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

**入口与设置面板**（对照真实截图确认）：Trancy 在播放器控制栏最右端（紧邻全屏按钮）
放了一个紫色圆角方块图标，点击弹出**页内深色侧栏面板**，而不是浏览器工具栏的 popup。
面板结构（自上而下）：

```
Trancy 字幕  ⓘ                      [开关]
AI 字幕  ⓘ
主字幕        English
翻译字幕      中文
AI 总结
收藏视频
翻译引擎      Google
字幕显示      双语字幕
字幕样式      ⋮      ← 点开才是字号/颜色/背景等细项
键盘控制
更多功能
[学习模式 ⓘ] [旧版本]
```

这个设计的用意：用户在看视频时不该被迫离开画面去点工具栏图标 ——
入口贴在播放器上、面板浮在画面上，调完即走。复刻版按这个思路实现（见下文
「播放器右下角悬浮按钮」与「页内设置面板」）。

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
| `content.js` | 隔离世界主控：轨道选择、批量翻译、双层字幕渲染、rAF 推进、点词、查词弹窗、生词高亮、悬浮按钮与页内面板 |
| `bg.js` | Service Worker：设置、翻译（Google + MyMemory 降级）、词典、IndexedDB 缓存与生词本 |
| `overlay.css` | 字幕覆盖层 + 查词弹窗 + 悬浮按钮 + 页内设置面板样式 |
| `theme.css` | **共享设计系统**（墨黑分层底 + 暖金强调 + 字体/圆角/按钮/卡片原子类），被 popup 与词库页共用 |
| `popup.html` / `popup.js` | 工具栏弹窗：设置 + 生词本精简列表 |
| `wordbook.html` / `wordbook.js` | **词库看板**（独立页面）：KPI、学习状态环、每日新增柱状图、筛选/搜索/抽屉/复习/删除 |
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

**⑤ 译文里对应词也高亮：哨兵对齐**

难点：英文 `word` 在中文里可能译成"单词"、"字"、"词"，**没法靠词典反查位置**。
解法是把对齐问题变成"让翻译引擎自己告诉我位置"：

```
原文：  Click any word to look it up and save it to your wordbook.
标记：  Click any ⟦0⟧word⟦1⟧ to look it up and save it to your ⟦2⟧wordbook⟦3⟧.
送翻：  POST /translate_a/t  （一次请求，不额外花钱）
译文：  单击任意⟦0⟧单词⟦1⟧进行查找并将其保存到您的⟦2⟧单词本⟦3⟧。
        ↓ 哨兵之间的内容就是这个词在这句里的译法，位置也直接拿到了
解析：  word→单词[4,6]   wordbook→单词本[18,21]
清洗：  单击任意单词进行查找并将其保存到您的单词本。   ← 哨兵全部移除
渲染：  把 [4,6) 和 [18,21) 两个切片包成 <span class="trace-saved-zh">
```

几个实现细节：

- **哨兵选 `⟦ ⟧`（U+27E6/U+27E7）**：普通文本几乎不会出现，且实测被 Google 原样保留。
  对比实验里 `<b>` 会被吃掉、`«»` 会被"翻译"成中文引号、`#` 会让整句不翻（一次性探针
  `probe-sentinel2.js` 对比了 12 种标记风格，用完即删）。
- **索引用 `slot*2` / `slot*2+1`**：相邻两对共用编号会导致正则错配。
- **`al2` 缓存键版本号**：对齐结果按「译文语言 + 原文 + 待高亮词集合」缓存。早期版本会把
  "标记失败退回纯译文"的降级结果也写进缓存，脏数据落库后即使引擎恢复也一直读到它 ——
  现在降级结果**不写缓存**，并把键前缀升到 `al2` 整体绕过历史脏数据。
- **兜底补译**（`repairUntranslatedSlots`）：Google 偶尔会把标记内的词**原样保留**不翻译
  （实测 `…save it to your ⟦0⟧wordbook⟦1⟧.` 直接返回英文 `wordbook`，但同一个词单独送翻
  又是正常的 —— 属于上下文依赖的不稳定行为）。此时对这些槽位单独补译一次，再在译文里
  就地替换残留英文并重算 span 偏移，保证译文永远是纯中文。
