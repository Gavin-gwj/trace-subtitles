/**
 * 探针：确认 backdrop-filter 是否真的生效，以及拖动手柄的实际几何/样式。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const fx = require('./mock/fixtures');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const ORIGIN = 'https://www.youtube.com';

(async () => {
  const userDataDir = path.join(__dirname, '.chrome-probe');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: CHROME,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
    ],
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });

  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/youtubei/v1/player') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ playerResponse: fx.playerResponse() }) });
    }
    if (p === '/api/timedtext') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: fx.json3Body() });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fx.pageHtml() });
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(`${ORIGIN}/watch?v=${fx.VIDEO_ID}`, { waitUntil: 'domcontentloaded' });

  for (let i = 0; i < 80; i++) {
    const t = await page.$eval('#trace-sub-overlay .trace-sub-trans', (e) => e.textContent).catch(() => '');
    if (t && t.trim()) break;
    await page.waitForTimeout(250);
  }

  const box = await page.locator('#trace-sub-overlay .trace-sub-box').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);

  const info = await page.evaluate(() => {
    const b = document.querySelector('#trace-sub-overlay .trace-sub-box');
    const h = document.querySelector('#trace-sub-overlay .trace-drag-handle');
    const cb = getComputedStyle(b);
    const ch = getComputedStyle(h);
    const rb = b.getBoundingClientRect();
    const rh = h.getBoundingClientRect();
    return {
      box: {
        backdrop: cb.backdropFilter,
        bg: cb.backgroundColor,
        radius: cb.borderRadius,
        rect: { x: Math.round(rb.x), y: Math.round(rb.y), w: Math.round(rb.width), h: Math.round(rb.height) },
      },
      handle: {
        opacity: ch.opacity,
        bg: ch.backgroundColor,
        rect: { x: Math.round(rh.x), y: Math.round(rh.y), w: Math.round(rh.width), h: Math.round(rh.height) },
        dots: h.querySelectorAll('i').length,
      },
      supportsBackdrop: CSS.supports('backdrop-filter', 'blur(4px)') || CSS.supports('-webkit-backdrop-filter', 'blur(4px)'),
    };
  });
  console.log(JSON.stringify(info, null, 2));

  // 只截字幕框 + 手柄区域，放大看细节
  const clip = {
    x: Math.max(0, box.x - 20),
    y: Math.max(0, box.y - 60),
    width: Math.min(1280, box.width + 40),
    height: box.height + 80,
  };
  await page.screenshot({ path: path.resolve(__dirname, 'shot-glass-crop.png'), clip });
  console.log('crop saved');

  await ctx.close();
})();
