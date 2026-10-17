/**
 * Trace 字幕翻译 —— 内容脚本
 *
 * 流程：
 *   1. 与主世界脚本通信，拿到当前视频的字幕轨道并抓取原始字幕
 *   2. 解析 → 分句 → 批量翻译（后台带缓存）
 *   3. 在播放器上叠加双层字幕（原文 + 译文），随 currentTime 切换
 *   4. 点击单词 → 查词卡片 → 一键加入生词本
 */
(() => {
  'use strict';
  if (window.__TRACE_CONTENT__) return;
  window.__TRACE_CONTENT__ = true;

  const S = window.TraceSubs;
  const REQ = '__TRACE_REQ__';
  const RES = '__TRACE_RES__';
  const pending = new Map();
  let reqSeq = 0;

  // ------------------------------------------------------------ 与主世界通信

  function callMain(action, payload) {
    return new Promise((resolve, reject) => {
      const id = 'r' + ++reqSeq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('main world timeout: ' + action));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ type: REQ, id, action, payload }, location.origin);
    });
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.type !== RES) return;
    if (d.id === 'nav') {
      onNavigate();
      return;
    }
    if (d.id === 'tracks-ready') {
      // 主世界刚拦到带字幕轨的 player 响应，若还没加载成功就再试一次
      if (!state.ready) scheduleLoad(400);
      return;
    }
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    clearTimeout(p.timer);
    if (d.ok) p.resolve(d.data);
    else p.reject(new Error(d.error || 'main world error'));
  });

  // ------------------------------------------------------------ 状态

  const state = {
    settings: null,
    tracks: [],
    track: null,
    raw: [],
    sentences: [],
    active: null,
    videoId: '',
    ready: false,
    translating: false,
    wordPopup: null,
    /** 已加入生词本的单词（小写），用于全站高亮 */
    wordSet: new Set(),
  };

  // ------------------------------------------------------------ DOM

  let overlayEl, origEl, transEl, tipEl, popupEl, boxEl, handleEl;

  function buildOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'trace-sub-overlay';
    overlayEl.innerHTML = `
      <div class="trace-sub-box">
        <div class="trace-drag-handle" title="拖动调整位置">
          <i></i><i></i><i></i>
        </div>
        <div class="trace-sub-orig"></div>
        <div class="trace-sub-trans"></div>
      </div>`;
    document.documentElement.appendChild(overlayEl);
    origEl = overlayEl.querySelector('.trace-sub-orig');
    transEl = overlayEl.querySelector('.trace-sub-trans');
    boxEl = overlayEl.querySelector('.trace-sub-box');
    handleEl = overlayEl.querySelector('.trace-drag-handle');

    origEl.addEventListener('click', onWordClick);
    initDrag();
  }

  /** 把保存的自由位置应用到字幕框 */
  function applyFreePosition(pos) {
    if (!boxEl) return;
    if (!pos) {
      overlayEl.removeAttribute('data-free');
      boxEl.style.left = '';
      boxEl.style.top = '';
      return;
    }
    overlayEl.dataset.free = '1';
    boxEl.style.left = pos.x + 'px';
    boxEl.style.top = pos.y + 'px';
  }

  /** 拖拽：按住顶部手柄移动字幕框，位置持久化 */
  function initDrag() {
    let drag = null;

    const onDown = (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const r = boxEl.getBoundingClientRect();
      drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
      boxEl.classList.add('trace-dragging');
      handleEl.setPointerCapture?.(ev.pointerId);
    };

    const onMove = (ev) => {
      if (!drag) return;
      ev.preventDefault();
      // 限制在视口内，避免拖丢
      const r = boxEl.getBoundingClientRect();
      const maxX = window.innerWidth - r.width - 4;
      const maxY = window.innerHeight - r.height - 4;
      const x = Math.max(4, Math.min(ev.clientX - drag.dx, Math.max(4, maxX)));
      const y = Math.max(4, Math.min(ev.clientY - drag.dy, Math.max(4, maxY)));
      applyFreePosition({ x: Math.round(x), y: Math.round(y) });
    };

    const onUp = () => {
      if (!drag) return;
      drag = null;
      boxEl.classList.remove('trace-dragging');
      const pos = {
        x: parseFloat(boxEl.style.left) || 0,
        y: parseFloat(boxEl.style.top) || 0,
      };
      savePosition(pos);
    };

    handleEl.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    // 窗口尺寸变化时，避免字幕框跑到视口外
    window.addEventListener('resize', () => {
      if (!state.settings?.freePos || !boxEl) return;
      const r = boxEl.getBoundingClientRect();
      const x = Math.min(parseFloat(boxEl.style.left) || 0, Math.max(4, window.innerWidth - r.width - 4));
      const y = Math.min(parseFloat(boxEl.style.top) || 0, Math.max(4, window.innerHeight - r.height - 4));
      applyFreePosition({ x: Math.round(x), y: Math.round(y) });
    });
  }

  let saveTimer = null;
  function savePosition(pos) {
    state.settings.freePos = pos;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'settings:set', patch: { freePos: pos } });
      } catch (_) {}
    }, 300);
  }

  function applySettingsToOverlay() {
    if (!overlayEl || !state.settings) return;
    const s = state.settings;
    overlayEl.style.setProperty('--trace-font-scale', String(s.fontScale || 1));
    overlayEl.style.setProperty('--trace-bottom', (s.position ?? 18) + '%');
    overlayEl.dataset.mode = s.mode;
    overlayEl.classList.toggle('trace-hidden', !s.enabled);
    // 有保存的自由位置就进入自由模式，否则回到默认底部居中
    applyFreePosition(s.freePos || null);
  }

  function renderActive(sentence) {
    if (!overlayEl) return;
    if (!sentence || !state.settings?.enabled) {
      overlayEl.classList.add('trace-empty');
      origEl.textContent = '';
      transEl.textContent = '';
      return;
    }
    overlayEl.classList.remove('trace-empty');
    origEl.innerHTML = renderWords(sentence.text);
    transEl.textContent = sentence.zh || '';
    transEl.classList.toggle('trace-loading', !sentence.zh && state.translating);
  }

  /** 把原文拆成可点击的单词 span，保留标点；已加入生词本的单词额外加 trace-saved */
  function renderWords(text) {
    return text
      .split(/(\s+)/)
      .map((tok) => {
        if (!tok.trim()) return tok;
        const m = tok.match(/^([^\p{L}\p{N}']*)([\p{L}\p{N}'-]+)([^\p{L}\p{N}']*)$/u);
        if (!m) return escapeHtml(tok);
        const [, pre, word, post] = m;
        const saved = state.wordSet.has(word.toLowerCase());
        return (
          escapeHtml(pre) +
          `<span class="trace-word${saved ? ' trace-saved' : ''}" data-w="${escapeAttr(word)}">` +
          escapeHtml(word) +
          '</span>' +
          escapeHtml(post)
        );
      })
      .join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/`/g, '&#96;');
  }

  // ------------------------------------------------------------ 字幕加载

  function getVideo() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  function getVideoId() {
    try {
      return new URL(location.href).searchParams.get('v') || '';
    } catch (_) {
      return '';
    }
  }

  /** 从轨道列表里挑一条最合适的：人工英文 → 任意英文 → 人工 → 自动 */
  function pickTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    const manual = tracks.filter((t) => t.kind !== 'asr');
    const auto = tracks.filter((t) => t.kind === 'asr');
    const en = (arr) => arr.find((t) => /^en/i.test(t.languageCode));
    return en(manual) || en(auto) || manual[0] || auto[0] || tracks[0];
  }

  /**
   * 加载字幕。主世界脚本会依次尝试「钩子已捕获 → 直接请求 → 强制播放器加载」，
   * 这里再加一层重试，因为 YouTube 常常在播放器初始化后几百毫秒才发出字幕请求。
   */
  async function loadSubtitles(attempt = 0, token = loadToken) {
    if (token !== loadToken) return; // 已被新一轮加载取代
    if (attempt === 0) {
      state.ready = false;
      state.sentences = [];
      state.active = null;
      renderActive(null);
    }

    let tracks = [];
    try {
      tracks = await callMain('tracks');
    } catch (e) {
      console.warn('[Trace] 读取字幕轨道失败', e);
    }
    state.tracks = tracks || [];

    const pick = pickTrack(state.tracks);
    state.track = pick;

    let data = null;
    try {
      data = await callMain('captions', { lang: pick && pick.languageCode });
    } catch (e) {
      data = null;
    }

    if (data && data.text) {
      stopDomFallback();
      try {
        state.raw = S.parse(data.kind, data.text);
      } catch (e) {
        console.warn('[Trace] 解析字幕失败', e);
        return;
      }
      if (!state.raw.length) {
        // 解析出 0 行，当作失败继续重试
        data = null;
      } else {
        state.sentences = S.segment(state.raw);
        state.ready = true;
        console.info(
          `[Trace] 已加载 ${state.raw.length} 行字幕 → ${state.sentences.length} 句（${
            pick ? pick.name : data.lang
          }，来源 ${data.source}）`
        );
        translateAll();
        return;
      }
    }

    // 还没拿到：有限次重试（总共约 15 秒），期间让主世界反复催播放器加载
    if (attempt < 5) {
      if (token !== loadToken) return;
      const delay = 900 + attempt * 700;
      console.info(`[Trace] 暂未拿到字幕正文，${delay}ms 后重试（第 ${attempt + 1} 次）`);
      setTimeout(() => loadSubtitles(attempt + 1, token), delay);
      return;
    }

    // 彻底失败：DOM 兜底（需要用户已在播放器里打开 CC）
    console.info('[Trace] 未拿到字幕正文，尝试 DOM 兜底（请在播放器里开启 CC）');
    startDomFallback();
  }

  async function translateAll() {
    if (state.translating || !state.sentences.length) return;
    state.translating = true;
    const target = state.settings?.targetLang || 'zh-CN';

    // 分批送翻译，边翻边渲染，不必等全部完成
    const BATCH = 25;
    for (let i = 0; i < state.sentences.length; i += BATCH) {
      const chunk = state.sentences.slice(i, i + BATCH);
      const texts = chunk.map((s) => s.text);
      try {
        const out = await chrome.runtime.sendMessage({
          type: 'translate',
          texts,
          source: state.track?.languageCode || 'auto',
          target,
        });
        if (out && out.ok) {
          out.data.forEach((zh, j) => {
            chunk[j].zh = zh;
          });
        }
      } catch (e) {
        console.warn('[Trace] 翻译失败', e);
      }
      // 立刻刷新当前句
      if (state.active) renderActive(state.active);
      await new Promise((r) => setTimeout(r, 80));
    }
    state.translating = false;
    if (state.active) renderActive(state.active);
  }

  // ------------------------------------------------------------ 时间同步

  let rafId = null;
  let lastKey = '';

  // ------------------------------------------------------------ DOM 兜底模式
  //
  // 拿不到字幕轨时（例如站点改版 / 未开启 CC），退化为“监听 YouTube 自己渲染的
  // 字幕节点”，实时翻译当前这一句。译文仍有缓存，重复句子不重复请求。

  let domTimer = null;
  let domLastOrig = '';
  let domCache = new Map();
  let domUpgradeTick = 0;

  function startDomFallback() {
    if (domTimer) return;
    overlayEl?.classList.add('trace-dom-mode');
    domTimer = setInterval(async () => {
      if (!state.settings?.enabled) return;

      // 每 ~5 秒尝试升级回完整模式（用户可能刚打开了 CC，轨道就出现了）
      if (++domUpgradeTick % 12 === 0) {
        try {
          const tracks = await callMain('tracks');
          if (tracks && tracks.length) {
            console.info('[Trace] 检测到字幕轨，切回完整模式');
            stopDomFallback();
            scheduleLoad(200);
            return;
          }
        } catch (_) {}
      }

      let text = '';
      try {
        text = await callMain('dom-caption');
      } catch (_) {
        return;
      }
      if (!text || text === domLastOrig) return;
      domLastOrig = text;
      const sent = { start: 0, end: 0, text, zh: domCache.get(text) || '' };
      state.active = sent;
      renderActive(sent);
      if (!sent.zh) {
        try {
          const out = await chrome.runtime.sendMessage({
            type: 'translate',
            texts: [text],
            source: state.track?.languageCode || 'auto',
            target: state.settings?.targetLang || 'zh-CN',
          });
          if (out && out.ok && out.data && out.data[0]) {
            sent.zh = out.data[0];
            domCache.set(text, sent.zh);
            if (state.active === sent) renderActive(sent);
          }
        } catch (_) {}
      }
    }, 400);
  }

  function stopDomFallback() {
    if (domTimer) {
      clearInterval(domTimer);
      domTimer = null;
    }
    overlayEl?.classList.remove('trace-dom-mode');
  }

  function tick() {
    const v = getVideo();
    if (v && state.ready) {
      const s = S.findByTime(state.sentences, v.currentTime);
      const key = s ? s.start + '|' + s.text : '';
      if (key !== lastKey) {
        lastKey = key;
        state.active = s;
        renderActive(s);
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (rafId) return;
    rafId = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ 查词

  function ensurePopup() {
    if (popupEl) return popupEl;
    popupEl = document.createElement('div');
    popupEl.id = 'trace-word-popup';
    popupEl.className = 'trace-hidden';
    document.documentElement.appendChild(popupEl);

    popupEl.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'close') hidePopup();
      if (act === 'add') {
        const d = state.wordPopup;
        if (!d) return;
        btn.disabled = true;
        btn.textContent = '添加中…';
        try {
          const r = await chrome.runtime.sendMessage({
            type: 'word:add',
            payload: {
              word: d.word,
              phonetic: d.phonetic,
              zh: d.zh,
              meanings: d.meanings,
              example: d.example,
              context: d.context,
              contextZh: d.contextZh,
              videoTitle: document.title.replace(/ - YouTube$/, ''),
              videoId: state.videoId,
              time: getVideo()?.currentTime ?? null,
            },
          });
          if (r && r.ok) {
            btn.textContent = '✓ 已在生词本';
            btn.classList.add('trace-done');
            btn.disabled = true;
            btn.dataset.act = 'remove';
            // 立刻本地生效：高亮当前字幕里所有该词，无需等广播
            state.wordSet.add(String(d.word || '').toLowerCase());
            refreshActiveWords();
          } else {
            btn.textContent = '添加失败';
          }
        } catch (e) {
          btn.textContent = '添加失败';
        }
      }
      if (act === 'remove') {
        const d = state.wordPopup;
        if (!d) return;
        btn.disabled = true;
        btn.textContent = '移除中…';
        try {
          await chrome.runtime.sendMessage({ type: 'word:remove', word: d.word });
          btn.textContent = '＋ 加入生词本';
          btn.classList.remove('trace-done');
          btn.disabled = false;
          btn.dataset.act = 'add';
          state.wordSet.delete(String(d.word || '').toLowerCase());
          refreshActiveWords();
        } catch (e) {
          btn.textContent = '✓ 已在生词本';
          btn.disabled = false;
        }
      }
    });
    return popupEl;
  }

  async function onWordClick(ev) {
    if (!state.settings?.clickWord) return;
    const el = ev.target.closest('.trace-word');
    if (!el) return;
    const word = el.dataset.w;
    if (!word) return;

    const rect = el.getBoundingClientRect();
    const pop = ensurePopup();
    state.wordPopup = {
      word,
      saved: state.wordSet.has(word.toLowerCase()),
      context: state.active?.text || '',
      contextZh: state.active?.zh || '',
    };

    pop.innerHTML = `
      <div class="trace-pop-head">
        <span class="trace-pop-word">${escapeHtml(word)}</span>
        <button class="trace-pop-close" data-act="close" title="关闭">×</button>
      </div>
      <div class="trace-pop-body"><div class="trace-pop-loading">查询中…</div></div>`;
    pop.classList.remove('trace-hidden');
    positionPopup(pop, rect);

    // 查词与"是否已在生词本"并行，后者很快，先更新一次状态
    const savedTask = chrome.runtime
      .sendMessage({ type: 'word:has', word })
      .then((r) => (r && r.ok ? !!r.data : false))
      .catch(() => state.wordPopup?.saved || false);

    let dict = null;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'dict', word });
      if (r && r.ok) dict = r.data;
    } catch (_) {}

    const saved = await savedTask;
    if (state.wordPopup) state.wordPopup.saved = saved;
    // 以服务端（IndexedDB）结果为准同步高亮集合
    if (saved) state.wordSet.add(word.toLowerCase());
    else state.wordSet.delete(word.toLowerCase());

    if (!dict) {
      pop.querySelector('.trace-pop-body').innerHTML =
        '<div class="trace-pop-loading">查询失败</div>';
      return;
    }

    state.wordPopup = { ...state.wordPopup, ...dict, saved };
    const meanings = (dict.meanings || [])
      .slice(0, 4)
      .map((m) => `<li><i>${escapeHtml(m.pos)}</i> ${escapeHtml(m.def)}</li>`)
      .join('');
    pop.querySelector('.trace-pop-body').innerHTML = `
      ${dict.phonetic ? `<div class="trace-pop-phon">${escapeHtml(dict.phonetic)}</div>` : ''}
      ${dict.zh ? `<div class="trace-pop-zh">${escapeHtml(dict.zh)}</div>` : ''}
      ${meanings ? `<ul class="trace-pop-meanings">${meanings}</ul>` : ''}
      ${dict.example ? `<div class="trace-pop-ex">“${escapeHtml(dict.example)}”</div>` : ''}
      <div class="trace-pop-actions">
        ${
          saved
            ? '<button class="trace-pop-add trace-done" data-act="remove">✓ 已在生词本</button>'
            : '<button class="trace-pop-add" data-act="add">＋ 加入生词本</button>'
        }
      </div>`;
    // 内容渲染后弹窗变高了，必须重新定位，否则会压住字幕
    positionPopup(pop, rect);
  }

  function positionPopup(pop, rect) {
    const pad = 8;
    const w = 300;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
    pop.style.width = w + 'px';
    pop.style.left = left + 'px';

    // 先放到 0 处测量真实高度
    pop.style.top = '0px';
    const h = pop.offsetHeight || 200;

    // 优先放在单词上方；但要避开整块字幕区域，别把正在看的字幕挡住
    const box = overlayEl ? overlayEl.querySelector('.trace-sub-box') : null;
    const boxRect = box ? box.getBoundingClientRect() : null;
    let top = rect.top - h - 12;
    if (boxRect && top + h > boxRect.top - 8) {
      // 会被字幕挡住 → 整体移到字幕块上方
      top = boxRect.top - h - 8;
    }
    // 上方放不下 → 放到字幕块下方；再不行就贴顶
    if (top < pad) {
      const below = boxRect ? boxRect.bottom + 8 : rect.bottom + 12;
      top = below + h <= window.innerHeight - pad ? below : pad;
    }
    pop.style.top = Math.round(top) + 'px';
  }

  function hidePopup() {
    if (popupEl) popupEl.classList.add('trace-hidden');
    state.wordPopup = null;
  }

  // ------------------------------------------------------------ 生词高亮

  /** 重新渲染当前这一句，让新增/移除的生词高亮立刻生效 */
  function refreshActiveWords() {
    if (state.active && overlayEl) origEl.innerHTML = renderWords(state.active.text);
  }

  /** 从后台拉取生词表，更新高亮集合 */
  async function loadWordSet() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'word:keys' });
      if (r && r.ok && Array.isArray(r.data)) {
        state.wordSet = new Set(r.data.map((w) => String(w).toLowerCase()));
        refreshActiveWords();
      }
    } catch (_) {
      /* 忽略：高亮是增强功能，失败不影响字幕 */
    }
  }

  document.addEventListener('click', (e) => {
    if (popupEl && !popupEl.classList.contains('trace-hidden')) {
      if (!popupEl.contains(e.target) && !e.target.closest('.trace-word')) hidePopup();
    }
  });

  // ------------------------------------------------------------ 生命周期

  let loadTimer = null;
  let loadToken = 0; // 每次重新加载自增，旧的重试链看到 token 变了就自行退出

  function scheduleLoad(delay = 600) {
    clearTimeout(loadTimer);
    const token = ++loadToken;
    loadTimer = setTimeout(() => {
      loadTimer = null;
      loadSubtitles(0, token);
    }, delay);
  }

  function onNavigate() {
    const id = getVideoId();
    if (id === state.videoId) return;
    state.videoId = id;
    hidePopup();
    stopDomFallback();
    domLastOrig = '';
    scheduleLoad(900);
  }

  async function init() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'settings:get' });
      state.settings = r && r.ok ? r.data : {};
    } catch (_) {
      state.settings = {};
    }
    buildOverlay();
    applySettingsToOverlay();
    state.videoId = getVideoId();
    loadWordSet();
    startLoop();

    // 监听页面切换 / 播放器就绪
    window.addEventListener('yt-navigate-finish', () => scheduleLoad(700));
    document.addEventListener('yt-page-data-updated', () => scheduleLoad(700));

    const obs = new MutationObserver(() => {
      if (getVideo() && !state.ready && !loadTimer) scheduleLoad(800);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    scheduleLoad(1000);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'settings:changed') {
      state.settings = msg.settings;
      applySettingsToOverlay();
      if (state.active) renderActive(state.active);
      if (msg.retranslate) translateAll();
      sendResponse({ ok: true });
    }
    if (msg.type === 'words:changed') {
      loadWordSet();
      sendResponse({ ok: true });
    }
    return false;
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
