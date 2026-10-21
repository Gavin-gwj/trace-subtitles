/**
 * 给生词本看板种一份「看起来像真在用」的数据。
 * 只在截图/走查脚本里用，不参与回归测试。
 *
 * 【为什么从 addWordNotify 走一遍再改字段】
 * 直接 idb.put 会漏掉后台 addWord 里那些派生字段（key 归一化、reviewCount
 * 初始化、短语的 literal/words 结构）。先让真实写入路径把它建成完整记录，
 * 再按设计稿需要的分布回填统计字段，导出的 JSON 结构和线上完全一致。
 *
 * 【为什么不用 new Function / eval】
 * 扩展的 service worker 受 MV3 CSP 约束，eval 与 new Function 一律被拒，
 * 会静默卡住整个 evaluate 调用。所以这里只传纯数据，字段一个个赋值。
 *
 * 参数 sw：service worker 的 Playwright 上下文（__traceDebug 只挂在 SW 上，
 * 页面里没有，别在 page.evaluate 里调）。
 */
const DAY = 86400000;

const WORDS = [
  { word: 'pipeline', zh: '流水线；管线', ph: '/ˈpaɪplaɪn/', at: 1, s: 'new', f: 3, z: 1, r: 0, rc: 4 },
  { word: 'overlay', zh: '覆盖层；叠加显示', ph: '/ˈəʊvəleɪ/', at: 2, s: 'new', f: 0, z: 0, r: 0, rc: 0 },
  { word: 'subtitle', zh: '字幕；副标题', ph: '/ˈsʌbtaɪtl/', at: 3, s: 'new', f: 1, z: 2, r: 0, rc: 3 },
  { word: 'translate', zh: '翻译；转化', ph: '/trænsˈleɪt/', at: -1 * DAY + 1000, s: 'learning', f: 2, z: 3, r: 1, rc: 6 },
  { word: 'segment', zh: '片段；分段', ph: '/ˈseɡmənt/', at: -1 * DAY + 5000, s: 'new', f: 0, z: 0, r: 0, rc: 0 },
  { word: 'caption', zh: '字幕轨；（图片）说明文字', ph: '/ˈkæpʃn/', at: -2 * DAY + 1000, s: 'learned', f: 1, z: 1, r: 4, rc: 6 },
  { word: 'bilingual', zh: '双语的', ph: '/ˌbaɪˈlɪŋɡwəl/', at: -3 * DAY + 5000, s: 'learning', f: 0, z: 2, r: 2, rc: 4 },
  { word: 'highlight', zh: '高亮；突出显示', ph: '/ˈhaɪlaɪt/', at: -4 * DAY, s: 'learned', f: 0, z: 1, r: 3, rc: 4 },
  { word: 'latency', zh: '延迟；时延', ph: '/ˈleɪtənsi/', at: -6 * DAY, s: 'learning', f: 4, z: 1, r: 1, rc: 6 },
  { word: 'throughput', zh: '吞吐量', ph: '/ˈθruːpʊt/', at: -8 * DAY, s: 'new', f: 0, z: 0, r: 0, rc: 0 },
  { word: 'render', zh: '渲染；呈现', ph: '/ˈrendə/', at: -11 * DAY, s: 'learned', f: 2, z: 2, r: 5, rc: 9 },
  { word: 'coalesce', zh: '合并；结合', ph: '/ˌkəʊəˈles/', at: -15 * DAY, s: 'learning', f: 1, z: 1, r: 2, rc: 4 },
  { word: 'sparse', zh: '稀疏的', ph: '/spɑːs/', at: -22 * DAY, s: 'new', f: 0, z: 0, r: 0, rc: 0 },
  { word: 'heuristic', zh: '启发式的；探索性的', ph: '/hjʊˈrɪstɪk/', at: -35 * DAY, s: 'learned', f: 3, z: 1, r: 3, rc: 7 },
];

const VIDEO = 'Building a Subtitle Pipeline with Zero Dependencies';
const VID = 'TESTID00001';

/** 直接改一条已存在记录的字段（纯数据入参，不拼代码） */
async function patch(sw, word, fields) {
  return sw.evaluate(
    async ({ word, fields }) => {
      const db = await globalThis.__traceDebug.openDB();
      return new Promise((res, rej) => {
        const tx = db.transaction('words', 'readwrite');
        const store = tx.objectStore('words');
        const cur = store.get(word);
        cur.onsuccess = () => {
          if (!cur.result) return;
          Object.assign(cur.result, fields);
          store.put(cur.result);
        };
        tx.oncomplete = () => res(true);
        tx.onerror = () => rej(tx.error);
      });
    },
    { word, fields }
  );
}

async function clear(sw) {
  await sw.evaluate(async () => {
    const db = await globalThis.__traceDebug.openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('words', 'readwrite');
      tx.objectStore('words').clear();
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  });
}

async function seed(sw) {
  await clear(sw);

  const t0 = await sw.evaluate(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  });

  // 1) 走真实写入路径建记录
  for (const it of WORDS) {
    await sw.evaluate(
      async ({ it, video, vid }) => {
        await globalThis.__traceDebug.addWordNotify({
          word: it.word,
          zh: it.zh,
          phonetic: it.ph,
          context: `The ${it.word} layer sits between the parser and the renderer, which is why we measure it separately.`,
          contextZh: `${it.zh.split('；')[0]}这一层位于解析器和渲染器之间，所以我们单独对它做测量。`,
          videoTitle: video,
          videoId: vid,
          time: 412,
          meanings: [
            { pos: 'n.', def: `the ${it.word} of a system, as used when discussing its overall behaviour` },
            { pos: 'v.', def: `to apply ${it.word} to a value before it is handed to the next stage` },
          ],
        });
      },
      { it, video: VIDEO, vid: VID }
    );
  }

  // 2) 回填统计分布
  for (const it of WORDS) {
    await patch(sw, it.word, {
      createdAt: t0 + it.at,
      status: it.s,
      forgetCount: it.f,
      fuzzyCount: it.z,
      rememberCount: it.r,
      reviewCount: it.rc,
      lastReview: t0 + it.at + DAY,
    });
  }

  // 3) 一条短语
  await sw.evaluate(
    async ({ video, vid }) => {
      await globalThis.__traceDebug.addWordNotify({
        word: 'pay your fair',
        kind: 'phrase',
        zh: '支付你该付的那份',
        source: 'llm',
        context: 'Everyone has to pay your fair share of the cost.',
        contextZh: '每个人都得承担自己那份成本。',
        videoTitle: video,
        videoId: vid,
        time: 512,
        words: [
          { w: 'pay', zh: '支付' },
          { w: 'your', zh: '你的' },
          { w: 'fair', zh: '公平的；应得的' },
        ],
        literal: '付你的公平',
        note: '字幕里 fair 可能是 fare 的误听',
      });
    },
    { video: VIDEO, vid: VID }
  );
  await patch(sw, 'pay your fair', {
    createdAt: t0 - 2 * DAY + 8000,
    status: 'learning',
    forgetCount: 1,
    fuzzyCount: 1,
    rememberCount: 0,
    reviewCount: 2,
    lastReview: t0 - DAY,
  });

  return WORDS.length + 1;
}

module.exports = { seed, clear, WORDS, DAY };
