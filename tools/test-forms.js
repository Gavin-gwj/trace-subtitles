/**
 * 词形归一化专项测试（生词本里的 beverage 要能高亮字幕里的 beverages）
 *
 * 验证五件事：
 *   1. subtitles.js 与 bg.js 里的 WORD_FORMS 段内容一致（两处各一份，必须同步）
 *   2. wordForms() 对常见词形变化给出正确候选（单复数 / -ed / -ing / 比较级 / 不规则复数）
 *   3. wordForms() 不产生已知的误报（news 不能变 new、bus 不能变 bu、is/was/has 不拆）
 *   4. 端到端：只收藏 beverage，字幕里的 beverages 也高亮，且 data-w 归一化成 beverage
 *   5. 点这个复数形式，生词卡显示「✓ 已在生词本」而不是「＋ 加入生词本」
 *
 * 用法: node test-forms.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const fx = require('./mock/fixtures');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const ORIGIN = 'https://www.youtube.com';
const WATCH = `${ORIGIN}/watch?v=${fx.VIDEO_ID}`;

// 单复数配对句：第一句单数、第二句复数。
// 只收藏 beverage，两句都应该高亮 —— 这是用户实际遇到的场景。
const FORM_CUES = [
  [0.0, 1.8, 'Right when I got seated I was brought a cappuccino and some other beverage.'],
  [2.0, 2.2, 'There is also a lounge with a bar and attendants that serve you beverages.'],
  [4.4, 1.8, 'The city lounge was busier than the box office.'],
  [6.4, 1.8, 'She stopped walking and carried the happier child.'],
];

/** 抽出文件里 // >>> WORD_FORMS_BEGIN ... // >>> WORD_FORMS_END 之间的文本（去掉行首缩进） */
function wordFormsBlock(file) {
  const text = fs.readFileSync(file, 'utf8');
  const a = text.indexOf('// >>> WORD_FORMS_BEGIN');
  const b = text.indexOf('// >>> WORD_FORMS_END');
  if (a < 0 || b < 0) return null;
  const body = text.slice(a, b + '// >>> WORD_FORMS_END'.length);
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s+/, ''))
    .join('\n');
}

