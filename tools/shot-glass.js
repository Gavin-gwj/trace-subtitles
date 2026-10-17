/**
 * 截图脚本：等字幕真正渲染出来再截图，用于人工/视觉核对毛玻璃 + 拖动手柄。
 * 结构刻意与 test-mock.js 保持一致（同样的 route 伪造与 profile 处理）。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const fx = require('./mock/fixtures');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const ORIGIN = 'https://www.youtube.com';

(async () => {
  const userDataDir = path.join(__dirname, '.chrome-glass');
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
    const u = new URL(route.request().url());
    const p = u.pathname;
    if (p === '/youtubei/v1/player') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' },
        body: JSON.stringify({ playerResponse: fx.playerResponse() }),
      });
    }
    if (p === '/api/timedtext') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' },
        body: fx.json3Body(),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: fx.pageHtml(),
    });
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('console', (m) => {
    const t = m.text();
    if (/Trace|trace/i.test(t)) console.log(`  console[${m.type()}] ${t}`);
  });

  await page.goto(`${ORIGIN}/watch?v=${fx.VIDEO_ID}`, { waitUntil: 'domcontentloaded' });

  let ok = false;
  for (let i = 0; i < 80; i++) {
    const st = await page
      .evaluate(() => {
        const box = document.querySelector('#trace-sub-overlay .trace-sub-box');
        const o = document.querySelector('#trace-sub-overlay .trace-sub-orig');
        const t = document.querySelector('#trace-sub-overlay .trace-sub-trans');
        if (!box || !o || !t) return null;
        const r = box.getBoundingClientRect();
        return {
          w: Math.round(r.width),
          orig: o.textContent,
          trans: t.textContent,
          empty: document.querySelector('#trace-sub-overlay').classList.contains('trace-empty'),
        };
      })
      .catch(() => null);
    if (st && !st.empty && st.orig && st.trans && st.w > 120) {
      ok = true;
      console.log('captured at:', JSON.stringify(st));
      break;
    }
    await page.waitForTimeout(250);
  }

  // 悬停字幕框，让拖动手柄显形
  const box = await page.locator('#trace-sub-overlay .trace-sub-box').boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
  }

  const shot = path.resolve(__dirname, 'shot-glass.png');
  await page.screenshot({ path: shot });
  console.log('ok:', ok, 'screenshot:', shot);
  await ctx.close();
})();
