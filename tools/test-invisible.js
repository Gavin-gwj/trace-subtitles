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
 *   - 译文不清洗 → 带零宽字符 → FAIL
 *
 * bug 18 之后对齐机制整体换掉了（不再往句子里插记号），
 * 所以 S5 一组改为验证「探针内部件都不会被零宽字符污染位置」。
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
      ...require('./lib/proxy').proxyArgs(),
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
  // 端到端：整句送翻，返回的译文里不能有零宽字符。
  // （bug 18 之后不再插入任何记号，主译文就是原句的正常翻译。）
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
  // 旁路探针的内部件（bug 18 改造后，不再有 markWords/parseMarked）：
  // 同一件事仍然要验证 —— 零宽字符不能污染「位置」计算。
  const s5 = await sw.evaluate((zw) => {
    const d = globalThis.__traceDebug;
    const dirty = '我想创建一个 horizo' + zw + zw + 'ntal 视频。';
    // ① fillerFor 必须保持长度，否则探针句里词的偏移会变
    const f = d.fillerFor('pick');
    // ② 前后缀差分：只在「铁镐 → 熨斗」处断开
    const dm = d.diffMid('这是制作铁镐的好时机。', '这是制作熨斗的好时机。');
    // ③ 规范化定位要能跨过零宽字符与标点，并且映射回原文坐标
    const at = d.findNormalized(dirty, 'horizontal');
    return {
      hasFns:
        typeof d.fillerFor === 'function' &&
        typeof d.diffMid === 'function' &&
        typeof d.findNormalized === 'function',
      filler: f,
      fillerLen: f === 'pick' ? 0 : f.length,
      mid: dm.mid,
      // 原文坐标系下切出来的片段，应当正好是那个脏词
      slice: at ? dirty.slice(at.start, at.end) : null,
    };
  }, ZW);
  check(
    'S5 探针内部件齐全且填充串等长',
    s5.hasFns && s5.fillerLen === 'pick'.length,
    s5
  );
  check('S5b 前后缀差分能框出被替换的词', s5.mid === '铁镐', { mid: s5.mid });
  check(
    'S5c 规范化定位跨零宽字符仍能框准',
    s5.slice === 'horizo' + ZW + ZW + 'ntal',
    { slice: s5.slice }
  );

  // ---------------------------------------------------------------- S5d
  // 三道闸门：只留中文、长度不超半数、必须有内容
  const s5d = await sw.evaluate(() => {
    const d = globalThis.__traceDebug;
    const plain = '今天我们来聊聊这个插件是怎么工作的，它靠旁路探针定位。';
    return {
      ok: d.acceptSpan(plain, '旁路探针'),
      english: d.acceptSpan(plain, 'probe'),
      tooLong: d.acceptSpan(plain, plain),
      empty: d.acceptSpan(plain, '   '),
    };
  });
  check(
    'S5d 三道闸门：中文短候选通过，英文/半句/空白被拒',
    s5d.ok && !s5d.english && !s5d.tooLong && !s5d.empty,
    s5d
  );

  // ---------------------------------------------------------------- S5e
  // findWordHits 只定位、不改写原文（这是 bug 18 的根治点）
  const s5e = await sw.evaluate(() => {
    const d = globalThis.__traceDebug;
    const text = 'Well, at least I guess this is a good time to make my iron pick.';
    const hits = d.findWordHits(text, new Set(['pick']));
    return { text, hits };
  });
  check(
    'S5e findWordHits 找到词且不改动原文',
    s5e.hits.length === 1 &&
      s5e.hits[0].word === 'pick' &&
      s5e.text.slice(s5e.hits[0].start, s5e.hits[0].end) === 'pick',
    s5e
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
