/* Trace —— 词库看板逻辑
 *
 * 三层职责，改代码时别混：
 *   1) 取数：全部走 chrome.runtime.sendMessage 找后台，页面自己不碰 IndexedDB
 *      （唯一例外是备份目录句柄，见 saveDirHandleToIDB 的注释）
 *   2) 派生：KPI / 分桶 / 占比全部从 all 现算，不做增量缓存
 *   3) 渲染：innerHTML 整块重建，事件用行内委托
 */

const $ = (id) => document.getElementById(id);

const STATUS_LABEL = { new: '新词', learning: '记忆中', learned: '已记住' };
// 颜色只在 CSS 里定义，这里只记变量名，主题切换时不用重算
const STATUS_FILL = {
  new: 'var(--st-new-fill)',
  learning: 'var(--st-learning-fill)',
  learned: 'var(--st-learned-fill)',
};
const SRC_LABEL = { llm: '大模型', google: '机翻', literal: '直译' };

let all = [];
let view = 'all'; // all | new | learning | learned | phrase
let gran = 'day'; // day | week | month
let sortBy = 'new'; // new | forget | learned | old
let selected = null;

const DAY = 86400000;

// ---------------------------------------------------------------- 工具

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

function fmtTime(t) {
  if (typeof t !== 'number') return '';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setCount(el, n) {
  if (el) el.textContent = n;
}

const st = (w) => w.status || 'new';
const isPhrase = (w) => w.kind === 'phrase';

/** 单条记录的记忆评级细分（老记录没有这些字段，一律当 0） */
function tally(w) {
  const forget = w.forgetCount || 0;
  const fuzzy = w.fuzzyCount || 0;
  const remember = w.rememberCount || 0;
  // reviewCount 是总次数；老记录可能只有总次数没有细分（评级功能上线前
  // 复习过的词），差额记成「未分类」，不能凭空填进任何一档。
  const reviews = w.reviewCount || 0;
  const untagged = Math.max(0, reviews - forget - fuzzy - remember);
  return { forget, fuzzy, remember, reviews, untagged };
}

/**
 * 间隔复习的「到期」判定。
 * 新词一律算到期（还没过第一遍）；其余按 1/2/4/7/15/30 天递增的间隔，
 * 以「上次复习时间」为起点。没复习过的用加入时间当起点。
 */
const INTERVAL_DAYS = [1, 2, 4, 7, 15, 30];
function isDue(w) {
  if (st(w) === 'learned') return false;
  if (st(w) === 'new') return true;
  const from = w.lastReview || w.createdAt || 0;
  if (!from) return true;
  const idx = Math.min(w.reviewCount || 0, INTERVAL_DAYS.length - 1);
  return Date.now() - from >= INTERVAL_DAYS[idx] * DAY;
}

// ---------------------------------------------------------------- 迷你折线

/**
 * 在 SVG 里画一条带面积填充的折线（viewBox 120x26）。
 * color 传 CSS 颜色表达式（可以是 var(--x)）—— 因为 var() 在 presentation
 * attribute 里不生效，一律写进 style。
 */
function sparkline(svg, values, color) {
  if (!svg) return;
  const w = 120;
  const h = 26;
  const pad = 2;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const pts = values.map((v, i) => [
    pad + step * i,
    h - pad - (v / max) * (h - pad * 2),
  ]);
  if (!pts.length) {
    svg.innerHTML = '';
    return;
  }
  const line = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const area =
    `M${pts[0][0].toFixed(1)},${h} ` +
    pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ') +
    ` L${pts[pts.length - 1][0].toFixed(1)},${h} Z`;
  const id = 'g' + Math.random().toString(36).slice(2, 7);
  svg.innerHTML = `
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" style="stop-color:${color};stop-opacity:0.24"/>
      <stop offset="100%" style="stop-color:${color};stop-opacity:0"/>
    </linearGradient></defs>
    <path d="${area}" style="fill:url(#${id})" stroke="none"/>
    <path d="${line}" fill="none" style="stroke:${color}" stroke-width="1.4"
          stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
}

// ---------------------------------------------------------------- 时间分桶

/** 把单词按 day / week / month 分桶，返回 [{label, count, full}] */
function bucketize(words, mode) {
  const now = new Date();
  const buckets = [];

  if (mode === 'day') {
    // 最近 30 天
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const from = d.getTime();
      const to = from + DAY;
      // 每 7 天标一个，并保证最后一天（今天）一定有标签
      const show = i % 7 === 0 || i === 0;
      buckets.push({
        label: show ? `${d.getMonth() + 1}/${d.getDate()}` : '',
        full: `${d.getMonth() + 1} 月 ${d.getDate()} 日`,
        count: 0,
        from,
        to,
      });
    }
  } else if (mode === 'week') {
    // 最近 12 周（周一为起点）
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = (today.getDay() + 6) % 7; // 周一=0
    const thisMonday = today.getTime() - dow * DAY;
    for (let i = 11; i >= 0; i--) {
      const from = thisMonday - i * 7 * DAY;
      const to = from + 7 * DAY;
      const d = new Date(from);
      buckets.push({
        label: i % 3 === 0 || i === 0 ? `${d.getMonth() + 1}/${d.getDate()}` : '',
        full: `${d.getMonth() + 1} 月 ${d.getDate()} 日当周`,
        count: 0,
        from,
        to,
      });
    }
  } else {
    // 最近 12 个月
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const from = d.getTime();
      const to = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
      buckets.push({
        label: `${d.getMonth() + 1}月`,
        full: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`,
        count: 0,
        from,
        to,
      });
    }
  }

  for (const w of words) {
    const t = w.createdAt || 0;
    for (const b of buckets) {
      if (t >= b.from && t < b.to) {
        b.count++;
        break;
      }
    }
  }
  return buckets;
}

// ---------------------------------------------------------------- 渲染：KPI

