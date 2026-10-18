/**
 * 短语划词 + 大模型引擎专项测试
 *
 * 验证五件事：
 *   1. 选中多词短语（pay your fair）时给的是「整段释义」而不是逐词硬拼
 *   2. 单点一个单词（fair）时仍走原单词路径，显示词典义
 *   3. 短语能收藏进生词本，且记录带 kind='phrase' 与逐词对照
 *   4. 收藏后同一短语在别处出现时整段高亮（连续多词，不是碎块）
 *   5. 大模型引擎能配置、能翻译、失败时自动降级到 Google
 *
 * 大模型用本地假服务（route 拦截），因为它需要真实 API key 才能测；
 * 假服务同时用来验证「配置错误要降级而不是白屏」。
 *
 * 用法: node test-phrase.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const fx = require('./mock/fixtures');
const { copyExtWithHost } = require('./lib/perm-ext');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// 大模型那几项要打 https://llm.test，而 llm.test 是任意域名，manifest 里静态声明不了。
// 若靠 chrome.permissions.request() 现场申请，Chrome 会弹**原生**权限气泡 ——
// 它不在 DOM 里，Playwright 点不到，request() 的 promise 永远挂着（曾把本测试
// 拖成 600s 超时、一行 RESULT 都没有）。所以复制一份扩展、把 llm.test 预置进
// host_permissions（等价于用户此前已点过允许），详见 lib/perm-ext.js。
const EXT = copyExtWithHost('https://llm.test', path.join(__dirname, '.perm-ext-phrase'));
const ORIGIN = 'https://www.youtube.com';
const WATCH = `${ORIGIN}/watch?v=${fx.VIDEO_ID}`;

// 同一短语出现在两句里：第一句用来收藏，第二句验证「别处也高亮」
const PHRASE_CUES = [
  [0.0, 3.0, 'Walk up, pay your fair, go up and find your seat.'],
  [3.4, 3.0, 'You have to pay your fair before you board the plane.'],
  [6.8, 3.0, 'This seat is fair but the lounge is better.'],
];

const checks = {};
const detail = {};
function check(name, ok, extra) {
  checks[name] = !!ok;
  if (extra !== undefined) detail[name] = extra;
  console.log(`${ok ? '✓' : '✗'} ${name}`, extra === undefined ? '' : JSON.stringify(extra));
}

(async () => {
  const userDataDir = path.join(__dirname, '.chrome-phrase');
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

  const errors = [];
  ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(String(e))));

  // ---- 假大模型服务 ----
  // 用一个可切换的 mode：'ok' 正常回 JSON、'broken' 返回 500。
  // 后者用来验证「配置错/服务挂 → 自动降级 Google」而不是字幕变空白。
  let llmMode = 'ok';
  let llmHits = 0;
  let lastLlmBody = null;
  await ctx.route('https://llm.test/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/models')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          data: [{ id: 'fake-1' }, { id: 'fake-2' }],
        }),
      });
    }
    llmHits++;
    try {
      lastLlmBody = JSON.parse(route.request().postData() || '{}');
    } catch (_) {}
    if (llmMode === 'broken') {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ error: { message: 'quota exceeded' } }),
      });
    }
    // 从请求里挖出短语，回一个可辨识的 JSON 释义
    const userMsg = (lastLlmBody?.messages || []).find((m) => m.role === 'user')?.content || '';
    const m = userMsg.match(/短语：(.+)/);
    const phrase = (m ? m[1] : 'phrase').trim();
    const content = JSON.stringify({
      gloss: `【LLM】${phrase} 的语境义`,
      note: '字幕里 fair 可能是 fare 的误听',
    });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        choices: [{ message: { role: 'assistant', content } }],
      }),
    });
  });

  // ---- 假 YouTube ----
  await ctx.route('https://www.youtube.com/**', async (route) => {
    const url = route.request().url();
    const u = new URL(url);
    if (u.pathname === '/watch') {
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: fx.pageHtml(fx.VIDEO_ID, { cues: PHRASE_CUES }),
      });
    }
    if (u.pathname === '/youtubei/v1/player') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': ORIGIN },
        body: JSON.stringify({ playerResponse: fx.playerResponse(fx.VIDEO_ID) }),
      });
    }
    if (u.pathname === '/api/timedtext') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': ORIGIN },
        body: fx.json3Body(PHRASE_CUES),
      });
    }
    return route.fulfill({ status: 204, body: '' });
  });

  // Google 翻译走真实网络（短语释义的降级路径必须是真链路）

  // 等 service worker
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  console.log('SW:', sw.url());

  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));

  // 清库，避免上一轮残留
  await sw.evaluate(async () => {
    const db = await globalThis.__traceDebug.openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(['words', 'translations'], 'readwrite');
      tx.objectStore('words').clear();
      tx.objectStore('translations').clear();
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  });

  await page.goto(WATCH, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => !!document.querySelector('#trace-sub-overlay .trace-sub-orig'),
    { timeout: 20000 }
  );
  await page.evaluate(() => window.__mockPause && window.__mockPause());
  await page.waitForTimeout(900);

  // ---- L1/L2：短语与单词两条路径 ----
  // 先点 fair（单个词）：应显示词典义，不是短语卡
  const fairSel = '#trace-sub-overlay .trace-sub-orig .trace-word';
  const fairIdx = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#trace-sub-overlay .trace-sub-orig .trace-word')];
    return els.findIndex((e) => (e.textContent || '').toLowerCase() === 'fair');
  });
  if (fairIdx < 0) {
    console.log('RESULT: FAIL (字幕里没找到 fair 这个词，夹具或分句有问题)');
    process.exit(1);
  }
  await page.locator(fairSel).nth(fairIdx).click();
  await page.waitForTimeout(1600);
  const wordCard = await page.evaluate(() => {
    const pop = document.querySelector('#trace-word-popup');
    if (!pop || pop.classList.contains('trace-hidden')) return null;
    return {
      title: pop.querySelector('.trace-pop-word')?.textContent?.trim() || '',
      hasPhraseGloss: !!pop.querySelector('.trace-pop-phrase-gloss'),
      hasSenses: !!pop.querySelector('.trace-pop-senses'),
      bodyText: (pop.querySelector('.trace-pop-body')?.textContent || '').trim().slice(0, 120),
    };
  });
  check('L1 点单个词走单词卡（不是短语卡）', !!wordCard && !wordCard.hasPhraseGloss, wordCard);
  check(
    'L2 单词卡标题是这个词本身',
    !!wordCard && wordCard.title.toLowerCase() === 'fair',
    wordCard && wordCard.title
  );

  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const pop = document.querySelector('#trace-word-popup');
    if (pop) pop.classList.add('trace-hidden');
  });

  // ---- L2b~L2e：真实鼠标拖选短语 ----
  // 用户报障：「把两个单词一起选中（例如 dive in）后点击查询，结果仍然只查其中一个单词」。
  //
  // 旧代码只挂了 click 监听。实测（真实 Chrome）从 "pay" 拖到 "your"，mouseup 之后
  // 浏览器派发的 click 目标是**共同祖先**而不是起始词，所以 closest('.trace-word')
  // 取不到任何词，直接 return —— 什么也不弹，短语分支（data-p）永远走不到。
  //
  // 这条用真实 mouse.down/move/up 拖选，不能用 click()，否则测不到真实交互。
  {
    const wordBox = async (text, nth = 0) =>
      page.evaluate(
        ({ text, nth }) => {
          const els = [...document.querySelectorAll('#trace-sub-overlay .trace-sub-orig .trace-word')]
            .filter((e) => (e.textContent || '').toLowerCase() === text);
          const el = els[nth];
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        },
        { text, nth }
      );

    // 隐藏已有的卡片，确保下面看到的是新弹的
    await page.evaluate(() => {
      const pop = document.querySelector('#trace-word-popup');
      if (pop) pop.classList.add('trace-hidden');
    });

    const payBox = await wordBox('pay');
    const yourBox = await wordBox('your');
    check('L2b 字幕里能定位到 pay / your 两个词', !!payBox && !!yourBox, { payBox, yourBox });

    if (payBox && yourBox) {
      // 从 pay 左侧拖到 your 右侧 —— 真实的跨 span 拖选
      await page.mouse.move(payBox.x + 2, payBox.y + payBox.h / 2);
      await page.mouse.down();
      await page.mouse.move(yourBox.x + yourBox.w - 2, yourBox.y + yourBox.h / 2, { steps: 14 });
      await page.mouse.up();
      await page.waitForTimeout(1800);

      const dragSel = await page.evaluate(() => String(getSelection() || ''));
      check('L2c 拖选后浏览器选区是 pay your', /^pay\s+your$/i.test(dragSel.trim()), dragSel);

      const dragCard = await page.evaluate(() => {
        const pop = document.querySelector('#trace-word-popup');
        if (!pop || pop.classList.contains('trace-hidden')) return null;
        return {
          title: pop.querySelector('.trace-pop-word')?.textContent?.trim() || '',
          gloss: pop.querySelector('.trace-pop-phrase-gloss')?.textContent?.trim() || '',
          hasPhraseCard: !!pop.querySelector('.trace-pop-phrase-gloss'),
        };
      });
      check('L2d 拖选短语会弹出短语卡（不是单词卡）', !!dragCard && dragCard.hasPhraseCard, dragCard);
      check(
        'L2e 短语卡标题是整段 pay your（不是单个词）',
        !!dragCard && /^pay\s+your$/i.test(dragCard.title),
        dragCard && dragCard.title
      );

      // 收起卡片，避免影响后面的断言
      await page.evaluate(() => {
        const pop = document.querySelector('#trace-word-popup');
        if (pop) pop.classList.add('trace-hidden');
        getSelection()?.removeAllRanges();
      });
    }
  }

  // ---- L3/L4：把三个词都收藏成短语 ----
  // 直接走后台 API 造数据（模拟"用户之前收藏过 pay your fair"），
  // 因为这里要验证的是「收藏后的高亮与词库展示」，不是划词交互本身
  // （划词交互已由上面的 L2b~L2e 用真实拖选覆盖）。
  await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    await D.addWordNotify({
      word: 'pay your fair',
      kind: 'phrase',
      zh: '付钱',
      literal: '支付你的公平',
      source: 'llm',
      note: '字幕里 fair 可能是 fare 的误听',
      words: [
        { w: 'pay', zh: '支付' },
        { w: 'your', zh: '你的' },
        { w: 'fair', zh: '公平' },
      ],
      context: 'Walk up, pay your fair, go up and find your seat.',
      contextZh: '走上去，付钱，然后找到你的座位。',
      videoId: 'TESTID00001',
      time: 0.5,
    });
  });

  // 让内容脚本重新拉词表
  await page.evaluate(async () => {
    const tabs = await chrome?.tabs?.query?.({});
    return tabs;
  }).catch(() => {});
  await page.waitForTimeout(400);

  // ---- L5：短语整段高亮 ----
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => !!document.querySelector('#trace-sub-overlay .trace-sub-orig'),
    { timeout: 20000 }
  );
  await page.evaluate(() => window.__mockPause && window.__mockPause());
  await page.waitForTimeout(1200);

  const hl = await page.evaluate(() => {
    const ph = document.querySelector('#trace-sub-overlay .trace-phrase');
    if (!ph) return null;
    return {
      text: (ph.textContent || '').trim(),
      dataP: ph.dataset.p || '',
      wordCount: ph.querySelectorAll('.trace-word').length,
      innerSaved: ph.querySelectorAll('.trace-word.trace-in-phrase').length,
    };
  });
  check('L5 短语在字幕里整段高亮', !!hl && hl.wordCount === 3, hl);
  check(
    'L6 高亮的是 pay your fair 三个词',
    !!hl && /pay\s+your\s+fair/i.test(hl.text),
    hl && hl.text
  );

  // ---- L7：点短语内部任意词 → 短语卡 ----
  const phraseWordIdx = await page.evaluate(() => {
    const ph = document.querySelector('#trace-sub-overlay .trace-phrase');
    if (!ph) return -1;
    const els = [...document.querySelectorAll('#trace-sub-overlay .trace-sub-orig .trace-word')];
    return els.indexOf(ph.querySelector('.trace-word'));
  });
  await page.locator(fairSel).nth(phraseWordIdx).click();
  await page.waitForTimeout(2000);

  const phraseCard = await page.evaluate(() => {
    const pop = document.querySelector('#trace-word-popup');
    if (!pop || pop.classList.contains('trace-hidden')) return null;
    return {
      title: pop.querySelector('.trace-pop-word')?.textContent?.trim() || '',
      gloss: pop.querySelector('.trace-pop-phrase-gloss')?.textContent?.trim() || '',
      warn: pop.querySelector('.trace-pop-phrase-warn')?.textContent?.trim() || '',
      src: pop.querySelector('.trace-pop-src')?.textContent?.trim() || '',
      note: pop.querySelector('.trace-pop-phrase-note')?.textContent?.trim() || '',
      wordRows: pop.querySelectorAll('.trace-pop-words li').length,
      btnText: pop.querySelector('[data-act="add"], [data-act="remove"]')?.textContent?.trim() || '',
    };
  });
  check('L7 点短语内部词打开短语卡', !!phraseCard && !!phraseCard.gloss, phraseCard);
  // 这条短语没有大模型配置，走 Google 短语整体翻译。实测 Google 给的
  // 「支付你的公平」就是逐词拼接 —— 所以卡片的正确行为不是"给个更好的译文"
  // （它给不出来），而是**明确告知用户这句是按词拼的**，别当成短语真义。
  check(
    'L8 逐词拼接时卡片给出警示而不是假装准确',
    !!phraseCard && /按词拼/.test(phraseCard.warn || ''),
    { warn: phraseCard && phraseCard.warn, gloss: phraseCard && phraseCard.gloss }
  );
  check(
    'L9 短语卡有逐词对照',
    !!phraseCard && phraseCard.wordRows === 3,
    phraseCard && phraseCard.wordRows
  );
  check(
    'L10 已收藏的短语显示「已在生词本」',
    !!phraseCard && /已在生词本/.test(phraseCard.btnText),
    phraseCard && phraseCard.btnText
  );

  // 短语卡比单词卡高一大截，早期只按「词的上面」摆放，直接压住字幕 ——
  // 而当时没有断言，靠人眼看截图才发现。这条盯住它。
  const phraseGeom = await page.evaluate(() => {
    const pop = document.querySelector('#trace-word-popup');
    const box = document.querySelector('.trace-sub-box');
    if (!pop || !box || pop.classList.contains('trace-hidden')) return null;
    const p = pop.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const ovW = Math.min(p.right, b.right) - Math.max(p.left, b.left);
    const ovH = Math.min(p.bottom, b.bottom) - Math.max(p.top, b.top);
    return {
      pop: [Math.round(p.x), Math.round(p.y), Math.round(p.width), Math.round(p.height)],
      box: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)],
      overlapPx: Math.round(Math.min(ovW, ovH)),
      insideViewport: p.top >= 0 && p.bottom <= window.innerHeight + 1,
      bodyScrollable: (() => {
        const bd = pop.querySelector('.trace-pop-body');
        return bd ? bd.scrollHeight > bd.clientHeight + 1 : false;
      })(),
    };
  });
  check(
    'L10b 短语卡不遮挡字幕框',
    !!phraseGeom && phraseGeom.overlapPx <= 2,
    phraseGeom
  );
  check('L10c 短语卡在视口内', !!phraseGeom && phraseGeom.insideViewport, phraseGeom);

  // ---- L11：生词本里短语可区分查看 ----
  const board = await ctx.newPage();
  board.on('pageerror', (e) => errors.push(String(e)));
  await board.goto(`chrome-extension://${extId}/wordbook.html`, {
    waitUntil: 'domcontentloaded',
  });
  await board.waitForTimeout(1200);
  const boardState = await board.evaluate(() => ({
    phraseCount: document.querySelector('#cPhrase')?.textContent?.trim() || '',
    hasPhraseChip: !!document.querySelector('[data-f="phrase"]'),
    hasPhraseView: !!document.querySelector('[data-view="phrase"]'),
  }));
  check(
    'L11 词库看板有短语分类入口',
    boardState.hasPhraseChip && boardState.hasPhraseView,
    boardState
  );
  check('L12 短语计数正确', boardState.phraseCount === '1', boardState.phraseCount);

  await board.locator('[data-f="phrase"]').click();
  await board.waitForTimeout(400);
  const boardRows = await board.evaluate(() => {
    const rows = [...document.querySelectorAll('#rows .wrow')];
    return {
      count: rows.length,
      isPhraseRow: rows[0]?.classList.contains('wrow-phrase') || false,
      text: rows[0]?.querySelector('.w-txt')?.textContent?.trim() || '',
      meta: rows[0]?.querySelector('.w-phon')?.textContent?.trim() || '',
    };
  });
  check('L13 短语视图只列短语', boardRows.count === 1 && boardRows.isPhraseRow, boardRows);
  check(
    'L14 短语行用引号徽标 + 来源标签',
    boardRows.meta === '大模型',
    boardRows.meta
  );

  // 抽屉里应看到逐词对照
  await board.locator('#rows .wrow').first().click();
  await board.waitForTimeout(500);
  const drawer = await board.evaluate(() => {
    const b = document.querySelector('#dwBody');
    return {
      open: document.querySelector('#drawer')?.classList.contains('open') || false,
      zh: document.querySelector('#dwBody .dw-zh')?.textContent?.trim() || '',
      wordRows: b?.querySelectorAll('.dw-wrow').length || 0,
      note: b?.querySelector('.dw-note')?.textContent?.trim() || '',
    };
  });
  check('L15 短语抽屉显示逐词对照', drawer.open && drawer.wordRows === 3, drawer);
  check('L16 短语抽屉显示误听提示', /fare/.test(drawer.note), drawer.note);

  // ---- L17~L20：大模型引擎 ----
  // 配置指向本地假服务。注意 host permission 必须真的授予：bg.js 的 llmChat /
  // llmListModels 会先检查 chrome.permissions.contains，没有权限直接抛
  // 「未授权访问该 API 地址」，根本不会走到 fetch（这是 bug 17 的修复）。
  //
  // 权限已经由文件头的 copyExtWithHost() 预置进 manifest 的 host_permissions，
  // 等价于「用户此前已允许」。**不要**在这里再调 chrome.permissions.request()：
  // 那会弹原生气泡，Playwright 点不到，promise 永远挂着 → 整条 await 卡死
  // （历史事故：600s 超时、没有 RESULT 行）。也不要 permissions.remove()，
  // 预置权限一旦移除就再也拿不回来（request 又会去弹那个点不到的框）。
  {
    const granted = await sw.evaluate(() =>
      chrome.permissions.contains({ origins: ['https://llm.test/*'] })
    );
    check('L16b 大模型域名权限已预置（否则走不到 fetch）', granted === true, { granted });
  }

  await sw.evaluate(async () => {
    await globalThis.__traceDebug.setSettings({
      llmBaseUrl: 'https://llm.test/v1',
      llmApiKey: 'sk-test',
      llmModel: 'fake-1',
      engine: 'llm',
    });
  });

  const models = await sw.evaluate(async () => {
    try {
      return { ok: true, data: await globalThis.__traceDebug.llmListModels() };
    } catch (e) {
      return { ok: false, err: String(e && e.message) };
    }
  });
  check(
    'L17 能拉取模型列表',
    models.ok && Array.isArray(models.data) && models.data.includes('fake-1'),
    models
  );

  const llmTrans = await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    return await D.translateBatch(['Pay your fair now.', 'Have a nice day.'], 'en', 'zh-CN');
  });
  check(
    'L18 大模型引擎能翻出译文',
    Array.isArray(llmTrans) && llmTrans.length === 2 && llmTrans.every((s) => s && s.trim()),
    llmTrans
  );
  check(
    'L19 请求里带了模型名与 system 提示',
    !!lastLlmBody && lastLlmBody.model === 'fake-1' && Array.isArray(lastLlmBody.messages),
    lastLlmBody && { model: lastLlmBody.model, n: lastLlmBody.messages?.length }
  );

  // 服务挂掉时必须降级，不能白屏
  llmMode = 'broken';
  const before = llmHits;
  const fallback = await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    return await D.translateBatch(['Something completely new here.'], 'en', 'zh-CN');
  });
  check(
    'L20 大模型失败时自动降级（仍有译文）',
    Array.isArray(fallback) && fallback[0] && fallback[0].trim().length > 0,
    { hits: llmHits - before, out: fallback }
  );

  await page.waitForTimeout(300);
  check('L21 无 JS 错误', errors.length === 0, errors.slice(0, 3));

  await page.screenshot({ path: path.join(__dirname, 'shot-phrase.png') });
  await board.screenshot({ path: path.join(__dirname, 'shot-phrase-board.png') });

  const failed = Object.keys(checks).filter((k) => !checks[k]);
  console.log('');
  if (failed.length) {
    console.log('RESULT: FAIL (' + failed.join(', ') + ')');
  } else {
    console.log(
      'RESULT: PASS（短语整段释义 + 短语生词本 + 整段高亮 + 大模型引擎与降级）'
    );
  }
  await ctx.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('RESULT: FAIL (exception)', e);
  process.exit(1);
});
