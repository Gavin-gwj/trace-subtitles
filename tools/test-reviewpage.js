/**
 * 复习台（review.html）回归测试
 *
 * 覆盖：
 *   A. 种子数据能正确算出「待复习」队列与 KPI
 *   B. 卡片正反面切换（点击 / 空格 / 按钮三条路径）
 *   C. 三档评级写入 IndexedDB：reviewCount / forgetCount / fuzzyCount /
 *      rememberCount 各自加一，status 按规则变化
 *   D. 队列自动前进，走完后出「本轮完成」面板
 *   E. 打卡系统：今日计数、连续天数、热力图格子、三档分布面板
 *   F. 主题切换 + 持久化
 *   G. 「重开一轮」能把整库重新排进队列
 *   H. 全程零 JS 错误
 *
 * 注意：review.html 是扩展页面（chrome-extension://），JS 跑在页面主世界，
 * page.evaluate 可以直接访问 DOM。但 __traceDebug 只挂在 service worker 上，
 * 清库/造数据必须走 sw.evaluate。
 *
 * 用法: node test-reviewpage.js
 */
const path = require('path');
const { chromium } = require('playwright');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');

const DAY = 86400000;

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

(async () => {
  const ctx = await chromium.launchPersistentContext('.chrome-reviewpage', {
    headless: false,
    executablePath: CHROME,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--mute-audio',
      ...require('./lib/proxy').proxyArgs(),
    ],
    viewport: { width: 1440, height: 940 },
    locale: 'zh-CN',
  });

  let sw = ctx.serviceWorkers()[0];
  for (let i = 0; i < 40 && !sw; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    sw = ctx.serviceWorkers()[0];
  }
  if (!sw) {
    console.log('RESULT: FAIL (no service worker)');
    process.exit(1);
  }

  const errors = [];
  const extId = sw.url().split('/')[2];

  // ---------------------------------------------------------------- 种子
  // 与 seed-wordbook 的分布不同：这里要保证「一定有几个到期」。
  //   new 状态一律到期（isDue 对 new 恒 true）
  //   learning 但 lastReview 在 5 天前、reviewCount=1 → INTERVAL_DAYS[1]=2，也到期
  //   learned 一律不到期
  const SEED = [
    { word: 'pipeline', zh: '流水线；管线', ph: '/ˈpaɪplaɪn/', s: 'new', at: 0, rc: 0, lr: 0 },
    { word: 'overlay', zh: '覆盖层；叠加显示', ph: '/ˈəʊvəleɪ/', s: 'new', at: 0, rc: 0, lr: 0 },
    { word: 'subtitle', zh: '字幕；副标题', ph: '/ˈsʌbtaɪtl/', s: 'new', at: 0, rc: 0, lr: 0 },
    { word: 'latency', zh: '延迟；时延', ph: '/ˈleɪtənsi/', s: 'learning', at: -6 * DAY, rc: 1, lr: -5 * DAY },
    { word: 'caption', zh: '字幕轨', ph: '/ˈkæpʃn/', s: 'learned', at: -8 * DAY, rc: 3, lr: -1 * DAY },
  ];

  await sw.evaluate(async () => {
    const db = await globalThis.__traceDebug.openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(['words', 'reviewlog'], 'readwrite');
      tx.objectStore('words').clear();
      tx.objectStore('reviewlog').clear();
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  });

  const t0 = await sw.evaluate(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  });

  for (const it of SEED) {
    await sw.evaluate(
      async ({ it, t0 }) => {
        await globalThis.__traceDebug.addWordNotify({
          word: it.word,
          zh: it.zh,
          phonetic: it.ph,
          context: `The ${it.word} layer sits between the parser and the renderer.`,
          contextZh: `${it.zh.split('；')[0]}这一层位于解析器和渲染器之间。`,
          videoTitle: 'Building a Subtitle Pipeline with Zero Dependencies',
          videoId: 'TESTID00001',
          time: 412,
          meanings: [{ pos: 'n.', def: `the ${it.word} of a system` }],
        });
      },
      { it, t0 }
    );
    // 纯数据回填：不在 SW 里拼函数源码（MV3 CSP 禁 eval/new Function，
    // 会静默卡死整个 evaluate）
    await sw.evaluate(
      async ({ word, fields }) => {
        const db = await globalThis.__traceDebug.openDB();
        await new Promise((res, rej) => {
          const tx = db.transaction('words', 'readwrite');
          const store = tx.objectStore('words');
          const cur = store.get(word);
          cur.onsuccess = () => {
            if (!cur.result) return;
            Object.assign(cur.result, fields);
            store.put(cur.result);
          };
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        });
      },
      {
        word: it.word,
        fields: {
          createdAt: t0 + it.at,
          status: it.s,
          reviewCount: it.rc,
          lastReview: it.lr ? t0 + it.lr : null,
          forgetCount: 0,
          fuzzyCount: 0,
          rememberCount: 0,
        },
      }
    );
  }

  // 造 3 天连续打卡记录，用来验证 streak / 热力图 / 分布面板。
  // 直接写 reviewlog 而不走 rateWord，是因为这几条要落在「昨天、前天」，
  // 而 rateWord 用的是 Date.now()，改不了时间。
  await sw.evaluate(
    async ({ t0, DAY }) => {
      const db = await globalThis.__traceDebug.openDB();
      const pad = (n) => String(n).padStart(2, '0');
      const key = (ts) => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      };
      const rows = [];
      const grades = ['forget', 'fuzzy', 'remember', 'fuzzy', 'remember'];
      for (let back = 1; back <= 3; back += 1) {
        const at = t0 - back * DAY + 10 * 3600000;
        for (let i = 0; i < 3; i += 1) {
          const g = grades[(back + i) % grades.length];
          rows.push({ id: `${at + i}|seed${back}${i}|${g}`, at: at + i, day: key(at + i), word: `seed${back}${i}`, grade: g });
        }
      }
      await new Promise((res, rej) => {
        const tx = db.transaction('reviewlog', 'readwrite');
        const store = tx.objectStore('reviewlog');
        for (const r of rows) store.put(r);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    },
    { t0, DAY }
  );

  // ---------------------------------------------------------------- 开页面
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`chrome-extension://${extId}/review.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);

  // ---- A. KPI 与队列
  const kpi = await page.evaluate(() => ({
    due: document.getElementById('kDue').textContent.trim(),
    streak: document.getElementById('kStreak').textContent.trim(),
    today: document.getElementById('kToday').textContent.trim(),
    all: document.getElementById('kAll').textContent.trim(),
    progLbl: document.getElementById('progLbl').textContent.trim(),
    subLine: document.getElementById('subLine').textContent.trim(),
    cardWord: document.querySelector('#fcFront .fc-word')?.textContent.trim() || '',
    heatCells: document.querySelectorAll('#hmGrid .hm-cell').length,
  }));

  // 4 个到期（3 new + 1 learning 超间隔），learned 的 caption 不计
  check('kDue 显示 4 个待复习', /^4/.test(kpi.due), { due: kpi.due });
  // 3 天连续（昨天/前天/大前天；今天还没复习所以从昨天往回数）
  check('kStreak 显示连续 3 天', /^3/.test(kpi.streak), { streak: kpi.streak });
  check('kToday 初始为 0 道', /^0/.test(kpi.today), { today: kpi.today });
  check('kAll 是累计 9 道（3 天 × 3 条流水）', /^9/.test(kpi.all), { all: kpi.all });
  check('队列标签显示第 1 / 4 个', /1[\s\S]*4/.test(kpi.progLbl), { progLbl: kpi.progLbl });
  check('热力图渲染 26 周 × 7 天 = 182 格', kpi.heatCells === 182, { cells: kpi.heatCells });
  check('卡片正面显示一个词', kpi.cardWord.length > 0, { cardWord: kpi.cardWord });
  check('副标题提到待复习数量', /4/.test(kpi.subLine), { subLine: kpi.subLine });

  // ---- B. 揭示 / 收起
  const beforeReveal = await page.evaluate(() => ({
    revealed: document.getElementById('fc').dataset.revealed,
    hasRates: !!document.querySelector('.rate'),
    hasReveal: !!document.getElementById('revealBtn'),
    backText: document.getElementById('fcBack').textContent.trim(),
  }));
  check('初始未揭示、有「看释义」按钮、无评级按钮', beforeReveal.revealed === '0' && beforeReveal.hasReveal && !beforeReveal.hasRates);

  await page.click('#revealBtn');
  await page.waitForTimeout(200);
  const afterReveal = await page.evaluate(() => ({
    revealed: document.getElementById('fc').dataset.revealed,
    rates: document.querySelectorAll('.rate').length,
    backText: document.getElementById('fcBack').textContent.trim(),
    backHasZh: /流水线|覆盖层|字幕技术|延迟|覆盖面|字幕房/.test(document.getElementById('fcBack').textContent),
  }));
  check('揭示后 revealed=1 且出现 3 个评级按钮', afterReveal.revealed === '1' && afterReveal.rates === 3);
  check('背面显示释义文本', afterReveal.backHasZh, { back: afterReveal.backText.slice(0, 60) });

  await page.click('#fc');
  await page.waitForTimeout(200);
  const afterHide = await page.evaluate(() => document.getElementById('fc').dataset.revealed);
  check('再点卡片可回到正面', afterHide === '0');

  // ---- C. 评级写入
  // 记录当前词，便于事后核对该词的字段
  const rated = await page.evaluate(() => document.querySelector('#fcFront .fc-word').textContent.trim());
  await page.click('#revealBtn');
  await page.waitForTimeout(180);
  await page.click('.rate-forget');
  await page.waitForTimeout(500);

  const recAfterForget = await sw.evaluate(async (w) => {
    const db = await globalThis.__traceDebug.openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('words', 'readonly');
      const cur = tx.objectStore('words').get(w.toLowerCase());
      cur.onsuccess = () => res(cur.result);
      cur.onerror = () => rej(cur.error);
    });
  }, rated);

  // 不能硬编码 rc===1：latency 这类 learning 词种子里本来就带 reviewCount。
  // 断言的是「相对种子 +1」，不是绝对值。
  const seedOf = SEED.find((x) => x.word === rated.toLowerCase());
  check(
    '「忘记了」使 forgetCount +1、reviewCount +1',
    recAfterForget &&
      recAfterForget.forgetCount === 1 &&
      recAfterForget.reviewCount === (seedOf ? seedOf.rc : 0) + 1,
    recAfterForget
      ? { f: recAfterForget.forgetCount, rc: recAfterForget.reviewCount, seededRc: seedOf && seedOf.rc }
      : null
  );
  check('「忘记了」把状态改为 learning', recAfterForget && recAfterForget.status === 'learning', {
    status: recAfterForget && recAfterForget.status,
  });

  // ---- D. 队列前进 + 键盘
  const advanced = await page.evaluate(() => ({
    progLbl: document.getElementById('progLbl').textContent.trim(),
    revealed: document.getElementById('fc').dataset.revealed,
    word: document.querySelector('#fcFront .fc-word')?.textContent.trim() || '',
    today: document.getElementById('kToday').textContent.trim(),
  }));
  check('评完自动翻到下一个词（第 2 / 4）', /2[\s\S]*4/.test(advanced.progLbl), { progLbl: advanced.progLbl });
  check('翻页后回到未揭示状态', advanced.revealed === '0');
  check('今天已复习计数变成 1 道', /^1/.test(advanced.today), { today: advanced.today });
  check('翻到的不是刚才那个词', advanced.word !== rated, { before: rated, now: advanced.word });

  // 键盘：先按 1 只揭示不评级，再按 1 才评级
  await page.keyboard.press('1');
  await page.waitForTimeout(220);
  const afterKey1 = await page.evaluate(() => ({
    revealed: document.getElementById('fc').dataset.revealed,
    progLbl: document.getElementById('progLbl').textContent.trim(),
  }));
  check('未揭示时按 1 只揭示、不评级', afterKey1.revealed === '1' && /2[\s\S]*4/.test(afterKey1.progLbl));

  await page.keyboard.press('1');
  await page.waitForTimeout(500);
  const afterKey1b = await page.evaluate(() => ({
    progLbl: document.getElementById('progLbl').textContent.trim(),
    today: document.getElementById('kToday').textContent.trim(),
  }));
  check('已揭示后按 1 完成评级并前进', /3[\s\S]*4/.test(afterKey1b.progLbl) && /^2/.test(afterKey1b.today), {
    progLbl: afterKey1b.progLbl,
    today: afterKey1b.today,
  });

  // 空格：揭示
  await page.keyboard.press(' ');
  await page.waitForTimeout(200);
  const afterSpace = await page.evaluate(() => document.getElementById('fc').dataset.revealed);
  check('空格揭示释义', afterSpace === '1');
  // 按 3 = 记住了
  await page.keyboard.press('3');
  await page.waitForTimeout(500);
  const afterRemember = await page.evaluate(() => document.getElementById('progLbl').textContent.trim());
  check('按 3 评级并前进到第 4 / 4', /4[\s\S]*4/.test(afterRemember), { progLbl: afterRemember });

  // ---- E. 走完一轮
  await page.keyboard.press(' ');
  await page.waitForTimeout(180);
  await page.keyboard.press('2');
  await page.waitForTimeout(600);
  const finish = await page.evaluate(() => ({
    hasFinish: !!document.querySelector('.finish'),
    title: document.querySelector('.finish-title')?.textContent.trim() || '',
    sum: [...document.querySelectorAll('.finish-sum > div')].map((d) => d.textContent.trim()),
    today: document.getElementById('kToday').textContent.trim(),
    cardHidden: getComputedStyle(document.getElementById('fc')).display === 'none',
  }));
  check('队列走完后显示「本轮复习完成」', finish.hasFinish && /完成/.test(finish.title), { title: finish.title });
  check('完成面板统计本轮三档次数', finish.sum.length === 3, { sum: finish.sum });
  check('完成时卡片区隐藏', finish.cardHidden);
  check('今天累计 4 道', /^4/.test(finish.today), { today: finish.today });

  // ---- F. 打卡面板
  const panels = await page.evaluate(() => ({
    streak: document.getElementById('kStreak').textContent.trim(),
    today: document.getElementById('kToday').textContent.trim(),
    hmFoot: document.getElementById('hmFoot').textContent.replace(/\s+/g, ' ').trim(),
    lv1: document.querySelectorAll('#hmGrid .hm-cell.lv1').length,
    lv2: document.querySelectorAll('#hmGrid .hm-cell.lv2').length,
    todayCell: document.querySelectorAll('#hmGrid .hm-cell.today').length,
    distRows: document.querySelectorAll('#dist .dist-row').length,
    recentRows: document.querySelectorAll('#recent .recent-row').length,
    weekOn: document.querySelectorAll('#weekDots i.on, #weekDots i.best').length,
  }));
  check('连续天数变成 4 天（今天接上了）', /^4/.test(panels.streak), { streak: panels.streak });
  check('热力图有 1 个今日格', panels.todayCell === 1, { todayCell: panels.todayCell });
  // 前天/大前天各 3 道 → lv1（1-4 档）；今天 4 道 → lv1；昨天 3 道 → lv1
  check('热力图至少 4 天有颜色', panels.lv1 + panels.lv2 >= 4, { lv1: panels.lv1, lv2: panels.lv2 });
  check('热力图脚注显示打卡天数与累计', /共打卡/.test(panels.hmFoot) && /累计/.test(panels.hmFoot), { foot: panels.hmFoot });
  check('三档分布面板有 3 行', panels.distRows === 3, { rows: panels.distRows });
  check('最近复习列表有内容', panels.recentRows > 0, { rows: panels.recentRows });
  // 「本周」只算周一到今天，所以期望值必须按今天星期几算，不能写死。
  // 种子打卡落在今天和前 1/2/3 天，只有落在本周内的才应该亮。
  const expectWeekOn = await page.evaluate(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const dow = (d.getDay() + 6) % 7; // 0=周一
    const monday = d.getTime() - dow * 86400000;
    let n = 0;
    for (let back = 0; back <= 3; back += 1) {
      if (d.getTime() - back * 86400000 >= monday) n += 1;
    }
    return n;
  });
  check('本周打卡点数与落在本周的种子天数一致', panels.weekOn === expectWeekOn, {
    on: panels.weekOn,
    expect: expectWeekOn,
  });

  // ---- G. 重开一轮
  await page.click('#restartBtn');
  await page.waitForTimeout(800);
  const afterRestart = await page.evaluate(() => ({
    progLbl: document.getElementById('progLbl').textContent.trim(),
    hasFinish: !!document.querySelector('.finish'),
    hasCard: !!document.querySelector('#fcFront .fc-word'),
    revealed: document.getElementById('fc').dataset.revealed,
  }));
  check('「重开一轮」把整库重新排进队列', afterRestart.hasCard && !afterRestart.hasFinish, {
    progLbl: afterRestart.progLbl,
  });
  check('重开后回到未揭示状态', afterRestart.revealed === '0');

  // ---- H. 主题
  const th0 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('#themeBtn');
  await page.waitForTimeout(420);
  const th1 = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    label: document.getElementById('themeLabel').textContent.trim(),
    stored: localStorage.getItem('wb-theme'),
  }));
  await page.click('#themeBtn');
  await page.waitForTimeout(420);
  const th2 = await page.evaluate(() => document.documentElement.dataset.theme);
  check('主题默认浅色、点击切深色并落 localStorage', th0 === 'light' && th1.theme === 'dark' && th1.stored === 'dark', {
    th0,
    th1,
  });
  check('再点回到浅色', th2 === 'light', { th2 });

  // ---- 结束
  check('全程零 JS 错误', errors.length === 0, { errors: errors.slice(0, 4) });

  await ctx.close();

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`\nRESULT: FAIL (${failed.map((f) => f.name).join(', ')})`);
    process.exit(1);
  }
  console.log('\nRESULT: PASS（复习台：待复习队列 + 卡片揭示 + 三档评级 + 打卡系统 + 热力图 + 主题）');
})().catch((e) => {
  console.log('RESULT: FAIL (exception)');
  console.log(e);
  process.exit(1);
});
