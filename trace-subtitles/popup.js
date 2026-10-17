/* Trace 字幕翻译 —— Popup 逻辑 */

const $ = (id) => document.getElementById(id);

let allWords = [];

// ---------------------------------------------------------------- 标签页

document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('on'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('on'));
    btn.classList.add('on');
    $('panel-' + btn.dataset.tab).classList.add('on');
    if (btn.dataset.tab === 'words') loadWords();
  });
});

// ---------------------------------------------------------------- 设置

async function loadSettings() {
  const r = await chrome.runtime.sendMessage({ type: 'settings:get' });
  const s = r && r.ok ? r.data : {};
  $('enabled').checked = s.enabled !== false;
  $('mode').value = s.mode || 'bilingual';
  $('targetLang').value = s.targetLang || 'zh-CN';
  $('engine').value = s.engine || 'google';
  $('fontScale').value = s.fontScale ?? 1;
  $('fontScaleVal').textContent = Number(s.fontScale ?? 1).toFixed(2).replace(/0$/, '');
  $('position').value = s.position ?? 18;
  $('positionVal').textContent = s.position ?? 18;
  $('clickWord').checked = s.clickWord !== false;
}

async function saveSettings(patch, retranslate = false) {
  const r = await chrome.runtime.sendMessage({ type: 'settings:set', patch });
  const settings = r && r.ok ? r.data : null;
  if (!settings) return;
  // 通知所有 YouTube 标签页立即生效
  const tabs = await chrome.tabs.query({ url: 'https://*.youtube.com/*' });
  for (const t of tabs) {
    chrome.tabs.sendMessage(t.id, { type: 'settings:changed', settings, retranslate }).catch(() => {});
  }
}

function bindSetting(id, key, { numeric = false, retranslate = false, onChange } = {}) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('change', async () => {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (numeric) v = Number(v);
    await saveSettings({ [key]: v }, retranslate);
    if (onChange) onChange(v);
  });
  // range 用 input 事件实时反馈
  if (el.type === 'range') {
    el.addEventListener('input', () => {
      if (onChange) onChange(Number(el.value));
    });
  }
}

function initSettingsUI() {
  bindSetting('enabled', 'enabled');
  bindSetting('mode', 'mode');
  bindSetting('targetLang', 'targetLang', { retranslate: true });
  bindSetting('engine', 'engine', { retranslate: true });
  bindSetting('fontScale', 'fontScale', {
    numeric: true,
    onChange: (v) => ($('fontScaleVal').textContent = Number(v).toFixed(2).replace(/0$/, '')),
  });
  bindSetting('position', 'position', {
    numeric: true,
    onChange: (v) => ($('positionVal').textContent = v),
  });
  bindSetting('clickWord', 'clickWord');

  // 拖动过字幕框后回到「底部居中」预设位置
  $('resetPos').addEventListener('click', async (ev) => {
    ev.preventDefault();
    await saveSettings({ freePos: null });
    $('positionVal').textContent = $('position').value;
  });
}

// ---------------------------------------------------------------- 生词本

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function renderWords(list) {
  const box = $('wordList');
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有生词<br/>在 YouTube 字幕里点击单词即可加入</div>';
    $('wordStat').textContent = '';
    return;
  }
  $('wordStat').textContent = `共 ${list.length} 个单词`;
  box.innerHTML = list
    .map((w) => {
      const link = w.videoId
        ? `<a data-vid="${esc(w.videoId)}" data-t="${w.time ?? 0}">${esc(w.videoTitle || '视频')} · ${fmtTime(w.time)}</a>`
        : '';
      return `
      <div class="word-card">
        <div class="wc-head">
          <span class="wc-word">${esc(w.display || w.word)}</span>
          ${w.phonetic ? `<span class="wc-phon">${esc(w.phonetic)}</span>` : ''}
          <button class="wc-del" data-del="${esc(w.word)}" title="删除">×</button>
        </div>
        ${w.zh ? `<div class="wc-zh">${esc(w.zh)}</div>` : ''}
        ${w.context ? `<div class="wc-ctx">${esc(w.context)}</div>` : ''}
        <div class="wc-meta">
          <span>${fmtDate(w.createdAt)}</span>
          ${w.reviewCount ? `<span>复习 ${w.reviewCount} 次</span>` : ''}
          ${link}
        </div>
      </div>`;
    })
    .join('');

  box.querySelectorAll('.wc-del').forEach((b) => {
    b.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'word:remove', word: b.dataset.del });
      loadWords();
    });
  });
  box.querySelectorAll('.wc-meta a[data-vid]').forEach((a) => {
    a.addEventListener('click', () => {
      const t = Math.max(0, Math.floor(Number(a.dataset.t) || 0));
      chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${a.dataset.vid}&t=${t}s` });
    });
  });
}

function fmtTime(t) {
  if (typeof t !== 'number') return '';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function loadWords() {
  const r = await chrome.runtime.sendMessage({ type: 'word:list' });
  allWords = r && r.ok ? r.data : [];
  filterWords();
}

function filterWords() {
  const q = ($('wordSearch').value || '').trim().toLowerCase();
  const list = q
    ? allWords.filter(
        (w) =>
          (w.word || '').includes(q) ||
          (w.zh || '').toLowerCase().includes(q) ||
          (w.context || '').toLowerCase().includes(q)
      )
    : allWords;
  renderWords(list);
}

// ---------------------------------------------------------------- 启动

$('wordSearch').addEventListener('input', filterWords);
$('exportWords').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'word:export' });
  const data = r && r.ok ? r.data : [];
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trace-words-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

(async () => {
  await loadSettings();
  initSettingsUI();
  loadWords();
})();
