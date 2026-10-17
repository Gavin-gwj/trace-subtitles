/**
 * 需求①回归测试：拖动后字幕框必须以「中心点」定位，句子长短变化时对称伸缩，
 * 不能出现「框变长就往右长、文字看起来在乱动」的情况。
 *
 * 做法：拖到某个 x，记录框的 center；然后强制切换到长短差异很大的句子，
 * 断言 center 不变（允许 ±2px 误差）。
 */
const path = require('path');
const { chromium } = require('playwright');
const F = require('./mock/fixtures');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const ORIGIN = 'https://www.youtube.com';

(async () => {
  const ctx = await chromium.launchPersistentContext('.chrome-center', {
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
  await page.waitForTimeout(2500);

  // 1) 拖到画面中间偏右（不会被 clamp 夹到，用来验证"中心跟随鼠标"）
  const box = await page.locator('.trace-sub-box').boundingBox();
  const handle = await page.locator('.trace-drag-handle').boundingBox();
  const targetX = 760;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetX, handle.y + handle.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const afterDrag = await page.locator('.trace-sub-box').boundingBox();
  const centerAfterDrag = afterDrag.x + afterDrag.width / 2;

  // 2) 再拖到最左边，验证 clampCenterX 把框夹在视口内（不溢出）
  //    注意：拖动后把手位置变了，必须重新取
  const handle2 = await page.locator('.trace-drag-handle').boundingBox();
  await page.mouse.move(handle2.x + handle2.width / 2, handle2.y + handle2.height / 2);
  await page.mouse.down();
  await page.mouse.move(10, handle2.y + handle2.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const leftBox = await page.locator('.trace-sub-box').boundingBox();
  const leftCenter = leftBox.x + leftBox.width / 2;
  const expectedMin = leftBox.width / 2 + 4;

  // 3) 自然播放采样：抓不同句子的宽度与中心，验证中心恒定
  //    （MediaStream 不能 seek，只能等时间自然走到不同句子）
  const samples = [];
  for (let i = 0; i < 40; i++) {
    const s = await page.evaluate(() => {
      const v = document.querySelector('video');
      const orig = document.querySelector('.trace-sub-orig');
      const box = document.querySelector('.trace-sub-box');
      if (!v || !orig || !box) return null;
      const r = box.getBoundingClientRect();
      return { t: Math.round(v.currentTime * 10) / 10, text: (orig.textContent || '').trim(), width: Math.round(r.width), center: Math.round(r.x + r.width / 2) };
    });
    if (s && s.text) samples.push(s);
    await page.waitForTimeout(300);
  }

  // 按文本去重，取宽度最大和最小的两个不同句子
  const uniq = [];
  for (const s of samples) if (!uniq.find((u) => u.text === s.text)) uniq.push(s);
  uniq.sort((a, b) => a.width - b.width);
  const shortBox = uniq[0];
  const longBox = uniq[uniq.length - 1];
  const shortCenter = shortBox ? shortBox.center : 0;
  const longCenter = longBox ? longBox.center : 0;

  await page.screenshot({ path: 'shot-center.png' });

  const drift = Math.abs(shortCenter - longCenter);
  const followsCursor = Math.abs(centerAfterDrag - targetX) <= 6;
  const clampedInside = leftBox.x >= 0 && leftCenter >= expectedMin - 2;
  console.log(JSON.stringify({
    targetX,
    centerAfterDrag: Math.round(centerAfterDrag),
    followsCursor,
    leftEdgeAfterClamp: Math.round(leftBox.x),
    leftCenterAfterClamp: Math.round(leftCenter),
    expectedMinCenter: Math.round(expectedMin),
    clampedInside,
    distinctSentences: uniq.length,
    shortText: shortBox ? shortBox.text : '',
    longText: longBox ? longBox.text : '',
    shortWidth: shortBox ? shortBox.width : 0,
    longWidth: longBox ? longBox.width : 0,
    shortCenter,
    longCenter,
    driftPx: Math.round(drift * 10) / 10,
    dataFree: await page.getAttribute('#trace-sub-overlay', 'data-free'),
  }, null, 2));

  const ok = drift <= 2 && followsCursor && clampedInside && uniq.length >= 2;
  console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}（中心不漂移 + 跟随鼠标 + 不溢出视口 + 至少两句不同长度）`);
  await ctx.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
