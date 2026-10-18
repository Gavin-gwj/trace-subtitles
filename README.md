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
| `subtitles.js` | 纯函数库：`parse()`（json3/srv3）、`segment()`（智能分句）、`splitLong()`（超长句二次切分）、`hash()`、`findByTime()`、`wordForms()`（词形归一化） |
| `content.js` | 隔离世界主控：轨道选择、批量翻译、双层字幕渲染（含 `fitToFrame()` 自适应缩小）、rAF 推进、点词、查词弹窗、生词高亮（含词形变化）、悬浮按钮与页内面板 |
| `bg.js` | Service Worker：设置、翻译（Google + MyMemory 降级）、词典、IndexedDB 缓存与生词本、哨兵对齐（`markWords` / `parseMarked`）、**备份/恢复落盘** |
| `overlay.css` | 字幕覆盖层 + 查词弹窗 + 悬浮按钮 + 页内设置面板样式 |
| `theme.css` | **共享设计系统**（墨黑分层底 + 暖金强调 + 字体/圆角/按钮/卡片原子类），被 popup 与词库页共用 |
| `popup.html` / `popup.js` | 工具栏弹窗：设置 + 生词本精简列表 |
| `wordbook.html` / `wordbook.js` | **词库看板**（独立页面）：KPI、学习状态环、每日新增柱状图、筛选/搜索/抽屉/复习/删除、**备份与恢复**（含自选文件夹） |
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
- 超长保护：`maxLen = 120` 字符，超出交给 `splitLong()` 二次切分（见下）
- 处理 YouTube 自动字幕的典型脏数据：碎片无标点、首字母小写、重复滚动行

实测把测试夹具的 **13 行碎片 → 6 个句子**，最长 111 字符，译文连贯。

**超长句二次切分（`splitLong()`）**

`maxLen` 从 180 收到 120 是踩了实际观感之后的决定：180 时字幕框最宽可到
1180px，一句 130 字符的英文能撑满两行、配上中文三行，整个框能占到画面高度的
40%（截图里那句 Emirates 头等舱的字幕就是这种情况）。收到 120 后，多数长句会在
逗号处断成两段，每段一行。

`splitLong()` 不是"按 120 硬切"，因为硬切会把词切两半、也会切出
`not each fragment.` 这种 18 字符的孤儿片段，单独闪一下反而更打断阅读。它的做法：

1. 先算需要几段 `n = ceil(len / maxLen)`，再按 `n` 均分得到 `target`；
2. 在 `target` 附近（±35%）找断点，**优先断在逗号/分号后面** —— 断在标点处的语义完整性最好；
3. 范围内没有标点就找**最近**的空格（不是最靠后的空格 —— 取最靠后会切出超过
   `maxLen` 的长段，等于白拆。第一版就犯了这个错，实测切出 134 字符的段）；
4. 整段没空格（极端 ASR 产物）才硬切，否则会死循环；
5. 尾巴短于 26 字符就并回上一段，宁可上一段略长，也不要单独闪一个短片段。

切段后时间轴按字符数比例分配，否则 `findByTime()` 只会命中第一段，后面几段永远
显示不出来。

**自适应缩小（`fitToFrame()`）**

拆分不是万能的：用户可以把字号调到 48px，全屏时还有 `--trace-vscale` 放大。
所以再加一道兜底 —— 量出字幕框的自然高度，超过画面高度 55% 就按超出比例缩小
`--trace-fit`（CSS 里与 `--trace-font-scale`、`--trace-vscale` 相乘），下限 0.62。
再小就不可读了，那时宁可让框超出也不缩成蚂蚁字。

实测三组（1440×900 画面、190 字符长句）：

| 场景 | 框高 | 占画面 | `--trace-fit` |
|---|---|---|---|
| 修复前（`maxLen=180`，无切分） | 171px | 19.0% | — |
| 修复后（`maxLen=120` + 切分） | 103px | 11.4% | 1（无需缩小） |
| 修复后 + 字号 48px/缩放 1.6 | 498px | 55.3% | 0.936（兜底生效） |

关键数字：修复后长句与短句的框高**都是 103px**，即框高不再随句长变化。

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

### 过程中修掉的十七个真实 bug（值得记录）

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

回归测试 `tools/test-center.js` 实测：短句 323px / 长句 1232px，两者中心都是 640px，
`sentenceDrift: 0`；拖到最上边时 `topAfterDragUp: 29`，正确被夹在画面内。

> **后续修正**：这套"按中心点定位 + 夹紧"的方案后来整个被替换了。
> 用户要求对齐 Trancy 的行为 —— **只能上下移动，横向固定居中**。
> 这样比"允许横向拖动再夹紧"更省事：横向根本不由 JS 控制（永远是 CSS 的
> `left:50%` + `translateX(-50%)`），`clampCenterX()` 因此被删除，也不用在每次
> 换句后重新夹紧。上面这段代码只作为历史记录保留。
> 新方案的回归测试断言：把指针往右拖 500px，框中心 640 → 640（纹丝不动）。

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

**bug 11：字幕贴在浏览器窗口上，而不是视频画面上。**

现象：普通（非全屏）模式下，YouTube 播放器只是页面里的一块矩形 —— 上方有顶栏、右侧有推荐栏、
影院模式下左右还有黑边。但字幕覆盖层是 `position: fixed; inset: 0`，贴的是**整个视口**，
于是字幕会浮在画面之外的空白/黑边上，看起来像"飘在网页上"而不是"压在视频里"。
进全屏时也没有等比放大：字号写死 28px，画面放大到 1920 宽后字幕显得很小。

根因：`inset: 0` 把覆盖层的坐标系绑到了视口，而所有百分比（`bottom: 18%`、`max-width: 94%`）
都是相对这个视口算的。视频框的位置和尺寸变化（全屏、影院模式、顶栏折叠、窗口缩放）
对覆盖层完全不可见。

修复：把覆盖层从"贴视口"改成"贴视频框"，并把位置/尺寸交给 JS 实时写入：

```js
function overlayGeom() {
  const mp = document.getElementById('movie_player');
  const r = (mp || getVideo())?.getBoundingClientRect?.();
  if (r && r.width > 80 && r.height > 60) return { left: r.left, top: r.top, width: r.width, height: r.height };
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };  // 兜底
}

function isFullscreen() {
  if (document.fullscreenElement) return true;
  const mp = document.getElementById('movie_player');
  return !!mp && mp.classList.contains('ytp-fullscreen');   // YouTube 的做法
}

function applyOverlayFrame() {
  const g = overlayGeom();
  const fs = isFullscreen();
  let scale = 1;
  if (!fs) {
    baseFrameWidth = g.width;          // 非全屏时持续刷新基准
  } else {
    const base = baseFrameWidth || g.width;
    scale = Math.max(1, Math.min(g.width / base, 2.8));   // 全屏按宽度比放大
  }
  const reserve = panelReservePx();     // 面板打开时右侧让位
  const key = [g.left, g.top, g.width, g.height, scale.toFixed(3), reserve].join(',');
  if (key === lastGeomKey) return;      // 几何签名去重，没变化就只做一次字符串比较
  lastGeomKey = key;
  overlayEl.style.left = g.left + 'px';  overlayEl.style.top = g.top + 'px';
  overlayEl.style.width = g.width + 'px'; overlayEl.style.height = g.height + 'px';
  overlayEl.style.setProperty('--trace-vscale', scale.toFixed(3));
  overlayEl.style.setProperty('--trace-panel-reserve', reserve + 'px');
  overlayEl.classList.toggle('trace-panel-open', isPanelOpen());
  if (state.settings?.freePos && boxEl) reapplyFreePos();
}
```

CSS 侧只要把字号和行宽都乘上 `--trace-vscale` 就够了：

```css
#trace-sub-overlay .trace-sub-orig  { font-size: calc(var(--trace-orig-size)  * var(--trace-font-scale) * var(--trace-vscale)); }
#trace-sub-overlay .trace-sub-trans { font-size: calc(var(--trace-trans-size) * var(--trace-font-scale) * var(--trace-vscale)); }
#trace-sub-overlay .trace-sub-box   { max-width: min(94%, calc(1180px * var(--trace-vscale))); }
```

**踩的坑一：缩放基准必须是"非全屏时的宽度"，不能写死 1280。**
第一版用 `scale = rect.width / 1280`，结果窗口小一点（播放器 900 宽）字幕就缩到 0.7 倍、
大屏（1600 宽）又涨到 1.25 倍 —— 用户拖一下窗口字幕就忽大忽小。
改成在非全屏时不断记录 `baseFrameWidth = g.width`，全屏时算 `g.width / baseFrameWidth`，
语义就精确对上需求："全屏后等比例放大，退出全屏后又等比例缩小"，非全屏时恒为 1。

**踩的坑二：拖拽坐标要减掉视频框的左上角。**
指针事件给的是视口坐标（`ev.clientX`），而覆盖层的坐标系现在是视频框的。
不换算的话，播放器不在 (0,0) 时字幕会偏移一整个顶栏的距离。
`onMove` 里改成 `clampCenterX(ev.clientX - drag.dx - g.left)` 与 `ev.clientY - drag.dy - g.top`。

