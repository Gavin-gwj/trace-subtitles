/**
 * Trace 字幕翻译 —— 主世界脚本 (MAIN world)
 *
 * YouTube 的字幕数据只存在于页面上下文（player 对象 / 网络响应）里，内容脚本处在
 * 隔离世界无法访问。本脚本运行在页面主世界，用五条冗余路径拿字幕：
 *
 *   A. 网络钩子  —— 拦截 /api/timedtext 响应，直接拿到带 pot 签名的字幕正文（最可靠）
 *   B. 强制加载  —— 调播放器 setOption/loadModule + 点 CC 按钮，让 YouTube 自己去请求，
 *                   钩子顺手截获（解决 pot 缺失导致空响应的问题）
 *   C. 播放器对象 —— movie_player.getPlayerResponse() / getOption('captions','tracklist')
 *   D. 全局变量  —— window.ytInitialPlayerResponse
 *   E. DOM 兜底  —— 直接读 YouTube 自己渲染的 .ytp-caption-segment 文本
 *
 * 关键背景：新版 YouTube 的 timedtext 接口需要 `pot` 参数，自己拼 URL 请求会返回
 * 200 + 空 body（表现为 "empty timedtext"）。只有页面自己发出的请求才带 pot，
 * 所以必须钩网络层。
 */
