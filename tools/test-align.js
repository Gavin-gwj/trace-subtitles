/**
 * bug 18 回归：收藏过的词会把它所在的那句译文改坏。
 *
 * 用户报障（m14977）：
 *   未收藏 pick 时  "…make my iron pick." → "…制作铁镐的好时机。"   ✅
 *   收藏 pick 后    "…make my iron pick." → "…制作我的熨斗挑选的好时机。" ❌
 *
 * 根因不是「词典查错」，而是**对齐机制自己改坏了句子**：
 * 旧实现对生词插哨兵再送翻 `make my ⟦0⟧pick⟦1⟧.`，
 * 记号把 `iron pick` 这个复合名词切开了，Google 不再把它当一个整体，
 * 于是 iron 单翻成「熨斗」、pick 单翻成「挑选」。
 *
 * 修复后的判据（两条都必须满足）：
 *   ① 译文必须与「纯文本翻译」**逐字相同** —— 加不加生词都不能改变译文；
 *   ② 生词在译文里仍然要能高亮，且高亮内容就是它在语境里的意思（铁镐）。
 *
 * 这个测试必须能抓住修复前的代码：
 *   - 旧代码 ① 会 FAIL（译文里出现「熨斗」）
 *   - 旧代码 ② 会 FAIL（哨兵之间是英文 pick，被 cjkSpansOnly 丢掉 → 无高亮）
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const userDataDir = path.join(__dirname, '.chrome-align');

const checks = {};
const failed = [];
function check(name, ok, info) {
  checks[name] = ok;
  console.log(`${ok ? '✓' : '✗'} ${name}${info !== undefined ? ' ' + JSON.stringify(info) : ''}`);
  if (!ok) failed.push(name);
}

/**
 * 算高亮译文的「有效宽度」：去掉标点与空白后的字符数。
 *
 * 不能直接用 `zh.length` —— 差分区间两侧常带「，」「。」这类标点，
 * 而那些字符会把宽度撑大 1~2，让「<= 3 字」的阈值变得没有意义。
 */
