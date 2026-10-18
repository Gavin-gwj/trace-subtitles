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
  // 全局显示：视频框不在视野里时（切到别的页面 / 往下翻到评论区），
  // 字幕改成贴屏幕底部的悬浮条继续跟播。关闭时只在视频框内显示。
  globalMode: false,
  // ---- 生词本备份 ----
  // Chrome 卸载扩展时会清空 IndexedDB，所以生词本要额外落一份 JSON 到
  // 「下载/trace-subtitles/wordbook-backup.json」。默认开，改动后自动覆盖。
  autoBackup: true,
  autoBackupFails: 0, // 连续失败次数，达 3 次自动关闭 autoBackup
  lastBackupAt: 0, // 上次自动备份时间戳，用于节流
  backupDirName: '', // 用户选定的备份目录名（空=还没选，退回「下载」目录）
  // ---- 大模型引擎（OpenAI 兼容中转站）----
  // engine='llm' 时才走这条路。配置留空则自动降级到 Google，
  // 所以这些字段为空是合法状态，不需要额外校验拦截。
  llmBaseUrl: '', // 例如 https://api.example.com/v1（末尾不带斜杠）
  llmApiKey: '', // 明文存 chrome.storage.local，界面需标注
  llmModel: '', // 从 /models 拉取后选择
  llmTimeoutMs: 30000, // 单次请求超时；批量翻译比查词慢，给宽一些
  llmBatch: 12, // 每次请求送多少句（大模型上下文够，但太大易超时）
  llmTemperature: 0.2,
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
const DB_VER = 2;
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
      // v2：存「用户选定的备份目录」句柄（FileSystemDirectoryHandle）。
      // 句柄本身是可结构化克隆的，能直接放进 IndexedDB，
      // 之后 Service Worker 取出来就能静默读写那个目录。
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
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
    // 统一在这里清零宽字符：Google 会在英文词中间插 U+200B，
    // 留着会让「译文里是否还有英文」的检测与补译全部失效。
    if (item == null) out.push('');
    else if (typeof item === 'string') out.push(stripInvisible(item));
    else if (Array.isArray(item)) out.push(stripInvisible(String(item[0] ?? '')));
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
  const out = String(json?.responseData?.translatedText || '');
  // 额度用尽时 MyMemory 仍然返回 HTTP 200，但正文是
  // "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY..."
  // 这种"看起来成功"的响应必须当成失败抛出，否则界面会把警告当成译文显示，
  // 或者（更糟）返回空串让整批译文消失。
  if (/^MYMEMORY WARNING/i.test(out.trim())) {
    throw new Error('mymemory quota exhausted');
  }
  return out;
}

async function translateBatch(texts, source, target) {
  if (!texts.length) return [];
  const engine = (await getSettings()).engine;

  if (engine === 'llm') {
    // 大模型：配置不全或整批失败都自动降级到 Google。
    // 不能因为用户填错一个 key 就让字幕彻底不显示 —— 降级比报错有用。
    try {
      const out = await llmTranslateAll(texts, source, target);
      const okCount = out.filter((s) => s && String(s).trim()).length;
      if (okCount >= Math.ceil(texts.length * 0.6)) return out;
      console.warn(
        `[Trace bg] 大模型只翻出 ${okCount}/${texts.length} 句，自动降级到 Google`
      );
      const gg = await googleChunked(texts, source, target);
      return texts.map((_, i) => {
        const a = out[i] || '';
        return a.trim() ? a : gg[i] || '';
      });
    } catch (e) {
      console.warn('[Trace bg] 大模型翻译失败，自动降级到 Google', e && e.message);
      return googleChunked(texts, source, target);
    }
  }

  if (engine === 'mymemory') {
    // MyMemory 免费版每天只有很小额度，用尽后每条都失败。
    // 如果整批几乎全空，说明额度/网络出问题了，这里自动降级到 Google，
    // 否则用户切到 MyMemory 后只会看到"译文全没了"（而且不知道原因）。
    const mm = await myMemoryAll(texts, source, target);
    const okCount = mm.filter((s) => s && String(s).trim()).length;
    if (okCount >= Math.ceil(texts.length * 0.6)) return mm;
    console.warn(
      `[Trace bg] MyMemory 只翻出 ${okCount}/${texts.length} 句（多半是免费额度用尽），自动降级到 Google`
    );
    const gg = await googleChunked(texts, source, target);
    // 逐句取"谁有译文用谁"，两边都不浪费
    return texts.map((_, i) => {
      const a = mm[i] || '';
      return a.trim() ? a : gg[i] || '';
    });
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

// ---------------------------------------------------------------- 大模型引擎
//
// 走 OpenAI 兼容协议（POST {baseUrl}/chat/completions），所以任何中转站都能用。
//
// 为什么单独一档而不是复用 Google：Google 免费端点对习语基本是字面直译
// （实测 10 个常见习语错 5 个：break a leg→"打断一条腿"、hit the sack→"解雇"），
// 而大模型带上下文能把 "pay your fair" 在 "walk up, pay your fair, go up"
// 里翻成"付钱"。代价是延迟和费用，所以做成可选引擎，默认仍是 google。

/** 大模型是否配置完整（缺任一项都不算可用） */
function llmReady(st) {
  const s = st || {};
  return !!(String(s.llmBaseUrl || '').trim() && String(s.llmModel || '').trim());
}

/** 把 baseUrl 归一化：去尾斜杠；用户若只填到域名，自动补 /v1 */
function llmUrl(st, path) {
  let base = String((st || {}).llmBaseUrl || '').trim().replace(/\/+$/, '');
  if (!/\/v\d+$/i.test(base)) base += '/v1';
  return base + path;
}

/** 从 baseUrl 取出 origin（scheme://host[:port]），用于申请 host permission */
function llmOriginOf(baseUrl) {
  const s = String(baseUrl || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    return u.origin;
  } catch (_) {
    return '';
  }
}

/** 调一次 chat/completions，返回纯文本回复 */
async function llmChat(messages, st) {
  const s = st || (await getSettings());
  if (!llmReady(s)) throw new Error('llm not configured');
  const timeout = Math.max(3000, Number(s.llmTimeoutMs) || 30000);
  const headers = { 'content-type': 'application/json' };
  const key = String(s.llmApiKey || '').trim();
  if (key) headers.authorization = 'Bearer ' + key;

  const res = await fetchT(
    llmUrl(s, '/chat/completions'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: s.llmModel,
        messages,
        temperature: Number(s.llmTemperature) || 0.2,
        stream: false,
      }),
    },
    timeout
  );
  if (!res.ok) {
    // 把上游错误正文带出来：中转站常把真实原因（余额不足/模型不存在）写在 body 里，
    // 只报 "http 400" 用户完全没法排查。
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch (_) {}
    throw new Error(`llm http ${res.status}${detail ? ' ' + detail : ''}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('llm empty content');
  }
  return content;
}

/** 从模型回复里尽力挖出 JSON（模型常带 ```json 围栏或前后废话） */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // 去掉 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch (_) {}
  // 退一步：截取第一个 { 到最后一个 }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch (_) {}
  }
  return null;
}

/**
 * 批量翻译（走大模型）。
 * 返回与输入等长的字符串数组，失败的位是 ''（交给上层兜底）。
 *
 * 关键约束：一次请求里用编号分隔多句，再按编号拆回来 —— 不能让模型
 * 自由发挥格式，否则几百句根本对不齐。
 */
async function llmTranslateAll(texts, source, target) {
  const st = await getSettings();
  if (!llmReady(st)) throw new Error('llm not configured');
  const tl = normLang(target);
  const sl = source === 'auto' ? '' : normLang(source);
  const size = Math.max(1, Math.min(40, Number(st.llmBatch) || 12));
  const out = new Array(texts.length).fill('');

  for (let start = 0; start < texts.length; start += size) {
    const chunk = texts.slice(start, start + size);
    // 用「编号 → 译文」的行格式。比 JSON 更省 token，也比纯换行可靠：
    // 空行/多行译文不会打乱编号对应关系。
    const numbered = chunk
      .map((t, i) => `${i + 1}. ${String(t).replace(/\s+/g, ' ').trim()}`)
      .join('\n');
    const sys =
      '你是字幕翻译器。把用户给的每条编号句子翻译成目标语言，' +
      '严格保持编号与行数，每行格式为「编号. 译文」，不要输出任何其它内容、不要合并或拆分句子。' +
      '保持口语风格，保留专有名词。' +
      // 带哨兵的句子来自"高亮生词"路径：⟦0⟧词⟦1⟧ 这种记号必须原样保留，
      // 否则中文侧就无法定位该词对应的译文片段（bug 12 的教训）。
      (/[\u27E6\u27E7]/.test(numbered)
        ? '句子里的 ⟦数字⟧ 是位置标记，必须原样保留在原位置，不要翻译、不要删除、不要改动编号。'
        : '');
    const user =
      `目标语言：${tl}\n` + (sl ? `源语言：${sl}\n` : '') + `待翻译：\n${numbered}`;

    let reply;
    try {
      reply = await llmChat(
        [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        st
      );
    } catch (e) {
      console.warn(`[Trace bg] 大模型翻译第 ${start / size + 1} 批失败`, e && e.message);
      continue; // 这一批留空，交给上层用 Google 补
    }

    // 按编号拆回。容忍模型写成 "1." "1)" "1、" 或漏写编号。
    const lines = String(reply).split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*(\d+)\s*[.)、．:：]?\s*(.*)$/);
      if (!m) continue;
      const idx = parseInt(m[1], 10) - 1;
      const val = m[2].trim();
      if (idx >= 0 && idx < chunk.length && val) out[start + idx] = val;
    }
    // 编号全丢（模型不听话）→ 行数正好对得上时按顺序硬塞
    const got = out.slice(start, start + chunk.length).filter(Boolean).length;
    if (!got) {
      const clean = String(reply)
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*\d+\s*[.)、．:：]?\s*/, '').trim())
        .filter(Boolean);
      if (clean.length === chunk.length) {
        clean.forEach((v, i) => {
          out[start + i] = v;
        });
      }
    }
  }
  return out;
}

