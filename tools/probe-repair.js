/**
 * 探测：哨兵内词未被翻译时的补译修复
 *
 * 复现条件：'Click any word to look it up and save it to your ⟦0⟧wordbook⟦1⟧.'
 * 现象：Google 原样返回 wordbook，译文里夹英文。
 * 期望：translateAligned 走 repairUntranslatedSlots，返回纯中文 + 正确 span。
 */
const { chromium } = require('playwright');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');

const CASES = [
  { text: 'Click any word to look it up and save it to your wordbook.', words: ['wordbook'] },
  { text: 'Click any word to look it up and save it to your wordbook.', words: ['word', 'wordbook'] },
  { text: 'The first step is to capture the subtitle tracks from the player.', words: ['capture', 'subtitle', 'tracks', 'player'] },
];

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.chrome-repair'), {
    headless: true,
    executablePath: CHROME,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  if (!sw) { console.log('no SW'); await ctx.close(); process.exit(1); }
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('about:blank');

  let bad = 0;
  for (const c of CASES) {
    // 每次用新的词集合 → 新的缓存键，避免命中上一次的结果
    const out = await sw.evaluate(async ({ text, words }) => {
      const D = globalThis.__traceDebug;
      return D.translateAligned([text], [words], 'en', 'zh-CN');
    }, c);
    const zh = out.texts[0] || '';
    const spans = out.spans[0] || [];
    const leftover = /[A-Za-z]{3,}/.test(zh.replace(/[\u4e00-\u9fff]/g, ''));
    const allMapped = c.words.every((w) => spans.some((s) => s.word === w));
    // 校验每个 span 的切片内容确实等于 zh
    const sliceOk = spans.every((s) => zh.slice(s.start, s.end) === s.zh);
    if (leftover || !allMapped || !sliceOk) bad++;
    console.log(JSON.stringify({
      words: c.words,
      zh,
      spans: spans.map((s) => `${s.word}=${s.zh}[${s.start},${s.end}]`),
      leftoverEnglish: leftover,
      allMapped,
      sliceOk,
    }, null, 1));
  }

  await ctx.close();
  console.log(bad === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${bad} case(s))`);
  process.exit(bad === 0 ? 0 : 1);
})();
