# Trancy 逆向分析 + Trace 字幕翻译（复刻）

对 Chrome 扩展 **Trancy - AI Translator & Dual Subtitles v7.9.4** 的逆向分析结论，以及在
`trace-subtitles/` 目录下从零复刻的一个可运行扩展（YouTube 双语字幕 + 点击查词 + 生词本）。

---

## 一、Trancy 是怎么工作的

被分析的目标：`%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\mjdbhokoopacimoekfgkcoogikbfgngb\7.9.4_0`
（扩展 id `mjdbhokoopacimoekfgkcoogikbfgngb`，Manifest V3，核心产物是 webpack 打包后的
`assets/edvideo-main.js`（2.3 MB）、`assets/background.js`（312 KB）、`assets/edvideo.css`（290 KB））。

### 1. 三层结构：content script 只是"引信"

`manifest.json` 里针对视频站点（YouTube / Netflix / HBO Max / Disney+ / Prime Video / TED /
Coursera / Udemy / edX / Bilibili / Vimeo）注入的 content script 是 `assets/edvideo-onload.js`，
只有 **2.4 KB**，它只做三件事：

1. 转发快捷键：`window.postMessage({to:'background', from:'content', eventName:'hotkey', ...})`；
2. 建一个 Trusted Types policy（`trancy-inject-policy`），绕过站点 CSP；
3. **把真正的业务代码注入页面主世界**：

```js
const s = document.createElement('script');
s.src = chrome.runtime.getURL('assets/edvideo-main.js');
s.type = 'module';
document.documentElement.prepend(s);   // 还有 romanize-main.js、ld-main.js
```

这一步是关键设计。MV3 的 content script 跑在**隔离世界（isolated world）**，看不到页面的
JavaScript 变量；而字幕数据藏在页面的 `window.ytInitialPlayerResponse` 里，要 hook
`JSON.parse` / `XMLHttpRequest` 也必须和页面同世界。所以 Trancy 用「隔离世界做引信 + 主世界跑业务」
的桥接模式，靠 `postMessage` 通信。

> 我在 `tools/probe-ext2/` 做过对照实验验证这一点：`document.getElementById('movie_player')`
> 在 MAIN world 里 `typeof getPlayerResponse === 'function'`，在隔离世界拿到的是空壳
> （`hasPlayer: false`）。这解释了为什么 Trancy 必须走注入路线。

### 2. 字幕从哪来：优先读播放器对象，其次 hook 网络

**YouTube**（`edvideo-main.js` 里的 `getYoutubeTracks()`）：

```js
const pr = player.getPlayerResponse();
pr.captions.playerCaptionsTracklistRenderer.captionTracks
```

拿到的每条轨道形如 `{ baseUrl, languageCode, kind, vssId, name }`。判定逻辑：

- `kind === 'asr'` → 自动生成字幕（ASR），其 `languageCode` 同时作为 `audioLanguage`；
- 有非 `asr` 且无 `trackName` 的轨道 → 判定存在"人工字幕"（`hasbuilinCaption`）。

拿到 `baseUrl` 后拼 `&fmt=json3`（或 `srv3` / `vtt` / `ttml`）拉字幕正文。内置支持
**json3、vtt、ttml、sub** 四种格式。

> **2024 之后的重要变化：timedtext 需要 `pot` 签名。**
> 直接请求 `baseUrl&fmt=json3` 现在会返回 **HTTP 200 + 空 body**（0 字节）。
> 这不是 URL 拼错了，而是 YouTube 要求请求带 `pot`（proof-of-origin token），
> 而 pot 只在**页面自己发出的请求**里才有。
>
> 复刻时踩过这个坑，最终解法是：**hook 页面的 fetch / XMLHttpRequest，截获
> `/api/timedtext` 的响应正文**。页面为了显示原生 CC 必然自己发这个请求，钩子顺手
> 拿到带 pot 的完整字幕——这是唯一稳定的路径。Trancy 的 2.3MB 主世界脚本同样在
> hook 网络层，原因就在这里。

**其它平台各有各的脏活**（这是这类插件的护城河）：

| 平台 | 抓取方式 |
|---|---|
| Netflix | hook `JSON.parse`，从响应里取 `result.timedtexttracks` + `ttDownloadables` |
| HBO Max | 从 `${n}.vtt` 逐段自增拼 URL，直到 404，再 parseVtt |
| Bilibili | hook XHR，匹配 URL 含 `subtitle/` 的响应，映射 `{start: from*1000, end: to*1000, text: content}` |
| Prime Video | hook `GetVodPlaybackResources`，取 `timedTextUrls` / `subtitleUrls` |
| DeepLearning.ai | hook `.vtt` 的 XHR |

