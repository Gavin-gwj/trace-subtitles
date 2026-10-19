/**
 * 需求回归：字幕框不能挡住 YouTube 自己的交互浮层（设置菜单里的「画质」等）。
 *
 * 背景：字幕框是覆盖在播放器上的不透明浮层。YouTube 的齿轮菜单从右下角弹出，
 * 长字幕正好压在上面，用户点不到「清晰度」——截图里就是这个现象。
 *
 * 验证五件事：
 *   1) 菜单没开时，字幕框完全不受影响（不透明度 1、能接收指针事件）；
 *   2) 菜单开了且与字幕重叠 → 字幕让路（淡出 + pointer-events:none）；
 *   3) 让路状态下点菜单里的「画质」按钮，click 真的落到按钮上；
 *   4) 菜单关掉后字幕恢复原样（最容易漏的：只进不出会永久淡出）；
 *   5) 菜单开着但字幕没压住它 → 不让路（否则一开菜单字幕就消失）。
 *
 * 关键设计：D4 必须先把字幕框**真的对准**「画质」按钮。
 * 第一版直接点按钮，结果按钮中心在框外（只重叠了菜单左边缘 66px），
 * 点击本来就能命中，这个断言等于没测 —— 所以要先按按钮位置拖动字幕，
 * 并把「按钮中心在框内」作为前置条件一起断言。
 */
const path = require('path');
const { chromium } = require('playwright');
const F = require('./mock/fixtures');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const ORIGIN = 'https://www.youtube.com';
const VIEW = { width: 1440, height: 900 };
const FRAME = { left: 0, top: 0, width: 1440, height: 900 };

// 一句足够长的字幕：让框横向铺开，才能盖住靠右的设置菜单
const DODGE_CUES = [
  [0.0, 6.0, 'This subtitle box is deliberately long so that it spans almost the whole width of the player window.'],
];

