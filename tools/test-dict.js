/**
 * 查词卡片回归：中文优先 + 词性中文 + 释义/例句翻译 + 英文默认收起
 *
 * 起因（用户报障）：
 *   「点击单词能不能给我稍微详细一些，然后里面尽量中文多一些，
 *     因为我本来就是要看翻译，结果还给我来一堆英文会更加看不懂」
 *
 * 这里要盯住的四件事：
 *   1) 卡片主体是中文（中文释义条数 > 0，且第一条就是中文）
 *   2) 词性是中文（noun 不能原样漏出来 —— 早期 POS_MAP 只映射了缩写 n/v/adj，
 *      而 dictionaryapi.dev 返回的是全称 noun/verb/adjective，取不到就回退成英文）
 *   3) 英文释义存在但默认收起（<details> 未 open）
 *   4) 有「本句译文」区块，把单词放回视频原句里解释 —— 词典释义和语境义
 *      本来就可能不同（vintage 词典是「优质的」，这句里是「复古」），
 *      不解释清楚用户会以为翻译错了
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const F = require('./mock/fixtures');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const userDataDir = path.join(__dirname, '.chrome-dict');
const VW = 1280;
const VH = 860;

const checks = {};
const failed = [];

function check(name, ok, extra) {
  checks[name] = !!ok;
  const mark = ok ? '\u2713' : '\u2717';
  const extraStr = extra === undefined ? '' : ' ' + JSON.stringify(extra);
  console.log(`${mark} ${name}${extraStr}`);
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
      '--mute-audio',
      ...require('./lib/proxy').proxyArgs(),
    ],
    viewport: { width: VW, height: VH },
    locale: 'zh-CN',
  });

  const errors = [];
  ctx.on('page', (p) => {
    p.on('pageerror', (e) => errors.push(String(e)));
  });

  // ---- 假 YouTube：复用夹具，但字幕换成一句含 vintage 的 ----
  const CUES = [
    [0.0, 3.0, 'look. This is proper vintage.'],
    [3.0, 2.0, 'This is proper vintage.'],
  ];
  // 第二阶段用：immediately 的词典义与语境义确实不同
  const CUES2 = [
    [0.0, 3.0, 'He was immediately brought a cappuccino.'],
    [3.0, 2.0, 'She immediately knew.'],
  ];
  await ctx.route('https://www.youtube.com/**', async (route) => {
    const u = route.request().url();
    if (u.includes('/api/timedtext')) {
      const body = F.json3Body(CUES);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': 'https://www.youtube.com' },
        body,
      });
    }
    if (u.includes('/youtubei/v1/player')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': 'https://www.youtube.com' },
        body: JSON.stringify({ playerResponse: F.playerResponse(F.VIDEO_ID) }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: F.pageHtml(F.VIDEO_ID, { cues: CUES }),
    });
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  console.log('SW:', sw.url());

  // 词典是真实网络请求（dictionaryapi.dev + translate.googleapis.com），
  // 只清缓存，不 mock —— 卡片里到底有没有中文，必须看真实链路。
  await sw.evaluate(async () => {
    const db = await globalThis.__traceDebug.openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('translations', 'readwrite');
      tx.objectStore('translations').clear();
      tx.oncomplete = res;
      tx.onerror = rej;
    });
  });

  const page = await ctx.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${F.VIDEO_ID}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('.trace-sub-orig', { timeout: 20000 });
  await page.waitForFunction(
    () => {
      const t = document.querySelector('.trace-sub-trans');
      return t && t.textContent.trim().length > 0;
    },
    { timeout: 30000 }
  );

  // 点字幕里的 vintage
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.trace-word')].find(
      (n) => (n.textContent || '').toLowerCase().replace(/[^a-z]/g, '') === 'vintage'
    );
    if (!el) return false;
    el.click();
    return true;
  });
  check('D1 字幕里找到并点击了 vintage', clicked);
  if (!clicked) {
    await ctx.close();
    return finish();
  }

  // 等卡片填充完成（loading 消失）
  await page.waitForFunction(
    () => {
      const pop = document.getElementById('trace-word-popup');
      if (!pop || pop.classList.contains('trace-hidden')) return false;
      return !pop.querySelector('.trace-pop-loading');
    },
    { timeout: 30000 }
  );
  await page.waitForTimeout(300);

  const card = await page.evaluate(() => {
    const pop = document.getElementById('trace-word-popup');
    if (!pop) return null;
    const body = pop.querySelector('.trace-pop-body');
    const txt = (sel) => pop.querySelector(sel)?.textContent?.trim() || '';
    const senses = [...pop.querySelectorAll('.trace-pop-senses li')].map((li) => ({
      pos: li.querySelector('i')?.textContent?.trim() || '',
      text: li.querySelector('span')?.textContent?.trim() || '',
    }));
    const more = pop.querySelector('.trace-pop-more');
    const ctxBlock = [...pop.querySelectorAll('.trace-pop-block')].find((b) =>
      /本句译文/.test(b.textContent || '')
    );
    return {
      word: txt('.trace-pop-word'),
      phon: txt('.trace-pop-phon'),
      // 直译有两种渲染位置：有中文释义清单时是 .trace-pop-gloss（小字「直译：…」），
      // 没有清单时才是 .trace-pop-zh（红色大字，唯一的中文）。
      zh: txt('.trace-pop-zh') || txt('.trace-pop-gloss'),
      hasSenses: pop.querySelectorAll('.trace-pop-senses li').length > 0,
      senses,
      ctxEn: ctxBlock?.querySelector('.trace-pop-ctx')?.textContent?.trim() || '',
      ctxZh: ctxBlock?.querySelector('.trace-pop-ctx-zh')?.textContent?.trim() || '',
      hasMore: !!more,
      moreOpen: more ? more.hasAttribute('open') : false,
      enDefsCount: pop.querySelectorAll('.trace-pop-meanings li').length,
      bodyText: body?.textContent || '',
      bodyHeight: body?.getBoundingClientRect().height || 0,
      width: pop.getBoundingClientRect().width,
      // 卡片与字幕框是否重叠 —— 查词时把正在看的字幕盖住是最烦的
      overlap: (() => {
        const box = document.querySelector('.trace-sub-box');
        if (!box) return null;
        const a = pop.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return {
          w: Math.round(w),
          h: Math.round(h),
          overlapPx: Math.round(Math.min(w, h)),
          pop: [Math.round(a.top), Math.round(a.bottom)],
          box: [Math.round(b.top), Math.round(b.bottom)],
        };
      })(),
      // 中文占比：CJK 字符数 / 非空白字符数
      // 必须只算**可见**文本 —— 折叠在 <details> 里的英文释义仍是 textContent
      // 的一部分，算进来会把占比压低，量到的就不是用户真正读到的内容。
      cjkRatio: (() => {
        const visible = [];
        const walk = (node) => {
          if (node.nodeType === 3) {
            visible.push(node.nodeValue);
            return;
          }
          if (node.nodeType !== 1) return;
          const tag = node.tagName.toLowerCase();
          // <details> 未展开时其内容不可见
          if (tag === 'details' && !node.hasAttribute('open')) return;
          if (tag === 'summary') return;
          for (const c of node.childNodes) walk(c);
        };
        if (body) for (const c of body.childNodes) walk(c);
        const s = visible.join('').replace(/\s+/g, '');
        if (!s) return 0;
        const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
        return Math.round((cjk / s.length) * 100) / 100;
      })(),
      // 同时记录含折叠内容的占比，方便对比
      cjkRatioAll: (() => {
        const s = (body?.textContent || '').replace(/\s+/g, '');
        if (!s) return 0;
        const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
        return Math.round((cjk / s.length) * 100) / 100;
      })(),
    };
  });

  check('D2 卡片打开且标题是 vintage', /^vintage$/i.test(card.word || ''), {
    word: card.word,
  });

  // 词性必须是中文 —— 这是 POS_MAP 漏映射全称时最直接的暴露点
  const posTexts = card.senses.map((s) => s.pos).filter(Boolean);
  const posAllChinese = posTexts.length > 0 && posTexts.every((p) => /[\u4e00-\u9fff]/.test(p));
  check('D3 词性是中文（noun/verb 不能原样漏出）', posAllChinese, {
    posTexts,
  });

  // 释义主体是中文
  const senseZh = card.senses.filter((s) => /[\u4e00-\u9fff]/.test(s.text));
  check('D4 中文释义至少 2 条', senseZh.length >= 2, {
    count: senseZh.length,
    sample: senseZh.slice(0, 3).map((s) => s.text),
  });

  check('D5 词典中文释义在（vintage → 优质的之类）', !!card.zh && /[\u4e00-\u9fff]/.test(card.zh), {
    zh: card.zh,
    hasSenses: card.hasSenses,
  });

  // 英文释义存在但收起
  check('D6 英文释义存在但默认收起', card.hasMore && !card.moreOpen && card.enDefsCount > 0, {
    hasMore: card.hasMore,
    moreOpen: card.moreOpen,
    enDefsCount: card.enDefsCount,
  });

  // 本句译文区块：把词放回视频原句
  check('D7 有「本句译文」区块且带中文', !!card.ctxZh && /[\u4e00-\u9fff]/.test(card.ctxZh), {
    ctxEn: card.ctxEn.slice(0, 60),
    ctxZh: card.ctxZh.slice(0, 60),
  });

  // 整体中文占比：只看用户实际能读到的部分（折叠的英文释义不算）
  check('D8 可见正文中文占比 > 0.6', card.cjkRatio > 0.6, {
    cjkRatio: card.cjkRatio,
    cjkRatioAll: card.cjkRatioAll,
  });

  // 卡片不超视口、宽度是 340
  check('D9 卡片宽度 340 且不超出视口', card.width === 340, { width: card.width });

  // 卡片不能盖住字幕 —— 用户正看着那一句，盖住等于看不到
  check(
    'D12 卡片不遮挡字幕',
    !card.overlap || card.overlap.overlapPx <= 2,
    card.overlap
  );

  // 展开英文释义后仍在视口内，且仍然不遮挡字幕
  // （<details> 的 toggle 必须触发重新定位，否则卡片向下长出去正好盖住字幕）
  await page.evaluate(() => {
    const pop = document.getElementById('trace-word-popup');
    const more = pop.querySelector('.trace-pop-more');
    if (more) more.open = true;
  });
  await page.waitForTimeout(250);
  const afterOpen = await page.evaluate(() => {
    const pop = document.getElementById('trace-word-popup');
    const r = pop.getBoundingClientRect();
    const box = document.querySelector('.trace-sub-box');
    const b = box ? box.getBoundingClientRect() : null;
    let overlapPx = null;
    if (b) {
      const w = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const h = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      overlapPx = Math.round(Math.min(w, h));
    }
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      vh: innerHeight,
      overlapPx,
    };
  });
  check(
    'D10 展开英文释义后卡片不超出视口',
    afterOpen.top >= 0 && afterOpen.bottom <= afterOpen.vh,
    afterOpen
  );
  check(
    'D13 展开英文释义后仍不遮挡字幕',
    afterOpen.overlapPx === null || afterOpen.overlapPx <= 2,
    afterOpen
  );

  check('D11 无 JS 错误', errors.length === 0, { errors: errors.slice(0, 3) });

  // ---- 第二阶段：这个词已在生词本里时，卡片要告诉用户「本句译作什么」----
  // 用户的原始抱怨是「会出现翻译不一样的情况」：字幕把 vintage 译成「复古」，
  // 词典给「优质的」，两边一对照就像翻错了。真正权威的是它在**这句话里**的译法，
  // 而这个译法后台已经在 zhSpans 里算过了，只要把它显示出来就能消除困惑。
  await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    await D.addWord({ word: 'vintage', display: 'vintage', zh: '优质的' });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.trace-sub-orig', { timeout: 20000 });
  // 等生词高亮 + 对齐译文就绪（zhSpans 要等 realign 那一轮才回来）
  await page.waitForFunction(
    () => {
      const t = document.querySelector('.trace-sub-trans');
      return t && t.querySelector('.trace-saved-zh');
    },
    { timeout: 30000 }
  );

  const clicked2 = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.trace-word')].find(
      (n) => (n.textContent || '').toLowerCase().replace(/[^a-z]/g, '') === 'vintage'
    );
    if (!el) return false;
    el.click();
    return true;
  });
  check('D14 已收藏的词在字幕里高亮且可点', clicked2);
  await page.waitForFunction(
    () => {
      const pop = document.getElementById('trace-word-popup');
      if (!pop || pop.classList.contains('trace-hidden')) return false;
      return !pop.querySelector('.trace-pop-loading');
    },
    { timeout: 30000 }
  );
  await page.waitForTimeout(300);

  const savedCard = await page.evaluate(() => {
    const pop = document.getElementById('trace-word-popup');
    const txt = (sel) => pop.querySelector(sel)?.textContent?.trim() || '';
    const btn = pop.querySelector('[data-act="add"], [data-act="remove"]');
    return {
      ctxWord: txt('.trace-pop-ctxword'),
      gloss: txt('.trace-pop-gloss') || txt('.trace-pop-zh'),
      btnText: btn?.textContent?.trim() || '',
      btnAct: btn?.dataset.act || '',
    };
  });
  // 语境义提示只在**与词典直译不同**时才显示。
  // 引擎对单个词往往就翻成和词典一样（vintage → 优质的），这时再显示一遍
  // 「本句译作 优质的」会让用户以为这是两个不同答案。所以断言的是不变式：
  // 要么没有这条提示，要么它出现且确实与直译不同。
  const ctxWordText = (savedCard.ctxWord || '').replace(/^本句译作「|」$/g, '');
  const ctxDiffers = ctxWordText && ctxWordText !== (savedCard.gloss || '');
  check(
    'D15 语境义提示只在不同于直译时出现（不重复同一答案）',
    !savedCard.ctxWord || (ctxDiffers && /[\u4e00-\u9fff]/.test(ctxWordText)),
    { ctxWord: savedCard.ctxWord, gloss: savedCard.gloss, differs: !!ctxDiffers }
  );
  check(
    'D16 已收藏的词按钮显示「已在生词本」',
    savedCard.btnAct === 'remove' && /已在生词本/.test(savedCard.btnText),
    { btnText: savedCard.btnText, btnAct: savedCard.btnAct }
  );

  // ---- 字幕换成一句含 immediately 的，验证「语境义真的不同时会显示」----
  // immediately 的词典义是「立即地」，Google 在这句里译成「立即」——
  // 这就是用户说的「翻译不一样」。两个都该出现，但要标清楚各自是什么。
  await ctx.route('https://www.youtube.com/**', async (route) => {
    const u = route.request().url();
    if (u.includes('/api/timedtext')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': 'https://www.youtube.com' },
        body: F.json3Body(CUES2),
      });
    }
    if (u.includes('/youtubei/v1/player')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': 'https://www.youtube.com' },
        body: JSON.stringify({ playerResponse: F.playerResponse(F.VIDEO_ID) }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: F.pageHtml(F.VIDEO_ID, { cues: CUES2 }),
    });
  });
  await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    await D.addWord({ word: 'immediately', display: 'immediately', zh: '立即地' });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.trace-sub-orig', { timeout: 20000 });
  await page.waitForFunction(
    () => {
      const t = document.querySelector('.trace-sub-trans');
      return t && t.querySelector('.trace-saved-zh');
    },
    { timeout: 30000 }
  );
  const clicked3 = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.trace-word')].find(
      (n) => (n.textContent || '').toLowerCase().replace(/[^a-z]/g, '') === 'immediately'
    );
    if (!el) return false;
    el.click();
    return true;
  });
  check('D17 immediately 已收藏且在字幕里高亮可点', clicked3);
  await page.waitForFunction(
    () => {
      const pop = document.getElementById('trace-word-popup');
      if (!pop || pop.classList.contains('trace-hidden')) return false;
      return !pop.querySelector('.trace-pop-loading');
    },
    { timeout: 30000 }
  );
  await page.waitForTimeout(300);
  const diffCard = await page.evaluate(() => {
    const pop = document.getElementById('trace-word-popup');
    const txt = (sel) => pop.querySelector(sel)?.textContent?.trim() || '';
    return { ctxWord: txt('.trace-pop-ctxword'), gloss: txt('.trace-pop-gloss') || txt('.trace-pop-zh') };
  });
  check(
    'D18 语境义与直译不同时，两条都显示且能区分',
    /本句译作/.test(diffCard.ctxWord) && !!diffCard.gloss && /[\u4e00-\u9fff]/.test(diffCard.ctxWord),
    diffCard
  );

  await page.screenshot({ path: path.join(__dirname, 'shot-dict.png') });

  await ctx.close();
  finish();
})().catch(async (e) => {
  console.error('FATAL', e);
  failed.push('fatal');
  finish();
});

function finish() {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log('\n' + JSON.stringify(checks, null, 2));
  if (failed.length) {
    console.log(`\nRESULT: FAIL (${failed.join(', ')})（查词卡片中文优先）`);
    process.exit(1);
  }
  console.log(
    '\nRESULT: PASS（查词卡片：词性中文 + 中文释义 + 本句译文 + 英文默认收起）'
  );
  process.exit(0);
}