另外它还从 `streamingData.adaptiveFormats` 里挑 `mimeType` 含 `audio` 的流
（字段 `whispering` / `whisperID` / `useWhisper`）——**没有字幕时上传给 Whisper 做语音转写**。

### 3. 核心难点：智能分句（sentencizer）

YouTube 的自动字幕是**碎片**，按呼吸停顿切，一句话被切成三四段，还带大小写和标点错误：

```
So today we are going to talk
about how this plugin works.
The first step is to capture
the subtitle tracks from the player,
```

直接逐条翻译，译文必然断裂、代词指代全丢。Trancy 的做法是先把碎片**重组成完整句子**再翻译：

- `POST https://api.trancy.org/1/sents`（NLP 分句服务，响应缓存 ttl 15s）

这是它翻译质量明显优于"逐条翻"的根本原因，也是整个流水线里最难复刻的一环。
我的复刻版用本地启发式算法（见下文）实现了同一目标。

### 4. 翻译与词典后端

统一入口 `Rs = { API_ENDPOINT: 'https://api.trancy.org' }`：

```
POST /1/translation          { text, from, to }        ← 翻译主接口
POST /1/sents                                          ← 智能分句
POST /2/sentences/grammar                              ← 语法解析（有 stream 版）
GET  /2/phrases  /1/word/definition  /4/words
GET  /1/words/{w}/sentences  /1/tts/voices  /1/voice   ← TTS 返回 mp3 Blob
POST /1/words  /1/word-contexts                        ← 生词本 + 语境
POST /evaluations  (FormData 上传录音)                  ← 跟读发音评测
```

请求头 `x-trancy-version` / `x-trancy-et` / `x-trancy-app` / `x-locale`，
登录后带 `Authorization: Bearer <token>`。

`background.js` 里还内置了**第三方引擎的直连代理**，说明它允许用户自备 key：

- DeepL：`api.deepl.com/v2/translate`、`api-free.deepl.com`
- 微软 Edge：`edge.microsoft.com/translate/auth` → `api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0`
- LLM 系：OpenAI、DeepSeek（`api.deepseek.com/chat/completions`）、xAI grok、Anthropic
  `/v1/messages`、Gemini `generativelanguage.googleapis.com/v1beta/models/`、SiliconFlow、
  OpenRouter、火山方舟、阿里 DashScope、百度千帆、腾讯混元、智谱 `open.bigmodel.cn/api/paas/v4/chat/completions`

### 5. 渲染层

CSS 类名体系（`edvideo.css`）暴露了它的结构：

```
.trancy-container > .trancy-wrapper
  .trancy-caption-container
    .trancy-subtitle-container
      .trancy-primary-subtitle      ← 原文
      .trancy-secondary-subtitle    ← 译文
  .trancy-controller / .trancy-page-setting / .trancy-setting-pannel
  .trancy-word-details / .rd-dict-definition
```

`primary = 原文`、`secondary = 译文`（内部变量命名是 `target` 语言 = 字幕语言、
`native` 语言 = 翻译目标语言）。三种模式：`reader`（阅读模式）、`cinema`（影院沉浸）、
`complex`（复杂布局）。字幕随 `video.currentTime` 高亮推进，单词可点出词典卡。

### 6. 完整数据流

```
页面加载
  └─ content script (隔离世界) 注入 edvideo-main.js → 主世界
       └─ 读 player.getPlayerResponse().captions.captionTracks
            └─ fetch baseUrl&fmt=json3  → 解析成 cue 列表
                 └─ POST /1/sents  智能分句（碎片 → 完整句子）
                      └─ POST /1/translation  批量翻译（+ IndexedDB 缓存）
                           └─ 渲染 .trancy-primary/secondary-subtitle
                                └─ rAF 跟随 currentTime 切换当前句
                                     └─ 点词 → /1/word/definition → /1/words 入生词本
```

---

## 二、复刻产物：Trace 字幕翻译

`trace-subtitles/` 是一个**零依赖、零 API key、可直接加载**的 MV3 扩展，
只保留 Trancy 最核心的 YouTube 双语字幕 + 查词 + 生词本（按需求收窄范围）。

### 文件

