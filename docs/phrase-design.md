# 短语划词释义 + 短语生词本 —— 设计方案

> 状态：**设计待确认**（按用户要求，本轮不落代码）
> 依据：两张截图 + 对现有代码的核对 + 一组真实接口实测（结论见 §0）

---

## 0. 先说实测结论：这一步改变了设计

在动手设计前，我把两个截图里的短语和 10 个常见习语真的送进接口跑了一遍。结果决定了方案该怎么做：

### 0.1 截图里的 "pay your fair" 其实是个拼写错误

| 输入 | Google 译文 |
|---|---|
| `fair` | 公平的 |
| `fare` | 票价 |
| `pay your fair` | **支付你的公平** |
| `pay your fare` | 支付车费 |

字幕原文是 `So you walk up, pay your fair, go up`，中文却是「付钱」。原因是 **YouTube 自动字幕把 `fare`（车费）听成了 `fair`（公平）**。所以"fair 在短语里不是公平的意思"这个判断是对的，但**根因不是词义随上下文变化，而是字幕本身就错了一个词**。

这带来一个设计上的硬约束：**任何只查 "fair" 的词典都会给出"公平的"，这是正确行为**。要得到"付钱"，必须知道两件事之一：① 这是 `fare`；② 这一句讲的是进门付费。

### 0.2 短语单独翻译，习语准确率约 50%

实测 10 个常见习语（Google `client=gtx`）：

| 短语 | 译文 | 判定 |
|---|---|---|
| give it a shot | 试一试 | ✅ |
| piece of cake | 小菜一碟 | ✅ |
| cut corners | 偷工减料 | ✅ |
| once in a blue moon | 千载难逢 | ✅ |
| take it easy | 别紧张 | ⚠️ 可接受（语境可作"放轻松"） |
| break a leg | 打断一条腿 | ❌ 应为"祝好运" |
| on the fence | 在栅栏上 | ❌ 应为"犹豫不决" |
| hit the sack | 解雇 | ❌ 应为"睡觉" |
| under the weather | 天气不好 | ❌ 应为"身体不适" |
| pull someone's leg | 拉某人的腿 | ❌ 应为"开玩笑" |

**结论：纯机器翻译不能作为短语释义的唯一来源。** 设计必须让用户看得见来源与置信度，并提供更强的一档。

### 0.3 三种"从上下文提取短语义"的尝试，只有一种部分有效

| 方法 | 结果 |
|---|---|
| 把短语用哨兵包起来送翻译（复用现有对齐机制） | ❌ 被**字面翻译**：`⟦0⟧pay your fair⟦1⟧` → 「⟦0⟧支付你的公平⟦1⟧」，反而更差 |
| 挖空短语再和整句译文做前后缀比对（diff） | ❌ Google 挖空后会**整句重写**，前后缀锚点全部消失（7 个用例中仅 1 个成功） |
| 用 `dt=bd`（词典模式）请求短语 | ❌ 对短语只返回普通译文，没有词典条目 |
| 把整句（含 1930 年那句上文）送翻译 | ✅ **得到了"付钱"** —— 但整句里挖不出短语对应的那一段 |

**只有"带完整上下文"这一条路能得出正确语义，而它无法定位到短语对应的字面片段。** 这正是需要大模型的地方。

### 0.4 所以：释义来源必须分档，且默认档要诚实

结合用户在对话中提出的「用自己的中转站 API + 选一个模型来翻译」，这恰好是解决 §0.2/§0.3 的正解。方案定为三档（详见 §3）。

---

## 1. 交互流程（从划词到入库）

### 1.1 主流程

```
用户在字幕上拖选一段文字
        ↓
mouseup 事件 → 读 window.getSelection().toString()
        ↓
归一化（见 §5 边界表）：折叠空白、去首尾标点、统一弯引号
        ↓
判定：词数 = 1 且无空格  →  【单词流程】（现状，完全不变）
      词数 2..6           →  【短语流程】
      词数 > 6 或长度 > 80 →  【超长提示】不查询，提示"选中内容过长，请选一段短语"
        ↓
短语流程：弹出结果卡片（先显示"查询中…"骨架）
        ↓
并行发起：
  ① 整体释义（按 §3 分档）
  ② 逐词对照（复用现有 lookupWord，每个词一条）
        ↓
卡片渲染（见 §4.1）
        ↓
用户点「＋ 加入生词本」
        ↓
bg.js addWord({ kind:'phrase', ... })
        ↓
IndexedDB words 表新增一条 kind='phrase' 记录
        ↓
broadcastWordsChanged() → 所有 YouTube 标签页重新拉词表
        ↓
字幕里该短语以整体高亮形式出现（见 §4.4）
        ↓
生词本看板 / popup 中出现于「短语」分类
```