/** 列出中转站可用模型（GET /models） */
async function llmListModels() {
  const st = await getSettings();
  if (!String(st.llmBaseUrl || '').trim()) throw new Error('请先填写 API 地址');
  const headers = {};
  const key = String(st.llmApiKey || '').trim();
  if (key) headers.authorization = 'Bearer ' + key;
  const res = await fetchT(llmUrl(st, '/models'), { headers }, 15000);
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch (_) {}
    throw new Error(`http ${res.status}${detail ? ' ' + detail : ''}`);
  }
  const json = await res.json();
  const list = json?.data || json?.models || [];
  return list
    .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name)))
    .filter(Boolean);
}

/** 测试连接：发一条最小请求，验证地址/密钥/模型三者都对 */
async function llmTest() {
  const st = await getSettings();
  if (!llmReady(st)) throw new Error('地址或模型未填写');
  const t0 = Date.now();
  const reply = await llmChat(
    [
      { role: 'system', content: '只回答一个字：好' },
      { role: 'user', content: 'ping' },
    ],
    st
  );
  return { ok: true, ms: Date.now() - t0, sample: String(reply).slice(0, 80) };
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

// 哨兵在译文里**会被 Google 弄坏**，不能靠「成对括号」匹配。
// 实测（"…two ⟦0⟧halves⟦1⟧. …both ⟦2⟧halves⟦3⟧, …both ⟦4⟧halves⟦5⟧."）返回：
//   "…两半⟦0⟧半⟦1⟧。 ⟦2⟧⟧3⟧底部涂上奶油，⟦4⟧⟧5⟧都涂上果酱。"
// 即重复出现的词被去重时，Google 把「词 + 后一个哨兵的左括号」一起删掉了，
// 于是 `⟦2⟧halves⟦3⟧` 变成 `⟦2⟧⟧3⟧`（`⟦3⟧` 少了左括号）。
// 早期版本用 `⟦n⟧([\s\S]*?)⟦n+1⟧` 严格配对，这些坏掉的槽位匹配失败，
// 于是 `⟦2⟧`、`⟧3⟧` 这些记号**原样漏进译文**，用户看到的就是「〖3〗」之类的乱码。
// 修复思路：括号可能丢，但括号里的**编号几乎总被保留**，所以以编号为锚点扫描，
// 相邻两个记号之间的文本就是那个槽位的内容；扫不到内容的槽位就放弃高亮（不猜）。
const TOKEN_RE = /[\u27E6\u27E7]?\s*(\d+)\s*[\u27E6\u27E7]/g;

/** 扫描译文里所有哨兵记号（容忍括号被删/被替换），按出现顺序返回 {idx, start, end} */
function scanTokens(raw) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(raw))) {
    out.push({ idx: Number(m[1]), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 去掉残留的哨兵括号字符与零宽字符（数字由记号扫描负责消费，不会走到这里） */
function stripMarkers(raw) {
  return stripInvisible(String(raw == null ? '' : raw)).replace(/[\u27E6\u27E7]/g, '');
}

// >>> WORD_FORMS_BEGIN  (本段在 subtitles.js 与 bg.js 里各有一份，内容必须一致，tools/test-forms.js 会逐行比对)
// 生词本存的是某个词形（beverage），字幕里出现的可能是另一个词形（beverages）。
// 这里给出「一个词形可能对应的其它词形」，匹配时看两个集合有没有交集。
// 取舍：
//   1) 只做形态学猜测，不做词性标注 —— 多出来的候选只有在生词本里真有那个词时才命中，
//      误报代价很低；宁可多给候选，也不漏掉词形变化。
//   2) 双向都生成：存了 beverage 要能命中 beverages，存了 beverages 也要能命中 beverage。
//   3) 收录不规则**名词**复数（children / knives / halves…），不收录不规则**动词**：
//      saw(锯子)/saw(see 的过去式)、left(左)/left(leave 的过去式)、found(建立)/found(find 的过去式)
//      这类同形冲突太多，误报比漏报更烦人。
//   4) be / have / do 三族一律不收（is/are/was/has/had/does…）：超高频功能词，
//      一旦收藏会让整屏字幕都在高亮，纯噪音。长度 < 4 的词也不做形态猜测。
//   5) 单复数同形或不可数词（news/series/species/data…）列进 INVARIANT，
//      既不拆成词干（news 不能变成 new），也不接受正向加 s。
const IRREGULAR = {
  // ---- 不规则复数 ----
  children: 'child', men: 'man', women: 'woman', people: 'person',
  feet: 'foot', teeth: 'tooth', mice: 'mouse', geese: 'goose', oxen: 'ox', lice: 'louse',
  halves: 'half', knives: 'knife', wives: 'wife', lives: 'life', leaves: 'leaf',
  loaves: 'loaf', thieves: 'thief', shelves: 'shelf', wolves: 'wolf', calves: 'calf',
  elves: 'elf', scarves: 'scarf', hooves: 'hoof', selves: 'self',
};

/** 单复数同形 / 不可数：不能再套 -s 规则（否则 news 会变成 new） */
const INVARIANT = new Set([
  'news', 'series', 'species', 'means', 'physics', 'mathematics', 'economics',
  'politics', 'ethics', 'measles', 'data', 'media',
]);

/** 返回这个词形可能对应的其它词形（含自身，统一小写） */
function wordForms(w) {
  const word = String(w || '').toLowerCase();
  const out = new Set([word]);
  if (!word) return out;
  const irr = IRREGULAR[word];
  if (irr) out.add(irr);
  if (word.length < 4) return out;
  const invariant = INVARIANT.has(word);

  // ===== 反向：把变形还原成原形（beverages → beverage）=====
  if (!invariant) {
    if (/(?:s|x|z|ch|sh)es$/.test(word)) out.add(word.slice(0, -2)); // boxes→box
    if (/[^aeiou]ies$/.test(word)) out.add(word.slice(0, -3) + 'y'); // cities→city
    if (/[^aeiou]ves$/.test(word)) {
      const stem = word.slice(0, -3);
      out.add(stem + 'f'); // wolves→wolf
      out.add(stem + 'fe'); // knives→knife
    }
    if (/s$/.test(word) && !/ss$/.test(word) && !/us$/.test(word) && !/is$/.test(word)) {
      out.add(word.slice(0, -1)); // beverages→beverage
    }
  }
  if (/ied$/.test(word)) out.add(word.slice(0, -3) + 'y'); // carried→carry
  else if (/ed$/.test(word)) {
    const base = word.slice(0, -2);
    out.add(base); // walked→walk
    if (/([bcdfgklmnprstvz])\1$/.test(base)) out.add(base.slice(0, -1)); // stopped→stop
    if (base.length >= 2 && !/^(sh|th|wh|ye|the)$/.test(base)) out.add(base + 'e'); // used→use
  }
  if (/ing$/.test(word) && word.length > 5) {
    const base = word.slice(0, -3);
    out.add(base); // walking→walk
    if (/([bcdfgklmnprstvz])\1$/.test(base)) out.add(base.slice(0, -1)); // running→run
    if (base.length >= 2 && !/^(sh|th|wh|ye|the)$/.test(base)) out.add(base + 'e'); // making→make
  }
  if (/ier$/.test(word)) out.add(word.slice(0, -3) + 'y'); // happier→happy
  else if (/er$/.test(word) && word.length > 5) {
    const base = word.slice(0, -2);
    out.add(base); // faster→fast
    if (/([bcdfgklmnprstvz])\1$/.test(base)) out.add(base.slice(0, -1)); // bigger→big
  }
  if (/iest$/.test(word)) out.add(word.slice(0, -4) + 'y'); // happiest→happy
  else if (/est$/.test(word) && word.length > 6) {
    const base = word.slice(0, -3);
    out.add(base); // fastest→fast
    if (/([bcdfgklmnprstvz])\1$/.test(base)) out.add(base.slice(0, -1)); // biggest→big
  }

  // ===== 正向：把原形展开成常见变形（beverage → beverages）=====
  // 只在生词本里真有那个词时才命中，所以多给几个候选不会让画面变乱。
  // 唯一要防的是「展开出来的词本身是高频词」：如果结果是 INVARIANT 里的词就不加，
  // 否则收藏了 new 会让所有 news 都高亮。
  // 已经像变形词的（-s/-es/-ed/-ing/-er/-est）不再继续展开，
  // 否则 beverages 会派生出 beverageses 这种永远匹配不上的垃圾候选。
  const looksInflected = /(?:s|ed|ing|er|est)$/.test(word);
  if (!invariant && !looksInflected) {
    const addForm = (f) => { if (!INVARIANT.has(f)) out.add(f); };
    // 复数 / 三单
    if (/[^aeiou]y$/.test(word)) addForm(word.slice(0, -1) + 'ies'); // city→cities
    else if (/(?:s|x|z|ch|sh)$/.test(word)) addForm(word + 'es'); // box→boxes
    else addForm(word + 's'); // beverage→beverages
    if (/fe$/.test(word)) addForm(word.slice(0, -2) + 'ves'); // knife→knives
    else if (/f$/.test(word)) addForm(word.slice(0, -1) + 'ves'); // half→halves
    // 过去式 / 现在分词
    if (/e$/.test(word)) {
      addForm(word + 'd'); // use→used
      addForm(word.slice(0, -1) + 'ing'); // make→making
    } else if (/[^aeiou]y$/.test(word)) {
      addForm(word.slice(0, -1) + 'ied'); // carry→carried
      addForm(word + 'ing');
    } else {
      addForm(word + 'ed'); // walk→walked
      addForm(word + 'ing'); // walk→walking
    }
    // 比较级 / 最高级（短词才加）
    if (word.length <= 6) {
      if (/[^aeiou]y$/.test(word)) { addForm(word.slice(0, -1) + 'ier'); addForm(word.slice(0, -1) + 'iest'); }
      else { addForm(word + 'er'); addForm(word + 'est'); }
    }
  }

  return out;
}
// >>> WORD_FORMS_END

/**
 * 字幕里的一个词形，命中生词本里的哪个词？
 * 命中返回**生词本里的那个词**（小写），未命中返回 null。
 *
 * 优先精确命中，其次才做词形展开比较 —— 生词本里同时有 beverage 和 beverages 时，
 * 字幕里的 beverages 必须归到 beverages，否则点它会显示另一个词条的释义。
 */
function matchSaved(rawWord, set) {
  const w = String(rawWord || '').toLowerCase();
  if (!w) return null;
  if (set.has(w)) return w;
  for (const cand of wordForms(w)) {
    if (cand !== w && set.has(cand)) return cand;
  }
  return null;
}

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
    // 词形匹配：beverages 要能命中生词本里的 beverage。
    // slot.word 记**生词本里那个词**（不是字幕里的词形），
    // 这样点中文高亮时打开的是已收藏词条的卡片，而不是一个「未收藏」的复数形式。
    const canon = matchSaved(m[0], set);
    if (canon) {
      hits.push({ start: m.index, end: m.index + m[0].length, word: canon });
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

/**
 * 零宽/不可见字符。
 *
 * Google 会在英文单词**中间**插零宽空格（U+200B）—— 实测
 *   horizontal → horizo\u200B\u200Bntal
 * 肉眼完全看不出来，但所有正则都匹配不到它：
 *   /horizontal/.test('horizo\u200B\u200Bntal') === false
 * 后果是「译文里残留英文原词」的检测与补译全部失效，英文就那么留在中文里。
 * 所以：清洗译文时一律删掉，做词匹配时一律允许它们夹在字母之间。
 */
const INVISIBLE_RE = /[\u200B-\u200F\u2060\uFEFF\u00AD]/g;

function stripInvisible(s) {
  return String(s == null ? '' : s).replace(INVISIBLE_RE, '');
}

/** 生成一个能容忍「字母之间夹零宽字符」的词匹配正则 */
function looseWordRe(word, flags = 'gi') {
  const chars = String(word).split('').map((c) => escapeRe(c));
  return new RegExp(chars.join('[\\u200B-\\u200F\\u2060\\uFEFF\\u00AD]*'), flags);
}

/** 从带哨兵的译文里抽出每个 slot 的中文，并给出清洗后的纯译文。
 *
 * 不依赖「成对括号」（Google 会删掉重复词旁的一个括号，见 TOKEN_RE 上方注释）：
 *   ① 扫描所有记号；
 *   ② 相邻两个记号之间的文本 = 前一个槽位的译文；
 *   ③ 内容为空或夹着别的括号 → 该槽位被引擎吃掉，放弃高亮（绝不猜）；
 *   ④ 清洗时把**记号整体**（含编号）和落单括号一起删掉，
 *      否则 `⟦2⟧⟧3⟧` 里的数字会变成译文里的 "23"。
 */
function parseMarked(out, slots) {
  // 先清掉零宽字符再做任何位置计算 —— 统一坐标系，
  // 否则「记号位置」和「最终文本位置」会差若干个看不见的字符。
  out = stripInvisible(out);
  const tokens = scanTokens(out);
  const spans = slots.map((s) => ({ word: s.word, zh: null, start: -1, end: -1 }));

  // ---- 收集要删除的区间：记号本身 + 任何落单的括号字符 ----
  const cuts = tokens.map((t) => ({ at: t.start, end: t.end }));
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (ch === SENT_A || ch === SENT_B) cuts.push({ at: i, end: i + 1 });
  }
  cuts.sort((a, b) => a.at - b.at);
  const merged = [];
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    if (last && c.at <= last.end) last.end = Math.max(last.end, c.end);
    else merged.push({ at: c.at, end: c.end });
  }
  // raw 坐标 → 清洗后坐标
  const adjust = (pos) => {
    let d = 0;
    for (const c of merged) {
      if (c.at >= pos) break;
      d += Math.min(c.end, pos) - c.at;
    }
    return pos - d;
  };
  let clean = '';
  let cursor = 0;
  for (const c of merged) {
    clean += out.slice(cursor, c.at);
    cursor = c.end;
  }
  clean += out.slice(cursor);

  // ---- 槽位内容：只接受「左记号 + 紧邻的右记号」这一对 ----
  for (let t = 0; t < tokens.length - 1; t++) {
    const open = tokens[t];
    const close = tokens[t + 1];
    if (open.idx % 2 !== 0) continue; // 只从槽位的左记号起算（idx = slot*2）
    if (close.idx !== open.idx + 1) continue; // 右记号必须紧邻，否则结构已坏
    const slot = open.idx >> 1;
    if (slot < 0 || slot >= slots.length) continue;
    const body = out.slice(open.end, close.start);
    if (!body.trim()) continue; // 词被引擎去重掉了（`⟦2⟧⟧3⟧`）
    if (/[\u27E6\u27E7]/.test(body)) continue; // 内容里还有括号 → 错位，放弃
    if (/^\s*\d+\s*$/.test(body)) continue; // 只剩编号，说明词没翻出来
    spans[slot] = {
      word: slots[slot].word,
      zh: body.trim(),
      start: adjust(open.end),
      end: adjust(close.start),
    };
  }

  return { clean, spans };
}

/** 把带哨兵的句子翻成译文 + 词对齐位置；引擎不支持标记时优雅退化为纯译文 */async function translateAligned(texts, wordSets, source, target) {
  const tl = target || 'zh-CN';
  // 对齐缓存同样必须带引擎维度（理由见 translateWithCache）。
  // 版本号提到 al4：键结构变了（插入了引擎），旧的 al3 记录自然全部失效。
  const engine = (await getSettings()).engine || 'google';

  // ---- 1. 查缓存：对齐结果按「引擎 + 译文语言 + 原文 + 待高亮词集合」缓存 ----
  // fallback 记录该条是否是「标记失败退回纯译文」的降级结果：
  // 降级结果只用于当下渲染，不写入缓存，否则之后换生词也修不好（词没翻就是没翻）。
  const result = {
    texts: new Array(texts.length).fill(''),
    spans: new Array(texts.length).fill(null),
    fallback: new Array(texts.length).fill(false),
  };
  const missIdx = [];
  const missMarked = [];

  const keyOf = (i) =>
    `${engine}|${tl}|al4|${hashStr(texts[i])}|${hashStr(
      (Array.isArray(wordSets?.[i]) ? wordSets[i] : wordSets?.[i] ? [...wordSets[i]] : [])
        .map((w) => String(w).toLowerCase())
        .sort()
        .join(',')
    )}`;

  for (let i = 0; i < texts.length; i++) {
    const mk = markWords(texts[i], wordSets?.[i]);
    // 缓存键版本号 al4：早期版本会把「标记失败退回纯译文」的结果也写进来，
    // 那些记录的 spans 为空、译文里还夹着英文原词，换版本号即可整体绕过旧脏数据。
    const hit = await idbGet('translations', keyOf(i));
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
  for (let k = 0; k < missIdx.length; k++) {
    const i = missIdx[k];
    const raw = outs[k] || '';
    const mk = missMarked[k];

    if (!mk.slots.length) {
      result.texts[i] = stripMarkers(raw);
      result.spans[i] = [];
    } else {
      const { clean, spans } = parseMarked(raw, mk.slots);
      result.texts[i] = clean;
      result.spans[i] = spans.filter((s) => s.zh && s.start >= 0);
    }

    // ---- 4. 兜底：哨兵之间没有译出中文（Google 偶尔把标记内的词原样保留）----
    // 实测 "…save it to your ⟦0⟧wordbook⟦1⟧." 会原样返回英文，
    // 但同一个词单独送翻是正常的。这里对这类槽位单独补译，再在译文里就地替换。
    if (mk.slots.length) {
      await repairUntranslatedSlots(result, i, texts[i], mk, tl);
    }

    // ---- 5. 最终把关：只留下真的是中文的高亮 ----
    // 补译也可能失败（网络抖动 / 引擎就是不给译文）。这时 spans 里会留着
    // 「zh 是英文原词」的槽位，渲染出来就是中文字幕里夹一块高亮的英文 ——
    // 正是用户报的那个症状。宁可不高亮，也不显示一个假的高亮。
    //
    // 注意这一步**不能**挪进 parseMarked：parseMarked 必须保留坏槽位，
    // 否则 repairUntranslatedSlots 就找不到该补译的词了。
    result.spans[i] = cjkSpansOnly(result.spans[i]);

    if (result.texts[i]) {
      await idbPut('translations', {
        key: keyOf(i),
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
 * 只保留「真的是中文」的高亮片段。
 *
 * 一个槽位如果没翻出来（zh 为空、或 zh 就是英文原词），它不能作为高亮显示 ——
 * 否则中文字幕里会夹一块高亮的英文，比不高亮更让人困惑。
 */
function cjkSpansOnly(spans) {
  if (!Array.isArray(spans)) return [];
  return spans.filter(
    (s) => s && typeof s.zh === 'string' && /[\u4e00-\u9fff]/.test(s.zh) && s.start >= 0
  );
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
    // 译文里仍含英文原词（例如 "wordbook" 混在中文里）也算没翻干净。
    // 用 looseWordRe 而不是普通正则：Google 会在字母间插零宽字符，
    // 普通 /horizontal/ 匹配不到 horizo\u200B\u200Bntal，会漏判成「已翻译」。
    return looseWordRe(s.word).test(s.zh);
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
    // 在当前位置附近找英文原词（大小写不敏感，容忍零宽字符）
    const re = looseWordRe(s.word);
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
  // 缓存键必须带引擎维度：否则切到 MyMemory 时会命中 Google 写入的旧译文，
  // 界面看起来"切了但没变"；切回 Google 时也可能命中 MyMemory 的降级结果。
  const engine = (await getSettings()).engine || 'google';
  const result = new Array(texts.length).fill(null);
  const missIdx = [];
  const missTexts = [];

  for (let i = 0; i < texts.length; i++) {
    const key = `${engine}|${target}|${hashFn(texts[i])}`;
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
      // 同一道清零宽字符的关：googleOnce 已经清过，但大模型/MyMemory
      // 也可能吐出不可见字符，统一在这里收口。
      const txt = stripInvisible(outs[j] || '');
      result[gi] = txt;
      if (txt) {
        await idbPut('translations', {
          key: `${engine}|${target}|${hashFn(chunk[j])}`,
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
  // dictionaryapi.dev 返回的是**全称**（noun / verb / adjective），不是缩写。
  // 早期只映射了缩写，于是 POS_MAP['noun'] 取不到值，一路回退成英文原文，
  // 卡片上就出现了 noun / verb / adjective —— 用户说的「一堆英文」里有一部分是这个。
  noun: '名词', verb: '动词', adjective: '形容词', adverb: '副词',
  pronoun: '代词', preposition: '介词', conjunction: '连词',
  determiner: '限定词', interjection: '感叹词', numeral: '数词',
  auxiliary: '助动词', article: '冠词', particle: '小品词',
  'proper noun': '专有名词', exclamation: '感叹词',
};

async function lookupWord(word) {
  const w = word.trim();
  if (!w) return null;
  // dict2：旧缓存里的 meanings 只有英文 def、没有 defZh，也没有例句中文，
  // 不换版本号的话用户刷新后看到的还是旧卡片。
  const key = 'dict2|' + w.toLowerCase();
  const cached = await idbGet('translations', key);
  if (cached && cached.dict) return cached.dict;

  const dict = { word: w, phonetic: '', meanings: [], example: '', exampleZh: '', zh: '', senses: [] };

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
      // 每个词性最多取 2 条释义，整体最多 6 条 —— 再多会挤满卡片，
      // 而且要逐条翻成中文，条数直接决定查词延迟。
      (e.meanings || []).slice(0, 4).forEach((m) => {
        (m.definitions || []).slice(0, 2).forEach((d) => {
          if (dict.meanings.length >= 6) return;
          dict.meanings.push({
            pos: POS_MAP[m.partOfSpeech] || m.partOfSpeech || '',
            def: d.definition || '',
            defZh: '',
            example: d.example || '',
            exampleZh: '',
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

  await Promise.all([dictTask]);

  // 一次批量请求翻完三件事：单词直译、每条英文释义、例句。
  // 早期单词直译是单独一次 googleTranslate，释义又批量一次 —— 两次往返，
  // 而且其中一次超时就会出现「释义有中文、直译却是空」的残缺卡片。
  // 合成一次后要么都有、要么都没有，且少一个网络往返。
  const toZh = [w];
  for (const m of dict.meanings) if (m.def) toZh.push(m.def);
  if (dict.example) toZh.push(dict.example);
  try {
    const outs = await googleTranslate(toZh, 'en', 'zh-CN');
    let i = 0;
    dict.zh = outs[i++] || '';
    for (const m of dict.meanings) {
      if (m.def) m.defZh = outs[i++] || '';
    }
    if (dict.example) dict.exampleZh = outs[i] || '';
  } catch (_) {
    /* 翻译失败就只留英文释义，不影响卡片可用 */
  }

  // 词义清单：同一词性下把中文释义收拢成一行，方便快速扫读
  dict.senses = dict.meanings
    .filter((m) => m.defZh || m.def)
    .map((m) => ({ pos: m.pos, text: m.defZh || m.def }));

  await idbPut('translations', { key, dict, createdAt: Date.now() });
  return dict;
}

// ---------------------------------------------------------------- 短语查词
//
// 为什么不能只靠 Google：实测 10 个常见习语，Google 单句直译错 5 个
// （break a leg→"打断一条腿"、on the fence→"在栅栏上"、hit the sack→"解雇"）。
// 更麻烦的是 ASR 误听：字幕写 "pay your fair"（应为 fare），
// Google 翻成"支付你的公平"，而整句带上下文时能翻成"付钱"。
// 所以短语释义必须优先问大模型，并始终标注来源，让用户知道能信几分。

/** 归一化短语：折叠空白、去首尾标点、小写。生词本主键与去重都用它 */
function normPhrase(s) {
  return String(s || '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .toLowerCase();
}

/** 短语里有多少个词（按空白切） */
function phraseWordCount(s) {
  const t = String(s || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/**
 * 判断「整体译文」是否只是「逐词直译」拼起来的。
 *
 * 严格相等不管用：同一段英文，整体翻译和逐词翻译的虚词、助词、
 * 词尾「的/地/了」都会不一样（实测 pay your fair → 整体「支付你的公平」，
 * 逐词「支付你的公平的」）。所以这里比较的是去掉这些噪声后的主体字符。
 */
function looksLiteral(whole, literal) {
  const norm = (s) =>
    String(s || '')
      .replace(/[\s\u3000]/g, '')
      // 中文虚词/助词/量词：它们最容易在两种翻法里增减，不构成"意思不同"
      .replace(/[的了着过地得吗呢吧啊呀哦嘛]/g, '')
      .replace(/[，。、；：！？,.!?;:'"「」『』()（）]/g, '');
  const a = norm(whole);
  const b = norm(literal);
  if (!a || !b) return false;
  if (a === b) return true;
  // 一边包含另一边（长度差不超过 4 字）也算逐词拼接
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.includes(short) && long.length - short.length <= 4;
}

const PHRASE_MAX_WORDS = 5; // 用户要求"偏紧"：超过 5 个词不当短语
const PHRASE_MAX_CHARS = 60;

/**
 * 查短语。返回：
 * { phrase, gloss, literal, source, note, words:[{w, zh}], cached }
 * source: 'llm' | 'google' | 'literal'（逐词拼接兜底）
 */
async function lookupPhrase({ phrase, context, contextZh } = {}) {
  const p = normPhrase(phrase);
  if (!p) return null;
  const st = await getSettings();
  const tl = normLang(st.targetLang || 'zh-CN');
  const key = `phrase|${tl}|${hashStr(p)}|${hashStr(normPhrase(context || '').slice(0, 200))}`;

  // 缓存：同一短语在同一句里查第二次不必再问网络
  const hit = await idbGet('translations', key);
  if (hit && hit.phrase && String(hit.phrase.gloss || '').trim()) {
    return { ...hit.phrase, cached: true };
  }

  const words = p.split(/\s+/).filter(Boolean);
  const result = {
    phrase: p,
    gloss: '',
    literal: '',
    source: '',
    note: '',
    words: [],
  };

  // 逐词对照 + 逐词直译拼接（这部分永远要做，是最可靠的兜底）
  const wordZh = await googleTranslate(words, 'en', tl).catch(() => []);
  result.words = words.map((w, i) => ({ w, zh: (wordZh[i] || '').trim() }));
  result.literal = result.words
    .map((x) => x.zh)
    .filter(Boolean)
    .join('');

  // Tier A：大模型（带上下文，能处理习语与 ASR 误听）
  if (llmReady(st)) {
    try {
      const sys =
        '你是英语学习助手。用户给出一段英文字幕和其中被选中的短语，' +
        '请给出该短语在【当前语境】中的中文释义。' +
        '注意：字幕来自语音识别，可能有同音误听（例如 fair 实为 fare），' +
        '若发现这种情况请在 note 里说明。只输出 JSON。';
      const user =
        `字幕：${String(context || phrase).slice(0, 400)}\n` +
        (contextZh ? `字幕译文：${String(contextZh).slice(0, 400)}\n` : '') +
        `短语：${p}`;
      const reply = await llmChat(
        [
          { role: 'system', content: sys },
          {
            role: 'user',
            content:
              user +
              '\n\n返回格式：{"gloss":"短语在当前语境的中文释义（简短，不超过12字）","note":"可选说明，没有就空字符串"}',
          },
        ],
        st
      );
      const j = extractJson(reply);
      const gloss = String((j && (j.gloss || j.zh)) || '').trim();
      if (gloss) {
        result.gloss = gloss;
        result.source = 'llm';
        result.note = String((j && j.note) || '').trim();
      } else {
        // 模型没按 JSON 回，但正文可能就是释义 —— 别浪费
        const plain = String(reply).trim().replace(/^["'「]|["'」]$/g, '');
        if (plain && plain.length <= 40) {
          result.gloss = plain;
          result.source = 'llm';
        }
      }
    } catch (e) {
      console.warn('[Trace bg] 短语释义走大模型失败，降级 Google', e && e.message);
    }
  }

  // Tier B：Google 短语整体翻译
  if (!result.gloss) {
    try {
      const outs = await googleTranslate([p], 'en', tl);
      const g = String((outs && outs[0]) || '').trim();
      if (g) {
        result.gloss = g;
        result.source = 'google';
        // 判断 Google 是否只是把逐词译文拼起来。
        // 不能做严格相等：实测 "pay your fair" 整体翻成「支付你的公平」，
        // 而逐词拼出来是「支付你的公平的」（fair 作形容词时多一个「的」），
        // 严格比较永远不相等，提示就永远不会出现 —— 而那正是最该提示的情况。
        // 所以先去掉虚词与标点再比，并且允许一边是另一边的子串。
        if (result.literal && looksLiteral(g, result.literal)) {
          result.note = '这句是按词拼出来的，可能不是它在这里的真正意思';
        }
      }
    } catch (_) {}
  }

  // Tier C：逐词直译兜底
  if (!result.gloss && result.literal) {
    result.gloss = result.literal;
    result.source = 'literal';
    result.note = '未能获取整体释义，此处为逐词直译';
  }

  if (!result.gloss) return null;

  await idbPut('translations', { key, phrase: result, createdAt: Date.now() });
  return { ...result, cached: false };
}

// ---------------------------------------------------------------- 生词本

async function addWord(payload) {
  const word = (payload.word || '').trim();
  if (!word) return null;
  // 短语与单词共用一张表：主键是归一化后的文本，短语含空格、单词不含，
  // 两者不会撞主键，所以去重/复习/删除/备份全都自动适用，不需要第二张表。
  const kind = payload.kind === 'phrase' ? 'phrase' : 'word';
  const key = kind === 'phrase' ? normPhrase(word) : word.toLowerCase();
  if (!key) return null;
  const existing = await idbGet('words', key);
  const rec = {
    word: key,
    kind,
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
  // 短语专有字段：只有短语才写，避免单词记录里堆一堆空字段
  if (kind === 'phrase') {
    rec.literal = payload.literal || '';
    rec.source = payload.source || '';
    rec.note = payload.note || '';
    rec.words = Array.isArray(payload.words) ? payload.words : [];
  }
  await idbPut('words', rec);
  scheduleAutoBackup();
  return rec;
}

async function listWords() {
  const all = await idbAll('words');
  return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * 只返回单词集合（小写），供内容脚本做高亮比对，比传全量记录轻得多。
 * 短语不在这里 —— 短语的匹配方式完全不同（跨词、连续、按最长优先），
 * 混在一起会让单词高亮逻辑去比对含空格的字符串，纯属干扰。
 */
async function wordKeys() {
  const all = await idbAll('words');
  return all.filter((w) => w.kind !== 'phrase').map((w) => w.word);
}

/** 生词本里的短语（归一化文本），内容脚本用它做连续多词高亮 */
async function phraseKeys() {
  const all = await idbAll('words');
  return all.filter((w) => w.kind === 'phrase').map((w) => w.word);
}

async function hasWord(word) {
  if (!word) return false;
  const raw = String(word).trim();
  // 先按短语查（含空格，或超过一个词）：用户选中 "pay your fair" 时
  // 要判断的是这个短语在不在生词本，而不是把它当一个单词去匹配。
  if (phraseWordCount(raw) > 1 || /\s/.test(raw)) {
    if (await idbGet('words', normPhrase(raw))) return true;
  }
  const w = raw.toLowerCase();
  if (await idbGet('words', w)) return true;
  // 词形变化也算「已在生词本」：收藏了 beverage，问 beverages 时应当回答 true，
  // 否则查词卡会显示「加入生词本」，与字幕上的高亮状态自相矛盾。
  const keys = await wordKeys();
  const set = new Set(keys.map((k) => String(k).toLowerCase()));
  return !!matchSaved(w, set);
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

// ---------------------------------------------------------------- 自动备份节流
//
// 生词变动（加词/删词/复习）都会触发备份，但用户可能连续点好几个词，
// 每次都下载一个文件会刷屏。所以合并成一次：30 秒内最多写一次盘。
//
// 另一个真实风险：Chrome 设置里若开了「下载前询问每个文件的保存位置」，
// chrome.downloads.download 即使 saveAs:false 也可能弹框。自动备份反复弹框
// 比不备份还糟，所以连续失败 3 次就自动关掉自动备份（只留手动备份）。

let autoBackupTimer = null;
const AUTO_BACKUP_GAP = 30000;
const AUTO_BACKUP_MAX_FAILS = 3;

function scheduleAutoBackup() {
  if (autoBackupTimer) clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(async () => {
    autoBackupTimer = null;
    try {
      const st = await getSettings();
      if (st.autoBackup === false) return;
      const last = st.lastBackupAt || 0;
      if (Date.now() - last < AUTO_BACKUP_GAP) return;
      await backupToFile();
      await setSettings({ lastBackupAt: Date.now(), autoBackupFails: 0 });
    } catch (e) {
      // 自动备份失败不打扰用户（可能是权限被拒、下载被拦、或弹框被取消），
      // 手动点「备份到文件」时会拿到明确报错。
      const st = await getSettings().catch(() => ({}));
      const fails = (st.autoBackupFails || 0) + 1;
      console.warn(`[Trace bg] 自动备份失败（第 ${fails} 次）`, e && e.message);
      if (fails >= AUTO_BACKUP_MAX_FAILS) {
        await setSettings({ autoBackup: false, autoBackupFails: fails }).catch(() => {});
        console.warn('[Trace bg] 自动备份连续失败，已自动关闭；可在词库页手动备份');
      } else {
        await setSettings({ autoBackupFails: fails }).catch(() => {});
      }
    }
  }, 1500);
}

async function removeWord(word) {
  await idbDel('words', String(word).toLowerCase());
  await broadcastWordsChanged();
  scheduleAutoBackup();
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
  scheduleAutoBackup();
  return rec;
}

async function exportWords() {
  const all = await listWords();
  return all;
}

// ---------------------------------------------------------------- 本地文件备份
//
// 为什么需要这一层：Chrome 在扩展被卸载/移除时会清空该扩展的 IndexedDB 与
// storage.local（浏览器机制，扩展侧无法阻止）。所以「卸载旧插件、装新插件」
// 必然丢数据。唯一能让数据活过卸载的办法，是写到扩展目录之外的普通文件里。
//
// 两种落盘方式，按优先级：
//   1. 用户选定的目录（File System Access）：页面用 showDirectoryPicker 选一个
//      文件夹，句柄存进 IndexedDB 的 meta store。SW 没有 showDirectoryPicker，
//      但**能用页面存下的句柄**（已实测 queryPermission:granted、写入成功），
//      所以自动备份也能静默写进那个目录，不弹任何框。这是首选。
//   2. 兜底：chrome.downloads + data URL 写进「下载」目录。MV3 的 SW 没有
//      URL.createObjectURL，但 data: URL 可以下载（已实测 state:complete）。
//      缺点：只能进「下载」，且若 Chrome 开了「下载前询问」可能弹框。

const BACKUP_FILE = 'trace-subtitles/wordbook-backup.json';
/** 用户目录里用的文件名（直接放在所选目录根下，不再套子目录） */
const BACKUP_BASENAME = 'trace-wordbook-backup.json';

/** 读出用户选定的备份目录句柄（没有则 null） */
async function getBackupDirHandle() {
  try {
    const rec = await idbGet('meta', 'backupDir');
    return (rec && rec.handle) || null;
  } catch (_) {
    return null;
  }
}

/** 保存用户选定的备份目录句柄；传 null 表示清除 */
async function setBackupDirHandle(handle, name) {
  if (!handle) {
    await idbDel('meta', 'backupDir');
    await setSettings({ backupDirName: '' });
    return { ok: true, cleared: true };
  }
  // 尽量要读写权限（页面里刚选的句柄通常已 granted）
  let perm = 'prompt';
  try {
    perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
  } catch (_) {
    /* 权限查询失败就照存，写入时再报错 */
  }
  await idbPut('meta', { key: 'backupDir', handle, name: name || handle.name || '' });
  await setSettings({ backupDirName: name || handle.name || '' });
  return { ok: perm === 'granted', permission: perm, name: name || handle.name || '' };
}

/** 把 JSON 写进用户选定的目录；返回 { ok, filename } 或抛错 */
async function writeBackupToDir(json) {
  const handle = await getBackupDirHandle();
  if (!handle) return null;
  // 权限可能因为浏览器重启而退化为 prompt，这里再确认一次
  let perm = 'granted';
  try {
    perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
  } catch (_) {}
  if (perm !== 'granted') {
    throw new Error('备份目录权限已失效，请在词库页重新选择目录');
  }
  const fh = await handle.getFileHandle(BACKUP_BASENAME, { create: true });
  const w = await fh.createWritable();
  await w.write(json);
  await w.close();
  return { ok: true, filename: `${handle.name || ''}/${BACKUP_BASENAME}` };
}

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  // 分块，避免 apply 参数过多导致栈溢出（生词多时 JSON 会很大）
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

function fromBase64Utf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 把生词本 + 设置序列化成备份对象 */
async function buildBackup() {
  return {
    format: 'trace-subtitles-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: await getSettings(),
    words: await listWords(),
  };
}

/**
 * 写一份备份。
 * 优先写进用户选定的目录（静默、可指定位置）；没有选就退回「下载」目录。
 * 返回 { ok, filename, relPath, via, count, at }
 */
async function backupToFile() {
  const data = await buildBackup();
  const json = JSON.stringify(data, null, 2);

  // 1) 用户选定的目录
  try {
    const r = await writeBackupToDir(json);
    if (r) {
      return {
        ok: true,
        filename: r.filename,
        relPath: BACKUP_BASENAME,
        via: 'dir',
        count: data.words.length,
        at: Date.now(),
      };
    }
  } catch (e) {
    // 选了目录但写失败（权限失效等）：不静默退回下载，否则用户以为写到自己目录了
    throw e;
  }

  // 2) 兜底：下载目录
  const url = 'data:application/json;base64,' + toBase64Utf8(json);
  const id = await chrome.downloads.download({
    url,
    filename: BACKUP_FILE,
    conflictAction: 'overwrite',
    saveAs: false,
  });
  // 等下载真正完成，才能回报准确的落盘路径
  const final = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (item && item.state !== 'in_progress') return resolve(item);
      if (Date.now() - t0 > 8000) return resolve(item || null);
      setTimeout(tick, 120);
    };
    tick();
  });
  if (final && final.state === 'interrupted') {
    throw new Error(final.error || 'download interrupted');
  }
  return {
    ok: true,
    filename: (final && final.filename) || BACKUP_FILE,
    // 给界面用的短路径（下载目录内相对位置），避免 toast 里塞上百字符的绝对路径
    relPath: BACKUP_FILE,
    via: 'download',
    count: data.words.length,
    at: Date.now(),
  };
}

/** 从用户选定的目录读回备份对象（没有目录或没文件则返回 null） */
async function readBackupFromDir() {
  const handle = await getBackupDirHandle();
  if (!handle) return null;
  try {
    const fh = await handle.getFileHandle(BACKUP_BASENAME);
    const f = await fh.getFile();
    const text = await f.text();
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/**
 * 从备份对象恢复：合并进 IndexedDB（同名 key 用备份里的覆盖，但保留
 * 本地更早的 createdAt 与更高的 reviewCount，避免恢复把学习进度清零）。
 */
async function restoreFromBackup(data, opts = {}) {
  if (!data || data.format !== 'trace-subtitles-backup' || !Array.isArray(data.words)) {
    throw new Error('不是有效的 Trace 生词本备份文件');
  }
  const replace = opts.replace === true;
  if (replace) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('words', 'readwrite');
      tx.objectStore('words').clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
  let added = 0, merged = 0;
  for (const w of data.words) {
    if (!w || !w.word) continue;
    const key = String(w.word).toLowerCase();
    const old = await idbGet('words', key);
    if (old) {
      // 保留本地学习进度：取两者中更早的加入时间、更晚的复习时间、更高的复习次数
      merged++;
      await idbPut('words', {
        ...w,
        word: key,
        createdAt: Math.min(old.createdAt || Infinity, w.createdAt || Infinity) || Date.now(),
        reviewCount: Math.max(old.reviewCount || 0, w.reviewCount || 0),
        lastReview: Math.max(old.lastReview || 0, w.lastReview || 0) || null,
        status:
          (old.reviewCount || 0) >= (w.reviewCount || 0) ? old.status || 'new' : w.status || 'new',
      });
    } else {
      added++;
      await idbPut('words', { ...w, word: key });
    }
  }
  if (data.settings && typeof data.settings === 'object') {
    await setSettings(data.settings);
  }
  await broadcastWordsChanged();
  return { ok: true, added, merged, total: data.words.length };
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
          {
            // 大模型地址是用户自填的任意域名，MV3 要求 host permission 覆盖才能 fetch。
            // optional_host_permissions 只声明了 "https://*/*"，所以真正请求前
            // 必须显式申请该 origin —— 否则 fetch 直接抛 TypeError: Failed to fetch，
            // 用户只会看到"连接失败"，完全猜不到是权限问题。
            const patch = msg.patch || {};
            if (typeof patch.llmBaseUrl === 'string') {
              const origin = llmOriginOf(patch.llmBaseUrl);
              if (origin) {
                try {
                  const has = await chrome.permissions.contains({ origins: [origin + '/*'] });
                  if (!has) {
                    // 必须由用户手势触发；popup 里点「测试连接/拉取模型」正是手势。
                    // 失败也不阻塞保存设置 —— 只是后面请求会失败并给出明确报错。
                    await chrome.permissions.request({ origins: [origin + '/*'] });
                  }
                } catch (e) {
                  console.warn('[Trace bg] 申请大模型域名权限失败', e && e.message);
                }
              }
            }
            sendResponse({ ok: true, data: await setSettings(patch) });
          }
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
        case 'phrase':
          {
            const p = await lookupPhrase({
              phrase: msg.phrase,
              context: msg.context,
              contextZh: msg.contextZh,
            });
            sendResponse({ ok: true, data: p });
          }
          break;
        case 'llm:models':
          try {
            sendResponse({ ok: true, data: await llmListModels() });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message) });
          }
          break;
        case 'llm:test':
          try {
            sendResponse({ ok: true, data: await llmTest() });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message) });
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
        case 'word:phrase-keys':
          sendResponse({ ok: true, data: await phraseKeys() });
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
        case 'backup:save':
          // 手动备份：写进用户选定的目录，没选就退回「下载」
          sendResponse({ ok: true, data: await backupToFile() });
          break;
        case 'backup:set-dir':
          // 页面已经把目录句柄自己写进 IndexedDB（句柄过不了消息通道），
          // 这里只记录名字用于界面显示。
          sendResponse({
            ok: true,
            data: await (async () => {
              const h = await getBackupDirHandle();
              const name = msg.name || (h && h.name) || '';
              await setSettings({ backupDirName: name });
              return { has: !!h, name };
            })(),
          });
          break;
        case 'backup:get-dir':
          // 返回目录名与当前权限状态（浏览器重启后权限可能退化为 prompt）
          sendResponse({
            ok: true,
            data: await (async () => {
              const h = await getBackupDirHandle();
              if (!h) return { has: false };
              let perm = 'prompt';
              try {
                perm = await h.queryPermission({ mode: 'readwrite' });
              } catch (_) {}
              const st = await getSettings();
              return {
                has: true,
                // 句柄本身读不到 name 时（极少数情况）退回设置里记的名字
                name: h.name || st.backupDirName || '已选文件夹',
                permission: perm,
              };
            })(),
          });
          break;
        case 'backup:clear-dir':
          // 句柄由页面从 IndexedDB 删除（同一源，页面能直接操作），
          // 这里只清设置里的名字。
          await setSettings({ backupDirName: '' });
          sendResponse({ ok: true, data: { cleared: true } });
          break;
        case 'backup:restore':
          // 从备份对象恢复（内容由词库页读文件后传进来）
          sendResponse({ ok: true, data: await restoreFromBackup(msg.data, { replace: msg.replace === true }) });
          break;
        case 'backup:read-dir':
          // 直接读用户目录里的备份文件（恢复时优先用它，省得用户再选文件）
          sendResponse({ ok: true, data: await readBackupFromDir() });
          break;
        case 'backup:auto':
          // 自动备份：仅在「自动备份」开关打开时执行，失败静默（不打扰用户）
          try {
            const st = await getSettings();
            if (st.autoBackup === false) {
              sendResponse({ ok: true, data: { skipped: true } });
              break;
            }
            sendResponse({ ok: true, data: await backupToFile() });
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
  /** 零宽字符处理：Google 会在英文词中间插 U+200B，导致所有正则匹配不到 */
  stripInvisible,
  looseWordRe,
  /** 补译之后的把关：只保留真的是中文的高亮片段 */
  cjkSpansOnly,
  /** 词形归一化：字幕里的词形能命中生词本里的哪个词（含单复数等变化） */
  wordForms,
  matchSaved,
  lookupWord,
  /** 短语查词（多词整体释义 + 逐词对照），大模型优先、Google 兜底 */
  lookupPhrase,
  normPhrase,
  phraseWordCount,
  looksLiteral,
  phraseKeys,
  llmChat,
  llmTranslateAll,
  llmListModels,
  llmTest,
  extractJson,
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
  reviewWord,
  /** 测试辅助：直接改设置（与 'settings:set' 消息等价） */
  setSettings,
  /** 测试辅助：与消息路由 'word:remove' 同一条路径（删除 + 广播） */
  removeWordNotify: (word) => removeWord(word),
  /** 本地文件备份：写一份 JSON 到用户选定的目录（没选则「下载」） */
  backupToFile,
  restoreFromBackup,
  buildBackup,
  getBackupDirHandle,
  setBackupDirHandle,
  readBackupFromDir,
};