function renderKPIs() {
  const now = new Date();
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - DAY;
  const weekStart = todayStart - 6 * DAY;

  const total = all.length;
  const learned = all.filter((w) => st(w) === 'learned').length;
  const learning = all.filter((w) => st(w) === 'learning').length;
  const today = all.filter((w) => (w.createdAt || 0) >= todayStart).length;
  const yesterday = all.filter(
    (w) => (w.createdAt || 0) >= yesterdayStart && (w.createdAt || 0) < todayStart
  ).length;
  const week = all.filter((w) => (w.createdAt || 0) >= weekStart).length;

  const reviews = all.reduce((s, w) => s + (w.reviewCount || 0), 0);
  const forgets = all.reduce((s, w) => s + (w.forgetCount || 0), 0);
  const rate = total ? Math.round((learned / total) * 100) : 0;
  // 遗忘率：忘记次数 / 总复习次数。用次数而不是词数——「同一个词忘三次」
  // 比「三个词各忘一次」更值得关注，按次数算才反映真实的记忆负担。
  const forgetRate = reviews ? Math.round((forgets / reviews) * 100) : 0;

  const due = all.filter(isDue).length;
  // 复习入口的角标与 KPI 用同一个 due，必须同源，否则两个数字会打架。
  if ($('batchDue')) $('batchDue').textContent = due;
  if ($('cDue')) $('cDue').textContent = due;

  $('kTotal').textContent = total;
  $('kToday').textContent = today;
  $('kReviews').textContent = reviews;
  if ($('kDue')) $('kDue').textContent = due;
  if ($('kForget')) {
    $('kForget').innerHTML = `<span class="sm">${forgetRate}</span>%`;
    // 有遗忘才着红：0% 也标红会让「学得不错」看起来像警报。
    $('kForget').classList.toggle('neg', forgetRate > 0);
  }

  $('dTotal').innerHTML = `本周新增 <b class="up">+${week}</b>`;
  const delta = today - yesterday;
  $('dToday').innerHTML =
    `昨日 <b>${yesterday}</b>` +
    (yesterday > 0
      ? ` · <b class="${delta >= 0 ? 'up' : 'hot'}">${delta >= 0 ? '+' : ''}${delta}</b>`
      : '');
  if ($('dDue')) {
    $('dDue').innerHTML = due
      ? `间隔复习已到期 <b class="warn">${due}</b>`
      : `都掌握了 · 已记住 <b>${learned}</b>`;
  }
  $('dReviews').innerHTML = `已记住 <b>${learned}</b> · 掌握率 <b>${rate}%</b>`;
  $('dForget').innerHTML = `共忘记 <b class="${forgets ? 'hot' : ''}">${forgets}</b> 次`;

  // 侧栏计数
  setCount($('cAll'), total);
  setCount($('cLearned'), learned);
  setCount($('cLearning'), learning);
  setCount($('cNew'), all.filter((w) => st(w) === 'new').length);
  // 短语单独一栏：它们的记录结构和单词不同（没有音标/词性，有逐词对照），
  // 混在单词列表里既占位置又难扫读。
  setCount($('cPhrase'), all.filter(isPhrase).length);

  // 工具栏芯片上的计数（评论文档里的「筛选按钮组」要带数量才有效率）
  setCount($('fAll'), total);
  setCount($('fNew'), all.filter((w) => st(w) === 'new').length);
  setCount($('fLearning'), learning);
  setCount($('fLearned'), learned);
  setCount($('fPhrase'), all.filter(isPhrase).length);

  // 待复习卡片：有积压时才提亮，空的时候不要喊
  if ($('kpiDue')) $('kpiDue').classList.toggle('due', due > 0);

  // ---- 4 条迷你折线 ----
  const last14 = [];
  for (let i = 13; i >= 0; i--) {
    const from = todayStart - i * DAY;
    const to = from + DAY;
    last14.push(all.filter((w) => (w.createdAt || 0) >= from && (w.createdAt || 0) < to).length);
  }
  let acc = 0;
  const cum = last14.map((v) => (acc += v));
  // 累计曲线起点应为「14 天前的存量」，让曲线形状真实
  const before = Math.max(0, total - acc);
  const cumTotal = cum.map((v) => v + before);

  // 未掌握存量：按当前状态回溯。状态没有历史表，这是近似值，
  // 只用来给曲线定形状，KPI 数字本身用精确计数。
  const learnedNow = learned;
  const cumLearning = cumTotal.map((v) =>
    v ? Math.round(((total ? v / total : 0)) * (total ? total - learnedNow : 0)) : 0
  );

  // 复习次数：lastReview 有真实时间戳，这一条按天分桶是真数据
  const reviews14 = [];
  for (let i = 13; i >= 0; i--) {
    const from = todayStart - i * DAY;
    const to = from + DAY;
    reviews14.push(
      all.filter((w) => {
        const t = w.lastReview || 0;
        return t >= from && t < to;
      }).length
    );
  }

  // 遗忘曲线：forgetCount 是累计值，没有逐次时间戳，只能把「这个词忘了几次」
  // 记到它最后一次复习那天。这是一个近似（真实分布可能更早），所以它只用来
  // 给迷你折线定形状——卡片上的百分比是精确的 forgetting/reviews。
  const forget14 = [];
  for (let i = 13; i >= 0; i--) {
    const from = todayStart - i * DAY;
    const to = from + DAY;
    forget14.push(
      all.reduce((s, w) => {
        const t = w.lastReview || 0;
        return s + (t >= from && t < to ? w.forgetCount || 0 : 0);
      }, 0)
    );
  }
  let facc = 0;
  const forgetCum = forget14.map((v) => (facc += v));

  // 描边色走 --spark-* 而不是语义色：浅色主题下品牌金 #ffd76e 压白卡只有
  // 1.38:1，1.5px 的线等于看不见（见 wordbook.html 里的注释）。
  sparkline($('spTotal'), cumTotal, 'var(--spark-gold)');
  sparkline($('spToday'), last14, 'var(--spark-violet)');
  sparkline($('spLearning'), cumLearning, 'var(--spark-learning)');
  sparkline($('spLearned'), reviews14, 'var(--spark-learned)');
  sparkline($('spForget'), forgetCum, 'var(--spark-new)');

  $('subLine').textContent = total
    ? `共 ${total} 条 · 已记住 ${learned} · 记忆中 ${learning} · 今天新增 ${today}`
    : // 空库时这里只报事实。操作指引交给列表里的空态块（那里有图标、标题、
      // 两步说明），两处都写「去字幕里点一个词」等于同一句话说两遍。
      '共 0 条 · 从零开始';
}