- **退化路径**：若引擎把哨兵全吃掉（例如 MyMemory），`usable` 判定失败 → 退回纯译文，
  中文不高亮但至少能读，不会显示乱码。

### 过程中修掉的十个真实 bug（值得记录）

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

**bug 4：翻译竞态 —— 选 Google 时"只有英文没有译文"。**

现象：选 Google 引擎时字幕只有原文，切到 MyMemory 就正常。第一反应是"Google 被限流/被封"，
于是写了一轮压力测试把它排除掉：

- 800 句 × 25 句/批共 32 批 → 全部 200、`empty:0`；
- 连续 12 批 × 40 条（模拟真实视频）→ 12 批全 200，耗时 332–874ms，`empty:0`；
- 各种特殊字符（`& # % " < >`）、超长句、含换行 → 全部正常。

也就是说**引擎侧完全没问题**，问题在我们的代码。真正的根因有两个，叠在一起：

1. **并发竞态（主因）**：`loadSubtitles` 会被 `init` 和 `yt-page-data-updated` 触发两次。
   第二次重建 `state.sentences` 后调 `translateAll()`，而旧版 `translateAll` 开头是
   `if (state.translating) return;` —— 于是第二轮直接退出，但它已经把
   `state.sentences` 换成了**全新的、没有 `zh` 字段的对象**。第一轮的译文写进的是
   旧对象，新对象永远空白 → 界面只有原文。
   修复：用**代际令牌** `translateGen` 代替布尔锁。

   ```js
   let translateGen = 0;
   async function translateAll() {
     const gen = ++translateGen;               // 每次启动拿新代号
     for (const chunk of batches) {
       if (gen !== translateGen) return;       // 旧轮次自觉退出
       await translateChunk(chunk, …, gen);
     }
     if (gen === translateGen) state.translating = false;  // 只有当前轮能收尾
   }
   ```

2. **空串被当成"翻译成功"**：`googleTranslate` 把 `""` 原样返回且**不抛错**，于是
   `translateBatch` 的 catch 降级分支永不触发，`""` 还会被写进 IndexedDB 缓存
   （脏数据一旦落库，重开视频也修不好）。
   修复：`googleOnce` 里判定"整批为空 / 译文与原文完全相同（语言猜错）"都算失败并继续
   试下一个方案；缓存命中条件收紧为 `hit.text.trim()`。

同时把降级链做成**逐级拆分**，应对真实视频中途限流：

```
整批 40 条 → 成功 ≥60% 就收
           → 否则对半拆 → 再拆 → 单条
           → 仍失败的用 MyMemory 补（每批上限 60 条，避免打光额度）
```

**bug 5：自由拖动后字幕框"往右长"，文字看起来在乱动。**

现象：拖到某个位置后，句子变长时框向右扩展、变短时缩回左边，视觉上字幕左右横跳。

根因：自由模式下把鼠标位置直接写进了 `left`，而 `left` 是**左边缘**坐标；
框宽 `width: max-content` 随句子变化，左边缘固定 → 右边缘伸缩 → 视觉中心漂移。

修复：改成**按中心点定位**，并在每次重渲染后重新夹紧：

```css
[data-free="1"] .trace-sub-box {
  transform: translateX(-50%);   /* 保留，让 left 成为中心点 */
}
```

```js
function clampCenterX(cx) {
  const half = (boxEl.getBoundingClientRect().width || 0) / 2;
  return Math.max(half + 4, Math.min(window.innerWidth - half - 4, cx));
}
// 拖动时、以及 renderActive() 每次换句后都调一次
```

回归测试 `tools/test-center.js` 实测：短句 762px / 长句 1232px，两者中心都是 620px，
`driftPx: 0`；拖到最左边时 `leftEdge: 4`，正确被夹在视口内。

> 顺带记一个**测试台自身的坑**：早期用
> `Object.defineProperty(video, 'currentTime', { get: … })` 伪造播放进度，
> 但那个只改到**主世界**的 DOM wrapper，内容脚本跑在隔离世界读到的是原生
> `currentTime`（mock 里没有真实媒体，恒为 0），导致字幕永远停在第 1 句、
> 所有"换句"断言其实都没生效。改用 `canvas.captureStream(25)` 喂给 `video`
> 后两个世界才共享同一条真实时间轴。教训：**跨世界伪造 DOM 属性是无效的**。

