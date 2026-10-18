/**
 * 需求回归：字幕必须跟着「视频框」走，而不是贴浏览器窗口。
 *
 *   - 非全屏：视频框只是页面里的一块矩形（上方顶栏、右侧推荐栏），
 *     覆盖层要精确贴住这块矩形，字幕不能跑到画面外的黑边/空白上。
 *   - 进全屏：视频框撑满窗口，字幕字号按宽度比例等比放大。
 *   - 退全屏：字号等比例缩回，覆盖层回到视频框矩形。
 *
 * 做法：夹具里给 #movie_player 一个明确的矩形（140,80,900x506），
 * 用 __mockFullscreen() 模拟 YouTube 给播放器加 .ytp-fullscreen。
 */
const path = require('path');
const { chromium } = require('playwright');
const F = require('./mock/fixtures');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const ORIGIN = 'https://www.youtube.com';
const VIEW = { width: 1440, height: 900 };
const FRAME = { left: 140, top: 80, width: 900, height: 506 };

(async () => {
  const ctx = await chromium.launchPersistentContext('.chrome-frame', {
    headless: false,
    executablePath: CHROME,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--mute-audio'],
    viewport: VIEW,
  });

  const cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' };
  const html = F.pageHtml(F.VIDEO_ID, { frame: FRAME });
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/youtubei/v1/player') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ playerResponse: F.playerResponse() }) });
    }
    if (p === '/api/timedtext') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: F.json3Body() });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  });

  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/watch?v=${F.VIDEO_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.trace-sub-box', { state: 'attached', timeout: 20000 });
  await page.waitForTimeout(2500);

  // 钉住时间轴，保证对比字号/位置时句子没变
  await page.evaluate(() => window.__mockPause && window.__mockPause());
  await page.waitForTimeout(400);

  /** 读一次几何快照 */
  const snap = () => page.evaluate(() => {
    const ov = document.querySelector('#trace-sub-overlay');
    const box = document.querySelector('.trace-sub-box');
    const orig = document.querySelector('.trace-sub-orig');
    const mp = document.getElementById('movie_player');
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom), right: Math.round(b.right) };
    };
    const cs = getComputedStyle(ov);
    return {
      overlay: r(ov),
      box: r(box),
      player: r(mp),
      vscale: cs.getPropertyValue('--trace-vscale').trim(),
      reserve: cs.getPropertyValue('--trace-panel-reserve').trim(),
      fontPx: parseFloat(getComputedStyle(orig).fontSize),
      text: (orig.textContent || '').trim().slice(0, 40),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });

  const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
  const overlayMatchesFrame = (s, f) =>
    near(s.overlay.x, f.left) && near(s.overlay.y, f.top) &&
    near(s.overlay.w, f.width) && near(s.overlay.h, f.height);

  // ---------- 1) 非全屏：覆盖层 == 视频框，字幕在框内 ----------
  const normal = await snap();
  const normalOk = overlayMatchesFrame(normal, FRAME);
  const boxInsideFrame = normal.box.y >= FRAME.top - 2 && normal.box.bottom <= FRAME.top + FRAME.height + 2;
  const baseFont = normal.fontPx;
  const vscaleNormal = parseFloat(normal.vscale);

  await page.screenshot({ path: 'shot-frame-normal.png' });

  // ---------- 2) 全屏：覆盖层 == 视口，字号等比放大 ----------
  await page.evaluate(() => window.__mockFullscreen(true));
  await page.waitForTimeout(500);
  const fs = await snap();
  const fsOk = overlayMatchesFrame(fs, { left: 0, top: 0, width: VIEW.width, height: VIEW.height });
  const expectScale = Math.round((VIEW.width / FRAME.width) * 1000) / 1000;
  const vscaleFs = parseFloat(fs.vscale);
  const scaleOk = Math.abs(vscaleFs - expectScale) <= 0.01;
  const fontGrew = fs.fontPx > baseFont * 1.4;
  const fsBoxInside = fs.box.y >= -2 && fs.box.bottom <= VIEW.height + 2;

  await page.screenshot({ path: 'shot-frame-fullscreen.png' });

  // ---------- 3) 退全屏：字号缩回，覆盖层回到视频框 ----------
  await page.evaluate(() => window.__mockFullscreen(false));
  await page.waitForTimeout(500);
  const back = await snap();
  const backOk = overlayMatchesFrame(back, FRAME);
  const vscaleBack = parseFloat(back.vscale);
  const fontBack = Math.abs(back.fontPx - baseFont) <= 1;

  // ---------- 4) 拖动后的纵向相对位置，进出全屏必须保持一致 ----------
  // 曾经的 bug：reapplyFreePos() 沿用上一次写下的像素 top 再夹紧，
  // 小窗 506px 高时拖到 78%（约 395px），全屏 900px 高时 395px 只剩 44%，
  // 字幕突然上浮到画面中间。这里直接量「框中心 / 画面高度」这个比例。
  const boxCenterRatio = () => page.evaluate(() => {
    const box = document.querySelector('.trace-sub-box');
    const ov = document.querySelector('#trace-sub-overlay');
    const b = box.getBoundingClientRect();
    const o = ov.getBoundingClientRect();
    return Math.round(((b.top + b.height / 2 - o.top) / o.height) * 1000) / 1000;
  });

  // 先悬停到字幕框上让拖动手柄显形，再按住手柄往上拖一段
  const boxRect = await page.evaluate(() => {
    const b = document.querySelector('.trace-sub-box').getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  await page.mouse.move(boxRect.x + boxRect.w / 2, boxRect.y + boxRect.h / 2);
  await page.waitForTimeout(450);
  const handleRect = await page.evaluate(() => {
    const h = document.querySelector('.trace-drag-handle');
    const b = h.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.move(handleRect.x, handleRect.y);
  await page.waitForTimeout(120);
  await page.mouse.down();
  // 往上拖 120px：让字幕明显离开默认的 82% 位置
  await page.mouse.move(handleRect.x, handleRect.y - 120, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const ratioNormal = await boxCenterRatio();

  await page.evaluate(() => window.__mockFullscreen(true));
  await page.waitForTimeout(600);
  const ratioFs = await boxCenterRatio();
  await page.screenshot({ path: 'shot-frame-fullscreen-dragged.png' });

  await page.evaluate(() => window.__mockFullscreen(false));
  await page.waitForTimeout(600);
  const ratioBack = await boxCenterRatio();

  // 允许 3% 的偏差：框高不同、像素取整都会带来一点误差
  const posKeepFs = Math.abs(ratioFs - ratioNormal) <= 0.03;
  const posKeepBack = Math.abs(ratioBack - ratioNormal) <= 0.03;

  console.log(JSON.stringify({
    frame: FRAME,
    normal: { overlay: normal.overlay, player: normal.player, box: normal.box, vscale: vscaleNormal, fontPx: baseFont, text: normal.text },
    normalOk,
    boxInsideFrame,
    fullscreen: { overlay: fs.overlay, vscale: vscaleFs, expectScale, fontPx: fs.fontPx, box: fs.box },
    fsOk,
    scaleOk,
    fontGrew,
    fsBoxInside,
    back: { overlay: back.overlay, vscale: vscaleBack, fontPx: back.fontPx },
    backOk,
    fontBack,
    dragKeep: { ratioNormal, ratioFs, ratioBack, posKeepFs, posKeepBack },
  }, null, 2));

  const ok = normalOk && boxInsideFrame && fsOk && scaleOk && fontGrew && fsBoxInside
    && backOk && fontBack && posKeepFs && posKeepBack;
  console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}（字幕贴视频框 + 全屏等比放大 + 退全屏等比缩回 + 拖动位置进出全屏不跑偏）`);
  await ctx.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
