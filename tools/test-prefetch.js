/**
 * 预取生效性测试：句子渲染后，该句的候选词应已进入 IndexedDB 缓存，
 * 因此再「点击」这些词时应当是毫秒级、且零网络请求。
 *
 * 用法: node test-prefetch.js   （在 tools 目录下）
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const userDataDir = path.join(__dirname, '.chrome-prefetch');

const checks = {};
const failed = [];
function check(name, ok, extra) {
  checks[name] = !!ok;
  console.log(`${ok ? '\u2713' : '\u2717'} ${name}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}`);
  if (!ok) failed.push(name);
}

(async () => {
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
      '--autoplay-policy=no-user-gesture-required',
    ],
    viewport: { width: 1280, height: 860 },
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');

  const page = await ctx.newPage();

  // 统计真实的词典网络请求。
  // 必须用 ctx.route 而不是 page.route：查词发生在 Service Worker 里，
  // page.route 只作用于页面上下文，拦不到 SW 发出的 fetch
  // （这一点 test-dict.js 里断网复现查空时踩过同样的坑）。
  let netCalls = 0;
  const countRoute = (r) => {
    netCalls++;
    r.continue();
  };
  for (const p of ['**api.datamuse.com/**', '**api.dictionaryapi.dev/**']) {
    await ctx.route(p, countRoute);
  }

  // 直接驱动内容脚本里的预取逻辑，不必依赖真实 YouTube 页面
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });

  const hasCs = await page.evaluate(() => !!document.getElementById('trace-word-popup'));
  if (!hasCs) {
    // 内容脚本可能还没注入，给一点时间
    await page.waitForTimeout(1500);
  }

  // 通过后台确认：预取调用的是与点击同一条 lookupWord 路径 → 结果应落进同一份缓存
  const KEYWORDS = ['vintage', 'brutal', 'vessel'];
  netCalls = 0;
  const before = await sw.evaluate(async (words) => {
    const D = globalThis.__traceDebug;
    const out = {};
    for (const w of words) {
      const hit = await D.idbGet('translations', 'dict5|normal|' + w);
      out[w] = !!hit;
    }
    return out;
  }, KEYWORDS);
  check(
    'P1 测试开始前这些词都没有缓存（保证后面测的是预取本身）',
    Object.values(before).every((v) => v === false),
    before
  );

  // 模拟内容脚本的预取消息（与 prefetchWords 发出的完全一致）
  const prefetchRes = await sw.evaluate(async (words) => {
    const D = globalThis.__traceDebug;
    const t0 = Date.now();
    const results = [];
    for (const w of words) {
      const d = await D.lookupWordDeduped(w, {});
      results.push({ w, ok: !!d });
    }
    return { ms: Date.now() - t0, results };
  }, KEYWORDS);
  check(
    'P2 预取把结果写入了缓存（与点击共用同一份缓存）',
    prefetchRes.results.every((r) => r.ok),
    prefetchRes.results
  );

  const after = await sw.evaluate(async (words) => {
    const D = globalThis.__traceDebug;
    const out = {};
    for (const w of words) {
      const hit = await D.idbGet('translations', 'dict5|normal|' + w);
      out[w] = !!hit;
    }
    return out;
  }, KEYWORDS);
  check(
    'P3 预取后缓存里确实有了这些词',
    Object.values(after).every((v) => v === true),
    after
  );

  // 关键体验指标：预取过之后再"点击"同一个词，必须零网络、毫秒级
  netCalls = 0;
  const clickRes = await sw.evaluate(async (words) => {
    const D = globalThis.__traceDebug;
    const t0 = Date.now();
    const results = [];
    for (const w of words) {
      const t = Date.now();
      const d = await D.lookupWord(w, {});
      results.push({ w, ms: Date.now() - t, zh: (d && d.zh) || '' });
    }
    return { totalMs: Date.now() - t0, results };
  }, KEYWORDS);
  check(
    'P4 预取后的"点击"全部命中缓存（零网络请求）',
    netCalls === 0 && clickRes.results.every((r) => r.ms < 200),
    { networkCalls: netCalls, results: clickRes.results }
  );

  // 反向对照：一个没预取过的词，点击应该走网络（说明 P4 不是因为缓存全有）
  netCalls = 0;
  const freshWord = await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    const t = Date.now();
    const d = await D.lookupWord('serendipity', {});
    return { ms: Date.now() - t, ok: !!d };
  });
  check(
    'P5 未预取的词点击时确实要走网络（对照组）',
    freshWord.ok === true && netCalls > 0,
    { networkCalls: netCalls, ...freshWord }
  );

  await page.screenshot({ path: path.join(__dirname, 'shot-prefetch.png') });
  await ctx.close();

  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log('\n' + JSON.stringify(checks, null, 2));
  if (failed.length) {
    console.log(`\nRESULT: FAIL (${failed.join(', ')})（预取让点击命中缓存）`);
    process.exit(1);
  }
  console.log('\nRESULT: PASS（预取命中缓存：预取后点击零网络、未预取才走网络）');
})().catch((e) => {
  console.error('FATAL', e);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