**bug 6：拖动手柄"一碰就消失"，永远抓不到。**

现象：把手柄改成"鼠标移到字幕上才显示"之后，鼠标往上移去抓手柄，手柄立刻消失了。

根因：手柄是 `.trace-sub-box` 的子元素，但**定位在框外**（`top:-20px`）。
指针从框上移向手柄时会先离开框 → `:hover` 失效 → 手柄自己 `visibility:hidden` →
指针还没碰到它就已经不可点。

修复分两步：
1. CSS 上让手柄下沿**压住框顶 2px**，把两者的悬停区域连成一片；
2. JS 上加 **320ms 宽限延迟**桥接空隙 —— 离开框后不立即隐藏，
   期间如果指针进到手柄上就取消隐藏：

```js
const scheduleHide = () => {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!boxEl.classList.contains('trace-dragging')) overlayEl.classList.remove('trace-hot');
  }, 320);
};
boxEl.addEventListener('pointerenter', showHandle);
boxEl.addEventListener('pointerleave', scheduleHide);
handleEl.addEventListener('pointerenter', showHandle);   // 进了手柄就保持
```

CSS 侧对应 `.trace-sub-box:hover` 之外再加 `#trace-sub-overlay.trace-hot` 这个 JS 控制类。
`tools/test-ui.js` 断言三态：静止 `opacity:0/visibility:hidden/pointer-events:none`、
悬停 `opacity:1/visibility:visible/pointer-events:auto`、移开后重新归零。

> 这里也有个测试时序坑：类名在 320ms 移除，但 `opacity .16s` 过渡还要 160ms，
> 采样点必须 ≥800ms 才拿到终态；早期用 400ms 采样读到中间值导致误报 FAIL。

**bug 7：对齐链"整条静默失效"—— `Set` 过不了消息通道。**

现象：中文高亮完全不出现，但英文高亮正常，日志里也没有任何报错。

根因：`markWords(text, wordSet)` 里判的是 `wordSet.size`，而词集合是**通过
`chrome.runtime.sendMessage` 传进 SW 的** —— 结构化克隆把 `Set` 序列化成 `{}`，
`size` 变 `undefined`，函数直接 `return { marked: text, slots: [] }` 提前退出。
整条对齐链失效且**不抛错**，所以最难查。

修复：`markWords` 同时接受 `Set` 与数组，数组先 `new Set(...)` 归一化：

```js
const set = wordSet instanceof Set ? wordSet
          : Array.isArray(wordSet) ? new Set(wordSet.map(w => String(w).toLowerCase()))
          : null;
```

教训：跨消息传递的数据结构只能是 JSON 原生类型（数组/对象/字符串/数字），
`Set`/`Map`/`Date`/函数都不保证，且失败往往是静默的。

**bug 8：降级结果写进缓存，把好数据永久盖住。**

现象：移除一个生词后，译文里剩下的那个词变成英文 —— "…保存到您的 `wordbook`。"

排查过程：先怀疑哨兵导致不翻译，做了 `probe-sentinel.js`（发现 `⟦0⟧wordbook⟦1⟧`
确实原样返回）→ 又做 `probe-sentinel2.js` 对比 12 种标记风格（`⟦⟧`/`【】`/`<>`/`{{}}`/
`[[]]`/`«»`/`<b>`/零宽空格/`~`/LRM），结果 `⟦⟧` 在所有句子里都正常工作
→ 说明不是标记本身的问题，而是**读到了旧结果**。

根因：`translateAligned` 在"引擎吃掉了哨兵"的降级分支里，把 `spans: []` 的纯译文
**也写进了缓存**。之后即使引擎恢复正常，同样的（译文语言 + 原文 + 词集合）也只会命中
这条脏记录，永远修不好。

修复：降级结果**不写缓存**，并把缓存键前缀从 `al|` 升到 `al2|`，让历史脏数据整体失效。

**bug 9：Google 偶尔"把标记内的词原样保留"。**

现象：`…save it to your ⟦0⟧wordbook⟦1⟧.` 返回 `…保存到您的⟦0⟧wordbook⟦1⟧。` ——
哨兵保留了，但里面的词没翻。而把同一个词放进别的句子（`Please save the ⟦0⟧wordbook⟦1⟧
for me.` → `请帮我保存⟦0⟧单词书⟦1⟧。`）又是正常的。

