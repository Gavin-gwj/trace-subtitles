/**
 * 查词延迟基准：对比「串行旧策略」与「并发新策略」。
 *
 * 只测词典阶段（Datamuse + dictionaryapi.dev），不涉及 Google 翻译。
 * 用法：node tools/bench-dict.mjs [词...]
 */

const WORDS =
  process.argv.length > 2
    ? process.argv.slice(2)
    : ['vessel', 'pick', 'chill', 'beverage', 'calling', 'making', 'brutal', 'vintage'];

async function fetchT(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const dm = (w, ms) =>
  fetchT(`https://api.datamuse.com/words?sp=${encodeURIComponent(w)}&md=dpr&max=1`, ms);
const da = (w, ms) =>
  fetchT(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`, ms);

/** 旧策略：先 Datamuse(4s)，needMore 恒真（normal 档要例句）→ 再 dictionaryapi(3.5s) */
async function oldStrategy(w) {
  const t0 = Date.now();
  const d = await dm(w, 4000);
  const dmOk = Array.isArray(d) && d[0] && String(d[0].word).toLowerCase() === w.toLowerCase();
  const meanings = dmOk ? (d[0].defs || []).length : 0;
  const phonetic = dmOk && (d[0].tags || []).some((t) => t.startsWith('pron:'));
  const needMore = !phonetic || meanings < 2 || true; // preset.wantExample === true
  if (needMore) await da(w, 3500);
  return Date.now() - t0;
}

/** 新策略：两源并发 + 「Datamuse 够用就只给 dictionaryapi 900ms 宽限」 */
async function newStrategy(w) {
  const t0 = Date.now();
  const dmP = dm(w, 3000).catch(() => null);
  const daP = da(w, 2500).catch(() => null);

  const d = await dmP;
  const e = Array.isArray(d) ? d[0] : null;
  const hit = e && String(e.word || '').toLowerCase() === w.toLowerCase();
  const phonetic = hit && (e.tags || []).some((t) => t.startsWith('pron:'));
  const meanings = hit ? (e.defs || []).length : 0;
  const goodEnough = phonetic && meanings >= 2;

  if (goodEnough) {
    await Promise.race([daP, new Promise((r) => setTimeout(r, 900))]);
  } else {
    await daP;
  }
  return Date.now() - t0;
}

const rows = [];
for (const w of WORDS) {
  // 交替顺序，减少缓存/限流带来的顺序偏差
  const a = await oldStrategy(w);
  const b = await newStrategy(w);
  rows.push({ w, old: a, nw: b });
  console.log(
    `${w.padEnd(10)} 旧=${String(a).padStart(5)}ms   新=${String(b).padStart(5)}ms   省 ${String(a - b).padStart(5)}ms`
  );
}

const sum = rows.reduce(
  (acc, r) => ({ old: acc.old + r.old, nw: acc.nw + r.nw }),
  { old: 0, nw: 0 }
);
console.log('\n--- 合计 ---');
console.log(`旧策略 ${sum.old}ms / 平均 ${Math.round(sum.old / rows.length)}ms`);
console.log(`新策略 ${sum.nw}ms / 平均 ${Math.round(sum.nw / rows.length)}ms`);
console.log(`平均每词省 ${Math.round((sum.old - sum.nw) / rows.length)}ms`);
console.log(`最慢单词：旧 ${Math.max(...rows.map((r) => r.old))}ms → 新 ${Math.max(...rows.map((r) => r.nw))}ms`);
