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

function json3Body(cues = CUES) {
  const events = cues.map(([t, d, text]) => ({
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
  // cues: 自定义字幕（同时影响播放器时间轴总长），测试「词形变化」时用单复数配对句
  const cues = opts.cues || CUES;
  const total = cues[cues.length - 1][0] + cues[cues.length - 1][1];
  // frame: 模拟「非全屏」时播放器只是页面里的一块矩形（上方顶栏、右侧推荐栏）。
  // 不给就是铺满视口（旧行为）。测试用它验证字幕贴的是视频框而不是视口。
  const frame = opts.frame || null;
  const frameCss = frame
    ? `--mp-left:${frame.left}px; --mp-top:${frame.top}px;
       --mp-w:${frame.width}px; --mp-h:${frame.height}px;`
    : `--mp-left:0px; --mp-top:0px; --mp-w:100vw; --mp-h:100vh;`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Mock Video - YouTube</title>
<style>
  html,body { margin:0; padding:0; background:#0f0f0f; color:#fff;
    font-family:Roboto,Arial,sans-serif; overflow:hidden; }
  /* 播放器默认铺满视口（模拟真实 YouTube 剧场模式）；给了 frame 就变成一块矩形 */
  #movie_player { position:fixed; left:var(--mp-left); top:var(--mp-top);
    width:var(--mp-w); height:var(--mp-h); margin:0;
    background:#000; overflow:hidden; ${frameCss} }
  #movie_player.ytp-fullscreen { left:0; top:0; width:100vw; height:100vh; }
  #movie_player video { position:absolute; inset:0; width:100%; height:100%;
    object-fit:contain; background:#000; }
  #movie_player canvas { position:absolute; inset:0; width:100%; height:100%; }
  /* YouTube 自己的设置菜单（点齿轮弹出）：默认隐藏，位置贴近真实播放器的右下角。
     它是「字幕框不该遮住」的那类交互浮层，测试用它验证避让。 */
  .ytp-settings-menu { position:absolute; right:40px; bottom:70px; width:300px;
    height:260px; background:rgba(28,28,28,.96); border-radius:12px; z-index:8;
    display:none; padding:12px; box-sizing:border-box; }
  .ytp-settings-menu .qbtn { display:block; width:100%; margin-top:8px; padding:10px;
    background:#3a3a3a; color:#fff; border:0; border-radius:8px; font-size:14px;
    cursor:pointer; }
  .ytp-settings-menu .qbtn:hover { background:#4a4a4a; }
  .hint { position:fixed; left:12px; bottom:6px; color:#888; font-size:12px; z-index:2; }
</style>
</head>
<body>
  <div id="movie_player" class="html5-video-player">
    <video class="html5-main-video" muted playsinline></video>
    <canvas width="960" height="540"></canvas>
    <button class="ytp-subtitles-button" aria-pressed="false" style="position:absolute;left:8px;bottom:8px;z-index:5">CC</button>
    <div class="ytp-settings-menu">
      <div style="font-size:13px;color:#bbb">设置</div>
      <button class="qbtn" id="qualityBtn">画质 · 自动 (2160p 4K)</button>
      <button class="qbtn" id="speedBtn">播放速度 · 正常</button>
    </div>
  </div>
  <div class="hint">Mock YouTube player · 0 – ${total.toFixed(1)}s captions · videoId=${videoId}${
    potMode ? ' · POT MODE (direct timedtext returns empty)' : ''
  }</div>
<script>
  const VIDEO_ID = ${JSON.stringify(videoId)};
  const PLAYER_RESPONSE = ${JSON.stringify(playerResponse(videoId))};
  const TOTAL = ${total};
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

    // ---- 模拟全屏 / 退出全屏（YouTube 的做法：给播放器加 .ytp-fullscreen）----
    window.__mockFullscreen = (on) => {
      player.classList.toggle('ytp-fullscreen', !!on);
      return player.getBoundingClientRect();
    };

    // ---- 模拟「视频框被滚出视野」/「缩成迷你播放器」----
    // 真实 YouTube 里这两种情况分别是：往下翻评论区、切到首页后后台播放。
    // 测试用它们验证「全局显示」开关与「离开画面就隐藏」。
    const MP_LEFT = ${JSON.stringify(frame ? frame.left : 0)};
    const MP_TOP = ${JSON.stringify(frame ? frame.top : 0)};
    const MP_W = ${JSON.stringify(frame ? frame.width : 0)};
    const MP_H = ${JSON.stringify(frame ? frame.height : 0)};
    /** 把播放器移到指定矩形；传 null 恢复夹具原本的 frame 设置 */
    window.__mockFrame = (rect) => {
      if (!rect) {
        player.style.left = MP_LEFT ? MP_LEFT + 'px' : '0px';
        player.style.top = MP_TOP ? MP_TOP + 'px' : '0px';
        player.style.width = MP_W ? MP_W + 'px' : '100vw';
        player.style.height = MP_H ? MP_H + 'px' : '100vh';
        return player.getBoundingClientRect();
      }
      player.style.left = rect.left + 'px';
      player.style.top = rect.top + 'px';
      player.style.width = rect.width + 'px';
      player.style.height = rect.height + 'px';
      return player.getBoundingClientRect();
    };
    /** 播放器滚出视野：整体挪到视口下方（模拟往下翻到评论区） */
    window.__mockScrollAway = () => window.__mockFrame({
      left: MP_LEFT || 0, top: window.innerHeight + 40, width: MP_W || 900, height: MP_H || 506,
    });
    /** 缩成右下角迷你播放器（模拟首页后台播放） */
    window.__mockMini = () => window.__mockFrame({
      left: window.innerWidth - 400 - 16, top: window.innerHeight - 225 - 16, width: 400, height: 225,
    });

    // ---- 模拟 YouTube 设置菜单的开合 ----
    // 菜单弹出时字幕框若压在它上面，扩展应当让路（淡出 + 点击穿透），
    // 让用户能点到「画质」这类选项。点击计数用来断言「真的点到了」。
    const settingsMenu = document.querySelector('.ytp-settings-menu');
    window.__mockMenuOpen = (on) => {
      settingsMenu.style.display = on ? 'block' : 'none';
      return settingsMenu.getBoundingClientRect();
    };
    window.__mockClicks = { quality: 0, speed: 0 };
    document.getElementById('qualityBtn').addEventListener('click', () => {
      window.__mockClicks.quality++;
    });
    document.getElementById('speedBtn').addEventListener('click', () => {
      window.__mockClicks.speed++;
    });
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