结论：这是 Google 的上下文依赖行为，**不可控**，只能兜底。

修复：`repairUntranslatedSlots()` —— 检测哪些 span 的译文里没有中文（或仍含英文原词），
把这些词**单独再翻一次**，然后在译文里就地替换残留英文并重算 span 偏移：

```js
const looksUntranslated = (s) => !s?.zh
  || !/[\u4e00-\u9fff]/.test(s.zh)                              // 没有中文
  || new RegExp(`(^|[^A-Za-z])${escapeRe(s.word)}([^A-Za-z]|$)`, 'i').test(s.zh); // 混着英文

// 补译 → 替换 → recomputeSpanOffsets() 重新按出现顺序算位置
```

补译逻辑当时用一次性探针覆盖了三种情况（单词 / 两词 / 四词），断言
`leftoverEnglish:false`、`allMapped:true`、`sliceOk:true`（每个 span 的切片必须严格等于 `zh`）；
现在这条路径由 `test-zh-highlight.js` 的 `noSentinel` + 译文断言持续兜着。

**bug 10：设置面板把字幕从中间切断。**

现象：打开页内设置面板后，长句字幕的右半截被面板盖住（截图里英文
`…to capture the subtitle trac…player, and then we translate each complete…each fragment.`，
中文同样断在 `每个完整的句子，`），读起来是残句。

根因：面板是 `position: fixed; right: 14px; width: 322px` 的浮层，直接叠在播放器之上；
而字幕框是 `left: 50%; transform: translateX(-50%)` 的**全宽居中**布局 —— 两者互不知道对方存在。

修复分两半，靠一个 `.trace-panel-open` 类联动：

```css
/* 面板打开：可用宽度收到面板左侧，字幕左移到剩余区域中心 */
#trace-sub-overlay.trace-panel-open .trace-sub-box {
  max-width: min(calc(100vw - 374px - 52px), 1180px);
  left: calc((100vw - 350px) / 2);
}
```

```js
const PANEL_RESERVE = 350;   // 面板 322 + 右间距 14 + 余量 8
function isPanelOpen() { return !!panelEl && !panelEl.classList.contains('trace-hidden'); }
function syncPanelLayout() {
  overlayEl.classList.toggle('trace-panel-open', isPanelOpen());
  if (state.settings?.freePos && boxEl) {           // 自由拖动模式也要跟着夹紧
    const cx = parseFloat(boxEl.style.left) || window.innerWidth / 2;
    boxEl.style.left = clampCenterX(cx) + 'px';
  }
}
// togglePanel() 末尾调用 syncPanelLayout()
// clampCenterX() 的右边界改为 window.innerWidth - (isPanelOpen() ? PANEL_RESERVE : 0)
```

**踩的坑**：第一版 `max-width: calc(100vw - 374px)` 直接生效后，`test-ui.js` 新加的
`panelClearance` 断言量出 `boxLeft: -14` —— 字幕右缘确实退到面板左边了（`overlapPx: 0`），
但左边缘从屏幕里伸了出去。原因是 `.trace-sub-box` 没有 `box-sizing: border-box`，
`max-width` 只约束**内容盒**，`padding: 13px 26px 15px` 的左右 52px 要另算。
补上 `- 52px` 后实测 `boxLeft: 12, boxRight: 918, panelLeft: 944, overlapPx: -26`，
两边都有余量。断言也补了 `boxLeft >= 0`，防止这个溢出回归。

### 界面重设计：从"能用"到"像产品"

复刻完功能后，界面做了两轮视觉重构。核心决定是**放弃"每个页面各写一套 CSS"**，先抽出一套
共享设计系统 `theme.css`，再让三处界面（工具栏弹窗、词库看板、页内面板）共用同一套色板与原子类。

**设计语言**：深墨底 + 暖金强调。

- 金色直接取自字幕里「已加入生词本」的高亮色（`#ffd76e`）—— 设置界面、词库看板、视频画面
  三者在视觉上是一套东西，而不是拼装起来的三个工具。
- 底色是**五级墨黑**（`--ink-0` 到 `--ink-4`），靠层级而非描边区分区块；描边只用
  `rgba(255,255,255,.07)` 这种发丝线，避免深色界面上出现"一堆灰框"。
