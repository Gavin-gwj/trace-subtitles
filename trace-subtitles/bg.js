/**
 * Trace 字幕翻译 —— 后台 Service Worker
 *
 * 职责：
 *   1. 翻译引擎适配（Google 免费接口 / MyMemory 兜底），批量翻译 + 并发控制 + 重试
 *   2. 翻译缓存（IndexedDB，按 文本哈希 + 目标语言 存），避免重复请求
 *   3. 生词本 / 设置的存储与查询
 *
 * 注意：MV3 service worker 会随时休眠，所有状态都放 IndexedDB / chrome.storage。
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  targetLang: 'zh-CN',
  sourceLang: 'auto',
  mode: 'bilingual', // bilingual | translation-only | original-only
  fontScale: 1,
  position: 18, // 距底部百分比（仅在未自由拖动时生效）
  freePos: null, // 自由拖动后的 {x, y} 像素坐标；null 表示用 position 的默认底部居中
  engine: 'google',
  autoHideNative: true,
  clickWord: true,
  // ---- 字幕样式（页内设置面板可实时调整）----
  origSize: 28, // 原文字号 px
  transSize: 21, // 译文字号 px
  origColor: '#ffffff',
  transColor: '#ebebeb',
  bgAlpha: 0.55, // 背景不透明度 0~0.95
  radius: 12, // 圆角 px
  blur: 18, // 高斯模糊 px
  showLauncher: true, // 播放器右下角悬浮按钮
};

// ---------------------------------------------------------------- 网络工具

/**
 * 带超时的 fetch。
 * 必须用：某些公开 API（例如 dictionaryapi.dev 对个别词）会永久挂住，
 * 不设超时会让整个查词/翻译流程卡死，表现为界面一直"查询中…"。
 */