(() => {
  'use strict';
  if (window.__TRACE_MAIN__) return;
  window.__TRACE_MAIN__ = true;

  const REQ = '__TRACE_REQ__';
  const RES = '__TRACE_RES__';

  // ---------------------------------------------------------------- 工具

  function currentVideoId() {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
      if (m) return m[1];
    } catch (_) {}
    return '';
  }

  function isTimedText(url) {
    return typeof url === 'string' && /\/api\/timedtext|\/timedtext\b/.test(url);
  }

  function langOfUrl(url) {
    try {
      return new URL(url, location.origin).searchParams.get('lang') || '';
    } catch (_) {
      return '';
    }
  }

  function kindOfText(text) {
    const s = (text || '').trimStart();
    if (s.startsWith('{')) return 'json3';
    if (s.startsWith('<')) {
      if (/<transcript[\s>]/.test(s.slice(0, 400))) return 'srv1';
      return 'srv3';
    }
    if (/^WEBVTT/.test(s)) return 'vtt';
    return 'unknown';
  }

  // ---------------------------------------------------------------- A. 网络钩子
  //
  // 只保留当前视频、且内容非空的 timedtext 响应。这是唯一能拿到 pot 签名正文的路径。

  let captured = []; // { url, lang, kind, text, at, vid }

  function videoIdOfUrl(url) {
    try {
      return new URL(url, location.origin).searchParams.get('v') || '';
    } catch (_) {
      return '';
    }
  }

  function captureCaption(url, text) {
    if (!text || !text.trim()) return false;
    const rec = {
      url,
      lang: langOfUrl(url),
      kind: kindOfText(text),
      text,
      at: Date.now(),
      vid: videoIdOfUrl(url),
    };
    const i = captured.findIndex((r) => r.url === url);
    if (i >= 0) captured[i] = rec;
    else captured.push(rec);
    // 只保留最近 8 条，避免长视频占内存
    if (captured.length > 8) captured = captured.slice(-8);

    window.postMessage(
      { type: RES, id: 'captions-captured', ok: true, data: { lang: rec.lang, len: text.length, kind: rec.kind } },
      location.origin
    );
    return true;
  }

  /**
   * 找已捕获的字幕。按当前视频过滤（timedtext URL 里带 v=），
   * 避免切换视频后拿到上一个视频的字幕。
   */
  function findCaptured(lang) {
    if (!captured.length) return null;
    const vid = currentVideoId();
    const byVideo = vid ? captured.filter((r) => !r.vid || r.vid === vid) : captured;
    if (!byVideo.length) return null;
    const hits = lang ? byVideo.filter((r) => r.lang === lang) : [];
    const pool = hits.length ? hits : byVideo;
    return pool[pool.length - 1];
  }

  // 钩 fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (isTimedText(url)) {
          p.then((res) => {
            res.clone().text().then((t) => captureCaption(url, t)).catch(() => {});
          }).catch(() => {});
        }
      } catch (_) {}
      return p;
    };
  }

  // 钩 XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__traceUrl = url; } catch (_) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      if (isTimedText(this.__traceUrl)) {
        const url = this.__traceUrl;
        this.addEventListener('load', () => {
          try {
            const t = this.responseText;
            if (t && t.trim()) captureCaption(url, t);
          } catch (_) {}
        });
      }
    } catch (_) {}
    return origSend.apply(this, arguments);
  };

  // ---------------------------------------------------------------- C/D. 播放器与全局对象

  function getPlayer() {
    return (
      document.getElementById('movie_player') ||
      document.querySelector('.html5-video-player') ||
      document.querySelector('ytd-player')
    );
  }

  /** 从任意 playerResponse 形状里抽出字幕轨 */
  function tracksFromPlayerResponse(pr) {
    const tl =
      pr && pr.captions &&
      pr.captions.playerCaptionsTracklistRenderer &&
      pr.captions.playerCaptionsTracklistRenderer.captionTracks;
    return Array.isArray(tl) ? tl : null;
  }

  let cachedResponse = null;

  function rememberResponse(pr) {
    if (!pr || typeof pr !== 'object') return;
    const tl = tracksFromPlayerResponse(pr);
    if (tl && tl.length) {
      cachedResponse = pr;
      window.postMessage({ type: RES, id: 'tracks-ready', ok: true, data: tl.length }, location.origin);
    } else if (!cachedResponse && pr.videoDetails) {
      cachedResponse = pr;
    }
  }

  function responseVideoId(pr) {
    try {
      return (pr && pr.videoDetails && pr.videoDetails.videoId) || '';
    } catch (_) {
      return '';
    }
  }

  function handlePlayerJson(json) {
    if (!json || typeof json !== 'object') return;
    const pr = json.playerResponse || json;
    const vid = responseVideoId(pr);
    if (vid && currentVideoId() && vid !== currentVideoId()) return; // 防止导航后串台
    rememberResponse(pr);
  }

  // 额外钩 /youtubei/v1/player 与 /v1/next，缓存 playerResponse 与文字稿 params
  (function hookInnertube() {
    const of = window.fetch;
    window.fetch = function (input, init) {
      const p = of.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (/\/youtubei\/v1\/player/.test(url)) {
          p.then((res) => {
            res.clone().json().then(handlePlayerJson).catch(() => {});
          }).catch(() => {});
        } else if (/\/youtubei\/v1\/next/.test(url)) {
          p.then((res) => {
            res.clone().json().then(rememberTranscriptParams).catch(() => {});
          }).catch(() => {});
        }
      } catch (_) {}
      return p;
    };
  })();

  function candidateResponses() {
    const out = [];
    const push = (pr) => { if (pr && typeof pr === 'object') out.push(pr); };
    push(cachedResponse);
    const p = getPlayer();
    if (p) {
      try { if (typeof p.getPlayerResponse === 'function') push(p.getPlayerResponse()); } catch (_) {}
      try { if (typeof p.getEmbeddedPlayerResponse === 'function') push(p.getEmbeddedPlayerResponse()); } catch (_) {}
    }
    push(window.ytInitialPlayerResponse);
    return out;
  }

  // ---------------------------------------------------------------- 轨道读取

  function normalizeTrack(t) {
    const base = t.baseUrl || t.base_url;
    if (!base) return null;
    const code = t.languageCode || t.language_code || '';
    return {
      vssId: t.vssId || t.vss_id || '',
      languageCode: code,
      name:
        (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) ||
        code,
      kind: t.kind || '',
      isTranslatable: !!t.isTranslatable,
      baseUrl: base,
    };
  }

  function readTracks() {
    const out = [];
    const seen = new Set();

    const push = (t) => {
      const n = normalizeTrack(t);
      if (!n) return;
      // 同一语言同一 kind 视为同一条，但保留先到的（tracklist 通常带 pot，后到的会覆盖）
      const key = n.vssId + '|' + n.languageCode + '|' + n.kind;
      if (seen.has(key)) {
        const i = out.findIndex(
          (x) => x.vssId === n.vssId && x.languageCode === n.languageCode && x.kind === n.kind
        );
        if (i >= 0) out[i] = n; // 后来的覆盖，优先 tracklist 的带签名 URL
        return;
      }
      seen.add(key);
      out.push(n);
    };

    for (const pr of candidateResponses()) {
      const tl = tracksFromPlayerResponse(pr);
      if (Array.isArray(tl)) tl.forEach(push);
    }

    // 播放器内部加载的轨道（通常带 pot 签名，比 playerResponse 里的更可用）
    const p = getPlayer();
    try {
      const opt = p && p.getOption && p.getOption('captions', 'tracklist');
      if (Array.isArray(opt)) opt.forEach(push);
    } catch (_) {}

    return out;
  }

  // ---------------------------------------------------------------- F. 文字稿接口
  //
  // YouTube 的 timedtext 需要 pot 签名，但「显示字幕文稿」用的 get_transcript 接口不需要。
  // params 就在页面 ytInitialData 里（getTranscriptEndpoint.params），拿不到时再退回点 UI。

  function innertubeContext() {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === 'function') {
        const ctx = window.ytcfg.get('INNERTUBE_CONTEXT');
        if (ctx) return ctx;
      }
    } catch (_) {}
    return {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20240101.00.00',
        hl: 'en',
        gl: 'US',
      },
    };
  }

  function innertubeApiKey() {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === 'function') {
        return window.ytcfg.get('INNERTUBE_API_KEY') || '';
      }
    } catch (_) {}
    return '';
  }

  let transcriptParams = '';

  /** 深度搜索 ytInitialData 里的 getTranscriptEndpoint.params */
  function findTranscriptParams(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 14) return '';
    if (obj.getTranscriptEndpoint && obj.getTranscriptEndpoint.params) {
      return obj.getTranscriptEndpoint.params;
    }
    for (const k of Object.keys(obj)) {
      if (k === 'getTranscriptEndpoint') continue;
      const v = obj[k];
      if (v && typeof v === 'object') {
        const r = findTranscriptParams(v, depth + 1);
        if (r) return r;
      }
    }
    return '';
  }

  function rememberTranscriptParams(obj) {
    if (transcriptParams) return;
    const p = findTranscriptParams(obj);
    if (p) transcriptParams = p;
  }

  /** 解析 get_transcript 返回的 cueGroups */
  function parseTranscriptResponse(json) {
    const out = [];
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 12) return;
      if (o.transcriptCueRenderer) {
        const r = o.transcriptCueRenderer;
        const text = (r.cue && r.cue.simpleText) || '';
        const startMs = parseInt(r.startOffsetMs || '0', 10) || 0;
        const durMs = parseInt(r.durationMs || '0', 10) || 0;
        if (text) out.push({ start: startMs / 1000, dur: durMs / 1000, text });
        return;
      }
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(json, 0);
    return out;
  }

  /** 把 transcript 转成 json3 结构，复用既有的解析/分句逻辑 */
  function transcriptToJson3(cues) {
    return JSON.stringify({
      events: cues.map((c) => ({
        tStartMs: Math.round(c.start * 1000),
        dDurationMs: Math.round(c.dur * 1000),
        segs: [{ utf8: c.text }],
      })),
    });
  }

  async function fetchViaTranscriptApi() {
    // 1) 优先用网络钩子从 /youtubei/v1/next 里抓到的 params
    let params = transcriptParams;
    // 2) 其次从 ytInitialData / playerResponse 里挖
    if (!params) {
      try {
        params = findTranscriptParams(window.ytInitialData);
      } catch (_) {}
    }
    if (!params) {
      try {
        const p = getPlayer();
        if (p && typeof p.getPlayerResponse === 'function') {
          params = findTranscriptParams(p.getPlayerResponse());
        }
      } catch (_) {}
    }
    if (!params) return null;

    const key = innertubeApiKey();
    if (!key) return null;

    const url =
      'https://www.youtube.com/youtubei/v1/get_transcript?key=' +
      encodeURIComponent(key) +
      '&prettyPrint=false';
    const body = JSON.stringify({ context: innertubeContext(), params });
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!r.ok) return null;
    const json = await r.json();
    const cues = parseTranscriptResponse(json);
    if (!cues.length) return null;
    return transcriptToJson3(cues);
  }

  // ---------------------------------------------------------------- G. 文字稿面板 DOM
  //
  // 点开 YouTube 自己的「显示字幕文稿」面板，直接读已渲染的段落。
  // 完全绕开 pot / 内部接口，只要页面能显示字幕就一定拿得到。

  function readTranscriptPanel() {
    const nodes = document.querySelectorAll(
      'ytd-transcript-segment-renderer .segment-text, ' +
      'ytd-transcript-segment-renderer yt-formatted-string.segment-text'
    );
    if (!nodes.length) return null;
    const cues = [];
    nodes.forEach((n) => {
      const row = n.closest('ytd-transcript-segment-renderer');
      const stamp = row && row.querySelector('.segment-timestamp');
      const ts = stamp ? parseTimestamp(stamp.textContent || '') : 0;
      const text = (n.textContent || '').trim();
      if (text) cues.push({ start: ts, dur: 0, text });
    });
    if (!cues.length) return null;
    // 面板不带时长：用相邻段起点补，最后一段给 4 秒
    for (let i = 0; i < cues.length; i++) {
      const next = cues[i + 1];
      cues[i].dur = next ? Math.max(0.4, next.start - cues[i].start) : 4;
    }
    return transcriptToJson3(cues);
  }

  function parseTimestamp(s) {
    const parts = s.trim().split(':').map((x) => parseInt(x, 10) || 0);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }

  async function openTranscriptPanel() {
    // 已经开着就直接读
    let t = readTranscriptPanel();
    if (t) return t;

    // 1) 描述区的「显示字幕文稿」按钮
    let btn =
      document.querySelector('ytd-video-description-transcript-section-renderer button') ||
      document.querySelector('#expand[aria-label*="transcript" i]') ||
      document.querySelector('button[aria-label*="transcript" i]');

    // 2) 兜底：从「更多」菜单里找
    if (!btn) {
      try {
        const more = document.querySelector('#button-shape button[aria-label*="more" i], ytd-menu-renderer #button');
        if (more) {
          more.click();
          await new Promise((r) => setTimeout(r, 350));
          const items = Array.from(document.querySelectorAll('ytd-menu-service-item-renderer, tp-yt-paper-item'));
          btn = items.find((el) => /transcript|字幕文稿|文字稿|转写/i.test(el.textContent || ''));
        }
      } catch (_) {}
    }
    if (!btn) return null;

    try { btn.click(); } catch (_) { return null; }

    // 等面板渲染出至少一段
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      t = readTranscriptPanel();
      if (t) return t;
    }
    return null;
  }

  // ---------------------------------------------------------------- E. DOM 兜底

  function readDomCaption() {
    const nodes = document.querySelectorAll('.ytp-caption-segment');
    if (!nodes.length) return '';
    let s = '';
    nodes.forEach((n) => { s += (n.textContent || '') + ' '; });
    return s.replace(/\s+/g, ' ').trim();
  }

  // ---------------------------------------------------------------- 抓字幕正文

  /** 直接请求 timedtext（可能因缺 pot 返回空） */
  async function fetchTimedText(baseUrl) {
    const formats = ['json3', 'srv3', ''];
    let lastErr = null;
    for (const fmt of formats) {
      try {
        const u = new URL(baseUrl, location.origin);
        if (fmt) u.searchParams.set('fmt', fmt);
        const r = await fetch(u.toString(), { credentials: 'include' });
        if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue; }
        const text = await r.text();
        if (text && text.trim()) return { kind: kindOfText(text), text };
        lastErr = new Error('empty timedtext');
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('empty timedtext');
  }

  /** 让播放器自己去请求字幕（带 pot），钩子会截获 */
  async function forcePlayerLoadCaptions(pick) {
    const p = getPlayer();
    if (!p) return false;
    let touched = false;

    // 1) 设置轨道
    if (pick) {
      try {
        p.setOption('captions', 'track', {
          languageCode: pick.languageCode,
          kind: pick.kind || '',
          vssId: pick.vssId || '',
        });
        touched = true;
      } catch (_) {}
    }

    // 2) 加载 captions 模块
    try {
      if (typeof p.loadModule === 'function') { p.loadModule('captions'); touched = true; }
    } catch (_) {}

    // 3) 确保 CC 按钮是开启状态（点击会触发 timedtext 请求）
    try {
      const cc = document.querySelector('.ytp-subtitles-button');
      if (cc && cc.getAttribute('aria-pressed') !== 'true') {
        cc.click();
        touched = true;
      }
    } catch (_) {}

    // 4) 播放器自带的字幕面板也点一下，触发重新拉取
    try {
      const btn = document.querySelector('.ytp-subtitles-button');
      if (btn && btn.getAttribute('aria-pressed') === 'true') {
        // 关掉再开，强制重新请求
        btn.click();
        await new Promise((r) => setTimeout(r, 120));
        btn.click();
        touched = true;
      }
    } catch (_) {}

    return touched;
  }

  /**
   * 确保拿到某个语言的字幕正文。优先级：
   *   已捕获（带 pot） → 直接请求 → 强制播放器加载后等钩子捕获
   */
  async function ensureCaptions(lang) {
    // 1) 钩子里已经有了（带 pot 的原始响应，最可靠）
    let c = findCaptured(lang);
    if (c) return { kind: c.kind, text: c.text, source: 'hook', lang: c.lang };

    const tracks = readTracks();
    const pick =
      (lang && tracks.find((t) => t.languageCode === lang)) ||
      tracks.find((t) => t.languageCode === 'en') ||
      tracks[0];

    // 2) 文字稿接口（不需要 pot，最稳）
    try {
      const t = await fetchViaTranscriptApi();
      if (t) {
        return { kind: 'json3', text: t, source: 'transcript-api', lang: (pick && pick.languageCode) || lang || 'en' };
      }
    } catch (_) {}

    // 3) 直接请求（老视频 / 无 pot 限制时可用）
    if (pick) {
      try {
        const d = await fetchTimedText(pick.baseUrl);
        if (d && d.text) return { ...d, source: 'direct', lang: pick.languageCode };
      } catch (_) {
        /* 继续走强制加载 */
      }
    }

    // 4) 强制播放器加载，等钩子捕获（最多 ~6s）
    await forcePlayerLoadCaptions(pick);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      c = findCaptured(lang || (pick && pick.languageCode));
      if (c) return { kind: c.kind, text: c.text, source: 'hook-forced', lang: c.lang };
      c = findCaptured();
      if (c) return { kind: c.kind, text: c.text, source: 'hook-forced', lang: c.lang };
    }

    // 5) 最后手段：点开「显示字幕文稿」面板读 DOM（会短暂弹出侧栏）
    try {
      const t = await openTranscriptPanel();
      if (t) {
        return { kind: 'json3', text: t, source: 'transcript-panel', lang: (pick && pick.languageCode) || lang || 'en' };
      }
    } catch (_) {}

    return null;
  }

  // ---------------------------------------------------------------- 消息通道

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.type !== REQ) return;

    const reply = (payload) => {
      window.postMessage({ type: RES, id: d.id, ...payload }, location.origin);
    };

    try {
      if (d.action === 'tracks') {
        reply({ ok: true, data: readTracks() });
      } else if (d.action === 'captions') {
        // 新主路径：确保拿到正文
        const data = await ensureCaptions(d.payload && d.payload.lang);
        if (data) reply({ ok: true, data });
        else reply({ ok: false, error: 'empty timedtext' });
      } else if (d.action === 'fetch') {
        // 兼容旧调用
        const data = await fetchTimedText(d.payload.url);
        reply({ ok: true, data });
      } else if (d.action === 'dom-caption') {
        reply({ ok: true, data: readDomCaption() });
      } else if (d.action === 'enable-cc') {
        await forcePlayerLoadCaptions(null);
        reply({ ok: true, data: true });
      } else if (d.action === 'ping') {
        reply({ ok: true, data: true });
      } else {
        reply({ ok: false, error: 'unknown action' });
      }
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
  });

  // 页面切换视频后清空缓存，避免串台（captured 按 vid 过滤，无需清空）
  window.addEventListener('yt-navigate-finish', () => {
    cachedResponse = null;
    transcriptParams = '';
    // 新页面的 ytInitialData 里通常已有文字稿 params
    try { rememberTranscriptParams(window.ytInitialData); } catch (_) {}
    window.postMessage({ type: RES, id: 'nav', ok: true, data: 'navigate' }, location.origin);
  });

  // 首次加载也先挖一次
  try { rememberTranscriptParams(window.ytInitialData); } catch (_) {}
})();