- 字体用系统栈而非网络字体：扩展页面要**离线可用、零网络请求、首屏即渲染**，
  层级靠字号 / 字重 / 字距拉开，不依赖字体文件。

**词库看板**（`wordbook.html`）不是把 popup 拉长，而是按"数据产品"重新设计：

| 区域 | 内容 |
|---|---|
| 顶部 KPI | 总词数、今日新增、连续天数、待复习 |
| 学习状态环 | 新词 / 记忆中 / 已记住 三段环形图（SVG `stroke-dasharray`） |
| 每日新增柱状图 | 支持日 / 周 / 月三种粒度，纵轴刻度用 `niceScale()` 取整 |
| 单词表 | 单词、释义、状态徽章、来源视频、加入时间、操作列 |
| 抽屉 | 点行展开：所在句子、译文、跳回视频按钮、复习 / 删除 |

**纵轴刻度**这个细节值得单独说：早期直接取 `max/3`、`2max/3`，数据量小时会出现
`1、3、4` 这种不等距刻度，读起来莫名其妙。改成先把上限向上取整到"好步长"（1/2/5/10…）的
整数倍，再等距出刻度：

```js
function niceScale(raw) {
  const target = Math.max(1, raw) * 1.15;
  let step;
  if (target <= 4) step = 1;
  else if (target <= 10) step = 2;
  else if (target <= 25) step = 5;
  else step = Math.ceil(target / 5 / 5) * 5;
  const max = Math.max(step, Math.ceil(target / step) * step);
  const ticks = [];
  for (let v = step; v <= max; v += step) ticks.push(v);
  return { max, ticks };
}
```

**页内面板**的视觉也对齐了这套语言（原来是 Trancy 风格的深灰 + 蓝紫，现在是墨黑 + 暖金）：

- 头部：金色渐变的 T 徽标 + 主标题 + 一行副标题（"双语字幕 · 点词即查 · 自动高亮生词"）
- 分区小标题（`字幕` / `字幕样式` / `更多功能`）用 10.5px + `letter-spacing: .1em` 做目录感
- 开关、滑杆、下拉全部自己画（原生控件在深色面板上是浅蓝系统样式，格格不入）
- 滑杆拇指金色、数值白色 —— **金色只留给可交互元素**，否则一屏七八个金色数字会和交互焦点抢注意力

**页内面板重设计时踩的两个排版坑**（靠像素级探针量 `getBoundingClientRect()` 才确认，
探针用完即删）：

1. 颜色选择器的色块（`input[type=color]`）没有 `margin-left: auto`，会紧跟标签靠左，
   右缘和上下滑杆的数值列对不齐，整块面板的右对齐网格就断了。
2. 数值列宽度不固定时，`55%` 和 `28` 混排会让右缘左右微抖；给 `.tp-val` 固定
   `width: 36px` + `text-align: right` 后，所有控件右缘落在同一条线上。

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
- **字号、字幕位置**：popup 或**页内面板**里实时调
- **毛玻璃字幕框**：深色半透明底 + `backdrop-filter: blur(18px)`，透出画面纹理而不是死黑板
- **播放器右下角悬浮按钮**：一个渐变紫的「T」方块贴在播放器右下角内侧，点击弹出**页内设置面板**
  （全屏、网页全屏、改窗口大小都会跟着贴边；可在面板里关掉）
- **页内设置面板**：深色侧栏，结构对齐 Trancy 的「Trancy 字幕」菜单 —— 启用开关、主字幕语言、
  翻译字幕语言、翻译引擎、字幕显示模式，加上可折叠的「字幕样式」与「更多功能」分组
- **字幕样式实时调节**：原文字号 / 译文字号 / 原文颜色 / 译文颜色 / 背景不透明度 / 圆角 /
  高斯模糊 / 整体缩放，8 项全部即时生效并持久化
- **自由拖动**：鼠标移到字幕框上，顶部浮出黑色胶囊（3 个白点）→ 按住即可拖到任意位置；
  **不碰字幕时手柄完全不显示**（`opacity:0` + `visibility:hidden` + `pointer-events:none`），
  移开鼠标后约 0.5s 淡出，绝不干扰画面；
  **拖动后按"中心点"定位**，句子变长变短都从中心向两侧对称伸缩，不会左右横跳；
  位置自动记住，换视频/刷新都保持；面板或 popup 里「恢复居中」可回到默认底部位置
