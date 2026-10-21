/* ============================================================================
   Trace 复习台 · review.js

   数据来源全部是 IndexedDB（经 bg.js 的消息通道），不联网。
   流程：取「到期待复习」的词 → 一张一张过 → 先看词、揭示释义、三档评级。
   每次评级都走 bg.js 的 word:rate，所以：
     - reviewCount / forgetCount / fuzzyCount / rememberCount 与生词本一致
     - 会落一条打卡流水（reviewlog），热力图与连续天数由此而来
   ========================================================================== */

const $ = (id) => document.getElementById(id);

const STATUS_LABEL = { new: '新词', learning: '记忆中', learned: '已记住' };
const SRC_LABEL = { llm: '大模型释义', google: '机器翻译', literal: '逐词直译' };
const DAY = 86400000;

// 与 wordbook.js 的间隔表保持一致：两页对「什么时候该复习」必须同一套算法，
// 否则看板说「今天到期 5 个」、复习台却排不出来，用户会以为坏了。
const INTERVAL_DAYS = [1, 2, 4, 7, 15, 30];

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

const st = (w) => w.status || 'new';
const isPhrase = (w) => w.kind === 'phrase';

/** 与 wordbook.js 完全同构的「是否到期」判定 */
function isDue(w) {
  if (st(w) === 'learned') return false;
  if (st(w) === 'new') return true;
  const base = w.lastReview || w.createdAt || 0;
  const gap = INTERVAL_DAYS[Math.min(w.reviewCount || 0, INTERVAL_DAYS.length - 1)] * DAY;
  return Date.now() - base >= gap;
}

function tally(w) {
  const forget = w.forgetCount || 0;
  const fuzzy = w.fuzzyCount || 0;
  const remember = w.rememberCount || 0;
  const reviews = w.reviewCount || 0;
  return { forget, fuzzy, remember, reviews, untagged: Math.max(0, reviews - forget - fuzzy - remember) };
}