**踩的坑三：自由位置必须改存归一化比例。**
原来存的是视口绝对像素 `{x, y}`。覆盖层改成贴视频框后，绝对像素在换窗口大小、
进全屏、切影院模式时全部失效（字幕会跑到画面外）。改成 `{nx, ny}`（0~1 的比例），
`applyFreePosition` 里乘回当前视频框尺寸；同时兼容旧数据 —— 见到没有 `nx` 的对象就按
旧的视口像素处理一次。

**踩的坑四：`max-width` 的上限也得缩放。**
只放大字号不放大行宽上限，全屏时 1180px 的 `max-width` 会把长句挤成三行。
`calc(1180px * var(--trace-vscale))` 之后，全屏实测行宽从 892px 展开到 1392px，长句仍是一行。

**回归测试 `tools/test-frame.js`**（夹具新增 `opts.frame` 指定播放器矩形、`__mockFullscreen(on)`
模拟 YouTube 加 `.ytp-fullscreen`）：1440×900 窗口 + 900×506 的播放器矩形，实测：

```
normal:     overlay {x:140, y:80, w:900, h:506}  == 视频框   vscale 1     fontPx 28
fullscreen: overlay {x:0,   y:0,  w:1440, h:900} == 视口     vscale 1.6   fontPx 44.8
back:       overlay {x:140, y:80, w:900, h:506}  == 视频框   vscale 1     fontPx 28
RESULT: PASS（字幕贴视频框 + 全屏等比放大 + 退全屏等比缩回）
```

截图目视确认：非全屏时字幕完整落在偏左上的绿色画面内、下方还露出画面（CC 徽标与 T 按钮），
全屏时字幕随画面一起铺开、字号明显变大，两种状态都没有越出画面。

**bug 12：译文里漏出「〖3〗」这类哨兵乱码。**

现象：用户加入生词后，译文里出现 `〖3〗`、`〖5〗` 这样的记号（截图里被红框圈出）。
不是每次都有 —— 只在**同一个词在一句里重复出现**时出现。

根因：中文高亮靠「带哨兵的翻译」——把生词用 `⟦0⟧word⟦1⟧` 包起来送给 Google，
中文对应词会落在两个哨兵之间。但 Google 在**去重重复词**时会把「词 + 旁边那个括号」一起删掉：

```
输入: …two ⟦0⟧halves⟦1⟧. Cream on the bottom of both ⟦2⟧halves⟦3⟧, dollop of jam on both ⟦4⟧halves⟦5⟧.
输出: …两半⟦0⟧半⟦1⟧。 ⟦2⟧⟧3⟧底部涂上奶油，⟦4⟧⟧5⟧都涂上果酱。
                              ↑ 这里少了 ⟦ 只剩 ⟧3⟧
```

注意它把三个 `halves` 去重成了一个「半」——语义上已经丢了两处，
但那是引擎行为，改不了。真正要修的是：早期解析用 `⟦n⟧([\s\S]*?)⟦n+1⟧` 严格配成对，
`⟦2⟧⟧3⟧` 这种缺一个括号的结构匹配失败，于是记号本身**原样留在译文里**。
`⟦` `⟧` 在中文语境下看起来就像 `〖` `〗`，用户看到的就是「〖3〗」。

修复：**不依赖成对括号，改用编号做锚点**。括号可能被删，但编号几乎总被保留：

```js
const TOKEN_RE = /[\u27E6\u27E7]?\s*(\d+)\s*[\u27E6\u27E7]/g;   // 左括号可选
function parseMarked(out, slots) {
  const tokens = scanTokens(out);          // ① 扫描所有记号（容忍括号缺失）
  // ② 相邻两记号之间的文本 = 前一个槽位的内容
  // ③ 右记号编号必须紧邻左记号（close.idx === open.idx + 1），否则结构已坏，放弃该槽位
  // ④ 内容为空 / 内容里还有括号 / 内容只剩编号 → 都是「词被引擎吃掉」，放弃高亮（绝不猜）
  // ⑤ 清洗时把**记号整体（含编号）**和落单括号一起删掉
}
```

第 ⑤ 点是个独立的坑：如果只删括号不删编号，`⟦2⟧⟧3⟧` 会变成 `23` 留在译文里。

缓存键版本从 `al2` 升到 `al3`：旧缓存里存着「带哨兵残留」的脏译文，
不换版本号的话重开视频还会从 IndexedDB 读回同样的乱码。

**回归测试**：`test-zh-highlight.js` 增加 `repeatOk` 断言 —— 用截图里那句原话
（三个 `halves`）走一次 `translateAligned`，断言译文不含 `⟦⟧`、不含孤立数字、
且至少有一个槽位成功对齐。实测：

```
zh: ">> 你将做什么 将顶部和撬开，这样你就得到了两半半。 底部涂上奶油，都涂上果酱。"
spans: [{w:"halves", zh:"半"}]
hasSentinel: false   hasStrayDigit: false
```

（`两半半` 是 Google 去重的结果，属上游语义损失，不在本扩展能修的范围内。）

**bug 13：换翻译引擎 / 刷新页面，字幕就「没译文」了（三个独立故障）。**

用户报障三句话：①切到 MyMemory 后译文消失；②切回 Google 仍然没有译文，必须刷新页面；
③每次刷新页面后必须点一下扩展面板，字幕才出来。三个症状看着像同一个问题，
实际是**三条互不相关的故障链**，各自独立修。

**A. MyMemory 额度用尽时返回 HTTP 200 + 警告正文，被当成译文。**

MyMemory 免费额度耗尽时**不返回 429**，而是 `200 OK`，正文是：

```json
{"responseData": {"translatedText": "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY. NEXT AVAILABLE IN 14 HOURS ..."}, "quotaFinished": null}
```

旧代码直接 `return String(json?.responseData?.translatedText || '')`，于是这句警告
被当译文渲染到字幕上 —— 而额度耗尽后**每一句**都这样，看起来就是"译文没了/变英文了"。
更糟的是它非空，所以 `translateBatch` 的降级分支（空结果才降级）**永远不会触发**。

修复：识别警告正文，当作失败抛错，让降级链继续往下走：

```js
if (/^MYMEMORY WARNING/i.test(out.trim())) {
  throw new Error('mymemory quota exceeded');
}
```

**B. 缓存键里没有引擎维度 → 切引擎读到上一个引擎的译文。**

`translateAligned` 的缓存键是 `${tl}|al3|${hash(text)}|${hash(words)}`，
`translateWithCache` 是 `${target}|${hash(text)}` —— **两个都不含引擎**。
MyMemory 那轮一旦把结果写进 IndexedDB，切回 Google 时缓存直接命中，读回的还是
MyMemory 的（降级前的）内容，界面看起来"切了引擎没反应"。

修复：缓存键最前面加引擎，并把版本号从 `al3` 提到 `al4`：

```js
const engine = (await getSettings()).engine;
const key = `${engine}|${tl}|al4|${hashStr(texts[i])}|${hashStr(...)}`;   // 对齐路径
const key = `${engine}|${target}|${hashFn(texts[i])}`;                   // 纯译文路径
```

**C. `init()` 第一行就 `await` 后台设置 → 后台没醒，整个字幕流程都不启动。**

旧 `init()` 的第一句是 `const r = await chrome.runtime.sendMessage({type:'settings:get'})`，
**拿到设置之前什么都不做**：不建覆盖层、不抓字幕。而 MV3 的 service worker 空闲就休眠，
`sendMessage` 要把它唤醒、冷启动、读 storage 再回消息 —— 这段时间里页面上什么都没有。
用户看到的"必须点一下插件才出字幕"，点的那个动作恰好唤醒了 SW，于是下一次刷新就正常了。

修复：**先用默认值把界面立起来，设置随后异步补**：

```js
const FALLBACK_SETTINGS = { enabled: true, targetLang: 'zh-CN', sourceLang: 'auto', ... };

async function loadSettings(ms = 2500) {
  try {
    const r = await sendMsg({ type: 'settings:get' }, ms);   // sendMsg 自带超时
    if (r && r.ok && r.data) { state.settings = { ...FALLBACK_SETTINGS, ...r.data }; return true; }
  } catch (e) { console.warn('[Trace] 读取设置超时，先用默认值继续', e.message || e); }
  state.settings = { ...FALLBACK_SETTINGS };
  return false;
}

async function init() {
  state.settings = { ...FALLBACK_SETTINGS };   // ① 先立起来
  buildOverlay(); buildLauncher(); applySettingsToOverlay();
  loadWordSet(); startLoop();
  scheduleLoad(1000);                          // ② 抓字幕不依赖设置，立刻开跑
  const ok = await loadSettings(2500);          // ③ 设置随后到
  if (ok) {
    applySettingsToOverlay();
    if (state.translatedTarget && state.translatedTarget !== state.settings.targetLang) {
      // 之前按默认语言翻过的句子要作废重翻
      state.sentences.forEach((s) => { s.zh = ''; s.zhSpans = []; s.zhAlignTried = false; });
      translateAll();
    }
  }
}
```

