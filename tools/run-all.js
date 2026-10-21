/**
 * 跑全部回归测试，逐条输出 RESULT 行。
 * 用法: node run-all.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  'test-mock.js',
  'test-pot.js',
  'test-center.js',
  'test-ui.js',
  'test-zh-highlight.js',
  'test-wordbook.js',
  'test-frame.js',
  'test-settings.js',
  'test-forms.js',
  'test-backup.js',
  'test-global.js',
  'test-dodge.js',
  'test-dict.js',
  'test-prefetch.js',
  'test-phrase.js',
  'test-invisible.js',
  'test-llm.js',
  'test-split.js',
  'test-card.js',
  'test-review.js',
  'test-reviewpage.js',
  'test-align.js',
];

const results = [];
for (const f of SUITES) {
  process.stdout.write(`\n===== ${f} =====\n`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], {
    cwd: __dirname,
    encoding: 'utf8',
    timeout: 600000,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const line = (out.match(/RESULT: .*/g) || []).pop() || '(no RESULT line)';
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  results.push({ f, ok: /RESULT: PASS/.test(line), line, secs });
  // 失败时把最后几十行贴出来，方便定位
  if (!/RESULT: PASS/.test(line)) {
    console.log(out.split(/\r?\n/).slice(-40).join('\n'));
  }
  console.log(`${line}  [${secs}s]`);
}

console.log('\n===== SUMMARY =====');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.f.padEnd(22)} ${r.secs}s  ${r.line}`);
}
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} suite(s) FAILED` : '\nALL SUITES PASS');
process.exit(bad.length ? 1 : 0);
