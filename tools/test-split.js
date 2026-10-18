/**
 * 分句专项测试：句中句号必须断开
 *
 * 背景（用户报障）：
 *   "一个句子里中间已经有一个句号了，前后两句被连在一起展示，两行英文太长。"
 *
 * 根因：segment() 只在「文本结尾」判 SENT_END。一条 cue 里塞两句是 ASR 字幕的常态
 * （"...vocabulary. The thinking goes, ..."），中间那个句号完全没起作用，
 * 于是两句被当成一句，英文撑成两行长行。
 *
 * 本测试直接调 subtitles.js 的 segment()，不需要浏览器 —— 分句是纯函数，
 * 用 Playwright 跑反而更慢且更难定位。
 *
 * 用法: node test-split.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.resolve(__dirname, '..', 'trace-subtitles');

// 在干净的 vm 上下文里加载 subtitles.js，拿到 window.TraceSubs
function loadSubs() {
  const code = fs.readFileSync(path.join(EXT, 'subtitles.js'), 'utf8');
  const sandbox = { window: {}, DOMParser: class {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'subtitles.js' });
  if (!sandbox.window.TraceSubs) throw new Error('subtitles.js 没有挂出 window.TraceSubs');
  return sandbox.window.TraceSubs;
}

const checks = {};
const detail = {};
function check(name, ok, extra) {
  checks[name] = !!ok;
  if (extra !== undefined) detail[name] = extra;
  console.log(`${ok ? '✓' : '✗'} ${name}`, extra === undefined ? '' : JSON.stringify(extra));
}

/** 把 [text, text, ...] 造成带时间轴的 rows（每条 cue 2 秒，首尾相接） */
function rows(...texts) {
  return texts.map((text, i) => ({ start: i * 2, end: i * 2 + 2, text }));
}

const subs = loadSubs();
const { segment } = subs;

const texts = (sents) => sents.map((s) => s.text);

// ---------------------------------------------------------------- 核心用例
{
  // 一条 cue 里两句：前句有句号，后句以逗号结尾。
  // 这正是用户截图里的形态。
  const out = texts(
    segment(
      rows(
        "speakers is simply because they don't know enough vocabulary. The thinking goes, if I just memorize more words,"
      ),
      { maxLen: 120 }
    )
  );
  check('S1 句中句号处断开（一句变两句）', out.length === 2, out);
  check(
    'S2 第一段以 vocabulary. 结尾',
    /vocabulary\.$/.test(out[0] || ''),
    out[0]
  );
  check(
    'S3 第二段从 The thinking 开始',
    /^The thinking/.test(out[1] || ''),
    out[1]
  );
  check(
    'S4 断开后每段都短于 120 字符（不再撑成两行长行）',
    out.every((t) => t.length <= 120),
    out.map((t) => t.length)
  );
}

// ---------------------------------------------------------------- 边界：不拆
{
  // 单句、中间没有任何句末标点 → 必须原样一条，不能被拆开
  const src = 'this is one single sentence without any period inside it at all';
  const out = texts(segment(rows(src), { maxLen: 120 }));
  check('S5 单句无句号时不拆开', out.length === 1 && out[0] === src, out);
}

{
  // 句号在结尾 → 本来就该收句，不能多切出一段空的
  const out = texts(segment(rows('So today we are going to talk about it.'), { maxLen: 120 }));
  check('S6 结尾句号不多切出空段', out.length === 1 && out[0].endsWith('it.'), out);
}

// ---------------------------------------------------------------- 其他句末标点
{
  const out = texts(segment(rows('Really? I cannot believe it! Let us go.'), { maxLen: 120 }));
  check('S7 问号/感叹号同样断开', out.length === 3, out);
  check('S8 三段内容依次正确', /Really\?$/.test(out[0]) && /believe it!$/.test(out[1]), out);
}

{
  // 引号里的句号：句号后面是收引号，断在引号之后而不是引号之前
  const out = texts(segment(rows('He said "stop." Then he left.'), { maxLen: 120 }));
  check('S9 引号后的句号断开且引号留在前句', out.length === 2 && /"stop\."$/.test(out[0]), out);
}

// ---------------------------------------------------------------- 时间轴
{
  // 断开后两段都要有时间轴，且都在原 cue 区间内 ——
  // 否则 findByTime 只命中第一段，第二段永远显示不出来。
  const out = segment(
    rows("speakers is simply because they don't know enough vocabulary. The thinking goes, if I just memorize more words,"),
    { maxLen: 120 }
  );
  const ok =
    out.length === 2 &&
    out[0].start === 0 &&
    out[1].start > out[0].start &&
    out[1].start >= out[0].end - 1e-6 &&
    out[out.length - 1].end <= 2 + 1e-6;
  check('S10 断开后时间轴按长度分摊且覆盖原 cue', ok, out.map((s) => [s.start.toFixed(2), s.end.toFixed(2)]));
}

// ---------------------------------------------------------------- 多 cue 合并
{
  // 两条 cue，第一条没有句末标点 → 应当合并（这是原有的「碎片行合并成句」能力，
  // 不能被本次修复破坏）。中间缺句号时靠长度上限断开。
  const out = texts(
    segment(
      rows(
        "speakers is simply because they don't know enough vocabulary",
        'The thinking goes, if I just memorize more words,'
      ),
      { maxLen: 120 }
    )
  );
  check('S11 跨 cue 无标点时仍按原逻辑合并', out.length === 1, out);
}

{
  // 两条 cue，第一条已带句号 → 各自成句，不会被合并
  const out = texts(
    segment(
      rows(
        "speakers is simply because they don't know enough vocabulary.",
        'The thinking goes, if I just memorize more words,'
      ),
      { maxLen: 120 }
    )
  );
  check('S12 跨 cue 已有句号时各自成句', out.length === 2, out);
}

// ---------------------------------------------------------------- 结果
const failed = Object.keys(checks).filter((k) => !checks[k]);
console.log('');
if (failed.length) {
  console.log('RESULT: FAIL (' + failed.join(', ') + ')');
  process.exit(1);
}
console.log('RESULT: PASS（句中句号断开 + 单句不拆 + 时间轴分摊 + 跨 cue 合并不回归）');