### 1.2 与现有单词流程的关系

**关键：单词流程一行都不改。** 现有 `onWordClick` 是"点击单词"触发；短语流程是"选中文字"触发。两者是并列入口，不是替换关系：

- 单击单词 → 现有卡片（音标 + 词性 + 中文释义 + 例句）→ `kind:'word'`
- 拖选短语 → 新卡片（整体释义 + 逐词对照）→ `kind:'phrase'`

用户选中的内容若恰好是一个单词，**仍走单词流程**，保证"选中 fair 显示公平的"这条验收标准成立。

### 1.3 用户可手动修正释义

短语释义天然不可靠（§0.2），所以卡片上的释义**必须可编辑**：双击释义文字 → 变输入框 → 失焦保存。用户自己写「付钱」比任何自动结果都准。这条是刚需，不是锦上添花。

---

## 2. 数据结构定义

### 2.1 现有结构（已核对 `bg.js:77-106`、`bg.js:1020-1045`）

```js
DB_NAME = 'trace-subs';  DB_VER = 2;
// objectStore 'words', keyPath 'word'
{
  word: 'beverage',        // 小写归一化，同时是主键
  display: 'beverage',
  phonetic: '', zh: '饮料', meanings: [], example: '',
  context: '…serve you beverages…', contextZh: '…为你提供饮料…',
  videoTitle, videoId, time,
  createdAt, reviewCount, lastReview, status: 'new'|'learning'|'learned'
}
```

### 2.2 扩展方案：同表加 `kind` 字段，**不新建 store**

```js
{
  // —— 新增字段 ——
  kind: 'phrase',          // 'word' | 'phrase'；老记录缺省视为 'word'
  literal: '支付你的公平',   // 逐词直译（短语专有），用于对照
  source: 'llm',           // 'llm' | 'google' | 'manual' —— 释义来源，决定卡片标注
  note: '',                // 备注，如"字幕可能把 fare 听成 fair"

  // —— 沿用字段 ——
  word: 'pay your fair',   // 短语小写 + 空白折叠后作为主键
  display: 'pay your fair',
  zh: '付钱',               // 短语整体释义就放这里，与单词语义一致
  phonetic: '',            // 短语为空
  meanings: [], example: '',
  context: '…you walk up, pay your fair, go up', contextZh: '…付钱…',
  createdAt, reviewCount, lastReview, status
}
```

**为什么复用同一张表而不是新建 `phrases` store：**

1. **去重天然生效** —— 主键 `word` 已做小写归一化，短语含空格、单词不含，两者不会撞主键；同一短语重复添加自然走 `existing` 分支（保留 `createdAt`、累加 `reviewCount`）。
2. **备份/恢复/复习/删除/导出全部零改动** —— 现有 `listWords` / `wordKeys` / `hasWord` / `removeWord` / `reviewWord` / `buildBackup` / `restoreFromBackup` 都是按 store 整体读写的，加了字段自动带上。
3. **`wordKeys()` 的返回值会混入短语**，这会让现有 `renderWords()` 尝试把短语当单词高亮 —— **这是唯一必须同步处理的地方**，见 §4.4。

**升级路径**：`DB_VER` 保持 2（不加索引、不建 store，不需要 upgrade）。老记录读出来 `kind` 为 `undefined`，所有读取处统一写 `(rec.kind || 'word')`，因此**无需数据迁移**。

### 2.3 设置项新增（`DEFAULT_SETTINGS`）

```js
// 短语/查词专用的大模型（不用于整篇字幕翻译，理由见 §3.3）
llmEnabled: false,
llmBaseUrl: '',        // 例如 https://api.xxx.com/v1
llmApiKey: '',         // 明文存 chrome.storage.local，界面需标注
llmModel: '',          // 从 /v1/models 拉取后选择
llmTimeoutMs: 12000,
```

---

## 3. 短语释义的三档来源

