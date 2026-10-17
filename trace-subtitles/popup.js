/* Trace 字幕翻译 —— Popup 逻辑 */

const $ = (id) => document.getElementById(id);

let allWords = [];

// ---------------------------------------------------------------- 标签页

document.querySelectorAll('#nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#nav button').forEach((b) => b.classList.remove('on'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('on'));
    btn.classList.add('on');
    $('panel-' + btn.dataset.tab).classList.add('on');
    if (btn.dataset.tab === 'words') loadWords();
  });
});

// ---------------------------------------------------------------- 概览条

/** 把数组压成 7 天的每日新增曲线，画进右上角的迷你折线 */
function renderSpark(counts) {
  const svg = $('spark');
  if (!svg) return;
  const w = 76;
  const h = 30;
  const pad = 3;
  const max = Math.max(1, ...counts);
  const step = counts.length > 1 ? (w - pad * 2) / (counts.length - 1) : 0;

  const pts = counts.map((v, i) => {
    const x = pad + step * i;
    // 值越大越靠上：0 → h-pad，max → pad
    const y = h - pad - (v / max) * (h - pad * 2);
    return [x, y];
  });

  const line = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const area =
    `M${pts[0][0].toFixed(1)},${h} ` +
    pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ') +
    ` L${pts[pts.length - 1][0].toFixed(1)},${h} Z`;

  svg.querySelector('.line').setAttribute('d', line);
  svg.querySelector('.area').setAttribute('d', area);

  const dot = svg.querySelector('.dot');
  const last = pts[pts.length - 1];
  dot.setAttribute('cx', last[0].toFixed(1));
  dot.setAttribute('cy', last[1].toFixed(1));
}

function renderOverview(list) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const total = list.length;
  const learned = list.filter((w) => w.status === 'learned').length;
  const today = list.filter((w) => (w.createdAt || 0) >= startOfToday).length;

  $('ovTotal').textContent = total;
  $('ovLearned').textContent = learned;
  $('ovToday').textContent = today;

  // 最近 7 天（含今天）每日新增
  const counts = [];
  for (let d = 6; d >= 0; d--) {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d).getTime();
    const to = from + 86400000;
    counts.push(list.filter((w) => (w.createdAt || 0) >= from && (w.createdAt || 0) < to).length);
  }
  renderSpark(counts);
}

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
  $('positionVal').textContent = (s.position ?? 18) + '%';
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
    onChange: (v) => ($('positionVal').textContent = v + '%'),
  });
  bindSetting('clickWord', 'clickWord');

  // 拖动过字幕框后回到「底部居中」预设位置
  $('resetPos').addEventListener('click', async (ev) => {
    ev.preventDefault();
    await saveSettings({ freePos: null });
  });

  // 折叠分组
  $('foldStyleHd').addEventListener('click', () => {
    $('foldStyle').classList.toggle('open');
  });
}

// ---------------------------------------------------------------- 生词本

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
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

const STATUS_LABEL = { new: '新词', learning: '记忆中', learned: '已记住' };

function renderWords(list) {
  const box = $('wordList');
  if (!list.length) {
    box.innerHTML = `
      <div class="empty">
        <div class="empty-mark">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
          </svg>
        </div>
        <div>
          <div class="empty-title">生词本还是空的</div>
          <div>在 YouTube 字幕里点击单词即可加入</div>
        </div>
      </div>`;
    $('wordStat').textContent = '';
    return;
  }
  $('wordStat').textContent = `共 ${list.length} 个单词`;
  box.innerHTML = list
    .map((w, i) => {
      const st = w.status || 'new';
      return `
      <div class="wc rise" style="--i:${Math.min(i, 12)}">
        <div class="wc-main">
          <div class="wc-top">
            <span class="wc-word">${esc(w.display || w.word)}</span>
            ${w.phonetic ? `<span class="wc-phon">${esc(w.phonetic)}</span>` : ''}
            <span class="pill pill-${st}">${STATUS_LABEL[st] || st}</span>
          </div>
          ${w.zh ? `<div class="wc-zh">${esc(w.zh)}</div>` : ''}
          ${w.context ? `<div class="wc-ctx">${esc(w.context)}</div>` : ''}
        </div>
        <div class="wc-side">
          <button class="wc-del" data-del="${esc(w.word)}" title="删除">×</button>
          <span class="wc-date">${fmtDate(w.createdAt)}</span>
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
}

async function loadWords() {
  const r = await chrome.runtime.sendMessage({ type: 'word:list' });
  allWords = r && r.ok ? r.data : [];
  renderOverview(allWords);
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

function openBoard() {
  chrome.tabs.create({ url: chrome.runtime.getURL('wordbook.html') });
  window.close();
}
$('openBoard').addEventListener('click', openBoard);
$('openBoard2').addEventListener('click', openBoard);

(async () => {
  await loadSettings();
  initSettingsUI();
  loadWords();
})();
