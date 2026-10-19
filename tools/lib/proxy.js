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
 *
 * **踩过的坑（2026-10-19）**：Clash 类客户端关掉「系统代理」开关后，
 * 注册表里 ProxyEnable 变成 0 但 ProxyServer 还留着旧值，端口也仍然在监听。
 * 这时本函数返回空参数，Chrome 走直连 → 每次 fetch 卡 21 秒才 `Failed to fetch`
 * → `translateBatch` 反复退避重试 → 整套回归看起来「卡死不动」（test-align
 * 单套跑了 13 分钟没有任何输出，只有一行 SW url）。
 * 现在改成：**端口真的在监听就用它**，不管 ProxyEnable 是几 —— 端口开着
 * 说明用户就是要走它。ProxyEnable=1 但没有 ProxyServer 时仍然直连。
 */
const { execSync, execFileSync } = require('child_process');

let cached; // 读一次就够，测试进程内不会变

/**
 * 同步探一下某个 host:port 是否接受 TCP 连接（约 60~150ms）。
 *
 * 必须用 `execFileSync('node', ['-e', code])` 而不是 `execSync('node -e "..."')`：
 * 后者要经 shell，host 会被 JSON.stringify 出来的双引号在 shell 层被吃掉，
 * 变成 `connect(7897,127.0.0.1)`（语义全变，直接语法错误）。execFileSync
 * 不经 shell，参数原样传给进程，不会踩这个坑。
 */
function portOpen(host, port) {
  const code =
    `const s=require('net').connect({port:${Number(port)},host:${JSON.stringify(host)}});` +
    `s.setTimeout(900);` +
    `s.on('connect',()=>{console.log('1');s.destroy()});` +
    `s.on('timeout',()=>{console.log('0');s.destroy()});` +
    `s.on('error',()=>console.log('0'));`;
  try {
    const out = execFileSync(process.execPath, ['-e', code], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
    return String(out).trim() === '1';
  } catch (_) {
    return false;
  }
}

function hostPort(server) {
  const m = String(server).match(/^(?:([a-z]+):\/\/)?([^:/]+):(\d+)/i);
  if (!m) return null;
  return { host: m[2], port: m[3] };
}

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
    if (cfg && cfg.ProxyServer) {
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
      // ProxyEnable=1 直接用；ProxyEnable=0 时看端口是否仍在监听（客户端没退）
      if (Number(cfg.ProxyEnable) === 1) return server;
      const hp = hostPort(server);
      if (hp && portOpen(hp.host, hp.port)) return server;
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