### 3.1 分层与降级顺序

```
Tier A  用户配置的大模型（llmEnabled && llmBaseUrl && llmModel）
          ↓ 未配置 / 失败 / 超时
Tier B  Google 短语整体翻译（免费、快、习语约 50% 准）
          ↓ 失败
Tier C  逐词直译拼接（永远可用，兜底）
```

卡片上**必须标注来源**：`大模型` / `机器翻译` / `逐词直译`，并用不同颜色的小标签。用户在 §0.2 里看到的那种错误，只有标了来源才不会误以为是权威释义。

### 3.2 Tier A：大模型调用设计

- 接口：OpenAI 兼容 `POST {llmBaseUrl}/chat/completions`
- 认证：`Authorization: Bearer {llmApiKey}`
- 请求体：

```json
{
  "model": "<llmModel>",
  "messages": [
    { "role": "system", "content": "你是英语学习助手。用户给出一段英文字幕和其中一个短语，请给出该短语在当前语境中的中文释义。只输出 JSON，不要解释。" },
    { "role": "user", "content": "字幕：So you walk up, pay your fair, go up\n短语：pay your fair" }
  ],
  "response_format": { "type": "json_object" },
  "temperature": 0.2
}
```

- 期望返回：

```json
{ "gloss": "付钱", "literal": "支付你的公平", "note": "字幕可能把 fare 误听为 fair" }
```

- **必须做 JSON 解析容错**：模型可能带 ```json 围栏、可能少字段。解析失败时把整个回复文本当 `gloss`（不丢弃），并标 `source:'llm'`。
- **必须做超时**（复用现有 `fetchT(url, init, ms)`，默认 12s）—— 现有代码里 `dictionaryapi.dev` 对某些词永久挂起的教训（README 已记录）在这里同样适用。
- **`host_permissions` 问题**：用户填的域名无法预知。两种做法：
  - 推荐：`optional_host_permissions: ["https://*/*"]`，在设置里点"测试连接"时 `chrome.permissions.request({origins:[...]})` 动态申请；
  - 次选：manifest 里写死 `https://*/*`（会在安装时提示"读取所有网站数据"，体验差）。
- **获取模型列表**：`GET {llmBaseUrl}/models`，解析 `data[].id` 填充下拉框。

### 3.3 为什么大模型**只用于查词，不用于整篇字幕翻译**（重要）

现有字幕翻译是**批量**的（一次 25 句，`translateChunk`），一条 20 分钟视频几百句：

| 维度 | Google 批量 | 大模型批量 |
|---|---|---|
| 延迟 | 一次请求 25 句，~1s | 25 句要 25 次请求或一次长 prompt，~30s+ |
| 成本 | 免费 | 按 token 计费，长视频成本显著 |
| 稳定性 | 高 | 需处理限流/重试/超时 |
| 收益 | 字幕译文可读 | 略好，但字幕是"跟读"场景，不需要精雕 |

而查词是**单次、按需、用户主动触发**的：一次一条短语，延迟 2s 可接受，成本可忽略，收益（习语正确率 50% → 90%+）极大。**同一个 key 用在两个场景性价比完全不同**，所以设置里要把这一点写清楚，避免用户误以为切了模型整篇字幕会变好。

---

## 4. UI 改动点

### 4.1 划词结果卡片（`content.js` 新增 `onSelectionLookup`）

短语卡片结构（与现有单词卡片并列，复用 `.trace-pop-*` 样式）：

```
┌────────────────────────────────────────┐
│ pay your fair                    [×]   │
│ 机器翻译 · 建议人工确认                  │  ← 来源标签（颜色区分）
├────────────────────────────────────────┤
│ 整体释义                                │
│ 支付你的公平                    （双击改）│  ← 大字，可编辑
├────────────────────────────────────────┤
│ 逐词对照                                │
│ pay     支付                           │
│ your    你的                           │
│ fair    公平的                          │
├────────────────────────────────────────┤
│ 出现语境                                │
│ So you walk up, pay your fair, go up    │
│ 所以你走上去，付钱，然后上去              │  ← 用字幕译文，能看出差异
├────────────────────────────────────────┤
│ [＋ 加入生词本]（短语）                  │
└────────────────────────────────────────┘
```

三个设计要点：

