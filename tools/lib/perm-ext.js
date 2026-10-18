/**
 * 扩展权限测试助手。
 *
 * ## 问题：原生弹框点不到
 *
 * 大模型引擎的 API 地址是用户自填的任意域名，`manifest.json` 里无法静态声明，
 * 只能靠 `optional_host_permissions` + 运行时 `chrome.permissions.request()`。
 *
 * 但 Chrome 的「扩展请求获得更多权限」弹框是**浏览器原生 Views 气泡**，不在 DOM 里，
 * Playwright 点不到。实测 8 组候选启动参数（`--auto-accept-extension-permission-prompts`、
 * `--disable-extensions-permission-prompts`、`--grant-permissions=*`、
 * `--allowlisted-extension-id=*` 等）全部无效：`request()` 的 promise 永远挂着，
 * 既不 resolve 也不 reject。表现为测试 600s 超时、一行 RESULT 都没有
 * （曾把 `test-phrase.js` 拖死过一次）。
 *
 * ## 做法：预置 host_permissions
 *
 * 把扩展复制一份到固定临时目录，并在 `host_permissions` 里**预置**目标域名 ——
 * 这等价于「用户此前已经点过允许」，是真实可达的状态。此时：
 *
 *   chrome.permissions.contains(origin) === true
 *   chrome.permissions.request(origin) === Promise.resolve(true)   // 不弹框
 *
 * 于是测试既能跑真实 `fetch`，又不会卡在原生弹框上。
 *
 * 用**固定路径**（而不是 mkdtemp）是因为未打包扩展的 ID 由路径哈希而来，
 * 路径一变 ID 就变，profile 里的旧状态全部失效。
 *
 * ## 预置了权限，还怎么抓 bug 17？
 *
 * 预置只解决「权限已授予」这个**前置状态**，不改变被测代码的调用位置。
 * bug 17 的失败条件是：申请写在 `bg.js` 的消息处理器里，而那里没有手势上下文。
 * 它的**可观测后果**是 —— popup 页面从头到尾**一次都不会**调用
 * `chrome.permissions.request`（它把这件事交给了后台）。
 *
 * 所以判据是调用**次数**，不是手势状态：
 *
 *   - 修复后：点「拉取模型列表」→ popup 页面记录到 1 次调用，origins 正确
 *   - 修复前：申请在 bg.js → popup 页面记录恒为 0 次
 *
 * 反向验证：删掉 popup.js 里两处 `requestLlmOrigin()` 调用，断言立刻 FAIL。
 *
 * ## 踩过的坑：不要用 navigator.userActivation 当判据
 *
 * 第一版用 `navigator.userActivation.isActive` 断言「申请发生在手势里」，还配了
 * 一个「在非手势上下文里调用应得 active===false」的灵敏度自检。结果自检直接
 * 失败：`page.evaluate` 里 `isActive` 也是 `true` —— Playwright 的 evaluate
 * 走 CDP `Runtime.evaluate`，默认就带 `userGesture: true`。这个断言会恒真，
 * 等于没测。灵敏度自检的价值就在这里：它证明了自己没用。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..', 'trace-subtitles');

/**
 * 复制扩展并在 host_permissions 里预置 origin（等价于用户已允许该域名）。
 *
 * @param {string} origin  例如 'https://llm.test'
 * @param {string} destDir 固定目标目录，会被清空重建（保证扩展 ID 稳定）
 * @returns {string} 复制后的扩展目录
 */
function copyExtWithHost(origin, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of fs.readdirSync(SRC)) {
    if (f === 'manifest.json') continue;
    fs.cpSync(path.join(SRC, f), path.join(destDir, f), { recursive: true });
  }
  const m = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  const pat = origin.replace(/\/+$/, '') + '/*';
  m.host_permissions = Array.from(new Set([...(m.host_permissions || []), pat]));
  // 预置的权限不该再留在可选列表里，否则 request() 会认为还没授予
  m.optional_host_permissions = (m.optional_host_permissions || []).filter((p) => p !== pat);
  fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(m, null, 2));
  return destDir;
}

/**
 * 在扩展页面里安装观察器：记录每次 chrome.permissions.request 的调用参数，
 * 然后**照常调用原函数**（不改变被测行为）。
 *
 * 用法：在 page.goto 之前 `await installPermProbe(page)`，
 * 之后 `await readPermCalls(page)` 取记录。
 */
async function installPermProbe(page) {
  await page.addInitScript(() => {
    window.__permCalls = [];
    const orig = chrome.permissions.request.bind(chrome.permissions);
    chrome.permissions.request = (opts) => {
      window.__permCalls.push({
        origins: (opts && opts.origins) || [],
        // 仅作参考记录，不作判据（见文件头「踩过的坑」）
        active: navigator.userActivation ? navigator.userActivation.isActive : null,
        at: Date.now(),
      });
      return orig(opts);
    };
  });
}

/** 读回观察器记录 */
function readPermCalls(page) {
  return page.evaluate(() => window.__permCalls || []);
}

module.exports = { copyExtWithHost, installPermProbe, readPermCalls, SRC };