| 文件 | 职责 |
|---|---|
| `manifest.json` | MV3 声明；两组 content_scripts（主世界 + 隔离世界）；host 权限只开 4 个域 |
| `main-world.js` | 跑在页面主世界：读 `getPlayerResponse()` / `getOption('captions','tracklist')`，`fetch` 字幕正文，`postMessage` 桥接 |
| `subtitles.js` | 纯函数库：`parse()`（json3/srv3）、`segment()`（智能分句）、`hash()`、`findByTime()` |
| `content.js` | 隔离世界主控：轨道选择、批量翻译、双层字幕渲染、rAF 推进、点词、查词弹窗、生词高亮 |
| `bg.js` | Service Worker：设置、翻译（Google + MyMemory 降级）、词典、IndexedDB 缓存与生词本 |
| `overlay.css` | 字幕覆盖层 + 查词弹窗样式 |
| `popup.html` / `popup.js` | 设置面板 + 生词本管理（搜索/删除/导出/跳回视频） |
| `icons/` | 4 个尺寸图标（纯 Node zlib 手写 PNG 生成） |

### 三个技术要点

**① 主世界桥接**（`main-world.js` ↔ `content.js`）

主世界监听 `__TRACE_REQ__`，回 `__TRACE_RES__`：

```js
window.postMessage({ type:'__TRACE_REQ__', id, action:'tracks' | 'captions' | 'dom-caption' | 'ping', payload }, location.origin);
```

轨道读取三路径兜底：

```js
const pr = getPlayer().getPlayerResponse();          // 主路径
pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks
getPlayer().getOption('captions', 'tracklist');      // 兜底 1
window.ytInitialPlayerResponse.captions…              // 兜底 2
```

**字幕正文获取的五级降级链**（`main-world.js` 的 `ensureCaptions()`）：

| 顺序 | 路径 | 说明 |
|---|---|---|
| 1 | `hook` | 网络钩子已截获页面自己发的、**带 pot** 的 timedtext 响应 —— 最可靠 |
| 2 | `transcript-api` | `/youtubei/v1/get_transcript` + 从 `ytInitialData` / `/v1/next` 挖到的 `params` |
| 3 | `direct` | 直接请求 `baseUrl&fmt=json3`（老视频可用，新视频常返回空 body） |
| 4 | `hook-forced` | 主动 `setOption` / `loadModule` / 点 CC 按钮，逼页面去请求，钩子接住 |
| 5 | `transcript-panel` | 点开 YouTube「显示字幕文稿」侧栏，直接读已渲染的 DOM 段 |

全部失败时，内容脚本还有最后一道 **DOM 兜底**：每 400ms 读一次 `.ytp-caption-segment`，
对当前这一句做实时翻译（带内存缓存）。并每 ~5 秒尝试"升级"回完整模式。

**② 智能分句**（`subtitles.js` 的 `segment()`）

不依赖任何 NLP 服务，用启发式把碎片拼成句子：

- 收句条件：句末标点 `SENT_END = /[.!?。！？…]["'”’)）\]]*\s*$/`
- 边界条件：与上一片的时间间隔 `gap > 2.0s` 也强制断开
- 超长保护：`maxLen = 180` 字符，超出则在最近的逗号处断
- 处理 YouTube 自动字幕的典型脏数据：碎片无标点、首字母小写、重复滚动行

实测把测试夹具的 **13 行碎片 → 5 个完整句子**，译文连贯。

**③ 翻译引擎：Google 免费端点的正确用法**

这是逆向过程中实测出的关键细节（`tools/probe-sw-api.js` 验证）：

```
POST https://translate.googleapis.com/translate_a/t?client=gtx&sl=en&tl=zh-CN&dt=t
Content-Type: application/x-www-form-urlencoded
body: q=句子1&q=句子2&q=句子3
→ ["译文1","译文2","译文3"]     ← 按 q 顺序返回的 JSON 数组
```

- **必须 POST**；同样的参数用 GET 会 **400**；
- 一次可传多条，天然适合批量字幕翻译（本实现每批 40 条）；
- 失败降级到 MyMemory：`https://api.mymemory.translated.net/get?q=...&langpair=en|zh-CN`。

**缓存**：翻译结果与词典结果都写进 IndexedDB（`trace-subs` v1，`translations` + `words` 两个
store），同一个视频二次打开不再请求网络。

**④ 生词本状态与跨视频高亮**