1. **整体释义在上、逐词对照在下** —— 用户要的是"这段什么意思"，逐词只是辅助理解结构。反过来会让人先读一堆碎片。
2. **必须显示字幕原文的中文译文**（"出现语境"块）—— §0.1 那个案例里，用户正是靠「付钱 vs 支付你的公平」的差异才发现问题。把字幕译文摆出来，差异自己会暴露。
3. **来源标签 + 可编辑** —— 承认不可靠，并给出修正手段。

### 4.1.1 查空时的卡片：空结果不再被永久缓存

这条来自一个真实报障：「为什么这两个单词单独点击没有解释意思，两个一起查才有翻译意思」。截图里单点 `chill` / `secluded`，卡片只有标题 + 「本句译文」+ 收藏按钮，中间**完全空白**，既没有释义也没有任何提示；而把两个词一起拖选，短语卡却有「寒冷僻静」的整体译和逐词对照。

**根因不在渲染，在缓存。** `lookupWord()` 拿到结果后是无条件 `idbPut` 的，包括「词典源全挂」时返回的那个空壳结构（`meanings: []`、`phonetic: ''`、`source: ''`）；而读取侧 `if (cached && cached.dict) return cached.dict` 命中即返回，**既不看新鲜度，也不看空不空**。于是某个词只要在第一次点击时恰好赶上网络/代理抖一下，它就被永久钉成空卡，重装扩展之前都不会恢复。短语路径 `lookupPhrase()` 的 `if (!result.gloss) return null;` 写在 `idbPut` 之前，空结果不落盘 —— 这正是「单词空、短语正常」这个诡异不对称的来源。

复现实验（`tools/probe-poison.js`）：正常加载 → 断掉 Datamuse / dictionaryapi / Google 三个域 → 查 `chill` 得到 `{meanings:0, phonetic:"", source:""}` → 恢复网络 → 再查，**逐字节相同**；手动删缓存键后立刻恢复成 `{phonetic:"CH IH1 L", meanings:6, source:"datamuse"}`。

四处改动：

| 位置 | 改动 | 作用 |
|---|---|---|
| `bg.js` `lookupWord()` | 缓存键 `dict3\|` → `dict4\|` | 让历史上被钉死的空卡一次性失效，不用用户手动清缓存 |
| `bg.js` `lookupWord()` | 新增 `dictIsEmpty()` + `DICT_PARTIAL_TTL = 5 * 60 * 1000`；非 `force` 时，空结果只在 5 分钟内算「新鲜」 | 空结果不再是永久的：短暂网络故障仍走缓存避免连打，过期自动重查 |
| `bg.js` 消息路由 `case 'dict'` | 透传 `{ force: !!msg.force }` | 给 UI 一个「跳过缓存、直连网络」的入口 |
| `content.js` 卡片 | 无 senses 且无 `zh` 时渲染 `.trace-pop-miss`（标题 + 一句为什么 + `↻ 重新查询`） | 用户看到的是「没查到，可以重试」而不是一片空白 |

重试按钮走 `data-act="retry"` → `openWordCard(word, rect, true)`，用存下来的 `state.wordPopup.retryRect` 原地重绘，卡片不跳位置。

**顺带修掉一个会让重试直接失效的坑**：document 级「点卡片外面就关闭」的处理器只看 `popupEl.contains(e.target)`，而重查会把卡片 `innerHTML` 整个重建 —— 事件冒泡到 document 时，`e.target`（原来那个按钮）已经脱离文档，`contains` 返回 false，卡片被判成「点了外面」立刻关闭，表现为「点重新查询后卡片消失」。加一句 `if (!e.target.isConnected) return;` 即可。

回归覆盖（`tools/test-dict.js` D19–D23）：D19 断四域时返回空结果、D20 空结果在 TTL 内仍走缓存、D21 把 `createdAt` 改老 6 分钟后自动重查并恢复 6 条释义、D22 `force:true` 直连网络、D23 完整条目照常走缓存。断域时必须**同时**断掉 `translate.googleapis.com` 和 `clients5.google.com` —— 只断前者的话 `dict.zh` 仍会由第三档 plan 填上，`dictIsEmpty` 为 false，测试会假绿。

