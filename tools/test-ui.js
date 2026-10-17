/**
 * 新增 UI 回归测试：
 *   A. 拖动手柄只在鼠标悬停字幕框时显示，移开即隐藏（m01505 需求）
 *   B. 播放器右下角悬浮按钮存在、贴边、可点击打开页内设置面板
 *   C. 面板里的「字幕样式」真的生效（改字号/透明度 → CSS 变量与计算样式都变）
 *
 * 注意：content script 跑在隔离世界，但它创建的 DOM 是共享的，
 * 所以 page.evaluate 能看到 #trace-launcher / #trace-panel / #trace-sub-overlay。
 */
const path = require('path');
const { chromium } = require('playwright');
const F = require('./mock/fixtures');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const ORIGIN = 'https://www.youtube.com';

(async () => {
  const ctx = await chromium.launchPersistentContext('.chrome-ui', {
    headless: false,
    executablePath: CHROME,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--mute-audio'],
    viewport: { width: 1280, height: 900 },
  });

  const cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' };
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/youtubei/v1/player') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ playerResponse: F.playerResponse() }) });
    }
    if (p === '/api/timedtext') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: F.json3Body() });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: F.pageHtml() });
  });

  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/watch?v=${F.VIDEO_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.trace-sub-box', { state: 'attached', timeout: 20000 });
  await page.waitForTimeout(3000);

  const out = {};

  // ---------------------------------------------------------- A. 手柄悬停显隐
  const handleOpacity = () => page.evaluate(() => {
    const h = document.querySelector('.trace-drag-handle');
    if (!h) return null;
    const cs = getComputedStyle(h);
    return { opacity: Number(cs.opacity), visibility: cs.visibility, pointerEvents: cs.pointerEvents };
  });

  // 把鼠标移到远离字幕的地方
  await page.mouse.move(60, 60);
  await page.waitForTimeout(400);
  out.handleIdle = await handleOpacity();

  // 移到字幕框正中
  const boxRect = await page.locator('.trace-sub-box').boundingBox();
  await page.mouse.move(boxRect.x + boxRect.width / 2, boxRect.y + boxRect.height / 2);
  await page.waitForTimeout(400);
  out.handleHover = await handleOpacity();

  // 再移开，确认又隐藏。
  // 注意要等足够久：JS 有 320ms 宽限延迟，之后 opacity 还有 .16s 过渡，
  // 总共约 480ms 才完全淡出；这里取 800ms 保证采样到的是终态。
  await page.mouse.move(60, 60);
  await page.waitForTimeout(800);
  out.handleAfterLeave = await handleOpacity();

  // ---------------------------------------------------------- B. 悬浮按钮
  out.launcher = await page.evaluate(() => {
    const el = document.getElementById('trace-launcher');
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    const mp = document.getElementById('movie_player');
    const mr = mp ? mp.getBoundingClientRect() : null;
    return {
      present: true,
      text: (el.textContent || '').trim(),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      player: mr ? { right: Math.round(mr.right), bottom: Math.round(mr.bottom) } : null,
      // 按钮应完全落在播放器右下角内部
      insidePlayer: !!(mr && r.right <= mr.right + 1 && r.bottom <= mr.bottom + 1 && r.left >= mr.left && r.top >= mr.top),
      panelExists: !!document.getElementById('trace-panel'),
      panelHiddenBefore: (document.getElementById('trace-panel') || {}).className || null,
    };
  });

  // 点开面板
  await page.click('#trace-launcher');
  await page.waitForTimeout(400);
  out.panelAfterClick = await page.evaluate(() => {
    const p = document.getElementById('trace-panel');
    if (!p) return { present: false };
    const r = p.getBoundingClientRect();
    const rows = [...p.querySelectorAll('.tp-row .tp-label')].map((x) => x.textContent.trim());
    const groups = [...p.querySelectorAll('.tp-group-head span:first-child')].map((x) => x.textContent.trim());
    return {
      present: true,
      visible: !p.classList.contains('trace-hidden') && r.width > 100,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      rows,
      groups,
      hasStyleControls: !!p.querySelector('[data-k="origSize"]') && !!p.querySelector('[data-k="bgAlpha"]') && !!p.querySelector('[data-k="blur"]'),
    };
  });

  // ---------------------------------------------------------- 面板不遮挡字幕
  // 面板打开时字幕必须让位：字幕框右缘不能伸到面板左缘之下，否则长句会被硬切。
  // 等一拍让 .trace-panel-open 的 CSS 生效并重新夹紧。
  await page.waitForTimeout(300);
  out.panelClearance = await page.evaluate(() => {
    const p = document.getElementById('trace-panel');
    const box = document.querySelector('.trace-sub-box');
    const ov = document.getElementById('trace-sub-overlay');
    if (!p || !box) return { ok: false, reason: 'missing nodes' };
    const pr = p.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    return {
      ok: true,
      panelLeft: Math.round(pr.left),
      boxRight: Math.round(br.right),
      boxLeft: Math.round(br.left),
      boxWidth: Math.round(br.width),
      overlapPx: Math.round(br.right - pr.left),
      overlayHasClass: ov.classList.contains('trace-panel-open'),
      hasOpenSubtitle: (document.querySelector('.trace-sub-orig')?.textContent || '').length > 0,
    };
  });

  // ---------------------------------------------------------- C. 样式真的生效
  // 展开「字幕样式」分组（默认已展开，稳妥点再确保一次）
  await page.evaluate(() => {
    const g = document.querySelector('#trace-panel .tp-group[data-group="style"]');
    if (g && !g.classList.contains('tp-open')) g.querySelector('.tp-group-head').click();
  });
  await page.waitForTimeout(200);

  const styleProbe = () => page.evaluate(() => {
    const ov = document.getElementById('trace-sub-overlay');
    const box = document.querySelector('.trace-sub-box');
    const orig = document.querySelector('.trace-sub-orig');
    const trans = document.querySelector('.trace-sub-trans');
    const csBox = box ? getComputedStyle(box) : null;
    const csOrig = orig ? getComputedStyle(orig) : null;
    const csTrans = trans ? getComputedStyle(trans) : null;
    return {
      varOrig: ov ? ov.style.getPropertyValue('--trace-orig-size') : null,
      varAlpha: ov ? ov.style.getPropertyValue('--trace-alpha') : null,
      varRadius: ov ? ov.style.getPropertyValue('--trace-radius') : null,
      origFontPx: csOrig ? Math.round(parseFloat(csOrig.fontSize)) : null,
      transFontPx: csTrans ? Math.round(parseFloat(csTrans.fontSize)) : null,
      boxRadius: csBox ? csBox.borderTopLeftRadius : null,
      boxBg: csBox ? csBox.backgroundColor : null,
      origColor: csOrig ? csOrig.color : null,
    };
  });

  out.styleBefore = await styleProbe();

  // 用真实拖动 range 的方式改值（直接设 value + 派发 input 事件，等价于用户拖动）
  await page.evaluate(() => {
    const set = (k, v) => {
      const el = document.querySelector(`#trace-panel [data-k="${k}"]`);
      if (!el) return;
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('origSize', 40);
    set('transSize', 30);
    set('bgAlpha', 0.9);
    set('radius', 24);
  });
  await page.waitForTimeout(500);
  out.styleAfter = await styleProbe();

  // 面板值是否同步显示
  out.panelLabels = await page.evaluate(() => {
    const pick = (k) => {
      const el = document.querySelector(`#trace-panel .tp-val[data-v="${k}"]`);
      return el ? el.textContent : null;
    };
    return { origSize: pick('origSize'), transSize: pick('transSize'), bgAlpha: pick('bgAlpha'), radius: pick('radius') };
  });

  // 设置应已持久化到 background（等防抖 220ms + 消息往返）
  await page.waitForTimeout(600);
  const sw = ctx.serviceWorkers()[0];
  out.persisted = await sw.evaluate(async () => {
    const s = await globalThis.__traceDebug.getSettings();
    return { origSize: s.origSize, transSize: s.transSize, bgAlpha: s.bgAlpha, radius: s.radius, blur: s.blur };
  });

  // 关闭面板前留一张「面板展开 + 字幕样式已改」的截图
  await page.screenshot({ path: 'shot-ui-panel.png' });

  // 关闭面板
  await page.click('#trace-panel .tp-close');
  await page.waitForTimeout(300);
  out.panelClosed = await page.evaluate(() => {
    const p = document.getElementById('trace-panel');
    return { hidden: p ? p.classList.contains('trace-hidden') : null };
  });

  await page.screenshot({ path: 'shot-ui.png' });

  // ---------------------------------------------------------- 判定
  const handleHidesWhenIdle = out.handleIdle.opacity < 0.05 && out.handleIdle.visibility === 'hidden';
  const handleShowsOnHover = out.handleHover.opacity > 0.9 && out.handleHover.visibility === 'visible' && out.handleHover.pointerEvents === 'auto';
  const handleHidesAgain = out.handleAfterLeave.opacity < 0.05;

  const launcherOk = out.launcher.present && out.launcher.insidePlayer;
  const panelOk = out.panelAfterClick.present && out.panelAfterClick.visible && out.panelAfterClick.hasStyleControls;
  // 面板打开时字幕让位：不得与面板横向重叠（允许 2px 亚像素误差），
  // 同时不能因为收窄而把左边缘推出视口（max-width 作用在内容盒上，padding 要算进来）
  const panelClearanceOk = out.panelClearance.ok
    && out.panelClearance.overlayHasClass
    && out.panelClearance.overlapPx <= 2
    && out.panelClearance.boxLeft >= 0;

  const sizeChanged = out.styleAfter.origFontPx === 40 && out.styleAfter.transFontPx === 30;
  const alphaChanged = out.styleAfter.varAlpha === '0.9' && out.styleAfter.boxBg.includes('0.9');
  const radiusChanged = out.styleAfter.boxRadius === '24px';
  const persistedOk =
    out.persisted.origSize === 40 && out.persisted.transSize === 30 &&
    Math.abs(out.persisted.bgAlpha - 0.9) < 1e-6 && out.persisted.radius === 24;
  const panelClosedOk = out.panelClosed.hidden === true;

  console.log(JSON.stringify({
    handle: { idle: out.handleIdle, hover: out.handleHover, afterLeave: out.handleAfterLeave },
    launcher: out.launcher,
    panel: out.panelAfterClick,
    panelClearance: out.panelClearance,
    styleBefore: out.styleBefore,
    styleAfter: out.styleAfter,
    panelLabels: out.panelLabels,
    persisted: out.persisted,
    panelClosed: out.panelClosed,
    checks: {
      handleHidesWhenIdle,
      handleShowsOnHover,
      handleHidesAgain,
      launcherOk,
      panelOk,
      panelClearanceOk,
      sizeChanged,
      alphaChanged,
      radiusChanged,
      persistedOk,
      panelClosedOk,
    },
  }, null, 2));

  const ok =
    handleHidesWhenIdle && handleShowsOnHover && handleHidesAgain &&
    launcherOk && panelOk && panelClearanceOk && sizeChanged && alphaChanged && radiusChanged &&
    persistedOk && panelClosedOk;
  console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}（手柄悬停显隐 + 右下角悬浮按钮 + 页内设置面板不遮挡字幕 + 字幕样式生效 + 设置持久化）`);
  await ctx.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
