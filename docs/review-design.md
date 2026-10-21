# Trace 复习台（review）—— 逐卡记忆与打卡系统设计说明

> 状态：**已落代码并全量验证通过**
> 依据：`trace-subtitles/review.html`（1402 行）+ `trace-subtitles/review.js`（817 行）+ `trace-subtitles/bg.js` 新增 `reviewlog` store / `logReview` / `reviewStats` / `clearReviewLog` / `openExtPage`；`tools/test-reviewpage.js` 37 项 + 全页 WCAG 审计（三区域 × 双主题）+ 六档断点探针实测
> 载体：浏览器扩展独立网页（`chrome-extension://<id>/review.html`），桌面优先，兼容浏览器小窗口

---

## 0. 先说约束怎么落成了硬指标

这份设计延续 `docs/wordbook-design.md` 的方法论：每个视觉决定背后都有一个可复算的数字。四条最硬的：

| 硬性要求 | 落地方式 | 验证方式 |
|---|---|---|
| 独立复习页面，流程如「不背单词」 | 路由 `/review.html` 独立成页，不复用生词本抽屉；卡片三态（正面 → 揭示 → 评级）单卡推进 | `test-reviewpage.js` A–D 组：队列/KPI/揭示三条路径/评级写入/队列前进 |
| 复习对象＝之前不认识、且到期的词 | 复用 wordbook 的 `isDue()` 同一套 `INTERVAL_DAYS = [1,2,4,7,15,30]`，非到期不排 | `test-reviewpage.js`：5 词种子 → `kDue="4 个"`（learned 的 caption 不进队列） |
| 打卡系统（连续天数 + 日历 + 面板） | 新 IndexedDB store `reviewlog`，按「天」记流水；连续天数带「今天没练不清零」的保护 | `test-reviewpage.js`：热力图 182 格、`streak` 3 天→4 天、`hmFoot="共打卡 4 天 累计 13 道"` |
| 全部功能图标用内联 SVG，禁 emoji / 图片图标 | 源码共 20 处 `<svg>`（`review.html` 12 处静态 + `review.js` 8 处模板生成），全部 `stroke="currentColor"`，无 `<img>`、无 emoji | `Select-String "<img\|🖼\|✅\|❌"` 零命中 |
| 满足 WCAG 文本可读性 | 逐节点算相对亮度 + 对比度，按 AA 阈值（小字 4.5:1 / 大字 3:1） | `tools/a11y-contrast.js`：light 主页面 196 + 抽屉 48 + 复习台 209 **未达标 0**；dark 同 |

**一条必须写下来的教训**：`a11y-contrast.js` 报 0 不等于全覆盖。它只遍历文本节点，`::placeholder` 这类伪元素、`background-image: linear-gradient(...)` 这类背景都必须单独处理。本页的 `.brand .mark`（金渐变底 + `#2a2000` 字）就曾在审计里被误报成 1.22 —— 因为脚本读不到渐变，只能读到父级的深色底。现在脚本对带 `background-image` 的祖先直接跳过该节点，而不是给出一个假的失败。

---

## 1. 页面布局

```
┌─ aside 216px ─┬──────────── main (max-width 1560px, 居中) ──────────────┐
│ 品牌 mark T   │ ① 页头：Trace 复习台 + 副标题行   [重开一轮][生词本]   │
│               ├────────────────────────────────────────────────────────┤
│ 去向          │ ② 四张统计卡（连续天数 / 今日 / 待复习 / 累计）        │
│  复习台  ●    ├────────────────────────────────────────────────────────┤
│  生词本  →    │ ③ 复习台（stage）                                      │
│  深色         │    ├ 进度：第 3 / 4 个 + 4 段进度条                     │
│               │    ├ 卡片（deck > fc > fcFront / fcBack）               │
│ 今日目标      │    └ 操作区（acts）：[看释义] 或 三档评级              │
│  ◯ 12 / 20    ├────────────────────────────────────────────────────────┤
│  还差 8 道    │ ④ 打卡日历（1.55fr）│ 评级分布 + 最近复习（1fr）      │
│               │    26 周 × 7 天热力图 │                                │
│ 连续打卡      │                       │                                │
│   7  最长 12  │                       │                                │
│  ●●●●●○○      │                       │                                │
│               │                       │                                │
│ 隐私脚注      │                       │                                │
└───────────────┴────────────────────────────────────────────────────────┘
```

### 1.1 骨架尺寸（实测）

| 区块 | 关键属性 |
|---|---|
| `.wrap` | `grid-template-columns: 216px minmax(0,1fr)`；`min-height:100vh` |
| `aside` | `position:sticky; top:0; height:100vh; display:flex; flex-direction:column; gap:6px; padding:22px 14px 16px`；`overflow-y:auto` |
| `main` | `max-width:1560px; margin-inline:auto`；`padding:26px 30px 56px`；`display:flex; flex-direction:column; gap:14px` |
| `.stats` | `grid-template-columns: repeat(4, minmax(0,1fr))`；`gap:10px` |
| `.stage` | 卡片 + 操作区的容器，`padding` + `border-radius:var(--r-lg)` |
| `.fc` | `min-height:306px`；`padding:22px 26px 20px`；`border-radius:var(--r-lg)` |
| `.rates` | `grid-template-columns: repeat(3, minmax(0,1fr))`；`gap:8px` |
| `.panel` | 面板卡，`background:var(--ink-2)` + `--shadow-card` |
| `.panels` | `grid-template-columns: minmax(0,1.55fr) minmax(0,1fr)`；`gap:12px`；`align-items:stretch` |
| `.side-col > .panel` | `>1181px` 时 `display:flex; flex-direction:column; flex:1 1 auto`，第二块 `flex-grow:1.2` —— 两张卡吸收剩余高度，而不是在右栏底部留一块空洞 |
| `.hm-grid` | `grid-template-columns: repeat(var(--hm-weeks,26), minmax(0,1fr))`；26 周 × 7 = 182 格 |

