/**
 * 验证字幕框的「毛玻璃 + 自由拖动」能力。
 *
 * 1. 覆盖层应带 backdrop-filter 与半透明背景
 * 2. 拖动手柄存在，拖动后字幕框位置改变
 * 3. 位置写入 chrome.storage.local 的 settings.freePos
 * 4. 重新加载页面后位置仍然生效
 */
const path = require('path');
const { chromium } = require('playwright');
const F = require('./mock/fixtures');

const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = path.resolve(__dirname, '.chrome-drag');

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
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
  });

  await ctx.route('https://www.youtube.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/timedtext')) {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: F.json3Body,
      });
    }
    if (url.pathname.startsWith('/youtubei/v1/player')) {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerResponse: F.playerResponse }),
      });
    }
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: F.pageHtml(F.VIDEO_ID),
    });
  });

  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const page = await ctx.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${F.VIDEO_ID}`, {
    waitUntil: 'domcontentloaded',
  });

  // 等字幕出现
  for (let i = 0; i < 40; i++) {
    const t = await page.$eval('#trace-sub-overlay .trace-sub-trans', (e) => e.textContent).catch(() => '');
    if (t && t.trim()) break;
    await page.waitForTimeout(500);
  }

  const style = await page.evaluate(() => {
    const box = document.querySelector('#trace-sub-overlay .trace-sub-box');
    if (!box) return null;
    const cs = getComputedStyle(box);
    const r = box.getBoundingClientRect();
    return {
      backdrop: cs.backdropFilter || cs.webkitBackdropFilter || '',
      background: cs.backgroundColor,
      hasHandle: !!document.querySelector('.trace-drag-handle'),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    };
  });

  // 拖动手柄：从当前位置往左上拖 200,150
  const before = style.rect;
  const hb = await page.locator('.trace-drag-handle').boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 - 200, hb.y + hb.height / 2 - 150, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(900);

  const after = await page.evaluate(() => {
    const box = document.querySelector('#trace-sub-overlay .trace-sub-box');
    const r = box.getBoundingClientRect();
    return {
      rect: { x: Math.round(r.left), y: Math.round(r.top) },
      free: document.querySelector('#trace-sub-overlay').dataset.free,
      styleLeft: box.style.left,
      styleTop: box.style.top,
    };
  });

  const saved = await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    return settings && settings.freePos;
  });

  await page.screenshot({ path: path.resolve(__dirname, 'shot-drag.png') });

  // 重载后位置应保持
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const afterReload = await page.evaluate(() => {
    const box = document.querySelector('#trace-sub-overlay .trace-sub-box');
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), free: document.querySelector('#trace-sub-overlay').dataset.free };
  });

  const moved = Math.abs(after.rect.x - before.x) > 50 && Math.abs(after.rect.y - before.y) > 50;
  const kept = afterReload && Math.abs(afterReload.x - after.rect.x) <= 2 && Math.abs(afterReload.y - after.rect.y) <= 2;

  console.log('style:', JSON.stringify(style));
  console.log('drag:', JSON.stringify({ before: before, after: after }));
  console.log('saved freePos:', JSON.stringify(saved));
  console.log('after reload:', JSON.stringify(afterReload));
  console.log('screenshot:', path.resolve(__dirname, 'shot-drag.png'));
  console.log('');
  console.log('checks:', `blur=${/blur/.test(style.backdrop)}`, `handle=${style.hasHandle}`, `moved=${moved}`, `persisted=${!!saved}`, `kept=${kept}`);
  console.log('');
  console.log('RESULT:', /blur/.test(style.backdrop) && style.hasHandle && moved && saved && kept ? 'PASS' : 'FAIL');

  await ctx.close();
})();