// ---------------------------------------------------------------- 渲染：柱状图

/**
 * 计算「好看」的纵轴刻度。
 * 直接用 max/3、2max/3 会得到 1、3、4 这种不等距数字，读起来莫名其妙；
 * 这里先把上限向上取整到 step 的整数倍（顺便留出顶部余量），再等距出刻度。
 */
function niceScale(raw) {
  const target = Math.max(1, raw) * 1.15;
  let step;
  if (target <= 4) step = 1;
  else if (target <= 10) step = 2;
  else if (target <= 25) step = 5;
  else step = Math.ceil(target / 5 / 5) * 5;
  const max = Math.max(step, Math.ceil(target / step) * step);
  const ticks = [];
  for (let v = step; v <= max; v += step) ticks.push(v);
  return { max, ticks };
}

function renderBars() {
  const buckets = bucketize(all, gran);
  const box = $('bars');
  const grid = $('barGrid');
  const raw = Math.max(1, ...buckets.map((b) => b.count));
  const { max, ticks } = niceScale(raw);

  // 网格线画在独立的绝对定位层里：柱子容器有 18px 的底部留白给日期标签，
  // 如果网格和柱子在同一个流里，刻度和柱底会对不上。
  // .chart-grid 自己已经 inset 掉了那 18px，所以这里的百分比就是绘图区高度，
  // 直接 bottom:p% 即可 —— 不要写成 calc(18px + p% * (...))，CSS calc 里
  // 百分比不能乘百分比，那样算出来的值无效，所有线会叠成一条。
  if (grid) {
    grid.innerHTML = ticks
      .map((v) => {
        const p = (v / max) * 100;
        return `<div class="grid-line${v === max ? ' top' : ''}" style="bottom:${p}%">
                  <span class="grid-y">${v}</span>
                </div>`;
      })
      .join('');
  }

  box.innerHTML = buckets
    .map((b) => {
      const h = max ? (b.count / max) * 100 : 0;
      const empty = b.count === 0 ? ' bar-empty' : '';
      return `
      <div class="bar${empty}">
        <div class="bar-tip">${b.full} · <b>${b.count}</b> 词</div>
        <div class="bar-fill" style="height:${Math.max(h, 1.5)}%"></div>
        ${b.label ? `<span class="bar-x">${b.label}</span>` : ''}
      </div>`;
    })
    .join('');

  const span =
    gran === 'day' ? '最近 30 天' : gran === 'week' ? '最近 12 周' : '最近 12 个月';
  const sum = buckets.reduce((s, b) => s + b.count, 0);
  const older = all.length - sum;
  $('chartSub').textContent =
    `${span} · 共 ${sum} 条` + (older > 0 ? ` · 另有 ${older} 条更早` : '');
}

// ---------------------------------------------------------------- 渲染：状态环

function renderDonut() {
  const total = all.length;
  // 顺序固定为「已记住 → 记忆中 → 新词」，环从 12 点顺时针：越靠前的
  // 越接近「已经学会」，视觉上从成功读到待办，和列表的排序方向一致。
  const parts = ['learned', 'learning', 'new'].map((k) => ({
    k,
    n: all.filter((w) => st(w) === k).length,
  }));

  const donut = $('donut');
  $('donutNum').textContent = total;

  if (!total) {
    donut.style.background = 'var(--ink-4)';
  } else {
    const live = parts.filter((p) => p.n > 0);
    // 相邻两段（新词 / 记忆中）同属红色族，只靠明度差在 116px 的环上分不开，
    // 所以在段与段之间留一道 1.4% 的中性缝（填卡片底色）代替对比度。
    // 只有一段时不留缝，否则整圈会被切出一个莫名其妙的缺口。
    const GAP = live.length > 1 ? 1.4 : 0;
    let acc = 0;
    const segs = live.map((p) => {
      const from = (acc / total) * 100;
      acc += p.n;
      return { k: p.k, from, to: (acc / total) * 100 };
    });
    const stops = [];
    segs.forEach((s, i) => {
      if (i > 0) {
        stops.push(
          `var(--ink-2) ${(s.from - GAP / 2).toFixed(2)}% ${(s.from + GAP / 2).toFixed(2)}%`
        );
      }
      const a = i === 0 ? s.from : s.from + GAP / 2;
      const b = i === segs.length - 1 ? s.to : s.to - GAP / 2;
      stops.push(`${STATUS_FILL[s.k]} ${a.toFixed(2)}% ${b.toFixed(2)}%`);
    });
    donut.style.background = `conic-gradient(${stops.join(', ')})`;
  }

  // kLearned / kLearning 挂在图例的数字上：这是全页唯一「同时展示
  // 三类状态数量」的地方，把它做成可读的数值锚点，比再开一排 KPI 省地方。
  $('legend').innerHTML = parts
    .map(
      (p) => `
      <div class="lg${view === p.k ? ' on' : ''}" data-v="${p.k}">
        <span class="lg-dot" style="background:${STATUS_FILL[p.k]}"></span>
        <span class="lg-name">${STATUS_LABEL[p.k]}</span>
        <span class="lg-val" id="${p.k === 'learned' ? 'kLearned' : p.k === 'learning' ? 'kLearning' : 'kNew'}">${p.n}</span>
        <span class="lg-pct">${total ? Math.round((p.n / total) * 100) : 0}%</span>
      </div>`
    )
    .join('');

  $('legend')
    .querySelectorAll('.lg')
    .forEach((el) =>
      el.addEventListener('click', () => {
        view = el.dataset.v;
        syncSideNav();
        renderRows();
      })
    );
}

// ---------------------------------------------------------------- 渲染：词表