UI 侧另有一支探针 `tools/probe-miss.js`：断网 → 点词 → 断言 `.trace-pop-miss` 出现且 `.trace-pop-senses li` 为 0 → 恢复网络 → 点重试 → 断言提示块消失、释义恢复到 6 条，产出 `tools/shots/popup-miss.png` 与 `popup-recovered.png`。

### 4.2 加入生词本按钮

- 短语模式按钮文案改为 `＋ 加入生词本（短语）`，与单词的 `＋ 加入生词本` 区分。
- 提交 `payload.kind = 'phrase'`，并带上 `literal` / `source` / `note` / `context` / `contextZh`。
- 已存在时显示 `✓ 已在生词本`（`hasWord` 复用现有逻辑，短语主键已归一化，能正确命中）。

### 4.3 页内设置面板（`content.js` `buildPanel`）

在「更多功能」组内、`globalMode` 之后新增一个折叠子组「短语与查词模型」：

| 控件 | 类型 | 说明 |
|---|---|---|
| 使用大模型查词 | switch (`llmEnabled`) | 副标题：只影响查词，不影响字幕翻译 |
| API 地址 | input (`llmBaseUrl`) | placeholder `https://api.example.com/v1` |
| API Key | password input (`llmApiKey`) | 副标题：明文保存在本机 |
| 模型 | select (`llmModel`) + 「获取模型」按钮 | 调 `/models` 填充 |
| 测试连接 | button | 发一条最小请求，显示成功/失败原因 |

`llmEnabled` 关闭时，下面四项置灰（`disabled` + `opacity`），保持面板整洁。

### 4.4 生词本看板（`wordbook.html` / `wordbook.js`）

**侧栏分类**（现有 `#sideNav` 是 `all / learned / learning / new`，改为两组）：

```
词条类型
  全部词条        N
  单词            N
  短语            N
学习状态
  已记住          N
  记忆中          N
  新词            N
```

实现：`view` 变量现在同时承载"状态"与"类型"，需要拆成两个维度 `viewKind`（`all|word|phrase`）+ `viewStatus`（`all|learned|learning|new`）。`visibleWords()` 里两个条件叠加。**这是 `wordbook.js` 改动量最大的一处**（`syncSideNav` / `visibleWords` / `renderKPIs` 都要跟着改）。

**表格**：`.w-word` 里在 `.pill` 之前插入一个类型徽标 `.kind-tag`（短语=金色描边小胶囊「短语」，单词不显示，避免视觉噪音）。

**KPI 卡**：顶部四张卡（总数/已记住/记忆中/今日新增）保持不变，但 `subLine` 补上类型分布：`共 42 个词条（38 单词 · 4 短语）· 已记住 …`。

**抽屉**：短语条目的抽屉里，「释义」下方多一行「逐词对照」，并把「音标」位置替换为来源标签。

### 4.5 popup（`popup.html` / `popup.js`）

`#panel-words` 的筛选胶囊增加两个：`全部 / 单词 / 短语`（现有是状态筛选，两行并存）。`renderWords()` 里按 `kind` 过滤，短语行的副标题显示 `literal`（逐词直译）而不是音标。

---

## 5. 边界情况处理表

