/**
 * 测试用 Chrome 的代理参数。
 *
 * 为什么需要这个：
 *   自动化启动的 Chrome **不会**读取 Windows 的 Internet Settings 代理设置
 *   （HKCU\...\Internet Settings 的 ProxyEnable/ProxyServer）。实测同一台机器上
 *   curl 走 127.0.0.1:7897 能拿到 Google 翻译，而 Playwright 起的 Chrome 里
 *   fetch('https://translate.googleapis.com/...') 直接 `TypeError: Failed to fetch`
 *   （639ms 就失败，不是超时）。加上 --proxy-server 后立刻 200。
 *
 * 所以测试必须显式传代理。但写死地址会让没开代理的机器上整套回归全部失败，
 * 因此这里**从系统设置里读**：有代理就用，没有就返回空数组（直连）。
 *
 * 也可以在命令行覆盖：TRACE_TEST_PROXY=http://127.0.0.1:7897 node test-xxx.js
 */
const { execSync } = require('child_process');

let cached; // 读一次就够，测试进程内不会变

function systemProxy() {
  // 显式指定优先（方便在 CI 或别的机器上跑）
  if (process.env.TRACE_TEST_PROXY) return process.env.TRACE_TEST_PROXY;
  if (process.env.TRACE_TEST_PROXY === '') return ''; // 显式要求直连
  if (process.platform !== 'win32') return '';
  try {
    const ps =
      "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'" +
      ' | Select-Object -Property ProxyEnable,ProxyServer,AutoConfigURL | ConvertTo-Json -Compress';
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    const cfg = JSON.parse(out);
    // AutoConfigURL（PAC）无法直接转成 --proxy-server，交给 Chrome 自己处理，
    // 这里只在有静态代理时返回
    if (cfg && Number(cfg.ProxyEnable) === 1 && cfg.ProxyServer) {
      let server = String(cfg.ProxyServer).trim();
      // 形如 "http=127.0.0.1:7897;https=127.0.0.1:7897" 时取 https 或 http 那一段
      if (server.includes('=')) {
        const parts = server.split(';').map((s) => s.trim());
        const https = parts.find((p) => /^https=/i.test(p));
        const http = parts.find((p) => /^http=/i.test(p));
        const pick = https || http || parts[0];
        server = pick.replace(/^[a-z]+=/i, '');
      }
      if (server && !/^https?:\/\//i.test(server)) server = 'http://' + server;
      return server;
    }
  } catch (_) {
    /* 读不到就当没有代理 */
  }
  return '';
}

/** 直接展开进 Chrome 的 args 数组 */
function proxyArgs() {
  if (cached === undefined) {
    const p = systemProxy();
    cached = p ? [`--proxy-server=${p}`] : [];
  }
  return cached.slice();
}

/** 便于日志里说明当前用的是哪种网络路径 */
function describe() {
  const p = systemProxy();
  return p ? `proxy=${p}` : 'direct';
}

module.exports = { proxyArgs, systemProxy, describe };
