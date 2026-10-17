/**
 * 探测：哪种「哨兵/标记」风格能让 Google 既保留标记、又把标记里的词翻译出来
 *
 * 已知问题：⟦0⟧wordbook⟦1⟧ 会被原样保留（wordbook 不翻），
 * 而 ⟦0⟧word⟦1⟧ 能翻成 单词。怀疑是「标记紧贴单词」让 Google 把它当占位符。
 */
const { chromium } = require('playwright');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');

const SENTENCES = [
  'Click any word to look it up and save it to your wordbook.',
  'The first step is to capture the subtitle tracks from the player.',
];

// 每种风格给一个 make(word, idx) -> string
const STYLES = {
  bracket_noSpace: (w, i) => `\u27E6${i * 2}\u27E7${w}\u27E6${i * 2 + 1}\u27E7`,
  bracket_space: (w, i) => `\u27E6${i * 2}\u27E7 ${w} \u27E6${i * 2 + 1}\u27E7`,
  cjk_bracket: (w, i) => `\u3010${i * 2}\u3011${w}\u3010${i * 2 + 1}\u3011`,
  angle: (w, i) => `<${i * 2}>${w}</${i * 2 + 1}>`,
  brace: (w, i) => `{{${i * 2}}}${w}{{${i * 2 + 1}}}`,
  square: (w, i) => `[[${i * 2}]]${w}[[${i * 2 + 1}]]`,
  hash: (w, i) => `#${i * 2}#${w}#${i * 2 + 1}#`,
  guillemet: (w, i) => `\u00AB${i * 2}\u00BB${w}\u00AB${i * 2 + 1}\u00BB`,
  bold: (w, i) => `<b>${w}</b>`,
  zwj: (w, i) => `\u200B${i * 2}\u200B${w}\u200B${i * 2 + 1}\u200B`,
  tilde: (w, i) => `~${i * 2}~${w}~${i * 2 + 1}~`,
  lrm: (w, i) => `\u202A${i * 2}\u202C${w}\u202A${i * 2 + 1}\u202C`,
};

function mark(text, words, styleFn) {
  const hits = [];
  const re = /[A-Za-z][A-Za-z'’-]*/g;
  const set = new Set(words.map((w) => w.toLowerCase()));
  let m;
  while ((m = re.exec(text))) if (set.has(m[0].toLowerCase())) hits.push({ s: m.index, e: m.index + m[0].length, w: m[0] });
  if (!hits.length) return text;
  let out = '', i = 0, k = 0;
  for (const h of hits) {
    out += text.slice(i, h.s) + styleFn(text.slice(h.s, h.e), k++);
    i = h.e;
  }
  return out + text.slice(i);
}

const CJK = /[\u4e00-\u9fff]/;
const LATIN_WORD = /[A-Za-z]{3,}/;

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.chrome-sentprobe'), {
    headless: true,
    executablePath: CHROME,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  if (!sw) { console.log('no SW'); await ctx.close(); process.exit(1); }
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('about:blank');

  const report = {};
  for (const [name, fn] of Object.entries(STYLES)) {
    report[name] = [];
    for (const s of SENTENCES) {
      const marked = mark(s, ['word', 'wordbook', 'capture', 'subtitle', 'tracks', 'player'], fn);
      const r = await sw.evaluate(async (m) => {
        try {
          const out = await globalThis.__traceDebug.translateBatch([m], 'en', 'zh-CN');
          return out[0];
        } catch (e) { return 'ERR: ' + e.message; }
      }, marked);
      report[name].push({ marked, out: r });
    }
  }

  // 汇总：标记保留情况 + 标记内是否还残留英文
  console.log('==== 汇总 ====\n');
  for (const [name, rows] of Object.entries(report)) {
    const verdicts = rows.map((r) => {
      const out = r.out || '';
      const keep = /\d/.test(out) ? 'MARK' : 'nomark';
      const latin = LATIN_WORD.test(out.replace(/\d+/g, '')) ? 'HAS_EN' : 'all-zh';
      return `${keep}/${latin}`;
    });
    console.log(`${name.padEnd(18)} ${verdicts.join('  ')}`);
  }
  console.log('\n==== 原文 ====\n');
  for (const [name, rows] of Object.entries(report)) {
    console.log(`\n--- ${name} ---`);
    rows.forEach((r) => {
      console.log('  IN :', r.marked);
      console.log('  OUT:', r.out);
    });
  }

  await ctx.close();
})();