function alignNormWidth(s) {
  const PUNCT =
    /[，。！？、；：""''（）《》·…—!?,.;:()"'\s\u3000\u200B-\u200F\u2060\uFEFF\u00AD\u00A0]/;
  return String(s || '')
    .split('')
    .filter((c) => !PUNCT.test(c)).length;
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
  console.log('SW:', sw.url());

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

  // ---------------------------------------------------------------- A1
  // 同一个引擎、同一句话，分别用「不加词」和「加 pick」取结果。
  // 两者必须**逐字相同** —— 这是 bug 18 的核心契约。
  const SENT = 'Well, at least I guess this is a good time to make my iron pick.';

  const plain = await D('translateAligned', [SENT], [[]], 'en', 'zh-CN');
  const saved = await D('translateAligned', [SENT], [['pick']], 'en', 'zh-CN');

  const tPlain = plain.ok ? plain.v.texts[0] : '';
  const tSaved = saved.ok ? saved.v.texts[0] : '';

  check('A1 加生词前后译文逐字相同（bug 18 的根）', plain.ok && saved.ok && tPlain === tSaved, {
    plain: tPlain,
    saved: tSaved,
    same: tPlain === tSaved,
  });

  // A1b：译文本身要是对的 —— 不能出现「熨斗」这种被记号切碎后的产物
  check('A1b 译文里没有「熨斗」这种错误拆词', !/熨斗/.test(tSaved), {
    text: tSaved,
    iron: /熨斗/.test(tSaved),
  });

  // A1c：pick 在语境里是「镐」，译文里应当出现「镐」
  check('A1c 语境义「镐」被正确保留', /镐/.test(tSaved), { text: tSaved });

  // ---------------------------------------------------------------- A2
  // 该句仍然要能高亮，且高亮内容就是语境义「镐」（而不是词典直译「挑选」）。
  const spans = saved.ok ? saved.v.spans[0] : [];
  check('A2 生词在译文里仍有高亮', saved.ok && Array.isArray(spans) && spans.length === 1, {
    spans,
  });
  const sp0 = spans[0] || null;
  const slice =
    sp0 && Number.isInteger(sp0.start) ? tSaved.slice(sp0.start, sp0.end) : null;
  check('A2b 高亮内容与译文实际切片一致', sp0 && slice === sp0.zh, { slice, zh: sp0?.zh });
  check('A2c 高亮的是语境义「镐」，不是词典义「挑选」', !!sp0 && /镐/.test(sp0.zh) && !/挑选/.test(sp0.zh), {
    zh: sp0?.zh,
  });

  // A2d：高亮必须**窄**。
  // 这是用户看得见的那一面：filler 差分给出的是「整个被重写的结构」，
  // 早先 pick 会亮「现在是制作铁镐」7 个字，视觉上像半句都是这个词。
  // 加入单词/窗口探针后应当收到 2 个字，这里卡 3 作为余量。
  const spanW = sp0 ? alignNormWidth(sp0.zh) : -1;
  check('A2d 高亮跨度足够窄（不超过 3 个字）', spanW >= 1 && spanW <= 3, {
    zh: sp0?.zh,
    width: spanW,
  });

  // ---------------------------------------------------------------- A3
  // 对照：加一个**不在句子里**的词，译文同样不能变
  const other = await D('translateAligned', [SENT], [['beverage']], 'en', 'zh-CN');
  const tOther = other.ok ? other.v.texts[0] : '';
  check('A3 加一个句中不存在的词，译文也不变', other.ok && tOther === tPlain, {
    tPlain,
    tOther,
  });
  check('A3b 句中不存在的词不产生任何高亮', other.ok && (other.v.spans[0] || []).length === 0, {
    spans: other.ok ? other.v.spans[0] : null,
  });

  // ---------------------------------------------------------------- A4
  // 四个句子一批（含两个待查词），逐句验证互不干扰、译文都不被改写
  const BATCH = [
    { t: 'Everything is stored in the cloud now.', w: ['cloud'] },
    { t: 'Her bearing was calm and steady.', w: ['bearing'] },
    { t: 'Let us bury the hatchet and move on.', w: ['hatchet'] },
    { t: 'They hit the sack after a long day.', w: ['sack'] },
  ];
  const bp = await D('translateAligned', BATCH.map((b) => b.t), BATCH.map(() => []), 'en', 'zh-CN');
  const bs = await D('translateAligned', BATCH.map((b) => b.t), BATCH.map((b) => b.w), 'en', 'zh-CN');
  const sameAll =
    bp.ok &&
    bs.ok &&
    BATCH.every((_, i) => bp.v.texts[i] === bs.v.texts[i]);
  check('A4 批量：加生词后每句译文都不变', sameAll, {
    plain: bp.ok ? bp.v.texts : null,
    saved: bs.ok ? bs.v.texts : null,
  });

  // A4b：高亮要么没有，要么位置和内容都自洽 —— 绝不允许错位或纯英文
  const spanOk = bs.ok
    ? bs.v.spans.every((arr, i) =>
        (arr || []).every(
          (s) =>
            /[\u4e00-\u9fff]/.test(s.zh) &&
            s.end > s.start &&
            bs.v.texts[i].slice(s.start, s.end) === s.zh
        )
      )
    : false;
  check('A4b 批量：所有高亮都与译文切片自洽', spanOk, { spans: bs.ok ? bs.v.spans : null });

  // ---------------------------------------------------------------- A5
  // 精度优先：定位不到时宁可不亮。至少一半句子应当「没有高亮」而不是「错的高亮」。
  const total = bs.ok ? bs.v.spans.reduce((n, a) => n + (a || []).length, 0) : -1;
  check('A5 高亮只出现在能确定位置的地方', bs.ok && total >= 0 && total <= 4, { total });

  // ---------------------------------------------------------------- A6
  // 缓存：同样的输入第二次必须命中缓存并且结果一致（不能每次重新探针）
  const again = await D('translateAligned', [SENT], [['pick']], 'en', 'zh-CN');
  check(
    'A6 第二次读缓存，译文与高亮都不变',
    again.ok &&
      again.v.texts[0] === tSaved &&
      JSON.stringify(again.v.spans[0]) === JSON.stringify(spans),
    { text: again.ok ? again.v.texts[0] : null, spans: again.ok ? again.v.spans[0] : null }
  );

  check('A7 无页面 JS 错误', errors.length === 0, { errors });

  // ---------------------------------------------------------------- A8
  // 差分兜底的**绝对宽度上限**（DIFF_MAX_ZH = 7）。
  //
  // 用户实报：那句 33 字的字幕里 vintage 被差分区吞成 11 个字
  // 「这些老式的东西也在那里」，半个句子都被点亮。
  // 相对闸门「≤ 原译 50%」= 16.5 拦不住，所以必须有这条绝对上限。
  //
  // 断言写成「**任何**高亮都不超过 7 个字」而不是「vintage 这一条不超过」：
  // 上限对差分这一路是全局的，只盯一个词会让别的词漏过。
  const LONG =
    'They brought a cappuccino and some other beverage to the lounge, and this vintage stuff was there too.';
  const lw = ['vintage', 'lounge', 'beverage'];
  const lr = await D('translateAligned', [LONG], [lw], 'en', 'zh-CN');
  const lPlain = await D('translateAligned', [LONG], [[]], 'en', 'zh-CN');
  const lspans = lr.ok ? lr.v.spans[0] || [] : [];
  const wide = lspans
    .map((s) => ({ ...s, width: alignNormWidth(s.zh) }))
    .filter((s) => s.width > 7);
  check('A8 差分兜底有绝对宽度上限（任何高亮都不超过 7 个字）', lr.ok && wide.length === 0, {
    spans: lspans.map((s) => ({ zh: s.zh, width: alignNormWidth(s.zh) })),
    tooWide: wide,
  });
  // A8b：上限只在「差分兜底」这一路生效，不能连译文一起改坏
  check(
    'A8b 那条长句的译文与不加生词时一致',
    lr.ok && lPlain.ok && lr.v.texts[0] === lPlain.v.texts[0],
    { saved: lr.ok ? lr.v.texts[0] : null, plain: lPlain.ok ? lPlain.v.texts[0] : null }
  );

  await ctx.close();

  const names = Object.keys(checks);
  console.log(`\n${names.filter((n) => checks[n]).length}/${names.length} passed`);
  if (failed.length) {
    console.log('RESULT: FAIL (' + failed.join(', ') + ')');
    process.exit(1);
  }
  console.log('RESULT: PASS（加生词不再改坏译文，且仍能定位语境义）');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