async function fetchT(url, init = {}, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 设置

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// ---------------------------------------------------------------- IndexedDB

const DB_NAME = 'trace-subs';
const DB_VER = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('translations')) {
        const s = db.createObjectStore('translations', { keyPath: 'key' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('words')) {
        const w = db.createObjectStore('words', { keyPath: 'word' });
        w.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClear(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------- 翻译引擎

const LANG_MAP = {
  'zh-CN': 'zh-CN', zh: 'zh-CN', 'zh-TW': 'zh-TW', en: 'en', ja: 'ja',
  ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru', pt: 'pt',
  it: 'it', ar: 'ar', th: 'th', vi: 'vi', id: 'id', tr: 'tr',
};

function normLang(l) {
  if (!l || l === 'auto') return 'auto';
  const base = l.split('-')[0];
  return LANG_MAP[l] || LANG_MAP[base] || l;
}

/**
 * Google 免费端点：支持一次多 q，按行返回。
 * 这是 Trancy 这类插件最常用的零成本方案。
 *
 * 实测坑（真实视频里会踩到）：
 *  1. 某些情况下它返回 200 + 空数组/空串，**不抛错**。若直接把它当译文，
 *     界面上就是"只有原文、没有译文"，而且永远不会触发降级 —— 必须主动校验。
 *  2. 原文里偶发的孤立代理项（被截断的 emoji）会让 encodeURIComponent 抛
 *     URIError，整批请求直接失败。
 *  3. sl 猜错时会"原样返回"（例如中文视频被当成 zh→zh），表现为没有翻译。
 */

/** 去掉孤立代理项，避免 encodeURIComponent 抛 URIError */
function sanitizeForQuery(s) {
  return String(s).replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    ''
  );
}

/** 请求一次 Google 端点，返回按顺序的译文数组；结构异常时抛错 */
async function googleOnce(texts, sl, tl, host, client) {
  const url =
    `https://${host}/translate_a/t?client=${client}` +
    `&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t`;

  const body = texts.map((t) => 'q=' + encodeURIComponent(sanitizeForQuery(t))).join('&');
  const res = await fetchT(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
    },
    10000
  );
  if (!res.ok) throw new Error('google http ' + res.status);

  const json = await res.json();
  // 返回形如 ["译1","译2"] 或 [["译1","en"],["译2","en"]]
  const arr = Array.isArray(json) ? json : [];
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    const item = arr[i];
    if (item == null) out.push('');
    else if (typeof item === 'string') out.push(item);
    else if (Array.isArray(item)) out.push(String(item[0] ?? ''));
    else out.push('');
  }
  return out;
}

async function googleTranslate(texts, source, target) {
  const tl = normLang(target);
  const wanted = source === 'auto' ? 'auto' : normLang(source);

  // 依次尝试：主端点 → 备用主机 → 备用 client
  const plans = [
    ['translate.googleapis.com', 'gtx', wanted],
    ['clients5.google.com', 'dict-chrome-ex', wanted],
    // 指定源语言时如果"原样返回"，说明语言猜错了，再用 auto 试一次
    ['translate.googleapis.com', 'gtx', wanted === 'auto' ? null : 'auto'],
  ];

  let last = null;
  for (const [host, client, sl] of plans) {
    if (!sl) continue;
    let out;
    try {
      out = await googleOnce(texts, sl, tl, host, client);
    } catch (_) {
      continue;
    }
    last = out;
    const got = out.filter((s) => s && s.trim()).length;
    if (!got) continue; // 全空 → 换下一个方案
    // 译文和原文完全一样，且源语言不是 auto：疑似语言猜错，继续试 auto
    const sameAsInput =
      sl !== 'auto' && out.every((s, i) => s === texts[i] || !s);
    if (sameAsInput && plans.some((p) => p[2] === 'auto')) continue;
    return out;
  }

  // 全都拿不到有效译文 → 抛错，交给 MyMemory 兜底
  if (last && last.some((s) => s && s.trim())) return last;
  throw new Error('google returned empty translation');
}

/** MyMemory 兜底：单条请求，有每日额度 */
async function myMemoryTranslate(text, source, target) {
  const sl = source === 'auto' ? 'en' : normLang(source);
  const tl = normLang(target);
  const url =
    'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(text) +
    `&langpair=${encodeURIComponent(sl)}%7C${encodeURIComponent(tl)}`;
  const res = await fetchT(url, {}, 10000);
  if (!res.ok) throw new Error('mymemory http ' + res.status);
  const json = await res.json();
  return String(json?.responseData?.translatedText || '');
}

async function translateBatch(texts, source, target) {
  const engine = (await getSettings()).engine;
  if (engine === 'mymemory') {
    return myMemoryAll(texts, source, target);
  }

  // 默认 google。真实视频动辄几百句，Google 可能中途限流（429）或返回空，
  // 所以这里做"整批 → 对半拆 → 单条兜底"的逐级降级，保证尽量每句都有译文。
  let out = await googleChunked(texts, source, target);

  // 剩下没翻出来的，用 MyMemory 逐条补（限流时这条能救回大部分）
  const missing = [];
  out.forEach((s, i) => {
    if (!s || !String(s).trim()) missing.push(i);
  });
  if (missing.length) {
    console.info(`[Trace bg] ${missing.length}/${texts.length} 句无译文，改用 MyMemory 兜底`);
    const extra = await myMemoryAll(
      missing.map((i) => texts[i]),
      source,
      target,
      60 // 每批最多补 60 句，避免一次视频把额度打光
    );
    missing.forEach((idx, k) => {
      if (extra[k] && extra[k].trim()) out[idx] = extra[k];
    });
  }
  return out;
}

/** Google 分批翻译：整批失败就对半拆，最小到单条 */
async function googleChunked(texts, source, target) {
  if (!texts.length) return [];
  try {
    const out = await googleTranslate(texts, source, target);
    const okCount = out.filter((s) => s && s.trim()).length;
    // 全部翻出，或只剩极少（可能是真的没内容），直接返回
    if (okCount >= Math.ceil(texts.length * 0.6)) return out;
    if (texts.length === 1) return out;
  } catch (_) {
    if (texts.length === 1) return [''];
  }

  // 对半拆开重试
  const mid = Math.ceil(texts.length / 2);
  const left = await googleChunked(texts.slice(0, mid), source, target);
  await new Promise((r) => setTimeout(r, 150));
  const right = await googleChunked(texts.slice(mid), source, target);
  return left.concat(right);
}

/** MyMemory 逐条翻译（慢但稳），limit 控制最多翻多少条 */
async function myMemoryAll(texts, source, target, limit = Infinity) {
  const out = [];
  const n = Math.min(texts.length, limit);
  for (let i = 0; i < n; i++) {
    let txt = '';
    for (let attempt = 0; attempt < 2 && !txt; attempt++) {
      try {
        txt = await myMemoryTranslate(texts[i], source, target);
      } catch (_) {
        txt = '';
      }
      if (!txt && attempt === 0) await new Promise((r) => setTimeout(r, 300));
    }
    out.push(txt);
    await new Promise((r) => setTimeout(r, 120));
  }
  while (out.length < texts.length) out.push('');
  return out;
}

// ------------------------------------------------- 译文对齐（生词中文高亮）
//
// 问题：生词本里的单词，英文那边能高亮（我们自己拆词就知道位置），
// 但中文译文是 Google 整句翻出来的，根本不知道"today"对应"今天"落在哪个字。
//
// 解法：把待高亮的英文词用哨兵包起来再送翻译，Google 会原样保留哨兵，
// 中文对应词就夹在两个哨兵之间。实测（tools/probe-align3.js）：
//   Click any ⟦0⟧word⟦1⟧ ... and ⟦2⟧save⟦3⟧ it to your ⟦4⟧wordbook⟦5⟧.
//   → 单击任意⟦0⟧单词⟦1⟧进行查找，然后⟦2⟧将⟦3⟧保存到您的⟦4⟧单词本⟦5⟧。
// 12 个词全标记也 12/12 命中，词形变化（capturing→捕捉、translated→翻译了）同样有效。
//
// 哨兵选 ⟦ ⟧（U+27E6/U+27E7）：普通文本几乎不可能出现，且实测被保留。
// 索引用 slot*2 / slot*2+1，避免相邻两对共用编号导致正则错配。

const SENT_A = '\u27E6';
const SENT_B = '\u27E7';
const SENT_RE = new RegExp(`[${SENT_A}${SENT_B}]`, 'g');

/** 把 text 里出现在 wordSet 中的单词包上哨兵，返回 {marked, slots} */
function markWords(text, wordSet) {
  // wordSet 可能是 Set，也可能是从消息里传来的数组（JSON 不支持 Set）。
  // 早期只判 .size，数组的 size 是 undefined 会直接跳过标记，导致整条对齐链静默失效。
  const set =
    wordSet instanceof Set
      ? wordSet
      : Array.isArray(wordSet)
      ? new Set(wordSet.map((w) => String(w).toLowerCase()))
      : null;
  const slots = [];
  if (!set || !set.size) return { marked: text, slots };
  const hits = [];
  const re = /[A-Za-z][A-Za-z'’-]*/g;
  let m;
  while ((m = re.exec(text))) {
    if (set.has(m[0].toLowerCase())) {
      hits.push({ start: m.index, end: m.index + m[0].length, word: m[0] });
    }
  }
  if (!hits.length) return { marked: text, slots };

  let out = '';
  let i = 0;
  for (const h of hits) {
    out += text.slice(i, h.start);
    const idx = slots.length * 2;
    out += `${SENT_A}${idx}${SENT_B}${text.slice(h.start, h.end)}${SENT_A}${idx + 1}${SENT_B}`;
    slots.push({ word: h.word.toLowerCase(), start: h.start });
    i = h.end;
  }
  out += text.slice(i);
  return { marked: out, slots };
}

/** 从带哨兵的译文里抽出每个 slot 的中文，并给出清洗后的纯译文 */
function parseMarked(out, slots) {
  const spans = [];
  for (const s of slots) {
    const idx = spans.length * 2;
    const re = new RegExp(`${SENT_A}${idx}${SENT_B}([\\s\\S]*?)${SENT_A}${idx + 1}${SENT_B}`);
    const m = out.match(re);
    if (m && m[1] && m[1].trim()) {
      spans.push({ word: s.word, zh: m[1].trim(), start: m.index, end: m.index + m[0].length });
    } else {
      spans.push({ word: s.word, zh: null, start: -1, end: -1 });
    }
  }
  const clean = out.replace(new RegExp(`${SENT_A}\\d+${SENT_B}`, 'g'), '');
  return { clean, spans };
}

/** 把带哨兵的句子翻成译文 + 词对齐位置；引擎不支持标记时优雅退化为纯译文 */async function translateAligned(texts, wordSets, source, target) {
  const tl = target || 'zh-CN';

  // ---- 1. 查缓存：对齐结果按「译文语言 + 原文 + 待高亮词集合」缓存 ----
  // fallback 记录该条是否是「标记失败退回纯译文」的降级结果：
  // 降级结果只用于当下渲染，不写入缓存，否则之后换生词也修不好（词没翻就是没翻）。
  const result = {
    texts: new Array(texts.length).fill(''),
    spans: new Array(texts.length).fill(null),
    fallback: new Array(texts.length).fill(false),
  };
  const missIdx = [];
  const missMarked = [];

  for (let i = 0; i < texts.length; i++) {
    const mk = markWords(texts[i], wordSets?.[i]);
    // 缓存键版本号 al2：早期版本会把「标记失败退回纯译文」的结果也写进来，
    // 那些记录的 spans 为空、译文里还夹着英文原词，换版本号即可整体绕过旧脏数据。
    const key = `${tl}|al2|${hashStr(texts[i])}|${hashStr(((Array.isArray(wordSets?.[i]) ? wordSets[i] : wordSets?.[i] ? [...wordSets[i]] : []).map((w) => String(w).toLowerCase()).sort().join(',')))}`;
    const hit = await idbGet('translations', key);
    if (hit && typeof hit.text === 'string' && hit.text.trim() && Array.isArray(hit.spans)) {
      result.texts[i] = hit.text;
      result.spans[i] = hit.spans;
    } else {
      missIdx.push(i);
      missMarked.push(mk);
    }
  }

  if (!missIdx.length) return result;

  // ---- 2. 需要对齐的句子先打标记；没有待高亮词的句子照常翻 ----
  const anySlots = missMarked.some((mk) => mk.slots.length);
  let outs = null;
  if (anySlots) {
    try {
      outs = await translateBatch(missMarked.map((x) => x.marked), source, tl);
    } catch (_) {
      outs = null;
    }
  }

  const usable =
    Array.isArray(outs) &&
    outs.length === missMarked.length &&
    missMarked.every((mk, i) => {
      if (!mk.slots.length) return true;
      const o = outs[i] || '';
      // 至少第一对哨兵完整保留，才认为这一批的标记没被吃掉
      return new RegExp(`${SENT_A}0${SENT_B}[\\s\\S]*?${SENT_A}1${SENT_B}`).test(o);
    });

  if (!usable) {
    // 引擎（例如 MyMemory）把哨兵吃掉了 → 退回纯译文，中文不高亮但至少能读
    if (anySlots) console.info('[Trace bg] 标记对齐不可用，退回纯译文');
    const plainOut = await translateBatch(
      missIdx.map((i) => texts[i]),
      source,
      tl
    );
    for (let k = 0; k < missIdx.length; k++) {
      const i = missIdx[k];
      result.texts[i] = plainOut[k] || '';
      result.spans[i] = [];
      result.fallback[i] = true;
      // 故意不写缓存：这是降级结果，写进去会让后续即使引擎恢复也一直读到它
    }
    return result;
  }

  // ---- 3. 解析哨兵，得到纯译文 + 中文词位置 ----
  const reMark = new RegExp(`${SENT_A}\\d+${SENT_B}`, 'g');
  for (let k = 0; k < missIdx.length; k++) {
    const i = missIdx[k];
    const raw = outs[k] || '';
    const mk = missMarked[k];

    if (!mk.slots.length) {
      const clean = raw.replace(reMark, '');
      result.texts[i] = clean;
      result.spans[i] = [];
    } else {
      const { clean, spans } = parseMarked(raw, mk.slots);
      // 把绝对位置换算成「清洗后文本」里的位置
      const shifts = [];
      reMark.lastIndex = 0;
      let mm;
      while ((mm = reMark.exec(raw))) shifts.push({ at: mm.index, len: mm[0].length });
      const adjust = (pos) => {
        let d = 0;
        for (const s of shifts) {
          if (s.at < pos) d += s.len;
          else break;
        }
        return pos - d;
      };
      result.texts[i] = clean;
      result.spans[i] = spans
        .filter((s) => s.zh && s.start >= 0)
        .map((s) => ({ word: s.word, zh: s.zh, start: adjust(s.start), end: adjust(s.end) }));
    }

    // ---- 4. 兜底：哨兵之间没有译出中文（Google 偶尔把标记内的词原样保留）----
    // 实测 "…save it to your ⟦0⟧wordbook⟦1⟧." 会原样返回英文，
    // 但同一个词单独送翻是正常的。这里对这类槽位单独补译，再在译文里就地替换。
    if (mk.slots.length) {
      await repairUntranslatedSlots(result, i, texts[i], mk, tl);
    }

    if (result.texts[i]) {
      await idbPut('translations', {
        key: `${tl}|al2|${hashStr(texts[i])}|${hashStr(
          (Array.isArray(wordSets?.[i]) ? wordSets[i] : wordSets?.[i] ? [...wordSets[i]] : []).map((w) => String(w).toLowerCase()).sort().join(',')
        )}`,
        source: texts[i],
        text: result.texts[i],
        spans: result.spans[i],
        target: tl,
        createdAt: Date.now(),
      });
    }
  }
  return result;
}

/**
 * 修掉「哨兵内没翻译」的槽位。
 *
 * Google 对某些句子会把 ⟦n⟧word⟦n+1⟧ 整段原样保留，导致译文里夹着英文原词。
 * 这些词单独送翻通常没问题，所以这里：
 *   ① 找出 spans 里 zh 为空（或 zh 仍是英文原词）的槽位
 *   ② 把它们单独翻一遍
 *   ③ 在已清洗的译文里找到残留的英文原词，替换成中文，并修正 spans 的位置
 */
async function repairUntranslatedSlots(result, i, sourceText, mk, tl) {
  const spans = result.spans[i];
  if (!Array.isArray(spans) || !spans.length) return;

  // 判断某个 slot 的译文是否其实是「没翻」：没有中文、或内容就是英文原词
  const looksUntranslated = (s) => {
    if (!s || !s.zh) return true;
    const hasCjk = /[\u4e00-\u9fff]/.test(s.zh);
    if (!hasCjk) return true;
    // 译文里仍含英文原词（例如 "wordbook" 混在中文里）也算没翻干净
    return new RegExp(`(^|[^A-Za-z])${escapeRe(s.word)}([^A-Za-z]|$)`, 'i').test(s.zh);
  };

  const broken = spans.filter((s) => s.start >= 0 && looksUntranslated(s));
  if (!broken.length) return;

  // 补译这些词（一次批量，去重）
  const uniq = [...new Set(broken.map((s) => s.word))];
  let fixed;
  try {
    fixed = await translateBatch(uniq, 'en', tl || result.target || 'zh-CN');
  } catch (_) {
    return; // 补译失败就算了，保持原样，至少不崩
  }
  const dict = {};
  uniq.forEach((w, k) => {
    const zh = (fixed?.[k] || '').trim();
    // 只有真的译出中文才采用，否则宁可不替换
    if (zh && /[\u4e00-\u9fff]/.test(zh)) dict[w] = zh;
  });
  if (!Object.keys(dict).length) return;

  // 在译文里逐个替换残留英文，并记录新位置
  let text = result.texts[i];
  const newSpans = [];
  for (const s of spans) {
    const zh = dict[s.word];
    if (!zh || !looksUntranslated(s)) {
      if (s.start >= 0) newSpans.push(s);
      continue;
    }
    // 在当前位置附近找英文原词（大小写不敏感）
    const re = new RegExp(escapeRe(s.word), 'gi');
    re.lastIndex = 0;
    const m = re.exec(text);
    if (!m) {
      // 找不到就不高亮，避免错位
      continue;
    }
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    text = before + zh + after;
    newSpans.push({ word: s.word, zh, start: m.index, end: m.index + zh.length });
  }

  // 替换会让后面 span 的位置变化，重新按出现顺序算一遍
  result.texts[i] = text;
  result.spans[i] = recomputeSpanOffsets(text, newSpans);
}

/** 按 span 的 word 在最终译文里出现顺序，重新计算 start/end（去重叠） */
function recomputeSpanOffsets(text, spans) {
  const out = [];
  let cursor = 0;
  const sorted = spans.filter((s) => s && s.word && s.zh).sort((a, b) => a.start - b.start);
  for (const s of sorted) {
    const at = text.indexOf(s.zh, cursor);
    if (at < 0) continue;
    out.push({ word: s.word, zh: s.zh, start: at, end: at + s.zh.length });
    cursor = at + s.zh.length;
  }
  return out;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 稳定哈希（放在后台，避免通过消息传函数） */
function hashStr(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 带缓存的批量翻译：先查缓存，再按 40 条一批请求 */
async function translateWithCache(texts, source, target) {
  const hashFn = hashStr;
  const result = new Array(texts.length).fill(null);
  const missIdx = [];
  const missTexts = [];

  for (let i = 0; i < texts.length; i++) {
    const key = `${target}|${hashFn(texts[i])}`;
    const hit = await idbGet('translations', key);
    // 旧版本可能把空串写进过缓存，这类脏数据一律当作未命中，重新翻译
    if (hit && typeof hit.text === 'string' && hit.text.trim()) {
      result[i] = hit.text;
    } else {
      missIdx.push(i);
      missTexts.push(texts[i]);
    }
  }

  const BATCH = 40;
  for (let i = 0; i < missTexts.length; i += BATCH) {
    const chunk = missTexts.slice(i, i + BATCH);
    let outs = [];
    try {
      outs = await translateBatch(chunk, source, target);
    } catch (e) {
      outs = chunk.map(() => '');
    }
    for (let j = 0; j < chunk.length; j++) {
      const gi = missIdx[i + j];
      const txt = outs[j] || '';
      result[gi] = txt;
      if (txt) {
        await idbPut('translations', {
          key: `${target}|${hashFn(chunk[j])}`,
          source: chunk[j],
          text: txt,
          target,
          createdAt: Date.now(),
        });
      }
    }
    if (i + BATCH < missTexts.length) {
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  return result.map((v) => v || '');
}

// ---------------------------------------------------------------- 词典

const POS_MAP = {
  n: '名词', v: '动词', adj: '形容词', adv: '副词', pron: '代词',
  prep: '介词', conj: '连词', det: '限定词', interj: '感叹词',
  num: '数词', aux: '助动词', phrase: '短语',
};

async function lookupWord(word) {
  const w = word.trim();
  if (!w) return null;
  const key = 'dict|' + w.toLowerCase();
  const cached = await idbGet('translations', key);
  if (cached && cached.dict) return cached.dict;

  const dict = { word: w, phonetic: '', meanings: [], example: '', zh: '' };

  // 词典与中文释义并行请求，谁慢谁降级，不互相拖累
  const dictTask = (async () => {
    // 免费词典：音标 + 英文释义 + 词性
    // 注意 dictionaryapi.dev 对部分词（如 "So"）会永久挂起，必须超时并降级
    try {
      const r = await fetchT(
        'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w),
        {},
        3500
      );
      if (!r.ok) return;
      const arr = await r.json();
      const e = Array.isArray(arr) ? arr[0] : null;
      if (!e) return;
      dict.phonetic =
        e.phonetic || (e.phonetics || []).map((p) => p.text).find(Boolean) || '';
      (e.meanings || []).slice(0, 4).forEach((m) => {
        (m.definitions || []).slice(0, 2).forEach((d) => {
          dict.meanings.push({
            pos: POS_MAP[m.partOfSpeech] || m.partOfSpeech || '',
            def: d.definition || '',
            example: d.example || '',
          });
        });
      });
      dict.example =
        (e.meanings || [])
          .flatMap((m) => m.definitions || [])
          .map((d) => d.example)
          .find(Boolean) || '';
    } catch (_) {
      /* 词典失败不影响整体 */
    }
  })();

  const zhTask = (async () => {
    try {
      const zh = await googleTranslate([w], 'en', 'zh-CN');
      dict.zh = zh[0] || '';
    } catch (_) {
      dict.zh = '';
    }
  })();

  await Promise.all([dictTask, zhTask]);

  await idbPut('translations', { key, dict, createdAt: Date.now() });
  return dict;
}

// ---------------------------------------------------------------- 生词本

async function addWord(payload) {
  const word = (payload.word || '').trim();
  if (!word) return null;
  const key = word.toLowerCase();
  const existing = await idbGet('words', key);
  const rec = {
    word: key,
    display: word,
    phonetic: payload.phonetic || '',
    zh: payload.zh || '',
    meanings: payload.meanings || [],
    example: payload.example || '',
    context: payload.context || '',
    contextZh: payload.contextZh || '',
    videoTitle: payload.videoTitle || '',
    videoId: payload.videoId || '',
    time: typeof payload.time === 'number' ? payload.time : null,
    createdAt: existing ? existing.createdAt : Date.now(),
    reviewCount: existing ? existing.reviewCount || 0 : 0,
    lastReview: existing ? existing.lastReview || null : null,
    status: existing ? existing.status || 'new' : 'new',
  };
  await idbPut('words', rec);
  return rec;
}

async function listWords() {
  const all = await idbAll('words');
  return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** 只返回单词集合（小写），供内容脚本做高亮比对，比传全量记录轻得多 */
async function wordKeys() {
  const all = await idbAll('words');
  return all.map((w) => w.word);
}

async function hasWord(word) {
  if (!word) return false;
  return !!(await idbGet('words', String(word).toLowerCase()));
}

/** 通知所有 YouTube 标签页：生词本变了，重新拉取高亮词表 */
async function broadcastWordsChanged() {
  try {
    // host_permissions 已覆盖 youtube.com，chrome.tabs.query 可直接按 URL 过滤，
    // 不需要额外的 "tabs" 权限（那个会触发"读取浏览记录"警告）。
    const tabs = await chrome.tabs.query({ url: 'https://*.youtube.com/*' });
    await Promise.all(
      tabs.map((t) =>
        chrome.tabs.sendMessage(t.id, { type: 'words:changed' }).catch(() => {})
      )
    );
  } catch (_) {
    /* 标签页已关闭或权限不足，忽略：高亮会在下次加载时同步 */
  }
}

async function removeWord(word) {
  await idbDel('words', String(word).toLowerCase());
  await broadcastWordsChanged();
  return true;
}

async function reviewWord(word) {
  const key = String(word).toLowerCase();
  const rec = await idbGet('words', key);
  if (!rec) return null;
  rec.reviewCount = (rec.reviewCount || 0) + 1;
  rec.lastReview = Date.now();
  rec.status = rec.reviewCount >= 3 ? 'learned' : 'learning';
  await idbPut('words', rec);
  return rec;
}

async function exportWords() {
  const all = await listWords();
  return all;
}

// ---------------------------------------------------------------- 消息路由

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'settings:get':
          sendResponse({ ok: true, data: await getSettings() });
          break;
        case 'settings:set':
          sendResponse({ ok: true, data: await setSettings(msg.patch || {}) });
          break;
        case 'translate':
          sendResponse({
            ok: true,
            data: await translateWithCache(
              msg.texts || [],
              msg.source || 'auto',
              msg.target || 'zh-CN'
            ),
          });
          break;
        case 'translate:aligned':
          // 带生词对齐的翻译：除了译文，还返回每个生词在译文中的位置
          sendResponse({
            ok: true,
            data: await translateAligned(
              msg.texts || [],
              msg.wordSets || [],
              msg.source || 'auto',
              msg.target || 'zh-CN'
            ),
          });
          break;
        case 'dict':
          console.info('[Trace bg] dict start', msg.word);
          {
            const d = await lookupWord(msg.word);
            console.info('[Trace bg] dict done', msg.word, !!d);
            sendResponse({ ok: true, data: d });
          }
          break;
        case 'word:add':
          {
            const rec = await addWord(msg.payload || {});
            await broadcastWordsChanged();
            sendResponse({ ok: true, data: rec });
          }
          break;
        case 'word:list':
          sendResponse({ ok: true, data: await listWords() });
          break;
        case 'word:keys':
          sendResponse({ ok: true, data: await wordKeys() });
          break;
        case 'word:has':
          sendResponse({ ok: true, data: await hasWord(msg.word) });
          break;
        case 'word:remove':
          sendResponse({ ok: true, data: await removeWord(msg.word) });
          break;
        case 'word:review':
          sendResponse({ ok: true, data: await reviewWord(msg.word) });
          break;
        case 'word:export':
          sendResponse({ ok: true, data: await exportWords() });
          break;
        case 'cache:clear':
          await idbClear('translations');
          sendResponse({ ok: true });
          break;
        case 'open-wordbook':
          // 页内面板的「生词本」按钮 → 词库看板（wordbook.html）。
          // 已有看板标签页就切过去复用，避免开出一堆重复页面。
          // 用 runtime.getContexts 而不是 tabs.query：后者按 url 过滤需要 "tabs" 权限
          // （会触发「读取您的浏览记录」警告），getContexts 只查本扩展自己的页面，不需要。
          try {
            const base = chrome.runtime.getURL('wordbook.html');
            let ctxs = [];
            try {
              ctxs = await chrome.runtime.getContexts({
                contextTypes: ['TAB'],
                documentUrls: [base],
              });
            } catch (_) {
              ctxs = [];
            }
            const hit = (ctxs || []).find((c) => c.tabId != null && c.tabId >= 0);
            if (hit) {
              await chrome.tabs.update(hit.tabId, { active: true });
              if (hit.windowId != null) {
                try { await chrome.windows.update(hit.windowId, { focused: true }); } catch (_) {}
              }
              sendResponse({ ok: true, via: 'focus' });
            } else {
              await chrome.tabs.create({ url: base });
              sendResponse({ ok: true, via: 'tab' });
            }
          } catch (e) {
            sendResponse({ ok: false, error: String((e && e.message) || e) });
          }
          break;
        default:
          sendResponse({ ok: false, error: 'unknown message: ' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 保持消息通道，异步回复
});

// 首次安装时写入默认设置
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await getSettings();
  await setSettings(cur);
});

// 调试钩子（仅用于本地测试脚本，生产无副作用）
globalThis.__traceDebug = {
  openDB,
  idbGet,
  idbPut,
  idbAll,
  getSettings,
  translateWithCache,
  translateBatch,
  googleTranslate,
  googleChunked,
  myMemoryAll,
  translateAligned,
  markWords,
  parseMarked,
  lookupWord,
  addWord,
  /** 测试辅助：与消息路由 'word:add' 完全同一条路径（写入 + 广播） */
  addWordNotify: async (payload) => {
    const rec = await addWord(payload || {});
    await broadcastWordsChanged();
    return rec;
  },
  listWords,
  wordKeys,
  hasWord,
  removeWord,
  /** 测试辅助：与消息路由 'word:remove' 同一条路径（删除 + 广播） */
  removeWordNotify: (word) => removeWord(word),
};
