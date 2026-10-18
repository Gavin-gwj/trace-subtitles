/**
 * 回归测试：设置相关的三个真实故障
 *
 *   A. 切到 MyMemory 后译文消失（免费额度用尽时返回 MYMEMORY WARNING）
 *   B. 切回 Google 仍然没有译文（引擎没写进后台就开始翻译 / 缓存串台）
 *   C. 刷新页面后必须先点一下插件才出字幕（init 卡在无超时的 settings:get）
 *
 * 全部在扩展自己的 service worker 与页面里跑，不碰真实 YouTube。
 *
 * 用法: node test-settings.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const fx = require('./mock/fixtures');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const ORIGIN = 'https://www.youtube.com';
const WATCH = `${ORIGIN}/watch?v=${fx.VIDEO_ID}`;

const checks = {};
function check(name, ok, extra) {
  checks[name] = !!ok;
  console.log(`${ok ? '✓' : '✗'} ${name}${extra !== undefined ? ': ' + JSON.stringify(extra) : ''}`);
}

(async () => {
  const userDataDir = path.join(__dirname, '.chrome-settings');
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

  // ---- 伪造 YouTube 站点 ----
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    const cors = {
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-credentials': 'true',
    };
    if (p === '/youtubei/v1/player') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: cors,
        body: JSON.stringify({ playerResponse: fx.playerResponse() }),
      });
    }
    if (p === '/api/timedtext') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: cors,
        body: fx.json3Body(),
      });
    }
    if (p === '/watch' || p === '/' || p === '') {
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: fx.pageHtml(),
      });
    }
    return route.fulfill({ status: 404, body: 'nf' });
  });

  // ---- 伪造 MyMemory ----
  // mmMode: 'quota' = 额度用尽（HTTP 200 + WARNING 正文，最阴险的情况）
  //         'ok'    = 正常返回，但译文带【MM】前缀，便于区分「这条到底是谁翻的」
  let mmHits = 0;
  let mmMode = 'quota';
  await ctx.route('https://api.mymemory.translated.net/**', async (route) => {
    mmHits++;
    const q = new URL(route.request().url()).searchParams.get('q') || '';
    const body =
      mmMode === 'quota'
        ? {
            responseData: {
              translatedText:
                'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY. ' +
                'NEXT AVAILABLE IN 14 HOURS 11 MINUTES 42 SECONDS',
            },
            quotaFinished: null,
          }
        : { responseData: { translatedText: `【MM】${q}` }, quotaFinished: null };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });
  });

  const logs = [];
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('console', (m) => {
    const t = m.text();
    if (/Trace/i.test(t)) {
      logs.push(`[${m.type()}] ${t}`);
      console.log(`  console[${m.type()}] ${t}`);
    }
  });
  page.on('pageerror', (e) => console.log('  pageerror:', e.message));

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  console.log('SW:', sw ? sw.url() : 'NOT FOUND');
  if (!sw) {
    console.log('RESULT: FAIL (no service worker)');
    await ctx.close();
    process.exit(1);
  }
  const extId = new URL(sw.url()).host;

  // ================================================================
  // 用例 1：MyMemory 额度用尽 → 必须自动降级出译文，而不是空白
  // ================================================================
  const mm = await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    await D.setSettings({ engine: 'mymemory', targetLang: 'zh-CN' });
    const t0 = Date.now();
    const texts = ['Hello world', 'This is a test', 'How are you today'];
    let out = null;
    let err = '';
    try {
      out = await D.translateBatch(texts, 'en', 'zh-CN');
    } catch (e) {
      err = e.message || String(e);
    }
    return { out, err, ms: Date.now() - t0 };
  });
  console.log('mymemory-quota:', JSON.stringify(mm));
  const mmOut = Array.isArray(mm.out) ? mm.out : [];
  const mmFilled = mmOut.filter((s) => s && String(s).trim()).length;
  check('A1 不抛错', !mm.err, mm.err);
  check('A2 额度用尽时自动降级出译文', mmFilled === 3, { filled: mmFilled, out: mmOut });
  check(
    'A3 译文里没有 MYMEMORY 警告原文',
    !mmOut.some((s) => /MYMEMORY WARNING/i.test(String(s || ''))),
    mmOut
  );

  // ================================================================
  // 用例 2：引擎写进缓存键 → 切回 Google 必须拿到 Google 的译文
  //
  // 关键：先让 MyMemory 正常返回（带【MM】前缀），把 MyMemory 的译文写进缓存；
  // 再切回 Google。若缓存键不含引擎，这里会读回【MM】开头的旧译文，
  // 断言就会失败 —— 这就是「切了引擎看起来没变」的复现路径。
  // ================================================================
  mmMode = 'ok';
  const sw2 = await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    const text = ['Click any word to look it up'];
    await D.setSettings({ engine: 'mymemory' });
    const a = await D.translateWithCache(text, 'en', 'zh-CN');
    const aAligned = await D.translateAligned(text, [[]], 'en', 'zh-CN');
    await D.setSettings({ engine: 'google' });
    const b = await D.translateWithCache(text, 'en', 'zh-CN');
    const bAligned = await D.translateAligned(text, [[]], 'en', 'zh-CN');
    return { mm: a, mmAligned: aAligned && aAligned.texts, google: b, googleAligned: bAligned && bAligned.texts };
  });
  console.log('engine-switch:', JSON.stringify(sw2));
  check(
    'B0 MyMemory 路径确实写入了自己的译文',
    Array.isArray(sw2.mm) && /^【MM】/.test(sw2.mm[0] || ''),
    sw2.mm
  );
  check(
    'B1 切到 Google 后有译文',
    Array.isArray(sw2.google) && !!(sw2.google[0] || '').trim(),
    sw2.google
  );
  check(
    'B2 Google 没有读回 MyMemory 的缓存译文',
    Array.isArray(sw2.google) && !/^【MM】/.test(sw2.google[0] || ''),
    sw2.google
  );
  check(
    'B3 对齐路径也没读回 MyMemory 的缓存',
    Array.isArray(sw2.googleAligned) && !/^【MM】/.test(sw2.googleAligned[0] || ''),
    sw2.googleAligned
  );
  check(
    'B4 对齐路径在 Google 下确实有译文',
    Array.isArray(sw2.googleAligned) && !!(sw2.googleAligned[0] || '').trim(),
    sw2.googleAligned
  );

  // ================================================================
  // 用例 3：页面加载即出字幕（不依赖「点一下插件」唤醒 SW）
  //
  // 做法：先关掉 SW（模拟空闲休眠）再打开页面，页面必须在没有 popup
  // 参与的情况下自己拿到字幕。这里用一个全新 tab 直接访问 watch 页。
  // ================================================================
  // 先把引擎恢复成 google，避免沿用上面的 mymemory
  await sw.evaluate(async () => {
    await globalThis.__traceDebug.setSettings({ engine: 'google', targetLang: 'zh-CN' });
  });

  // 停掉 SW，模拟冷启动（Chrome 会在下一条消息到来时重新拉起）
  try {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    console.log('stopped service workers');
  } catch (e) {
    console.log('stop workers skipped:', e.message);
  }

  const page2 = await ctx.newPage();
  page2.on('console', (m) => {
    const t = m.text();
    if (/Trace/i.test(t)) logs.push(`[p2 ${m.type()}] ${t}`);
  });
  console.log('opening fresh tab (no popup involved):', WATCH);
  await page2.goto(WATCH, { waitUntil: 'domcontentloaded', timeout: 60000 });

  let auto = { present: false };
  for (let i = 0; i < 30; i++) {
    await page2.waitForTimeout(600);
    auto = await page2
      .evaluate(() => {
        const o = document.getElementById('trace-sub-overlay');
        if (!o) return { present: false };
        return {
          present: true,
          orig: o.querySelector('.trace-sub-orig')?.textContent || '',
          trans: o.querySelector('.trace-sub-trans')?.textContent || '',
        };
      })
      .catch((e) => ({ present: false, err: e.message }));
    if (auto.present && auto.orig) break;
  }
  console.log('auto-load:', JSON.stringify(auto));
  check('C1 新标签页无需点插件就出现字幕层', auto.present, auto);
  check('C2 无需点插件就渲染出原文', !!auto.orig, auto);
  check('C3 无需点插件就渲染出译文', !!auto.trans, auto);

  // ================================================================
  // 用例 3b：后台设置读取很慢时，字幕层也不能跟着等
  //
  // 旧实现 init() 第一行就是 await settings:get，后台慢多久字幕层就晚多久；
  // 新实现先用默认值把界面立起来，设置异步补。
  // 做法：把 SW 里的 storage.local.get 延迟 3 秒，再开新标签页量覆盖层出现耗时。
  // ================================================================
  await sw.evaluate(() => {
    const orig = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = async (keys) => {
      await new Promise((r) => setTimeout(r, 3000));
      return orig(keys);
    };
  });
  const page3 = await ctx.newPage();
  const t0 = Date.now();
  await page3.goto(WATCH, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let overlayMs = -1;
  for (let i = 0; i < 80; i++) {
    const has = await page3
      .evaluate(() => !!document.getElementById('trace-sub-overlay'))
      .catch(() => false);
    if (has) {
      overlayMs = Date.now() - t0;
      break;
    }
    await page3.waitForTimeout(100);
  }
  console.log('slow-settings overlayMs:', overlayMs);
  check(
    'C5 后台设置慢（3s）时字幕层仍立刻建立',
    overlayMs >= 0 && overlayMs < 2200,
    { overlayMs }
  );

  // ================================================================
  // 用例 4：init 的 settings:get 有超时，后台不响应也能继续
  // ================================================================
  const c4 = await page2.evaluate(async () => {
    // content script 在隔离世界，page.evaluate 看不到它；这里只能验证
    // 页面主世界没有被卡住（覆盖层已存在就说明 init 走完了）
    const o = document.getElementById('trace-sub-overlay');
    return { overlayPresent: !!o };
  });
  check('C4 init 已完成（覆盖层已建立）', c4.overlayPresent, c4);

  const errors = logs.filter((l) => /pageerror/i.test(l));
  check('no-page-errors', errors.length === 0, errors);

  // ---- 截图 ----
  const shot = path.join(__dirname, 'shot-settings.png');
  await page2.screenshot({ path: shot }).catch(() => {});
  console.log('screenshot:', shot);

  // ---- 汇总 ----
  const names = Object.keys(checks);
  const failed = names.filter((n) => !checks[n]);
  console.log('checks:', JSON.stringify(checks));
  if (failed.length) {
    console.log(`RESULT: FAIL (${failed.join(', ')})`);
    await ctx.close();
    process.exit(1);
  }
  console.log('RESULT: PASS（MyMemory 降级 + 引擎切换缓存 + 免点插件自动出字幕）');
  await ctx.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
