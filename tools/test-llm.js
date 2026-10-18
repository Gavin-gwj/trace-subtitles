/**
 * test-llm.js —— 大模型引擎配置链路回归
 *
 * 背景（真实 bug 17）：`chrome.permissions.request` 必须在用户手势里调用。
 * 早期版本把它写在 bg.js 的 `'settings:set'` 处理器里，消息处理器没有手势
 * 上下文 → Chrome 抛 "This function must be called during a user gesture"
 * → 权限永远拿不到 → fetch 只会报 "Failed to fetch"，用户以为是地址/密钥错。
 *
 * ## 这个测试怎么避开「原生弹框点不到」
 *
 * Chrome 的扩展权限弹框是浏览器原生 Views 气泡，Playwright 点不到；实测 8 组
 * 候选启动参数全部无效，`request()` 的 promise 永远挂着（详见 lib/perm-ext.js）。
 *
 * 所以：把扩展复制到固定临时目录，并在 `host_permissions` 里预置 `llm.test`
 * （等价于「用户此前已允许」），再走真实点击。这样 fetch 真能发出。
 *
 * ## 预置了权限，还怎么抓 bug 17
 *
 * 判据是**调用次数**，不是手势状态：bug 17 的代码把申请交给后台，popup 页面
 * 从头到尾一次都不会调用 `chrome.permissions.request`。
 *
 *   P4 点「拉取模型列表」后 popup 自己发起了权限申请   ← 修复前恒为 0 次
 *   P4b 申请带的是填写的那个 origin
 *
 * 反向验证：注释掉 popup.js 里两处 `requestLlmOrigin()` → P4/P4b 立刻 FAIL。
 *
 * 验证：① 点「拉取模型列表」能拿到模型；② 点「测试连接」真发一条请求；
 * ③ 后台能真的用大模型翻译；④ 服务挂掉时降级不白屏。
 */
const path = require('path');
const { chromium } = require('playwright');
const {
  copyExtWithHost,
  installPermProbe,
  readPermCalls,
} = require('./lib/perm-ext');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// 预置了 llm.test 的扩展副本；固定路径 → 扩展 ID 稳定
const EXT = path.join(__dirname, '.perm-ext-llm');
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
  copyExtWithHost(LLM, EXT);

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

  // 清掉上一轮可能残留的配置，保证从零开始。
  // 注意：这里**不** remove 权限 —— 权限是 manifest 预置的，remove 掉就再也拿不回来
  // （request 会弹原生框挂住）。预置权限不影响 bug 17 的判别力，因为判据是
  // 「popup 有没有自己发起申请」，与权限最终是否授予无关。
  const clean = await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    const next = { ...(settings || {}), llmBaseUrl: '', llmApiKey: '', llmModel: '' };
    await chrome.storage.local.set({ settings: next });
    return await chrome.permissions.contains({ origins: ['https://llm.test/*'] });
  });
  console.log('pre-granted:', clean);
  check('P0 预置权限已生效（否则走不到 fetch）', clean === true, { preGranted: clean });

  // 打开真实弹窗页面（不是 popup 窗口，但同源同 API，按钮逻辑一致）
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.type(), m.text());
  });
  // 观察器必须在 goto 之前装：它要包住 popup.js 加载后就绑定的那批处理器
  await installPermProbe(page);
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

  // —— bug 17 的判别点 ——
  // 申请必须由 popup 页面自己在 click 处理器里发起。修复前申请写在 bg.js 的
  // 消息处理器里，popup 一次都不会调用 request()，所以这里会是空数组。
  const calls = await readPermCalls(page);
  check('P4 popup 自己发起了权限申请（修复前恒为 0 次）', calls.length >= 1, {
    calls: calls.map((c) => c.origins),
  });
  const askedOrigin = calls.length ? (calls[calls.length - 1].origins || [])[0] : '';
  check(
    'P4b 申请的是填写的那个 origin',
    askedOrigin === LLM + '/*',
    { askedOrigin, want: LLM + '/*' }
  );

  // 验证权限确实已生效（fetch 能打出去）
  const permGranted = await sw.evaluate(async (base) => {
    try {
      const u = new URL(base);
      return await chrome.permissions.contains({ origins: [u.origin + '/*'] });
    } catch (_) {
      return false;
    }
  }, LLM + '/v1');
  check('P5 该域名权限已授予', permGranted === true, { permGranted });

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
  check('P6 点「测试连接」返回连接正常', /连接正常/.test(thint), { hint: thint.trim() });
  check('P7 测试连接真的发出了请求', chatHits >= 1, { chatHits });
  check(
    'P8 请求带了配置的模型名',
    !!lastChatBody && lastChatBody.model === MODELS[1],
    { model: lastChatBody && lastChatBody.model }
  );
  // 测试连接也必须走同一套权限申请（否则用户只点「测试连接」时拿不到权限）
  const calls2 = await readPermCalls(page);
  check('P8b 测试连接也发起了权限申请', calls2.length >= 2, { n: calls2.length });

  // 后台应当能真的用大模型翻译
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
  check('P9 后台能调通大模型', trans.ok === true, trans);
  check(
    'P10 大模型译文非空',
    trans.ok && Array.isArray(trans.out) && trans.out.filter((s) => s && s.trim()).length >= 1,
    { out: trans.out }
  );

  // 服务挂掉时必须降级，不能白屏
  const down = await sw.evaluate(async () => {
    // 指向一个不会被 route 拦截的端口，制造网络失败
    await globalThis.__traceDebug.setSettings({ llmBaseUrl: 'https://llm-down.test/v1' });
    try {
      const out = await globalThis.__traceDebug.translateBatch(['Something brand new.'], 'en', 'zh-CN');
      return { ok: true, out };
    } catch (e) {
      return { ok: false, err: String((e && e.message) || e) };
    }
  });
  check(
    'P11 大模型不可用时自动降级（仍有译文）',
    down.ok && Array.isArray(down.out) && !!down.out[0] && down.out[0].trim().length > 0,
    down
  );

  check('P12 无 JS 错误', errors.length === 0, { errors });

  await page.screenshot({ path: path.join(__dirname, 'shot-llm.png'), fullPage: false });
  await ctx.close();

  console.log('');
  if (failed.length) {
    console.log('RESULT: FAIL (' + failed.join(', ') + ')');
    process.exit(1);
  }
  console.log('RESULT: PASS（大模型配置：手势里申请权限 + 拉模型 + 测试连接 + 后台可用 + 降级）');
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