function syncSideNav() {
  document.querySelectorAll('#sideNav button').forEach((b) => {
    b.classList.toggle('on', b.dataset.view === view);
  });
  document.querySelectorAll('.chip[data-f]').forEach((c) => {
    c.classList.toggle('on', c.dataset.f === view);
  });
  document.querySelectorAll('#legend .lg').forEach((l) => {
    l.classList.toggle('on', l.dataset.v === view);
  });
}

function visibleWords() {
  const q = ($('q').value || '').trim().toLowerCase();
  let list = all;

  // 短语视图：按记录类型过滤，不按学习状态
  if (view === 'phrase') {
    list = list.filter(isPhrase);
  } else if (view !== 'all') {
    list = list.filter((w) => st(w) === view && !isPhrase(w));
  }
  if (q) {
    list = list.filter(
      (w) =>
        (w.word || '').includes(q) ||
        (w.zh || '').toLowerCase().includes(q) ||
        (w.context || '').toLowerCase().includes(q) ||
        (w.contextZh || '').toLowerCase().includes(q)
    );
  }

  const by = {
    // 加入时间排序（新的在前）
    new: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    // 优先遗忘最多：先看忘记次数，同次数时看总复习次数（复习得多还没记住更该看）
    forget: (a, b) =>
      (b.forgetCount || 0) - (a.forgetCount || 0) ||
      (b.reviewCount || 0) - (a.reviewCount || 0) ||
      (b.createdAt || 0) - (a.createdAt || 0),
    // 优先已记住：learned 置顶，组内按复习次数降序
    learned: (a, b) => {
      const rank = (w) => (st(w) === 'learned' ? 0 : st(w) === 'learning' ? 1 : 2);
      return rank(a) - rank(b) || (b.reviewCount || 0) - (a.reviewCount || 0);
    },
    old: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
  }[sortBy] || ((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return list.slice().sort(by);
}

/* 短语图标：三横线（文本块）。
   原设计是双引号，但引号的两撇在 12px 下会塌成两个人形或「99」——
   把图标栅格化成 12×12 真实像素后确认：引号下半截的撇只剩 1px 宽的两条尾，
   而两个闭合的圆头被读成数字 9 / 9。三横线在同样面积里只有横笔画，
   不依赖「撇」这种细尖结构，缩小后仍然稳定读作「一段文本」。 */
const PHRASE_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h9"/></svg>`;

function renderRows() {
  const list = visibleWords();
  const box = $('rows');

  if (!list.length) {
    box.innerHTML = `
      <div class="empty">
        <div class="empty-mark">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>
          </svg>
        </div>
        <div>
          <div class="empty-title">${all.length ? '这个筛选下没有词' : '词库还是空的'}</div>
          <div class="empty-sub">${
            all.length
              ? '换个状态、清空搜索，或切换排序试试'
              : '在 YouTube 字幕里点击单词或短语，就会存进这里'
          }</div>
        </div>
      </div>`;
    return;
  }

  box.innerHTML = list
    .map((w, i) => {
      const s = st(w);
      const phrase = isPhrase(w);
      // 短语没有音标，那一列改用「来源」（大模型/机翻/直译）——
      // 用户扫列表时更需要知道这条释义可信度，而不是一个空列。
      const meta = phrase ? SRC_LABEL[w.source] || '短语' : esc(w.phonetic || '');
      const t = tally(w);
      const forgetTag = t.forget
        ? `<span class="w-forget${t.forget >= 3 ? ' hot' : ''}" title="忘记 ${t.forget} 次">
             <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>${t.forget}
           </span>`
        : '';
      return `
      <div class="wrow s-${s}${phrase ? ' wrow-phrase' : ''}" data-w="${esc(w.word)}"
           style="--i:${Math.min(i, 14)}" tabindex="0" role="button"
           aria-label="${esc(w.display || w.word)}，${STATUS_LABEL[s]}">
        <div class="w-ico${phrase ? ' w-ico-phrase' : ''}">${
        phrase ? PHRASE_SVG : esc((w.display || w.word || '?').charAt(0))
      }</div>
        <div class="w-word">
          <span class="w-txt">${esc(w.display || w.word)}</span>
          <span class="pill pill-${s}">${STATUS_LABEL[s]}</span>
          ${forgetTag}
        </div>
        <div class="w-phon">${meta}</div>
        <div class="w-zh">${esc(w.zh || w.context || '')}</div>
        <div class="w-date">${fmtDate(w.createdAt)}</div>
        <div class="w-act">
          <button class="act-rev" data-act="rev" title="标记复习一次" aria-label="标记复习">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
          </button>
          <button class="act-del" data-act="del" title="删除" aria-label="删除">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9.5 7V4.8h5V7"/><path d="M6 7l.9 12.2A2 2 0 0 0 8.9 21h6.2a2 2 0 0 0 2-1.8L18 7"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </div>
      </div>`;
    })
    .join('');

  box.querySelectorAll('.wrow').forEach((row) => {
    row.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (btn) {
        ev.stopPropagation();
        const word = row.dataset.w;
        if (btn.dataset.act === 'del') delWord(word);
        else revWord(word);
        return;
      }
      openDrawer(row.dataset.w);
    });
    // 键盘可达：行本身是 role=button，回车/空格等同点击
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openDrawer(row.dataset.w);
      }
    });
  });
}

// ---------------------------------------------------------------- 详情抽屉

function openDrawer(word) {
  const w = all.find((x) => x.word === word);
  if (!w) return;
  selected = w;
  renderDrawer(w);
  $('drawer').classList.add('open');
  $('scrim').classList.add('on');
  document.body.style.overflow = 'hidden';
  // 抽屉打开后把焦点送进去，Esc / Tab 才不会留在背后的列表里
  setTimeout(() => $('dwClose').focus(), 40);
}

