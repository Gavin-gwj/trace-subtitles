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
          // 页内面板的「生词本」按钮：优先弹扩展 popup（需要 Chrome 127+ 且通常要用户手势）；
          // 失败就退化成新标签页打开 popup.html —— 功能一致，只是不在角标里
          try {
            await chrome.action.openPopup();
            sendResponse({ ok: true, via: 'popup' });
          } catch (e) {
            try {
              await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
              sendResponse({ ok: true, via: 'tab' });
            } catch (e2) {
              sendResponse({ ok: false, error: String((e2 && e2.message) || e2) });
            }
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
  lookupWord,
  addWord,
  listWords,
  wordKeys,
  hasWord,
};