**两个宽度决定（都是用户反馈倒逼的改动，不是审美偏好）**

*① `max-width` 1120 → 1560 + `margin-inline:auto`*。1120 在 1600 宽窗口里实测 `mainRightGap = 264px`：grid 子项的 `max-width` 生效后不会自动居中，整块内容贴左、右侧一条死白，而同一套视觉语言下的生词本主区是流式铺满的，两页并排看就不像一家人（用户原话：「为什么复习台的右侧是空的，看着十分不协调」）。改完 1600 宽时 `mainRightGap = 8px`（与左内边距对称），2048 宽时左右各 136px 对称留白。上限 1560 不是为了留白，是极宽屏下别把四张统计卡拉成四条细长的带子。

*② 右栏两张卡 `flex-grow`*。`.panels{align-items:stretch}` 只把 `.side-col` 拉到与左栏日历等高，卡本身仍是内容高 —— 空词库时右栏就是「两个小盒子 + 下方一大片背景色」，比贴边死白更显眼。改后两张卡按 1:1.2 吸收剩余高度（「最近复习」最多 6 行，天然比三行条形图高），配合 `.dist/.recent{flex:1 1 auto; justify-content:center}` 与空态文案 `margin-block:auto`，空态文字落在面板正中。只在 `>1181px` 生效 —— 1180 以下 `.side-col` 改横排，`flex-grow` 会把两张卡拉成等高的大块，反而更糟。

实测（`tools/probe-review4.js`）：1600×867 空态 `sideColSlack = 0`、`mainRightGap = 8`；1180 边界与 1280 宽均无溢出、无右侧死白。
| `.hm-grid` | `grid-template-columns: repeat(var(--hm-weeks,26), minmax(0,1fr))`；26 周 × 7 = 182 格 |

### 1.2 与生词本的视觉关系

两页共用 `theme.css`（基础组件）+ `theme-tokens.css`（主题变量），所以色板、圆角、阴影、字体完全同源。差异只在**密度**：

| | 生词本 wordbook | 复习台 review |
|---|---|---|
| 主内容宽度 | 流式铺满 | `max-width:1560px; margin-inline:auto`（卡片太宽会让一个词显得空旷，但也不能在宽屏上贴左留死白） |
| 每屏信息量 | 高（15 行列表 + 两图） | 低（一张卡 + 一排按钮），刻意留白 |
| 主动作 | 浏览 / 筛选 / 编辑 | 单一决策（这次想得起来吗） |
| 侧栏 | 视图筛选 + 备份 | 去向导航 + 目标环 + 连续打卡 |

设计意图：生词本是「图书馆」，复习台是「考场」。考场里不该有别的东西分心，所以没有筛选、没有搜索、没有排序——这些都在生词本那一侧。

---

## 2. 色彩规范

### 2.1 继承关系

`theme-tokens.css` 是唯一来源，两页共用。本页**没有新增任何文字色 token**，只新增了热力图的五档梯度（`--hm-0` ~ `--hm-4`）。

### 2.2 热力图梯度（本页唯一新增的色彩体系）

浅色（对白底对比度，按等距解出）：

| token | 值 | 对白底 | 语义 |
|---|---|---|---|
| `--hm-0` | `#f1eee7` | 1.16 | 空档（没打卡） |
| `--hm-1` | `#dfc99f` | 1.62 | 1–4 道 |
| `--hm-2` | `#d1b175` | 2.05 | 5–9 道 |
| `--hm-3` | `#c49b4e` | 2.58 | 10–19 道 |
| `--hm-4` | `#b8862a` | 3.24 | 20+ 道 |

深色（对面板 `#101017` 的对比度）：

| token | 值 | 对面板 |
|---|---|---|
| `--hm-0` | `#17171f` | 1.06 |
| `--hm-1` | `rgba(255,215,110,.24)` | 1.85 |
| `--hm-2` | `rgba(255,215,110,.40)` | 3.02 |
| `--hm-3` | `rgba(255,215,110,.56)` | 4.91 |
| `--hm-4` | `rgba(255,215,110,.76)` | 8.19 |

**为什么是「按对比度等距」而不是手挑颜色**：最初那版（`#f9ecca` / `#f0d493` / `#ddb257`）是凭眼睛挑的，逐档比值算出来是 **1.01 / 1.23 / 1.37** —— 第一档和空格子只差 1%，「今天练了 1 道」与「今天没练」在屏幕上等于同一个颜色，梯度前段整段失效。改成按目标对比度反解后，浅色相邻档稳定在 1.26~1.39，深色在 1.63~1.74，任何一档都能与邻档区分。

**颜色不是唯一编码**：`.hm-cell` 的 `title` 写着「2026-10-20 · 12 道」，悬停即可读到精确值；色弱用户也能靠单调的明暗读出强度，因为整条梯度是单向的。

### 2.3 三档评级的色彩策略（关键决定）

三档按钮 `background` 分别是 `--red-soft` / `--amber-soft` / `--green-soft`（浅色 12% 透明）。

**底色只负责「这是个按钮」，不负责「区分是哪一档」。** 这句话写在 CSS 注释里，因为它是被实测逼出来的：

