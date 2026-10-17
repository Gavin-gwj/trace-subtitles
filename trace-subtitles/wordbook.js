/* Trace —— 词库看板逻辑 */

const $ = (id) => document.getElementById(id);

const STATUS_LABEL = { new: '新词', learning: '记忆中', learned: '已记住' };
const STATUS_COLOR = { learned: '#46d39a', learning: '#f5a623', new: '#7d8798' };

let all = [];
let view = 'all'; // all | learned | learning | new
let gran = 'day'; // day | week | month
let sortBy = 'new';
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

// ---------------------------------------------------------------- 迷你折线

/** 在 SVG 里画一条带面积填充的折线（viewBox 120x26） */
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
      <stop offset="0%" stop-color="${color}" stop-opacity="0.26"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#${id})" stroke="none"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.4"
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
  const learned = all.filter((w) => w.status === 'learned').length;
  const learning = all.filter((w) => w.status === 'learning').length;
  const today = all.filter((w) => (w.createdAt || 0) >= todayStart).length;
  const yesterday = all.filter(
    (w) => (w.createdAt || 0) >= yesterdayStart && (w.createdAt || 0) < todayStart
  ).length;
  const week = all.filter((w) => (w.createdAt || 0) >= weekStart).length;
  const reviews = all.reduce((s, w) => s + (w.reviewCount || 0), 0);
  const rate = total ? Math.round((learned / total) * 100) : 0;

  $('kTotal').textContent = total;
  $('kLearned').textContent = learned;
  $('kLearning').textContent = learning;
  $('kToday').textContent = today;

  $('dTotal').innerHTML = `本周新增 <b class="up">+${week}</b>`;
  $('dLearned').innerHTML = `掌握率 <b class="${rate >= 50 ? 'up' : ''}">${rate}%</b>`;
  $('dLearning').innerHTML = `复习次数 <b>${reviews}</b>`;
  const delta = today - yesterday;
  $('dToday').innerHTML =
    `昨日 <b>${yesterday}</b>` +
    (yesterday > 0
      ? ` · <b class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${delta}</b>`
      : '');

  // 侧栏计数
  setCount($('cAll'), total);
  setCount($('cLearned'), learned);
  setCount($('cLearning'), learning);
  setCount($('cNew'), all.filter((w) => (w.status || 'new') === 'new').length);

  // 4 条迷你折线：总量累计 / 已记住累计 / 记忆中累计 / 每日新增
  const last14 = [];
  for (let i = 13; i >= 0; i--) {
    const from = todayStart - i * DAY;
    const to = from + DAY;
    last14.push(all.filter((w) => (w.createdAt || 0) >= from && (w.createdAt || 0) < to).length);
  }
  const cum = [];
  let acc = 0;
  for (const v of last14) {
    acc += v;
    cum.push(acc);
  }
  // 累计曲线起点应为「14 天前的存量」，让曲线形状真实
  const before = total - acc;
  const cumTotal = cum.map((v) => v + before);

  sparkline($('spTotal'), cumTotal, '#ffd76e');
  sparkline($('spLearned'), cumTotal.map((v) => Math.round(v * (rate / 100))), '#46d39a');
  sparkline($('spLearning'), last14.map((v) => v), '#f5a623');
  sparkline($('spToday'), last14, '#8b7ff0');

  $('subLine').textContent = total
    ? `共 ${total} 个单词 · 已记住 ${learned} · 记忆中 ${learning} · 今天新增 ${today}`
    : '还没有生词，去 YouTube 字幕里点一个词试试';
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
  const raw = Math.max(1, ...buckets.map((b) => b.count));
  const { max, ticks } = niceScale(raw);

  const lines = ticks
    .map((v) => {
      const p = (v / max) * 100;
      // 最上面那条线贴着容器顶，标签若仍放线上方会被裁掉（视觉上就像刻度丢了），
      // 所以顶部那条改成放在线下方
      const top = p >= 99 ? ' grid-top' : '';
      return `<div class="grid-line${top}" style="bottom:${p}%"><span>${v}</span></div>`;
    })
    .join('');

  const bars = buckets
    .map((b, i) => {
      const h = max ? (b.count / max) * 100 : 0;
      const empty = b.count === 0 ? ' bar-empty' : '';
      return `
      <div class="bar${empty}" style="--i:${i}">
        <div class="bar-tip">${b.full} · <b>${b.count}</b> 词</div>
        <div class="bar-fill" style="height:${Math.max(h, 1.5)}%"></div>
        ${b.label ? `<span class="bar-x">${b.label}</span>` : ''}
      </div>`;
    })
    .join('');

  box.innerHTML = lines + bars;

  const span =
    gran === 'day' ? '最近 30 天' : gran === 'week' ? '最近 12 周' : '最近 12 个月';
  const sum = buckets.reduce((s, b) => s + b.count, 0);
  const older = all.length - sum;
  $('chartSub').textContent =
    `${span} · 共 ${sum} 词` + (older > 0 ? ` · 另有 ${older} 词更早` : '');
}