(async () => {
  const ctx = await chromium.launchPersistentContext('.chrome-dodge', {
    headless: false,
    executablePath: CHROME,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--mute-audio', ...require('./lib/proxy').proxyArgs()],
    viewport: VIEW,
  });

  const cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' };
  const html = F.pageHtml(F.VIDEO_ID, { frame: FRAME, cues: DODGE_CUES });
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/youtubei/v1/player') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ playerResponse: F.playerResponse() }) });
    }
    if (p === '/api/timedtext') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: F.json3Body(DODGE_CUES) });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  });

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));

  await page.goto(`${ORIGIN}/watch?v=${F.VIDEO_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.trace-sub-box', { state: 'attached', timeout: 20000 });
  await page.waitForTimeout(2600);

  await page.evaluate(() => window.__mockPause && window.__mockPause());
  await page.waitForTimeout(400);

  const snap = () => page.evaluate(() => {
    const ov = document.querySelector('#trace-sub-overlay');
    const box = document.querySelector('.trace-sub-box');
    const menu = document.querySelector('.ytp-settings-menu');
    const b = box.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const cs = getComputedStyle(box);
    return {
      dodge: ov.classList.contains('trace-dodge'),
      boxOpacity: Number(cs.opacity),
      boxPointer: cs.pointerEvents,
      box: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      menuVisible: getComputedStyle(menu).display !== 'none',
      menu: { x: Math.round(m.x), y: Math.round(m.y), w: Math.round(m.width), h: Math.round(m.height) },
      overlapW: Math.round(Math.min(b.right, m.right) - Math.max(b.left, m.left)),
      overlapH: Math.round(Math.min(b.bottom, m.bottom) - Math.max(b.top, m.top)),
      clicks: JSON.parse(JSON.stringify(window.__mockClicks || {})),
    };
  });

  const checks = {};
  const log = (k, v, extra) => { checks[k] = v; console.log(`${v ? '✓' : '✗'} ${k}${extra ? ' ' + JSON.stringify(extra) : ''}`); };

  /** 把字幕框拖到某个视口纵坐标（横向锁死居中，只能调纵向） */
  async function dragBoxTo(targetY) {
    const boxRect = await page.evaluate(() => {
      const b = document.querySelector('.trace-sub-box').getBoundingClientRect();
      return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, h: b.height };
    });
    await page.mouse.move(boxRect.cx, boxRect.cy);
    await page.waitForTimeout(450);
    const handle = await page.evaluate(() => {
      const b = document.querySelector('.trace-drag-handle').getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    await page.mouse.move(handle.x, handle.y);
    await page.waitForTimeout(150);
    await page.mouse.down();
    const delta = targetY - boxRect.cy;
    await page.mouse.move(handle.x, handle.y + delta, { steps: 16 });
    await page.mouse.up();
    await page.waitForTimeout(500);
  }

  // ---------- 1) 菜单未开：字幕完全不受影响 ----------
  const idle = await snap();
  log('D1 菜单未开时字幕不让路', idle.dodge === false && idle.boxOpacity > 0.9 && idle.boxPointer === 'auto', {
    dodge: idle.dodge, opacity: idle.boxOpacity, pointer: idle.boxPointer, boxW: idle.box.w,
  });

  // ---------- 2) 量出「画质」按钮位置，把字幕对准它 ----------
  // 必须在菜单关着的时候拖动：菜单开着且重叠时手柄会被让路逻辑一起藏掉。
  const target = await page.evaluate(() => {
    window.__mockMenuOpen(true);
    const q = document.getElementById('qualityBtn').getBoundingClientRect();
    const out = { cx: q.x + q.width / 2, cy: q.y + q.height / 2 };
    window.__mockMenuOpen(false);
    return out;
  });
  await dragBoxTo(target.cy);
  const aimed = await snap();
  const coversX = target.cx >= aimed.box.x && target.cx <= aimed.box.x + aimed.box.w;
  const coversY = target.cy >= aimed.box.y && target.cy <= aimed.box.y + aimed.box.h;

  // ---------- 3) 菜单打开且重叠 → 让路 ----------
  await page.evaluate(() => window.__mockMenuOpen(true));
  await page.waitForTimeout(700);
  const opened = await snap();
  log('D2 菜单与字幕确实重叠（前提成立）',
    opened.overlapW > 6 && opened.overlapH > 6 && opened.menuVisible, {
      overlapW: opened.overlapW, overlapH: opened.overlapH,
    });
  log('D3 重叠时字幕让路（淡出 + 点击穿透）',
    opened.dodge === true && opened.boxOpacity < 0.2 && opened.boxPointer === 'none', {
      dodge: opened.dodge, opacity: opened.boxOpacity, pointer: opened.boxPointer,
    });

  // ---------- 4) 真的能点到菜单里的按钮 ----------
  // 前置：按钮中心必须在框内，否则这次点击本来就能命中，断言没有判别力。
  const before = await snap();
  await page.mouse.click(target.cx, target.cy);
  await page.waitForTimeout(300);
  const clicked = await snap();
  log('D4 按钮被字幕盖住时仍能点到（click 没被截住）',
    coversX && coversY && clicked.clicks.quality > before.clicks.quality, {
      coversX, coversY, qualityClicks: clicked.clicks.quality,
    });

  // ---------- 5) 菜单关掉 → 字幕恢复 ----------
  await page.evaluate(() => window.__mockMenuOpen(false));
  await page.waitForTimeout(700);
  const closed = await snap();
  log('D5 菜单关闭后字幕恢复（不透明度与指针事件回到默认）',
    closed.dodge === false && closed.boxOpacity > 0.9 && closed.boxPointer === 'auto', {
      dodge: closed.dodge, opacity: closed.boxOpacity, pointer: closed.boxPointer,
    });

  // ---------- 6) 菜单开着但字幕挪开（不重叠）→ 不该让路 ----------
  await dragBoxTo(120);
  await page.evaluate(() => window.__mockMenuOpen(true));
  await page.waitForTimeout(700);
  const moved = await snap();
  const noOverlap = !(moved.overlapW > 6 && moved.overlapH > 6);
  log('D6 菜单开着但没重叠时不让路', noOverlap && moved.dodge === false && moved.boxOpacity > 0.9, {
    overlapW: moved.overlapW, overlapH: moved.overlapH, dodge: moved.dodge, opacity: moved.boxOpacity,
  });
  await page.screenshot({ path: 'shot-dodge.png' });

  // 回到重叠状态截图，目视确认「淡出后菜单清晰可见」
  await page.evaluate(() => window.__mockMenuOpen(false));
  await page.waitForTimeout(300);
  await dragBoxTo(target.cy);
  await page.evaluate(() => window.__mockMenuOpen(true));
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'shot-dodge-overlap.png' });

  log('D7 无 JS 错误', pageErrors.length === 0, { errors: pageErrors });

  // ---------- 7) 拖动进行中菜单弹出 → 不能中断拖动 ----------
  // 让路会给字幕框加 pointer-events:none，而拖拽靠 pointer capture。
  // 中途把指针事件掐掉，拖动会卡在半路。所以 syncDodge() 里必须排除正在拖动的状态。
  await page.evaluate(() => window.__mockMenuOpen(false));
  await page.waitForTimeout(300);
  const beforeDragTop = await page.evaluate(() => {
    const b = document.querySelector('.trace-sub-box').getBoundingClientRect();
    return Math.round(b.y);
  });
  const dragBox = await page.evaluate(() => {
    const b = document.querySelector('.trace-sub-box').getBoundingClientRect();
    return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
  });
  await page.mouse.move(dragBox.cx, dragBox.cy);
  await page.waitForTimeout(450);
  const dh = await page.evaluate(() => {
    const b = document.querySelector('.trace-drag-handle').getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.move(dh.x, dh.y);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.mouse.move(dh.x, dh.y - 40, { steps: 6 });
  // 拖动中途打开菜单（此时字幕框正压在菜单上）
  await page.evaluate(() => window.__mockMenuOpen(true));
  await page.waitForTimeout(300);
  const midDrag = await snap();
  // 继续拖完
  await page.mouse.move(dh.x, dh.y - 160, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterDrag = await page.evaluate(() => {
    const b = document.querySelector('.trace-sub-box').getBoundingClientRect();
    return { top: Math.round(b.y), dragging: document.querySelector('.trace-sub-box').classList.contains('trace-dragging') };
  });
  log('D8 拖动中菜单弹出不会中断拖动',
    midDrag.dodge === false && afterDrag.dragging === false && beforeDragTop - afterDrag.top > 80, {
      midDragDodge: midDrag.dodge, beforeTop: beforeDragTop, afterTop: afterDrag.top,
      movedUp: beforeDragTop - afterDrag.top,
    });

  // 拖完松手、菜单仍开着且重叠 → 这时应该正常让路
  await page.waitForTimeout(700);
  const afterDragOverlap = await snap();
  log('D9 松手后若仍重叠则恢复让路', afterDragOverlap.dodge === true || !(afterDragOverlap.overlapW > 6 && afterDragOverlap.overlapH > 6), {
    dodge: afterDragOverlap.dodge, overlapW: afterDragOverlap.overlapW, overlapH: afterDragOverlap.overlapH,
  });
  await page.screenshot({ path: 'shot-dodge-mid-drag.png' });

  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  console.log(JSON.stringify({
    idle: { dodge: idle.dodge, opacity: idle.boxOpacity, pointer: idle.boxPointer, box: idle.box },
    aimed: { box: aimed.box, target: { cx: Math.round(target.cx), cy: Math.round(target.cy) }, coversX, coversY },
    opened: { dodge: opened.dodge, opacity: opened.boxOpacity, pointer: opened.boxPointer, overlapW: opened.overlapW, overlapH: opened.overlapH, menu: opened.menu },
    clicked: { qualityClicks: clicked.clicks.quality },
    closed: { dodge: closed.dodge, opacity: closed.boxOpacity, pointer: closed.boxPointer },
    moved: { dodge: moved.dodge, opacity: moved.boxOpacity, overlapW: moved.overlapW, overlapH: moved.overlapH },
    checks,
  }, null, 2));

  console.log(`RESULT: ${failed.length ? 'FAIL (' + failed.join(', ') + ')' : 'PASS'}（字幕框让路 YouTube 设置菜单：重叠时淡出可点，不重叠时不受影响）`);
  await ctx.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
