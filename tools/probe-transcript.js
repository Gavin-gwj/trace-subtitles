/**
 * 探测：真实 YouTube 的 get_transcript 接口在未登录 + 代理环境下是否可用。
 * 走系统代理 127.0.0.1:7897 自建 CONNECT 隧道（同 test-innertube2.js 的做法）。
 *
 * 目的：验证 main-world.js 里 F 路径（文字稿接口，不需要 pot）是否真的能拿到字幕，
 * 这是解决 "empty timedtext" 的关键假设。
 */
const http = require('http');
const https = require('https');
const tls = require('tls');

const PROXY = { host: '127.0.0.1', port: 7897 };
const VIDEO_ID = process.argv[2] || 'axRhjqd-rus';

function tunnel(host) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: PROXY.host,
      port: PROXY.port,
      method: 'CONNECT',
      path: `${host}:443`,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error('CONNECT ' + res.statusCode));
      resolve(socket);
    });
    req.on('error', reject);
    req.end();
  });
}

function reqOverSocket(socket, host, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
      const h = {
        Host: host,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      };
      if (body) h['Content-Length'] = Buffer.byteLength(body);
      const r = https.request({ method, path, headers: h, createConnection: () => secure }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
      });
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });
    secure.on('error', reject);
  });
}

function findParams(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 16) return '';
  if (obj.getTranscriptEndpoint && obj.getTranscriptEndpoint.params) return obj.getTranscriptEndpoint.params;
  for (const k of Object.keys(obj)) {
    if (k === 'getTranscriptEndpoint') continue;
    const v = obj[k];
    if (v && typeof v === 'object') {
      const r = findParams(v, depth + 1);
      if (r) return r;
    }
  }
  return '';
}

function extractYtInitialData(html) {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}

function extractKey(html) {
  const m = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  return m ? m[1] : '';
}

function extractClientVersion(html) {
  const m = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
  return m ? m[1] : '2.20240101.00.00';
}

function extractVisitorData(html) {
  const m = html.match(/"VISITOR_DATA":"([^"]+)"/);
  return m ? m[1] : '';
}

(async () => {
  const host = 'www.youtube.com';
  const socket = await tunnel(host);
  console.log('tunnel ok');

  const page = await reqOverSocket(socket, host, 'GET', `/watch?v=${VIDEO_ID}&hl=en`, null, {
    Accept: 'text/html',
  });
  console.log('page status', page.status, 'len', page.body.length);

  const data = extractYtInitialData(page.body);
  console.log('ytInitialData:', data ? 'found' : 'MISSING');

  const params = findParams(data);
  console.log('transcript params:', params ? params.slice(0, 60) + '…' : 'MISSING');

  const key = extractKey(page.body);
  const cv = extractClientVersion(page.body);
  const visitorData = extractVisitorData(page.body);
  console.log('api key:', key ? key.slice(0, 12) + '…' : 'MISSING', '| clientVersion:', cv);
  console.log('visitorData:', visitorData ? visitorData.slice(0, 20) + '…' : 'MISSING');

  if (!params || !key) {
    console.log('=> cannot call get_transcript');
    socket.end();
    return;
  }

  const body = JSON.stringify({
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: cv,
        hl: 'en',
        gl: 'US',
        visitorData,
        originalUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    },
    params,
  });

  // 用新隧道（上一条可能因 keep-alive 复用而卡住）
  let s2;
  try { socket.end(); } catch (_) {}
  s2 = await tunnel(host);
  const res = await reqOverSocket(
    s2,
    host,
    'POST',
    `/youtubei/v1/get_transcript?key=${encodeURIComponent(key)}&prettyPrint=false`,
    body,
    {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': cv,
      'X-Goog-Visitor-Id': visitorData,
      Origin: 'https://www.youtube.com',
      Referer: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    }
  );
  console.log('get_transcript status', res.status, 'len', res.body.length);
  if (res.status !== 200) console.log('body head:', res.body.slice(0, 300));

  let cues = 0;
  try {
    const json = JSON.parse(res.body);
    const walk = (o, d) => {
      if (!o || typeof o !== 'object' || d > 14) return;
      if (o.transcriptCueRenderer) { cues++; return; }
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (v && typeof v === 'object') walk(v, d + 1);
      }
    };
    walk(json, 0);
  } catch (e) {
    console.log('parse failed:', e.message, res.body.slice(0, 200));
  }
  console.log('cues:', cues);
  console.log(cues > 0 ? '=> TRANSCRIPT API WORKS' : '=> transcript api returned no cues');
  socket.end();
})().catch((e) => console.error('ERR', e.message));