生词本存在 IndexedDB 的 `words` store（`keyPath: 'word'`，键为小写形式）。围绕它有三条链路：

```
加入生词本 → word:add → 写 IndexedDB → broadcastWordsChanged()
                                        └─ chrome.tabs.sendMessage(所有 YouTube 标签页, 'words:changed')
                                             └─ content.js: loadWordSet() → 拉 word:keys → 更新 Set → 重渲染

内容脚本启动 → loadWordSet() 拉一次全量词表（只传小写单词数组，不传释义）
渲染字幕 → renderWords() 逐词查 Set，命中就加 trace-saved 类

点击单词 → 并行两件事：查词典 / 问 word:has 是否已收藏
          → 已收藏则按钮渲染成「✓ 已在生词本」（data-act="remove"），点一下可移除
```

几个设计取舍：

- **只传单词集合**：`word:keys` 返回 `['so','the',...]` 而不是完整记录。几千个词也才几十 KB，
  比每次传释义/语境轻得多。
- **立即本地生效**：点「加入」成功后先把词塞进内存 `Set` 并重渲染，不依赖广播回来 —— 用户
  看到高亮是**瞬间**的。广播只负责同步**其它已打开的标签页**。
- **以数据库为准**：打开弹窗时并行问一次 `word:has`，用 IndexedDB 的真实结果校正内存 Set，
  避免多标签页并发操作导致的内存与磁盘不一致。
- **广播不需要 `tabs` 权限**：`host_permissions` 已含 `youtube.com`，`chrome.tabs.query({url})`
  可以直接按 URL 过滤；申请 `tabs` 权限反而会触发"读取浏览记录"的安装警告。

### 过程中修掉的三个真实 bug（值得记录）

**bug 1：跨消息传函数。** `content.js` 曾把 `hash: S.hash` 放进 `chrome.runtime.sendMessage`，
而消息经过结构化克隆会丢掉函数，SW 侧抛 `TypeError: hashFn is not a function`。
修复：哈希函数在 SW 内部定义（`hashStr`），消息里只传数据。

**bug 2：公开词典 API 会永久挂起。** `api.dictionaryapi.dev` 对 `So` 这类词**不返回也不报错**，
`fetch` 永远 pending，界面卡在"查询中…"。修复：

```js
async function fetchT(url, init = {}, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}
```

并把 `lookupWord` 改成**词典与中文释义并行、各自独立降级**：

```js
await Promise.all([dictTask /* 3.5s 超时，失败静默 */, zhTask /* Google 中文释义 */]);
```

`So` 的查词耗时从"永不返回"变成 3.9s 内必返回。

**bug 3：新版 YouTube 的 timedtext 需要 pot 签名（最隐蔽的一个）。**

在真实 YouTube 上，扩展日志显示 `empty timedtext` —— 轨道读到了、URL 也拼对了，
但 `/api/timedtext?...&fmt=json3` 返回 **200 + 0 字节**。排查过程：

1. 换 `fmt=srv3` / 不带 `fmt` → 同样空；
2. 换 `credentials:'include'` → 同样空；
3. 对照实验：让页面自己发同一个 URL（点开 CC）→ 有内容；
4. 结论：差别在 **`pot` 参数**，它由页面 JS 在运行时生成，只有页面自己发的请求才带。

修复就是 `main-world.js` 里的网络钩子 —— hook `window.fetch` 与
`XMLHttpRequest.prototype.send`，对 `/api/timedtext` 的响应 `clone().text()` 存起来。
为避免切换视频串台，捕获记录里带 `v=` 视频 ID，读取时按当前视频过滤。

为此新增了专门的回归测试 `tools/test-pot.js`：把站点伪造成 pot 模式
（不带 pot → 空 body，带 pot → 正常 json3），断言字幕必须从 `hook` 路径拿到。

---

## 三、安装与使用

### 加载扩展

1. Chrome 打开 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `D:\MyFiles\项目\Trace\trace-subtitles`
4. 打开任意 YouTube 视频，字幕会自动出现

### 功能

- **双语字幕**：原文 + 译文双层，随播放高亮推进
- **显示模式**：双语 / 仅译文 / 仅原文
- **目标语言**：简体中文、繁体中文、日、韩、英、法、德、西、俄、葡（10 种）
- **翻译引擎**：Google（推荐，快）/ MyMemory（备用）
- **字号、字幕位置**：popup 里实时调
- **点击查词**：点字幕里任意单词 → 音标 + 中文释义 + 英文释义 + 例句
- **生词本**：一键加入，记录单词/释义/**所在句子与译文**/视频标题/时间点，可搜索、删除、
  导出 JSON，点击条目跳回原视频那一秒
