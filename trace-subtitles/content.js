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
    /** 上一轮翻译实际使用的目标语言（设置晚到时用来判断是否需要重翻） */
    translatedTarget: '',
  };

  // ------------------------------------------------------------ DOM

  let overlayEl, origEl, transEl, tipEl, popupEl, boxEl, handleEl;
  let launcherEl, panelEl;
  /** 非全屏时记下的视频框宽度，作为「全屏等比例放大」的基准 */
  let baseFrameWidth = 0;
  /** 上次应用的覆盖层几何签名，避免每帧都写样式 */
  let lastGeomKey = '';

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
    // 译文里高亮的中文也能点：直接打开同一个生词卡片
    transEl.addEventListener('click', onWordClick);
    initDrag();
  }

  // ------------------------------------------------------------ 悬浮按钮 + 页内面板

  /**
   * 播放器右下角的悬浮按钮（Trancy 风格）。
   * 位置跟随 YouTube 播放器：贴在其右下角内侧，播放器不存在时贴视口右下角。
   * 用 position:fixed + 实时读 getBoundingClientRect，所以全屏/网页全屏/改窗口都能跟上。
   */
  function buildLauncher() {
    if (launcherEl) return;
    launcherEl = document.createElement('button');
    launcherEl.id = 'trace-launcher';
    launcherEl.type = 'button';
    launcherEl.title = 'Trace 字幕设置';
    launcherEl.innerHTML = 'T';
    launcherEl.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      togglePanel();
    });
    document.documentElement.appendChild(launcherEl);
    positionLauncher();

    // 播放器尺寸/位置变化（全屏切换、窗口缩放、影院模式）都要重新贴边
    window.addEventListener('resize', positionLauncher);
    document.addEventListener('fullscreenchange', positionLauncher);
    window.addEventListener('scroll', positionLauncher, { passive: true });
    // YouTube 自己会改播放器尺寸，用 ResizeObserver 跟住
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => positionLauncher());
      const mp = document.getElementById('movie_player');
      if (mp) ro.observe(mp);
    }
    // 播放器可能晚于脚本出现，轮询几次补挂
    let tries = 0;
    const timer = setInterval(() => {
      positionLauncher();
      const mp = document.getElementById('movie_player');
      if (mp && window.ResizeObserver) {
        // 观察一次即可
        clearInterval(timer);
      } else if (++tries > 30) {
        clearInterval(timer);
      }
    }, 500);
  }

  /** 把悬浮按钮贴到播放器右下角内侧（避开控制栏） */
  function positionLauncher() {
    if (!launcherEl) return;
    const mp = document.getElementById('movie_player');
    const v = getVideo();
    const r = (mp || v)?.getBoundingClientRect?.();
    const size = 34;
    const gap = 12;
    let x, y;
    if (r && r.width > 80 && r.height > 80) {
      x = r.right - size - gap;
      // 稍微上移，避免压住 YouTube 自带的控制栏按钮
      y = r.bottom - size - gap - 6;
    } else {
      x = window.innerWidth - size - gap;
      y = window.innerHeight - size - gap;
    }
    launcherEl.style.left = Math.round(Math.max(4, Math.min(x, window.innerWidth - size - 4))) + 'px';
    launcherEl.style.top = Math.round(Math.max(4, Math.min(y, window.innerHeight - size - 4))) + 'px';
  }

  function togglePanel(force) {
    if (!panelEl) buildPanel();
    const show = force === undefined ? panelEl.classList.contains('trace-hidden') : !!force;
    panelEl.classList.toggle('trace-hidden', !show);
    if (show) syncPanelUI();
    syncPanelLayout();
  }

  /** 构建页内设置面板（深色侧栏，结构对齐 Trancy 的「Trancy 字幕」菜单） */
  function buildPanel() {
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.id = 'trace-panel';
    panelEl.className = 'trace-hidden';
    panelEl.innerHTML = `
      <div class="tp-head">
        <div class="tp-logo">T</div>
        <div class="tp-titles">
          <div class="tp-title">Trace 字幕</div>
          <div class="tp-tag">双语字幕 · 点词即查 · 自动高亮生词</div>
        </div>
        <button class="tp-close" type="button" title="关闭">×</button>
      </div>
      <div class="tp-body">
        <div class="tp-sec-title">字幕</div>
        <div class="tp-row">
          <div class="tp-label">启用双语字幕<div class="tp-sub">在播放器上叠加译文</div></div>
          <label class="tp-switch"><input type="checkbox" data-k="enabled" /><span class="tp-slider"></span></label>
        </div>

        <div class="tp-row">
          <div class="tp-label">主字幕<div class="tp-sub">原文语言</div></div>
          <select data-k="sourceLang">
            <option value="auto">自动检测</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
            <option value="zh-CN">简体中文</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
            <option value="ru">Русский</option>
          </select>
        </div>

        <div class="tp-row">
          <div class="tp-label">翻译字幕<div class="tp-sub">译文语言</div></div>
          <select data-k="targetLang">
            <option value="zh-CN">简体中文</option>
            <option value="zh-TW">繁體中文</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
            <option value="ru">Русский</option>
            <option value="pt">Português</option>
          </select>
        </div>

        <div class="tp-row">
          <div class="tp-label">翻译引擎<div class="tp-sub">译文来自哪家服务</div></div>
          <select data-k="engine">
            <option value="google">Google</option>
            <option value="mymemory">MyMemory</option>
          </select>
        </div>

        <div class="tp-row">
          <div class="tp-label">字幕显示<div class="tp-sub">同时显示原文与译文</div></div>
          <select data-k="mode">
            <option value="bilingual">双语字幕</option>
            <option value="translation-only">仅译文</option>
            <option value="original-only">仅原文</option>
          </select>
        </div>

        <div class="tp-group tp-open" data-group="style">
          <button class="tp-group-head" type="button">
            <span>字幕样式</span>
            <span class="tp-caret">▶</span>
          </button>
          <div class="tp-group-body">
            <div class="tp-field">
              <span>原文字号</span>
              <input type="range" data-k="origSize" min="14" max="48" step="1" />
              <span class="tp-val" data-v="origSize"></span>
            </div>
            <div class="tp-field">
              <span>译文字号</span>
              <input type="range" data-k="transSize" min="12" max="40" step="1" />
              <span class="tp-val" data-v="transSize"></span>
            </div>
            <div class="tp-field tp-color">
              <span>原文颜色</span>
              <input type="color" data-k="origColor" />
            </div>
            <div class="tp-field tp-color">
              <span>译文颜色</span>
              <input type="color" data-k="transColor" />
            </div>
            <div class="tp-field">
              <span>背景透明</span>
              <input type="range" data-k="bgAlpha" min="0" max="0.95" step="0.05" />
              <span class="tp-val" data-v="bgAlpha"></span>
            </div>
            <div class="tp-field">
              <span>圆角</span>
              <input type="range" data-k="radius" min="0" max="28" step="1" />
              <span class="tp-val" data-v="radius"></span>
            </div>
            <div class="tp-field">
              <span>高斯模糊</span>
              <input type="range" data-k="blur" min="0" max="40" step="1" />
              <span class="tp-val" data-v="blur"></span>
            </div>
            <div class="tp-field">
              <span>整体缩放</span>
              <input type="range" data-k="fontScale" min="0.7" max="1.6" step="0.05" />
              <span class="tp-val" data-v="fontScale"></span>
            </div>
          </div>
        </div>

        <div class="tp-group" data-group="more">
          <button class="tp-group-head" type="button">
            <span>更多功能</span>
            <span class="tp-caret">▶</span>
          </button>
          <div class="tp-group-body">
            <div class="tp-row" style="padding-left:0;padding-right:0;">
              <div class="tp-label">点击单词查词<div class="tp-sub">弹出释义并可直接收藏</div></div>
              <label class="tp-switch"><input type="checkbox" data-k="clickWord" /><span class="tp-slider"></span></label>
            </div>
            <div class="tp-row" style="padding-left:0;padding-right:0;">
              <div class="tp-label">全局显示<div class="tp-sub">离开视频画面时改成贴底悬浮条</div></div>
              <label class="tp-switch"><input type="checkbox" data-k="globalMode" /><span class="tp-slider"></span></label>
            </div>
            <div class="tp-row" style="padding-left:0;padding-right:0;">
              <div class="tp-label">显示悬浮按钮<div class="tp-sub">播放器右下角的 T 按钮</div></div>
              <label class="tp-switch"><input type="checkbox" data-k="showLauncher" /><span class="tp-slider"></span></label>
            </div>
            <div class="tp-field">
              <span>字幕位置</span>
              <input type="range" data-k="position" min="4" max="40" step="1" />
              <span class="tp-val" data-v="position"></span>
            </div>
          </div>
        </div>
      </div>
      <div class="tp-actions">
        <button class="tp-btn" type="button" data-act="reset-pos">恢复默认位置</button>
        <button class="tp-btn tp-primary" type="button" data-act="wordbook">生词本</button>
      </div>`;
    document.documentElement.appendChild(panelEl);

    panelEl.querySelector('.tp-close').addEventListener('click', () => togglePanel(false));

    // 折叠分组
    panelEl.querySelectorAll('.tp-group-head').forEach((h) => {
      h.addEventListener('click', () => h.closest('.tp-group').classList.toggle('tp-open'));
    });

    // 输入项统一走 patchSettings，实时生效（不重译）
    panelEl.querySelectorAll('[data-k]').forEach((el) => {
      const k = el.dataset.k;
      const ev = el.type === 'range' || el.type === 'color' ? 'input' : 'change';
      el.addEventListener(ev, () => {
        let v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.type === 'range') v = Number(el.value);
        else if (el.type === 'color') v = el.value;
        else v = el.value;
        // 语言/引擎变更必须重译，其余只改样式
        const retranslate = k === 'targetLang' || k === 'engine' || k === 'sourceLang';
        patchSettings({ [k]: v }, retranslate);
        updateValLabel(k, v);
      });
    });

    panelEl.querySelector('[data-act="reset-pos"]').addEventListener('click', () => {
      patchSettings({ freePos: null });
    });
    panelEl.querySelector('[data-act="wordbook"]').addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'open-wordbook' });
      } catch (_) {
        /* 忽略 */
      }
    });
  }

  /** 把设置值写回面板控件（打开面板时同步一次） */
  function syncPanelUI() {
    if (!panelEl || !state.settings) return;
    const s = state.settings;
    panelEl.querySelectorAll('[data-k]').forEach((el) => {
      const k = el.dataset.k;
      const v = s[k];
      if (v === undefined) return;
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
      updateValLabel(k, v);
    });
  }

  function updateValLabel(k, v) {
    if (!panelEl) return;
    const lab = panelEl.querySelector(`.tp-val[data-v="${k}"]`);
    if (!lab) return;
    if (k === 'bgAlpha') lab.textContent = Math.round(Number(v) * 100) + '%';
    else if (k === 'fontScale') lab.textContent = Number(v).toFixed(2).replace(/0$/, '');
    else if (k === 'position') lab.textContent = v + '%';
    else lab.textContent = String(v);
  }

  /** 面板改设置：先本地生效，再持久化，再广播给其它标签页 */
  let patchTimer = null;
  const patchPending = {};

  /** 立刻把攒着的设置写进后台（不等防抖），返回 Promise */
  async function flushSettingsPatch() {
    clearTimeout(patchTimer);
    patchTimer = null;
    const p = { ...patchPending };
    for (const k of Object.keys(patchPending)) delete patchPending[k];
    if (!Object.keys(p).length) return;
    try {
      await sendMsg({ type: 'settings:set', patch: p }, 8000);
    } catch (_) {}
  }

  function patchSettings(patch, retranslate = false) {
    state.settings = { ...state.settings, ...patch };
    applySettingsToOverlay();
    if (state.active) renderActive(state.active);
    Object.assign(patchPending, patch);

    if (retranslate) {
      // 语言/引擎变了：旧译文作废，重新翻。
      // 注意顺序：必须先把设置写进后台，再开始翻译。
      // 否则后台读到的还是旧 engine，会拿新引擎的名字去跑旧引擎（表现为
      // “切到 Google 了但还是没译文”）。
      state.sentences.forEach((s) => {
        s.zh = '';
        s.zhSpans = [];
        s.zhAlignTried = false;
      });
      flushSettingsPatch().then(() => translateAll());
    }

    clearTimeout(patchTimer);
    patchTimer = setTimeout(() => {
      flushSettingsPatch();
    }, 220);
  }

  /**
   * 视频框的原始矩形（不做任何兜底）。
   * 优先用 YouTube 的 #movie_player（它包含控制栏、比 video 元素略大），
   * 拿不到或尺寸小到不像播放器时返回 null。
   */
  function playerRect() {
    const mp = document.getElementById('movie_player');
    const v = getVideo();
    const el = mp || v;
    const r = el?.getBoundingClientRect?.();
    if (r && r.width > 80 && r.height > 60) {
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    return null;
  }

  function viewportGeom() {
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  /**
   * 视频框在视口里露出了多少（0~1）以及是否算「在画面里」。
   *
   * 用「交集面积 / 视频框面积」判断，而不是只看 top/bottom：
   * 往下翻评论区时视频框常常还露出一半，这时仍算在画面里，
   * 不该突然切成悬浮条 —— 那会让字幕在屏幕上跳来跳去。
   *
   * 另外要把「迷你播放器」排除掉：在首页/别的页面上后台播放时，
   * YouTube 会把播放器缩成右下角的小窗。它确实完整可见，但面积只有
   * 视口的一小块，此时字幕贴上去只有几个像素高、根本没法读，
   * 而且会在浏览首页时一直飘着。这种一律按「不在画面里」处理。
   */
  function frameVisibility() {
    const r = playerRect();
    if (!r) return { visible: false, ratio: 0, rect: null, mini: false };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const mini = r.width < vw * 0.5 && r.height < vh * 0.5;
    const visW = Math.min(r.left + r.width, vw) - Math.max(r.left, 0);
    const visH = Math.min(r.top + r.height, vh) - Math.max(r.top, 0);
    if (visW <= 0 || visH <= 0) return { visible: false, ratio: 0, rect: r, mini };
    const ratio = (visW * visH) / (r.width * r.height);
    const visible = !mini && ratio >= 0.45 && visW > 80 && visH > 60;
    return { visible, ratio, rect: r, mini };
  }

  /**
   * 是否该切成「全局悬浮条」：开了全局显示、视频框几乎不在视野里、
   * 但视频还在放（或还有字幕可显示）。
   *
   * 关掉全局显示时这个函数恒为 false，此时视频框离开视野就整条隐藏，
   * 不会再出现「在首页/别的页面上飘着字幕」的情况。
   */
  function isGlobalBar() {
    if (state.settings?.globalMode !== true) return false;
    if (frameVisibility().visible) return false;
    const v = getVideo();
    if (!v) return false;
    return !v.paused || !!state.active;
  }

  /**
   * 覆盖层要贴住哪个矩形：正常是视频框，全局悬浮条模式下是整个视口，
   * 视频框彻底消失时退回视口（随后会被 .trace-away 隐藏）。
   */
  function overlayGeom() {
    if (isGlobalBar()) return viewportGeom();
    return playerRect() || viewportGeom();
  }

  /**
   * YouTube 自己的交互浮层（设置菜单、画质/倍速菜单、底部控制栏）。
   *
   * 字幕框是覆盖在播放器上的不透明浮层，压在设置菜单上时用户点不到
   * 「清晰度」这类选项 —— 这是要避让的对象。
   * 只收集**当前真的可见**的那些：YouTube 自动隐藏控制栏时会把
   * opacity 压到 0（.ytp-autohide），这类跳过，否则鼠标一动就误判成重叠。
   */
  function ytUiRects() {
    const out = [];
    for (const sel of ['.ytp-settings-menu', '.ytp-popup', '.ytp-chrome-bottom']) {
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        out.push(r);
      }
    }
    return out;
  }

  /** 字幕框当前占的视口矩形（拿不到有效尺寸就返回 null） */
  function boxViewportRect() {
    const r = boxEl?.getBoundingClientRect?.();
    if (!r || r.width < 4 || r.height < 4) return null;
    return r;
  }

  /** 字幕框是否真的压住了 YouTube 的交互浮层（重叠要超过几个像素才算） */
  function boxOverlapsYtUi() {
    const b = boxViewportRect();
    if (!b) return false;
    for (const r of ytUiRects()) {
      const w = Math.min(b.right, r.right) - Math.max(b.left, r.left);
      const h = Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top);
      if (w > 6 && h > 6) return true;
    }
    return false;
  }

  /**
   * 字幕框压住 YouTube 菜单时让路：加 .trace-dodge（点击穿透 + 淡出）。
   *
   * 为什么是「淡出」而不是「挪位置」：菜单的高度和位置随内容变化
   * （设置 / 画质 / 倍速各不相同），挪到哪儿都可能又压住别的东西；
   * 淡出则一定能看清菜单，且指针事件直通到菜单上，点击一定命中。
   *
   * 为什么必须节流：这里要读 getBoundingClientRect + getComputedStyle，
   * 都会强制同步布局。tick() 是 60fps，每帧查一遍会拖慢播放器；
   * 120ms 一次足够（菜单开合没人能察觉 0.12 秒延迟）。
   *
   * 只在**真的重叠**时生效 —— 不重叠时什么都不做，
   * 字幕框外观与交互完全不变。
   */
  let lastDodge = false;
  let lastDodgeAt = 0;
  function syncDodge() {
    if (!overlayEl) return;
    const now = performance.now();
    if (now - lastDodgeAt < 120) return;
    lastDodgeAt = now;
    // 正在拖动时绝不让路：让路会给字幕框加 pointer-events:none，
    // 而拖拽依赖 pointer capture —— 中途把指针事件掐掉会让拖动卡在半路。
    const dodge = !isGlobalBar()
      && !overlayEl.classList.contains('trace-away')
      && !boxEl?.classList.contains('trace-dragging')
      && boxOverlapsYtUi();
    if (dodge === lastDodge) return;
    lastDodge = dodge;
    overlayEl.classList.toggle('trace-dodge', dodge);
  }

  /** 是否处于真·全屏（YouTube 会把 .ytp-fullscreen 加到播放器上） */
  function isFullscreen() {
    if (document.fullscreenElement) return true;
    const mp = document.getElementById('movie_player');
    return !!mp && mp.classList.contains('ytp-fullscreen');
  }

  /** 页内面板盖住了视频框右侧多少像素（覆盖层坐标系） */
  function panelReservePx() {
    if (!isPanelOpen() || !panelEl) return 0;
    const g = overlayGeom();
    const pr = panelEl.getBoundingClientRect();
    const overlap = g.left + g.width - pr.left;
    if (overlap <= 0) return 0;
    return Math.min(g.width, Math.round(overlap + 8));
  }

  /**
   * 让覆盖层精确贴合视频框，并按视频框宽度换算字号缩放。
   *
   * 为什么不是贴满视口：普通模式下 YouTube 播放器只是页面里的一块矩形
   * （上方有顶栏、右侧有推荐栏），贴视口会让字幕跑到画面外的黑边上。
   *
   * 缩放基准 baseFrameWidth 在非全屏时持续更新，所以：
   *   非全屏 → 比例恒为 1（拖窗口不会让字幕忽大忽小）
   *   全屏   → 按 当前宽度/非全屏宽度 放大（1080p 全屏约 1.6~1.8 倍）
   *   退全屏 → 比例回到 1，字号等比例缩回
   */
  function applyOverlayFrame() {
    if (!overlayEl) return;
    const bar = isGlobalBar();
    const vis = frameVisibility();
    const g = bar ? viewportGeom() : playerRect() || viewportGeom();
    const fs = isFullscreen();
    let scale = 1;
    if (bar) {
      // 悬浮条贴的是整个视口，不该按视频框宽度放大字号
      scale = 1;
    } else if (!fs) {
      baseFrameWidth = g.width;
    } else {
      const base = baseFrameWidth || g.width;
      scale = Math.max(1, Math.min(g.width / base, 2.8));
    }
    const reserve = bar ? 0 : panelReservePx();
    // 悬浮条模式下，右下角的迷你播放器要给它让路（否则横穿小窗，两边都看不清）。
    // 只有当播放器落在视口下半部分、且贴右侧时才算 —— 左侧的小窗不挡居中悬浮条。
    let barReserve = 0;
    if (bar && vis.mini && vis.rect) {
      const r = vis.rect;
      const inBottom = r.top + r.height / 2 > window.innerHeight * 0.5;
      const onRight = r.left + r.width / 2 > window.innerWidth * 0.5;
      if (inBottom && onRight) {
        barReserve = Math.max(0, Math.round(window.innerWidth - r.left + 16));
        barReserve = Math.min(barReserve, Math.round(window.innerWidth * 0.5));
      }
    }
    // 视频框既不在视野里、又没开全局显示 → 整条隐藏。
    // 这就是「在首页/别的页面上飘着字幕」的修复：没画面可贴就别显示。
    const away = !bar && !vis.visible;
    const key = [
      Math.round(g.left), Math.round(g.top), Math.round(g.width), Math.round(g.height),
      scale.toFixed(3), reserve, barReserve, bar ? 'bar' : '', away ? 'away' : '',
    ].join(',');
    if (key === lastGeomKey) return;
    lastGeomKey = key;

    overlayEl.style.left = Math.round(g.left) + 'px';
    overlayEl.style.top = Math.round(g.top) + 'px';
    overlayEl.style.width = Math.round(g.width) + 'px';
    overlayEl.style.height = Math.round(g.height) + 'px';
    overlayEl.style.setProperty('--trace-vscale', scale.toFixed(3));
    overlayEl.style.setProperty('--trace-panel-reserve', reserve + 'px');
    overlayEl.style.setProperty('--trace-bar-reserve', barReserve + 'px');
    overlayEl.classList.toggle('trace-panel-open', !bar && isPanelOpen());
    overlayEl.classList.toggle('trace-global', bar);
    overlayEl.classList.toggle('trace-away', away);

    // 视频框变形后，自由模式下的位置要重新夹紧（否则可能落到画面外）。
    // 悬浮条模式下位置由 CSS 固定（贴屏幕底部），要清掉内联 top，
    // 否则会带着上次在画面里的像素位置飘到屏幕中间。
    if (state.settings?.freePos && boxEl) {
      if (bar) boxEl.style.top = '';
      else reapplyFreePos();
    }
  }

  /**
   * 按当前视频框重新摆一次字幕框（换句、视频框变化后调用）。
   *
   * 纵向位置必须用保存的归一化比例 ny 乘「当前」画面高度重新算，
   * **不能沿用上一次写下的像素 top**。否则小窗里拖到 75% 的位置（506px 高的
   * 画面里约 380px），进全屏后画面变 900px、380px 只剩 42%，字幕会突然
   * 上浮到画面中间 —— 这正是「全屏后位置不对」的成因。
   * 只处理纵向：水平方向永远由 CSS 居中（left:50% + translateX(-50%)）。
   */
  function reapplyFreePos() {
    if (!boxEl) return;
    const g = overlayGeom();
    const pos = state.settings?.freePos;
    const h = boxEl.offsetHeight || 0;
    const pixelTop = parseFloat(boxEl.style.top);
    let y;
    if (pos && Number.isFinite(pos.ny)) {
      y = pos.ny * g.height;          // 按新画面高度换算，相对位置保持不变
    } else if (Number.isFinite(pixelTop)) {
      y = pixelTop;                    // 没有比例可依（旧数据）才退回像素
    } else {
      y = g.height * 0.8;
    }
    boxEl.style.top = Math.round(Math.max(4, Math.min(y, Math.max(4, g.height - h - 4)))) + 'px';
  }

  /**
   * 把保存的自由位置应用到字幕框。
   * 位置只记纵向比例 ny（0~1），水平方向固定居中 —— 这是刻意的：
   * 字幕框宽度随句子长短变化，允许横向拖动会让「居中」这件事变得没有保证，
   * 用户每次都得重新摆；只放开纵向既够用又稳定。
   * 兼容旧数据：早期存过 {nx, ny} 或 {x, y}，这里只取纵向分量。
   */
  function applyFreePosition(pos) {
    if (!boxEl) return;
    if (!pos) {
      overlayEl.removeAttribute('data-free');
      boxEl.style.left = '';
      boxEl.style.top = '';
      return;
    }
    overlayEl.dataset.free = '1';
    // 水平方向不写 left，交给 CSS 居中（含面板打开时的让位规则）
    boxEl.style.left = '';
    const g = overlayGeom();
    let cy;
    if (Number.isFinite(pos.ny)) {
      cy = pos.ny * g.height;
    } else if (Number.isFinite(pos.y)) {
      // 更早的版本存的是视口绝对像素
      cy = pos.y;
    } else {
      cy = g.height * 0.8;
    }
    const h = boxEl.offsetHeight || 0;
    boxEl.style.top = Math.round(Math.max(4, Math.min(cy, Math.max(4, g.height - h - 4)))) + 'px';
  }

  /** 页内面板当前是否可见 */
  function isPanelOpen() {
    return !!panelEl && !panelEl.classList.contains('trace-hidden');
  }

  /**
   * 面板开合时重算覆盖层几何（CSS 里据 --trace-panel-reserve 收窄字幕），
   * 并重新夹紧自由模式下的中心点，避免字幕被面板压住。
   */
  function syncPanelLayout() {
    if (!overlayEl) return;
    lastGeomKey = '';
    applyOverlayFrame();
    if (state.settings?.freePos && boxEl) reapplyFreePos();
  }

  /**
   * 拖拽：按住顶部手柄上下移动字幕框，位置持久化（归一化到视频框的纵向比例）。
   * 水平方向锁死在中间 —— 句子长短变化时字幕以画面中心为轴伸缩，不会左右跑。
   */
  function initDrag() {
    let drag = null;

    const onDown = (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const r = boxEl.getBoundingClientRect();
      // 只记纵向偏移：指针相对框顶的距离。横向不参与计算。
      drag = { dy: ev.clientY - r.top };
      boxEl.classList.add('trace-dragging');
      handleEl.setPointerCapture?.(ev.pointerId);
    };

    const onMove = (ev) => {
      if (!drag) return;
      ev.preventDefault();
      const g = overlayGeom();
      const h = boxEl.offsetHeight || 0;
      // 指针坐标是视口的，覆盖层坐标系是视频框的 → 先减去视频框上沿
      const localY = ev.clientY - drag.dy - g.top;
      const y = Math.max(4, Math.min(localY, Math.max(4, g.height - h - 4)));
      applyFreePosition({ ny: y / g.height });
      // 立即回写成像素，避免拖动过程中反复按比例换算产生累积误差
      boxEl.style.top = Math.round(y) + 'px';
    };

    const onUp = () => {
      if (!drag) return;
      drag = null;
      boxEl.classList.remove('trace-dragging');
      const g = overlayGeom();
      const py = parseFloat(boxEl.style.top);
      savePosition({
        ny: (Number.isFinite(py) ? py : 0) / g.height,
      });
    };

    handleEl.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    // ---- 手柄显隐：鼠标在字幕框上时显示，移开后稍等一会儿再隐藏 ----
    // 为什么需要延迟：手柄在字幕框上方 20px 处，指针从框上移向手柄时会短暂
    // 离开 .trace-sub-box，:hover 立即失效 → 手柄自己消失 → 永远抓不到。
    // 用 320ms 宽限把这段空隙桥接起来，既不影响「不碰字幕就不显示」的观感。
    let hideTimer = null;
    const showHandle = () => {
      clearTimeout(hideTimer);
      hideTimer = null;
      overlayEl.classList.add('trace-hot');
    };
    const scheduleHide = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        hideTimer = null;
        if (!boxEl.classList.contains('trace-dragging')) overlayEl.classList.remove('trace-hot');
      }, 320);
    };
    boxEl.addEventListener('pointerenter', showHandle);
    boxEl.addEventListener('pointerleave', scheduleHide);
    // 指针进到手柄上也要保持显示（手柄是 box 的子元素，但为稳妥再挂一次）
    handleEl.addEventListener('pointerenter', showHandle);
    handleEl.addEventListener('pointerleave', scheduleHide);
    // 拖动期间强制保持，松手后再按指针位置决定
    handleEl.addEventListener('pointerdown', () => showHandle());

    // 窗口尺寸变化时重算覆盖层几何，再重新夹紧中心点，避免字幕框跑到画面外
    window.addEventListener('resize', () => {
      lastGeomKey = '';
      applyOverlayFrame();
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
    // 字幕样式（页内面板实时改）
    overlayEl.style.setProperty('--trace-orig-size', (s.origSize ?? 28) + 'px');
    overlayEl.style.setProperty('--trace-trans-size', (s.transSize ?? 21) + 'px');
    overlayEl.style.setProperty('--trace-orig-color', s.origColor || '#ffffff');
    overlayEl.style.setProperty('--trace-trans-color', s.transColor || '#ebebeb');
    overlayEl.style.setProperty('--trace-alpha', String(s.bgAlpha ?? 0.55));
    overlayEl.style.setProperty('--trace-radius', (s.radius ?? 12) + 'px');
    overlayEl.style.setProperty('--trace-blur', (s.blur ?? 18) + 'px');
    overlayEl.dataset.mode = s.mode;
    overlayEl.classList.toggle('trace-hidden', !s.enabled);
    // 先贴住视频框（写入 --trace-vscale / --trace-panel-reserve），再摆字幕框
    lastGeomKey = '';
    applyOverlayFrame();
    // 有保存的自由位置就进入自由模式，否则回到默认底部居中
    applyFreePosition(s.freePos || null);
    // 悬浮按钮跟着开关键变灰
    if (launcherEl) {
      launcherEl.classList.toggle('trace-off', !s.enabled);
      launcherEl.style.display = s.showLauncher === false ? 'none' : '';
      positionLauncher();
    }
    syncPanelUI();
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
    renderTranslation(sentence);
    transEl.classList.toggle('trace-loading', !sentence.zh && state.translating);
    // 这句里有生词、但当前译文还没有对齐位置（例如先翻完才加的词）→ 补一次对齐
    if (sentence.zh && !sentence.zhSpans?.length && !sentence.zhAlignTried) {
      const saved = collectSavedWords(sentence.text);
      if (saved && saved.size) {
        sentence.zhAlignTried = true;
        realignActive();
      }
    }
    // 句子变长/变短后框高可能变化，自由模式下重新夹一次纵向位置，避免下半截出画面
    if (state.settings?.freePos) reapplyFreePos();
    fitToFrame();
  }

  /**
   * 字幕框太高时按比例缩小字号，让它留在视频画面里。
   *
   * 为什么需要：句子长度差异极大（"Yes." 到 300 字符的 ASR 长句），
   * 固定字号下长句能把框撑到视频画面的一半以上，把画面盖掉。
   * 只靠 subtitles.js 的 splitLong 不够 —— 拆分有 300 字符硬上限，
   * 而且用户可以把字号调到 48px。
   *
   * 做法：量出框的自然高度，如果超过画面高度的 55%，就按超出比例
   * 缩小 --trace-fit（CSS 里与 --trace-font-scale 相乘）。
   * 下限 0.62，再小就不可读了 —— 到那时宁可让框超出，也不缩成蚂蚁字。
   */
  function fitToFrame() {
    if (!overlayEl || !boxEl) return;
    const g = overlayGeom();
    if (!g.height) return;
    // 先复位再量，否则上一句的缩小值会影响这次测量
    overlayEl.style.setProperty('--trace-fit', '1');
    const h = boxEl.offsetHeight || 0;
    if (!h) return;
    const budget = g.height * 0.55;
    if (h <= budget) return;
    const fit = Math.max(0.62, budget / h);
    overlayEl.style.setProperty('--trace-fit', fit.toFixed(3));
  }

  /**
   * 渲染译文。若后台给了生词在译文里的位置（sentence.zhSpans），
   * 就把对应中文片段包成 .trace-saved-zh 高亮出来。
   *
   * 位置来自「带哨兵翻译」：把英文生词用 ⟦n⟧ 包起来送 Google，
   * 中文对应词会落在哨兵之间（原理与实测见 bg.js 的 translateAligned）。
   */
  function renderTranslation(sentence) {
    const zh = sentence.zh || '';
    const spans = Array.isArray(sentence.zhSpans) ? sentence.zhSpans : [];
    if (!zh || !spans.length) {
      transEl.textContent = zh;
      return;
    }
    // 按位置排序并剔除越界/重叠项，然后切片拼接
    const valid = spans
      .filter((s) => Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.end > s.start && s.end <= zh.length)
      .sort((a, b) => a.start - b.start);
    if (!valid.length) {
      transEl.textContent = zh;
      return;
    }
    let html = '';
    let cursor = 0;
    for (const s of valid) {
      if (s.start < cursor) continue; // 与上一段重叠，跳过
      html += escapeHtml(zh.slice(cursor, s.start));
      html += `<span class="trace-saved-zh" data-w="${escapeAttr(s.word)}">${escapeHtml(zh.slice(s.start, s.end))}</span>`;
      cursor = s.end;
    }
    html += escapeHtml(zh.slice(cursor));
    transEl.innerHTML = html;
  }

  /**
   * 字幕里的一个词形，命中生词本里的哪个词？
   * 命中返回**生词本里的那个词**（小写），未命中返回 null。
   *
   * 词形归一化由 subtitles.js 的 wordForms() 提供（与 bg.js 里同一份实现）：
   * 收藏 beverage 之后，字幕里的 beverages 也要高亮、也要能点开同一张生词卡。
   * 精确命中优先，避免生词本里同时有 beverage 和 beverages 时串到另一个词条。
   */
  function findSaved(rawWord) {
    const w = String(rawWord || '').toLowerCase();
    if (!w || !state.wordSet || !state.wordSet.size) return null;
    if (state.wordSet.has(w)) return w;
    const S = window.TraceSubs;
    if (!S || typeof S.wordForms !== 'function') return null;
    for (const cand of S.wordForms(w)) {
      if (cand !== w && state.wordSet.has(cand)) return cand;
    }
    return null;
  }

  /** 这句话里哪些词是生词（小写集合），用于后台打标记 */
  function collectSavedWords(text) {
    if (!state.wordSet || !state.wordSet.size) return null;
    const found = new Set();
    const re = /[A-Za-z][A-Za-z'’-]*/g;
    let m;
    while ((m = re.exec(text))) {
      const canon = findSaved(m[0]);
      if (canon) found.add(canon);
    }
    return found.size ? found : null;
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
        // 命中生词本（含词形变化）时，data-w 记**生词本里的那个词**，
        // 这样点 beverages 打开的是 beverage 的词卡，按钮显示「✓ 已在生词本」。
        const canon = findSaved(word);
        const saved = !!canon;
        return (
          escapeHtml(pre) +
          `<span class="trace-word${saved ? ' trace-saved' : ''}" data-w="${escapeAttr(
            canon || word
          )}">` +
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

  // 每次翻译启动都拿一个自增代号。字幕重新加载时旧的一轮必须作废，
  // 否则会出现「旧批次把译文写进已丢弃的句子对象，新句子永远没译文」的竞态。
  let translateGen = 0;

  async function translateAll() {
    if (!state.sentences.length) return;
    const gen = ++translateGen;
    state.translating = true;
    const target = state.settings?.targetLang || 'zh-CN';
    // 记下这一轮用的目标语言：设置晚到时（init 先用了默认值）靠它判断要不要重翻
    state.translatedTarget = target;

    try {
      // 分批送翻译，边翻边渲染，不必等全部完成
      const BATCH = 25;
      for (let i = 0; i < state.sentences.length; i += BATCH) {
        if (gen !== translateGen) return; // 已被更新的一轮取代
        const chunk = state.sentences.slice(i, i + BATCH);
        await translateChunk(chunk, chunk.map((s) => s.text), target, gen);
        if (gen !== translateGen) return;
        if (state.active) renderActive(state.active);
        await new Promise((r) => setTimeout(r, 80));
      }

      // 收尾：对仍然没有译文的句子再补一轮（网络抖动/限流时很常见）
      const missing = state.sentences.filter((s) => !s.zh);
      if (missing.length && gen === translateGen) {
        console.info(`[Trace] 补翻 ${missing.length} 句缺失译文`);
        const mChunk = missing.slice(0, 40);
        await translateChunk(mChunk, mChunk.map((s) => s.text), target, gen);
      }
    } catch (e) {
      console.warn('[Trace] 翻译流程异常', e);
    } finally {
      // 只有当前这一轮才有权收尾，避免把新一轮的 translating 提前清掉
      if (gen === translateGen) {
        state.translating = false;
        const total = state.sentences.length;
        const done = state.sentences.filter((s) => s.zh).length;
        console.info(`[Trace] 译文就绪 ${done}/${total} 句（引擎 ${state.settings?.engine}）`);
        if (done < total) {
          console.warn(
            `[Trace] 有 ${total - done} 句没拿到译文。可尝试：① popup 里换翻译引擎；` +
              '② 刷新页面重试；③ 把这条日志反馈给开发者'
          );
        }
        if (state.active) renderActive(state.active);
      }
    }
  }

  /**
   * 带超时的 sendMessage。
   *
   * MV3 的 service worker 会空闲休眠；长视频要翻几百句时，如果后台在两次
   * 消息之间被回收，原生的 sendMessage 会一直挂着（或直接 reject
   * "message port closed"），表现出来就是"翻译到一半没了"。
   * 这里统一加超时，让上层能重试。
   */
  function sendMsg(msg, ms = 20000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('message timeout: ' + msg.type));
      }, ms);
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message || String(err)));
          else resolve(res);
        });
      } catch (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /** 翻译一小批句子，失败自动重试一次；同时取回生词在译文中的位置 */
  async function translateChunk(chunk, texts, target, gen) {
    // 源语言用轨道声明的语言；轨道没给就交给后台 auto 探测
    const source = state.track?.languageCode || 'auto';
    // 每句带上"这句话里哪些词是生词"，后台据此打标记做译文对齐
    const wordSets = texts.map((t) => collectSavedWords(t));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const out = await sendMsg({
          type: 'translate:aligned',
          texts,
          wordSets: wordSets.map((s) => (s ? [...s] : [])),
          source,
          target,
        }, 30000);
        if (gen != null && gen !== translateGen) return; // 结果过期，丢弃
        if (out && out.ok && out.data && Array.isArray(out.data.texts)) {
          let filled = 0;
          out.data.texts.forEach((zh, j) => {
            if (zh && String(zh).trim() && chunk[j]) {
              chunk[j].zh = zh;
              chunk[j].zhSpans = out.data.spans?.[j] || [];
              filled++;
            }
          });
          if (filled) return;
        }
        if (out && out.ok === false) {
          console.warn('[Trace] 后台翻译报错', out.error);
        }
      } catch (e) {
        console.warn(`[Trace] 翻译请求失败（第 ${attempt + 1} 次）`, e.message || e);
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 + attempt * 700));
    }
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
    // 跟随视频框：全屏切换、影院模式、窗口缩放、顶栏折叠都会改变播放器矩形。
    // 放在 rAF 里做是因为 YouTube 的这些变化没有统一事件，而且 applyOverlayFrame
    // 内部有几何签名去重，没变化时只是一次字符串比较，开销可以忽略。
    applyOverlayFrame();
    // 让路：YouTube 设置菜单弹出时，字幕框若压住它就淡出 + 点击穿透。
    // 内部有 120ms 节流，不会每帧强制布局。
    syncDodge();
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
    // 英文词（.trace-word）和译文里高亮的中文（.trace-saved-zh）都能点，
    // 两者都带 data-w = 英文原词，所以打开的是同一张生词卡。
    const el = ev.target.closest('.trace-word, .trace-saved-zh');
    if (!el) return;
    const word = el.dataset.w;
    if (!word) return;

    const rect = el.getBoundingClientRect();
    const pop = ensurePopup();
    // data-w 在渲染时已归一化成生词本里的那个词（点 beverages 拿到 beverage），
    // 但历史渲染结果或手动构造的节点可能还是原始词形，这里再归一化一次兜底。
    const canon = findSaved(word) || word;
    // 生词在译文里被高亮时，后台同时给了它在那句话里的译法（zhSpans）。
    // 这是「这个词在这句里到底译成什么」最权威的答案 —— 词典给的是通用义，
    // 常常和语境义不一致（vintage 词典「优质的」/ 本句「复古」），用户会以为翻错了。
    const spanZh =
      (state.active?.zhSpans || []).find(
        (s) => String(s?.word || '').toLowerCase() === String(canon).toLowerCase()
      )?.zh || '';
    state.wordPopup = {
      word: canon,
      saved: !!findSaved(word),
      context: state.active?.text || '',
      contextZh: state.active?.zh || '',
      contextWordZh: spanZh,
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
      .sendMessage({ type: 'word:has', word: canon })
      .then((r) => (r && r.ok ? !!r.data : false))
      .catch(() => state.wordPopup?.saved || false);

    let dict = null;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'dict', word: canon });
      if (r && r.ok) dict = r.data;
    } catch (_) {}

    const saved = await savedTask;
    if (state.wordPopup) state.wordPopup.saved = saved;
    // 以服务端（IndexedDB）结果为准同步高亮集合
    if (saved) state.wordSet.add(canon);
    else state.wordSet.delete(canon);

    if (!dict) {
      pop.querySelector('.trace-pop-body').innerHTML =
        '<div class="trace-pop-loading">查询失败</div>';
      return;
    }

    state.wordPopup = { ...state.wordPopup, ...dict, saved };
    // 卡片以中文为主：最上面是这个词在当前语境下的中文，往下是中文释义，
    // 英文原文折到「英文释义」里默认收起 —— 用户要看的是翻译，不是英文解释。
    const senses = (dict.meanings || [])
      .filter((m) => m.defZh || m.def)
      .slice(0, 4)
      .map(
        (m) =>
          `<li>${
            m.pos ? `<i>${escapeHtml(m.pos)}</i>` : ''
          }<span>${escapeHtml(m.defZh || m.def)}</span></li>`
      )
      .join('');
    const enDefs = (dict.meanings || [])
      .filter((m) => m.def)
      .slice(0, 3)
      .map(
        (m) =>
          `<li>${m.pos ? `<i>${escapeHtml(m.pos)}</i>` : ''}${escapeHtml(m.def)}</li>`
      )
      .join('');
    // 视频里的原句 + 其中文译文：这是「这个词在这里到底什么意思」最直接的答案
    const ctxEn = state.wordPopup?.context || '';
    const ctxZh = state.wordPopup?.contextZh || '';
    // 生词在译文里的译法（来自 zhSpans）。只有已加入生词本、且译文里高亮过才有。
    // 它有时等于词典直译（引擎对单个词就是那样翻的），这时再显示一遍是冗余的，
    // 反而让人以为「本句译作」和「单词直译」是两个不同答案 —— 只在真的不同才显示。
    const spanZhRaw = state.wordPopup?.contextWordZh || '';
    const ctxWordZh =
      spanZhRaw && spanZhRaw !== (dict.zh || '') ? spanZhRaw : '';
    const exEn = dict.example || '';
    const exZh = dict.exampleZh || '';

    pop.querySelector('.trace-pop-body').innerHTML = `
      ${dict.phonetic ? `<div class="trace-pop-phon">${escapeHtml(dict.phonetic)}</div>` : ''}
      ${
        // 这句里它译成了什么 —— 比词典义更贴合当前语境，放最前面，
        // 让用户先看到「复古」再看词典的「优质的」，就不会觉得两边打架。
        ctxWordZh
          ? `<div class="trace-pop-ctxword">本句译作「${escapeHtml(ctxWordZh)}」</div>`
          : ''
      }
      ${
        // 有中文释义清单时，清单就是主体；单词的「直译」降级成一行小字。
        // 反过来（没有清单）时，直译就是唯一的中文，必须当主体显示。
        // 早期两者都放大并列，用户会看到「优质的」和字幕里的「复古」打架，
        // 以为翻译错了 —— 其实一个是词典义、一个是语境义。
        senses
          ? dict.zh
            ? `<div class="trace-pop-gloss">单词直译：${escapeHtml(dict.zh)}</div>`
            : ''
          : dict.zh
          ? `<div class="trace-pop-zh">${escapeHtml(dict.zh)}</div>`
          : ''
      }
      ${senses ? `<ul class="trace-pop-senses">${senses}</ul>` : ''}
      ${
        ctxEn
          ? `<div class="trace-pop-block">
              <div class="trace-pop-label">本句译文</div>
              <div class="trace-pop-ctx">${escapeHtml(ctxEn)}</div>
              ${ctxZh ? `<div class="trace-pop-ctx-zh">${escapeHtml(ctxZh)}</div>` : ''}
            </div>`
          : ''
      }
      ${
        exEn
          ? `<div class="trace-pop-block">
              <div class="trace-pop-label">例句</div>
              <div class="trace-pop-ctx">${escapeHtml(exEn)}</div>
              ${exZh ? `<div class="trace-pop-ctx-zh">${escapeHtml(exZh)}</div>` : ''}
            </div>`
          : ''
      }
      ${
        enDefs
          ? `<details class="trace-pop-more">
              <summary>英文原文释义</summary>
              <ul class="trace-pop-meanings">${enDefs}</ul>
            </details>`
          : ''
      }
      <div class="trace-pop-actions">
        ${
          saved
            ? '<button class="trace-pop-add trace-done" data-act="remove">✓ 已在生词本</button>'
            : '<button class="trace-pop-add" data-act="add">＋ 加入生词本</button>'
        }
      </div>`;
    // 内容渲染后弹窗变高了，必须重新定位，否则会压住字幕
    positionPopup(pop, rect);

    // 展开/收起「英文原文释义」会改变卡片高度，也要重新定位，
    // 否则展开后卡片向下长出去，正好盖住字幕。
    const more = pop.querySelector('.trace-pop-more');
    if (more) {
      more.addEventListener('toggle', () => positionPopup(pop, rect));
    }
  }

  function positionPopup(pop, rect) {
    const pad = 8;
    // 卡片内容变多了（中文释义 + 视频原句 + 例句 + 折叠的英文释义），
    // 300px 宽会把中文释义挤成三四行；340px 在这个信息量下折行最舒服。
    const w = 340;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
    pop.style.width = w + 'px';
    pop.style.left = left + 'px';

    // 先放到 0 处测量真实高度
    pop.style.top = '0px';
    // 卡片变高后可能超出视口，给它一个上限（内容多时内部滚动）
    const maxH = Math.round(window.innerHeight * 0.62);
    pop.querySelector('.trace-pop-body').style.maxHeight = maxH + 'px';
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

  /**
   * 重新渲染当前这一句，让新增/移除的生词高亮立刻生效。
   *
   * 英文侧是本地重渲染（立刻见效）；中文侧的位置需要重新对齐，
   * 所以这里先按旧位置渲染一次，再异步请求对齐后补上。
   */
  function refreshActiveWords() {
    if (!state.active || !overlayEl) return;
    origEl.innerHTML = renderWords(state.active.text);
    // 中文高亮依赖译文对齐位置，词表变了必须重新要一次
    realignActive();
  }

  /** 针对当前句重新请求一次带对齐的翻译，只更新这一句 */
  let alignGen = 0;
  async function realignActive() {
    const sentence = state.active;
    if (!sentence || !sentence.zh) return;
    const gen = ++alignGen;
    try {
      const out = await sendMsg({
        type: 'translate:aligned',
        texts: [sentence.text],
        wordSets: [(() => {
          const s = collectSavedWords(sentence.text);
          return s ? [...s] : [];
        })()],
        source: state.track?.languageCode || 'auto',
        target: state.settings?.targetLang || 'zh-CN',
      }, 20000);
      if (gen !== alignGen) return;
      if (out && out.ok && out.data && Array.isArray(out.data.texts)) {
        const zh = out.data.texts[0];
        if (zh && zh.trim()) {
          sentence.zh = zh;
          sentence.zhSpans = out.data.spans?.[0] || [];
          if (state.active === sentence) renderTranslation(sentence);
        }
      }
    } catch (_) {
      /* 对齐失败不影响字幕本身 */
    }
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
      if (!popupEl.contains(e.target) && !e.target.closest('.trace-word, .trace-saved-zh')) hidePopup();
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

  // ------------------------------------------------------------ 设置兜底
  //
  // MV3 的 service worker 会空闲休眠，冷启动要几百毫秒到几秒。
  // 早期版本 init() 里第一句就是 `await chrome.runtime.sendMessage({type:'settings:get'})`
  // 且**没有超时**，一旦这个 Promise 迟迟不 resolve，init 后面全部不执行：
  // buildOverlay 没跑 → 没有字幕层；scheduleLoad 没跑 → 不去抓字幕轨。
  // 用户看到的就是"刷新页面后只有 YouTube 自带字幕，点一下插件图标（唤醒 SW）
  // 之后字幕才冒出来"。
  // 修法：settings:get 用带超时的 sendMsg，失败就用这份默认值继续，绝不阻塞主流程。
  const FALLBACK_SETTINGS = {
    enabled: true,
    targetLang: 'zh-CN',
    sourceLang: 'auto',
    mode: 'bilingual',
    fontScale: 1,
    position: 18,
    freePos: null,
    engine: 'google',
    autoHideNative: true,
    clickWord: true,
    origSize: 28,
    transSize: 21,
    origColor: '#ffffff',
    transColor: '#ebebeb',
    bgAlpha: 0.55,
    radius: 12,
    blur: 18,
    showLauncher: true,
    globalMode: false,
  };

  /**
   * 拉一次设置。超时/失败都退回默认值并记一条日志。
   * 拿到真设置后会自动 applySettingsToOverlay()，让界面追上来。
   */
  async function loadSettings(ms = 2500) {
    try {
      const r = await sendMsg({ type: 'settings:get' }, ms);
      if (r && r.ok && r.data) {
        state.settings = { ...FALLBACK_SETTINGS, ...r.data };
        return true;
      }
    } catch (e) {
      console.warn('[Trace] 读取设置超时，先用默认值继续', e.message || e);
    }
    state.settings = { ...FALLBACK_SETTINGS };
    return false;
  }

  async function init() {
    // 先用默认值把界面立起来，再异步拉真设置。
    // 这样即使后台还没醒，字幕层和抓字幕流程也已经在跑了。
    state.settings = { ...FALLBACK_SETTINGS };
    buildOverlay();
    buildLauncher();
    applySettingsToOverlay();
    state.videoId = getVideoId();
    loadWordSet();
    startLoop();

    // 全屏切换时立刻重算一次（rAF 里也会跟，但这一下能消掉一帧的滞后）
    document.addEventListener('fullscreenchange', () => {
      lastGeomKey = '';
      applyOverlayFrame();
    });

    // 监听页面切换 / 播放器就绪
    window.addEventListener('yt-navigate-finish', () => scheduleLoad(700));
    document.addEventListener('yt-page-data-updated', () => scheduleLoad(700));

    const obs = new MutationObserver(() => {
      if (getVideo() && !state.ready && !loadTimer) scheduleLoad(800);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    // 字幕抓取不依赖设置，立刻开跑
    scheduleLoad(1000);

    // 设置随后到：到了再套用一次（可能改变语言/引擎/样式）
    const ok = await loadSettings(2500);
    if (ok) {
      applySettingsToOverlay();
      if (state.active) renderActive(state.active);
      // 之前用默认语言（zh-CN）翻过的句子，若真实目标语言不同，需要重翻
      if (state.sentences.length && state.sentences.some((s) => s.zh)) {
        const target = state.settings.targetLang || 'zh-CN';
        if (state.translatedTarget && state.translatedTarget !== target) {
          state.sentences.forEach((s) => {
            s.zh = '';
            s.zhSpans = [];
            s.zhAlignTried = false;
          });
          translateAll();
        }
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'settings:changed') {
      const prevTarget = state.settings?.targetLang;
      const prevEngine = state.settings?.engine;
      state.settings = msg.settings;
      applySettingsToOverlay();
      // 目标语言或引擎变了，旧译文全部作废（否则会串语言 / 残留失败结果）
      if (
        state.sentences.length &&
        (prevTarget !== state.settings.targetLang || prevEngine !== state.settings.engine)
      ) {
        state.sentences.forEach((s) => {
          s.zh = '';
        });
      }
      if (state.active) renderActive(state.active);
      if (msg.retranslate || (state.sentences.length && state.sentences.some((s) => !s.zh))) {
        translateAll();
      }
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