(async () => {
  // ---- 1. 两处实现必须一致 ----
  const blockA = wordFormsBlock(path.join(EXT, 'subtitles.js'));
  const blockB = wordFormsBlock(path.join(EXT, 'bg.js'));
  const blockSame = !!blockA && blockA === blockB;
  console.log('WORD_FORMS blocks identical:', blockSame, `(${blockA ? blockA.length : 0} chars)`);
  if (!blockSame) {
    console.log('RESULT: FAIL (两份 WORD_FORMS 实现不一致，请同步 subtitles.js 与 bg.js)');
    process.exit(1);
  }

  const userDataDir = path.join(__dirname, '.chrome-forms');
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
        headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' },
        body: JSON.stringify({ playerResponse: fx.playerResponse() }),
      });
    }
    if (p === '/api/timedtext') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' },
        body: fx.json3Body(FORM_CUES),
      });
    }
    if (p === '/watch' || p === '/' || p === '') {
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: fx.pageHtml(fx.VIDEO_ID, { cues: FORM_CUES }),
      });
    }
    return route.fulfill({ status: 404, body: 'nf' });
  });

  const logs = [];
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('console', (m) => {
    const t = m.text();
    if (/Trace/i.test(t)) {
      logs.push(t);
      console.log(`  console[${m.type()}] ${t}`);
    }
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  console.log('SW:', sw ? sw.url() : 'NOT FOUND');
  if (!sw) {
    console.log('RESULT: FAIL (no service worker)');
    await ctx.close();
    process.exit(1);
  }

  // ---- 2 & 3. wordForms 单元断言（在 SW 里跑 bg.js 那份实现） ----
  const unit = await sw.evaluate(() => {
    const cases = [
      ['beverages', 'beverage'], ['beverage', 'beverages'], ['lounges', 'lounge'],
      ['halves', 'half'], ['cities', 'city'], ['boxes', 'box'], ['watches', 'watch'],
      ['knives', 'knife'], ['wolves', 'wolf'], ['children', 'child'], ['people', 'person'],
      ['stopped', 'stop'], ['making', 'make'], ['running', 'run'], ['carried', 'carry'],
      ['happier', 'happy'], ['biggest', 'big'], ['used', 'use'],
    ];
    const misses = [];
    for (const [input, want] of cases) {
      const forms = globalThis.__traceDebug.wordForms(input);
      if (!forms.has(want)) misses.push(`${input}->${want}`);
    }
    const falsePositives = [];
    for (const [input, mustNot] of [
      ['bus', 'bu'], ['class', 'clas'], ['news', 'new'], ['is', 'i'],
      ['was', 'wa'], ['has', 'ha'], ['this', 'thi'],
    ]) {
      const forms = globalThis.__traceDebug.wordForms(input);
      if (forms.has(mustNot)) falsePositives.push(`${input}->${mustNot}`);
    }
    return { misses, falsePositives };
  });
  console.log('wordForms unit:', JSON.stringify(unit));

  await page.goto(WATCH, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // ---- 只收藏单数 beverage ----
  await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    await D.addWordNotify({
      word: 'beverage',
      display: 'beverage',
      phonetic: '/ˈbevərɪdʒ/',
      zh: '饮料',
      meanings: [{ pos: 'noun', def: 'a drink other than water' }],
      example: 'some other beverage',
      context: 'Right when I got seated I was brought a cappuccino and some other beverage.',
      contextZh: '刚坐下，就有人给我端来一杯卡布奇诺和其他一些饮料。',
      videoTitle: 'Mock Video',
      videoId: 'TESTID00001',
      time: 1.0,
    });
    return true;
  });

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

  // ---- 4. 采样：等到复数句，检查高亮与 data-w ----
  // 播放是自然推进的（MediaStream 不支持 seek），复数句在 2.0~4.2s，
  // 所以每 300ms 采样一次，收集所有见过的「含 beverages 的那句」的渲染结果。
  let plural = null;
  let singular = null;
  for (let i = 0; i < 60; i++) {
    const snap = await page.evaluate(() => {
      const o = document.getElementById('trace-sub-overlay');
      if (!o) return null;
      const orig = o.querySelector('.trace-sub-orig');
      const text = orig ? orig.textContent : '';
      if (!/beverage/i.test(text)) return null;
      const words = [...orig.querySelectorAll('.trace-word')].map((el) => ({
        text: el.textContent,
        saved: el.classList.contains('trace-saved'),
        w: el.dataset.w,
      }));
      return { text, words };
    });
    if (snap) {
      const target = snap.words.find((w) => /^beverages?$/i.test(w.text));
      if (target) {
        if (/beverages$/i.test(target.text)) plural = { ...snap, target };
        else singular = { ...snap, target };
      }
      if (plural && singular) break;
    }
    await page.waitForTimeout(300);
  }

  // ---- 5. 点复数形式，看按钮状态 ----
  let clickState = null;
  if (plural) {
    // 先把时间钉住，否则采样完这句就播过去了
    await page.evaluate(() => window.__mockPause && window.__mockPause());
    await page.waitForTimeout(300);
    const clicked = await page.evaluate(() => {
      const o = document.getElementById('trace-sub-overlay');
      const el = [...o.querySelectorAll('.trace-word')].find((e) => /^beverages$/i.test(e.textContent));
      if (!el) return { found: false };
      el.click();
      return { found: true, dataW: el.dataset.w, saved: el.classList.contains('trace-saved') };
    });
    if (clicked.found) {
      let state = null;
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(500);
        state = await page.evaluate(() => {
          const pop = document.getElementById('trace-word-popup');
          if (!pop) return null;
          // 注意：弹窗里第一个 [data-act] 是右上角的关闭按钮（data-act="close"），
          // 收藏按钮要单独选，否则会把「×」当成按钮文案。
          const btn = pop.querySelector('[data-act="add"], [data-act="remove"]');
          return {
            present: !pop.classList.contains('trace-hidden'),
            word: pop.querySelector('.trace-pop-word')?.textContent || '',
            btnText: btn ? btn.textContent.trim() : '',
            btnAct: btn ? btn.dataset.act : '',
            loading: !!pop.querySelector('.trace-pop-loading'),
          };
        });
        if (state && !state.loading) break;
      }
      clickState = { ...clicked, ...(state || {}) };
    }
  }

  await page.screenshot({ path: path.join(__dirname, 'shot-forms.png') });

  await ctx.close();

  const checks = {
    blockSame,
    unitForms: unit.misses.length === 0,
    unitNoFalsePositive: unit.falsePositives.length === 0,
    // 单数句：高亮
    singularSaved: !!(singular && singular.target.saved),
    // 复数句：也高亮，且 data-w 归一化成单数
    pluralSaved: !!(plural && plural.target.saved),
    pluralCanon: !!(plural && plural.target.w === 'beverage'),
    // 点复数 → 生词卡显示「已在生词本」
    clickShowsSaved: !!(clickState && clickState.found && clickState.btnAct === 'remove'),
    clickWordCanon: !!(clickState && /^beverage$/i.test(clickState.word || '')),
    noPageErrors: pageErrors.length === 0,
  };

  console.log('\nsingular:', JSON.stringify(singular && { text: singular.text.slice(0, 60), target: singular.target }));
  console.log('plural  :', JSON.stringify(plural && { text: plural.text.slice(0, 60), target: plural.target }));
  console.log('click   :', JSON.stringify(clickState));
  console.log('checks  :', JSON.stringify(checks));
  if (pageErrors.length) console.log('pageErrors:', pageErrors);

  const pass = Object.values(checks).every(Boolean);
  console.log(pass ? '\nRESULT: PASS（词形归一化：单复数都高亮，点复数打开同一词条）' : '\nRESULT: FAIL');
  process.exit(pass ? 0 : 1);
})();