// ---------------------------------------------------------------- 渲染：状态环

function renderDonut() {
  const total = all.length;
  const parts = ['learned', 'learning', 'new'].map((k) => ({
    k,
    n: all.filter((w) => (w.status || 'new') === k).length,
  }));

  const donut = $('donut');
  $('donutNum').textContent = total;

  if (!total) {
    donut.style.background = 'var(--ink-4)';
  } else {
    let acc = 0;
    const stops = parts
      .filter((p) => p.n > 0)
      .map((p) => {
        const from = (acc / total) * 100;
        acc += p.n;
        const to = (acc / total) * 100;
        return `${STATUS_COLOR[p.k]} ${from.toFixed(2)}% ${to.toFixed(2)}%`;
      })
      .join(', ');
    donut.style.background = `conic-gradient(${stops})`;
  }

  $('legend').innerHTML = parts
    .map(
      (p) => `
      <div class="lg" data-v="${p.k}">
        <span class="lg-dot" style="background:${STATUS_COLOR[p.k]}"></span>
        <span class="lg-name">${STATUS_LABEL[p.k]}</span>
        <span class="lg-val">${p.n}</span>
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
}

function visibleWords() {
  const q = ($('q').value || '').trim().toLowerCase();
  let list = all;

  if (view !== 'all') {
    list = list.filter((w) => (w.status || 'new') === view);
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
    new: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    old: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    az: (a, b) => (a.word || '').localeCompare(b.word || ''),
    rev: (a, b) => (b.reviewCount || 0) - (a.reviewCount || 0),
  }[sortBy];

  return list.slice().sort(by);
}

function renderRows() {
  const list = visibleWords();
  const box = $('rows');

  if (!list.length) {
    box.innerHTML = `
      <div class="empty big-empty">
        <div class="empty-mark">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>
          </svg>
        </div>
        <div>
          <div class="empty-title">${all.length ? '这个筛选下没有单词' : '词库还是空的'}</div>
          <div>${all.length ? '换个状态或清空搜索试试' : '在 YouTube 字幕里点击单词即可加入'}</div>
        </div>
      </div>`;
    return;
  }

  box.innerHTML = list
    .map((w, i) => {
      const st = w.status || 'new';
      return `
      <div class="wrow" data-w="${esc(w.word)}" style="--i:${Math.min(i, 14)}">
        <div class="w-ico">${esc((w.display || w.word || '?').charAt(0))}</div>
        <div class="w-word">
          <span class="w-txt">${esc(w.display || w.word)}</span>
          <span class="pill pill-${st}">${STATUS_LABEL[st]}</span>
        </div>
        <div class="w-phon">${esc(w.phonetic || '')}</div>
        <div class="w-zh">${esc(w.zh || w.context || '')}</div>
        <div class="w-date">${fmtDate(w.createdAt)}</div>
        <div class="w-act">
          <button class="act-rev" data-act="rev" title="标记复习">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          </button>
          <button class="act-del" data-act="del" title="删除">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
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
  });
}

