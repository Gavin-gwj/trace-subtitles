/**
 * 回归测试：POT 模式（模拟新版 YouTube）
 *
 * 真实故障场景：YouTube 的 /api/timedtext 在缺少 pot 签名时返回 200 + **空 body**，
 * 扩展表现为「有字幕但抓取失败、没有翻译」。
 *
 * 本测试把站点伪造为 pot 模式：
 *   - 不带 pot 的 timedtext 请求 → 200 + 空 body（模拟真实行为）
 *   - 页面自己发起的带 pot 请求   → 正常 json3
 * 扩展必须靠 main-world 的网络钩子截获后者才能成功。
 *
 * 用法: node test-pot.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const fx = require('./mock/fixtures');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const ORIGIN = 'https://www.youtube.com';
const WATCH = `${ORIGIN}/watch?v=${fx.VIDEO_ID}`;

(async () => {
  const userDataDir = path.join(__dirname, '.chrome-pot');
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
      ...require('./lib/proxy').proxyArgs(),
    ],
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });

  const timedtextHits = [];

  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    const cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' };

    if (p === '/youtubei/v1/player') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: cors,
        body: JSON.stringify({ playerResponse: fx.playerResponse() }),
      });
    }
    if (p === '/api/timedtext') {
      const hasPot = u.searchParams.has('pot');
      timedtextHits.push({ hasPot, pot: u.searchParams.get('pot') || '' });
      const r = fx.timedTextResponse(route.request().url());
      return route.fulfill({
        status: r.status,
        contentType: r.contentType || 'application/json',
        headers: cors,
        body: r.body,
      });
    }
    if (p === '/watch' || p === '/' || p === '') {
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: fx.pageHtml(fx.VIDEO_ID, { potMode: true }),
      });
    }
    return route.fulfill({ status: 404, body: 'nf' });
  });

  const logs = [];
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('console', (m) => {
    const t = m.text();
    if (/Trace|trace/i.test(t)) {
      logs.push(`[${m.type()}] ${t}`);
      console.log(`  console[${m.type()}] ${t}`);
    }
  });
  page.on('pageerror', (e) => {
    logs.push(`[pageerror] ${e.message}`);
    console.log('  pageerror:', e.message);
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  console.log('SW:', sw ? sw.url() : 'NOT FOUND');
  if (!sw) {
    console.log('RESULT: FAIL (no service worker)');
    await ctx.close();
    process.exit(1);
  }

  console.log('navigating (pot mode):', WATCH);
  await page.goto(WATCH, { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('waiting for subtitles...');
  let ok = false;
  let st = null;
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(700);
    st = await page.evaluate(() => {
      const o = document.getElementById('trace-sub-overlay');
      if (!o) return { present: false };
      return {
        present: true,
        orig: o.querySelector('.trace-sub-orig')?.textContent || '',
        trans: o.querySelector('.trace-sub-trans')?.textContent || '',
        empty: o.classList.contains('trace-empty'),
      };
    }).catch((e) => ({ present: false, err: e.message }));

    if (st.present && st.orig && st.trans) {
      console.log(`  ✓ 双语字幕渲染成功 @${i}:`, JSON.stringify(st));
      ok = true;
      break;
    }
    if (i % 5 === 0) console.log(`  ...${i}`, JSON.stringify(st));
  }

  const segLine = logs.find((l) => /已加载.*句/.test(l)) || '';
  const segMatch = segLine.match(/已加载\s*(\d+)\s*行字幕\s*→\s*(\d+)\s*句（([^，]+)，来源\s*([^）]+)）/);
  const seg = segMatch
    ? { rows: Number(segMatch[1]), sentences: Number(segMatch[2]), lang: segMatch[3], source: segMatch[4], line: segLine }
    : { line: segLine || '(no load log)' };

  console.log('segmentation:', JSON.stringify(seg, null, 1));
  console.log('timedtext hits:', JSON.stringify(timedtextHits.slice(0, 10), null, 1));

  const shot = path.join(__dirname, 'shot-pot.png');
  await page.screenshot({ path: shot });
  console.log('screenshot:', shot);

  await ctx.close();

  // 判定：必须拿到字幕，且来源必须是 hook（direct 在 pot 模式下会拿到空 body）
  const sourceOk = seg.source === 'hook' || seg.source === 'hook-forced';
  const pass = ok && seg.sentences > 0 && sourceOk;
  console.log(
    pass
      ? '\nRESULT: PASS (网络钩子成功绕过 pot 限制)'
      : `\nRESULT: FAIL (ok=${ok} sentences=${seg.sentences} source=${seg.source})`
  );
  process.exit(pass ? 0 : 1);
})();
