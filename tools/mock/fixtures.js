/**
 * 测试夹具：仿 YouTube 播放器页面 + playerResponse + 字幕数据
 *
 * 被两处复用：
 *   - tools/mock/server.js   本地 HTTP 服务（便于人工打开看效果）
 *   - tools/test-mock.js     Playwright page.route() 把 https://www.youtube.com/*
 *                            整体伪造，从而让扩展的 content_scripts 真正命中
 */

const VIDEO_ID = 'TESTID00001';

// 字幕轨道：baseUrl 用同源相对路径，扩展会用页面身份去 fetch
const TRACKS = [
  {
    baseUrl: `/api/timedtext?v=${VIDEO_ID}&lang=en&kind=`,
    name: { simpleText: 'English' },
    vssId: '.en',
    languageCode: 'en',
    kind: '',
    isTranslatable: true,
  },
  {
    baseUrl: `/api/timedtext?v=${VIDEO_ID}&lang=en&kind=asr`,
    name: { simpleText: 'English (auto-generated)' },
    vssId: 'a.en',
    languageCode: 'en',
    kind: 'asr',
    isTranslatable: true,
  },
];

/**
 * 故意构造「碎片化」字幕：句子被切成多行、行间有停顿、行内无标点，
 * 用来检验扩展的分句能力（这是 Trancy 类插件的核心难点）。
 */
const CUES = [
  [0.0, 1.6, 'So today we are going to talk'],
  [1.6, 1.8, 'about how this plugin works.'],
  [3.4, 1.4, 'The first step is to capture'],
  [4.8, 1.6, 'the subtitle tracks from the player,'],
  [6.4, 1.2, 'and then we translate'],
  [7.6, 1.4, 'each complete sentence,'],
  [9.0, 1.2, 'not each fragment.'],
  [10.2, 1.4, 'Finally the overlay renders'],
  [11.6, 1.6, 'both languages at the same time.'],
  [13.2, 1.4, 'Click any word to look it up'],
  [14.6, 1.6, 'and save it to your wordbook.'],
  [16.2, 1.4, 'That is the whole pipeline'],
  [17.6, 1.6, 'in about thirty seconds.'],
];

const TOTAL = CUES[CUES.length - 1][0] + CUES[CUES.length - 1][1];

function playerResponse(videoId = VIDEO_ID) {
  return {
    videoDetails: { videoId, title: 'Mock Video' },
    captions: {
      playerCaptionsTracklistRenderer: { captionTracks: TRACKS },
    },
  };
}

function json3Body() {
  const events = CUES.map(([t, d, text]) => ({
    tStartMs: Math.round(t * 1000),
    dDurationMs: Math.round(d * 1000),
    segs: [{ utf8: text }],
  }));
  return JSON.stringify({ wireMagic: 'pb3', events });
}