/** 抽屉内容整体重建；复习评级后原地刷新，不重新播放入场动画 */
function renderDrawer(w) {
  $('dwWord').textContent = w.display || w.word;
  // 短语没有音标；那一行改成来源标签，比留空有用
  const srcLabel = { llm: '大模型释义', google: '机器翻译', literal: '逐词直译' };
  $('dwPhon').textContent = isPhrase(w)
    ? srcLabel[w.source] || '短语'
    : w.phonetic || '';

  const s = st(w);
  const t = tally(w);

  // 短语的「逐词对照」是它区别于单词卡的核心内容：单词只要一条释义，
  // 短语必须让用户看到每个词各是什么，才能理解整段为什么这么翻。
  const wordsBlock =
    isPhrase(w) && Array.isArray(w.words) && w.words.length
      ? `<div class="dw-sec">
           <div class="dw-sec-hd">
             <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 12h10M4 17h13"/></svg>
             逐词对照
           </div>
           <div class="dw-words">
             ${w.words
               .map(
                 (x) =>
                   `<div class="dw-wrow"><b>${esc(x.w || '')}</b><span>${esc(
                     x.zh || '—'
                   )}</span></div>`
               )
               .join('')}
           </div>
         </div>`
      : '';

  const meaningsBlock =
    w.meanings && w.meanings.length
      ? `<div class="dw-sec">
           <div class="dw-sec-hd">
             <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21z"/><path d="M4 18.5V5.5"/></svg>
             英文释义
           </div>
           ${w.meanings
             .slice(0, 4)
             .map(
               (m) => `<div class="dw-mean">
                 ${m.pos ? `<span class="pos">${esc(m.pos)}</span>` : '<span class="pos">·</span>'}
                 <span>${esc(m.def || '')}</span>
               </div>`
             )
             .join('')}
         </div>`
      : '';

  const ctx = w.context
    ? `<div class="dw-quote">
         ${highlightWord(w.context, w.display || w.word)}
         ${w.contextZh ? `<div class="q-zh">${highlightWord(w.contextZh, w.zh)}</div>` : ''}
       </div>`
    : `<div class="dw-empty-quote">这条记录没有保存原句（很多短语是从字幕里直接划的）</div>`;

  // 记忆统计：四档 + 一条配额条。配额条比四个数字更快传达「这个词是
  // 偶发遗忘还是反复遗忘」，数字给出精确值。
  const mixTotal = Math.max(1, t.reviews);
  const mix = t.reviews
    ? `<div class="dw-mix" title="忘记 / 模糊 / 记住 / 未分类">
         ${t.forget ? `<i class="m-f" style="width:${(t.forget / mixTotal) * 100}%"></i>` : ''}
         ${t.fuzzy ? `<i class="m-z" style="width:${(t.fuzzy / mixTotal) * 100}%"></i>` : ''}
         ${t.remember ? `<i class="m-r" style="width:${(t.remember / mixTotal) * 100}%"></i>` : ''}
         ${t.untagged ? `<i class="m-n" style="width:${(t.untagged / mixTotal) * 100}%"></i>` : ''}
       </div>`
    : `<div class="dw-mix"><i class="m-n" style="width:100%"></i></div>`;
  // 配额条只画出「有份额」的段，没有图例时红/琥珀/绿纯靠猜。
  // 三档评级恒定列出（值为 0 时淡显）—— 只列非零项会让「记住 0」直接消失，
  // 用户就不知道这条杠还有第三种语义；「未分类」是老记录的差额，只在存在时出现。
  const LEGEND = [
    [t.forget, '忘记', 'f', false],
    [t.fuzzy, '模糊', 'z', false],
    [t.remember, '记住', 'r', false],
    [t.untagged, '未分类', 'n', true],
  ];
  const mixLegend = t.reviews
    ? `<div class="dw-mix-leg">${LEGEND.filter(([n, , , opt]) => n || !opt)
        .map(
          ([n, label, tone]) =>
            `<span class="is-${tone}${n ? '' : ' is-off'}"><i></i>${label}</span>`
        )
        .join('')}</div>`
    : '';

  $('dwBody').innerHTML = `
    <div class="dw-sec">
      ${
        isPhrase(w)
          ? `<div class="dw-tag">
               <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h9"/></svg>
               短语
             </div>`
          : ''
      }
      <div class="dw-zh">${esc(w.zh || '—')}</div>
      ${
        isPhrase(w) && w.literal && w.literal !== w.zh
          ? `<div class="dw-literal">逐词直译：${esc(w.literal)}</div>`
          : ''
      }
      ${isPhrase(w) && w.note ? `<div class="dw-note">${esc(w.note)}</div>` : ''}
    </div>

    ${wordsBlock}
    ${meaningsBlock}

    <div class="dw-sec">
      <div class="dw-sec-hd">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19V9m5 10V5m5 14v-7m5 7V8"/></svg>
        记忆统计
      </div>
      <div class="dw-stat">
        <div>
          <div class="v">${t.reviews}</div>
          <div class="k">总复习</div>
        </div>
        <div>
          <div class="v f">${t.forget}</div>
          <div class="k">忘记</div>
        </div>
        <div>
          <div class="v z">${t.fuzzy}</div>
          <div class="k">模糊</div>
        </div>
        <div>
          <div class="v r">${t.remember}</div>
          <div class="k">记住</div>
        </div>
      </div>
      ${mix}
      ${mixLegend}
    </div>

    <div class="dw-sec">
      <div class="dw-sec-hd">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 10.5h.01M8 14h.01M8 17.5h.01M12 7h8M12 12h8M12 17h5"/><path d="M4 5h4v16H4z"/></svg>
        原句 · 上下文
      </div>
      ${ctx}
      ${
        w.videoTitle
          ? `<div style="font-size:11.5px;color:var(--text-3);line-height:1.5">
               <span style="color:var(--text-4)">来源 · </span>${esc(w.videoTitle)}${
              w.time != null
                ? `<span style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-4)"> · ${fmtTime(
                    w.time
                  )}</span>`
                : ''
            }
             </div>`
          : ''
      }
    </div>

    <div class="dw-sec">
      <div class="dw-sec-hd">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
        这次想得起来吗
      </div>
      <div class="rate-row">
        <button type="button" class="rate rate-forget" data-rate="forget" title="完全想不起来（1）">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M18.5 15.5V21"/><path d="M16.2 18.7L18.5 21l2.3-2.3"/></svg>
          忘记了
          <span class="hint">稍后再练</span>
        </button>
        <button type="button" class="rate rate-fuzzy" data-rate="fuzzy" title="想起来但不完整（2）">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8.6 10h6.8M9.4 13h5.2M10.4 16h3.2"/></svg>
          模糊
          <span class="hint">继续温习</span>
        </button>
        <button type="button" class="rate rate-remember" data-rate="remember" title="想得起来（3）">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.3l2.6 2.6 5-5.4"/></svg>
          记住了
          <span class="hint">标记已记住</span>
        </button>
      </div>
    </div>

    <div class="dw-sec">
      <div class="dw-sec-hd">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5l3 1.8"/></svg>
        记录
      </div>
      <div class="dw-stat" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div>
          <div class="v" style="font-size:12px">${STATUS_LABEL[s]}</div>
          <div class="k">当前状态</div>
        </div>
        <div>
          <div class="v" style="font-size:12px">${fmtDate(w.createdAt)}</div>
          <div class="k">加入时间</div>
        </div>
        <div>
          <div class="v" style="font-size:12px">${w.lastReview ? fmtDate(w.lastReview) : '—'}</div>
          <div class="k">上次复习</div>
        </div>
      </div>
    </div>
  `;

  $('dwPlay').disabled = !w.videoId;
  $('dwStatus').value = s;

  // 评级键需要每次重建后重新绑定（innerHTML 会把监听器一起丢掉）
  $('dwBody')
    .querySelectorAll('.rate')
    .forEach((btn) =>
      btn.addEventListener('click', () => rateWord(selected.word, btn.dataset.rate))
    );
}

