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
  $('globalMode').checked = s.globalMode === true;

  // 查词卡片：详细程度 + 样式预设
  $('dictDetail').value = s.dictDetail || 'normal';
  syncDictDetailHint();
  setCardStyle(s.cardStyle || 'classic');

  // 大模型配置
  $('llmBaseUrl').value = s.llmBaseUrl || '';
  $('llmApiKey').value = s.llmApiKey || '';
  $('llmBatch').value = s.llmBatch ?? 12;
  $('llmBatchVal').textContent = s.llmBatch ?? 12;
  if (s.llmModel) {
    // 已保存的模型先塞一个 option，否则下拉框会显示成空
    $('llmModel').innerHTML = `<option value="${s.llmModel}">${s.llmModel}</option>`;
    $('llmModel').value = s.llmModel;
  }
  syncLlmGroup();
}

/** 只有选中「大模型」引擎时才展开配置区，避免平时占着一大块 */
function syncLlmGroup() {
  $('llmGroup').style.display = $('engine').value === 'llm' ? '' : 'none';
}

/** 详细程度的三档说明文案，跟着下拉框走 */
const DETAIL_HINT = {
  concise: '简洁：只给 1-2 个常用义项，卡片最矮',
  normal: '标准：义项 + 例句 + 英文原文',
  full: '详细：所有义项 + 例句 + 英文原文',
};
function syncDictDetailHint() {
  const v = $('dictDetail').value || 'normal';
  $('dictDetailHint').textContent = DETAIL_HINT[v] || DETAIL_HINT.normal;
}

/** 高亮当前选中的卡片样式色块 */
function setCardStyle(style) {
  const name = style || 'classic';
  document.querySelectorAll('#cardStylePicker .style-chip').forEach((b) => {
    b.classList.toggle('on', b.dataset.style === name);
  });
}

/** 从地址取 origin（scheme://host[:port]），取不到返回 '' */
function originOf(baseUrl) {
  const s = String(baseUrl || '').trim();
  if (!s) return '';
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).origin;
  } catch (_) {
    return '';
  }
}

/**
 * 申请大模型域名的 host permission。
 *
 * 必须**在用户手势里同步调用**：chrome.permissions.request 会拒绝任何
 * 脱离手势的调用（"This function must be called during a user gesture"）。
 * 之前这段逻辑写在 bg.js 的 'settings:set' 处理器里 —— 消息处理器没有手势
 * 上下文，Chrome 直接拒绝，权限永远拿不到，fetch 只会报 "Failed to fetch"，
 * 用户完全猜不到是权限问题。
 *
 * 因此调用方要在 click 处理器里**第一件事**就调它，中间不能有 await。
 */