**这三个 bug 的测试都是先证明"能抓住旧代码"。** 把修复前的 `bg.js` / `content.js`
从 `git show HEAD:` 取出来放进 `tools/.ext-old/`，用同一份测试跑一遍 ——
旧代码必须 FAIL、新代码必须 PASS，否则这个测试就没在测东西。实测对照：

| 断言 | 旧代码 | 新代码 |
|---|---|---|
| A3 译文里没有 MYMEMORY 警告原文 | **FAIL**（三句全是警告正文） | PASS（`["你好世界","这是一个测试","你今天怎么样"]`） |
| B2 Google 没有读回 MyMemory 的缓存 | **FAIL**（读回 `【MM】Click any word...`） | PASS（`["单击任意单词即可查找"]`） |
| C5 后台设置慢 3s 时字幕层仍立刻建立 | **FAIL**（`overlayMs: 3116`） | PASS（`overlayMs: 49`） |

C5 的做法是在 SW 里把 `chrome.storage.local.get` 包一层 3 秒延迟，再开新标签页量
`#trace-sub-overlay` 出现的耗时 —— 旧实现跟着设置一起等（3116ms），新实现先立界面（49ms）。

B 用例能测出问题，靠的是**给两个引擎不同的可辨识输出**：让 MyMemory 的 mock 返回
`【MM】<原文>`，于是"切回 Google 却拿到 `【MM】` 开头的译文"一眼就能断言。
早期版本里 MyMemory 降级到 Google、两边输出一模一样，这个断言其实**永远为真**，
测不出任何东西 —— 这是写降级链测试时最容易踩的坑。

**D. 长句不折行 → 字幕框吃掉了半个画面。**

这不是"译文太长"的问题，而是分句阶段压根没管长度：`maxLen` 是 180 字符，而
190 字符的句子在 180 的阈值下正好逃过一次切分，于是一整句英文撑满两行、
配上中文三行，框高 171px（占 900px 画面的 19%）。截图里那句
`smallest road legal car ever made. So, naturally, as an adult with free will...`
就是这种情况 —— 一屏字幕盖掉近四分之一画面。

修复分两层，因为单靠哪一层都不够：

1. **`maxLen` 180 → 120，并加 `splitLong()` 二次切分**。多数长句会在逗号处断成两段，每段一行。
2. **`fitToFrame()` 兜底**。用户能把字号调到 48px，全屏还有 `--trace-vscale` 放大，
   拆分拦不住。量出框高超过画面 55% 就按比例缩 `--trace-fit`（下限 0.62）。

实测三组（同一句 190 字符）：

| 场景 | 框高 | 占画面 | `--trace-fit` |
|---|---|---|---|
| 旧（`maxLen=180`，无切分） | 171px | 19.0% | — |
| 新（`maxLen=120` + 切分） | 103px | 11.4% | 1（无需缩小） |
| 新 + 字号 48px/缩放 1.6 | 498px | 55.3% | 0.936（兜底生效） |

修复后长句与短句的框高**都是 103px** —— 框高不再随句长变化，这才是目标。
只把 `maxLen` 调小不够：不切分的话 130 字符的句子照样能撑满两行。

**E. 在首页浏览时，字幕还飘在页面内容上。**

现象来自用户反馈：「为什么我在后台放视频，YouTube 首页也会有时候有翻译字幕」。
根因不是"没隐藏"，而是**覆盖层的坐标系选错了**：它贴的是 `#movie_player` 的矩形，
而当 YouTube 把播放器缩成右下角 400×225 的迷你窗时，那个矩形**仍然存在且完整可见** ——
于是字幕照样贴上去，字号还被 `--trace-vscale` 按小窗宽度算成十几个像素。

关键在于「可见」有三种含义，只看矩形有没有值是分不出来的：

| 情况 | 播放器矩形 | 该不该显示 |
|---|---|---|
| 翻到评论区，播放器露出一半 | 存在，部分在视口外 | 显示 |
| 滚到完全看不见 | 存在，完全在视口外 | 隐藏 |
| 首页后台播放，缩成迷你窗 | 存在且完整可见，但只有视口一小块 | 隐藏 |

所以判据改成「**可见面积 / 播放器面积**」+ 迷你窗识别：

```js
function frameVisibility() {
  const r = playerRect();
  if (!r) return { visible: false, ratio: 0, rect: null, mini: false };
  const vw = window.innerWidth, vh = window.innerHeight;
  const mini = r.width < vw * 0.5 && r.height < vh * 0.5;   // 完整可见但没法读
  const visW = Math.min(r.left + r.width, vw) - Math.max(r.left, 0);
  const visH = Math.min(r.top + r.height, vh) - Math.max(r.top, 0);
  if (visW <= 0 || visH <= 0) return { visible: false, ratio: 0, rect: r, mini };
  const ratio = (visW * visH) / (r.width * r.height);
  // 45%：翻评论区时常常还露出一半，这时仍算在画面里，
  // 不该突然切走 —— 那会让字幕在屏幕上跳来跳去。
  const visible = !mini && ratio >= 0.45 && visW > 80 && visH > 60;
  return { visible, ratio, rect: r, mini };
}
```