// ---------------------------------------------------------------- 详情抽屉

function openDrawer(word) {
  const w = all.find((x) => x.word === word);
  if (!w) return;
  selected = w;

  $('dwWord').textContent = w.display || w.word;
  $('dwPhon').textContent = w.phonetic || '';

  const st = w.status || 'new';
  const ctx = w.context
    ? `<div class="dw-quote">
         ${highlightWord(w.context, w.display || w.word)}
         ${w.contextZh ? `<div class="q-zh">${highlightWord(w.contextZh, w.zh)}</div>` : ''}
       </div>`
    : '<div class="dw-quote" style="color:var(--text-4)">没有保存上下文</div>';

  $('dwBody').innerHTML = `
    <div class="dw-sec">
      <div class="dw-sec-hd">释义</div>
      <div class="dw-zh">${esc(w.zh || '—')}</div>
    </div>

    ${w.meanings && w.meanings.length ? `
    <div class="dw-sec">
      <div class="dw-sec-hd">英文释义</div>
      ${w.meanings.slice(0, 4).map((m) => `
        <div style="font-size:11.5px;color:var(--text-2);line-height:1.6;margin-bottom:6px">
          ${m.pos ? `<span style="font-family:var(--font-mono);font-size:10px;color:var(--gold);margin-right:5px">${esc(m.pos)}</span>` : ''}
          ${esc(m.def || '')}
        </div>`).join('')}
    </div>` : ''}

    <div class="dw-sec">
      <div class="dw-sec-hd">出现语境</div>
      ${ctx}
    </div>

    <div class="dw-sec">
      <div class="dw-sec-hd">记录</div>
      <div class="dw-meta">
        <div><div class="m-lbl">状态</div><div class="m-val"><span class="pill pill-${st}">${STATUS_LABEL[st]}</span></div></div>
        <div><div class="m-lbl">加入时间</div><div class="m-val">${fmtDate(w.createdAt)}</div></div>
        <div><div class="m-lbl">复习次数</div><div class="m-val">${w.reviewCount || 0}</div></div>
        <div><div class="m-lbl">上次复习</div><div class="m-val">${w.lastReview ? fmtDate(w.lastReview) : '—'}</div></div>
      </div>
    </div>

    ${w.videoTitle ? `
    <div class="dw-sec">
      <div class="dw-sec-hd">来源视频</div>
      <div style="font-size:11.5px;color:var(--text-2);line-height:1.55">${esc(w.videoTitle)}</div>
      ${w.time != null ? `<div style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-4);margin-top:3px">${fmtTime(w.time)}</div>` : ''}
    </div>` : ''}
  `;

  $('dwPlay').disabled = !w.videoId;
  $('dwPlay').style.opacity = w.videoId ? 1 : 0.4;

  $('drawer').classList.add('open');
  $('scrim').classList.add('on');
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
  selected = null;
}

// ---------------------------------------------------------------- 数据操作

async function reload() {
  const r = await chrome.runtime.sendMessage({ type: 'word:list' });
  all = r && r.ok ? r.data : [];
  renderKPIs();
  renderBars();
  renderDonut();
  renderRows();
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

$('q').addEventListener('input', renderRows);
$('sort').addEventListener('change', () => {
  sortBy = $('sort').value;
  renderRows();
});

$('scrim').addEventListener('click', closeDrawer);
$('dwClose').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

$('dwReview').addEventListener('click', () => {
  if (selected) revWord(selected.word);
});

$('dwPlay').addEventListener('click', () => {
  if (!selected || !selected.videoId) return;
  const t = Math.max(0, Math.floor(Number(selected.time) || 0));
  chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${selected.videoId}&t=${t}s` });
});

$('exportBtn').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'word:export' });
  const data = r && r.ok ? r.data : [];
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trace-words-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

// 后台生词本变化时自动刷新（在 YouTube 页加词，看板这边立刻更新）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'words:changed') reload();
});

// ---------------------------------------------------------------- 启动

reload();