- **点击查词**：点字幕里任意单词 → 音标 + 中文释义 + 英文释义 + 例句
- **生词本**：一键加入，记录单词/释义/**所在句子与译文**/视频标题/时间点，可搜索、删除、
  导出 JSON，点击条目跳回原视频那一秒
- **词库看板**（独立页面）：KPI 概览、学习状态环、每日新增柱状图（日/周/月）、状态筛选、
  搜索、单词抽屉（所在句子 + 跳回视频）、复习与删除 —— 数据全在本机，离线可用
- **生词高亮（跨视频生效）**：任何已加入生词本的单词，在**所有** YouTube 视频的字幕里都会
  自动高亮（黄色底色 + 下划线），不需要重新加入
- **译文对应词也高亮**：不只是英文原文，**中文译文里对应的那几个字**同样会高亮
  （青色 + 斜体 + 虚线下划线），一眼就能看出这个词在这句话里被译成了什么
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
node test-mock.js            # 基础链路 + 查词 + 生词本 + 高亮，输出 PASS/FAIL + shot-mock.png
node test-pot.js             # pot 签名回归测试 + 截图 shot-pot.png
node test-center.js          # 拖动后按中心点定位（长短句不左右跳）+ 截图 shot-center.png
node test-ui.js              # 手柄悬停显隐 + 悬浮按钮 + 页内面板 + 字幕样式，截图 shot-ui*.png
node test-zh-highlight.js    # 译文里对应中文也高亮（多词 / 点击 / 移除），截图 shot-zh-highlight.png
node test-wordbook.js        # 词库看板：KPI/状态环/柱状图/筛选/搜索/抽屉/复习/删除/粒度切换
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

居中回归（拖动后短句 762px / 长句 1232px，中心完全不动）：

```
targetX: 760  expectClamped: 660  centerAfterDrag: 660  followsCursor: true
leftEdgeAfterClamp: 4  leftCenterAfterClamp: 620  clampedInside: true
shortWidth: 762   longWidth: 1232
shortCenter: 620  longCenter: 620   driftPx: 0
RESULT: PASS（中心不漂移 + 跟随鼠标 + 不溢出视口 + 至少两句不同长度）
```

`expectClamped` 这个字段值得说明：拖动那一刻显示的是最长句（1232px），
`clampCenterX` 会把中心夹到 `1280 - 1232/2 - 4 = 660`，所以目标 760 会被正确夹紧。
测试早期硬编码"期望 760"导致误报失败，现在按当时框宽动态计算期望值。

UI 回归（手柄悬停显隐 + 悬浮按钮 + 页内面板 + 字幕样式）：

```
handle:   idle {opacity:0, visibility:hidden, pointerEvents:none}
          hover{opacity:1, visibility:visible, pointerEvents:auto}
          afterLeave {opacity:0}
launcher: {present:true, rect:{x:1234,y:848,w:34,h:34}, player:{right:1280,bottom:900}, insidePlayer:true}
panel:    {visible:true, w:322, groups:["字幕样式","更多功能"], hasStyleControls:true}
clearance:{panelLeft:944, boxLeft:12, boxRight:918, overlapPx:-26, overlayHasClass:true}  ← 面板不遮挡字幕
style:    before {origFontPx:28, transFontPx:21, boxRadius:"12px", boxBg:"rgba(38,38,40,0.55)"}
          after  {origFontPx:40, transFontPx:30, boxRadius:"24px", boxBg:"rgba(38,38,40,0.9)"}
persisted:{origSize:40, transSize:30, bgAlpha:0.9, radius:24}
RESULT: PASS
```

中文高亮回归（译文里对应词也高亮）：

```
target sentence: {"orig":"Click any word to look it up and save it to your wordbook.",
                  "trans":"单击任意单词即可查找并将其保存到您的单词簿中。"}
zh highlight: {count:2, words:["word","wordbook"], zhTexts:["单词","单词本"],
               hasSentinel:false, italic:true, underline:true, dash:"dashed",
               color:"rgb(127, 227, 212)"}
click zh span: {present:true, word:"word", btnAct:"remove"}
after remove:  {zhCount:1, enCount:1, trans:"单击任意单词即可查找并将其保存到您的wordbook。"}
checks: {zhPresent:true, noSentinel:true, styled:true, cyan:true, clickOpens:true, removed:true}
RESULT: PASS
```

