/**
 * 背单词模式专项测试（词态配色 + 译文模糊 + 复习计数 + 标记已记住）
 *
 * 用户原话（m13117）：
 *   「如果有个单词已经加入过生词本了，那么在下一次出现这个单词的时候，下方译文中的
 *     对应翻译字会主动模糊处理，鼠标移动到上面才会显示出意思；如果下一次出现了已经
 *     在生词本的单词，你点击了它或者鼠标移动到下面的译文上，那么会被算作重新记忆，
 *     你也可以手动点击单词，在单词卡片上点击已经记住，这时候，这个单词的状态就变成
 *     已经记住了，它就会被显示成淡绿色，否则没记住或者记忆中是有些红色」
 *
 * 验证七件事：
 *   1. 已收藏词的译文默认带 .trace-zh-blur（模糊），且 filter 真的生效
 *   2. 鼠标移上去 filter 变 none（能看清）
 *   3. 未收藏的词译文不模糊（不能整句都遮，否则没法读）
 *   4. 新词/记忆中 = 红色系，已记住 = 绿色系（英文侧和中文侧都要）
 *   5. 鼠标停留够久 → reviewCount+1（停太短不算）
 *   6. 同一句里反复划过同一个词只记一次
 *   7. 卡片「标记为已记住」→ status=learned，高亮立刻变绿
 *
 * 用法: node test-review.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const fx = require('./mock/fixtures');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const ORIGIN = 'https://www.youtube.com';
const WATCH = `${ORIGIN}/watch?v=${fx.VIDEO_ID}`;

// 一条长字幕覆盖全部断言点，优点是不需要 seek。
//
// 为什么必须这样：夹具用 canvas.captureStream 喂 video，MediaStream 不支持
// seek（也不支持 currentTime 伪造 —— 跨世界无效），所以只能「自然播放 + 采样」。
// 把三个目标词塞进同一句，一次采样就能同时验证三种状态的配色，
// 也顺带覆盖了「同一句里有多个已收藏词」这个真实场景。
const CUES = [
  [0.0, 30.0, 'They brought a cappuccino and some other beverage to the lounge, and this vintage stuff was there too.'],
];

const SEED = [
  { word: 'beverage', status: 'new', reviewCount: 0, zh: '饮料' },
  { word: 'lounge', status: 'learning', reviewCount: 1, zh: '休息室' },
  { word: 'vintage', status: 'learned', reviewCount: 3, zh: '复古' },
];

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

/** 把 rgb(...) 归成「红系 / 绿系 / 其它」——不锁死具体色值，只判色相倾向 */
function hueOf(rgb) {
  const m = /(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(rgb || '');
  if (!m) return 'none';
  const [r, g, b] = [+m[1], +m[2], +m[3]];
  if (r > g + 25 && r > b + 25) return 'red';
  if (g > r + 25 && g > b + 10) return 'green';
  return 'other';
}

(async () => {
  const userDataDir = path.join(__dirname, '.chrome-review');
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

  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    if (p === '/youtubei/v1/player') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': ORIGIN,
          'access-control-allow-credentials': 'true',
        },
        body: JSON.stringify({ playerResponse: fx.playerResponse() }),
      });
    }
    if (p === '/api/timedtext') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': ORIGIN,
          'access-control-allow-credentials': 'true',
        },
        body: fx.json3Body(CUES),
      });
    }
    if (p === '/watch' || p === '/' || p === '') {
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: fx.pageHtml(fx.VIDEO_ID, { cues: CUES }),
      });
    }
    return route.fulfill({ status: 404, body: 'nf' });
  });

  const pageErrors = [];
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  console.log('SW:', sw ? sw.url() : 'NOT FOUND');
  if (!sw) {
    console.log('RESULT: FAIL (no service worker)');
    await ctx.close();
    process.exit(1);
  }

  // ---- 种子数据：直接写库，status 与 reviewCount 由我们指定 ----
  // 为什么不用 addWord：它强制 status='new'、reviewCount=0，
  // 造不出「记忆中/已记住」两种初始状态，后面对照组的断言就全没意义。
  await sw.evaluate(
    async ({ seed, videoId }) => {
      const D = globalThis.__traceDebug;
      const db = await D.openDB();
      await new Promise((res, rej) => {
        const tx = db.transaction('words', 'readwrite');
        tx.objectStore('words').clear();
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      for (const s of seed) {
        await D.idbPut('words', {
          word: s.word,
          display: s.word,
          kind: 'word',
          phonetic: '',
          zh: s.zh,
          meanings: [{ pos: 'noun', def: 'seeded for review test' }],
          example: '',
          context: '',
          contextZh: '',
          videoTitle: 'Mock Video',
          videoId,
          time: 0,
          createdAt: Date.now() - 60000,
          reviewCount: s.reviewCount,
          lastReview: s.reviewCount ? Date.now() - 1000 : 0,
          status: s.status,
        });
      }
      return true;
    },
    { seed: SEED, videoId: fx.VIDEO_ID }
  );

  const seeded = await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    return await D.wordStates();
  });
  console.log('seeded states:', JSON.stringify(seeded));
  check('S0 种子状态写对了', seeded.beverage === 'new' && seeded.lounge === 'learning' && seeded.vintage === 'learned');

  await page.goto(WATCH, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 等字幕层出现
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(700);
    ready = await page.evaluate(() => {
      const o = document.getElementById('trace-sub-overlay');
      return !!(o && o.querySelector('.trace-sub-orig')?.textContent);
    });
    if (ready) break;
  }
  console.log('subtitles ready:', ready);
  check('S1 字幕层已就绪', ready);

  // 等第一句译文就绪并且有 zhSpans（对齐要额外一次翻译，比较慢）
  let aligned = false;
  for (let i = 0; i < 60; i++) {
    aligned = await page.evaluate(() => {
      const o = document.getElementById('trace-sub-overlay');
      return !!(o && o.querySelector('.trace-saved-zh'));
    });
    if (aligned) break;
    await page.waitForTimeout(500);
  }
  check('S2 译文里出现了已收藏词的中文片段', aligned);

  // ---- S3/S4/S5：模糊与配色（单条长字幕，一次采样拿全三种状态） ----
  const snap = await page.evaluate(() => {
    const o = document.getElementById('trace-sub-overlay');
    if (!o) return null;
    const orig = o.querySelector('.trace-sub-orig');
    const trans = o.querySelector('.trace-sub-trans');
    const words = [...(orig?.querySelectorAll('.trace-word') || [])].map((el) => ({
      text: el.textContent,
      w: el.dataset.w,
      st: el.dataset.st || '',
      saved: el.classList.contains('trace-saved'),
      color: getComputedStyle(el).color,
    }));
    const zhs = [...(trans?.querySelectorAll('.trace-saved-zh') || [])].map((el) => ({
      text: el.textContent,
      w: el.dataset.w,
      st: el.dataset.st || '',
      blur: el.classList.contains('trace-zh-blur'),
      filter: getComputedStyle(el).filter,
      color: getComputedStyle(el).color,
    }));
    return { orig: orig?.textContent || '', zh: trans?.textContent || '', words, zhs };
  });
  console.log('snapshot words:', JSON.stringify(snap?.words));
  console.log('snapshot zhs:', JSON.stringify(snap?.zhs));

  const bevZh = (snap?.zhs || []).find((z) => z.w === 'beverage');
  check('S3 已收藏词的中文默认模糊', !!(bevZh && bevZh.blur), {
    blur: bevZh?.blur,
    filter: bevZh?.filter,
  });
  check('S3b 模糊是真的生效（filter 不是 none）', !!(bevZh && /blur/.test(bevZh.filter || '')), {
    filter: bevZh?.filter,
  });

  // hover 之后 filter 应该变 none（用真实鼠标移动，让 :hover 生效）
  let hoverFilter = null;
  const zbox = await page.evaluate(() => {
    const o = document.getElementById('trace-sub-overlay');
    const el = o?.querySelector('.trace-saved-zh');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (zbox) {
    await page.mouse.move(zbox.x, zbox.y);
    await page.waitForTimeout(500);
    hoverFilter = await page.evaluate(() => {
      const o = document.getElementById('trace-sub-overlay');
      const el = o?.querySelector('.trace-saved-zh');
      return el ? getComputedStyle(el).filter : null;
    });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(200);
  }
  check('S4 鼠标移上去就变清楚（filter=none）', hoverFilter === 'none', { filter: hoverFilter });

  // 未收藏的词：不带状态属性，也不该被模糊
  const plainWords = (snap?.words || []).filter((w) => !w.saved);
  check('S5 未收藏的词不带状态属性', plainWords.length > 0 && plainWords.every((w) => !w.st), {
    checked: plainWords.length,
  });

  // 配色：new/learning = 红，learned = 绿
  const bevW = (snap?.words || []).find((w) => w.w === 'beverage');
  const loungeW = (snap?.words || []).find((w) => w.w === 'lounge');
  const vintW = (snap?.words || []).find((w) => w.w === 'vintage');
  console.log(
    'colors:',
    JSON.stringify({
      beverage: { st: bevW?.st, color: bevW?.color },
      lounge: { st: loungeW?.st, color: loungeW?.color },
      vintage: { st: vintW?.st, color: vintW?.color },
    })
  );
  check('S6 新词是红色系', hueOf(bevW?.color) === 'red', { color: bevW?.color });
  check('S7 记忆中是红色系', hueOf(loungeW?.color) === 'red', { color: loungeW?.color });
  check('S8 已记住是绿色系', hueOf(vintW?.color) === 'green', { color: vintW?.color });

  // 中文侧也要按状态着色（否则左右不一致）
  const vintZh = (snap?.zhs || []).find((z) => z.w === 'vintage');
  check('S9 译文侧已记住也是绿色系', hueOf(vintZh?.color) === 'green', { color: vintZh?.color });

  // ---- S10/S11：复习计数 ----
  const before = await sw.evaluate(async () => {
    const r = await globalThis.__traceDebug.idbGet('words', 'beverage');
    return r ? { reviewCount: r.reviewCount, status: r.status } : null;
  });

  // 悬停不足 800ms → 不该计数
  if (zbox) {
    await page.mouse.move(zbox.x, zbox.y);
    await page.waitForTimeout(260);
    await page.mouse.move(5, 5); // 立刻移开，不足停留阈值
    await page.waitForTimeout(700);
  }
  const shortDwell = await sw.evaluate(async () => {
    const r = await globalThis.__traceDebug.idbGet('words', 'beverage');
    return r ? r.reviewCount : null;
  });
  check('S10 停留时间不够就不算复习', shortDwell === (before?.reviewCount ?? 0), {
    before: before?.reviewCount,
    after: shortDwell,
  });

  // 停留够久 → 计数 +1
  if (zbox) {
    await page.mouse.move(zbox.x, zbox.y);
    await page.waitForTimeout(1400);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(600);
  }
  const afterDwell = await sw.evaluate(async () => {
    const r = await globalThis.__traceDebug.idbGet('words', 'beverage');
    return r ? { reviewCount: r.reviewCount, status: r.status } : null;
  });
  check(
    'S11 停留够久记一次复习',
    (afterDwell?.reviewCount ?? 0) === (before?.reviewCount ?? 0) + 1,
    { before: before?.reviewCount, after: afterDwell?.reviewCount, status: afterDwell?.status }
  );

  // ---- S12：同一句内只记一次 ----
  if (zbox) {
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(zbox.x, zbox.y);
      await page.waitForTimeout(1200);
      await page.mouse.move(5, 5);
      await page.waitForTimeout(300);
    }
  }
  const afterRepeat = await sw.evaluate(async () => {
    const r = await globalThis.__traceDebug.idbGet('words', 'beverage');
    return r ? r.reviewCount : null;
  });
  check('S12 同一句里反复划过只记一次', afterRepeat === afterDwell?.reviewCount, {
    afterDwell: afterDwell?.reviewCount,
    afterRepeat,
  });

  // ---- S13/S14：卡片「标记为已记住」 ----
  // 换到下一句再回来，让 reviewedHere 清空（否则点卡片那次复习被去重，
  // 不过这里测的是 markLearned，与 review 无关，清不清都不影响）。
  const cardState = await page.evaluate(() => {
    const o = document.getElementById('trace-sub-overlay');
    const el = [...(o?.querySelectorAll('.trace-word') || [])].find((e) => /^lounge$/i.test(e.textContent));
    if (!el) return { found: false };
    el.click();
    return { found: true };
  });
  let learnBtn = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(400);
    learnBtn = await page.evaluate(() => {
      const b = document.querySelector('#trace-word-popup [data-act="learned"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { text: b.textContent, disabled: b.disabled, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (learnBtn) break;
  }
  check('S13 已收藏词的卡片有「标记为已记住」按钮', !!learnBtn, { text: learnBtn?.text });

  if (learnBtn) {
    await page.mouse.click(learnBtn.x, learnBtn.y);
    await page.waitForTimeout(1200);
  }
  const afterLearn = await sw.evaluate(async () => {
    const r = await globalThis.__traceDebug.idbGet('words', 'lounge');
    return r ? { status: r.status, reviewCount: r.reviewCount } : null;
  });
  check('S14 点按钮后 status=learned', afterLearn?.status === 'learned', afterLearn);

  // 高亮颜色应该立刻变绿
  const loungeAfter = await page.evaluate(() => {
    const o = document.getElementById('trace-sub-overlay');
    const el = [...(o?.querySelectorAll('.trace-word') || [])].find((e) => /^lounge$/i.test(e.textContent));
    return el ? { st: el.dataset.st || '', color: getComputedStyle(el).color } : null;
  });
  check('S15 标记后高亮立刻变绿', hueOf(loungeAfter?.color) === 'green', loungeAfter);

  // ---- S16：关掉背单词模式后不再模糊 ----
  await sw.evaluate(async () => {
    await globalThis.__traceDebug.setSettings({ blurZh: false });
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(600);
    const ok = await page.evaluate(() => {
      const o = document.getElementById('trace-sub-overlay');
      return !!(o && o.querySelector('.trace-saved-zh'));
    });
    if (ok) break;
  }
  const noBlur = await page.evaluate(() => {
    const o = document.getElementById('trace-sub-overlay');
    const el = o?.querySelector('.trace-saved-zh');
    return el ? { classes: el.className, filter: getComputedStyle(el).filter } : null;
  });
  check(
    'S16 关掉背单词模式后中文不再模糊',
    !!(noBlur && !/trace-zh-blur/.test(noBlur.classes)),
    noBlur
  );

  check('S17 无 JS 错误', pageErrors.length === 0, { errors: pageErrors });

  await ctx.close();

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`\nRESULT: FAIL (${failed.map((f) => f.name).join(', ')})`);
    process.exit(1);
  }
  console.log(
    '\nRESULT: PASS（背单词模式：译文模糊 + 词态配色 + 复习计数 + 标记已记住 + 开关）'
  );
})();