| # | 情况 | 处理方式 | 理由 |
|---|---|---|---|
| 1 | **选中内容是单个单词** | 走现有单词流程，行为完全不变 | 验收标准要求"选中 fair 显示公平的" |
| 2 | **选中 2 个词但其实是同一概念**（如 `New York`） | 走短语流程，`kind:'phrase'` | 词数判定简单可预测，不做语义猜测 |
| 3 | **选中超过 6 词 / 超过 80 字符** | 不查询，卡片提示"选中内容过长，请选一段短语（≤6 词）" | 整句翻译已有字幕译文，无需再查；避免误把整句入库 |
| 4 | **跨行/跨节点选择**（选中横跨两个 `<span>`） | `getSelection().toString()` 本身跨节点可用；额外用 `range.getBoundingClientRect()` 定位卡片 | 现有卡片定位依赖 `rect`，多行选择要取并集外接矩形 |
| 5 | **选中内容含中文** | 若含 CJK 字符 → 走"中译英"或直接提示不支持 | 现有查词链路是英→中单向 |
| 6 | **短语已存在于生词本** | `addWord` 的 `existing` 分支：保留 `createdAt`、`reviewCount` 累加、`status` 保留 | 与单词去重逻辑一致，学习进度不倒退 |
| 7 | **同一短语的不同大小写/标点** | 主键统一 `trim().toLowerCase().replace(/\s+/g,' ')` 并剥除首尾标点 | 避免 `Pay your fair` 与 `pay your fair` 存成两条 |
| 8 | **短语与单词语义冲突**（fair vs pay your fair） | 两者是**独立词条**，各自入库、各自高亮；卡片上互不覆盖 | 这正是本功能存在的理由，不能合并 |
| 9 | **查不到释义**（Tier A/B/C 全失败） | 卡片显示"未能获取释义" + 空的可编辑输入框 + 提示"可手动填写" | 允许用户自行输入是最可靠的兜底 |
| 10 | **大模型返回非 JSON / 超时** | 降级到 Tier B；若 Tier B 也失败则 Tier C | 复用现有 `fetchT` 超时机制 |
| 11 | **大模型未配置** | `llmEnabled` 默认 `false`，直接走 Tier B | 不强制用户配置 |
| 12 | **短语高亮与单词高亮冲突** | 见 §4.4 补充：短语**整串匹配**优先，命中区间内不再做单词高亮 | 否则 `pay your fair` 里 `fair` 会被单词规则单独标色，视觉混乱 |
| 13 | **`wordKeys()` 混入短语导致 `renderWords` 误标** | 必须把 `wordKeys()` 拆成 `wordKeys()`（仅单词）与 `phraseKeys()`（仅短语），或返回 `{word:[], phrase:[]}` | 现有 `state.wordSet` 是 `Set<单词>`，短语进不去；不改会让短语永远不高亮 |
| 14 | **备份/恢复跨版本** | `buildBackup` 的 `format` 版本号保持 `1`；`restoreFromBackup` 对缺 `kind` 的老记录补 `'word'` | 老备份文件仍能恢复，不破坏已落盘数据 |
| 15 | **ASR 误听**（pay your **fair** 实为 fare） | 不做自动纠错；Tier A 的大模型带上下文时可在 `note` 里提示；卡片显示字幕译文供用户自行判断 | 自动纠错风险大于收益，且需要完整语言模型 |

---

## 6. 各文件改动点清单

| 文件 | 改动 | 预估量 |
|---|---|---|
| `trace-subtitles/bg.js` | ① `DEFAULT_SETTINGS` 加 5 个 `llm*` 字段<br>② `addWord` 支持 `kind`/`literal`/`source`/`note`<br>③ `wordKeys()` 拆分为仅单词 + 新增 `phraseKeys()`<br>④ 新增 `lookupPhrase({phrase, context, contextZh})`：Tier A→B→C 降级<br>⑤ 新增 `llmChat()` / `llmListModels()` / `llmTest()`<br>⑥ 消息路由加 `phrase:lookup` / `llm:models` / `llm:test`<br>⑦ `__traceDebug` 导出新函数（供测试） | +220 行 |
| `trace-subtitles/content.js` | ① 新增 `onSelectionLookup()` + `mouseup`/`selectionchange` 监听（仅覆盖层内，避免干扰 YouTube 自身选择）<br>② 新增 `renderPhraseCard()` + 释义双击编辑<br>③ `buildPanel` 加「短语与查词模型」子组<br>④ `loadWordSet` 同时拉 `phraseKeys()`，新增 `state.phraseSet`<br>⑤ `renderWords` 前置整串短语匹配（§4.4 边界 12）<br>⑥ 单词卡片与短语卡片共用 `positionPopup` | +260 行 |
| `trace-subtitles/overlay.css` | ① 短语卡片新增 `.trace-pop-gloss` / `.trace-pop-src` / `.trace-pop-lit` / `.trace-pop-note` / `.trace-pop-edit`<br>② 短语高亮 `.trace-saved-phrase`（与单词 `.trace-saved` 区分：加下边框而非纯底色）<br>③ 设置面板的 input/password 样式复用 `.select` 风格 | +90 行 |
| `trace-subtitles/wordbook.html` | ① 侧栏拆成「词条类型」+「学习状态」两组<br>② 表格加 `.kind-tag` 列位 | +30 行 |
| `trace-subtitles/wordbook.js` | ① `view` 拆成 `viewKind` + `viewStatus`<br>② `visibleWords` 双维过滤<br>③ `renderKPIs` 的 `subLine` 加类型分布<br>④ `renderRows` 加类型徽标<br>⑤ 抽屉加「逐词对照」与来源标签<br>⑥ 备份恢复后 `kind` 缺省补全 | +120 行 |
| `trace-subtitles/popup.html` | `#panel-words` 加类型筛选胶囊 | +12 行 |
| `trace-subtitles/popup.js` | `renderWords` 按 `kind` 过滤 + 短语行显示 `literal` | +25 行 |
| `trace-subtitles/manifest.json` | `optional_host_permissions: ["https://*/*"]`（供大模型域名动态申请） | +1 行 |
| `tools/test-phrase.js` | **新建**，见 §7 | +300 行 |
| `README.md` | 新增「短语划词」整节（含 §0 的实测数据表） | +100 行 |