| 方案 | 结果 |
|---|---|
| 只靠底色区分（12%） | forget↔fuzzy 的 RGB 欧氏距离仅 **24.5**，肉眼不可分 |
| 提高填充度到 48% | 琥珀会冲到 `#ebcf93` 这种糖果色，违反「低饱和」要求 |
| **正解：30px 实心色标** | 满色度只占 30px 的图标块，表面仍然柔和；实测最小色距 **43.7（浅）/ 104.3（深）** |

所以 `.r-ico` 是实心的 `var(--red)` / `var(--amber)` / `var(--green)`，图标内容是 `--ink-2`（白/黑），压自身底色比值 5.64~9.96，全部达标。这个「色标承担语义、底色承担容器」的分工是本页最重要的一条设计判断。

深色下的底色另有一套：`color-mix(in srgb, var(--red) 22%, var(--ink-2))`。因为 14% 透明度压在 `#16161f` 上会塌成同一个深灰（三块看起来一样），必须混入面板色提亮。`--green` 单独用 26%，因为它本身亮度最低，同用 22% 会让「正向操作」反而最弱。

### 2.4 语义色一览

| 用途 | 浅色 | 深色 |
|---|---|---|
| 忘记 / 负向 | `--red #9e4e4d`（白底 5.75 / 红软底 4.97） | `--red #e08684`（7.14） |
| 模糊 / 中间 | `--amber #8c5626`（白底 6.04 / 琥珀软底 4.97） | `--amber #f5a623`（9.35） |
| 记住 / 正向 | `--green #327356`（白底 5.64 / 绿软底 4.93） | `--green #46d39a`（9.96） |
| 品牌 / 主操作 | `--brand-ink #6b5518`（7.15） | `--brand-ink #ffd76e`（13.71） |
| 进度条已满 | `--gold #ffd76e` | `--gold #ffd76e` |
| 进度条当前 | `--gold-2 #ffbe3d` | `--gold-2 #ffbe3d` |

注意 `--gold` 浅色下对白底只有 **1.38:1**，所以它只用于**图形**（进度条填充、环形进度），从不用于文字。这是 wordbook 阶段就定下的规则，本页继续遵守。

---

## 3. 组件清单：状态与行为

### 3.1 侧栏（aside）

| 组件 | 类 / id | 行为 |
|---|---|---|
| 品牌块 | `.brand .mark` + `.brand-name` + `.brand-sub` | 26px 金渐变方块「T」，副标题「复习台」 |
| 去向导航 | `.side-nav` | 三项：复习台（当前，`.on` 金色软底）、生词本（`<a href="wordbook.html">`）、深色（`#themeBtn`） |
| 今日目标环 | `.goal` > `#goalFill` | SVG 圆环 `r=52`，`stroke-dasharray = 2π·52`，`dashoffset` 按 `todayCount/GOAL` 反比 |
| 目标数字 | `#goalNow` / `#goalOf` / `#goalLbl` | 「12」/「/ 20 道」/「还差 8 道」；达标时「今天达标了」，未开始「今天还没开始」 |
| 连续打卡 | `.streak` > `#stNow` / `#stBest` | 「7」天 + 「最长 12」 |
| 本周点阵 | `#weekDots` | 7 个 `<i>`，周一为首（`(getDay()+6)%7`）；`>0` 加 `.on`，`>=10` 加 `.best` |
| 隐私脚注 | `.side-foot` | 「数据只存在本机」说明 |

**为什么目标环要放在侧栏而不是主区**：主区已经有一张「今日 N 道」统计卡，环是把同一个数字**换成进度感**——它回答的不是「多少」，是「还差多少」。放在侧栏等于把它定位成「参考值」而非「主要读数」，避免和统计卡抢注意力。

### 3.2 统计条（四卡）

| 卡 | id | 值来源 | 副标题逻辑 |
|---|---|---|---|
| 连续天数 | `#kStreak` / `#dStreak` | `STATS.streak` | 「最长 N 天」 |
| 今日已练 | `#kToday` / `#dToday` | `STATS.todayCount` | 「目标 20 道」 |
| 待复习 | `#kDue` / `#dDue` | `ALL.filter(isDue).length` | 「N 个新词 · M 个到期」 |
| 累计次数 | `#kAll` / `#dAll` | `STATS.total` | 「已记住 N 个」 |

四卡都是「大数字 + 一行小字」的双层结构，`.stat-val` 里数字与单位用 `.sm` 降一档（18px vs 25px），单位不抢数字。

### 3.3 进度条

两种形态，按队列长度切换：

| 队列长度 | 形态 | 实现 |
|---|---|---|
| ≤ 24 | 逐格 `<i>` | `.prog` flex，每格 `flex:1 1 0`；已过 `.done`（`--gold`）、当前 `.now`（`--gold-2`） |
| > 24 | 单条进度条 | `.prog.bar` + 一个 `<i>` 按百分比设 `width` |

`review.js` 的 `buildProg()` 决定用哪种。理由写在注释里：**200 个 4px 宽的格子 DOM 太重，而且每格细到看不清，反而失去「还剩多少」的信息**。

### 3.4 卡片（deck + fc）

三层结构：

```
.deck            ← 相对定位；.stacked 时用 ::before/::after 露出两张「压着的牌」
  .fc            ← role="button" tabindex="0"，点击/空格切换正反面
    .fc-inner    ← display:grid，正反两层同占 1/1 格
      .fc-front  ← 来源标签 + 单词 + 音标 + 提示语
      .fc-back   ← 释义 + 词性 + 原句 + 来源 + 复习历史
```

