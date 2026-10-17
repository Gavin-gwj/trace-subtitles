/**
 * 本地测试台：模拟 YouTube 播放器页面，用来端到端验证扩展
 *
 * 提供：
 *   GET /watch?v=TESTID00001   —— 仿 YouTube 页面（含 #movie_player 与 video 元素）
 *   POST /youtubei/v1/player   —— 返回带 captionTracks 的 playerResponse
 *   GET  /api/timedtext        —— 返回 json3 字幕
 *
 * 这样可以在不依赖登录态的情况下，验证「钩 player 响应 → 取轨道 → 抓字幕 →
 * 分句 → 翻译 → 渲染双层字幕 → 点词查词 → 入生词本」整条链路。
 */
const http = require('http');
const url = require('url');

const PORT = 8899;
const VIDEO_ID = 'TESTID00001';

const BASE = `http://localhost:${PORT}`;

const TRACKS = [
  {
    baseUrl: `${BASE}/api/timedtext?v=${VIDEO_ID}&lang=en&kind=`,
    name: { simpleText: 'English' },
    vssId: '.en',
    languageCode: 'en',
    kind: '',
    isTranslatable: true,
  },
  {
    baseUrl: `${BASE}/api/timedtext?v=${VIDEO_ID}&lang=en&kind=asr`,
    name: { simpleText: 'English (auto-generated)' },
    vssId: 'a.en',
    languageCode: 'en',
    kind: 'asr',
    isTranslatable: true,
  },
];

/** 构造一段有碎片行、有半句断开、有句末标点的字幕 */
const CUES = [
  [0, 2.0, 'So today we are going to talk'],
  [2.0, 2.4, 'about how this plugin works.'],
  [4.4, 1.8, 'The first step is to capture'],
  [6.2, 2.2, 'the subtitle tracks from the player,'],
  [8.4, 1.6, 'and then we translate'],
  [10.0, 2.0, 'each complete sentence,'],
  [12.0, 1.4, 'not each fragment.'],
  [13.4, 2.6, 'Finally the overlay renders'],
  [16.0, 2.4, 'both languages at the same time.'],
  [18.4, 2.0, 'Click any word to look it up'],
  [20.4, 2.0, 'and save it to your wordbook.'],
  [22.4, 2.2, 'That is the whole pipeline'],
  [24.6, 2.0, 'in about thirty seconds.'],
];

function json3Body() {
  const events = CUES.map(([t, d, text]) => ({
    tStartMs: Math.round(t * 1000),
    dDurationMs: Math.round(d * 1000),
    segs: [{ utf8: text }],
  }));
  return JSON.stringify({ wireMagic: 'pb3', events });
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Mock Video - YouTube</title>
<style>
  body { margin:0; background:#0f0f0f; color:#fff; font-family:Roboto,Arial,sans-serif; }
  #movie_player { position:relative; width:100%; max-width:960px; margin:40px auto;
    aspect-ratio:16/9; background:#000; border-radius:12px; overflow:hidden; }
  video { width:100%; height:100%; display:block; object-fit:contain; background:#111; }
  .hint { max-width:960px; margin:16px auto; color:#aaa; font-size:13px; }
  .fake-caption { position:absolute; bottom:8%; left:0; right:0; text-align:center;
    font-size:20px; text-shadow:0 2px 4px #000; }
</style>
</head>
<body>
  <div id="movie_player" class="html5-video-player">
    <video class="html5-main-video" muted playsinline></video>
  </div>
  <div class="hint">Mock YouTube player for extension testing. 0 - 27s of captions.</div>
<script>
  // ---- 模拟播放器对象 ----
  const playerResponse = {
    videoDetails: { videoId: '${VIDEO_ID}', title: 'Mock Video' },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: ${JSON.stringify(TRACKS)},
      },
    },
  };
  const player = document.getElementById('movie_player');
  player.getPlayerResponse = () => playerResponse;
  player.getOption = (m, o) => (m === 'captions' && o === 'tracklist') ? ${JSON.stringify(TRACKS)} : null;

  // ---- 模拟页面自己发起的 player 请求（触发 main-world 的 fetch 钩子）----
  fetch('/youtubei/v1/player', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId: '${VIDEO_ID}' }),
  }).catch(() => {});

  // ---- 用 canvas 生成一段纯色视频，让 video.currentTime 能走 ----
  (function () {
    const v = document.querySelector('video');
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    const ctx = c.getContext('2d');
    let t0 = performance.now();
    function draw() {
      const p = ((performance.now() - t0) / 1000) % 27;
      ctx.fillStyle = 'hsl(' + (p * 13) + ', 45%, 22%)';
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#fff';
      ctx.font = '28px sans-serif';
      ctx.fillText('t = ' + p.toFixed(1) + 's', 30, 60);
      requestAnimationFrame(draw);
    }
    draw();
    // MediaRecorder 太重，这里用 canvas.captureStream 直接喂给 video
    try {
      const stream = c.captureStream(25);
      v.srcObject = stream;
      v.play().catch(() => {});
    } catch (e) { console.warn('captureStream failed', e); }
    // 手动推进 currentTime 不可行（srcObject 模式下只读），
    // 因此改用 proxy 覆盖 currentTime getter，供扩展按时间取句
    let fakeTime = 0;
    Object.defineProperty(v, 'currentTime', {
      get() { return ((performance.now() - t0) / 1000) % 27; },
      set(_) {},
      configurable: true,
    });
  })();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);

  // CORS：扩展的 fetch 带 credentials，需要允许
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (u.pathname === '/youtubei/v1/player') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      playerResponse: {
        videoDetails: { videoId: VIDEO_ID, title: 'Mock Video' },
        captions: {
          playerCaptionsTracklistRenderer: { captionTracks: TRACKS },
        },
      },
    }));
  }

  if (u.pathname === '/api/timedtext') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(json3Body());
  }

  if (u.pathname === '/watch') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }

  if (u.pathname === '/') {
    res.writeHead(302, { Location: `/watch?v=${VIDEO_ID}` });
    return res.end();
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`mock server on http://localhost:${PORT}/watch?v=${VIDEO_ID}`);
});