词库看板回归（KPI / 状态环 / 柱状图 / 筛选 / 搜索 / 抽屉 / 复习 / 删除 / 粒度切换）：

```
seeded: 8 个词（pipeline / subtitle / overlay / translate / segment / caption / bilingual / highlight）
first:  {kTotal:8, kLearned:2, kLearning:2, kToday:3, rows:8,
         barCount:30, barFilled:3, donutBg:true, donutNum:8, legendRows:3,
         subLine:"共 8 个单词 · 已记住 2 · 记忆中 2 · 今天新增 3",
         chartSub:"最近 30 天 · 共 7 词 · 另有 1 词更早"}
filter: learnedView {rows:2, words:["caption","highlight"]}
search: {rows:1, words:["translate"]}
drawer: {open:true, word:"pipeline", phon:"/ˈpaɪplaɪn/", hasQuote:true, hasEm:true, playEnabled:true}
review: {kLearning:3, pill:"记忆中", drawerOpen:true}
gran:   day {bars:30} → week {bars:12} → month {bars:12}
delete: {kTotal:7, rows:7, deleteDelta:1}
checks: firstOk barFilledOk kpiOk learnedOk searchOk chipOk drawerOk reviewOk granOk deleteOk noErrors 全 true
RESULT: PASS（词库看板：KPI/状态环/柱状图/筛选/搜索/抽屉/复习/删除/粒度切换）
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
│  ├─ content.js                渲染 / 交互 / 页内面板 / DOM 兜底
│  ├─ bg.js                     SW：翻译 / 词典 / IndexedDB
│  ├─ overlay.css               字幕 / 查词卡 / 悬浮按钮 / 页内面板
│  ├─ theme.css                 共享设计系统（墨黑 + 暖金）
│  ├─ popup.html / popup.js     工具栏弹窗
│  ├─ wordbook.html / wordbook.js  词库看板
│  └─ icons\
└─ tools\                       ← 逆向与验证工具（非扩展的一部分）
   ├─ mock\fixtures.js          测试夹具（假播放器 + 13 条碎片字幕 + pot 模式）
   ├─ mock\server.js            本地夹具站点 :8899
   ├─ test-mock.js              端到端自动化测试（字幕/查词/生词本/高亮）
   ├─ test-pot.js               pot 签名回归测试
   ├─ test-center.js            拖动后中心点定位回归测试
   ├─ test-ui.js                手柄显隐 + 悬浮按钮 + 页内面板 + 字幕样式回归测试
   ├─ test-zh-highlight.js      译文里对应中文高亮回归测试（多词/点击/移除）
   ├─ test-wordbook.js          词库看板回归测试（KPI/图表/筛选/抽屉/复习）
   ├─ probe-ext2\               主世界 vs 隔离世界对照实验
   ├─ probe-transcript.js       get_transcript 接口探针
   ├─ gen-icons.js              纯 Node 生成 PNG 图标
   ├─ shot-mock.png             验证截图（高亮 + 查词卡）
   ├─ shot-pot.png              pot 模式验证截图
   ├─ shot-center.png           居中验证截图
   ├─ shot-ui.png               悬浮按钮 + 放大字号截图
   ├─ shot-ui-panel.png         页内设置面板展开截图
   ├─ shot-zh-highlight.png     译文中文高亮截图
   ├─ shot-wordbook.png         词库看板截图
   ├─ shot-wordbook-drawer.png  词库看板单词抽屉截图
   └─ shot-glass.png            毛玻璃 + 3 点拖动胶囊截图
```

## 五、与 Trancy 的差距

复刻的是**核心链路**，以下能力未实现（都属于 Trancy 的商业化部分）：

- 多平台支持（Netflix / HBO / Disney+ / Prime / Bilibili 等各自的抓取 hook）
- Whisper 语音转写（无字幕视频）
- 服务端 NLP 分句（本实现用本地启发式替代，长句/跨句指代不如服务端）
- 语法分析、TTS 发音、跟读发音评测
- 网页全文沉浸翻译、划词翻译、阅读模式
- 云端账号同步