**关键实现：`.fc-inner { display:grid }` + 两层 `grid-area: 1/1`。** 这样容器高度永远等于「两者中更高的那个」，揭示时卡片**不会突然长高把下面的按钮顶走**。如果改成 `position:absolute` 互叠，容器就没有高度，必须写死 `min-height`，而写死的值总会在某个长释义的词上不够。

正面（`#fcFront`）：

| 元素 | 内容 | 说明 |
|---|---|---|
| `.fc-meta` | 短语标签（`.fc-tag`，紫软底 + 三横线图标）/ 释义来源 `.fc-note` | 短语才出标签 |
| `.fc-word` | 单词或短语原文 | 40px；`length > 16` 时加 `.small` 降到 30px |
| `.fc-phon` | 音标 | 14px 等宽，独立一行 |
| `.fc-hint` | 「想不起来也没关系，先猜一下」+ `.kbd`「空格」 | 降低焦虑 + 教学快捷键 |

> **音标为什么不塞进 `.fc-word` 内部**：一来它是 14px 等宽、词是 40px 比例字体，混在一个盒子里的基线对不齐；二来 `.fc-word` 的文本必须**只有那个词本身**——读屏、复制、测试取词都依赖它。（这条是实测发现的：把音标拼进 `.fc-word` 后，`test-reviewpage.js` 读到的 `cardWord` 变成 `latency/ˈleɪtənsi/`，断言直接失败。）

背面（`#fcBack`）按顺序拼装，每块都是条件渲染——缺什么就不画什么，**空框比没有更糟**：

1. 短语：`.fc-zh` 整段释义 → `.fc-literal` 直译 → `.fc-literal` 逐词拆解
2. 单词：`.fc-zh` 中文释义 → `.fc-literal` 前 3 个义项（带 `.fc-pos` 词性）
3. `.fc-quote` 原句（有 `context` 才画）+ `.q-zh` 中文译文
4. `.fc-src` 来源视频标题（带播放器图标）
5. `.fc-literal` 复习历史：「第 N 次复习 · 之前忘记 N 次 · 模糊 N 次」——**`t.reviews` 为 0 时不画**，否则新词会看到「第 1 次复习 · 之前忘记 0 次」这种噪音

### 3.5 操作区（acts）

按卡片状态渲染三种内容：

| 状态 | `#acts` 内容 |
|---|---|
| 未揭示 | `.acts-reveal` > `#revealBtn`「看释义」+ `.kbd`「空格」（眼睛图标） |
| 已揭示 | `.rates` > 三个 `.rate[data-rate]` |
| 队列走完 | `.finish` 完成面板 |

三档按钮的内部结构一致：`.r-ico`（30px 实心色标 + 16px SVG）+ `.r-txt`（`.r-name` 主文案 + `.r-hint` 副文案）+ `.r-k`（快捷键数字）。

| 档位 | 主文案 | 副文案 | 图标语义 | 快捷键 |
|---|---|---|---|---|
| `forget` | 忘记了 | 明天再来 | 叉线对（互交的斜线） | `1` |
| `fuzzy` | 模糊 | 继续温习 | 带弧线的笑脸 | `2` |
| `remember` | 记住了 | 标记已记住 | 单勾 | `3` |

`.r-hint` 和 `.r-k` 都用 `color-mix(in srgb, currentColor 72%, var(--text-2))` 而不是 `opacity`——**10px 小字乘 0.85 的透明度后压在同族软底上只剩 3.57，读不出来**；混色在视觉上一样「轻」，但颜色本身是实心的，过 4.5:1。

### 3.6 完成态（finish）

两种文案，**必须区分**：

| 情形 | 标题 | 说明 |
|---|---|---|
| 队列本来是空的（`QUEUE.length === 0`） | 「今天没有到期的词」 | 不是「做完了」；否则用户会以为刚才那一轮把词都清空了 |
| 队列走完（`IDX >= QUEUE.length`） | 「本轮复习完成」+ `.finish-sum` 三档计数 | 副文案按 `goalHit` 分「目标达成」/「还差 N 道」 |

两处都有 `<a href="wordbook.html">打开生词本</a>`——复习完的去向是「看看我的词库长什么样了」，这是自然的收尾。

### 3.7 打卡日历（panel）

| 部分 | id | 内容 |
|---|---|---|
| 月份标签 | `#hmMonths` | 每列一个 `<span style="grid-column: N / span 4">`；相邻 <4 周时丢弃后一个（否则两个标签挤在一起） |
| 星期标签 | `.hm-dow` | 一 / 三 / 五（只标三个，标七个太密） |
| 格子矩阵 | `#hmGrid` | 26 周 × 7 = 182 个 `.hm-cell`，class 为 `lv0`~`lv4` / `pad`（未来日期）/ `today` |
| 脚注 | `#hmFoot` | 「共打卡 N 天 · 累计 N 道 · 最后打卡 YYYY-MM-DD」 |

`title` 属性带精确值（`2026-10-20 · 12 道`），悬停可读。分档用**绝对道数**（0 / <5 / <10 / <20 / ≥20）而不是分位数——分位数会让「昨天 12 道」在不同时期显示成不同深浅，用户回头翻历史时会觉得颜色不可信。

### 3.8 评级分布 + 最近复习（右栏）

**评级分布** `#dist`：三行 `.dist-row`，结构为 `.dist-name`（色块 + 名称）+ `.dist-bar`（按占比的横条）+ `.dist-val`（百分比）。零数据时给 `.dist-empty` 说明文案而不是空框。