function requestLlmOrigin(baseUrl) {
  const origin = originOf(baseUrl);
  if (!origin) return Promise.resolve({ ok: false, err: '请先填写 API 地址' });
  // 已授权时 request 立即 resolve(true)，不会弹框，可以无脑调用
  return chrome.permissions
    .request({ origins: [origin + '/*'] })
    .then((granted) =>
      granted ? { ok: true, origin } : { ok: false, err: `未授权访问 ${origin}` }
    )
    .catch((e) => ({ ok: false, err: String((e && e.message) || e) }));
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
  bindSetting('globalMode', 'globalMode');

  // 大模型配置：这几个字段不触发重译（改配置时不该把正在看的字幕清空），
  // 只落盘；下次切引擎或换语言时自然生效。
  for (const id of ['llmBaseUrl', 'llmApiKey']) {
    $(id).addEventListener('change', () => saveSettings({ [id]: $(id).value.trim() }));
  }
  $('llmModel').addEventListener('change', () => saveSettings({ llmModel: $('llmModel').value }));
  $('llmBatch').addEventListener('change', () =>
    saveSettings({ llmBatch: Number($('llmBatch').value) })
  );
  $('llmBatch').addEventListener('input', () => {
    $('llmBatchVal').textContent = $('llmBatch').value;
  });
  // 引擎切换时展开/收起配置区
  $('engine').addEventListener('change', syncLlmGroup);

  // 查词卡片：详细程度
  $('dictDetail').addEventListener('change', () => {
    syncDictDetailHint();
    // 换详细程度要让缓存失效 —— 后台的缓存键里带了档位，
    // 所以这里只要落盘，下次点词自然按新档位取。
    saveSettings({ dictDetail: $('dictDetail').value });
  });
  // 查词卡片：样式预设（点色块即时切换，无需保存按钮）
  document.querySelectorAll('#cardStylePicker .style-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const style = btn.dataset.style;
      setCardStyle(style);
      saveSettings({ cardStyle: style });
    });
  });

  // 拉取模型列表：地址/密钥填好后点一下，省得手打模型名
  $('llmFetch').addEventListener('click', async (ev) => {
    ev.preventDefault();
    const btn = $('llmFetch');
    btn.disabled = true;
    btn.textContent = '拉取中…';
    // 权限申请必须紧跟点击（手势还没失效），所以放在最前面、前面不能有 await
    const perm = await requestLlmOrigin($('llmBaseUrl').value);
    if (!perm.ok) {
      $('llmHint').textContent = '需要先授权访问该地址：' + perm.err;
      btn.disabled = false;
      btn.textContent = '拉取模型列表';
      return;
    }
    // 再把当前输入落盘，后台读的是存储里的值
    await saveSettings({
      llmBaseUrl: $('llmBaseUrl').value.trim(),
      llmApiKey: $('llmApiKey').value.trim(),
    });
    try {
      const r = await chrome.runtime.sendMessage({ type: 'llm:models' });
      if (r && r.ok && Array.isArray(r.data) && r.data.length) {
        const cur = $('llmModel').value;
        $('llmModel').innerHTML = r.data
          .map((m) => `<option value="${m}">${m}</option>`)
          .join('');
        if (r.data.includes(cur)) $('llmModel').value = cur;
        $('llmHint').textContent = `共 ${r.data.length} 个模型，选一个即可`;
      } else {
        $('llmHint').textContent = (r && r.error) || '没拉到模型，检查地址与密钥';
      }
    } catch (e) {
      $('llmHint').textContent = '拉取失败：' + (e.message || e);
    }
    btn.disabled = false;
    btn.textContent = '拉取模型列表';
  });

  // 测试连接：真发一条最小请求，验证地址/密钥/模型三者都对
  $('llmTest').addEventListener('click', async (ev) => {
    ev.preventDefault();
    const btn = $('llmTest');
    btn.disabled = true;
    btn.textContent = '测试中…';
    // 同 llmFetch：手势里第一件事就申请权限
    const perm = await requestLlmOrigin($('llmBaseUrl').value);
    if (!perm.ok) {
      $('llmHint').textContent = '需要先授权访问该地址：' + perm.err;
      btn.disabled = false;
      btn.textContent = '测试连接';
      return;
    }
    await saveSettings({
      llmBaseUrl: $('llmBaseUrl').value.trim(),
      llmApiKey: $('llmApiKey').value.trim(),
      llmModel: $('llmModel').value,
    });
    try {
      const r = await chrome.runtime.sendMessage({ type: 'llm:test' });
      if (r && r.ok) {
        $('llmHint').textContent = `连接正常（${r.data.ms}ms）：${r.data.sample}`;
      } else {
        $('llmHint').textContent = '连接失败：' + ((r && r.error) || '未知错误');
      }
    } catch (e) {
      $('llmHint').textContent = '连接失败：' + (e.message || e);
    }
    btn.disabled = false;
    btn.textContent = '测试连接';
  });

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

// 导出成 JSON 文件。和词库页同一套约束：只有真拿到非空数组才落盘，
// 否则后台出错时会生成一个 2 字节的空 JSON，用户还以为是导出成功了。
$('exportWords').addEventListener('click', async () => {
  let data;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'word:export' });
    if (!r || !r.ok) throw new Error((r && r.error) || '后台没有返回数据');
    data = r.data;
  } catch (e) {
    $('wordStat').textContent = '导出失败：' + ((e && e.message) || e);
    return;
  }
  if (!Array.isArray(data) || data.length === 0) {
    $('wordStat').textContent = '生词本是空的，没有可导出的内容';
    return;
  }
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