/** 把上下文里的目标词包成 <em>，其余转义 */
function highlightWord(text, word) {
  const t = String(text || '');
  const w = String(word || '');
  if (!w) return esc(t);
  const idx = t.toLowerCase().indexOf(w.toLowerCase());
  if (idx < 0) return esc(t);
  return (
    esc(t.slice(0, idx)) +
    '<em>' + esc(t.slice(idx, idx + w.length)) + '</em>' +
    esc(t.slice(idx + w.length))
  );
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('scrim').classList.remove('on');
  document.body.style.overflow = '';
  selected = null;
}

// ---------------------------------------------------------------- 数据操作

async function reload() {
  const r = await chrome.runtime.sendMessage({ type: 'word:list' });
  all = r && r.ok ? r.data : [];
  // 图例里有 kLearned / kLearning 两个数值锚点，必须先渲染图例再渲染 KPI
  renderDonut();
  renderKPIs();
  renderBars();
  renderRows();
  if (selected) {
    const fresh = all.find((x) => x.word === selected.word);
    if (fresh) {
      selected = fresh;
      renderDrawer(fresh);
    } else {
      closeDrawer();
    }
  }
}

async function delWord(word) {
  await chrome.runtime.sendMessage({ type: 'word:remove', word });
  if (selected && selected.word === word) closeDrawer();
  await reload();
}

async function revWord(word) {
  await chrome.runtime.sendMessage({ type: 'word:review', word });
  await reload();
}

/**
 * 记忆评级：和 revWord 分开的两条路。
 *   revWord  → word:review，后台只 +1 次数并按「三次即记住」的旧规则推状态
 *              （列表行上的快捷勾选、抽屉底部的「标记复习」走这条）
 *   rateWord → word:rate，后台额外记 forget/fuzzy/remember 细分，
 *              并把状态直接定成 learned / learning
 */
async function rateWord(word, grade) {
  if (!word || !grade) return;
  // 点下去先给一次即时反馈，再等后台回包，避免「点了没反应」的错觉
  const btn = document.querySelector(`.rate[data-rate="${grade}"]`);
  if (btn) {
    btn.classList.add('flash');
    setTimeout(() => btn.classList.remove('flash'), 460);
  }
  const r = await chrome.runtime.sendMessage({ type: 'word:rate', word, grade });
  if (!r || !r.ok) {
    toast('记录失败：' + ((r && r.error) || '未知错误'), 'err');
    return;
  }
  await reload();
  const label = { forget: '已记一次遗忘', fuzzy: '已记一次模糊', remember: '已标记记住' }[grade];
  toast(label + ' · 明天再来一遍');
}

async function setStatus(word, status) {
  const r = await chrome.runtime.sendMessage({ type: 'word:set-status', word, status });
  if (!r || !r.ok) {
    toast('设置失败：' + ((r && r.error) || '未知错误'), 'err');
    return;
  }
  await reload();
  toast(`状态已改为「${STATUS_LABEL[status]}」`);
}

// ---------------------------------------------------------------- 主题

function applyTheme(next, animate) {
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-anim');
    setTimeout(() => root.classList.remove('theme-anim'), 420);
  }
  root.dataset.theme = next;
  try {
    localStorage.setItem('wb-theme', next);
  } catch (_) {}
  // 深色下 <select> 的原生弹出层要吃 color-scheme，已由 CSS 的 color-scheme 处理
  if ($('themeLabel')) {
    $('themeLabel').textContent = next === 'light' ? '浅色' : '深色';
  }
  $('themeBtn').setAttribute(
    'aria-label',
    next === 'light' ? '当前浅色，点击切换到深色' : '当前深色，点击切换到浅色'
  );
}

$('themeBtn').addEventListener('click', async () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next, true);
  // 顺手存进扩展设置，popup / 下次打开能沿用同一个偏好
  chrome.runtime
    .sendMessage({ type: 'settings:set', patch: { wbTheme: next } })
    .catch(() => null);
});

// ---------------------------------------------------------------- 事件

document.querySelectorAll('#sideNav button').forEach((b) => {
  b.addEventListener('click', () => {
    view = b.dataset.view;
    syncSideNav();
    renderRows();
  });
});