**最近复习** `#recent`：最近 6 个有 `lastReview` 的词，`.recent-row` 含 `.recent-dot`（按状态着色）+ `.recent-w`（单词）+ `.recent-t`（用 `fmtAgo` 显示「刚刚 / 12 分钟前 / 3 天前」）。这是「我刚才做了什么」的即时反馈，和热力图（长期）形成两个时间尺度。

**右栏的高度分配**：这一列的内容量是固定的（三行条形图 / 最多 6 行），但左栏日历的高度由屏宽决定，两者天然不等高。`.panels{align-items:stretch}` 先把 `.side-col` 拉齐到左栏高度，再由 `.side-col > .panel{flex:1 1 auto}` + 第二块 `flex-grow:1.2` 把这段高度分给两张卡本身。

**空态的结构**：把卡撑高只是第一步 —— 卡高 330px 而里面只有一句 11px 的文案时，几何上文字是居中的（实测 `#dist` 盒 643.8–721.3、文案 673.8–691.4，中心差 0.05px），但视觉上仍读作「两个空盒子」，因为面板内部没有可参照的东西。所以空态改成**图标 + 引导文字**的两段式：`.empty-ico`（30×30 虚线框，内嵌 15px 线性图标）压住视线，`.empty-hint`（`max-width:240px`、`text-wrap:pretty`）给出「下一步做什么」而不是只说「没有数据」。

选虚线框而不是实心/彩色图标，是为了不跟有数据时的三色条抢注意力 —— 空态在信息层级上应该比有数据态**更弱**，而不是反过来。文案也从单句扩成两句（「还没有复习记录。」→「还没有复习记录。评过级的词会按时间倒序排在这里，最多显示 6 个。」），让两张卡的内容量接近，并排时不会一重一轻。

`.dist-empty` / `.recent-empty` 在 `>1180px` 下 `padding-block:0` —— 它们原本各带 14px/4px 与 12px/6px 的上下不对称内边距（贴着标题排时用），进了居中 flex 之后只会让文字偏离中线。

---

## 4. 交互行为

### 4.1 三态推进

```
正面（未揭示）
   │ 点击卡片 / 空格 / Enter / 点击「看释义」
   ▼
背面（已揭示，出现三个评级按钮）
   │ 点击评级 / 按 1·2·3
   ▼
下一张的正面（或完成面板）
```

**点卡片可以「收起」**（已揭示时再点回到正面）。这是刻意的：用户可能想先回忆一下再确认，不给他退路等于逼他硬答。

### 4.2 键盘

| 按键 | 行为 | 备注 |
|---|---|---|
| `空格` / `Enter` | 揭示 / 收起 | `#revealBtn` 自己已处理时跳过，避免双重触发 |
| `1` / `2` / `3` | 评级 | **未揭示时第一次只揭示**，不评级——还没看释义就评级等于瞎猜 |
| `Tab` | 在卡片与按钮间移动 | `.fc` 有 `:focus-visible` 金色描边 |

快捷键在按钮上以 `.kbd` / `.r-k` **可见地标注**：功能存在但没人知道等于不存在。

### 4.3 评级写入链路

```
点击 .rate[data-rate="forget"]
  → BUSY 锁（防止连点记两次）
  → 按钮加 .flash（0.42s 缩放脉冲，唯一的即时反馈）
  → send('word:rate', {word, grade})
      → bg.js rateWord()：reviewCount+1、forgetCount+1、lastReview=now、status='learning'
      → logReview()：写入 reviewlog 流水
      → broadcastWordsChanged()：通知所有 YouTube 标签页
      → scheduleAutoBackup()：30 秒节流触发自动备份
  → 用返回的记录 Object.assign 回写 QUEUE 与 ALL 中同词
  → IDX++ / REVEALED=false
  → send('review:stats') 重新拉统计
  → 重绘：renderStats / renderHeatmap / renderDist / renderRecent
  → 队列走完则 renderFinish
```

**为什么评级后不重新拉 `word:list`**：词义没变，没必要整库重读。只有 `reviewCount` / `forgetCount` 这些计数变了，而 `word:rate` 的返回值就是更新后的完整记录，够用了。

**为什么 `logReview` 写在 `bg.js` 而不是复习页**：这样生词本抽屉里的三档评级也会计入打卡。同一个动作只应该有一条写入路径。

### 4.4 打卡数据的连续性保护

`reviewStats()` 里最关键的一段（`bg.js:2030-2040`）：

```js
const today = dayKey(Date.now());
const yesterday = dayKey(Date.now() - 86400000);
// 今天还没复习时不能直接判 0：
// 否则用户下午打开会看到「连续 0 天」，昨天的 7 天像被清零
if (byDay.has(today) || byDay.has(yesterday)) { ...从今天或昨天往回数... }
```

还有 `dayKey()` **不能用 `toISOString()`** —— UTC+8 的凌晨会被算到前一天，打卡会串位。必须用本地日期手工拼 `YYYY-MM-DD`。

### 4.5 重开一轮

`#restartBtn`（页头）与 `#finishRestart` / `#finishAll`（完成面板）都走同一条逻辑：

1. `reload()` 重新拉词库与统计
2. `buildQueue()` 按到期规则重排
3. **队列仍为空但有词时，退化成整库打乱重过** —— 否则「再来一轮」点下去毫无反应，那是最糟的交互
4. 队列为空且词库也为空时，toast 提示去字幕里点词

### 4.6 主题切换

`#themeBtn`（侧栏第三项）↔ `applyTheme(next, animate)`：

