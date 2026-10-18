/**
 * 拖动行为回归测试。
 *
 * 设计约束（用户要求，对齐 Trancy）：**只能上下移动，横向永远居中**。
 * 理由：字幕框宽度随句子长短变化，允许横向拖动会让"居中"这件事失去保证，
 * 每换一句都得重新摆；只放开纵向既够用又稳定。
 *
 * 所以这里断言三件事：
 *   1. 横向拖不动：把指针横向移很远，框的中心仍在画面中心（±2px）
 *   2. 纵向能拖：拖动后 top 变了，且与指针位置对应
 *   3. 换句不漂移：长短两句的中心完全一致（横向锁定的直接结果）
 */
const path = require('path');
const { chromium } = require('playwright');
const F = require('./mock/fixtures');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const ORIGIN = 'https://www.youtube.com';
const VW = 1280;
const VH = 900;

(async () => {
  const ctx = await chromium.launchPersistentContext('.chrome-center', {
    headless: false,
    executablePath: CHROME,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--mute-audio'],
    viewport: { width: VW, height: VH },
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

  // 等到**真的有一句字幕**再开始，不能只等 box 挂载。
  // 为什么：box 是同步建出来的（bug 13 的修复让它不依赖后台设置），但字幕要等
  // timedtext 抓取 + 分句完成。MV3 的 service worker 冷启动偶尔超过 2.5s，
  // 那时 box 在、`.trace-sub-orig` 却是空的 → 后面的采样全部拿到空文本 →
  // distinctSentences 为 0，报一个看起来像"位置漂移"的假失败（实测约 1/10 概率）。
  // 这里等到有文本为止，超时就明确报「字幕一直没出来」，而不是让它伪装成位置问题。
  await page.waitForFunction(
    () => {
      const o = document.querySelector('#trace-sub-overlay .trace-sub-orig');
      return !!o && (o.textContent || '').trim().length > 0;
    },
    null,
    { timeout: 20000 }
  );
  // 再多等一拍，让首句译文/几何都稳定下来
  await page.waitForTimeout(1200);

  const box0 = await page.locator('.trace-sub-box').boundingBox();
  const center0 = box0.x + box0.width / 2;

  // ---- 1) 横向拖动：指针移到画面最右，框的中心应该纹丝不动 ----
  // 手柄是「悬停字幕框才显形」，所以先悬停让手柄出来
  await page.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2);
  await page.waitForTimeout(320);
  const handle = await page.locator('.trace-drag-handle').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.waitForTimeout(160);
  await page.mouse.down();
  // 往右拖 500px，同时略微下移（横向应完全无效，纵向应生效）
  await page.mouse.move(handle.x + handle.width / 2 + 500, handle.y + handle.height / 2 + 60, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const afterH = await page.locator('.trace-sub-box').boundingBox();
  const centerH = afterH.x + afterH.width / 2;
  const hDrift = Math.abs(centerH - VW / 2);
  const movedDown = afterH.y - box0.y;

  // ---- 2) 纵向拖动：往上拖到接近画面顶部，框应跟着上去且不越界 ----
  await page.mouse.move(afterH.x + afterH.width / 2, afterH.y + afterH.height / 2);
  await page.waitForTimeout(320);
  const handle2 = await page.locator('.trace-drag-handle').boundingBox();
  await page.mouse.move(handle2.x + handle2.width / 2, handle2.y + handle2.height / 2);
  await page.waitForTimeout(160);
  await page.mouse.down();
  // 拖到视口 y=20（远超上边界），验证纵向夹紧
  await page.mouse.move(handle2.x + handle2.width / 2, 20, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const topBox = await page.locator('.trace-sub-box').boundingBox();
  const topCenter = topBox.x + topBox.width / 2;
  const topDrift = Math.abs(topCenter - VW / 2);
  const clampedTop = topBox.y >= 0;
  const wentUp = topBox.y < afterH.y;

  // ---- 3) 换句采样：不同长度的句子，中心必须完全一致 ----
  // 攒够 4 句就收工（最多等 40 拍）。夹具总共只有 19.2s、6 句左右，
  // 固定跑满 40 拍既慢又容易在视频播完后采到空文本。
  const samples = [];
  const seen = new Set();
  for (let i = 0; i < 40 && seen.size < 4; i++) {
    const s = await page.evaluate(() => {
      const v = document.querySelector('video');
      const orig = document.querySelector('.trace-sub-orig');
      const box = document.querySelector('.trace-sub-box');
      if (!v || !orig || !box) return null;
      const r = box.getBoundingClientRect();
      return {
        t: Math.round(v.currentTime * 10) / 10,
        text: (orig.textContent || '').trim(),
        width: Math.round(r.width),
        center: Math.round(r.x + r.width / 2),
        top: Math.round(r.y),
      };
    });
    if (s && s.text) {
      samples.push(s);
      seen.add(s.text);
    }
    await page.waitForTimeout(300);
  }

  const uniq = [];
  for (const s of samples) if (!uniq.find((u) => u.text === s.text)) uniq.push(s);
  uniq.sort((a, b) => a.width - b.width);
  const shortBox = uniq[0];
  const longBox = uniq[uniq.length - 1];
  const shortCenter = shortBox ? shortBox.center : 0;
  const longCenter = longBox ? longBox.center : 0;
  const sentenceDrift = Math.abs(shortCenter - longCenter);

  await page.screenshot({ path: 'shot-center.png' });

  const dataFree = await page.getAttribute('#trace-sub-overlay', 'data-free');
  console.log(JSON.stringify({
    viewportCenter: VW / 2,
    // 横向
    centerBefore: Math.round(center0),
    centerAfterHorizontalDrag: Math.round(centerH),
    horizontalDrift: Math.round(hDrift * 10) / 10,
    horizontalLocked: hDrift <= 2,
    // 纵向
    topBefore: Math.round(box0.y),
    topAfterDragDown: Math.round(afterH.y),
    movedDownPx: Math.round(movedDown),
    verticalWorks: movedDown > 20,
    topAfterDragUp: Math.round(topBox.y),
    wentUp,
    clampedTop,
    // 换句
    distinctSentences: uniq.length,
    shortText: shortBox ? shortBox.text : '',
    longText: longBox ? longBox.text : '',
    shortWidth: shortBox ? shortBox.width : 0,
    longWidth: longBox ? longBox.width : 0,
    shortCenter,
    longCenter,
    sentenceDrift: Math.round(sentenceDrift * 10) / 10,
    topDrift: Math.round(topDrift * 10) / 10,
    dataFree,
  }, null, 2));

  const ok =
    hDrift <= 2 &&
    topDrift <= 2 &&
    movedDown > 20 &&
    wentUp &&
    clampedTop &&
    sentenceDrift <= 2 &&
    uniq.length >= 2 &&
    dataFree === '1';

  console.log(
    `RESULT: ${ok ? 'PASS' : 'FAIL'}（横向锁死居中 + 纵向可拖且不越界 + 换句不漂移）`
  );
  await ctx.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
