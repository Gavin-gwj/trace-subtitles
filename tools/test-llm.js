/**
 * test-llm.js —— 大模型引擎配置链路回归
 *
 * 背景（真实 bug）：chrome.permissions.request 必须在用户手势里调用。
 * 早期版本把它写在 bg.js 的 'settings:set' 处理器里，消息处理器没有手势
 * 上下文 → Chrome 抛 "This function must be called during a user gesture"
 * → 权限永远拿不到 → fetch 只会报 "Failed to fetch"，用户以为是地址/密钥错。
 *
 * 本测试跑真实弹窗页面（chrome-extension://<id>/popup.html），点真实按钮，
 * 验证：① 点「拉取模型列表」能拿到模型（= 权限申请成功）；② 点「测试连接」
 * 真发一条请求；③ 权限授予后后台能真的用大模型翻译。
 */
const path = require('path');
const { chromium } = require('playwright');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const LLM = 'https://llm.test';
const MODELS = ['fake-alpha', 'fake-beta', 'fake-gamma'];

const checks = {};
const failed = [];
function check(name, ok, extra) {
  checks[name] = !!ok;
  if (!ok) failed.push(name);
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

(async () => {
  const ctx = await chromium.launchPersistentContext(
    path.join(__dirname, '.chrome-llm'),
    {
      headless: false,
      executablePath: CHROME,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--mute-audio',
      ],
      viewport: { width: 420, height: 700 },
      locale: 'zh-CN',
    }
  );

  // 假大模型服务：/models 与 /chat/completions
  let chatHits = 0;
  let lastChatBody = null;
  await ctx.route(LLM + '/**', async (route) => {
    const url = route.request().url();
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    };
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: cors, body: '' });
    }
    if (/\/models(\?|$)/.test(url)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: cors,
        body: JSON.stringify({ data: MODELS.map((id) => ({ id })) }),
      });
    }
    if (/\/chat\/completions(\?|$)/.test(url)) {
      chatHits++;
      try {
        lastChatBody = JSON.parse(route.request().postData() || '{}');
      } catch (_) {}
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: cors,
        body: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '【LLM】这是大模型译文' } }],
        }),
      });
    }
    return route.fulfill({ status: 404, headers: cors, body: '{}' });
  });

  // 等 SW 起来拿扩展 id
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  console.log('extId:', extId);

  // 清掉上一轮可能残留的授权与配置，保证从零开始。
  // 这一步不能省：权限是持久化的，上一轮跑过之后 https://llm.test/* 仍是已授权
  // 状态，fetch 能直接成功 —— 那样这个测试就抓不到「没在手势里申请权限」的 bug 了。
  const clean = await sw.evaluate(async (base) => {
    const { settings } = await chrome.storage.local.get('settings');
    const next = { ...(settings || {}), llmBaseUrl: '', llmApiKey: '', llmModel: '' };
    await chrome.storage.local.set({ settings: next });
    let removed = false;
    try {
      const u = new URL(base);
      removed = await chrome.permissions.remove({ origins: [u.origin + '/*'] });
    } catch (_) {}
    const still = await chrome.permissions.contains({ origins: ['https://llm.test/*'] });
    return { removed, still };
  }, LLM + '/v1');
  console.log('clean state:', clean);
  check('P0 起始状态未授权（否则测不出权限 bug）', clean.still === false, clean);

  // 打开真实弹窗页面（不是 popup 窗口，但同源同 API，按钮逻辑一致）
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.type(), m.text());
  });
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  // 切到「大模型」引擎，让配置区展开
  await page.selectOption('#engine', 'llm');
  await page.waitForTimeout(300);
  const groupShown = await page.evaluate(
    () => getComputedStyle(document.getElementById('llmGroup')).display !== 'none'
  );
  check('P1 选中「大模型」后配置区展开', groupShown);

  // 填地址与密钥
  await page.fill('#llmBaseUrl', LLM + '/v1');
  await page.fill('#llmApiKey', 'sk-test-key');
  await page.waitForTimeout(300);
  console.log(
    'form:',
    await page.evaluate(() => ({
      base: document.getElementById('llmBaseUrl').value,
      key: document.getElementById('llmApiKey').value,
      hint: document.getElementById('llmHint').textContent,
    }))
  );

  // —— 关键：点真实按钮，走真实手势里的 permissions.request ——
  await page.click('#llmFetch');
  // 等提示文案出现（最多 12s）
  let hint = '';
  for (let i = 0; i < 40; i++) {
    hint = (await page.textContent('#llmHint')) || '';
    if (/个模型|失败|授权|没拉到/.test(hint)) break;
    await page.waitForTimeout(300);
  }
  const opts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#llmModel option')).map((o) => o.value)
  );
  check('P2 点「拉取模型列表」能拿到模型', opts.length === MODELS.length, {
    hint: hint.trim(),
    opts,
  });
  check('P3 模型列表内容正确', opts.join(',') === MODELS.join(','), { opts });

  // 验证权限真的被授予了（这是 bug 的根因所在）
  const permGranted = await sw.evaluate(async (base) => {
    try {
      const u = new URL(base);
      return await chrome.permissions.contains({ origins: [u.origin + '/*'] });
    } catch (_) {
      return false;
    }
  }, LLM + '/v1');
  check('P4 点击后该域名权限已授予', permGranted === true, { permGranted });

  // 选模型 + 测试连接
  await page.selectOption('#llmModel', MODELS[1]);
  await page.waitForTimeout(300);
  await page.click('#llmTest');
  let thint = '';
  for (let i = 0; i < 40; i++) {
    thint = (await page.textContent('#llmHint')) || '';
    if (/连接正常|连接失败/.test(thint)) break;
    await page.waitForTimeout(300);
  }
  check('P5 点「测试连接」返回连接正常', /连接正常/.test(thint), { hint: thint.trim() });
  check('P6 测试连接真的发出了请求', chatHits >= 1, { chatHits });
  check(
    'P7 请求带了配置的模型名',
    !!lastChatBody && lastChatBody.model === MODELS[1],
    { model: lastChatBody && lastChatBody.model }
  );

  // 权限到位后，后台应当能真的用大模型翻译
  const trans = await sw.evaluate(async () => {
    try {
      const out = await globalThis.__traceDebug.translateBatch(
        ['Click any word to look it up', 'and save it to your wordbook'],
        'en',
        'zh-CN'
      );
      return { ok: true, out };
    } catch (e) {
      return { ok: false, err: String((e && e.message) || e) };
    }
  });
  check('P8 权限到位后后台能调通大模型', trans.ok === true, trans);
  check(
    'P9 大模型译文非空',
    trans.ok && Array.isArray(trans.out) && trans.out.filter((s) => s && s.trim()).length >= 1,
    { out: trans.out }
  );

  check('P10 无 JS 错误', errors.length === 0, { errors });

  await page.screenshot({ path: path.join(__dirname, 'shot-llm.png'), fullPage: false });
  await ctx.close();

  console.log('');
  if (failed.length) {
    console.log('RESULT: FAIL (' + failed.join(', ') + ')');
    process.exit(1);
  }
  console.log('RESULT: PASS（大模型配置：手势里申请权限 + 拉模型 + 测试连接 + 后台可用）');
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