- 给 `<html>` 加 `.theme-anim` 类 420ms，只过渡 `background-color` / `border-color` / `color`，避免切换瞬间整页闪
- 写 `localStorage['wb-theme']`（内联脚本读它防首屏闪白）
- 同时 `settings:set { wbTheme }` —— 让 popup 等其他页面读到一致的值
- 改 `#themeLabel` 文案（「浅色」↔「深色」）与 `#themeBtn` 的 `aria-label`
- 图标是 `.i-moon` / `.i-sun` 两个 SVG 叠放交叉淡入，不是替换 innerHTML

### 4.7 跨页面同步

```js
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'words:changed') { /* 只静默更新 ALL + 统计，不动队列 */ }
});
```

**不动队列**是刻意的：用户正看着第 7 张，被别的标签页改动弹回第 1 张很恼人。

### 4.8 与生词本的入口互链

| 从 | 到 | 方式 |
|---|---|---|
| 生词本 `#batchBtn`（工具栏「开始复习」+ 待复习数字） | review.html | `chrome.tabs.create` |
| 生词本 `#sideReview`（侧栏金色按钮 + `#cDue` 角标） | review.html | 同上 |
| 复习台侧栏「生词本」 | wordbook.html | `<a href>` 直接跳 |
| 复习台页头/完成面板「打开生词本」 | wordbook.html | 同上 |
| 字幕页内面板「生词本」按钮 | wordbook.html | `open-wordbook` 消息 |
| 以后任意入口 | review.html | `open-review` 消息（`bg.js` 的 `openExtPage`） |

`bg.js` 新增的 `openExtPage(file)` 用 `chrome.runtime.getContexts({contextTypes:['TAB'], documentUrls:[url]})` 找已开的标签页，有则 focus，无则新建——**不用 `tabs.query` 按 url 过滤，因为那需要 `tabs` 权限**（manifest 里只有 storage/unlimitedStorage/downloads）。

---

## 5. 按钮 → SVG 图标语义对照（全表）

共 20 处内联 SVG（`review.html` 12 + `review.js` 8）。

### 5.1 侧栏与页头

| 位置 | 图标描述 | 语义 |
|---|---|---|
| `.brand .mark` | 文字「T」 | 品牌字标（非 SVG，是排版字符） |
| `.side-nav` 复习台 | 逆时针回旋箭头 + 起点小折角 | 「复习 / 再来一遍」——回旋表示间隔重复 |
| `.side-nav` 生词本 | 翻开的书脊 | 词库 |
| `#themeBtn` `.i-moon` | 月牙 | 当前是浅色，点它转深色 |
| `#themeBtn` `.i-sun` | 太阳 + 八向光芒 | 当前是深色，点它转浅色 |
| `#restartBtn` | 逆时针回旋箭头 | 「重开一轮」 |
| 页头「生词本」链接 | 翻开的书脊 | 去向词库 |

### 5.2 统计与面板

| 位置 | 图标描述 | 语义 |
|---|---|---|
| 连续打卡卡 | 火焰（双层火苗） | 打卡连续性（业界通用隐喻） |
| 今日已复习卡 | 单勾 | 「今天已经完成的」（完成态，不是「日历」——日历图标会让人以为点它看日期） |
| 待复习卡 | 圆 + 指针（时钟） | 到期 |
| 累计复习卡 | 折线脉冲（平-升-降-升-平） | 「持续发生」的活动量，比双箭头更贴近「次数」这个可累加的量 |

四张卡的图标底色按「这一项属于什么性质」分配：连续打卡=金（`--gold-soft`，品牌色给最重要的成就项）、今日已复习=紫（`--violet-soft`）、待复习=琥珀（`--amber-soft`）、累计复习=绿（`--green-soft`）。红没有被用在统计卡上——它在本页专属「忘记了」这一档，这样红就只有一个含义，不会和「待办」或「热度」混淆。

### 5.3 卡片与操作区

| 位置 | 图标描述 | 语义 |
|---|---|---|
| `.fc-tag` 短语标签 | 三条横线（长短不一） | 「一段多词文本」= 短语 |
| `.fc-src` 来源 | 圆角矩形 + 播放三角 | 视频来源 |
| `#revealBtn` | 眼睛 + 瞳孔 | 「看释义」 |
| `.rate-forget .r-ico` | 两条互交的斜线 + 一条对角线 | 「错了 / 想不起来」（划掉） |
| `.rate-fuzzy .r-ico` | 圆 + 两点眼 + 上扬弧嘴 | 「模糊 / 有点印象但不确切」 |
| `.rate-remember .r-ico` | 单勾 | 「记住了」（确认） |
| `.finish-mark`（完成） | 单勾（26px，1.8 描边） | 本轮完成 |
| `.finish-mark`（空队列） | 翻开的书 + 两条横线 | 「词库在，但没有到期的」 |

### 5.4 完成面板按钮

`#finishRestart`「再来一轮」是纯文本按钮（无图标）—— 它和 `#restartBtn` 是同一个动作，重复放图标反而增加视觉噪音。`<a>打开生词本</a>` 同理。

---

## 6. 动效清单（克制原则）

| 元素 | 动效 | 时长 / 曲线 | 目的 |
|---|---|---|---|
| 卡片正反切换 | `opacity` + `translateY(±6px)` | 0.24s / 0.28s `--ease` | 状态过渡，不是表演 |
| `.deck.stacked` 压牌 | `opacity` 0→1 / 0→0.6 | 0.3s `--ease` | 表示「后面还有词」 |
| 评级按钮 `.flash` | `scale .97 → 1.012 → 1` | 0.42s | 确认点击已被接收 |
| 评级按钮 `:active` | `scale(.985)` | 0.12s | 按压反馈 |
| 进度条 `.prog i` | `background` 过渡 | 0.24s `--ease` | 前进感 |
| `.prog.bar i` | `width` 过渡 | 0.3s `--ease` | 同上 |
| 主题切换 | 颜色过渡 | 0.34s `--ease-io` | 避免闪白 |