配套给了一个 `globalMode` 开关（默认关）：打开后视频框不在视野里时不隐藏，
而是改成**贴屏幕底部的悬浮条**。完整实现、三个踩坑（悬浮条横穿迷你播放器 /
内联 `top` 压过 CSS `bottom` / 固定 profile 把上轮设置带进测试）与 8 项断言见
[全局显示：视频不在眼前时，字幕该去哪儿](#全局显示视频不在眼前时字幕该去哪儿)。

**bug 14：字幕框压住 YouTube 自己的设置菜单，用户点不到「清晰度」。**

字幕框是覆盖在播放器上的不透明浮层，YouTube 的齿轮菜单从右下角弹出，长字幕正好
压在上面。菜单是 `position:absolute` 的 DOM 元素，和字幕框抢同一块像素 —— 谁在上
谁就吃掉点击。用户反馈：「翻译框会遮住 YouTube 页面原有的组件，例如清晰度等设置项，
导致用户无法直接点击这些组件。」

修复是**检测到重叠就淡出 + 点击穿透**（`ytUiRects()` / `boxOverlapsYtUi()` /
`syncDodge()` + `.trace-dodge` 类），不是把字幕挪走 —— 菜单尺寸随内容变化，
挪到哪儿都可能又压住别的东西。三个细节（不透明度必须为 0 不能留残影 / 必须跳过
YouTube 自己隐藏的控制栏 / 不重叠时不能触发）与 7 项断言见
[让路：字幕压住 YouTube 设置菜单时自动退开](#让路字幕压住-youtube-设置菜单时自动退开)。

**bug 15：短语卡比单词卡高一截，`positionPopup()` 直接压住字幕。**

短语卡 375px 高、单词卡约 250px，而 `positionPopup()` 只按「词的上面」摆、
只在放不下时才做一次避让。结果短语卡正好盖住字幕条 —— 而**当时的测试一条位置断言都没有**，
只检查卡片里的文字，靠人眼看截图才发现。

修复：先量字幕框上下各剩多少空间，放得下就完全不碰字幕，放不下才把卡片高度收到刚好不越界
（`body.style.maxHeight = Math.min(hardMax, availH)`）；并补上 `L10b`（不遮挡）与
`L10c`（在视口内）两条断言。

这个修复本身又引出一个 bug：把 `!boxRect` 兜底分支从函数末尾提到判断链最前面时，
忘了删掉末尾那行重复的兜底赋值 —— 于是 `boxRect` 为 null 时仍然执行 `boxRect.top`，
`TypeError` 让整个卡片不渲染，`L7`–`L10c` 全部 FAIL。**移动分支要连带删掉旧位置那份。**

### 词形归一化：收藏 beverage，也要高亮 beverages

生词本里存的是**某个词形**，但视频里出现的可能是另一个。收藏 `beverage` 之后，
后面那句 `attendants that serve you beverages` 里的复数形式既不高亮、点开还显示
「＋ 加入生词本」—— 用户会以为生词本坏了。

**为什么不用词干化（stemming）或词形还原（lemmatization）**：
不引第三方 NLP 库（扩展要离线可用、体积敏感）。改成「给一个词形，列出它可能对应的
其它词形」，匹配时看两个集合有没有交集。多给的候选只有在生词本里**真有那个词**时才命中，
误报代价极低 —— 宁可多给候选，也不漏掉词形变化。

`wordForms(w)` 双向生成候选：

```js
// 反向：beverages → beverage
if (/s$/.test(word) && !/ss$/.test(word) && !/us$/.test(word) && !/is$/.test(word)) {
  out.add(word.slice(0, -1));
}
// 正向：beverage → beverages（只在生词本里真有 beverages 时才命中）
else addForm(word + 's');
```

四条边界，每一条都是踩过才知道要加的：

1. **必须双向**。只做 `beverages → beverage` 的话，先收藏了复数形式就永远匹配不到单数。
2. **单复数同形/不可数词要白名单**（`INVARIANT`：news / series / species / data / media …）。
   否则 `news` 会被 `-s` 规则砍成 `new`，收藏 `new` 又会让满屏 `news` 高亮。
3. **已经像变形词的（`-s/-es/-ed/-ing/-er/-est`）不再正向展开**，否则
   `beverages` 会派生出 `beverageses`、`beveragesed` 这种永远匹配不上的垃圾候选。
4. **不收不规则动词**。`saw`（锯子）vs `saw`（see 的过去式）、`left`（左）vs `left`（leave 的过去式）、
   `found`（建立）vs `found`（find 的过去式）—— 同形冲突太多，误报比漏报更烦人。
   不规则**名词**复数（children / knives / halves …）是安全的，收。
   `be / have / do` 三族也一律不收（is / are / was / has / had / does）：超高频功能词，
   一旦收藏整屏都在高亮。

**匹配时返回「生词本里那个词」，不是屏幕上那个词**：

```js
function matchSaved(rawWord, set) {
  const w = String(rawWord || '').toLowerCase();
  if (!w) return null;
  if (set.has(w)) return w;                      // 精确命中优先
  for (const cand of wordForms(w)) {
    if (cand !== w && set.has(cand)) return cand; // 词形展开命中
  }
  return null;
}
```

精确命中优先是必须的：生词本里同时有 `beverage` 和 `beverages` 时，字幕里的 `beverages`
必须归到 `beverages`，否则点它会显示另一个词条的释义。归一化后的词写进
`data-w`，所以点复数形式打开的是单数词卡、按钮显示「✓ 已在生词本」。

这条链要**三处同时归一化**，缺一处就前后矛盾：

| 位置 | 作用 | 不一致的后果 |
|---|---|---|
| `content.js` `findSaved()` / `renderWords()` | 决定英文词是否加 `trace-saved`、`data-w` 存什么 | 不归一化 → 复数不高亮 |
| `bg.js` `markWords()` | 决定送翻译时给哪些词打哨兵 | 不归一化 → 中文侧没有对应高亮 |
| `bg.js` `hasWord()` | 回答「这个词在生词本里吗」 | 不归一化 → 按钮显示「加入生词本」 |

`wordForms` 在 `subtitles.js`（内容脚本世界）和 `bg.js`（Service Worker 世界）各有一份
—— 两个世界不能共享模块，只能复制。为防止改一处忘另一处，两份都用
`// >>> WORD_FORMS_BEGIN` / `// >>> WORD_FORMS_END` 包起来，`tools/test-forms.js`
第一件事就是抽出两段逐行比对（忽略缩进），不一致直接 FAIL。

实测（`node test-forms.js`）：

```
WORD_FORMS blocks identical: true (4653 chars)
wordForms unit: {"misses":[],"falsePositives":[]}
singular: {"target":{"text":"beverage","saved":true,"w":"beverage"}}
plural  : {"target":{"text":"beverages","saved":true,"w":"beverage"}}
click   : {"word":"beverage","btnText":"✓ 已在生词本","btnAct":"remove"}
RESULT: PASS（词形归一化：单复数都高亮，点复数打开同一词条）
```

写这个测试时也踩了一个坑：弹窗里第一个 `[data-act]` 是右上角的关闭按钮
（`data-act="close"`），选择器写成 `[data-act]` 会把「×」当成收藏按钮的文案，
断言恒为 FAIL。要显式选 `[data-act="add"], [data-act="remove"]`。

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

### 生词本落盘：卸载重装后数据还在

IndexedDB 与 `storage.local` 都活在扩展的存储分区里，**卸载扩展时 Chrome 会连数据一起清掉**
—— 这不是 bug，是浏览器的设计，扩展侧无法阻止。所以想让生词本活过重装，只有一个方向：
把数据写成扩展目录**之外**的普通文件。

实现是「一个文件 + 双向同步」：

| 动作 | 行为 |
|---|---|
| 加词 / 删词 / 复习 | 若开了自动备份，静默覆盖写同一个文件（不堆副本） |
| 「备份到文件」 | 立即写一次，toast 报出写到了哪个目录、几个词 |
| 「恢复」 | 读文件 → 与现有数据**合并**：同词取复习次数更高的、`createdAt` 取更早的，不产生重复词条 |
| 「选择备份文件夹」 | 用 `showDirectoryPicker()` 让用户指定目录，之后所有备份都写那里 |

写文件有两条路，优先走前者：

1. **用户选定的目录**（File System Access API）—— 用 `FileSystemDirectoryHandle` 直接
   `getFileHandle('trace-vocab-backup.json', {create:true})` 再 `createWritable()` 写入。
   位置由用户定，重装扩展后重新选同一个目录就能恢复。
2. **兜底：`chrome.downloads`** —— 没选目录时下载到浏览器默认下载目录。
   需要一个 `chrome.downloads` 权限，且**文件名重复时 Chrome 会自动加 `(1)` `(2)`**，
   所以用 `conflictAction: 'overwrite'` 明确覆盖。

**这里踩了一个架构级的坑，值得单独记**：

> `FileSystemDirectoryHandle` **不能通过 `chrome.runtime.sendMessage` 传递**。

消息通道走结构化克隆，句柄传过去会变成**空壳** —— 方法全丢，连 `.name` 都读不到：

```
S21 选定目录后后台能看到句柄  ✗  name: ""
S23 备份走的是用户选定的目录  ✗  handle.getFileHandle is not a function
```

而探针里明明能跑通，因为探针是**页面自己**把句柄写进 IndexedDB 的。
正确做法是把这一步留在页面侧：

```js
// wordbook.js —— 页面自己把句柄写进扩展的 IndexedDB（同一 origin，后台能读到）
const handle = await showDirectoryPicker({ id: 'trace-backup', mode: 'readwrite' });
await saveDirHandleToIDB(handle);                                  // 句柄直接入库
await chrome.runtime.sendMessage({ type: 'backup:set-dir', name: handle.name });  // 只传名字
```

后台的 `backup:set-dir` 因此**只记录名字**用于界面显示，真正的句柄由后台从 IndexedDB
自己取。同理 `backup:clear-dir` 也是页面先删库里的句柄、再通知后台清名字。

其余三个细节：

- **权限会退化**：浏览器重启后 `queryPermission({mode:'readwrite'})` 可能回到 `prompt`，
  此时静默写入会抛错。所以 `backup:get-dir` 会返回 `permission` 字段，界面提示
  「权限已失效，点上方重新选择」，而不是静默失败。
- **恢复要合并不要覆盖**：直接覆盖会丢掉「这次装上新版之后又加的词」。合并规则是
  `reviewCount` 取大、`createdAt` 取小 —— 学习进度不能倒退，加入时间要保留最初那次。
- **测试里造句柄的方式**：`test-backup.js` 用 OPFS（`navigator.storage.getDirectory()`）
  造一个真句柄，再按上面的正确姿势写进 IndexedDB，这样能验证「句柄存库 → SW 写文件」
  整条链路，而不依赖原生选择框（自动化里点不出来）。

实测（`node test-backup.js`，28 项）：

```
S3  备份了 5 个单词
S4  备份文件真的存在于磁盘
S12 恢复保住了复习进度（reviewCount=2）
S13 恢复保住了原始加入时间
S14 重复恢复不会产生重复词条
S15 合并时保留更高的复习次数（不倒退）
S23 备份走的是用户选定的目录（不是下载目录）
S26 重复备份覆盖同一文件（不堆副本）
S27 卸载后能从用户目录里的备份直接恢复
S28 清除目录后自动退回下载目录
RESULT: PASS（生词本写成本机文件 + 卸载重装后可恢复 + 合并保留学习进度）
```

---

### 全局显示：视频不在眼前时，字幕该去哪儿

用户的原始反馈：「为什么我在后台放视频，YouTube 首页也会有时候有翻译字幕」。这不是偶发 bug，
而是**覆盖层的坐标系**出了问题：它贴的是 `#movie_player` 的矩形，而当 YouTube 把播放器缩成
右下角 400×225 的迷你窗（首页后台播放）时，那个矩形仍然「存在且完整可见」，于是字幕照样贴上去，
只是字号被 `--trace-vscale` 按小窗宽度算成十几个像素，飘在首页内容上。

这里有两个独立的问题，分开解决：

**问题一：视频框不在眼前，就不该有字幕。** 判断不能只看 `getBoundingClientRect()` 有没有值 ——
必须区分三种"不在眼前"：

| 情况 | 播放器矩形 | 该不该显示 |
|---|---|---|
| 往下翻到评论区，播放器滚出上半屏 | 存在，但大部分在视口外 | 显示（还在看视频） |
| 滚到完全看不见 | 存在，完全在视口外 | **隐藏** |
| 首页后台播放，缩成右下角迷你窗 | 存在且完整可见，但只有视口一小块 | **隐藏** |

所以判据是「**可见面积 / 播放器面积**」而不是「有没有矩形」：

```js
function frameVisibility() {
  const r = playerRect();
  if (!r) return { visible: false, ratio: 0, rect: null, mini: false };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 迷你播放器：宽高都不到视口一半 —— 完整可见但没法读
  const mini = r.width < vw * 0.5 && r.height < vh * 0.5;
  const visW = Math.min(r.left + r.width, vw) - Math.max(r.left, 0);
  const visH = Math.min(r.top + r.height, vh) - Math.max(r.top, 0);
  if (visW <= 0 || visH <= 0) return { visible: false, ratio: 0, rect: r, mini };
  const ratio = (visW * visH) / (r.width * r.height);
  // 45% 这个阈值是刻意的：翻评论区时播放器常常还露出一半，这时仍算在画面里，
  // 不该突然切成悬浮条 —— 那会让字幕在屏幕上跳来跳去。
  const visible = !mini && ratio >= 0.45 && visW > 80 && visH > 60;
  return { visible, ratio, rect: r, mini };
}
```

**问题二（可选开关）：有些人就是想在浏览首页时继续看字幕。** 于是加了一个
`globalMode` 开关（默认关）。打开后，视频框不在视野里时字幕不隐藏，而是变成一个
**贴屏幕底部的悬浮条**：

```css
#trace-sub-overlay.trace-global .trace-sub-box {
  position: fixed;              /* 覆盖层此刻贴的是整个视口，fixed 与 absolute 视觉等价，
                                   但免掉父级坐标系换算 */
  left: calc((100% - var(--trace-bar-reserve, 0px)) / 2);
  bottom: 6vh;
  max-width: min(86vw, 1100px, calc(100% - var(--trace-bar-reserve, 0px) - 32px));
  background: rgba(20, 20, 23, .82);   /* 比贴视频时更实：它是页面上的部件，不是画面的一部分 */
  backdrop-filter: blur(22px) saturate(150%);
}
#trace-sub-overlay.trace-global .trace-drag-handle { display: none; }
```

#### 三个踩过的坑

1. **悬浮条会横穿右下角的迷你播放器。** 第一版直接 `left: 50%; max-width: 86vw`，
   而迷你窗就在右下角、正好落在悬浮条右半段上 —— 截图里能清楚看到字幕条盖住小窗。
   修法是让 JS 实测播放器占掉多少右侧宽度，写进 `--trace-bar-reserve`：
   ```js
   let barReserve = 0;
   if (bar && vis.mini && vis.rect) {
     const r = vis.rect;
     const inBottom = r.top + r.height / 2 > window.innerHeight * 0.5;
     const onRight  = r.left + r.width / 2 > window.innerWidth * 0.5;
     if (inBottom && onRight) {
       barReserve = Math.min(Math.round(window.innerWidth - r.left + 16),
                             Math.round(window.innerWidth * 0.5));
     }
   }
   ```
   实测：悬浮条右缘 950px，迷你窗左缘 1024px，中间 74px 空隙。

2. **悬浮条模式下必须清掉内联 `top`。** 自由拖动过的话 `boxEl.style.top` 上留着上次在画面里的
   像素值（比如 395px），切到悬浮条后 CSS 的 `bottom: 6vh` 会被内联 `top` 压过，字幕就飘到屏幕中间。
   ```js
   if (state.settings?.freePos && boxEl) {
     if (bar) boxEl.style.top = '';   // 交回 CSS
     else reapplyFreePos();
   }
   ```

3. **测试的固定 profile 会把上一轮的设置带过来。** `launchPersistentContext('.chrome-global')`
   第二轮跑时 `globalMode` 还是上一轮设的 `true`，于是「开关关闭时应当隐藏」这条一上来测的
   是打开状态，直接 FAIL。测试开头必须显式复位：
   ```js
   await setGlobal(false);   // 先把开关关掉，再开始断言
   ```

#### 回归测试（`tools/test-global.js`，8 项）

夹具新增三个钩子来模拟真实场景：`__mockScrollAway()`（播放器挪到视口下方）、
`__mockMini()`（缩成右下角 400×225）、`__mockFrame(null)`（恢复原矩形）。

```
checks: {
  awayHiddenWhenOff: true,      // 开关关 + 滚出视野 → opacity 0 / visibility hidden
  miniHiddenWhenOff: true,      // 开关关 + 迷你播放器 → 同样隐藏（用户报的那个 bug）
  miniFloatingBar:   true,      // 开关开 + 迷你播放器 → fixed 悬浮条贴底部
  barClearOfMiniPlayer: true,   // 悬浮条右缘 950 < 迷你窗左缘 1024
  awayFloatingBar:   true,      // 开关开 + 滚出视野 → 同样走悬浮条
  backToFrame:       true,      // 回到画面里 → 撤销悬浮条，覆盖层 == 140,80,900x506
  toggleOffRestores: true,      // 关掉开关 → 立刻恢复"隐藏"行为
  noDragHandleInBar: true       // 悬浮条上没有拖动手柄
}
RESULT: PASS（全局显示悬浮条 + 离开画面自动隐藏 + 迷你播放器不贴小窗）
```

---

### 让路：字幕压住 YouTube 设置菜单时自动退开

字幕框是覆盖在播放器上的不透明浮层。YouTube 的齿轮菜单从右下角弹出，
长字幕正好压在上面 —— 用户点不到「画质 · 自动 (2160p 4K)」这类选项，
截图里就是这个现象。菜单是 `position:absolute` 的 DOM 元素，和字幕框抢同一块
像素，谁在上谁就吃掉点击。

**做法：检测到重叠就淡出 + 点击穿透，而不是把字幕挪走。**

```js
/** YouTube 自己的交互浮层（设置菜单、画质/倍速菜单、底部控制栏） */
function ytUiRects() {
  const out = [];
  for (const sel of ['.ytp-settings-menu', '.ytp-popup', '.ytp-chrome-bottom']) {
    for (const el of document.querySelectorAll(sel)) {
      const cs = getComputedStyle(el);
      // 自动隐藏控制栏时 YouTube 把 opacity 压到 0，这类不算「挡着」
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      out.push(r);
    }
  }
  return out;
}

/** 字幕框是否真的压住了 YouTube 交互浮层（重叠超过 6px 才算） */
function boxOverlapsYtUi() {
  const b = boxViewportRect();
  if (!b) return false;
  for (const r of ytUiRects()) {
    const w = Math.min(b.right, r.right) - Math.max(b.left, r.left);
    const h = Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top);
    if (w > 6 && h > 6) return true;
  }
  return false;
}
```

```css
#trace-sub-overlay.trace-dodge .trace-sub-box {
  opacity: 0;              /* 0 而不是 0.06，见下 */
  pointer-events: none;    /* 光看不见不够，指针必须直通菜单 */
}
#trace-sub-overlay.trace-dodge .trace-drag-handle {
  opacity: 0; visibility: hidden; pointer-events: none;
}
```

`syncDodge()` 挂在 `tick()` 里（60fps），但有 **120ms 节流**：
`getBoundingClientRect` + `getComputedStyle` 都强制同步布局，
每帧查一遍会拖慢播放器；菜单开合没人能察觉 0.12 秒延迟。

**为什么是淡出而不是挪位置**：菜单的尺寸和位置随内容变化（设置 / 画质 / 倍速
各不相同），挪到哪儿都可能又压住别的东西；淡出则一定能看清菜单，
`pointer-events:none` 让指针直接落到菜单上，点击必定命中。

#### 三个细节

1. **不透明度必须是 0，不能留一点点。** 第一版写 `0.06`，测试量到
   `opacity: 0.06` 就判过了，但截图目视发现字幕文字仍以「残影」浮在菜单
   文字上，像渲染错误。要么看清字幕、要么完全让开，中间态最难看。
2. **必须跳过 YouTube 自己隐藏的浮层。** 自动隐藏控制栏时 YouTube 把
   `.ytp-chrome-bottom` 的 `opacity` 压到 0 而 `display` 仍是 block；
   若只判 `display`，鼠标一动就会被误判成「重叠」而让字幕闪一下。
3. **只在真的重叠时生效。** 菜单开着但字幕被拖到画面上方时不触发，
   否则用户一开菜单字幕就消失，明明什么都没挡住。
4. **拖动进行中绝不让路。** 让路会给字幕框加 `pointer-events: none`，
   而拖拽依赖 pointer capture —— 中途把指针事件掐掉，拖动会卡在半路。
   `syncDodge()` 里显式排除 `trace-dragging` 状态，松手后下一轮（≤120ms）
   若仍重叠才恢复让路。这条是主动加防护时发现的，不是用户报的。

#### 回归实测（`node test-dodge.js`）

测试夹具里加了一个 `.ytp-settings-menu`（右下角 300×260，含「画质」「播放速度」
两个按钮，点击各自计数）与 `__mockMenuOpen(on)`。9 项断言：

```
✓ D1 菜单未开时字幕不让路        {dodge:false, opacity:1, pointer:"auto"}
✓ D2 菜单与字幕确实重叠（前提成立） {overlapW:236, overlapH:126}
✓ D3 重叠时字幕让路（淡出 + 点击穿透）{dodge:true, opacity:0, pointer:"none"}
✓ D4 按钮被字幕盖住时仍能点到      {coversX:true, coversY:true, qualityClicks:1}
✓ D5 菜单关闭后字幕恢复          {dodge:false, opacity:1, pointer:"auto"}
✓ D6 菜单开着但没重叠时不让路      {overlapW:236, overlapH:-380, dodge:false}
✓ D7 无 JS 错误                 {errors:[]}
✓ D8 拖动中菜单弹出不会中断拖动    {midDragDodge:false, beforeTop:556, afterTop:396, movedUp:160}
✓ D9 松手后若仍重叠则恢复让路      {dodge:true}
RESULT: PASS（字幕框让路 YouTube 设置菜单：重叠时淡出可点，不重叠时不受影响）
```

D4 的构造花了两次才写对：第一版直接点按钮，但按钮中心其实在字幕框**外面**
（只重叠了菜单左边缘 66px），点击本来就能命中 —— 这个断言等于没测。
改成先把字幕拖到按钮所在高度、并把「按钮中心落在框内」一起断言，才有判别力。

D8 也做了反向验证：临时删掉 `syncDodge()` 里的 `trace-dragging` 排除项，
D8 立刻 FAIL（`midDragDodge: true`），说明它确实能抓住这个回归。

---

### 查词卡片：从"英英词典截图"改成"中文优先的释义卡"

用户原话（大意）：点了单词想看得更详细，但**里面尽量中文多一些** ——
"我本来就是要看翻译，结果还给我来一堆英文会更加看不懂"。

旧卡片几乎是 `dictionaryapi.dev` 的英英原文照搬：词性 `noun`/`verb` 原样漏出、
释义整段英文、没有中文、没有音标。改造分三件事：

**1. 词性必须译成中文。** 这是最隐蔽的一个 bug —— 早期 `POS_MAP` 只映射了缩写：

```js
const POS_MAP = { n: '名词', v: '动词', adj: '形容词', adv: '副词' };
```

但 `dictionaryapi.dev` 返回的是**全称** `noun` / `verb` / `adjective` / `adverb`，
`POS_MAP['noun']` 是 `undefined`，于是回退成原样输出，用户看到的就是满屏 `noun`。
修法是把全称和缩写一起收进表，并加兜底 `|| m.pos`：

```js
const POS_MAP = {
  n: '名词', noun: '名词',
  v: '动词', verb: '动词',
  adj: '形容词', adjective: '形容词',
  adv: '副词', adverb: '副词',
  prep: '介词', preposition: '介词',
  conj: '连词', conjunction: '连词',
  pron: '代词', pronoun: '代词',
  det: '限定词', determiner: '限定词',
  interj: '感叹词', interjection: '感叹词',
};
```

**2. 释义、例句都要有中文。** `lookupWord()` 里对英文释义和例句各跑一次
Google 翻译，并行发出（`Promise.all`），任何一条失败都不影响其它部分：

```js
const [defsZh, exZh] = await Promise.all([
  defZhOf(meanings),      // 释义逐条翻
  defZhOf(example),       // 例句翻
]);
```

**3. 英文原文折进 `<details>`，默认收起。** 英文不是不要，而是不能当主体。
折叠后卡片可见部分的中文占比从 0.34 提到 **0.65**（`test-dict.js` 的 D8 断言）。
这个占比只统计**可见**文本 —— `<details>` 未展开时其内容仍是 `textContent`
的一部分，直接量会得到虚低的数字，量到的就不是用户真正读到的内容。

#### 卡片结构（从上到下）

| 区块 | 内容 | 为什么在这个位置 |
|---|---|---|
| 标题 | `vintage` + 音标 `/ˈvɪn.tɪdʒ/` | 先确认查的是哪个词 |
| **本句译作「立即」** | 绿色高亮条 | 见下「语境义 vs 词典义」 |
| 单词直译 | 一行小字 | 词典给的最短中文 |
| 中文释义清单 | `副词` + 中文解释，最多 4 条 | 主体内容 |
| 本句译文 | 视频原句 + 其中文 | 把词放回它出现的那句话 |
| 例句 | 词典例句 + 中文 | 补充用法 |
| 英文原文释义 | `<details>` 默认收起 | 需要时再看 |
| 按钮 | `＋ 加入生词本` / `✓ 已在生词本` | 主动作 |

#### 语境义 vs 词典义：用户说"翻译不一样"的真相

用户的第二句抱怨是"会出现翻译不一样的情况"。查下来这是**真实的**，但不是 bug：

```
字幕译文：看。这是正确的年份。      ← Google 按语境翻的
词典直译：优质的                   ← dictionaryapi.dev 的通用义
```

`vintage` 在这里是"年份酒/佳酿"，词典给"优质的"是它的形容词义。两个都对，
只是来源不同。用户看到两个不同的中文，自然会以为翻错了。

真正权威的是**它在这句话里被译成了什么** —— 而这个信息后台已经算过了：
生词在译文里高亮时，`translateAligned` 会返回 `spans[{word, zh, start, end}]`，
`zh` 就是这个词在该句中的译法。所以卡片把它显示在最上面：

```js
const spanZh =
  (state.active?.zhSpans || []).find(
    (s) => String(s?.word || '').toLowerCase() === String(canon).toLowerCase()
  )?.zh || '';
```

**但只在真的不同时才显示。** 实测 8 个词，只有 1 个不同：

| 词 | 词典直译 | 本句译作 | 不同 |
|---|---|---|---|
| vintage | 优质的 | 优质的 | |
| lounge | 休息室 | 休息室 | |
| naturally | 自然 | 自然 | |
| smallest | 最小的 | 最小的 | |
| **immediately** | **立即地** | **立即** | ✓ |
| beverage | 饮料 | 饮料 | |
| pipeline | 管道 | 管道 | |
| happier | 更快乐 | 更快乐 | |

引擎对单个词往往就翻成和词典一样，这时再显示一遍「本句译作 优质的」
反而会让人以为这是**两个不同答案**。所以去重条件是 `spanZh !== dict.zh`：

```js
const ctxWordZh = spanZhRaw && spanZhRaw !== (dict.zh || '') ? spanZhRaw : '';
```

`test-dict.js` 的 D15 断言的是这个**不变式**（要么没有这条，要么它确实与直译不同），
D18 则专门用 `immediately` 验证「真的不同时两条都出现且视觉可区分」。

#### 展开英文释义后盖住字幕

`positionPopup()` 只在初始渲染后调用一次，而 `<details>` 展开会改变卡片高度 ——
卡片向下长出去正好压住字幕，而字幕是用户此刻最需要对照的东西。
修法是监听 `toggle` 事件重新定位：

```js
const more = pop.querySelector('.trace-pop-more');
if (more) {
  more.addEventListener('toggle', () => positionPopup(pop, rect));
}
```

这个问题是**看截图才发现的** —— D12（初始不遮挡）当时是通过的，
但没人展开过 `<details>` 再量一次。补了 D13 断言后才有防护。

#### 回归实测（`node test-dict.js`）

```
✓ D1 字幕里找到并点击了 vintage
✓ D2 卡片打开且标题是 vintage
✓ D3 词性是中文（noun/verb 不能原样漏出）
✓ D4 中文释义至少 2 条                  {count:4}
✓ D5 词典中文释义在（vintage → 优质的之类）{zh:"单词直译：优质的", hasSenses:true}
✓ D6 英文释义存在但默认收起              {hasMore:true, moreOpen:false, enDefsCount:3}
✓ D7 有「本句译文」区块且带中文          {ctxEn:"look. This is proper vintage.", ctxZh:"看。这是正确的年份。"}
✓ D8 可见正文中文占比 > 0.6             {cjkRatio:0.65, cjkRatioAll:0.34}
✓ D9 卡片宽度 340 且不超出视口           {width:340}
✓ D12 卡片不遮挡字幕                    {overlapPx:-8}
✓ D10 展开英文释义后卡片不超出视口        {top:70, bottom:594, vh:860}
✓ D13 展开英文释义后仍不遮挡字幕          {overlapPx:-8}
✓ D11 无 JS 错误                       {errors:[]}
✓ D14 已收藏的词在字幕里高亮且可点
✓ D15 语境义提示只在不同于直译时出现      {ctxWord:"", gloss:"单词直译：优质的", differs:false}
✓ D16 已收藏的词按钮显示「已在生词本」    {btnText:"✓ 已在生词本", btnAct:"remove"}
✓ D17 immediately 已收藏且在字幕里高亮可点
✓ D18 语境义与直译不同时，两条都显示且能区分 {ctxWord:"本句译作「立即」", gloss:"单词直译：立即地"}
RESULT: PASS（查词卡片：词性中文 + 中文释义 + 本句译文 + 英文默认收起）
```

D8 的 `cjkRatio:0.65` 与 `cjkRatioAll:0.34` 之差就是折叠英文释义的效果 ——
如果不折叠，用户面对的是三分之一中文、三分之二英文的卡片。

---

### 短语划词：选中 `pay your fair`，别给我「支付你的公平的」

**需求**：选中多个词（短语/习语）时给整段释义，并且能作为「短语」条目进生词本；
选中其中单个词仍走原来的单词卡。

**核心矛盾**：免费机器翻译对习语基本无能为力。实测结论：

| 短语 | Google 整体译文 | 逐词拼接 | 是否可用 |
|---|---|---|---|
| pay your fair | 支付你的公平 | 支付你的公平的 | ✗ 逐词拼接 |
| walk up | 走上来 | 走上来 | ✗ |
| put on | 穿上 | 穿上 | ✓ 恰好对 |
| give up | 放弃 | 放弃 | ✓ |
| look forward to | 期待 | 期待 | ✓ |
| take care of | 照顾 | 照顾 | ✓ |

十二组里约一半习语恰好被词典收录所以正确，另一半纯逐词拼接。
所以**不能承诺「短语一定译对」**，能做的是：译不准时明确告诉用户。

**三级降级（`bg.js` 的 `lookupPhrase()`）**：

1. **Tier A — 大模型**（配置了 LLM 才走）：把整句上下文 + 选中短语一起送过去，
   要求返回「短语在此句中的意思 + 逐词对照 + 是否可能是字幕误听」。
   这是唯一能真正理解习语的路径。
2. **Tier B — Google 短语整体翻译**：一次请求整段，比逐词好但常常还是拼接。
3. **Tier C — 逐词直译**：前两级都失败时兜底。

**`looksLiteral()` —— 判断「整段译文是不是逐词拼的」**

第一版用严格相等比较，永远不触发：
```
整体译文：支付你的公平
逐词拼接：支付你的公平的     ← fair 作形容词多一个「的」
```
严格比较不等，警示就永不出现 —— 而那正是最该提示的情况。改成先去掉虚词助词标点再比：

```js
function looksLiteral(whole, literal) {
  const norm = (s) =>
    String(s || '')
      .replace(/[\s\u3000]/g, '')
      // 中文虚词/助词/量词：它们最容易在两种翻法里增减，不构成"意思不同"
      .replace(/[的了着过地得吗呢吧啊呀哦嘛]/g, '')
      .replace(/[，。、；：！？,.!?;:'"「」『』()（）]/g, '');
  const a = norm(whole);
  const b = norm(literal);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.includes(short) && long.length - short.length <= 4;
}
```

**卡片设计：先警示，再降级显示**

命中 `looksLiteral()` 时：
- 顶部插入橙色警示条「这句是按词拼出来的，可能不是它在这里的真正意思」；
- 释义从红色 19px 降级成灰色 15px（`.is-weak`）—— 它不配当主角。

**整段高亮**：字幕里 `pay your fair` 三个词包在一个 `.trace-phrase` 里，
点其中任何一个词都打开短语卡（不是单词卡）。判定靠 `data-p` 属性记短语原文。

**生词本区分**：短语条目 `isPhrase: true`，看板侧栏与筛选行都有「短语」入口，
行首用引号徽标 `❝` 而不是首字母圆形，来源标签显示「大模型」或「机器翻译」。

**短语卡的定位坑（测试没抓到，看截图才发现）**

短语卡比单词卡高一大截（375px vs 250px），旧 `positionPopup()` 只按「词的上面」摆，
结果直接压住字幕条。当时的测试只断言卡片内容，**没有任何一条断言卡片和字幕的位置关系**。
修复：先算字幕框上下各剩多少空间，放得下就完全不碰字幕，放不下才收紧卡片高度
（`body.style.maxHeight = Math.min(hardMax, availH)`）。同时补上断言：

```
✓ L10b 短语卡不遮挡字幕框 {"pop":[286,252,340,375],"box":[270,635,741,103],"overlapPx":-8}
✓ L10c 短语卡在视口内    {"insideViewport":true,"bodyScrollable":false}
```

**修复过程中引入又修掉的 bug**：把 `!boxRect` 的兜底分支从函数末尾提到判断链最前面时，
漏了同时删除末尾那行重复的兜底赋值，导致 `boxRect` 为 null 时仍然执行
`boxRect.top` → `TypeError` → 整个卡片不渲染（L7–L10c 全 FAIL）。教训是
**移动分支时要连带删掉旧位置的那份**。

---

### 大模型引擎：第三种翻译选择

**动机**：Google 免费端点对习语、上下文、口语基本无解（见上表）。
接一个 OpenAI 兼容的 `/chat/completions` 端点，让用户自己填 API，译文质量可以跨一个档次。

**配置项（`DEFAULT_SETTINGS`）**：`llmBaseUrl` / `llmApiKey` / `llmModel` /
`llmTemperature` / `llmUseForSubtitles`（是否也用于字幕批量翻译）。

**`llmChat(messages, opts)`**：标准 `/chat/completions` POST，
`Authorization: Bearer <key>`，返回 `choices[0].message.content`。

**`llmTranslateAll(texts, source, target)`**：一次请求翻一批字幕，
用编号前缀 `1. ... 2. ...` 保证行对齐，返回后按行号切回。
失败（网络/配额/格式不符）时抛错，由 `translateBatch()` 捕获并**自动降级回 Google** ——
大模型不可用不能导致整屏没译文。

**`lookupPhrase()` 的 Tier A**：带上下文的一次性释义请求，要求返回结构化 JSON。
实测（假模型）能拿到「付钱」而不是「支付你的公平」。

**权限**：`llmBaseUrl` 可以是任意域名，无法在 `manifest.json` 里静态声明。
用 `optional_host_permissions: ["<all_urls>"]` + 运行时 `chrome.permissions.request()`
在用户保存配置时申请。测试里通过 `chrome.permissions.contains()` 验证过。

**`test-phrase.js` 的三条大模型断言**（用 `ctx.route()` 伪造 `/chat/completions`）：

```
✓ L17 能拉取模型列表 {"ok":true,"data":["fake-1","fake-2"]}
✓ L18 大模型引擎能翻出译文 ["现在就支付你的公平。","祝你今天过得愉快。"]
✓ L19 请求里带了模型名与 system 提示 {"model":"fake-1","n":2}
✓ L20 大模型失败时自动降级（仍有译文） {"hits":1,"out":["这里有一些全新的东西。"]}
```

L20 是这里最重要的一条：让伪造端点返回 500，断言仍有译文 ——
证明降级链真的接上了，而不是"配了大模型就再也翻不出来"。

---

## 三、安装与使用

### 加载扩展

1. Chrome 打开 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `D:\MyFiles\项目\Trace\trace-subtitles`
4. 打开任意 YouTube 视频，字幕会自动出现

### 功能

- **双语字幕**：原文 + 译文双层，随播放高亮推进
- **长句自动折行**：单句超过 120 字符会在逗号处断成多段，每段一行；框高因此稳定在两行左右，
  不再出现"一屏字幕吃掉四分之一画面"。字号调到极大时还有自适应缩小兜底
- **字幕贴视频画面**（不是贴浏览器窗口）：非全屏时精确落在播放器矩形内，影院模式 / 顶栏折叠 /
  改窗口大小都跟着走；**全屏时按画面宽度等比放大字号与行宽**，退出全屏又等比缩回
- **离开画面就不显示**：视频框滚出视野（翻评论区）或缩成右下角迷你播放器（首页后台播放）时，
  字幕整条隐藏 —— 不会再有"在首页浏览时还有字幕飘在内容上"的情况
- **全局显示（可选开关）**：打开后，视频框不在视野里时字幕改成一个贴屏幕底部的悬浮条
  （更小更实、不挡内容、没有拖动手柄）；迷你播放器在右下角时悬浮条自动让开那个小窗
- **不挡 YouTube 自己的菜单**：字幕框压住齿轮菜单（画质 / 倍速）或控制栏时自动淡出并
  让出点击，菜单关掉又恢复 —— 不会出现"想调清晰度却点不到"的情况
- **显示模式**：双语 / 仅译文 / 仅原文
- **目标语言**：简体中文、繁体中文、日、韩、英、法、德、西、俄、葡（10 种）
- **翻译引擎**：Google（推荐，快）/ MyMemory（备用）/ 大模型（自带 OpenAI 兼容 API，
  习语与上下文翻得明显更准；不可用时自动降级回 Google）
- **字号、字幕位置**：popup 或**页内面板**里实时调
- **毛玻璃字幕框**：深色半透明底 + `backdrop-filter: blur(18px)`，透出画面纹理而不是死黑板
- **播放器右下角悬浮按钮**：一个渐变紫的「T」方块贴在播放器右下角内侧，点击弹出**页内设置面板**
  （全屏、网页全屏、改窗口大小都会跟着贴边；可在面板里关掉）
- **页内设置面板**：深色侧栏，结构对齐 Trancy 的「Trancy 字幕」菜单 —— 启用开关、主字幕语言、
  翻译字幕语言、翻译引擎、字幕显示模式，加上可折叠的「字幕样式」与「更多功能」分组
- **字幕样式实时调节**：原文字号 / 译文字号 / 原文颜色 / 译文颜色 / 背景不透明度 / 圆角 /
  高斯模糊 / 整体缩放，8 项全部即时生效并持久化
- **上下拖动（横向锁死居中）**：鼠标移到字幕框上，顶部浮出黑色胶囊（3 个白点）→ 按住即可
  **上下移动**；横向不响应拖动，字幕永远水平居中于画面。
  这样设计的理由：字幕框宽度随句子长短变化，允许横向拖动会让"居中"失去保证，每换一句
  都得重新摆；只放开纵向既够用又稳定 —— 与 Trancy 的行为一致。
  **不碰字幕时手柄完全不显示**（`opacity:0` + `visibility:hidden` + `pointer-events:none`），
  移开鼠标后约 0.5s 淡出，绝不干扰画面；
  位置自动记住（只记纵向比例），换视频/刷新/全屏/改窗口大小都保持；
  面板或 popup 里「恢复居中」可回到默认底部位置
- **点击查词**：点字幕里任意单词 → 音标 + 中文词性 + 中文释义 + 本句译文 +
  折叠的英文原文释义（默认收起，因为要的是中文）
- **短语划词**：选中 `pay your fair` 这类多个词时，点其中任意一个词打开**短语卡** ——
  整段释义 + 逐词对照 + 误听提示；整段在字幕里作为一个整体高亮。
  机器翻译只是逐词拼接时会显式警示「这句是按词拼出来的」，而不是假装准确
- **短语生词本**：短语作为独立条目收藏，看板里用引号徽标与「短语」分类区分，不与单词混在一起
- **生词本**：一键加入，记录单词/释义/**所在句子与译文**/视频标题/时间点，可搜索、删除、
  导出 JSON，点击条目跳回原视频那一秒
- **生词本落盘**：可指定本机任意文件夹作为备份目录，加词/删词/复习后自动覆盖写
  `trace-vocab-backup.json`（不堆副本）；**卸载扩展重装后点「恢复」即可找回全部单词**，
  合并时保留更高的复习次数与最早的加入时间。没选目录时退化为下载到「下载」文件夹
- **词库看板**（独立页面）：KPI 概览、学习状态环、每日新增柱状图（日/周/月）、状态筛选、
  搜索、单词抽屉（所在句子 + 跳回视频）、复习与删除 —— 数据全在本机，离线可用
- **生词高亮（跨视频生效）**：任何已加入生词本的单词，在**所有** YouTube 视频的字幕里都会
  自动高亮（黄色底色 + 下划线），不需要重新加入
- **词形变化一并高亮**：收藏 `beverage` 之后，字幕里的 `beverages` 也高亮，点它打开的还是
  `beverage` 那张词卡（单复数、-ed/-ing、比较级、不规则复数都覆盖；不猜不规则动词）
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
node test-center.js          # 拖动行为：横向锁死居中 + 纵向可拖 + 换句不漂移
node test-ui.js              # 手柄悬停显隐 + 悬浮按钮 + 页内面板 + 字幕样式，截图 shot-ui*.png
node test-zh-highlight.js    # 译文里对应中文也高亮（多词 / 点击 / 移除），截图 shot-zh-highlight.png
node test-wordbook.js        # 词库看板：KPI/状态环/柱状图/筛选/搜索/抽屉/复习/删除/粒度切换
node test-frame.js           # 字幕贴视频框 + 全屏等比放大 + 退全屏缩回，截图 shot-frame-*.png
node test-settings.js        # MyMemory 额度降级 + 引擎切换缓存 + 免点插件自动出字幕
node test-forms.js           # 词形归一化：收藏 beverage 也高亮 beverages，点复数开同一词条
node test-backup.js          # 生词本写本机文件 + 卸载重装后恢复 + 合并保留学习进度
node test-global.js          # 全局显示悬浮条 + 离开画面自动隐藏 + 迷你播放器不贴小窗
node test-dodge.js           # 字幕压住 YouTube 设置菜单时让路（淡出 + 点击穿透）
node test-dict.js            # 查词卡片中文优先（词性中文 + 释义中文化 + 语境义）
node test-phrase.js          # 短语整段释义 + 短语生词本 + 大模型引擎与降级
node run-all.js              # 一次跑完以上全部，末尾输出 PASS/FAIL 汇总
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
segmentation: { rows: 13, sentences: 6 }
word popup:   { word:"So", zh:"所以", hasAddBtn:true }
add button:   "✓ 已在生词本"   (btnAct: remove)
wordbook:     [{ word:"so", zh:"所以", context:"So today we are going to talk about…",
                 videoId:"TESTID00001", time:0 }]
highlight:    { found:true, hasSavedClass:true, savedCount:1 }
reopen popup: { btnText:"✓ 已在生词本", btnAct:"remove" }
checks:       subs=true seg=6 highlight=true reopen=true
RESULT: PASS
```

pot 模式回归：

```
[Trace] 已加载 13 行字幕 → 6 句（English，来源 hook）
timedtext hits: [{ hasPot: true, pot: "MOCK_POT_TOKEN" }]
RESULT: PASS (网络钩子成功绕过 pot 限制)
```

拖动行为回归（横向锁死居中 + 纵向可拖 + 换句不漂移）：

```
viewportCenter: 640
centerBefore: 640   centerAfterHorizontalDrag: 640   horizontalDrift: 0   horizontalLocked: true
topBefore: 635      topAfterDragDown: 695            movedDownPx: 60      verticalWorks: true
topAfterDragUp: 29  wentUp: true                     clampedTop: true
shortWidth: 762     longWidth: 1232
shortCenter: 640    longCenter: 640                  sentenceDrift: 0     topDrift: 0
RESULT: PASS（横向锁死居中 + 纵向可拖且不越界 + 换句不漂移）
```

测试里把指针往右拖了 500px，框中心纹丝不动（640 → 640）；同时下移 60px 则正常生效。
这直接证明了"横向锁死、纵向放开"这条约束。

> 早期版本允许横向拖动，靠 `clampCenterX()` 把中心点夹在视口内。那套逻辑能保证
> "长短句不左右跳"，但用户仍要自己摆位置，而且框一换句宽度就变、夹紧值也跟着变。
> 改成横向锁死后，`clampCenterX()` 整个函数都被删掉了 —— 不需要再夹，因为横向
> 根本不由 JS 控制，永远是 CSS 的 `left:50%` + `translateX(-50%)`。

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
│  ├─ subtitles.js              解析 + 智能分句 + 超长句切分 + 词形归一化
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
   ├─ test-center.js            拖动行为回归（横向锁死居中 + 纵向可拖）
   ├─ test-ui.js                手柄显隐 + 悬浮按钮 + 页内面板 + 字幕样式回归测试
   ├─ test-zh-highlight.js      译文里对应中文高亮回归测试（多词/点击/移除）
   ├─ test-wordbook.js          词库看板回归测试（KPI/图表/筛选/抽屉/复习）
   ├─ test-frame.js             字幕贴视频框 + 全屏等比放大回归测试
   ├─ test-forms.js             词形归一化回归（单复数同高亮 + 两份实现一致性）
   ├─ test-backup.js            生词本落盘回归（写文件/卸载恢复/合并进度/自选目录）
   ├─ test-global.js            全局显示悬浮条 + 离开画面隐藏 + 迷你播放器避让
   ├─ test-dodge.js             字幕压住设置菜单时让路（淡出 + 点击穿透）
├─ test-dict.js              查词卡片中文优先（词性中文 + 释义中文化 + 语境义）
├─ test-phrase.js            短语整段释义 + 短语生词本 + 大模型引擎与降级
├─ run-all.js                一次跑完全部回归，输出汇总表
├─ shot-dict.png             查词卡片：本句译作「立即」与单词直译「立即地」并存
├─ shot-phrase.png           短语卡：警示条 + 降级释义 + 逐词对照
├─ shot-phrase-board.png     词库看板的短语视图与短语抽屉
   ├─ probe-ext2\               主世界 vs 隔离世界对照实验
   ├─ probe-transcript.js       get_transcript 接口探针
   ├─ gen-icons.js              纯 Node 生成 PNG 图标
   ├─ shot-mock.png             验证截图（高亮 + 查词卡）
   ├─ shot-pot.png              pot 模式验证截图
   ├─ shot-center.png           拖动后居中验证截图
   ├─ shot-ui.png               悬浮按钮 + 放大字号截图
   ├─ shot-ui-panel.png         页内设置面板展开截图
   ├─ shot-zh-highlight.png     译文中文高亮截图
   ├─ shot-wordbook.png         词库看板截图
   ├─ shot-wordbook-drawer.png  词库看板单词抽屉截图
   ├─ shot-frame-normal.png     非全屏：字幕落在视频画面内
   ├─ shot-frame-fullscreen.png 全屏：字幕随画面等比放大
   ├─ shot-glass.png            毛玻璃 + 3 点拖动胶囊截图
   ├─ shot-forms.png            复数形式高亮 + 单数词卡截图
   ├─ shot-global.png           全局显示悬浮条（避开右下角迷你播放器）截图
   ├─ shot-dodge.png            菜单开着但字幕已挪开：不让路，字幕清晰
   ├─ shot-dodge-overlap.png    字幕压住菜单：完全淡出，菜单可读可点
   ├─ test-settings.js          MyMemory 降级 / 引擎切换缓存 / 自动出字幕回归
   ├─ shot-settings.png         自动出字幕截图（未点插件）
   ├─ shot-backup.png           词库页备份区截图（选目录 + 自动备份开关）
   └─ (以上测试每次跑完自动生成对应截图)
```

## 五、与 Trancy 的差距

复刻的是**核心链路**，以下能力未实现（都属于 Trancy 的商业化部分）：

- 多平台支持（Netflix / HBO / Disney+ / Prime / Bilibili 等各自的抓取 hook）
- Whisper 语音转写（无字幕视频）
- 服务端 NLP 分句（本实现用本地启发式替代，长句/跨句指代不如服务端）
- 语法分析、TTS 发音、跟读发音评测
- 网页全文沉浸翻译、划词翻译、阅读模式
- 云端账号同步