function startOfDay(ts) {
  const d = new Date(ts || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 相对时间：只用于「最近复习」这种一眼扫的列表 */
function fmtAgo(ts) {
  const gap = Date.now() - ts;
  if (gap < 60000) return '刚刚';
  if (gap < 3600000) return `${Math.floor(gap / 60000)} 分钟前`;
  if (gap < DAY) return `${Math.floor(gap / 3600000)} 小时前`;
  const d = Math.floor(gap / DAY);
  if (d === 1) return `昨天 ${fmtTime(ts)}`;
  if (d < 30) return `${d} 天前`;
  return `${new Date(ts).getFullYear()}/${new Date(ts).getMonth() + 1}/${new Date(ts).getDate()}`;
}

// ---------------------------------------------------------------- 消息通道

function send(type, extra) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (res) => {
        void chrome.runtime.lastError;
        resolve(res && res.ok ? res.data : null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function toast(text, kind) {
  let el = $('wb-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'wb-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.dataset.kind = kind || 'ok';
  // 重新触发过渡：先摘掉 on，强制读一次布局
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('on'), 3200);
}

// ---------------------------------------------------------------- 主题

function applyTheme(next, animate) {
  const theme = next === 'dark' ? 'dark' : 'light';
  if (animate) {
    document.documentElement.classList.add('theme-anim');
    setTimeout(() => document.documentElement.classList.remove('theme-anim'), 420);
  }
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('wb-theme', theme); } catch (_) {}
  const lbl = $('themeLabel');
  if (lbl) lbl.textContent = theme === 'light' ? '深色' : '浅色';
  const btn = $('themeBtn');
  if (btn) btn.setAttribute('aria-label', theme === 'light' ? '切换到深色主题' : '切换到浅色主题');
}

// ---------------------------------------------------------------- 状态

let ALL = [];          // 全部生词
let STATS = null;      // 打卡统计
let QUEUE = [];        // 本轮队列（词对象）
let IDX = 0;           // 当前第几张（0 基）
let REVEALED = false;  // 当前卡是否已揭示
let SESSION = { forget: 0, fuzzy: 0, remember: 0 };  // 本轮三档计数
let GOAL = 20;
let BUSY = false;      // 评级请求在飞时锁住，防止连点记两次

// ---------------------------------------------------------------- 侧栏/统计

function renderStats() {
  const s = STATS || {};
  const due = ALL.filter(isDue);
  const dueNew = due.filter((w) => st(w) === 'new').length;
  const dueLearn = due.length - dueNew;
  const learned = ALL.filter((w) => st(w) === 'learned').length;

  $('kStreak').innerHTML = `${s.streak || 0}<span class="sm"> 天</span>`;
  $('dStreak').textContent = `最长 ${s.best || 0} 天`;

  $('kToday').innerHTML = `${s.todayCount || 0}<span class="sm"> 道</span>`;
  $('dToday').textContent = GOAL > 0 ? `目标 ${GOAL} 道` : '未设目标';

  $('kDue').innerHTML = `${due.length}<span class="sm"> 个</span>`;
  $('dDue').textContent = due.length
    ? `${dueNew} 个新词 · ${dueLearn} 个到期`
    : '今天没有到期的词';

  $('kAll').innerHTML = `${s.total || 0}<span class="sm"> 次</span>`;
  $('dAll').textContent = `已记住 ${learned} 个`;

  // 今日目标环
  const now = s.todayCount || 0;
  const ratio = GOAL > 0 ? Math.min(1, now / GOAL) : now > 0 ? 1 : 0;
  const C = 2 * Math.PI * 52;
  const fill = $('goalFill');
  if (fill) {
    fill.setAttribute('stroke-dasharray', C.toFixed(2));
    fill.setAttribute('stroke-dashoffset', (C * (1 - ratio)).toFixed(2));
  }
  $('goalNow').textContent = now;
  $('goalOf').textContent = GOAL > 0 ? `/ ${GOAL} 道` : '道';
  const gl = $('goalLbl');
  if (gl) {
    gl.textContent = GOAL <= 0
      ? (now > 0 ? '今天已练习' : '未设目标')
      : ratio >= 1
        ? '今天达标了'
        : now > 0
          ? `还差 ${GOAL - now} 道`
          : '今天还没开始';
  }

  $('stNow').textContent = s.streak || 0;
  $('stBest').textContent = s.best || 0;

  renderWeekDots();
  renderSub();
}

function renderWeekDots() {
  const box = $('weekDots');
  if (!box) return;
  const byDay = new Map();
  for (const d of (STATS && STATS.days) || []) byDay.set(d.day, d.n);
  // 本周一到今天；周末还没到的格子留空
  const today = new Date();
  const dow = (today.getDay() + 6) % 7; // 0=周一
  const cells = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(startOfDay() + (i - dow) * DAY);
    const key = dayKey(d.getTime());
    const n = byDay.get(key) || 0;
    const future = i > dow;
    const cls = future ? '' : n >= 10 ? 'best' : n > 0 ? 'on' : '';
    cells.push(`<i class="${cls}" title="${key}${future ? '' : ` · ${n} 道`}"></i>`);
  }
  box.innerHTML = cells.join('');
}

function renderSub() {
  const s = STATS || {};
  const due = ALL.filter(isDue).length;
  const parts = [];
  if (!ALL.length) {
    parts.push('生词本还是空的，先去字幕里点几个词');
  } else if (!due) {
    parts.push('今天没有到期的词，想多练可以重开一轮');
  } else {
    parts.push(`今天有 ${due} 个词等着你`);
  }
  if (s.todayCount) parts.push(`已复习 ${s.todayCount} 道`);
  if (s.streak) parts.push(`连续 ${s.streak} 天`);
  $('subLine').textContent = parts.join(' · ');
}

// ---------------------------------------------------------------- 队列

function buildQueue() {
  const due = ALL.filter(isDue);
  // 越久没碰的排前面；同一时间加入的按加入顺序。
  // 不用随机：复习顺序不稳定的话，用户会觉得「怎么又抽到这个」。
  due.sort((a, b) => {
    const ka = a.lastReview || a.createdAt || 0;
    const kb = b.lastReview || b.createdAt || 0;
    if (ka !== kb) return ka - kb;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  QUEUE = due;
  IDX = 0;
  REVEALED = false;
  SESSION = { forget: 0, fuzzy: 0, remember: 0 };
}

function buildProg() {
  const box = $('prog');
  if (!box) return;
  const n = QUEUE.length;
  // 词多的时候不画 200 个格子：一是 DOM 太重，二是细到看不清反而没意义
  if (n > 24) {
    box.className = 'prog bar';
    box.innerHTML = '<i style="width:0%"></i>';
  } else {
    box.className = 'prog';
    box.innerHTML = QUEUE.map((_, i) => `<i class="${i < IDX ? 'done' : i === IDX ? 'now' : ''}"></i>`).join('');
  }
  $('progLbl').innerHTML = n
    ? `第 <b>${Math.min(IDX + 1, n)}</b> / <b>${n}</b> 个`
    : '没有待复习的词';
}

function paintProg() {
  const box = $('prog');
  if (!box) return;
  if (box.classList.contains('bar')) {
    const pct = QUEUE.length ? Math.round((IDX / QUEUE.length) * 100) : 0;
    box.firstElementChild.style.width = `${pct}%`;
  } else {
    [...box.children].forEach((el, i) => {
      el.className = i < IDX ? 'done' : i === IDX ? 'now' : '';
    });
  }
  $('progLbl').innerHTML = `第 <b>${Math.min(IDX + 1, QUEUE.length)}</b> / <b>${QUEUE.length}</b> 个`;
}

// ---------------------------------------------------------------- 卡片

function current() {
  return QUEUE[IDX] || null;
}

function renderCard() {
  const w = current();
  const fc = $('fc');
  const front = $('fcFront');
  const back = $('fcBack');
  const deck = $('deck');
  if (!fc || !front || !back) return;

  if (!w) {
    // 队列走完：卡片区不再显示词，交给 renderFinish() 接管 acts。
    // 这里保留空壳是为了让「本轮完成」面板有位置落。
    fc.style.display = 'none';
    deck.classList.remove('stacked');
    return;
  }
  fc.style.display = '';
  fc.dataset.revealed = REVEALED ? '1' : '0';
  fc.setAttribute('aria-label', REVEALED ? '复习卡片，点击或按空格回到正面' : '复习卡片，点击或按空格查看释义');
  // 后面还有词才画「叠着的牌」
  deck.classList.toggle('stacked', QUEUE.length - IDX > 1);

  const phrase = isPhrase(w);
  const meta = [];
  if (phrase) {
    meta.push(`<span class="fc-tag">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h9"/></svg>
      短语</span>`);
  }
  if (w.videoTitle) {
    // 不在这里数长度截断：卡宽是自适应的（桌面 1000px、窄窗 500px），
    // 写死 26 个字在宽屏上会白白扔掉一半标题。交给 CSS 的 ellipsis，
    // 它按真实可用宽度决定截在哪，title 保留全称供悬停查看。
    meta.push(`<span class="fc-note" title="${esc(w.videoTitle)}">来自 ${esc(w.videoTitle)}</span>`);
  }

  const big = (w.display || w.word || '').length > 16;

  // 音标单独占一行，不塞进 .fc-word 内部：
  // 一来它是 14px 等宽、词是 40px 比例字体，混在一个盒子里的基线对不齐；
  // 二来 .fc-word 的文本必须只有那个词本身（读屏、复制、测试取词都依赖它）。
  front.innerHTML = `
    <div class="fc-meta">${meta.join('')}</div>
    <div class="fc-main">
      <div class="fc-word${big ? ' small' : ''}">${esc(w.display || w.word)}</div>
      ${!phrase && w.phonetic ? `<div class="fc-phon">${esc(w.phonetic)}</div>` : ''}
    </div>
    <div class="fc-hint">想不起来也没关系，先猜一下</div>
  `;

  // ---- 背面
  const t = tally(w);
  const blocks = [];

  // 释义：短语给整段，单词给前几个义项
  if (phrase) {
    if (w.zh) blocks.push(`<div class="fc-zh">${esc(w.zh)}</div>`);
    if (w.literal) blocks.push(`<div class="fc-literal">直译：${esc(w.literal)}</div>`);
    if (Array.isArray(w.words) && w.words.length) {
      blocks.push(`<div class="fc-literal">${w.words.map((x) => esc(typeof x === 'string' ? x : x && x.word)).join(' · ')}</div>`);
    }
  } else {
    const zh = (w.zh || '').trim();
    if (zh) blocks.push(`<div class="fc-zh">${esc(zh)}</div>`);
    const ms = Array.isArray(w.meanings) ? w.meanings.slice(0, 3) : [];
    if (ms.length) {
      blocks.push(`<div class="fc-literal">${ms
        .map((m) => {
          if (typeof m === 'string') return esc(m);
          const pos = m && m.pos ? `<span class="fc-pos">${esc(m.pos)}</span>` : '';
          const def = m && (m.def || m.meaning) ? (m.def || m.meaning) : '';
          return `${pos}${esc(def)}`;
        })
        .filter(Boolean)
        .join('<br />')}</div>`);
    }
  }

  // 原句：有 context 才画，没有就整块不出现（空框比没有更糟）
  if (w.context) {
    const sentence = esc(w.context);
    const q = w.contextZh ? `<div class="q-zh">${esc(w.contextZh)}</div>` : '';
    blocks.push(`<div class="fc-quote">${sentence}${q}</div>`);
  }
  if (w.videoTitle) {
    blocks.push(`<div class="fc-src">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z"/><path d="M10 9l5 3-5 3z"/></svg>
      ${esc(w.videoTitle)}</div>`);
  }
  // 这一格的「记忆底子」：提示这是第几次、之前错过几次。
  // 放在最下面，因为用户先要知道词义，才关心历史。
  if (t.reviews) {
    blocks.push(`<div class="fc-literal">第 ${t.reviews + 1} 次复习 · 之前忘记 ${t.forget} 次 · 模糊 ${t.fuzzy} 次</div>`);
  }

  back.innerHTML = blocks.join('');
}

function renderActs() {
  const acts = $('acts');
  if (!acts) return;
  const w = current();

  if (!w) {
    acts.innerHTML = renderFinish();
    bindFinish();
    return;
  }

  if (!REVEALED) {
    acts.innerHTML = `
      <div class="acts-reveal">
        <button type="button" class="btn-reveal" id="revealBtn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3.2"/></svg>
          看释义
          <span class="kbd">空格</span>
        </button>
      </div>`;
    $('revealBtn').addEventListener('click', reveal);
    return;
  }

  acts.innerHTML = `
    <div class="rates">
      <button type="button" class="rate rate-forget" data-rate="forget">
        <span class="r-ico">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 14.5 5 19"/><path d="M14.5 9.5 19 5"/><path d="M5 5l14 14"/></svg>
        </span>
        <span class="r-txt"><span class="r-name">忘记了</span><span class="r-hint">明天再来</span></span>
        <span class="r-k">1</span>
      </button>
      <button type="button" class="rate rate-fuzzy" data-rate="fuzzy">
        <span class="r-ico">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z"/><path d="M8.5 10.5h.01M15.5 10.5h.01"/><path d="M9 15.5c.9-.7 2-.9 3-.9s2.1.2 3 .9"/></svg>
        </span>
        <span class="r-txt"><span class="r-name">模糊</span><span class="r-hint">继续温习</span></span>
        <span class="r-k">2</span>
      </button>
      <button type="button" class="rate rate-remember" data-rate="remember">
        <span class="r-ico">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6.5 9.5 17 4 11.5"/></svg>
        </span>
        <span class="r-txt"><span class="r-name">记住了</span><span class="r-hint">标记已记住</span></span>
        <span class="r-k">3</span>
      </button>
    </div>`;
  acts.querySelectorAll('.rate').forEach((b) => {
    b.addEventListener('click', () => rate(b.dataset.rate));
  });
}

function renderFinish() {
  const total = SESSION.forget + SESSION.fuzzy + SESSION.remember;
  const done = STATS && STATS.todayCount ? STATS.todayCount : 0;
  const goalHit = GOAL > 0 && done >= GOAL;

  if (!QUEUE.length) {
    // 队列本来就是空的：不是「做完了」，是「今天没得做」。文案必须区分，
    // 否则用户会以为刚才那一轮把词都清空了。
    return `
      <div class="finish">
        <div class="finish-mark">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21z"/><path d="M4 18.5V5.5"/><path d="M9.5 8.5h5M9.5 12h5"/></svg>
        </div>
        <div class="finish-title">今天没有到期的词</div>
        <div class="finish-sub">${ALL.length
          ? '这几个词都还在记忆保鲜期里。想多练一轮可以点「重开一轮」，把整个生词本再过一遍。'
          : '生词本还是空的。先在 YouTube 字幕里点几个不认识的词，它们会自动排进这里。'}</div>
        <div class="finish-acts">
          ${ALL.length
            ? '<button type="button" class="tool tool-key" id="finishAll">重开一轮（全部生词）</button>'
            : ''}
          <a class="tool" href="wordbook.html">打开生词本</a>
        </div>
      </div>`;
  }

  return `
    <div class="finish">
      <div class="finish-mark">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6.5 9.5 17 4 11.5"/></svg>
      </div>
      <div class="finish-title">本轮复习完成</div>
      <div class="finish-sub">${goalHit
        ? `今天已经复习了 ${done} 道，目标达成。明天这些词会按记忆间隔自动排回来。`
        : `这一轮过了 ${total} 个词。${GOAL > 0 ? `今天还差 ${Math.max(0, GOAL - done)} 道达标。` : ''}明天它们会按记忆间隔自动排回来。`}</div>
      <div class="finish-sum">
        <div class="is-f"><b>${SESSION.forget}</b><span>忘记了</span></div>
        <div class="is-z"><b>${SESSION.fuzzy}</b><span>模糊</span></div>
        <div class="is-r"><b>${SESSION.remember}</b><span>记住了</span></div>
      </div>
      <div class="finish-acts">
        <button type="button" class="tool" id="finishRestart">再来一轮</button>
        <a class="tool tool-key" href="wordbook.html">打开生词本</a>
      </div>
    </div>`;
}

function bindFinish() {
  const again = $('finishRestart') || $('finishAll');
  if (again) {
    again.addEventListener('click', async () => {
      await reload();
      buildQueue();
      if (!QUEUE.length && ALL.length) {
        // 「再来一轮」时如果按到期规则排不出东西，就退化成整库打乱重过，
        // 否则按钮点下去毫无反应 —— 那是最糟的交互
        QUEUE = ALL.slice().sort(() => Math.random() - 0.5);
        IDX = 0;
        REVEALED = false;
        SESSION = { forget: 0, fuzzy: 0, remember: 0 };
      }
      renderAll();
    });
  }
}

function reveal() {
  if (!QUEUE.length || REVEALED) return;
  REVEALED = true;
  const fc = $('fc');
  if (fc) fc.dataset.revealed = '1';
  renderActs();
}

function hide() {
  if (!REVEALED) return;
  REVEALED = false;
  const fc = $('fc');
  if (fc) fc.dataset.revealed = '0';
  renderActs();
}

// ---------------------------------------------------------------- 评级

async function rate(grade) {
  const w = current();
  if (!w || BUSY || !REVEALED) return;
  BUSY = true;
  const btn = document.querySelector(`.rate[data-rate="${grade}"]`);
  if (btn) {
    btn.classList.remove('flash');
    void btn.offsetWidth;
    btn.classList.add('flash');
  }

  const key = String(w.word || '').toLowerCase();
  const rec = await send('word:rate', { word: key, grade });

  BUSY = false;
  if (!rec) {
    toast('记录失败，再试一次', 'err');
    return;
  }

  SESSION[grade] += 1;
  // 用服务端返回的记录覆盖队列里那份，这样「第 N 次复习 / 之前忘记 N 次」
  // 下次出现时是新的；同时 ALL 里那份也要同步，否则统计条不更新。
  Object.assign(w, rec);
  const at = ALL.findIndex((x) => String(x.word).toLowerCase() === key);
  if (at >= 0) Object.assign(ALL[at], rec);

  IDX += 1;
  REVEALED = false;

  // 每评一次都重算统计：连续天数、今日进度、热力图都随之变化。
  // 不重新拉 word:list —— 词义没变，没必要整库重读。
  STATS = await send('review:stats');
  if (!STATS) STATS = { days: [], total: 0, todayCount: 0, streak: 0, best: 0 };
  renderStats();
  renderHeatmap();
  renderDist();
  renderRecent();

  if (IDX >= QUEUE.length) {
    renderCard();
    renderActs();
    paintProg();
  } else {
    renderCard();
    renderActs();
    paintProg();
  }
}

// ---------------------------------------------------------------- 热力图

function renderHeatmap() {
  const grid = $('hmGrid');
  const months = $('hmMonths');
  if (!grid) return;

  const byDay = new Map();
  for (const d of (STATS && STATS.days) || []) byDay.set(d.day, d.n);

  const today = startOfDay();
  const dow = (new Date(today).getDay() + 6) % 7;   // 0=周一
  const thisMonday = today - dow * DAY;
  const WEEKS = 26;
  const start = thisMonday - (WEEKS - 1) * 7 * DAY;

  // 分档阈值：0 / 1-4 / 5-9 / 10-19 / 20+
  // 用绝对道数而不是分位数：分位数会让「昨天 12 道」在不同时期显示成不同深浅，
  // 用户回头翻历史时会觉得颜色不可信。
  const level = (n) => (n <= 0 ? 0 : n < 5 ? 1 : n < 10 ? 2 : n < 20 ? 3 : 4);

  const cells = [];
  const monthLabels = [];
  let lastMonth = -1;
  for (let wI = 0; wI < WEEKS; wI += 1) {
    for (let dI = 0; dI < 7; dI += 1) {
      const ts = start + (wI * 7 + dI) * DAY;
      const key = dayKey(ts);
      const future = ts > today;
      const n = byDay.get(key) || 0;
      const cls = future ? 'hm-cell pad' : `hm-cell lv${level(n)}${ts === today ? ' today' : ''}`;
      cells.push(`<div class="${cls}" title="${key}${future ? '' : ` · ${n} 道`}"></div>`);
      if (dI === 0) {
        const m = new Date(ts).getMonth();
        if (m !== lastMonth) {
          monthLabels.push({ col: wI + 1, text: `${m + 1} 月` });
          lastMonth = m;
        }
      }
    }
  }
  grid.style.setProperty('--hm-weeks', WEEKS);
  grid.innerHTML = cells.join('');

  if (months) {
    months.style.setProperty('--hm-weeks', WEEKS);
    // 每个月份标签占一列；用 span 的 grid-column 起点定位，空列不写内容。
    // 相邻月份只隔 4 周时两个标签会挤在一起，所以给一个最小间隔判断。
    let lastCol = -9;
    months.innerHTML = monthLabels
      .filter((m) => {
        if (m.col - lastCol < 4) return false;
        lastCol = m.col;
        return true;
      })
      .map((m) => `<span style="grid-column: ${m.col} / span 4">${m.text}</span>`)
      .join('');
  }

  const foot = $('hmFoot');
  if (foot) {
    const s = STATS || {};
    const active = s.activeDays || 0;
    foot.innerHTML = `
      <span>共打卡 <b>${active}</b> 天</span>
      <span>累计 <b>${s.total || 0}</b> 道</span>
      <span>最后打卡 <b>${s.lastDay || '—'}</b></span>`;
  }
  const sub = $('hmSub');
  if (sub) sub.textContent = `最近 ${WEEKS} 周 · 每格是一个自然日`;
}

// ---------------------------------------------------------------- 面板

function renderDist() {
  const box = $('dist');
  if (!box) return;
  const t = ALL.reduce(
    (acc, w) => {
      const x = tally(w);
      acc.forget += x.forget;
      acc.fuzzy += x.fuzzy;
      acc.remember += x.remember;
      return acc;
    },
    { forget: 0, fuzzy: 0, remember: 0 }
  );
  const total = t.forget + t.fuzzy + t.remember;
  if (!total) {
    box.innerHTML = `<div class="dist-empty">
      <span class="empty-ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V9M10 20V4M16 20v-7M22 20H2"/></svg></span>
      <span class="empty-hint">还没有评级记录。复习时点「忘记了 / 模糊 / 记住了」，这里会显示你更常在哪一档上卡住。</span>
    </div>`;
    const sub = $('distSub');
    if (sub) sub.textContent = '全部生词合计';
    return;
  }
  const rows = [
    { k: 'forget', n: t.forget, label: '忘记了', color: 'var(--red)' },
    { k: 'fuzzy', n: t.fuzzy, label: '模糊', color: 'var(--amber)' },
    { k: 'remember', n: t.remember, label: '记住了', color: 'var(--green)' },
  ];
  box.innerHTML = rows
    .map((r) => {
      const pct = Math.round((r.n / total) * 100);
      return `<div class="dist-row">
        <span class="dist-name"><i style="background: ${r.color}"></i>${r.label}</span>
        <span class="dist-bar"><i style="width: ${pct}%; background: ${r.color}"></i></span>
        <span class="dist-val"><b>${r.n}</b> · ${pct}%</span>
      </div>`;
    })
    .join('');
  const sub = $('distSub');
  if (sub) sub.textContent = `全部生词合计 ${total} 次`;
}

function renderRecent() {
  const box = $('recent');
  if (!box) return;
  // 用词表里的 lastReview 而不是流水：流水可能有几万条，这里只列最近 6 个词。
  const items = ALL.filter((w) => w.lastReview)
    .sort((a, b) => (b.lastReview || 0) - (a.lastReview || 0))
    .slice(0, 6);
  if (!items.length) {
    box.innerHTML = `<div class="recent-empty">
      <span class="empty-ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.1 1.9"/></svg></span>
      <span class="empty-hint">还没有复习记录。评过级的词会按时间倒序排在这里，最多显示 6 个。</span>
    </div>`;
    return;
  }
  const color = (w) => {
    const s = st(w);
    return s === 'learned' ? 'var(--green)' : s === 'learning' ? 'var(--red)' : 'var(--slate)';
  };
  box.innerHTML = items
    .map(
      (w) => `<div class="recent-row">
        <span class="recent-dot" style="background: ${color(w)}"></span>
        <span class="recent-w" title="${esc(w.display || w.word)}">${esc(w.display || w.word)}</span>
        <span class="recent-t">${fmtAgo(w.lastReview)}</span>
      </div>`
    )
    .join('');
}

// ---------------------------------------------------------------- 载入

function renderAll() {
  renderStats();
  buildProg();
  renderCard();
  renderActs();
  renderHeatmap();
  renderDist();
  renderRecent();
}

async function reload() {
  const [words, stats] = await Promise.all([send('word:list'), send('review:stats')]);
  ALL = Array.isArray(words) ? words : [];
  STATS = stats || { days: [], total: 0, todayCount: 0, streak: 0, best: 0 };
}

async function boot() {
  // 主题：先读设置里的 wbTheme（与生词本同一份），没有再用 localStorage。
  // 顺序很重要 —— 内联在 head 的脚本已按 localStorage 上过色，这里只做校正。
  try {
    const stg = await send('settings:get');
    if (stg) {
      if (stg.wbTheme === 'light' || stg.wbTheme === 'dark') applyTheme(stg.wbTheme, false);
      if (typeof stg.reviewGoal === 'number') GOAL = stg.reviewGoal;
    }
  } catch (_) {}

  await reload();
  buildQueue();
  renderAll();
}

// ---------------------------------------------------------------- 事件

$('themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next, true);
  chrome.runtime.sendMessage({ type: 'settings:set', patch: { wbTheme: next } });
});

$('restartBtn').addEventListener('click', async () => {
  await reload();
  buildQueue();
  if (!QUEUE.length && ALL.length) {
    QUEUE = ALL.slice().sort(() => Math.random() - 0.5);
    IDX = 0;
    REVEALED = false;
    SESSION = { forget: 0, fuzzy: 0, remember: 0 };
  } else if (!QUEUE.length) {
    toast('生词本还是空的，先去字幕里点几个词', 'err');
    return;
  }
  renderAll();
  toast(`重开一轮 · 共 ${QUEUE.length} 个词`);
});

$('fc').addEventListener('click', () => {
  if (!QUEUE.length) return;
  if (REVEALED) hide();
  else reveal();
});

$('fc').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (!QUEUE.length) return;
    if (REVEALED) hide();
    else reveal();
  }
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const map = { 1: 'forget', 2: 'fuzzy', 3: 'remember' };
  if (map[e.key]) {
    e.preventDefault();
    if (!REVEALED) {
      // 还没看释义就评级等于瞎猜。先揭示，让第二个按键才是真正的作答。
      reveal();
      return;
    }
    rate(map[e.key]);
    return;
  }
  if (e.key === ' ' || e.key === 'Enter') {
    // 空格在 revealBtn 上已经被按钮自己处理（避免双重触发）
    if (e.target && e.target.id === 'revealBtn') return;
    if (!QUEUE.length) return;
    e.preventDefault();
    if (REVEALED) hide();
    else reveal();
  }
});

// 别的标签页加了词 / 改了状态 → 静默刷新词表，但不动当前进度。
// 不能直接重排队列：用户正看着第 7 张，别人加个词就把他弹回第 1 张会很恼人。
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'words:changed') {
    send('word:list').then((words) => {
      if (Array.isArray(words) && words.length) {
        ALL = words;
        renderStats();
        renderDist();
        renderRecent();
      }
    });
  }
});

boot();