全页**只有一处 `@keyframes`**（`rateflash`），就是评级按钮那 0.4s 的确认脉冲。其余全是 CSS `transition`——过渡是「从状态 A 到状态 B」，动画是「演一段给你看」，本页只取前者。

**没有任何「入场动画表演」**：没有弹跳、没有旋转、没有逐字打字、没有视差，也没有列表逐行浮现（生词本那页的 `.rise` 是为 15 行列表设计的，本页只有一张卡，逐行浮现没有对象）。所有动效都只做一件事——把状态变化告诉用户。

`@media (prefers-reduced-motion: reduce)` 由 `theme.css` 统一降级（压到 0.001ms），本页不需要重复声明。

---

## 7. 响应式（浏览器小窗口，不是移动 App）

| 断点 | 布局变化 |
|---|---|
| ≥1181px | 侧栏 216px 文字完整；统计四卡一行；面板 1.55fr / 1fr 两栏 |
| 901–1180px | 侧栏收成 **64px 图标条**（`.brand-text` / 文字 / 周点阵 / 目标文字全 `display:none`）；目标环缩到 44px；`.panels` 单栏；`.side-col` 横向换行 |
| 621–900px | `main` padding 收到 22/18；统计卡 **2 × 2**；`.fc-word` 32px；`.rates` **单列**（三个按钮竖排）；`.r-hint` 隐藏（保主文案） |
| ≤620px | `main` padding 18/14；统计卡单列；`.fc-word` 27px；热力图 `--hm-weeks` 从 26 收到 **14** |

**侧栏折叠到 64px 时每个按钮都有 `title`** —— 否则只剩图标，用户不知道「回旋箭头」是复习还是刷新。这条在 wordbook 阶段踩过，本页直接继承。

**`.rates` 在小窗口从三列变单列而不是缩窄**：三个 60px 高的按钮挤在一行、每个只有 90px 宽时，`.r-hint` 副文案必然要截断或消失，而副文案正是「明天再来 / 继续温习 / 标记已记住」这些区分语义的关键。竖排后每个按钮恢复完整信息。

---

## 8. 数据层：只加不改

### 8.1 IndexedDB 升版（DB_VER 2 → 3）

```js
const DB_VER = 3;   // 原 2
// onupgradeneeded 内：
if (!db.objectStoreNames.contains('reviewlog')) {
  const r = db.createObjectStore('reviewlog', { keyPath: 'id' });
  r.createIndex('at', 'at');
  r.createIndex('day', 'day');
}
```

**id 是内容定值而不是自增**：`id = \`${at}|${word}|${grade}\``。原因是备份合并回来时同一条流水必须落在同一个 id 上，否则反复恢复会把打卡天数越叠越多。

`if (!contains(...))` 的写法保证用户从 v1 直接升到 v3 也不会炸。

### 8.2 流水记录

```js
{ id: '1761000000000|latency|fuzzy', at: 1761000000000, day: '2026-10-20', word: 'latency', grade: 'fuzzy' }
```

`grade` 取值：`forget` / `fuzzy` / `remember` / `review`（后者是不分类的「记一次」，来自生词本抽屉的 `#dwReview`）。

### 8.3 新增消息路由

| 路由 | 作用 |
|---|---|
| `review:stats` | 返回 `{today, streak, best, total, graded, activeDays, todayCount, lastDay, days, words}` |
| `review:log` | 返回原始流水（调试/导出用） |
| `review:clear-log` | 清空流水 |
| `open-review` | 打开或聚焦 review.html |

### 8.4 备份兼容

`buildBackup()` 的 `version` 从 1 升到 2，新增 `reviewlog: await idbAll('reviewlog')`。老备份没有这个字段，恢复时按空数组处理，所以 `version` 只是标记、不参与判断。

`restoreFromBackup()` 的流水合并是**幂等**的：已存在的 id 跳过，`replace: true` 时先 `idbClear('reviewlog')`。

### 8.5 新增设置项

`DEFAULT_SETTINGS.reviewGoal = 20`（0 = 不设目标）。**放设置而不是 localStorage**，这样换机器恢复备份后目标还在。

### 8.6 一个测试脆弱点的修复

`tools/test-backup.js` 原先硬编码 `indexedDB.open('trace-subs', 2)`，DB_VER 升到 3 后抛 `VersionError: The requested version (2) is less than the existing version (3)`。已改为 `indexedDB.open('trace-subs')`（打开当前版本）。

> 教训：**测试不该跟着内部实现的版本号走**。写死版本号的测试，会在每次 schema 演进时假装自己坏了。

---

## 9. 无障碍（四条可复算的证据）

| 项 | 结果 |
|---|---|
| 文字对比度（浅色） | 主页面 196 节点 + 抽屉 48 + 复习台 209，**未达标 0** |
| 文字对比度（深色） | 同上，**未达标 0** |
| 唯一 `opacity < 1` 的节点 | `.chip.on .n`（0.85），比值 4.62(light) / 7.89(dark)，达标 |
| 热力图梯度单调性 | 浅色相邻 1.26~1.39、深色 1.63~1.74，无「两档同色」 |
| 键盘可达 | 全流程无鼠标可完成：Tab → 空格 → 1/2/3 |

