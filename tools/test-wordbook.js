/**
 * 词库看板（wordbook.html）回归测试
 *
 * 覆盖：
 *   A. 种子数据（不同时间/状态）能正确渲染 KPI、状态环、柱状图、词表
 *   B. 侧栏/筛选芯片/搜索能过滤词表
 *   C. 点行打开详情抽屉，抽屉内容正确
 *   D. 「标记复习」改变状态（新词 → 记忆中），KPI 跟着变
 *   E. 删除单词后总数减少
 *   F. 日/周/月切换后柱状图桶数量变化（30 / 12 / 12）
 *
 * 注意：wordbook.html 是扩展页面（chrome-extension://），
 * 与 content script 不同，它的 JS 跑在页面主世界，page.evaluate 可以直接访问 DOM。
 */
const path = require('path');
const { chromium } = require('playwright');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');

const DAY = 86400000;

(async () => {
  const ctx = await chromium.launchPersistentContext('.chrome-wordbook', {
    headless: false,
    executablePath: CHROME,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--mute-audio', ...require('./lib/proxy').proxyArgs()],
    viewport: { width: 1440, height: 940 },
  });

  // 等 service worker 起来
  let sw = ctx.serviceWorkers()[0];
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 250));
    sw = ctx.serviceWorkers()[0];
  }
  if (!sw) throw new Error('service worker 未启动');
  console.log('SW:', sw.url());

  // ---------------------------------------------------------- 种子数据
  // 造出「今天 3 个 / 昨天 2 个 / 5 天前 2 个 / 40 天前 1 个」，
  // 这样日视图（30 天）能看到 8 个、月视图能看到 9 个，能验证分桶边界。
  const seeded = await sw.evaluate(async () => {
    const D = 86400000;
    const now = Date.now();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const t0 = today.getTime();

    // 每次跑测试都从干净词库开始。
    // 坑：这个测试用固定 profile 目录（.chrome-wordbook），IndexedDB 会跨次保留，
    // 而 addWord 会继承已有记录的 reviewCount —— 不清库的话 reviewCount 会一轮轮累加，
    // 「新词点一次复习 → 记忆中」的断言在第三轮就会变成「已记住」而误报 FAIL。
    {
      const db = await globalThis.__traceDebug.openDB();
      await new Promise((res, rej) => {
        const tx = db.transaction('words', 'readwrite');
        tx.objectStore('words').clear();
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    }

    const items = [
      { word: 'pipeline', zh: '流水线', phonetic: '/ˈpaɪplaɪn/', at: t0 + 1000, status: 'new', vid: 'TESTID00001' },
      { word: 'subtitle', zh: '字幕', phonetic: '/ˈsʌbtaɪtl/', at: t0 + 2000, status: 'new', vid: 'TESTID00001' },
      { word: 'overlay', zh: '覆盖层', phonetic: '/ˈəʊvəleɪ/', at: t0 + 3000, status: 'new', vid: 'TESTID00001' },
      { word: 'translate', zh: '翻译', phonetic: '/trænsˈleɪt/', at: t0 - 1 * D + 1000, status: 'learning', vid: 'TESTID00001' },
      { word: 'segment', zh: '片段', phonetic: '/ˈseɡmənt/', at: t0 - 1 * D + 5000, status: 'new', vid: 'TESTID00001' },
      { word: 'caption', zh: '字幕轨', phonetic: '/ˈkæpʃn/', at: t0 - 5 * D + 1000, status: 'learned', vid: 'TESTID00001' },
      { word: 'bilingual', zh: '双语的', phonetic: '/ˌbaɪˈlɪŋɡwəl/', at: t0 - 5 * D + 5000, status: 'learning', vid: 'TESTID00001' },
      { word: 'highlight', zh: '高亮', phonetic: '/ˈhaɪlaɪt/', at: t0 - 40 * D, status: 'learned', vid: 'TESTID00001' },
    ];

    const out = [];
    for (const it of items) {
      const rec = await globalThis.__traceDebug.addWordNotify({
        word: it.word,
        zh: it.zh,
        phonetic: it.phonetic,
        context: `This is a context sentence with ${it.word} inside it.`,
        contextZh: `这是一个包含 ${it.zh} 的上下文句子。`,
        videoTitle: 'Mock Video',
        videoId: it.vid,
        time: 12,
        meanings: [{ pos: 'n.', def: `meaning of ${it.word}` }],
      });
      // 覆盖 createdAt / status（addWord 会保留已有记录的时间，这里直接改库）
      const db = await globalThis.__traceDebug.openDB();
      await new Promise((res, rej) => {
        const tx = db.transaction('words', 'readwrite');
        const st = tx.objectStore('words');
        const cur = st.get(it.word);
        cur.onsuccess = () => {
          const v = cur.result;
          v.createdAt = it.at;
          v.status = it.status;
          if (it.status === 'learned') {
            v.reviewCount = 3;
            v.lastReview = it.at + D;
          } else if (it.status === 'learning') {
            v.reviewCount = 1;
            v.lastReview = it.at + D;
          }
          st.put(v);
        };
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      out.push(rec.word);
    }
    return out;
  });
  console.log('seeded:', seeded.join(', '));

  // ---------------------------------------------------------- 打开看板
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message || e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
  });

  await page.goto(`chrome-extension://${extId}/wordbook.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.wrow', { timeout: 15000 });
  await page.waitForTimeout(700);

  const out = {};

  // ---------------------------------------------------------- A. 首屏渲染
  out.first = await page.evaluate(() => {
    const num = (id) => Number(document.getElementById(id).textContent.trim());
    const bars = document.querySelectorAll('#bars .bar');
    return {
      kTotal: num('kTotal'),
      kLearned: num('kLearned'),
      kLearning: num('kLearning'),
      kToday: num('kToday'),
      rows: document.querySelectorAll('.wrow').length,
      barCount: bars.length,
      barFilled: [...bars].filter((b) => !b.classList.contains('bar-empty')).length,
      donutBg: (document.getElementById('donut').style.background || '').includes('conic-gradient'),
      donutNum: Number(document.getElementById('donutNum').textContent.trim()),
      legendRows: document.querySelectorAll('#legend .lg').length,
      cAll: Number(document.getElementById('cAll').textContent.trim()),
      subLine: document.getElementById('subLine').textContent.trim(),
      chartSub: document.getElementById('chartSub').textContent.trim(),
      sparks: ['spTotal', 'spLearned', 'spLearning', 'spToday'].map((id) => {
        const svg = document.getElementById(id);
        return svg ? svg.querySelectorAll('path').length : 0;
      }),
    };
  });

  await page.screenshot({ path: 'shot-wordbook.png' });

  // ---------------------------------------------------------- B. 过滤与搜索
  await page.click('#sideNav button[data-view="learned"]');
  await page.waitForTimeout(250);
  out.learnedView = await page.evaluate(() => ({
    rows: document.querySelectorAll('.wrow').length,
    words: [...document.querySelectorAll('.w-txt')].map((e) => e.textContent.trim()).sort(),
  }));

  await page.click('#sideNav button[data-view="all"]');
  await page.waitForTimeout(200);
  await page.fill('#q', 'trans');
  await page.waitForTimeout(250);
  out.search = await page.evaluate(() => ({
    rows: document.querySelectorAll('.wrow').length,
    words: [...document.querySelectorAll('.w-txt')].map((e) => e.textContent.trim()),
  }));
  await page.fill('#q', '');
  await page.waitForTimeout(250);

  // 芯片筛选
  await page.click('.chip[data-f="learning"]');
  await page.waitForTimeout(250);
  out.chipLearning = await page.evaluate(() => document.querySelectorAll('.wrow').length);
  await page.click('.chip[data-f="all"]');
  await page.waitForTimeout(250);

  // ---------------------------------------------------------- C. 详情抽屉
  await page.click('.wrow[data-w="pipeline"]');
  await page.waitForTimeout(450);
  out.drawer = await page.evaluate(() => {
    const d = document.getElementById('drawer');
    return {
      open: d.classList.contains('open'),
      word: document.getElementById('dwWord').textContent.trim(),
      phon: document.getElementById('dwPhon').textContent.trim(),
      bodyText: document.getElementById('dwBody').innerText.replace(/\s+/g, ' ').trim(),
      hasQuote: !!document.querySelector('#dwBody .dw-quote'),
      hasEm: !!document.querySelector('#dwBody .dw-quote em'),
      playEnabled: !document.getElementById('dwPlay').disabled,
    };
  });
  await page.screenshot({ path: 'shot-wordbook-drawer.png' });

  // ---------------------------------------------------------- D. 标记复习
  await page.click('#dwReview');
  await page.waitForTimeout(800);
  out.afterReview = await page.evaluate(() => {
    const num = (id) => Number(document.getElementById(id).textContent.trim());
    const row = document.querySelector('.wrow[data-w="pipeline"]');
    return {
      kLearning: num('kLearning'),
      pill: row ? row.querySelector('.pill').textContent.trim() : null,
      drawerOpen: document.getElementById('drawer').classList.contains('open'),
    };
  });

  await page.click('#dwClose');
  await page.waitForTimeout(350);

  // ---------------------------------------------------------- F. 时间粒度
  out.gran = {};
  for (const g of ['day', 'week', 'month']) {
    await page.click(`#gran button[data-g="${g}"]`);
    await page.waitForTimeout(250);
    out.gran[g] = await page.evaluate(() => ({
      bars: document.querySelectorAll('#bars .bar').length,
      sub: document.getElementById('chartSub').textContent.trim(),
    }));
  }

  // ---------------------------------------------------------- E. 删除
  const before = await page.evaluate(() => Number(document.getElementById('kTotal').textContent.trim()));
  await page.evaluate(() => {
    const row = document.querySelector('.wrow[data-w="overlay"]');
    row.querySelector('button[data-act="del"]').click();
  });
  await page.waitForTimeout(900);
  out.afterDelete = await page.evaluate(() => ({
    kTotal: Number(document.getElementById('kTotal').textContent.trim()),
    hasOverlay: !!document.querySelector('.wrow[data-w="overlay"]'),
    rows: document.querySelectorAll('.wrow').length,
  }));
  out.deleteDelta = before - out.afterDelete.kTotal;

  // ---------------------------------------------------------- 判定
  const firstOk =
    out.first.kTotal === 8 &&
    out.first.rows === 8 &&
    out.first.donutNum === 8 &&
    out.first.donutBg === true &&
    out.first.legendRows === 3 &&
    out.first.cAll === 8 &&
    out.first.barCount === 30 &&          // 日视图 30 桶
    out.first.sparks.every((n) => n >= 2); // 每条折线至少 面积 + 线

  // barFilled 期望值：今天(1) + 昨天(1) + 5天前(1) = 3；40 天前不在 30 天窗口。
  // 注意桶边界是「本地零点 + i 天」，所以种子时间必须落在桶内正偏移处，
  // 若写成 t0 - 1*D 正好等于昨天桶的起点，会被前一个桶吃掉。
  const barFilledOk = out.first.barFilled === 3;

  const kpiOk =
    out.first.kLearned === 2 &&   // caption, highlight
    out.first.kLearning === 2 &&  // translate, bilingual
    out.first.kToday === 3;

  const learnedOk =
    out.learnedView.rows === 2 &&
    out.learnedView.words.join(',') === 'caption,highlight';

  const searchOk = out.search.rows === 1 && out.search.words[0] === 'translate';
  const chipOk = out.chipLearning === 2;

  const drawerOk =
    out.drawer.open &&
    out.drawer.word === 'pipeline' &&
    out.drawer.phon === '/ˈpaɪplaɪn/' &&
    out.drawer.bodyText.includes('流水线') &&
    out.drawer.hasQuote &&
    out.drawer.hasEm &&
    out.drawer.playEnabled;

  const reviewOk =
    out.afterReview.pill === '记忆中' &&
    out.afterReview.kLearning === 3;   // 原来 2 个 + pipeline 变 learning

  const granOk =
    out.gran.day.bars === 30 &&
    out.gran.week.bars === 12 &&
    out.gran.month.bars === 12;

  const deleteOk = out.deleteDelta === 1 && out.afterDelete.hasOverlay === false;
  const noErrors = errs.length === 0;

  console.log(JSON.stringify({
    first: out.first,
    learnedView: out.learnedView,
    search: out.search,
    chipLearning: out.chipLearning,
    drawer: out.drawer,
    afterReview: out.afterReview,
    gran: out.gran,
    afterDelete: out.afterDelete,
    deleteDelta: out.deleteDelta,
    errors: errs,
    checks: {
      firstOk,
      barFilledOk,
      kpiOk,
      learnedOk,
      searchOk,
      chipOk,
      drawerOk,
      reviewOk,
      granOk,
      deleteOk,
      noErrors,
    },
  }, null, 2));

  const ok =
    firstOk && barFilledOk && kpiOk && learnedOk && searchOk && chipOk &&
    drawerOk && reviewOk && granOk && deleteOk && noErrors;
  console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}（词库看板：KPI/状态环/柱状图/筛选/搜索/抽屉/复习/删除/粒度切换）`);

  await ctx.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

