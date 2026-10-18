/**
 * bug 16 回归：Google 会在英文词中间插零宽空格（U+200B），
 * 导致「译文里残留英文原词」的检测与补译全部失效。
 *
 * 真实案例（用户截图）：
 *   英文 Reels. For this example, I'm going with 16:9 because I want to create a horizontal video.
 *   中文 卷轴。对于本例，我选择 16:9，因为我想创建一个 horizo​​ntal 视频。
 *   中间那两个是不可见的 U+200B。
 *
 * 这个测试必须能抓住修复前的代码：
 *   - stripInvisible / looseWordRe 不存在 → 直接 FAIL
 *   - parseMarked 不清洗 → 译文里带零宽字符 → FAIL
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const F = require('./mock/fixtures.js');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const userDataDir = path.join(__dirname, '.chrome-invisible');

const checks = {};
const failed = [];
function check(name, ok, info) {
  checks[name] = ok;
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${name}${info !== undefined ? ' ' + JSON.stringify(info) : ''}`);
  if (!ok) failed.push(name);
}

const ZW = '\u200B'; // 零宽空格

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
      '--mute-audio',
    ],
    viewport: { width: 1280, height: 860 },
    locale: 'zh-CN',
  });

  const errors = [];
  ctx.on('weberror', (e) => errors.push(String(e.error())));
  ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(String(e))));

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  console.log('SW:', sw.url());

  // 清掉翻译缓存，确保走真实网络而不是读到旧结果
  await sw.evaluate(async () => {
    try {
      const db = await globalThis.__traceDebug.openDB();
      await new Promise((res) => {
        const tx = db.transaction('translations', 'readwrite');
        tx.objectStore('translations').clear();
        tx.oncomplete = res;
        tx.onerror = res;
      });
    } catch (_) {}
  });

  const D = (fn, ...args) =>
    sw.evaluate(
      async ({ fn, args }) => {
        const d = globalThis.__traceDebug;
        try {
          return { ok: true, v: await d[fn](...args) };
        } catch (e) {
          return { ok: false, err: String(e && e.message) };
        }
      },
      { fn, args }
    );

  // ---------------------------------------------------------------- S1
  // 单元：stripInvisible 真的删掉零宽字符
  const s1 = await sw.evaluate((zw) => {
    const d = globalThis.__traceDebug;
    const input = 'horizo' + zw + zw + 'ntal';
    return {
      hasFn: typeof d.stripInvisible === 'function',
      cleaned: d.stripInvisible ? d.stripInvisible(input) : null,
      plainRe: /horizontal/.test(input),
      loose: d.looseWordRe ? d.looseWordRe('horizontal').test(input) : null,
    };
  }, ZW);
  check('S1 零宽字符被清掉', s1.hasFn && s1.cleaned === 'horizontal', s1);
  check('S1b 普通正则确实匹配不到（前提成立）', s1.plainRe === false, {
    plainRe: s1.plainRe,
  });
  check('S1c looseWordRe 能跨零宽字符命中', s1.loose === true, { loose: s1.loose });

  // ---------------------------------------------------------------- S2
  // 端到端：带哨兵整句送翻，返回的译文里不能有零宽字符，
  // 且如果 Google 把词原样留在译文里，repair 逻辑必须能补上中文。
  const sentence =
    "Reels. For this example, I'm going with 16:9 because I want to create a horizontal video. So, I'll select 16:9.";
  const s2 = await D('translateAligned', [sentence], [['horizontal']], 'en', 'zh-CN');
  const out2 = s2.ok ? s2.v.texts[0] : '';
  const hasZw = new RegExp('[' + '\u200B-\u200F\u2060\uFEFF' + ']').test(out2);
  check('S2 端到端译文不含零宽字符', s2.ok && !hasZw, {
    text: out2,
    hasZw,
  });
  // 译文里不该再有独立的英文单词（horizontal / Reels 之外）
  const leftover = /\bhorizontal\b/i.test(out2);
  check('S2b 译文里没有残留的英文原词 horizontal', s2.ok && !leftover, {
    text: out2,
    leftover,
  });

  // ---------------------------------------------------------------- S3
  // 如果 Google 把 horizontal 原样保留（本次实测会），spans 要么给出中文，
  // 要么明确没有 span —— 绝不能给出「span 存在但内容是英文」这种半成品。
  const spans2 = s2.ok ? s2.v.spans[0] : [];
  const badSpan = spans2.find((s) => s && s.zh && !/[\u4e00-\u9fff]/.test(s.zh));
  check('S3 高亮片段不会是纯英文', !badSpan, {
    spans: spans2,
    bad: badSpan || null,
  });

  // ---------------------------------------------------------------- S4
  // 短句对照：不触发零宽字符的普通句子仍然正常
  const s4 = await D('translateAligned', ['So today we are going to talk about how this plugin works.'], [['today']], 'en', 'zh-CN');
  const out4 = s4.ok ? s4.v.texts[0] : '';
  check('S4 普通句子翻译不受影响', s4.ok && /[\u4e00-\u9fff]/.test(out4), { text: out4 });

  // ---------------------------------------------------------------- S5
  // markWords + parseMarked 往返：模拟引擎在词中间插零宽字符的返回
  const s5 = await sw.evaluate((zw) => {
    const d = globalThis.__traceDebug;
    const text = 'I want to create a horizontal video.';
    const mk = d.markWords(text, new Set(['horizontal']));
    // 伪造 Google 的返回：把英文原词塞回哨兵之间，并插入零宽字符
    const fake = mk.marked.replace('horizontal', 'horizo' + zw + zw + 'ntal');
    const parsed = d.parseMarked(fake, mk.slots);
    return { marked: mk.marked, slots: mk.slots.length, clean: parsed.clean, spans: parsed.spans };
  }, ZW);
  check('S5 parseMarked 输出不含零宽字符', s5.clean === 'I want to create a horizontal video.', s5);
  // 注意：parseMarked **必须**保留坏槽位（zh 是英文），否则 repairUntranslatedSlots
  // 就找不到该补译的词。真正的过滤发生在补译之后，用 cjkSpansOnly()。
  const s5b = await sw.evaluate(() => {
    const d = globalThis.__traceDebug;
    const raw = [
      { word: 'horizontal', zh: 'horizontal', start: 19, end: 29 },
      { word: 'video', zh: '视频', start: 30, end: 32 },
      { word: 'ghost', zh: '', start: 40, end: 45 },
    ];
    const hasFn = typeof d.cjkSpansOnly === 'function';
    return { hasFn, kept: hasFn ? d.cjkSpansOnly(raw) : null };
  });
  check(
    'S5b 补译之后的把关只留中文高亮',
    s5b.hasFn && s5b.kept.length === 1 && s5b.kept[0].word === 'video',
    s5b
  );

  check('S6 无页面 JS 错误', errors.length === 0, { errors });

  await ctx.close();

  const names = Object.keys(checks);
  console.log(`\n${names.filter((n) => checks[n]).length}/${names.length} passed`);
  if (failed.length) {
    console.log('RESULT: FAIL (' + failed.join(', ') + ')');
    process.exit(1);
  }
  console.log('RESULT: PASS（零宽空格不再破坏译文与补译）');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