**审计脚本的三个关键修正**（写在这里因为它们是可复用的方法）：

1. **分域审计**：抽屉打开时 `.scrim` 把主页面压暗 24%，会让 `.pill-new` 从 5.3 误判成 4.26。所以必须一遍关抽屉审主页面、一遍开抽屉只审 `#drawer`，失败取并集。
2. **`color(srgb ...)` 解析**：`color-mix()` 的计算结果分量是 0..1，不能当 0..255 读，否则整条算成近黑、比值误报 1。
3. **`background-image` 跳过**：渐变背景读不到，必须跳过该节点而不是用一个错的底色算出假失败。

---

## 10. 与生词本的分工（不是重复功能）

| 能力 | wordbook | review |
|---|---|---|
| 浏览 / 搜索 / 筛选 / 排序 | ✓ | — |
| 查看单词详情抽屉 | ✓ | —（卡片本身就是详情） |
| 三档评级 | ✓（抽屉内） | ✓（主流程） |
| 删除单词 | ✓ | — |
| 手动改状态 | ✓ | — |
| 每日新增柱状图 / 状态环 | ✓ | — |
| 逐卡推进的复习流程 | — | ✓ |
| 连续打卡 / 热力图 / 目标环 | — | ✓ |
| 本轮完成统计 | — | ✓ |
| 备份 / 恢复 | ✓ | —（数据同源，在 wordbook 操作） |

**三档评级两页都有，但两条路径都写同一个 `rateWord()`**，所以计数、状态、打卡流水完全一致。这是「只加不改」的具体体现：新页面没有复制一份业务逻辑。

---

## 11. 验证记录

| 项 | 命令 | 结果 |
|---|---|---|
| 复习台回归（37 项） | `node tools/test-reviewpage.js` | **PASS** |
| 生词本回归（11 项） | `node tools/test-wordbook.js` | **PASS** |
| 备份/恢复（28 项） | `node tools/test-backup.js` | **PASS** |
| 短语（21 项） | `node tools/test-phrase.js` | **PASS** |
| 字幕内背单词模式（17 项） | `node tools/test-review.js` | **PASS** |
| 全页 WCAG（浅色） | `node tools/a11y-contrast.js light` | 主页面 196 / 抽屉 48 / 复习台 209，**未达标 0** |
| 全页 WCAG（深色） | `node tools/a11y-contrast.js dark` | 同上，**未达标 0** |
| 截图（7 张） | `node tools/shot-review.js` | `errors: []` |

> 五套回归必须**串行**跑。`test-phrase` / `test-review` / `test-dict` 依赖 YouTube 夹具 + 自然播放采样，并行时会互相抢 Chrome 实例，出现大面积假失败。

`test-reviewpage.js` 首次运行有 2 项 FAIL，**都是我写错了断言、不是页面 bug**：

1. 断言「忘记了使 reviewCount +1」期望 `rc === 1`，实测 2 —— 因为抽到的第一个词种子本来就带 `reviewCount: 1`。改成与种子相对值比较。
2. 断言「本周打卡点 ≥4」，实测 2 —— 种子打卡只落在前 1/2/3 天，而「本周」只算周一到今天。改成按今天星期几动态算期望值。

---

## 12. 已知取舍（不是 bug）

| 现象 | 判断 |
|---|---|
| 音标只在单词卡上有，短语没有 | 短语本身没有音标；硬造一个会是假信息 |
| 背面「复习历史」行在新词上不出现 | 有意的：`t.reviews === 0` 时不画「第 1 次复习 · 之前忘记 0 次」这种噪音 |
| 队列按「最久没碰」排序而非随机 | 随机顺序会让用户觉得「怎么又抽到这个」，破坏「间隔重复」的心智模型 |
| `±24` 以内逐格进度条、以上退化成单条 | 200 个 4px 格子 DOM 太重，且每格细到看不清 |
| 热力图用绝对道数分档而非分位数 | 分位数会让历史颜色随当前使用量漂移，不可信 |
| 三档按钮在小窗口竖排 | 三列并排时 `.r-hint` 副文案必然截断，而它承担区分语义 |
| 侧栏 1180px 以下收成图标条 | 浏览器小窗口下内容优先；每个按钮都有 `title` 补偿 |
| 完成面板「再来一轮」无图标 | 与页头 `#restartBtn` 同一动作，重复图标增加噪音 |
| 打卡流水只记「哪一天练了 n 道」，不记「练的是哪些词」 | 后者已由 `words` store 的 `reviewCount` / `lastReview` 表达，流水再记一遍是冗余 |
| `#reviewGoal` 只可改代码默认值，页面上无 UI | 20 是个合理默认；加设置入口会让「复习台」这个单任务页面长出参数面板 |

---

## 13. 文件清单

| 文件 | 行数 | 角色 |
|---|---|---|
| `trace-subtitles/review.html` | 1402 | 结构与样式（引用 `theme.css` + `theme-tokens.css`） |
| `trace-subtitles/review.js` | 817 | 队列 / 渲染 / 评级 / 打卡面板 |
| `trace-subtitles/theme-tokens.css` | 215 | 两页共用的主题变量（本页新增 `--hm-0` ~ `--hm-4`） |
| `trace-subtitles/bg.js` | — | 新增 `reviewlog` store + `logReview` / `reviewStats` / `clearReviewLog` / `openExtPage` + 4 条路由 |
| `tools/test-reviewpage.js` | — | 37 项回归 |
| `tools/a11y-contrast.js` | — | 三区域 × 双主题对比度审计 |
| `tools/shot-review.js` | — | 7 张整页截图 |