function pageHtml(videoId = VIDEO_ID, opts = {}) {
  // potMode: 模拟新版 YouTube —— 没有 pot 签名的 timedtext 请求返回 200 + 空 body，
  // 只有页面自己发出的带 pot 请求才有内容。用于回归测试「网络钩子」路径。
  const potMode = !!opts.potMode;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Mock Video - YouTube</title>
<style>
  html,body { margin:0; padding:0; background:#0f0f0f; color:#fff;
    font-family:Roboto,Arial,sans-serif; overflow:hidden; }
  /* 铺满视口，模拟真实 YouTube 剧场模式，这样字幕框是压在画面上而不是页面空白上 */
  #movie_player { position:fixed; inset:0; width:100vw; height:100vh; margin:0;
    background:#000; overflow:hidden; }
  #movie_player video { position:absolute; inset:0; width:100%; height:100%;
    object-fit:contain; background:#000; }
  #movie_player canvas { position:absolute; inset:0; width:100%; height:100%; }
  .hint { position:fixed; left:12px; bottom:6px; color:#888; font-size:12px; z-index:2; }
</style>
</head>
<body>
  <div id="movie_player" class="html5-video-player">
    <video class="html5-main-video" muted playsinline></video>
    <canvas width="960" height="540"></canvas>
    <button class="ytp-subtitles-button" aria-pressed="false" style="position:absolute;left:8px;bottom:8px;z-index:5">CC</button>
  </div>
  <div class="hint">Mock YouTube player · 0 – ${TOTAL.toFixed(1)}s captions · videoId=${videoId}${
    potMode ? ' · POT MODE (direct timedtext returns empty)' : ''
  }</div>
<script>
  const VIDEO_ID = ${JSON.stringify(videoId)};
  const PLAYER_RESPONSE = ${JSON.stringify(playerResponse(videoId))};
  const TOTAL = ${TOTAL};
  const POT_MODE = ${potMode};

  // ---- 模拟 YouTube 播放器对象 ----
  const player = document.getElementById('movie_player');
  player.getPlayerResponse = () => PLAYER_RESPONSE;
  player.getOption = (m, o) =>
    (m === 'captions' && o === 'tracklist') ? PLAYER_RESPONSE.captions.playerCaptionsTracklistRenderer.captionTracks : null;
  player.setOption = (m, o, v) => {
    if (m === 'captions' && o === 'track') player.__track = v;
  };
  player.loadModule = () => {};

  // ---- 模拟页面自己发起的 player 请求（触发 main-world 的 fetch 钩子）----
  fetch('/youtubei/v1/player', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId: VIDEO_ID }),
  }).catch(() => {});

  // ---- POT 模式：页面自己带 pot 请求字幕（扩展必须靠钩子截获）----
  if (POT_MODE) {
    const base = PLAYER_RESPONSE.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl;
    fetch(base + '&pot=MOCK_POT_TOKEN&fmt=json3').catch(() => {});
    // 点 CC 按钮时也再发一次（扩展会强制点击）
    const cc = document.querySelector('.ytp-subtitles-button');
    cc.addEventListener('click', () => {
      cc.setAttribute('aria-pressed', cc.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      fetch(base + '&pot=MOCK_POT_TOKEN&fmt=json3&t=' + Date.now()).catch(() => {});
    });
  }

  // ---- 用 canvas 画个走动的画面，并用 captureStream 喂给 video ----
  // 关键教训：不能用 Object.defineProperty(v,'currentTime') 伪造时间——
  // 那个只在主世界生效，内容脚本跑在隔离世界，读到的是原生 currentTime（恒为 0），
  // 表现为字幕永远停在第 1 句。必须给 video 真实的媒体流，两个世界才看到同一条时间轴。
  (function () {
    const v = document.querySelector('video');
    const c = document.querySelector('canvas');
    const ctx = c.getContext('2d');
    const t0 = performance.now();

    function draw() {
      const p = ((performance.now() - t0) / 1000) % TOTAL;
      ctx.fillStyle = 'hsl(' + (p * 20) + ', 42%, 20%)';
      ctx.fillRect(0, 0, 960, 540);
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.font = '600 34px Roboto, sans-serif';
      ctx.fillText('t = ' + p.toFixed(1) + 's', 40, 70);
      ctx.font = '18px Roboto, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      ctx.fillText('mock player · no network video', 40, 100);
      requestAnimationFrame(draw);
    }
    draw();

    // MediaStream 不支持 seek，currentTime 从 0 开始真实推进；
    // 所以测试用「自然播放 + 多次采样」验证，而不是跳到某个时间点。
    v.srcObject = c.captureStream(25);
    v.play().catch(() => {});
    // 查词/生词本断言需要字幕停在当前句，用暂停把时间轴钉住（真实暂停，两个世界都看得到）
    window.__mockPause = () => v.pause();
    window.__mockPlay = () => v.play().catch(() => {});
    window.__mockReady = true;
  })();
</script>
</body>
</html>`;
}

/**
 * POT 模式下的 timedtext 响应：
 *   - 带 pot 参数 → 正常 json3
 *   - 不带 pot    → 200 + 空 body（真实 YouTube 的行为）
 */
function timedTextResponse(url) {
  const u = new URL(url, 'https://www.youtube.com');
  const hasPot = u.searchParams.has('pot');
  if (!hasPot) return { status: 200, body: '' };
  return { status: 200, body: json3Body(), contentType: 'application/json' };
}

module.exports = {
  VIDEO_ID, TRACKS, CUES, TOTAL, playerResponse, json3Body, pageHtml, timedTextResponse,
};