document.querySelectorAll('.chip[data-f]').forEach((c) => {
  c.addEventListener('click', () => {
    view = c.dataset.f;
    syncSideNav();
    renderRows();
  });
});

document.querySelectorAll('#gran button').forEach((b) => {
  b.addEventListener('click', () => {
    gran = b.dataset.g;
    document.querySelectorAll('#gran button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    renderBars();
  });
});

$('q').addEventListener('input', () => {
  const box = $('searchBox');
  if (box) box.classList.toggle('has-value', !!$('q').value);
  renderRows();
});
if ($('qClear')) {
  $('qClear').addEventListener('click', () => {
    $('q').value = '';
    $('searchBox').classList.remove('has-value');
    $('q').focus();
    renderRows();
  });
}

$('sort').addEventListener('change', () => {
  sortBy = $('sort').value;
  renderRows();
});

// 复习入口：到独立复习台（review.html）逐张过。
// 角标显示「到期词数」，与 KPI 的「待复习」同一套 isDue 算法 —— 两个数字
// 对不上会让用户觉得其中一个是错的。
if ($('batchBtn')) {
  $('batchBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
  });
}
if ($('sideReview')) {
  $('sideReview').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
  });
}

$('scrim').addEventListener('click', closeDrawer);
$('dwClose').addEventListener('click', closeDrawer);

document.addEventListener('keydown', (e) => {
  const open = $('drawer').classList.contains('open');
  if (e.key === 'Escape' && open) {
    closeDrawer();
    return;
  }
  // 抽屉里的快捷键：R 复习一次，1/2/3 对应三档评级
  if (!open) {
    if (e.key === '/' && document.activeElement !== $('q')) {
      e.preventDefault();
      $('q').focus();
    }
    return;
  }
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  const map = { 1: 'forget', 2: 'fuzzy', 3: 'remember' };
  if (map[e.key] && selected) {
    e.preventDefault();
    rateWord(selected.word, map[e.key]);
  } else if ((e.key === 'r' || e.key === 'R') && selected) {
    e.preventDefault();
    revWord(selected.word);
  }
});

$('dwReview').addEventListener('click', () => {
  if (selected) revWord(selected.word);
});

$('dwStatus').addEventListener('change', () => {
  if (selected) setStatus(selected.word, $('dwStatus').value);
});

$('dwDelete').addEventListener('click', () => {
  if (!selected) return;
  const w = selected;
  if (!confirm(`从生词本删除「${w.display || w.word}」？\n\n删除后只能从备份文件恢复。`)) return;
  delWord(w.word);
});