- **生词高亮（跨视频生效）**：任何已加入生词本的单词，在**所有** YouTube 视频的字幕里都会
  自动高亮（黄色底色 + 下划线），不需要重新加入
- **状态记忆**：再次点击已加入的词，弹窗按钮显示「✓ 已在生词本」，点一下即可移除

### 离线验证（不需要登录 YouTube）

```bash
cd tools
node mock/server.js          # 起本地夹具站点
# 浏览器打开 http://localhost:8899/watch?v=TESTID00001
```

或跑自动化端到端测试：

```bash
cd tools
npm i                        # 安装 playwright
node test-mock.js            # 基础链路，输出 PASS/FAIL + 截图 shot-mock.png
node test-pot.js             # pot 签名回归测试 + 截图 shot-pot.png
```

`tools/mock/` 用 Playwright `page.route()` 整体伪造 `https://www.youtube.com/**`，
提供假的 `player.getPlayerResponse()`、`/api/timedtext` 的 json3 正文，以及 13 条故意碎片化
的测试字幕。这样可以在**完全离线、无需登录**的情况下验证整条链路。

`test-pot.js` 额外模拟新版 YouTube 的 pot 限制：**不带 `pot` 的 timedtext 请求返回
200 + 空 body**，只有页面自己发的带 pot 请求才有内容 —— 精确复现真实故障，
并断言扩展必须走 `hook` 路径才算通过。

实测结果：

```
✓ 双语字幕渲染成功: orig="So today we are going to talk about how this plugin works."
                    trans="那么今天我们就来谈谈这个插件是如何工作的。"
segmentation: { rows: 13, sentences: 5 }
word popup:   { word:"So", zh:"所以", hasAddBtn:true }
add button:   "✓ 已在生词本"   (btnAct: remove)
wordbook:     [{ word:"so", zh:"所以", context:"So today we are going to talk about…",
                 videoId:"TESTID00001", time:0 }]
highlight:    { found:true, hasSavedClass:true, savedCount:1 }
reopen popup: { btnText:"✓ 已在生词本", btnAct:"remove" }
checks:       subs=true seg=5 highlight=true reopen=true
RESULT: PASS
```

pot 模式回归：

```
[Trace] 已加载 13 行字幕 → 5 句（English，来源 hook）
timedtext hits: [{ hasPot: true, pot: "MOCK_POT_TOKEN" }]
RESULT: PASS (网络钩子成功绕过 pot 限制)
```

---

## 四、目录结构

```
D:\MyFiles\项目\Trace\
├─ README.md                    ← 本文件
├─ trace-subtitles\             ← 复刻的扩展（加载这个目录）
│  ├─ manifest.json
│  ├─ main-world.js             主世界：读播放器 / 网络钩子 / 抓字幕（五级降级）
│  ├─ subtitles.js              解析 + 智能分句
│  ├─ content.js                渲染 / 交互 / DOM 兜底
│  ├─ bg.js                     SW：翻译 / 词典 / IndexedDB
│  ├─ overlay.css
│  ├─ popup.html / popup.js
│  └─ icons\
└─ tools\                       ← 逆向与验证工具（非扩展的一部分）
   ├─ mock\fixtures.js          测试夹具（假播放器 + 13 条碎片字幕 + pot 模式）
   ├─ mock\server.js            本地夹具站点 :8899
   ├─ test-mock.js              端到端自动化测试
   ├─ test-pot.js               pot 签名回归测试
   ├─ probe-*.js                逆向探针（网络端点、SW 能力、查词分步、get_transcript）
   ├─ gen-icons.js              纯 Node 生成 PNG 图标
   ├─ shot-mock.png             验证截图
   └─ shot-pot.png              pot 模式验证截图
```

## 五、与 Trancy 的差距

复刻的是**核心链路**，以下能力未实现（都属于 Trancy 的商业化部分）：

- 多平台支持（Netflix / HBO / Disney+ / Prime / Bilibili 等各自的抓取 hook）
- Whisper 语音转写（无字幕视频）
- 服务端 NLP 分句（本实现用本地启发式替代，长句/跨句指代不如服务端）
- 语法分析、TTS 发音、跟读发音评测
- 网页全文沉浸翻译、划词翻译、阅读模式
- 云端账号同步