**总计约 +1150 行**，其中 `bg.js` 与 `content.js` 是主体。

---

## 7. 验收标准

### 7.1 功能验收（对应任务书原话）

| # | 验收项 | 判定方式 |
|---|---|---|
| V1 | 选中 `pay your fair` 展示**短语整体释义**，可一键加入生词本「短语」分类 | 测试断言卡片出现"整体释义"块、按钮文案含「短语」、入库记录 `kind==='phrase'` |
| V2 | 选中 `fair` 仍按原单词流程显示「公平的」 | 测试断言卡片是单词卡（有音标位、无"整体释义"块）、`zh==='公平的'` |
| V3 | 生词本中短语与单词**可区分查看** | 测试断言侧栏有「单词」「短语」两项，点击后行数分别为 N/M，且行内 `.kind-tag` 只在短语行出现 |

### 7.2 必须补充的验收项（§0 实测带出的）

| # | 验收项 | 理由 |
|---|---|---|
| V4 | 卡片**标注释义来源**（大模型/机器翻译/逐词直译） | 习语准确率仅约 50%，不标来源会误导 |
| V5 | 释义**可双击编辑**并持久化 | 短语释义不可靠时的唯一兜底 |
| V6 | 未配置大模型时 `llmEnabled=false`，走 Google 且**不报错** | 默认路径必须可用 |
| V7 | 大模型超时/返回非 JSON 时**自动降级**到 Google，卡片仍出结果 | 复用 `dictionaryapi.dev` 永久挂起的教训 |
| V8 | 选中 >6 词时**不查询**并给出提示 | 防止整句入库 |
| V9 | 短语在字幕里**整串高亮**，且不与单词高亮重叠 | 边界 12/13 |
| V10 | 老备份文件（无 `kind` 字段）恢复后全部视为单词，不报错 | 边界 14 |

### 7.3 测试文件设计（`tools/test-phrase.js`）

沿用现有夹具体系（`tools/mock/fixtures.js` 的 `pageHtml` / `opts.cues`），要点：

- 自定义 `PHRASE_CUES`，包含 `pay your fair` 与单独出现的 `fair` 两句，便于同屏对比；
- 大模型用**本地 mock**（Playwright `route` 拦截用户填的假域名）返回固定 JSON，同时准备三种 mock：正常 JSON / 带 ```json 围栏 / 超时无响应 —— 分别验证 V6/V7；
- 断言清单：`phraseCardShown` / `wordFlowUnchanged` / `sourceLabelShown` / `glossEditable` / `savedAsPhrase` / `kindFilterWorks` / `phraseHighlighted` / `phraseNotWordHighlighted` / `tooLongWarned` / `llmFallbackOnTimeout` / `legacyBackupRestored` / `noErrors`。

---

## 8. 需要你确认的三个决策点

1. **大模型是否要做？** 按 §3.3，它只服务查词、不碰字幕批量翻译。做了才能把习语正确率从约 50% 拉到可用；不做就只能诚实标注"机器翻译，仅供参考"。**建议做**（你已主动提出中转站，说明有现成额度）。
2. **超长选中的阈值**：我取「>6 词或 >80 字符」。偏紧还是偏松？
3. **短语高亮的视觉**：用底色（同单词的金色）还是改用下划线以区分？我倾向**短语加下划线、单词用底色**，一眼能分出类型，但这会改变现有单词高亮的观感一致性 —— 需你定。

---

*本设计基于对 `bg.js`（1593 行）、`content.js`、`wordbook.js`、`overlay.css` 的核对，以及 6 组真实接口实测。*