$('dwPlay').addEventListener('click', () => {
  if (!selected || !selected.videoId) return;
  const s = Math.max(0, Math.floor(Number(selected.time) || 0));
  chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${selected.videoId}&t=${s}s` });
});

// 导出成 JSON 文件。
// 这里曾经不看结果就无条件下载：后台返回 {ok:false} 时 data 退化成 []，
// JSON.stringify([],null,2) 恰好 2 字节，于是用户拿到一个 2B 的空文件 ——
// 既没导出成功也没看到报错。现在只有真的拿到非空数组才落盘。
$('exportBtn').addEventListener('click', async () => {
  let data;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'word:export' });
    if (!r || !r.ok) throw new Error((r && r.error) || '后台没有返回数据');
    data = r.data;
  } catch (e) {
    toast('导出失败：' + ((e && e.message) || e), 'err');
    return;
  }
  if (!Array.isArray(data) || data.length === 0) {
    toast('生词本是空的，没有可导出的内容', 'err');
    return;
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trace-words-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`已导出 ${data.length} 条到本机文件`);
});

// ---------------------------------------------------------------- 备份 / 恢复
//
// 生词本原本只存在扩展自己的 IndexedDB 里，Chrome 一卸载扩展就清空。
// 所以这里提供「写成本机文件」+「从文件恢复」：
//   - 备份：由后台调 chrome.downloads 写到 下载/trace-subtitles/wordbook-backup.json
//   - 恢复：读用户选的文件（或自动去找那份固定备份），合并回 IndexedDB

function toast(text, kind = 'ok') {
  let el = document.getElementById('wb-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'wb-toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.dataset.kind = kind;
  el.classList.add('on');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('on'), 3200);
}

$('backupBtn').addEventListener('click', async () => {
  const btn = $('backupBtn');
  const label = $('backupLabel');
  const old = label ? label.textContent : '立即备份';
  btn.disabled = true;
  if (label) label.textContent = '备份中…';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'backup:save' });
    if (r && r.ok) {
      // 写到用户选的目录时只显示文件夹名；退回「下载」时才显示相对路径。
      // 绝不显示绝对路径：动辄上百字符，toast 会横跨词表把内容盖住。
      const where =
        r.data.via === 'dir'
          ? `「${(r.data.filename || '').split('/')[0] || '已选文件夹'}」`
          : `下载/${r.data.relPath || 'trace-subtitles/wordbook-backup.json'}`;
      toast(`已备份 ${r.data.count} 个单词 → ${where}`);
      await refreshDirUI();
    } else {
      toast('备份失败：' + ((r && r.error) || '未知错误'), 'err');
    }
  } catch (e) {
    toast('备份失败：' + ((e && e.message) || e), 'err');
  } finally {
    btn.disabled = false;
    if (label) label.textContent = old;
  }
});

/** 把备份对象送进后台恢复 */
async function doRestore(data, replace) {
  const r = await chrome.runtime.sendMessage({ type: 'backup:restore', data, replace });
  if (!r || !r.ok) throw new Error((r && r.error) || '恢复失败');
  return r.data;
}

// ---- 备份目录：选文件夹 + 显示状态 ----

/**
 * 把目录句柄直接写进扩展的 IndexedDB。
 *
 * 注意：**不能**通过 chrome.runtime.sendMessage 把 FileSystemDirectoryHandle
 * 传给后台 —— 消息通道的结构化克隆会把句柄变成空壳（方法全丢，只剩 name 都读不到），
 * 后台拿到后调 getFileHandle 会报 "is not a function"。
 * 唯一可靠的办法是页面自己把它写进 IndexedDB（同一个 chrome-extension:// 源，
 * 后台能读到），之后后台就能用这个句柄静默写文件。
 */
async function saveDirHandleToIDB(handle) {
  const DB_NAME = 'trace-subs';
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('translations')) {
        const s = d.createObjectStore('translations', { keyPath: 'key' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!d.objectStoreNames.contains('words')) {
        const w = d.createObjectStore('words', { keyPath: 'word' });
        w.createIndex('createdAt', 'createdAt');
      }
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: 'backupDir', handle, name: handle.name || '' });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** 从 IndexedDB 清掉目录句柄 */
async function clearDirHandleInIDB() {
  const DB_NAME = 'trace-subs';
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').delete('backupDir');
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
  db.close();
}

/** 刷新侧栏的目录状态（名称 / 权限 / 是否已设） */
async function refreshDirUI() {
  const btn = $('pickDirBtn');
  const label = $('pickDirLabel');
  const hint = $('bkHint');
  if (!btn) return;
  const r = await chrome.runtime.sendMessage({ type: 'backup:get-dir' }).catch(() => null);
  const d = r && r.ok ? r.data : { has: false };
  if (d && d.has) {
    btn.classList.add('set');
    label.textContent = d.name || '已选文件夹';
    hint.textContent =
      d.permission === 'granted' ? '备份会写到这个文件夹' : '权限已失效，点上方重新选择';
  } else {
    btn.classList.remove('set');
    label.textContent = '选择备份文件夹';
    // 自动备份只在有目录时才写；没目录时手动备份才落「下载」，这里说清楚，
    // 免得用户以为关掉了自动备份。
    hint.textContent = '还没选目录：自动备份会跳过，手动备份存到「下载」';
  }
}

$('pickDirBtn').addEventListener('click', async () => {
  if (typeof showDirectoryPicker !== 'function') {
    toast('当前浏览器不支持选择文件夹，备份会存到「下载」', 'err');
    return;
  }
  try {
    const handle = await showDirectoryPicker({ id: 'trace-backup', mode: 'readwrite' });
    // 句柄由页面直接写库（不能走消息通道，见 saveDirHandleToIDB 的注释）
    await saveDirHandleToIDB(handle);
    // 只把「名字」告诉后台，用于设置里显示
    await chrome.runtime.sendMessage({ type: 'backup:set-dir', name: handle.name });
    toast(`备份文件夹已设为「${handle.name}」`);
    await refreshDirUI();
    // 立刻写一次，让用户看到效果，也验证权限确实可用
    const b = await chrome.runtime.sendMessage({ type: 'backup:save' }).catch(() => null);
    if (b && b.ok) toast(`已备份 ${b.data.count} 个单词到「${handle.name}」`);
    else if (b && !b.ok) toast('写入失败：' + (b.error || '未知'), 'err');
  } catch (e) {
    // 用户取消选择框会抛 AbortError，不算错误
    if (e && (e.name === 'AbortError' || /abort/i.test(String(e)))) return;
    toast('选择文件夹失败：' + ((e && e.message) || e), 'err');
  }
});

// 自动备份开关
(async () => {
  const r = await chrome.runtime.sendMessage({ type: 'settings:get' }).catch(() => null);
  const st2 = (r && r.ok && r.data) || {};
  const cb = $('autoBackup');
  if (cb) {
    cb.checked = st2.autoBackup !== false;
    cb.addEventListener('change', async () => {
      await chrome.runtime.sendMessage({
        type: 'settings:set',
        patch: { autoBackup: cb.checked, autoBackupFails: 0 },
      });
      toast(cb.checked ? '已开启自动备份' : '已关闭自动备份');
    });
  }
  // 主题偏好：先读扩展设置（跨设备/跨次稳定），没有再用 localStorage
  // 的那份（内联脚本已经先应用过一次，避免闪白）
  if (st2.wbTheme === 'light' || st2.wbTheme === 'dark') {
    if (document.documentElement.dataset.theme !== st2.wbTheme) {
      applyTheme(st2.wbTheme, false);
    }
  } else {
    applyTheme(document.documentElement.dataset.theme || 'light', false);
  }
  await refreshDirUI();
})();

$('restoreBtn').addEventListener('click', async () => {
  // 优先：直接从「已选文件夹」里读那份备份，省得用户再翻文件
  const auto = await chrome.runtime.sendMessage({ type: 'backup:read-dir' }).catch(() => null);
  if (auto && auto.ok && auto.data && Array.isArray(auto.data.words)) {
    const n = auto.data.words.length;
    const ok = confirm(
      `在已选文件夹里找到备份（${n} 个单词，${String(auto.data.exportedAt || '').slice(0, 10)}）。\n\n点「确定」恢复；点「取消」改为手动选文件。`
    );
    if (ok) {
      try {
        const res = await doRestore(auto.data, false);
        toast(`已恢复：新增 ${res.added} 个，合并 ${res.merged} 个`);
        reload();
      } catch (e) {
        toast('恢复失败：' + ((e && e.message) || e), 'err');
      }
      return;
    }
  }

  // 手动选文件
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const n = Array.isArray(data.words) ? data.words.length : 0;
      const ok = confirm(`即将从「${file.name}」恢复 ${n} 个单词。\n\n点「确定」合并进现有生词本（同名单词保留更早的加入时间与更高的复习次数）；点「取消」放弃。`);
      if (!ok) return;
      const res = await doRestore(data, false);
      toast(`已恢复：新增 ${res.added} 个，合并 ${res.merged} 个`);
      reload();
    } catch (e) {
      toast('恢复失败：' + ((e && e.message) || e), 'err');
    }
  });
  input.click();
});

// 后台生词本变化时自动刷新（在 YouTube 页加词，看板这边立刻更新）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'words:changed') reload();
});

// ---------------------------------------------------------------- 启动

// 主题：内联脚本已经按 localStorage 设过一次，这里同步按钮文案
applyTheme(document.documentElement.dataset.theme || 'light', false);
reload();

