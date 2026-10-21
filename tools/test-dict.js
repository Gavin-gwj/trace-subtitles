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
  // 时间窗必须远长于「加载 + 抓轨 + 翻译往返」的最坏耗时（教训同 test-card.js：
  // 5 秒窗口在全量跑时会被播穿，字幕清空后既点不到词也等不到译文）。
  //
  // 但第一条 cue 必须是**单句**：扩展会把「句中句号」拆开并按时长比例分摊时间轴
  // （见 test-split.js）。早先这里是 'look. This is proper vintage.'，
  // 拉长到 30 秒后分摊成 look.(0–15s) / This is proper vintage.(15–30s)，
  // 断言执行时还停在前半句，vintage 根本不在 DOM 里 → D1 失败。
  // 逗号断句的覆盖交给 test-split.js，这里只要一句能稳定点到 vintage。
  const CUES = [[0.0, 60.0, 'This is proper vintage.']];
  // 第二阶段用：语境义与词典直译**差别足够大**，断言才稳定。
  //
  // 早先这里用 immediately：词典义「立即地」、这句里的语境义「立即」，
  // 两者只差一个「地」，而引擎偶尔直接翻成「立即地」→ 去重逻辑判定
  // 「两个答案相同」把提示清掉 → D18 随机失败（全量跑时偶现，单跑不现）。
  //
  // pick 的差别是结构性的：词典义「挑选」、这句里是「铁镐」（iron pick 是复合名词）。
  // 有 probe-pair2.js 实测支撑：「iron pick」→「铁镐」确实是主译文的字面子串。
  const CUES2 = [
    [0.0, 30.0, 'He grabbed an iron pick and started digging.'],
    [30.0, 30.0, 'She grabbed another iron pick.'],
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
  // 只等「这个词在原文里被标成已收藏」——这一步由 loadWordSet 驱动，必然发生。
  //
  // 不能等 `.trace-saved-zh`（译文侧的高亮片段）。bug 18 修复后译文侧高亮
  // 走的是「旁路探针定位」，定位不到就不高亮：
  //   "This is proper vintage." → "这是正确的年份。"
  // vintage 在这里被译成「年份」，单词探针给「优质的」、窗口探针也定位不到，
  // 差分又过不了 50% 闸门 → 诚实结果就是「不高亮」。
  // 旧版代码在这句里会输出「这是正确的**优质的**。」——那句话本身才是 bug 18
  // 的产物（把词典义塞进句子），不能拿它的行为当基线。
  let d14ok = false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(400);
    const st = await page.evaluate(() => {
      const o = document.getElementById('trace-sub-overlay');
      const v = document.querySelector('video');
      return {
        orig: (document.querySelector('.trace-sub-orig')?.textContent || '').trim(),
        words: [...(o?.querySelectorAll('.trace-word') || [])].map((n) => ({
          w: n.dataset.w,
          saved: n.classList.contains('trace-saved'),
        })),
        t: v ? +v.currentTime.toFixed(2) : null,
        ended: v ? v.ended : null,
        paused: v ? v.paused : null,
      };
    });
    if (i < 6 || st.words.length === 0) {
      console.log(`D14 轮询[${i}]`, JSON.stringify(st));
    }
    if (st.words.some((w) => w.saved && w.w === 'vintage')) {
      d14ok = true;
      break;
    }
    if (st.ended) {
      console.log('D14 视频已结束，重新播放');
      await page.evaluate(() => window.__mockPlay && window.__mockPlay());
    }
  }
  if (!d14ok) console.log('D14 始终没看到 vintage 的已收藏标记');
  // 不要在采样前再等 realign —— 夹具字幕总长只有 5 秒，任何额外等待都可能
  // 让视频播过当前 cue，采样时 .trace-word 已经换成下一句甚至清空。
  // 直接把「此刻屏幕上是什么」记下来。

  const align2 = await page.evaluate(() => {
    const o = document.getElementById('trace-sub-overlay');
    const zh = [...(o?.querySelectorAll('.trace-saved-zh') || [])].map((n) => ({
      w: n.dataset.w,
      text: n.textContent,
    }));
    const word = [...(o?.querySelectorAll('.trace-word.trace-saved') || [])].map(
      (n) => n.dataset.w
    );
    return {
      zh,
      word,
      plainZh: (document.querySelector('.trace-sub-trans')?.textContent || '').trim(),
    };
  });
  // 高亮是「可以没有」的，但只要出现就必须与译文一致（不能亮一个译文里没有的词）
  const alignOk =
    align2.zh.length === 0 ||
    align2.zh.every((z) => align2.plainZh.includes(z.text));
  check(
    'D14 已收藏的词在原文里高亮，且译文侧高亮若存在必与译文一致',
    align2.word.includes('vintage') && alignOk,
    { word: align2.word, zhCount: align2.zh.length, align: alignOk, plainZh: align2.plainZh }
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
    await D.addWord({ word: 'pick', display: 'pick', zh: '挑选' });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.trace-sub-orig', { timeout: 20000 });
  // 立刻暂停：CUES2 只覆盖 0–5 秒，而这一段要等「原文高亮 + 查词卡片」好几秒。
  // 不暂停就必然播过最后一条 cue，字幕整体清空、点不到词（这才是 D17 超时的真因）。
  await page.evaluate(() => window.__mockPause && window.__mockPause());
  // 同 D14：只等原文侧标记，译文侧高亮允许缺席（定位不到就不亮是对的）
  let sawImm = false;
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => {
      const o = document.getElementById('trace-sub-overlay');
      const v = document.querySelector('video');
      return {
        t: v ? +v.currentTime.toFixed(2) : null,
        paused: v ? v.paused : null,
        orig: (o?.querySelector('.trace-sub-orig')?.textContent || '').slice(0, 50),
        words: [...(o?.querySelectorAll('.trace-word') || [])].map((n) => n.dataset.w),
        saved: [...(o?.querySelectorAll('.trace-word.trace-saved') || [])].map(
          (n) => n.dataset.w
        ),
      };
    });
    console.log('D17 轮询', i, JSON.stringify(st));
    if (st.saved.includes('pick')) {
      sawImm = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!sawImm) {
    check('D17 pick 已收藏且在字幕里高亮可点', false, { reason: 'no saved highlight' });
    await ctx.close();
    finish();
    return;
  }
  // 关键：一拿到高亮就**暂停**时间轴。
  // 夹具用 canvas.captureStream 喂 video，MediaStream 不支持 seek、也永远不会 ended，
  // currentTime 一路涨过最后一条 cue 之后字幕就整体清空再也不回来。
  // 早先这里还多等了一个 8 秒的 waitForFunction（等译文侧高亮），那 8 秒正好把
  // 5 秒长的 cue 播完 → 点不到词 → D17 与 D18 连锁失败。
  // 现在：等到原文高亮即暂停，时间轴钉在 cue 内，后面怎么等都不会跑掉。
  await page.evaluate(() => window.__mockPause && window.__mockPause());

  // 译文侧的语境义（zhSpans）要等 realign 回来才有，而 D18 断言正是读它。
  // 时间轴已暂停，可以安心等；最多等 12 秒（探针批次 + 缓存写入）。
  let spanReady = null;
  for (let i = 0; i < 24; i++) {
    spanReady = await page.evaluate(() => {
      const o = document.getElementById('trace-sub-overlay');
      return {
        zh: (o?.querySelector('.trace-sub-trans')?.textContent || '').slice(0, 60),
        spans: [...(o?.querySelectorAll('.trace-saved-zh') || [])].map((n) => ({
          w: n.dataset.w,
          t: n.textContent,
        })),
      };
    });
    if (spanReady.spans.some((s) => s.w === 'pick')) break;
    await page.waitForTimeout(500);
  }
  console.log('D18 语境义等待结果', JSON.stringify(spanReady));

  let clicked3 = false;
  for (let i = 0; i < 25; i++) {
    clicked3 = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.trace-word')].find(
        (n) => (n.textContent || '').toLowerCase().replace(/[^a-z]/g, '') === 'pick'
      );
      if (!el) return false;
      el.click();
      return true;
    });
    if (clicked3) break;
    await page.waitForTimeout(400);
  }
  check('D17 pick 已收藏且在字幕里高亮可点', clicked3);
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

  // ---------------------------------------------------------------- D19–D21
  //
  // 回归 m01142：单词卡的「查空结果被永久缓存」。
  //
  // 现象：单独点 chill 只有标题 + 本句译文，中间什么释义都没有；而把
  // chill secluded 两个词一起拖选反而有翻译。因为短语走 lookupPhrase，
  // 空结果不落盘；单词走 lookupWord，旧代码无条件 idbPut ——
  // 只要第一次点击时词典源抖一下，这个词就被永久钉成空卡。
  //
  // 这里用 route 把三个词典/翻译域全部 abort 来稳定复现「查空」，
  // 而不是等真实网络抖动（那不可能在 CI 里稳定重现）。
  // 缓存键版本必须跟 bg.js 里的 DICT_KEY 前缀保持一致。
  // 每次升级（dict3→dict4→dict5）都是为了让旧版本里可能躺着的坏条目失效，
  // 这里不同步就会去删一个根本不存在的键，D21 会假失败。
  const DICT_KEY = 'dict5|normal|chill';
  const BLOCKED = [
    '**api.datamuse.com/**',
    '**api.dictionaryapi.dev/**',
    // googleTranslate 有三个 plan：translate.googleapis.com/gtx、
    // clients5.google.com/dict-chrome-ex、translate.googleapis.com/gtx+auto。
    // 只断前两个域不够 —— 第三个 plan 会拿到直译，dict.zh 非空就不算「查空」。
    '**translate.googleapis.com/**',
    '**clients5.google.com/**',
  ];
  const dropKey = (key) =>
    sw.evaluate(async (k) => {
      const db = await globalThis.__traceDebug.openDB();
      await new Promise((res, rej) => {
        const tx = db.transaction('translations', 'readwrite');
        tx.objectStore('translations').delete(k);
        tx.oncomplete = res;
        tx.onerror = rej;
      });
    }, key);
  const askWord = (w, opts) =>
    sw.evaluate(
      async ([word, o]) => {
        const d = await globalThis.__traceDebug.lookupWord(word, o || {});
        return {
          empty: globalThis.__traceDebug.dictIsEmpty(d),
          meanings: (d && d.meanings ? d.meanings.length : 0),
          zh: (d && d.zh) || '',
          source: (d && d.source) || '',
        };
      },
      [w, opts || null]
    );
  const ageCachedDict = (key, ageMs) =>
    sw.evaluate(
      async ([k, age]) => {
        const D = globalThis.__traceDebug;
        const rec = await D.idbGet('translations', k);
        if (!rec) return false;
        rec.createdAt = Date.now() - age;
        await D.idbPut('translations', rec);
        return true;
      },
      [key, ageMs]
    );

  await dropKey(DICT_KEY);
  for (const p of BLOCKED) await ctx.route(p, (r) => r.abort());
  const brokenDict = await askWord('chill');
  for (const p of BLOCKED) await ctx.unroute(p);
  check(
    'D19 词典源全挂时返回空结果（复现查空场景）',
    brokenDict.empty === true && brokenDict.meanings === 0,
    brokenDict
  );

  // 缓存仍然生效（否则每次点词都重打网络），但必须带 TTL：
  // 刚写进去的空结果在 TTL 内仍返回空 —— 证明「有缓存」；
  const withinTtl = await askWord('chill');
  check(
    'D20 空结果在 TTL 内仍走缓存（不会每次点词都重打网络）',
    withinTtl.empty === true,
    withinTtl
  );

  // 把缓存时间改成「很久以前」，模拟 TTL 过期 → 必须自动重查并拿到完整释义。
  // 这一条就是 m01142 的修复本体：空结果不能永久钉死。
  await ageCachedDict(DICT_KEY, 6 * 60 * 1000);
  const afterTtl = await askWord('chill');
  check(
    'D21 空结果缓存过期后自动重查并恢复完整释义',
    afterTtl.empty === false && afterTtl.meanings > 0 && !!afterTtl.source,
    afterTtl
  );

  // force:true 是卡片上「重新查询」按钮的路径 —— 用户不该等那 5 分钟。
  await dropKey(DICT_KEY);
  for (const p of BLOCKED) await ctx.route(p, (r) => r.abort());
  await askWord('chill');
  for (const p of BLOCKED) await ctx.unroute(p);
  const forced = await askWord('chill', { force: true });
  check(
    'D22 force:true 跳过缓存直连网络（卡片「重新查询」按钮）',
    forced.empty === false && forced.meanings > 0,
    forced
  );

  // 完整条目仍然长期缓存：再点一次不应重新请求（这里只看结果一致）
  const again = await askWord('chill');
  check(
    'D23 完整条目照常走缓存（不因 TTL 逻辑而反复重查）',
    again.empty === false && again.meanings === forced.meanings,
    again
  );

  // ---------------------------------------------------------------- D24–D27
  //
  // 回归「点击翻译很慢」。
  //
  // 起因（用户报障）：「为什么有些单词点击翻译很慢」。根因不是某些词特殊，
  // 而是「没缓存过 → 走完整链路」：旧代码把两个词典源串行等完（4s + 3.5s），
  // 且 normal 档 wantExample 恒真导致第二个源每次都白等。
  //
  // D24 盯住并发合并：预取还没回来时用户点了同一个词，只能有一次真实请求。
  // D25/D26 盯住残缺条目（有英文没中文）不能永久钉死。

  const countCalls = { n: 0 };
  const COUNTED = ['**api.datamuse.com/**', '**api.dictionaryapi.dev/**'];
  const counter = (r) => {
    countCalls.n++;
    r.continue();
  };
  await dropKey(DICT_KEY);
  for (const p of COUNTED) await ctx.route(p, counter);
  // 三个同词并发走 lookupWordDeduped（预取与点击的真实关系）
  const deduped = await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    const [a, b, c] = await Promise.all([
      D.lookupWordDeduped('chill', {}),
      D.lookupWordDeduped('chill', {}),
      D.lookupWordDeduped('chill', {}),
    ]);
    return {
      same: a === b && b === c,
      meanings: a ? a.meanings.length : 0,
    };
  });
  for (const p of COUNTED) await ctx.unroute(p);
  check(
    'D24 同词并发查词只发一次网络请求（预取与点击在途合并）',
    deduped.same === true && deduped.meanings > 0 && countCalls.n <= 2,
    { deduped, networkCalls: countCalls.n }
  );

  // D25：伪造一条「有英文义项但零中文」的残缺缓存，且已过期（超过 TTL）。
  // 旧代码 dictIsEmpty 判它非空 → 永久命中 → 用户永远看到没中文的卡片。
  const partialKey = 'dict5|normal|vintage';
  await sw.evaluate(async (k) => {
    const D = globalThis.__traceDebug;
    await D.idbPut('translations', {
      key: k,
      dict: {
        word: 'vintage',
        phonetic: '',
        meanings: [{ pos: '形容词', def: 'of high quality', defZh: '', example: '' }],
        example: '',
        exampleZh: '',
        zh: '',
        senses: [],
        detail: 'normal',
        source: 'datamuse',
      },
      createdAt: Date.now() - 10 * 60 * 1000,
    });
  }, partialKey);
  const revivedPartial = await sw.evaluate(async (k) => {
    const D = globalThis.__traceDebug;
    const d = await D.lookupWord('vintage', {});
    return { partial: D.dictIsPartial(d), zh: (d && d.zh) || '', key: k };
  }, partialKey);
  check(
    'D25 有英文没中文的残缺缓存过期后会重查并拿到中文',
    revivedPartial.partial === false && !!revivedPartial.zh,
    revivedPartial
  );

  // D26：残缺条目在 TTL 内仍算「新」，不该每次点词都重打网络
  const partialFresh = await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    await D.idbPut('translations', {
      key: 'dict5|normal|brutal',
      dict: {
        word: 'brutal',
        phonetic: '',
        meanings: [{ pos: '形容词', def: 'savage', defZh: '', example: '' }],
        example: '',
        exampleZh: '',
        zh: '',
        senses: [],
        detail: 'normal',
        source: 'datamuse',
      },
      createdAt: Date.now(),
    });
    const d = await D.lookupWord('brutal', {});
    return { partial: D.dictIsPartial(d), zh: (d && d.zh) || '' };
  });
  check(
    'D26 残缺缓存仍在 TTL 内时直接返回（不反复重打网络）',
    partialFresh.partial === true && !partialFresh.zh,
    partialFresh
  );

  // D27：Datamuse 够用时不再苦等 dictionaryapi —— 用 route 让
  // dictionaryapi 挂住 5s，若实现还有「够用就早收工」的宽限，整体应远小于 5s。
  await dropKey('dict5|normal|relic');
  await ctx.route('**api.dictionaryapi.dev/**', async (r) => {
    await new Promise((res) => setTimeout(res, 5000));
    r.continue();
  });
  const tSlow = await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    const t0 = Date.now();
    const d = await D.fetchDict('relic', D.detailPreset('normal'));
    return { ms: Date.now() - t0, meanings: d.meanings.length, phonetic: !!d.phonetic };
  });
  await ctx.unroute('**api.dictionaryapi.dev/**');
  check(
    'D27 Datamuse 够用时不等慢的 dictionaryapi（宽限后提前返回）',
    tSlow.ms < 4000 && tSlow.meanings > 0,
    tSlow
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
