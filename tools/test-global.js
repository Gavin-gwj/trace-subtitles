/**
 * 需求回归：「全局显示」开关 + 离开视频画面不再飘字幕。
 *
 * 三个场景：
 *   1) 开关关闭（默认）：视频框滚出视野 / 缩成迷你播放器 → 字幕整条隐藏。
 *      这是用户报的 bug —— 在首页浏览时还有字幕飘在内容上面。
 *   2) 开关打开 + 视频框滚出视野（翻到评论区）→ 字幕改成贴屏幕底部的悬浮条。
 *   3) 开关打开 + 迷你播放器（首页后台播放）→ 同样走悬浮条，
 *      不能去贴那个 400×225 的小窗（贴上去字号只有几个像素）。
 *   4) 回到视频框里 → 悬浮条撤销，恢复贴视频框。
 *
 * 夹具提供 __mockScrollAway() / __mockMini() / __mockFrame(null) 三个钩子。
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
  const ctx = await chromium.launchPersistentContext('.chrome-global', {
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

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`${ORIGIN}/watch?v=${F.VIDEO_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.trace-sub-box', { state: 'attached', timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__mockPause && window.__mockPause());
  await page.waitForTimeout(400);

  /** 读一次覆盖层状态 */
  const snap = () => page.evaluate(() => {
    const ov = document.querySelector('#trace-sub-overlay');
    const box = document.querySelector('.trace-sub-box');
    const mp = document.getElementById('movie_player');
    const rect = (el) => {
      const b = el.getBoundingClientRect();
      return {
        x: Math.round(b.x), y: Math.round(b.y),
        w: Math.round(b.width), h: Math.round(b.height),
        bottom: Math.round(b.bottom), right: Math.round(b.right),
      };
    };
    const cs = getComputedStyle(ov);
    const bs = getComputedStyle(box);
    return {
      overlay: rect(ov),
      box: rect(box),
      player: rect(mp),
      global: ov.classList.contains('trace-global'),
      away: ov.classList.contains('trace-away'),
      opacity: parseFloat(cs.opacity),
      visibility: cs.visibility,
      boxPosition: bs.position,
      boxBottom: bs.bottom,
      boxOpacity: parseFloat(bs.opacity),
      text: (document.querySelector('.trace-sub-orig')?.textContent || '').trim().slice(0, 30),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });

  /** 在后台改设置并像 popup 那样通知页面 */
  const setGlobal = async (on) => {
    await sw.evaluate(async (val) => {
      await globalThis.__traceDebug.setSettings({ globalMode: val });
      const st = (await chrome.storage.local.get('settings')).settings;
      const tabs = await chrome.tabs.query({ url: 'https://*.youtube.com/*' });
      for (const t of tabs) {
        await chrome.tabs.sendMessage(t.id, { type: 'settings:changed', settings: st }).catch(() => {});
      }
    }, on);
    await page.waitForTimeout(700);
  };

  const checks = {};
  const detail = {};

  // 固定 profile 会把上一轮的设置带过来（globalMode 可能是 true），
  // 先显式复位，否则「开关关闭时应当隐藏」这条一上来就测的是打开状态。
  await setGlobal(false);

  // ---------- 1) 开关关闭：滚出视野 → 隐藏 ----------
  await page.evaluate(() => window.__mockScrollAway());
  await page.waitForTimeout(600);
  const awayOff = await snap();
  detail.awayOff = awayOff;
  checks.awayHiddenWhenOff =
    awayOff.away === true && awayOff.opacity < 0.05 && awayOff.visibility === 'hidden';

  // ---------- 2) 开关关闭：迷你播放器 → 同样隐藏（用户报的 bug） ----------
  await page.evaluate(() => window.__mockMini());
  await page.waitForTimeout(600);
  const miniOff = await snap();
  detail.miniOff = miniOff;
  checks.miniHiddenWhenOff =
    miniOff.away === true && miniOff.opacity < 0.05 && miniOff.visibility === 'hidden';

  // ---------- 3) 打开全局显示：迷你播放器 → 悬浮条 ----------
  await setGlobal(true);
  await page.waitForTimeout(500);
  const miniOn = await snap();
  detail.miniOn = miniOn;
  const miniBarWidthOk = miniOn.box.w <= VIEW.width * 0.87;
  const miniBarBottomOk = miniOn.box.bottom > VIEW.height * 0.7 && miniOn.box.bottom <= VIEW.height + 2;
  // 悬浮条不能横穿右下角的迷你播放器（否则两边都看不清）
  const barClearOfMini = miniOn.box.right <= miniOn.player.x - 4;
  checks.miniFloatingBar =
    miniOn.global === true && miniOn.away === false && miniOn.opacity > 0.9 &&
    miniOn.boxPosition === 'fixed' && miniBarWidthOk && miniBarBottomOk;
  checks.barClearOfMiniPlayer = barClearOfMini;

  // ---------- 4) 全局显示 + 滚出视野 → 悬浮条 ----------
  await page.evaluate(() => window.__mockScrollAway());
  await page.waitForTimeout(600);
  const awayOn = await snap();
  detail.awayOn = awayOn;
  const awayBarBottomOk = awayOn.box.bottom > VIEW.height * 0.7 && awayOn.box.bottom <= VIEW.height + 2;
  checks.awayFloatingBar =
    awayOn.global === true && awayOn.away === false && awayOn.opacity > 0.9 &&
    awayOn.boxPosition === 'fixed' && awayBarBottomOk;

  // ---------- 5) 回到视频框里 → 恢复贴视频框 ----------
  await page.evaluate(() => window.__mockFrame(null));
  await page.waitForTimeout(700);
  const backIn = await snap();
  detail.backIn = backIn;
  const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
  checks.backToFrame =
    backIn.global === false && backIn.away === false && backIn.opacity > 0.9 &&
    near(backIn.overlay.x, FRAME.left) && near(backIn.overlay.y, FRAME.top) &&
    near(backIn.overlay.w, FRAME.width) && near(backIn.overlay.h, FRAME.height) &&
    backIn.boxPosition === 'absolute';

  // ---------- 6) 关掉开关后立刻恢复原行为 ----------
  await setGlobal(false);
  await page.evaluate(() => window.__mockMini());
  await page.waitForTimeout(600);
  const offAgain = await snap();
  detail.offAgain = offAgain;
  checks.toggleOffRestores =
    offAgain.away === true && offAgain.global === false && offAgain.opacity < 0.05;

  // ---------- 7) 悬浮条不出现拖动手柄 ----------
  await setGlobal(true);
  await page.evaluate(() => window.__mockMini());
  await page.waitForTimeout(600);
  const handle = await page.evaluate(() => {
    const h = document.querySelector('.trace-drag-handle');
    return h ? getComputedStyle(h).display : 'missing';
  });
  checks.noDragHandleInBar = handle === 'none';

  await page.screenshot({ path: path.join(__dirname, 'shot-global.png') });

  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  console.log(JSON.stringify({
    checks,
    failed,
    awayOff: { away: awayOff.away, opacity: awayOff.opacity, visibility: awayOff.visibility },
    miniOff: { away: miniOff.away, opacity: miniOff.opacity, visibility: miniOff.visibility },
    miniOn: { global: miniOn.global, box: miniOn.box, position: miniOn.boxPosition, text: miniOn.text },
    awayOn: { global: awayOn.global, box: awayOn.box, position: awayOn.boxPosition },
    backIn: { overlay: backIn.overlay, player: backIn.player, global: backIn.global, position: backIn.boxPosition },
    offAgain: { away: offAgain.away, global: offAgain.global, opacity: offAgain.opacity },
    dragHandleDisplay: handle,
    errors,
  }, null, 2));

  const ok = failed.length === 0 && errors.length === 0;
  console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}（全局显示悬浮条 + 离开画面自动隐藏 + 迷你播放器不贴小窗）`);
  await ctx.close();
  if (!ok) process.exit(1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
