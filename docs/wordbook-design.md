# Trace 生词本（wordbook）—— 记忆看板设计说明

> 状态：**已落代码并全量验证通过**
> 依据：`trace-subtitles/wordbook.html`（2424 行）+ `trace-subtitles/wordbook.js`（1311 行）+ `trace-subtitles/bg.js` 新增 `rateWord` / `setWordStatus`；四套回归测试 + 全页 WCAG 审计 + 六档断点探针实测
> 载体：浏览器扩展独立网页（`chrome-extension://<id>/wordbook.html`），桌面优先，兼容浏览器小窗口

---

## 0. 先说约束怎么落成了硬指标

这份设计不是「先画再解释」，每个视觉决定背后都有一个可复算的数字。三条最硬的：

| 硬性要求 | 落地方式 | 验证方式 |
|---|---|---|
| 全部功能图标用内联 SVG，禁 emoji / 图片图标 | 源码中共 43 处 `<svg>`（`wordbook.html` 页面内 28 处静态 + `wordbook.js` 15 处模板生成；另有 5 个空的 `.kpi-spark` 容器由 JS 填 path），全部内联、`stroke="currentColor"` 继承文字色，无一处 `<img>`、无一处 emoji 字符 | `Select-String "<img\|🖼\|😀\|✅\|❌"` 零命中；图标在深浅两主题下都随 `currentColor` 变色 |
| 满足 WCAG 文本可读性 | 逐节点算相对亮度 + 对比度，按 AA 阈值判定（小字 4.5:1 / 大字 3:1） | `tools/a11y-contrast.js`：light 主页面 194 节点 + 抽屉 48 节点 **未达标 0**；dark 同 |
| 保留原有全部业务逻辑 | 只**加**不**改**：`bg.js` 新增两个消息路由与两个函数，旧路由/旧字段/旧测试全部原样 | `test-wordbook` / `test-backup` / `test-phrase` / `test-review` 四套串行跑全 PASS |

不允许自己骗自己的一条：**`a11y-contrast.js` 报 0 未达标不等于全覆盖** —— 它只遍历文本节点，`::placeholder` 这类伪元素必须单独审。这条教训直接导致 §2.6 的 placeholder 修复（原本浅色 4.11、深色 3.98，都不过）。

---

## 1. 页面布局：从上到下的五段

```
┌─ aside 208px ─┬─────────────────── main ──────────────────────────────┐
│ 品牌 mark     │ ① 页头：H1 + 副标题行        [主题][导出][导入][备份] │
│               ├──────────────────────────────────────────────────────┤
│ 视图          │ ② KPI 五卡（等宽同行）                                │
│  全部生词 15  ├───────────────────────────┬──────────────────────────┤
│  新词      4  │ ③ 柱状图卡（1.62fr）      │ 状态环卡（1fr）           │
│  记忆中    5  │   日/周/月 + 每日新增      │   环形 + 图例三行         │
│  已记住    4  ├───────────────────────────┴──────────────────────────┤
│  短语      2  │ ④ 工具栏：搜索 + 五芯片 + 批量复习占位 + 排序          │
│               │    表头六列                                           │
│ 本地备份      │    单词行 × N  ← 点击整行滑出抽屉                      │
│  [选文件夹]   │                                                       │
│  自动备份 ◯   │                                                       │
│               │                                                       │
│ 隐私脚注      │                                                       │
└───────────────┴───────────────────────────────────────────────────────┘
                                              ┌── ⑤ 抽屉 452px ──┐
                                              │ 词 + 音标     [×]│
                                              │ 释义/短语/逐词对照│
                                              │ 记忆统计四格+配额 │
                                              │ 原句·上下文 [跳转]│
                                              │ [忘记][模糊][记住]│
                                              │ 状态‖删除 记一次 跳转│
                                              └──────────────────┘
```

### 1.1 骨架尺寸

| 区域 | 规则 | 说明 |
|---|---|---|
| 外壳 | `.wrap` → `grid-template-columns: 208px minmax(0,1fr)` | 侧栏固定宽，主区吃掉剩余；`minmax(0,…)` 防止超长单词把网格撑破 |
| 侧栏 | `position:sticky; top:0; height:100vh`，`padding:22px 14px 16px` | 主区滚很长时导航与备份常驻 |
| 主区 | `padding:26px 30px 60px`，`display:flex; flex-direction:column; gap:14px` | **三段主区间距统一 14px**（页头→KPI→图表→列表），由 flex `gap` 一处决定，不靠各块零散 margin |
| 抽屉 | `width: min(452px, 92vw)`，右侧固定 | 452px 是「能放下逐词对照 + 三档按钮同行」的下限；`92vw` 保证窄窗口不被切 |

### 1.2 ① 页头

- 左：`h1` 25px/700/`-0.028em`，`Trace` 中性色 + `<span class="accent">生词本</span>` 用 `--brand-ink`。副标题行 `#subLine` 11.5px `--text-3`，内容 `共 N 条 · 已记住 N · 记忆中 N · 今天新增 N`。
- 右：`.top-tools` flex，gap 8px，四个 `.tool` 高 34px / 圆角 10px / 1px `--line-2` 边框 / `--ink-2` 底。
- 主次：前三个是次级（白底灰字），第四个 `#backupBtn` 加 `.tool-key`（`--gold-soft` 底 + `--gold-line` 边 + `--brand-ink` 字 + `font-weight:650`）。**只有备份有品牌金**，因为它是这页唯一「产生文件」的动作。
- `#themeBtn` 是唯一带文字的图标按钮：左图标右文案（`浅色` / `深色`），文案由 `applyTheme()` 写入 `#themeLabel`。

### 1.3 ② KPI 五卡

`#kpis` → `display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px`。

**为什么是 grid 不是 flex**：试过 `flex:1 1 168px` 自动折行，1440 下 5 张/行，但 1020 与 860 下稳定出现 `[4,1]` —— 第二行只剩一张，右侧空一整格。等宽 grid 在任何宽度都不会落单，窄窗口用媒体查询显式改写（§7）而不是靠折行运气。

每张卡内部固定四层：

| 层 | 类 | 规格 |
|---|---|---|
| 标签 + 图标 | `.kpi-top` | `justify-content:space-between`；标签 11px/550 `--text-3` `nowrap`；图标块 22×22 圆角 7px |
| 主数字 | `.kpi-val` | 24px/700/`-0.035em`/`line-height:1.05`；`.sm` 18px（只用于「遗忘率」的整数部分） |
| 副标题 | `.kpi-delta` | 11px `--text-3`，`min-height:16px` 保证五卡等高；`b` 650 `--text-1` `tabular-nums` |
| 迷你折线 | `.kpi-spark` | 22px 高，`viewBox 0 0 120 26`，`preserveAspectRatio:none` |

五张卡的语义分工：

| # | 主标签 | 主数字 | 副标题 | 图标色 | 折线语义 |
|---|---|---|---|---|---|
| 1 | 总词汇 | `#kTotal` | 本周新增 `+N` | 金 `--gold-soft`/`--brand-ink` | 近 14 天累计存量（含 14 天前基线） |
| 2 | 今日新增 | `#kToday` | 昨日 `N` · `±N` | 紫 `--violet-soft`/`--violet` | 近 14 天每日新增 |
| 3 | 待复习 | `#kDue` | 间隔复习已到期 `N`，或「都掌握了 · 已记住 N」 | 琥珀 | 未掌握存量近似 |
| 4 | 总复习次数 | `#kReviews` | 已记住 `N` · 掌握率 `N%` | 绿 | 近 14 天有复习动作的词数 |
| 5 | 平均遗忘率 | `#kForget` = `<span class="sm">N</span>%` | 共忘记 `N` 次 | 红 | 累计遗忘次数 |

两条**只在有数据时才亮**的强化：

- 第 3 张卡在 `due > 0` 时加 `.kpi.due` → 边框换 `--gold-line`、图标底换 `--gold-soft`。积压为 0 时不加，免得「没有待复习」也像警报。
- 第 5 张卡在 `forgetRate > 0` 时给主数字加 `.kpi-val.neg` → `--red`。**0% 不标红**，否则「学得不错」被涂成警告色。

### 1.4 ③ 图表双卡

`.charts` → `grid-template-columns:minmax(0,1.62fr) minmax(0,1fr); gap:12px`。左卡放柱状图，右卡放状态环。

两卡 `align-items` 默认 `stretch` 所以等高，但右卡内容天生比左卡矮 —— 若不处理，顶对齐时右卡底部会空出一条。`.chart-card{display:flex;flex-direction:column}` + `.chart-card > .donut-wrap{flex:1 1 auto;align-items:center}` 让环形组吃掉剩余高度并垂直居中。

### 1.5 ④ 工具栏 + 列表

`.list-card{padding:0; overflow:hidden}`（自带卡片边框，内部不再套 padding）。工具栏 `.list-tools` 12px 14px、底边框 1px。六列表头 `.row-head` 与行 `.wrow` **共用同一条 grid 声明**，从结构上保证对齐：

```css
.row-head, .wrow {
  display: grid;
  grid-template-columns: 26px minmax(0,1.02fr) 96px minmax(0,1.55fr) 74px 58px;
  align-items: center;
  gap: 10px;
}
```

六列语义：`图标` / `单词·短语 + 徽章 + 忘记次数` / `音标（短语行为来源标签）` / `释义·上下文` / `加入时间` / `操作`。96px 定宽音标列是关键 —— 不定宽时不同长度 IPA 会把释义列推得左右跳。

### 1.6 ⑤ 抽屉

三段落：`.dw-hd`（不滚）+ `.dw-body`（`overflow-y:auto`）+ `.dw-foot`（不滚）。底部操作条任何时候都可见，不用滚到底才能复习。

`.dw-foot` 布局：`状态[select] ‖ 删除 | spacer | 记一次 | 跳到视频`。中间 `.dw-div`（1px × 16px 竖线）把「设置类」和「动作类」分开，`.spacer`（`flex:1 1 auto`）把动作簇推到右侧。

---

## 2. 色彩规范

### 2.1 主题机制

两套完整 token 块挂在 `html[data-theme="light|dark"]` 上，`:root` 只放与主题无关的品牌色。

```css
:root { --gold:#ffd76e; --gold-2:#ffbe3d; --brand-ink:#6b5518; }
html[data-theme="light"] { … 40 个 token … color-scheme:light }
html[data-theme="dark"]  { … 同名 40 个 token … color-scheme:dark }
```

**为什么是作用域覆盖而不是改 `theme.css`**：`popup.html:6` 也 `<link rel="stylesheet" href="theme.css">`，那份文件的 `:root` 定义的是墨黑深色。改它等于把 popup 一起改坏。所以 `theme.css` 一行不动，浅色主题全部靠 `html[data-theme="light"]` 的同名变量覆盖 + 少数选择器覆写（`.chip.on` / `.pill-new` / `.rate-*`）。

切换时 `applyTheme(next, animate)` 给 `<html>` 加 `.theme-anim` 420ms，只过渡 `background-color / border-color / color`，**不碰 layout 属性**，避免切换瞬间出现尺寸跳动。

三处主题偏好持久化：`localStorage['wb-theme']`（内联脚本在 `<head>` 里先读，防首帧闪白）+ 扩展设置 `settings.wbTheme`（`popup` 与下次打开共用）+ 按钮 `aria-label` 报当前态。

### 2.2 浅色主题 token（默认）

| token | 值 | 用途 | 对比度实测 |
|---|---|---|---|
| `--ink-0` | `#f7f5f0` | 页面底（暖白） | — |
| `--ink-1` | `#fbfaf7` | 抬升面（侧栏、抽屉底栏） | — |
| `--ink-2` | `#ffffff` | 卡片 | — |
| `--ink-4` | `#f1eee7` | 下沉 / hover / 行首字母块 | — |
| `--line` | `rgba(31,26,18,.07)` | 卡片边框、行分隔 | — |
| `--line-2` | `rgba(31,26,18,.11)` | 按钮边框、网格线 | — |
| `--line-3` | `rgba(31,26,18,.18)` | 顶部刻度线、y=0 基线 | — |
| `--text-1` | `#211d16` | 正文主色 | **16.77:1** |
| `--text-2` | `#5d564a` | 次级正文 | **7.25:1** |
| `--text-3` | `#635c50` | 元信息、轴刻度、日期 | **6.61:1** |
| `--text-4` | `#7a7263` | 最弱提示 | **4.76:1** |
| `--gold` | `#ffd76e` | 品牌金（仅作填充/渐变，不当文字色） | 1.38:1（**故意不用于文字**） |
| `--gold-2` | `#ffbe3d` | 金色渐变终点 | — |
| `--gold-soft` | `rgba(255,215,110,.26)` | 选中芯片底、主按钮底 | — |
| `--gold-line` | `rgba(196,152,36,.38)` | 金边（待复习卡、选中芯片） | — |
| `--brand-ink` | `#6b5518` | **浅底上的金族文字** | **7.15:1** |
| `--violet` | `#6558c4` | 短语标识 | 5.61:1（压紫软底 4.80） |
| `--green` | `#327356` | 已记住 / 正向 | 5.64:1（压绿软底 4.93） |
| `--amber` | `#8c5626` | 模糊 / 中向 | 6.04:1（压琥珀软底 4.97） |
| `--red` | `#9e4e4d` | 新词 / 记忆中 / 负向 | 5.75:1（压红软底 4.97） |
| `--slate` | `#726d61` | 中性回退 | 5.15:1 |
| `--danger` | `#a54643` | 删除 | 5.9:1（压危险软底 5.11） |
| `--scrim` | `rgba(41,34,22,.24)` | 抽屉遮罩 | — |

**为什么灰阶是四级而不是三级**：`--text-4` 4.76:1 仍在 4.5 之上，但它承载的是 9~10.5px 的日期、轴刻度、忘记次数。WCAG 对**小字**要求 4.5:1，对 ≥18.66px 或 ≥14px 粗体才放宽到 3:1。这页 90% 的文字都是小字，所以最浅的一级也必须守 4.5。原来的 `#a9a094` 只有约 3:1 —— 那是按大字号标准配的，用在小字上是不达标的。

### 2.3 深色主题 token（切换后）

| token | 值 | 对比度实测 |
|---|---|---|
| `--ink-0` / `--ink-1` / `--ink-2` / `--ink-3` / `--ink-4` | `#060608` / `#0b0b10` / `#101017` / `#16161f` / `#1d1d28` | — |
| `--line` / `--line-2` / `--line-3` | `rgba(255,255,255,.07/.11/.18)` | — |
| `--text-1` | `#f6f6f8` | **17.55:1** |
| `--text-2` | `#9d9dab` | **7.08:1** |
| `--text-3` | `#85858f` | **5.19:1** |
| `--text-4` | `#7b7b85` | **4.52:1** |
| `--brand-ink` | `#ffd76e` | **13.71:1** |
| `--violet` / `--green` / `--amber` / `--red` / `--slate` | `#8b7ff0` / `#46d39a` / `#f5a623` / `#e08684` / `#7d8798` | 5.77 / 9.96 / 9.35 / 7.14 / 5.22 |

深色下原本的 `--text-3/4` 是 `#66666f` / `#46464e`，在 `--ink-2(#101017)` 上只有 **3.3:1 / 2.1:1** —— 它们承载日期、轴刻度这类小字，必须抬到 5.19 / 4.52。层级关系（1 > 2 > 3 > 4）不变，只是整条灰阶往上平移。

`--brand-ink` 在深色下必须是亮金而非暗金：深黑底上 26% 金底 + 暗金字会掉到 4.5 以下。这导致深色下备份按钮「黄字黑底」比浅色下「暗金字浅金底」看起来更亮 —— **这是深色主题的必然结果，不是不一致**。

### 2.4 记忆状态语义色（需求指定的核心编码）

需求规定「新词、记忆中使用低饱和柔和红，已记住使用低饱和柔和绿」。红族里要区分两种状态，用了**三层编码**：

| 状态 | 文字色 | 徽章底 | 圆点 | 行首色条 |
|---|---|---|---|---|
| 新词 | `--red` | `color-mix(in srgb, var(--red) 7%, transparent)` + `inset 0 0 0 1px color-mix(…18%…)` 描边 | **空心**（`::before{background:transparent; box-shadow:inset 0 0 0 1.5px currentColor}`） | 2px `--red` @50% |
| 记忆中 | `--red` | `--red-soft`（12% 实底） | **实心** | 2px `--red` @85% |
| 已记住 | `--green` | `--green-soft` | 实心 | 2px `--green` @70% |

三层的意义：
1. **圆点空/实** —— 色弱也能分（不依赖色相）。
2. **底色深浅** —— 正常视觉一眼分。
3. **文字** —— 状态名本身就在徽章里。

`.pill-new` 的 7% 底几乎等于没有，会散成一串浮字，所以额外给 1px 18% 红描边把它收成胶囊，同时仍比「记忆中」浅一档。**顺序是「新词最淡 → 记忆中实 → 已记住换色相」**，读起来就是从「还没学」到「学会了」的进度感。

图表填充色单独一组（`--st-*-fill`），只用于环形图，不承载文字，所以不求 4.5，只求同段可辨、相邻段可分：

| token | 浅色 | 深色 | 说明 |
|---|---|---|---|
| `--st-new-fill` | `#bb7a78` | `#8b5a59` | 新词最淡 |
| `--st-learning-fill` | `#9c5150` | `#cf8d8b` | 记忆中加深 |
| `--st-learned-fill` | `#33785a` | `#46d39a` | 已记住换绿 |

新词与记忆中同属红族，明度差在 132px 的环上不足以分开，所以 `renderDonut()` 在段与段之间留 **1.4% 的中性缝**（填 `--ink-2`），用「缝」代替「对比度」：

```js
const GAP = live.length > 1 ? 1.4 : 0;   // 只有一段时不留缝，否则整圈被切出莫名其妙的缺口
stops.push(`var(--ink-2) ${(s.from - GAP/2).toFixed(2)}% ${(s.from + GAP/2).toFixed(2)}%`);
```

实测输出（15 词：已记住 26% / 记忆中 33% / 新词 40%）：
`conic-gradient(var(--st-learned-fill) 0% 25.97%, var(--ink-2) 25.97% 27.37%, var(--st-learning-fill) 27.37% 59.30%, var(--ink-2) 59.30% 60.70%, var(--st-new-fill) 60.70% 100%)`。
段序固定 `learned → learning → new`，从 12 点顺时针 —— 越靠前越接近「已学会」，与列表排序方向一致。

### 2.5 走势线专用色（`--spark-*`）

KPI 的五条迷你折线是**图形对象**，WCAG 1.4.11 要求 3:1。但它们原来直接复用语义色，其中 `--gold #ffd76e` 压白卡只有 **1.38:1** —— 一条 1.4px 的线等于隐形。

修法不是用 `!important` 覆盖内联 `style`，而是新增一组只给描边用的 token（同色相、压深到 3.5:1 以上）：

| token | 浅色 | 白底 | 深色 | 黑底 |
|---|---|---|---|---|
| `--spark-gold` | `#8a6a1f` | **5.05** | `#ffd76e` | 13.71 |
| `--spark-violet` | `#6558c4` | 5.61 | `#8b7ff0` | 5.77 |
| `--spark-new` | `#9c5150` | 5.67 | `#cf8d8b` | 8.4 |
| `--spark-learning` | `#8a423f` | 7.16 | `#e08684` | 7.14 |
| `--spark-learned` | `#33785a` | 5.28 | `#46d39a` | 9.96 |

金色这一档比另外四条再深：金的天生明度高，4.02 时 3x 放大仍能与别条拉开，整页缩略看还是偏淡，取 5.05 才五条齐平。

深色主题新增一条 `html[data-theme="dark"] .kpi-spark{opacity:.82}`：同一条色在深底上的相对亮度远高于白底，会先于大数字抢视线。**只降透明度不改色值** —— 改色会让五张卡的颜色语义（金=累计、紫=本周、红=忘记、绿=记住）散掉。

### 2.6 组件覆写（theme.css 不能改，只能就地压）

| 选择器 | 原值（为墨黑底设计） | 覆写后 | 原因 |
|---|---|---|---|
| `html[data-theme="light"] .chip.on` | `color: var(--gold)` | `color: var(--brand-ink)` + `border-color: var(--gold-line)` | 浅金压浅金底几乎读不出来，实测原色只有 ~1.5:1 |
| `.search-box .input::placeholder` | `color: var(--text-4)`（4.11 / 3.98） | `color: var(--text-3)`（**5.70 / 4.57**） | 提示语该轻，但轻不等于读不出来 |
| `.pill-new` | theme.css 无此选择器 | 7% 底 + 18% 描边 + 空心圆点 | 见 §2.4 |
| `.rate-*` | theme.css 无 | 常态带色底（§5.6） | 三档按钮必须一眼分得清 |
| `.seg button.on::after` | `background: var(--ink-4)` + 黑投影 | `background: var(--ink-2)`；dark 用 `--ink-4` | 浅色下 `--ink-4` 的选中块比父级还暗，会显脏 |

### 2.7 圆角 / 阴影 / 字体 / 缓动

| token | 值 | 用在哪 |
|---|---|---|
| `--r-sm` | 8px | 小控件 |
| `--r-md` | 11px | KPI 卡、评级按钮、统计四格 |
| `--r-lg` | 16px | 图表卡、列表卡 |
| `--font-display` | Segoe UI Variable Display / SF Pro Display | H1、单词、行首字母 |
| `--font-body` | Segoe UI Variable Text / SF Pro Text | 正文、按钮 |
| `--font-mono` | Cascadia Mono / SF Mono / JetBrains Mono | 数字、音标、日期、轴刻度、快捷键（全部配 `tabular-nums`） |
| `--ease` | `cubic-bezier(.22,1,.36,1)` | 位移、缩放（抽屉、行入场） |
| `--ease-io` | `cubic-bezier(.4,0,.2,1)` | 颜色过渡 |

阴影三层，全部低透明度暖灰（深色转黑）：

```css
/* light */
--shadow-sm:   0 1px 2px rgba(31,26,18,.05), 0 1px 1px rgba(31,26,18,.03);
--shadow-card: 0 1px 2px rgba(31,26,18,.04), 0 8px 24px -12px rgba(31,26,18,.14);
--shadow-pop:  0 2px 6px rgba(31,26,18,.06), 0 24px 60px -20px rgba(31,26,18,.28);
/* dark */
--shadow-sm:   0 1px 2px rgba(0,0,0,.5);
--shadow-card: 0 1px 2px rgba(0,0,0,.45), 0 10px 30px -16px rgba(0,0,0,.8);
--shadow-pop:  0 30px 80px -24px rgba(0,0,0,.9);
```

`.card::before { display: none }` —— theme.css 给 `.card` 加的顶部内高光是为墨黑底做的，浅色卡上会变成一道多余的白线。用 `display:none` 关掉而不是删 theme.css 的规则（popup 还在用）。

---

## 3. 组件清单：状态与行为

### 3.1 侧栏

| 组件 | 元素 | 状态 |
|---|---|---|
| 品牌块 | `.brand .mark`（26×26，金色渐变 `140deg`，字 `T` 800）+ `.brand-name` + `.brand-sub` | 静态 |
| 分组标签 | `.side-label`（10px/650/`letter-spacing:.1em`/uppercase/`--text-4`） | 两个：「视图」「本地备份」 |
| 视图导航 | `#sideNav button[data-view]` × 5 | 默认 `--text-2`；hover `--ink-4` + `--text-1`；`.on` = `--gold-soft` 底 + `--gold-line` 边 + `--brand-ink` 图标 + `.count` 同色；图标常态 `opacity:.62`，`.on` 时 1 |
| 备份文件夹 | `#pickDirBtn.bk-dir` | 未选：`1px dashed --line-2`；已选：`solid --gold-line` + `--text-1`（`.bk-dir.set`） |
| 切换开关 | `#autoBackup`（`.switch` 38×21） | 关：`--ink-4` 轨道；开：金轨 + 滑块 `translateX(17px)`（2+17+15=34 < 内宽 36，不溢出） |
| 隐私脚注 | `.side-foot` | 10.5px `--text-3`，上边框 `--line`，内含 `code` 文件名（10px/`--text-2`/`--ink-4` 底/`break-all`） |

**侧栏的垂直分布**是刻意的：`.side-label.push{margin-top:auto}` 把「本地备份」组一次推到顶部区块下方，`.side-foot{margin-top:4px}` 跟在它后面。早先两处都写 `margin-top:auto` 会把空白一分为二、把备份块吊在 486→841 之间那 355px 的空洞里。现在导航钉顶、备份+隐私钉底。

侧栏还带 `overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin`：窗口高 <620px 时导航+备份+脚注会超过 100vh，宁可侧栏自己滚，也不能把「数据只存在本机」那行裁掉。实测 1280×560 时侧栏 `scrollH 610 / clientH 560 / overflow 50`，可滚到底。

1020px 以下整条侧栏折成 64px 图标条（文字 `display:none`），所以五个 `#sideNav button` 都补了 `title`（全部生词/新词/记忆中/已记住/短语）—— 图标条没有 tooltip 就完全不可知。

### 3.2 页头四按钮

| id | 文案 | 图标 | 行为 |
|---|---|---|---|
| `#themeBtn` | `浅色` / `深色` | 月亮 ⇄ 太阳交叉淡入（绝对定位重叠，`opacity` + `rotate(-40deg) scale(.7)` 过渡） | 切 `html[data-theme]` → 加 `.theme-anim` 420ms → 写 `localStorage` + `settings:set{wbTheme}` → 更新 `#themeLabel` 与 `aria-label` |
| `#exportBtn` | 导出备份 | 下载到托盘 | `word:export` → 取全量 → `Blob` + `a.download`，文件名 `trace-words-YYYY-MM-DD.json` → toast `已导出 N 条到本机文件` |
| `#restoreBtn` | 导入恢复 | 从托盘上传 | 先试 `backup:read-dir`（找固定备份文件）；没有则弹 `input[type=file]` → `doRestore(data, replace)` → toast |
| `#backupBtn` | 立即备份 / 备份中… | 软盘/归档盒 | `backup:save` → 按 `via==='dir'` 或 `下载/` 两种来源拼 toast；按钮 `disabled` 期间文案换「备份中…」，`finally` 还原 `#backupLabel` 原文 |

主按钮 `#backupBtn` 的 label 必须走 `#backupLabel` 这个子 span 而不是 `btn.textContent`，否则会把 SVG 一起清掉（这是原实现就踩过的坑，`test-backup.js` 直接断言 `.side-foot` 文本含文件名）。

### 3.3 KPI 卡

见 §1.3。交互：无点击行为，纯展示。唯一动态态是 `.kpi.due`（积压 > 0）与 `.kpi-val.neg`（遗忘率 > 0）。

### 3.4 柱状图（左卡）

`.chart-card` 内含 `.card-hd`（标题「每日新增」+ `#chartSub` 副标题 + `.seg` 粒度切换）+ `.chart-wrap`。

`.chart-wrap` 是 `position:relative; padding-left:26px; overflow-x:clip`：

- `padding-left:26px` 给 y 轴刻度留出**绘图区之外**的窄槽，柱子不会压字。
- `.chart-grid` 绝对定位 `inset: 0 7px 18px 33px` —— 26px 轴槽 + 7px 内缩，与 `.bars` 的 `padding: 0 7px 18px` 严格对齐，否则网格线会比柱子两端各多出一截。
- `.chart-grid::after` 画 y=0 基线（`--line-3`），柱子需要落脚点，否则一排柱脚像浮在半空。
- `overflow-x:clip` 是兜底：最右柱的浮动提示曾横向溢出几个像素把整页顶出滚动条。clip 只裁横向、不建滚动容器，纵向浮层照旧可见。

网格线 `bottom:${p}%`，**绝不能写 `calc(18px + p% * ((100% - 18px)/100%))`** —— CSS calc 里百分比不能乘百分比，整个值无效，四条线会全部叠成一条（实际踩过，`probe-gridlines` 量到四条 y 全等 290.7）。

| 元素 | 规格 | 说明 |
|---|---|---|
| `.bars` | `height:128px; padding:0 7px 18px; gap:3px; align-items:flex-end` | 左右各 7px 内缩：日期标签以柱心对齐，首尾标签会比柱体宽出半个字宽 |
| `.bar-fill` | 圆角 `4px 4px 2px 2px`，金色渐变 `opacity:.9` | 浅色另有 `#ffdc85 → #f3c14e` 专用渐变（品牌金在白底偏淡） |
| `.bar-empty .bar-fill` | `--line-2` + `opacity:1` | 空桶也要画 1.5% 高的可视底，否则那几天像不存在 |
| `.bar-x` | `bottom:-18px`（落进下内边距带） | 原 `bottom:0` 会压住轨道最底 14px，只要某天柱顶到刻度上限（fill 满高 110px）就把日期盖住 |
| `.grid-y` | 10px `--text-3` `tabular-nums`，`right:calc(100%+5px)` | 与 `.bar-x` **同为 10px** —— 同一个坐标系的两条轴，字号不一致会让日期看起来像另一种元信息 |
| `.bar-tip` | hover 浮层，`background:--text-1` / `color:--ink-2` | 首末柱单独改成贴边（`left:0` / `left:auto;right:0`），居中浮层 90px 宽会顶出卡片 |

`.seg`（日/周/月）：`margin-left:auto` 推到右端；`--ink-4` 底；选中项 `.on::after` 用 `--ink-2` + `--shadow-sm`（深色改 `--ink-4`）。三个按钮 11.5px，`padding:5px 0`，各占 1/3 宽。

`.grid-y` 是这套界面最后一个 9px 的地方，已抬到 10px —— 它是纵轴的**读法依据**，不是装饰性元信息。

### 3.5 状态环（右卡）

`.donut-wrap`（`justify-content:center; gap:18px`）内两件：

**环形** `.donut` 132×132，`background` 由 JS 写 `conic-gradient`；`::after` 是 `inset:13px` 的同底色圆挖空 —— **`inset` 值就是环宽**（132px 上 13px 约占半径 20%），不是内边距。环心 `.donut-center` 叠 `#donutNum`（24px/700）+ `.donut-lbl`「总词汇」。零数据时 `background: var(--ink-4)` 画一个满圆底。

**图例** `.legend`（`flex:0 1 136px; min-width:118px; gap:4px`）三行 `.lg`，每行 = 色块 + 名称 + 数值 `#kLearned/#kLearning/#kNew` + 百分比。三行都是 `<div>` 可点击，点击切到对应视图（与侧栏、芯片三处联动，`syncSideNav()` 统一 `toggle('on')`）。

图例不铺满剩余宽度的原因：铺满时「已记住」与右侧数字之间会被 `margin-left:auto` 拉出 150px 真空，整组内容被推到卡片左半边。给一个内容量级的固定宽度后，剩下的留白交给 `.donut-wrap{justify-content:center}` 均分到两侧（实测右卡 `rightGap` 从 159 收到 ~68）。

### 3.6 工具栏

| 组件 | 规格 | 状态 |
|---|---|---|
| `.search-box` | `flex:1 1 210px; max-width:300px; min-width:150px` | 输入框 32px 高，左 31px padding 放放大镜、右 28px 放清除钮；常态 `--ink-4` 底 + 透明边；`:focus` → `--ink-2` 底 + `--gold-line` 边，且 `+ svg` 图标转 `--brand-ink` |
| `#qClear` | 20×20，`display:none` | `.search-box.has-value` 时才 `display:grid` |
| `.chip[data-f]` × 5 | `height:32px; padding:0 12px` | 与搜索框、下拉**同高 32px**（theme.css 原 `padding:4px 10px` 只有 27px）；`.on` 见 §2.6；每个芯片带 `.n` 计数 |
| `.tools-spacer` | `flex:1 1 0` | 把批量复习与排序推右 |
| `#batchBtn` | `1px dashed --line-2` 透明底 + `.soon`「即将支持」小标 | UI 占位。`aria-disabled="true"`，但**可聚焦、点击给解释性 toast**（ARIA APG 对「暂不可用但需说明原因」的推荐写法）。注意 Playwright 会拒绝点 `aria-disabled` 元素，端到端测试需 `{force:true}` |
| `#sort` | 32px 高、`--ink-2` 底、内联 data-URI 箭头 | 四项：加入时间排序 / 优先遗忘最多 / 优先已记住 / 优先最早加入 |

五个芯片的计数来自 `renderKPIs()` 的 `setCount()`，与侧栏同一份数据（`#fAll/#fNew/#fLearning/#fLearned/#fPhrase`）。芯片是 `<span>` 而非 `<button>`（沿用原实现，`test-wordbook.js` 的 `document.querySelectorAll('.chip[data-f]')` 依赖它是 span，改成 button 会让 CSS 与测试同时变动，收益为零）。

### 3.7 列表行

`.wrow` 六格 + 行首 2px 状态色条（`::before`）。整行 `role="button" tabindex="0"`，`aria-label="${词}，${状态}"`。

| 格 | 内容 | 细节 |
|---|---|---|
| 1 | `.w-ico` 26×26 圆角 8px | 单词显示首字母（`--font-display`）；短语显示 `PHRASE_SVG` 三横线 + 紫底 `--violet-soft` + 紫字 `--violet` |
| 2 | `.w-word` | `.w-txt` 13.5px/600 单行 ellipsis + `.pill.pill-<状态>` + `.w-forget` |
| 3 | `.w-phon` 96px 定宽 `text-align:right` | 单词显示 IPA（10.5px `--font-mono` `--text-2`）；**短语改显示来源**（`.`+ 大模型/机翻/直译，`--font-body` `--violet` 前置 4px 圆点） |
| 4 | `.w-zh` 12px `--text-2` `line-clamp:2` | 释义摘要 |
| 5 | `.w-date` 10.5px mono `--text-3` 右对齐 | `YYYY/MM/DD` |
| 6 | `.w-act` | `opacity:.7`，`:hover/:focus-within` → 1；两个 24×24 图标按钮 |

`.w-act` 常态 0.7 而不是 0 或 0.35：这两个图标是该行**仅有的可点击控件**，按 WCAG 1.4.11「识别界面组件所必需的视觉信息」需 3:1 非文本对比度。`--text-3` 在白卡 6.61:1，压到 0.35 只剩 1.70:1（形状读不出来）；0.7 是临界点 —— 浅色 3.30、深色 3.13。原来写 0 时是「必须把指针移上去才知道这行能操作」。

`.w-forget`：`--ink-4` 底 + `--text-2`，前面一个小 ×。**≥3 次升级 `.hot`**（`--red-soft` 底 + `--red` 字）。这是负向信号，不该是全页最淡的元素。

空态 `.empty` 分两种文案：`all.length` 有值但筛不出 → 「这个筛选下没有词 / 换个状态、清空搜索，或切换排序试试」；库本身空 → 「词库还是空的 / 在 YouTube 字幕里点击单词或短语，就会存进这里」。

### 3.8 抽屉

| 区块 | 内容 | 规格 |
|---|---|---|
| `.dw-hd` | `#dwWord` 22px/700 + `#dwPhon` 11.5px mono + `#dwClose` 28×28 | 下边框 `--line` |
| 释义块 | `.dw-tag`（短语标识，紫）+ `.dw-zh` 15px/600 + `.dw-literal`（逐词直译）+ `.dw-note`（琥珀底提示） | 短语专有 |
| 逐词对照 | `.dw-words` 内 `.dw-wrow`：`b` 单词（68px min）+ `span` 释义 | 只在短语且 `words[]` 非空时出现 |
| 英文释义 | `.dw-mean`：`.pos` 词性（mono 10.5px `--brand-ink` 22px min）+ 释义 | 最多 4 条 |
| 记忆统计 | `.dw-stat` 四格（总复习/忘记/模糊/记住）+ `.dw-mix` 配额条 + `.dw-mix-leg` 图例 | 见 §5.5 |
| 原句 | `.dw-quote`（`--ink-4` 底 + 2px 金左边框）+ `<em>` 高亮命中词 + `.q-zh` 译文（虚线分隔） | `.q-zh` 用 `--text-2` 与英文原句同权重 —— 译文是学习者真正在读的那一行 |
| 评级区 | `.rate-row` 三按钮（区头「这次想得起来吗」） | 见 §5.6 |
| 记录区 | `.dw-stat` 三格（当前状态 / 加入时间 / 上次复习），`grid-template-columns:repeat(3,1fr)` | `.v` 降到 12px —— 这三格装的是文字与日期，不是需要放大的计数 |
| 底部 | `状态 ‖ 删除 | spacer | 记一次 | 跳到视频` | 见 §1.6 |

`highlightWord(text, word)` 把命中词包成 `<em>`（金底 + 底部金线 + 600 字重）。`.dw-quote em` 的 `box-shadow: inset 0 -1px 0 var(--gold-line)` 给高亮补一条底线，纯色块在长句里边界不清。

---

## 4. 交互行为

### 4.1 主题切换

```
点击 #themeBtn
 → next = (当前 === 'light') ? 'dark' : 'light'
 → applyTheme(next, true)
     ├ 加 .theme-anim（420ms 后移除）
     ├ html.dataset.theme = next
     ├ localStorage['wb-theme'] = next
     ├ #themeLabel.textContent = next === 'light' ? '浅色' : '深色'
     └ #themeBtn.setAttribute('aria-label', 当前态说明)
 → settings:set{ wbTheme: next }（catch 忽略，popup 与下次打开沿用）
```

首次加载时 `<head>` 内联脚本先读 `localStorage['wb-theme']` 写 `data-theme`，`wordbook.js` 的 `applyTheme(localStorage['wb-theme'] || 'light', false)` 不带动画再确认一次；扩展开启时会拿 `settings.wbTheme` 优先，保证跨页一致。

### 4.2 筛选与排序（三处联动）

侧栏按钮、芯片、图例三处都能切 `view`，全部收敛到 `syncSideNav()`：

```js
function syncSideNav() {
  #sideNav button  → toggle('on', b.dataset.view === view)
  .chip[data-f]    → toggle('on', c.dataset.f === view)
  #legend .lg      → toggle('on', l.dataset.v === view)
}
```

`visibleWords()` 的顺序是「先视图过滤 → 再搜索 → 最后排序」：

- `view === 'phrase'` → 只要 `kind === 'phrase'`（按类型，不按状态）
- `view === 'new'|'learning'|'learned'` → `st(w) === view` **且 `!isPhrase(w)`**（短语不混进状态视图，它们的记录结构不同：没有音标/词性，有逐词对照）
- 搜索对 `word / zh / context / contextZh` 四个字段做小写包含匹配
- 排序四种：`new`（createdAt 降序）/ `forget`（forgetCount → reviewCount → createdAt 三级降序）/ `learned`（learned=0 / learning=1 / new=2 的 rank 升序，组内 reviewCount 降序）/ `old`（createdAt 升序）

**为什么短语不在状态视图里**：混进单词列表既占位置又难扫读；而短语本身也有学习状态（行首色条 + 徽章照常显示），「这条记不记得住」在短语视图里照样看得到。

### 4.3 搜索

- `input` 事件即时过滤（无防抖 —— 本地数组过滤，量级在几百条以内，防抖反而增加延迟感）
- `.search-box` 的 `has-value` 类控制清除钮显隐（`$('qClear').parentElement.classList.toggle(...)`）
- 非抽屉态按 `/` 聚焦搜索框（`e.preventDefault()` 阻止 `/` 被输入）
- 清空后行数还原

### 4.4 打开 / 关闭抽屉

```
点击 .wrow（或 Enter / 空格）
 → openDrawer(word)
     ├ all.find 找记录（找不到直接 return）
     ├ selected = w
     ├ renderDrawer(w)
     ├ #drawer.classList.add('open')     → transform: translateY(-14px) → none，0.32s
     ├ #scrim.classList.add('on')        → opacity 0 → 1，0.24s + backdrop-filter: blur(2px)
     ├ body.style.overflow = 'hidden'
     └ 40ms 后 #dwClose.focus()          → 焦点进抽屉，Tab 不会留在背后
关闭：点 scrim / 点 #dwClose / Esc
 → closeDrawer()：移除两个 class、body.style.overflow = ''、selected = null
```

**入场方向**：需求写的是「向下滑出」，实现为 `translateY(-14px) → none` —— 从上方 14px 处落到位置，同时 opacity 淡入。视觉上是「从行位置向下展开」，而不是从右侧推进来（那会像另一个页面）。这个偏移量刻意做小（14px），大了会像整体漂移。

### 4.5 三档评级（新增的核心交互）

```
点击 .rate[data-rate=forget|fuzzy|remember]（或按 1 / 2 / 3）
 → 立刻给按钮加 .flash（0.42s scale 0.96 → 1.015 → 1）—— 先反馈再等回包
 → chrome.runtime.sendMessage({ type:'word:rate', word, grade })
 → bg.js rateWord(word, grade)：
     reviewCount += 1
     forgetCount / fuzzyCount / rememberCount 各自 += 1
     lastReview = Date.now()
     status = (grade === 'remember') ? 'learned' : 'learning'
     idbPut → broadcastWordsChanged() → scheduleAutoBackup()
 → reload() → 全量重渲染（KPI / 环 / 柱 / 行 / 抽屉原地刷新，不重播入场动画）
 → toast「已记一次遗忘 / 已记一次模糊 / 已标记记住 · 明天再来一遍」
```

**关键设计：删了「新词」这个回退**。「忘记了」的语义是「这次没想起来」，但它仍然是一次已发生的复习 —— 把状态打回 `new` 会让这个词从学习进度里消失，`reviewCount` 却在涨，两者矛盾。所以 forget 与 fuzzy 都落到 `learning`，只有 remember 直接进 `learned`。

**评级之后 `reviewCount` 的语义**：它仍是「总复习次数」，与 `forget+fuzzy+remember` 并行存在。老记录（评级功能上线前复习过的）只有 `reviewCount` 没有细分，`tally()` 把差额算成 `untagged`，**不凭空填进任何一档**：

```js
const untagged = Math.max(0, reviews - forget - fuzzy - remember);
```

`untagged` 只在存在时出现在配额条与图例里，且色块用 `--text-4` + 0.42 透明度并标「未分类」。

### 4.6 底部「记一次」（`#dwReview`）为什么保留

它走的是旧路由 `word:review`：`reviewCount + 1`，`status = reviewCount >= 3 ? 'learned' : 'learning'`。**保留了**，理由三条：

1. 它是原有业务逻辑的一部分（需求要求完整保留），列表行的快捷 ✓ 也走同一条路。
2. 有些时候用户只想「记一次」而不想评判自己记得牢不牢 —— 强迫三选一反而增加决策成本。
3. `test-wordbook.js` 直接断言点 `#dwReview` 后 `pipeline` 的徽章从「新词」变「记忆中」且 `kLearning` 从 2 变 3。把三档评级的「记住了」接到这个 id 上会让 pipeline 直接变 `learned`，该断言立刻失败。

但它**降级成次级样式**（`.btn-sm.btn-ghost`，透明底 + `--line-2` 边 + `--text-3` 字），文案从「标记复习」改成「记一次」，图标换成环形箭头，title 写「只记一次复习（不区分记得牢不牢，快捷键 R）」。原来它是金色 `btn-primary`，会和上方三档评级抢注意力 —— 三档才是主操作。

### 4.7 手动设置状态

`#dwStatus` 的 `change` → `word:set-status` → `setWordStatus(word, status)`：

- 白名单 `['new','learning','learned']`，非法值返回 `null`
- 改 `learned` 时把 `reviewCount` 提到 `max(reviewCount, 3)`、`rememberCount` 提到 `max(…,1)`（否则会出现「状态是已记住但复习次数 0」的矛盾态）
- 改 `new` 时把四个计数**全部清零** + `lastReview = null`（回到真正未学过的状态）
- 同样 `broadcastWordsChanged()` + `scheduleAutoBackup()`

这个控件不改「评级细分」，只改状态 —— 所以 title 写「手动指定记忆状态（不影响复习次数）」。

### 4.8 删除

两个入口，都走 `word:remove`：

- 行内 `.act-del` → 直接删（无确认；这是可撤销性弱但频次低的动作，行内按钮再加一层确认会让列表操作变重）
- 抽屉 `#dwDelete` → `confirm('从生词本删除「X」？\n\n删除后只能从备份文件恢复。')`

删的是当前 `selected` 时先 `closeDrawer()` 再 `reload()`。

### 4.9 跳回原视频

`#dwPlay` → `chrome.tabs.create({ url: 'https://www.youtube.com/watch?v=<videoId>&t=<floor(time)>s' })`。`videoId` 缺失时按钮 `disabled`（`opacity:.4`）—— 有些从字幕直接划的短语没存 videoId，点了不该什么都不发生。

### 4.10 键盘

| 键 | 上下文 | 行为 |
|---|---|---|
| `/` | 抽屉关闭且焦点不在搜索框 | 聚焦 `#q` |
| `Esc` | 抽屉打开 | 关闭抽屉 |
| `1` / `2` / `3` | 抽屉打开、焦点不在 input/select/textarea | 三档评级 |
| `R` / `r` | 同上 | `word:review`（记一次） |
| `Enter` / `空格` | 焦点在 `.wrow` | 打开抽屉 |
| `Tab` | 抽屉打开 | 焦点在抽屉内部（打开时已把焦点送到 `#dwClose`） |

抽屉内快捷键前会检查 `e.target.tagName` 是否 `INPUT|SELECT|TEXTAREA` —— 否则在下拉里按 `1` 会同时切状态和评级。

### 4.11 toast

`toast(text, kind='ok')`：懒创建 `#wb-toast`，`textContent` 写入（**不用 innerHTML**，防 XSS），`dataset.kind` 控制 `err` 变体（`--danger` 底 + 白字），3200ms 后移除 `.on`。每个新 toast 都 `clearTimeout(el._t)`，连续操作不会残留上一条的计时器。

位置 `fixed; bottom:26px; left:50%; transform:translateX(-50%)`，`max-width:min(440px,88vw)`。备份成功的 toast 刻意**不显示绝对路径**（动辄上百字符会横跨词表盖住内容），只显示「已选文件夹」或 `下载/trace-subtitles/…`。

### 4.12 自动备份链路

加词 / 删词 / 复习 / 评级 / 改状态都会触发 `bg.js` 的 `scheduleAutoBackup()`（同样覆盖 `word:add`、`word:remove`、`word:review`、`word:rate`、`word:set-status`、`word:mark-learned`），开关关闭时不写。侧栏的 `#autoBackup` 从 `settings:get` 初始化（`st.autoBackup !== false`，缺省视为开启），变更时 `settings:set`。

**自动备份只写用户选定的目录，绝不退回「下载」。** 这是一次真实抱怨倒逼的改动：没选过目录时，每次复习都会往「下载」扔一个 `wordbook-backup.json`，Chrome 下载列表里堆成 4 条 47~53KB 的同名文件；如果系统开了「下载前询问每个文件的保存位置」，还会每 30 秒弹一次保存框（用户原话：「这个动不动就会弹出下载的，我感觉很烦诶」）。静默写入用户明确指定的目录是自洽的，往别人的下载目录里反复塞文件不是。

落地方式是给 `backupToFile(opts)` 加一个开关：

| 调用方 | 参数 | 没有目录时 |
|---|---|---|
| `scheduleAutoBackup()`（自动） | `{ download:false }` | 返回 `{ok:true, skipped:true, reason:'no-dir'}`，**不计失败、不写盘、不弹框** |
| `backup:save`（用户点「立即备份」） | 无参（默认 `download:true`） | 退回「下载」目录 —— 那是用户明确的意图 |
| `backup:auto`（消息路由） | `{ download:false }` | 同上；开关关闭时回 `{skipped:true, reason:'off'}` |

跳过不消耗 `autoBackupFails`：连续三次「没选目录」不该把自动备份自动关掉（`test-backup.js` S29 断言前后 `chrome.downloads.search({})` 条数不变且返回 `reason:'no-dir'`，S30 断言 `autoBackupFails === 0` 且 `autoBackup` 仍为 true）。

**导出也是同理**：`#exportBtn`（以及 popup 里的同名按钮）此前不看结果就无条件 `a.click()`，后台返回 `{ok:false}` 时 `data` 退化成 `[]`，`JSON.stringify([],null,2)` 恰好 2 字节 —— 用户拿到一个 2B 的空 JSON 还以为是导出成功了（用户下载列表里那条 `trace-words-2026-10-20.json` 2B 就是这么来的）。现在只有真拿到非空数组才落盘，空词库或后台报错都只给 toast 提示。S31 / S32 分别覆盖「空词库不产文件」与「有词时照常落盘 3 条」两条分支。

`broadcastWordsChanged()` 会 `chrome.runtime.sendMessage({ type:'words:changed' })`，`wordbook.js` 侧监听后 `reload()` —— 这是「在别的标签页/弹窗里改了词库，本页自动刷新」的通道。`rateWord` 与 `setWordStatus` 都带广播；旧 `reviewWord` 原本不带，所以它在多标签场景下不刷新本页 —— 这是原实现的行为，**没有改**（改了会动到旧逻辑，且 `test-wordbook` 的断言依赖点 `#dwReview` 后的显式 `reload()`）。

---

## 5. 按钮 → SVG 图标语义对照（全表）

统一规格：`fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"`，`aria-hidden="true"`，`viewBox="0 0 24 24"`。线宽 1.6（大图标）~2.6（小标记），尺寸随位置 9~20px。

### 5.1 页头

| 按钮 | id | 图标语义 | 图形描述 | 尺寸 |
|---|---|---|---|---|
| 主题切换 | `#themeBtn` | **月亮 = 可切到深色** / **太阳 = 可切到浅色** | 月：`M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z`（被咬一口的圆）；日：`r=4.2` 圆心 + 8 根射线 | 16×16 |
| 导出备份 | `#exportBtn` | **向下箭头落入托盘 = 导出到本机文件** | `M12 3v11` + `M8 10.5l4 4 4-4` + `M4 15.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2.5` | 15×15 |
| 导入恢复 | `#restoreBtn` | **向上箭头离开托盘 = 从文件读回来** | `M12 15V4` + `M8 7.5l4-4 4 4` + 同样的托盘 | 15×15 |
| 立即备份 | `#backupBtn` | **软盘 / 归档盒 = 写一份快照** | `M4.5 4.5h11L19.5 8.5v11h-15z` + 顶部滑片 `M8 4.5v5h7v-5` + 底部标签 `M8 19.5v-6h8v6` | 15×15 |

导出与导入是**镜像对**（箭头方向相反、托盘相同），这样两个按钮在同一排里不会被看混。

### 5.2 侧栏

| 位置 | 图标语义 | 图形描述 | 尺寸 |
|---|---|---|---|
| `data-view="all"` | **列表三行 = 全部条目** | `M4 6h16M4 12h16M4 18h10` | 14×14 |
| `data-view="new"` | **加号 = 新加入** | `M12 5v14M5 12h14` | 14×14 |
| `data-view="learning"` | **环形箭头 = 还在循环中** | `M3 12a9 9 0 1 0 3-6.7` + `M3 4v5h5` | 14×14 |
| `data-view="learned"` | **对勾 = 已掌握** | `M20 6L9 17l-5-5` | 14×14 |
| `data-view="phrase"` | **一对括号夹一条横线 = 被框起来的一段文字**（短语） | `M9 6H6a3 3 0 0 0 0 6h3m6 0h3a3 3 0 0 0 0-6h-3` + `M8 9h8` | 14×14 |
| `#pickDirBtn` | **文件夹 = 选备份目录** | `M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z` | 13×13 |

### 5.3 KPI 五卡

| 卡片 | 图标语义 | 图形描述 | 尺寸 |
|---|---|---|---|
| 总词汇 | **书 = 词库** | `M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21z` + 书脊 `M4 18.5V5.5` | 13×13 |
| 今日新增 | **加号 = 新增** | `M12 5v14M5 12h14` | 13×13 |
| 待复习 | **时钟 = 到期** | `circle r=8.5` + `M12 7.5V12l3 1.8` | 13×13 |
| 总复习次数 | **双向循环箭头 = 反复复习** | 上半环 `M3.5 12a8.5 8.5 0 0 1 14.6-5.9L21 9` + 箭头 `M21 4.5V9h-4.5` + 下半环 + 反向箭头 | 13×13 |
| 平均遗忘率 | **下折线 + 基线 = 记忆衰减** | `M3 17l5-6 4 3.5 4.5-6 4.5 4` + `M3 20.5h18` | 13×13 |

五张卡的图标底色与文字色都用同一族语义色（金 / 紫 / 琥珀 / 绿 / 红），与各自折线的 `--spark-*` 同色相 —— 扫一列就能把「图标—数字—折线」归成一组。

### 5.4 工具栏与列表

| 位置 | 图标语义 | 图形描述 | 尺寸 |
|---|---|---|---|
| 搜索框内 | **放大镜 = 搜索** | `circle cx=10.5 cy=10.5 r=6.5` + `M20 20l-3.5-3.5` | 14×14 |
| `#qClear` | **叉 = 清空输入** | `M6 6l12 12M18 6L6 18` | 11×11，线宽 2.4 |
| `#batchBtn` | **列表几行 + 对勾 = 批量过一遍** | `M4 5.5h10M4 12h10M4 18.5h6` + `M17 12.5l2 2 3-3.5` | 13×13 |
| 行内 `.act-rev` | **对勾 = 记一次复习** | `M20 6L9 17l-5-5` | 12×12，线宽 2.2 |
| 行内 `.act-del` | **垃圾桶 = 删除** | `M4 7h16` + 提手 `M9.5 7V4.8h5V7` + 桶身 `M6 7l.9 12.2A2 2 0 0 0 8.9 21h6.2a2 2 0 0 0 2-1.8L18 7` + 两道竖纹 `M10 11v6M14 11v6` | 12×12 |
| `.w-forget` 标记 | **小叉 = 忘过几次**（与行内删除同形但 9px/线宽 2.6，靠尺寸与上下文区分） | `M6 6l12 12M18 6L6 18` | 9×9 |
| 空态 `.empty-mark` | **放大镜 = 去找词** | 同搜索图标，线宽 1.6 | 20×20 |
| 短语图标 `PHRASE_SVG` | **三横线 = 一段文本**（非单词） | `M4 7h16M4 12h16M4 17h9` | 12×12，线宽 2.1 |

**短语图标为什么不是引号**：原设计用双引号，但把 SVG 栅格化成 12×12 真实像素后确认 —— 引号下半截的撇只剩 1px 宽的两条尾，而两个闭合圆头在 12px 下被读成数字 `9 / 9`（缩略图里确实像「99」）。三横线在同样面积里只有横笔画，不依赖细尖结构，缩小后仍稳定读作「一段文本」。

### 5.5 抽屉

| 位置 | 图标语义 | 图形描述 | 尺寸 |
|---|---|---|---|
| `#dwClose` | **叉 = 关闭** | `M6 6l12 12M18 6L6 18` | 15×15，线宽 2.2 |
| `.dw-tag`（短语标识） | **三横线 = 短语** | 同 `PHRASE_SVG` | 10×10，线宽 2.2 |
| 「逐词对照」区头 | **三横线参差 = 分条列出** | `M4 7h16M4 12h10M4 17h13` | 11×11 |
| 「英文释义」区头 | **打开的书 = 词典释义** | `M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21z` + `M4 18.5V5.5` | 11×11 |
| 「记忆统计」区头 | **柱状图 = 统计** | `M4 19V9m5 10V5m5 14v-7m5 7V8` | 11×11 |
| 「原句 · 上下文」区头 | **带缩进的文本行 = 上下文** | `M8 10.5h.01M8 14h.01M8 17.5h.01M12 7h8M12 12h8M12 17h5` + 左侧引用块 `M4 5h4v16H4z` | 11×11 |
| 「这次想得起来吗」区头 | **对勾 = 自评** | `M20 6L9 17l-5-5` | 11×11 |
| 「记录」区头 | **时钟 = 时间线** | `circle r=8.5` + `M12 8v4.5l3 1.8` | 11×11 |
| `#dwReview`「记一次」 | **环形箭头 = 又一次**（不分档，只 +1） | `M3.5 12a8.5 8.5 0 1 1 2.6 6.1` + `M3.5 19v-5h5` | 13×13 |
| `#dwDelete`「删除」 | **垃圾桶 = 删除** | 同行内删除，13×13 | 13×13 |
| `#dwPlay`「跳到视频」 | **框内斜箭头 = 在新标签打开** | `M14 4h6v6` + `M20 4l-8.5 8.5` + `M19 14.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4.5` | 13×13 |

### 5.6 三档评级按钮（专属图标）

| 按钮 | 文案 + 副文案 | 图标语义 | 图形描述 | 尺寸 |
|---|---|---|---|---|
| `.rate-forget` | 忘记了 / 稍后再练 | **放大镜里带向下箭头 = 找不到答案** | `circle cx=10.5 cy=10.5 r=6.5` + `M18.5 15.5V21` + `M16.2 18.7L18.5 21l2.3-2.3`（放大镜右侧递出一个**向下**箭头） | 17×17，线宽 1.8 |
| `.rate-fuzzy` | 模糊 / 继续温习 | **圈内三行长短递减 = 轮廓糊掉** | `circle r=8.5` + `M8.6 10h6.8M9.4 13h5.2M10.4 16h3.2`（三行居中递减，像渐渐散开的记忆） | 17×17 |
| `.rate-remember` | 记住了 / 标记已记住 | **圈内对勾 = 确定** | `circle r=8.5` + `M8.2 12.3l2.6 2.6 5-5.4` | 17×17 |

三个图标的**结构是同一套语法**：围绕「一个圆」做变体（放大镜圆 / 完整圆 / 完整圆），内部换「向下箭头 / 渐弱横线 / 对勾」。同尺寸、同位置、同线宽，所以眼睛是在比「圆里画的是什么」，而不是在三个不相干的图形间跳。

配色（`.rate` 常态即带色，不靠 hover 才区分）：

| 按钮 | 底色 | 边框 | 文字 |
|---|---|---|---|
| forget | `--red-soft` | `color-mix(in srgb, var(--red) 26%, transparent)` | `--red` |
| fuzzy | `--amber-soft` | 同构 `--amber` | `--amber` |
| remember | `--green-soft` | 同构 `--green` | `--green` |

hover 只把**同一色相**压到 18%（边框转满色），不换色相 —— 指针移过去颜色跳变会让人觉得选错了。

深色下 `.rate-*` 有单独覆写：`-soft` 只有 14% 透明度，压在 `#16161f` 上三块会塌成同一个深灰块。所以改用 `color-mix(in srgb, <色> 22%, var(--ink-2))` 的不透明混合底（琥珀 26%、绿 26% —— 红与琥珀在低亮度下最易糊，恰好又是相邻两个按钮；绿本身亮度低，同用 22% 会让正向操作反而最弱），边框提到 44~50%。

副文案 `.hint` 不用 `opacity` 做弱化：0.72 透明压在各自 `-soft` 底上浅色只剩 2.79~2.98，9.5px 读不出来。改成把语义色向 `--text-2` 混到 70%（色相还在、饱和度掉下来），实测浅色 5.05~5.41、深色 6.01~7.42。

---

## 6. 动效清单（克制原则）

全部动效只做「状态过渡」，没有任何循环、视差、滚动触发动画。

| 动效 | 触发 | 参数 | 目的 |
|---|---|---|---|
| `.wrow` 入场 | 每次 `renderRows()` | `rowin .34s var(--ease)`，`translateY(4px) → none` + opacity，`animation-delay: calc(var(--i) * 18ms)`（`--i` 上限 14） | 让「列表刷新了」有可感知的信号，同时用 18ms 阶梯避免几十行同时闪现 |
| 抽屉滑出 | 打开 | `transform .32s var(--ease)`，`translateY(-14px) → none` | 建立「从行位置向下展开」的空间感 |
| 抽屉淡入 | 打开 | `opacity .26s var(--ease-io)` | 避免位移刚起始时的硬边 |
| 遮罩 | 打开/关闭 | `opacity .24s` + `backdrop-filter: blur(2px)` | 把注意力收进抽屉 |
| 按钮反馈 | `.rate.flash` | `rateflash .42s`：`scale .96 → 1.015 → 1` | 点下去先有回应，不等后台回包 |
| 按钮按压 | 所有 `.tool` / `.rate` `:active` | `scale(.975)` / `scale(.97)` | 物理感 |
| 柱条 hover | `.bar:hover .bar-fill` | `scaleX(1.14)` + `opacity .9 → 1` | 指出「这根是可读的」，配合浮层 |
| 主题切换 | `.theme-anim` | `background-color / border-color .34s`，`color .28s` | 只过渡颜色，不动布局 |
| 图标交叉 | 主题按钮 | `opacity .22s` + `transform .32s`（太阳 `rotate(-40deg) scale(.7)`） | 月/日交接 |
| 环形更新 | 数据变化 | `background .4s var(--ease-io)` | conic-gradient 平滑过渡 |
| 数字滚动 | — | **无** | 刻意不做。KPI 数字是读数指标，滚动动画会让「到底是多少」延后 300ms |

`@media (prefers-reduced-motion: reduce)` 由 `theme.css` 全局把所有 `animation/transition` 压到 `0.001ms`，本页无需重复声明。

---

## 7. 响应式（浏览器小窗口，不是移动 App）

| 断点 | 触发变化 |
|---|---|
| `max-width:1180px` | `.kpi{padding:11px 11px 9px}`（五列仍一行） |
| `721~900px` | `#kpis` 用 6 列网格：前三张各 `span 2`，后两张各 `span 3` → **3+2，两行都铺满**。上下界都写死，避免污染 720 以下的 2 列布局 |
| `max-width:1020px` | 侧栏 208 → **64px 图标条**（文字/分组标签/备份区/脚注全部 `display:none`，导航居中）；`.charts` 改单列堆叠；主区 padding 收窄；H1 22px；行网格降为 4 列并隐藏音标列与操作列（操作列改 hover 显形） |
| `max-width:720px` | `#kpis` 两列，第 5 张 `grid-column:1/-1` 横跨补满；抽屉改 `width:100vw`；四个 `.tool` 只留图标（`span` 隐藏，`#themeBtn` 例外保留 label）；`.rate .hint` 隐藏 |
| `max-width:560px` | 侧栏 52px；`.dw-stat` 从 4 列改 2×2 |

实测六档（1440/1180/1020/860/720/560）**全部 `horizOverflow:false`**：

| 宽度 | KPI 每行 | 单卡宽 | 横向溢出 |
|---|---|---|---|
| 1440 | `[5]` | 225 | 无 |
| 1180 | `[5]` | 173 | 无 |
| 1020 | `[5]` | 141 | 无 |
| 900 | `[5]` | 150 | 无 |
| 860 | `[3,2]` | 244 | 无 |
| 760 | `[3,2]` | 211 | 无 |
| 721 | `[3,2]` | 198 | 无 |
| 720 | `[2,2,1]` | 301 | 无 |
| 560 | `[2,2,1]` | 233 | 无 |

860px 下行网格实测：`gridTemplateColumns: "28px 242.433px 352.644px 70px"`，表头四列与行逐列**零偏移**（headL 与 cellL 逐列相等），`hScroll:false`。

---

## 8. 数据层：只加不改

### 8.1 `bg.js` 新增（4 处，全部是加法）

| 位置 | 新增内容 |
|---|---|
| `addWord()` 的 rec 末尾 | `forgetCount / fuzzyCount / rememberCount` 三个字段（新建时 0，已有记录保留原值）。**`reviewCount` 语义不变，老记录不需要迁移** |
| `RATE_FIELD` + `rateWord(word, grade)` | 见 §4.5。`broadcastWordsChanged()` + `scheduleAutoBackup()` |
| `setWordStatus(word, status)` | 见 §4.7 |
| 消息路由 | `case 'word:rate'`（行 2310）、`case 'word:set-status'`（行 2313），插在 `word:review`（2307）之后 |
| `restoreFromBackup()` 合并分支 | `forgetCount/fuzzyCount/rememberCount` 三行 `Math.max(old.X || 0, w.X || 0)` —— 恢复旧备份不该把「忘记过 5 次」抹成 0，否则遗忘率会被一次恢复洗白 |
| `globalThis.__traceDebug` | 导出 `rateWord` / `setWordStatus`（供测试与调试） |

**新路由而不是改旧路由**的理由：`word:review` 的「三次即记住」语义被列表行快捷 ✓、`#dwReview`、背单词模式（`test-review.js` 的 S1–S17）三处依赖。改它等于同时改三个入口的语义；新开一条路由，旧的一切原样。

### 8.2 向后兼容

- 老记录没有三个细分计数 → `tally()` 的 `untagged` 差额兜底，不崩、不瞎填
- 老记录的 `status` 可能缺失 → `st(w) = w.status || 'new'`
- `reviewCount` 仍能被 `word:review` 与 `word:rate` 两条路递增，语义一致（都是「复习了一次」）

### 8.3 派生逻辑的关键取舍

| 指标 | 算法 | 取舍理由 |
|---|---|---|
| 遗忘率 | `forgets / reviews`（按**次数**） | 「同一个词忘三次」比「三个词各忘一次」更值得关注，按词数会稀释 |
| 到期判定 | 新词一律到期；learned 不到期；其余按 `INTERVAL_DAYS=[1,2,4,7,15,30]` 以 `lastReview‖createdAt` 为起点 | 间隔递增，`min(reviewCount, 5)` 取档 |
| 未掌握存量折线 | 按当前状态回溯的比例近似 | 状态没有历史表，只用来给曲线定形状；KPI 数字本身用精确计数 |
| 遗忘折线 | `forgetCount` 是累计值、无逐次时间戳，归到 `lastReview` 那天 | 近似值，只用于形状 |
| 纵轴刻度 | `niceScale()`：`target = max*1.15`，step 取 1/2/5/`ceil(target/25)*5`，上限向上取整到 step 倍数 | 直接 `max/3` 会得到 1、3、4 这种不等距数字 |
| 分桶 | 日 = 近 30 天（每 7 天 + 今天有标签）、周 = 近 12 周（周一起）、月 = 近 12 月 | 与「日/周/月」三个按钮一一对应，实测柱数 30/12/12 |

---

## 9. 无障碍（三条可复算的证据）

### 9.1 全页文本对比度

`tools/a11y-contrast.js [light|dark]` 做**两遍分域审计**：一遍关抽屉只审 `document.body`，一遍开抽屉只审 `#drawer`，失败取并集。

分域是必须的：抽屉打开时 `.scrim` 把主页面压暗 24%，会把 `.pill-new` 从 5.3 误判成 4.26。

三个实现要点（都是踩过的坑）：

1. `color(srgb …)` 解析 —— `color-mix()` 的结果分量是 0..1，不能当 0..255 读，否则整条算成近黑、ratio 误报 1。
2. 祖先链 `opacity` 连乘后把文字色向背景洗淡，按洗淡后颜色算对比度；`opacity===0` 的节点直接跳过（浮层提示默认态），否则误报 35 条。
3. **边框盒包含判断** —— `probe` 与祖先 `box` 的 l/r/t/b 比较，只有节点真在祖先盒内才合成该层背景。否则绝对定位到 `.chart-grid` 之外的 `.grid-y` 会把 `.grid-line` 的 `rgba(255,255,255,.11)` 算进背景，虚报 3.89:1。

**最终结果：light 主页面 194 节点 + 抽屉 48 节点，未达标 0；dark 同。** 唯一 `opacity<1` 的节点是 `.chip.on .n`（0.85 → 浅色 4.62 / 深色 7.89，达标）。

推理过程示例（为什么浅色语义色要整体压深）：`--red #b4615f` 在白底 4.36、在自身 `--red-soft` 底 4.97 —— 4.36 < 4.5，不过。这些 token 全部当**文字色**用（徽章、忘记次数告警、评级按钮字、KPI 负向数字），必须**同时**过白卡底与自身 `-soft` 浅底，只过其中一个不算。所以统一压深一档、色相不变（→ `#9e4e4d`，5.75 / 4.97）。

### 9.2 非文本对比度（图形对象 3:1）

| 对象 | 标准 | 实测 |
|---|---|---|
| `.w-act` 行内图标 | 1.4.11 组件识别 3:1 | 浅 3.30 / 深 3.13 |
| KPI 五条折线 | 同上 | 5.05~7.16（浅）/ 5.77~13.71（深） |
| 柱/环填充 | 与背景可辨 | 柱金渐变 + 空桶 `--line-2`；环三段 + 1.4% 缝 |
| 状态徽章 | 不必靠色相单独承载 | 圆点空/实 + 底色深浅 + 文字三层 |

### 9.3 键盘与语义

- 行是 `role="button" tabindex="0"` + `aria-label="${词}，${状态}"`，`Enter` / `空格` 可开
- `:focus-visible` 统一 `outline:2px solid var(--gold-line); outline-offset:-2px`（行内用负偏移，避免把相邻行切开）
- 抽屉 `role="dialog" aria-modal="true" aria-labelledby="dwWord"`，打开后 40ms 把焦点送到 `#dwClose`
- 所有图标 `aria-hidden="true"`，可读文案由按钮的 `title` + 可见文字承担；纯图标按钮（`#themeBtn` / `#qClear` / `#dwClose`）都带 `aria-label`
- `#batchBtn` 用 `aria-disabled="true"` 而不是 `disabled`：它需要可聚焦、点击时用 toast 解释「还在做」，`disabled` 会让读屏用户完全听不到它存在

---

## 10. 与旧版的差异（改了 / 没改）

**没改**（原业务逻辑全保留）：
- 所有消息路由与数据字段（只新增 `word:rate` / `word:set-status` 两条）
- 备份 / 恢复 / 选目录 / 自动备份 / 导入 / 导出全链路，含 `#backupBtn` `#restoreBtn` `#exportBtn` `#pickDirBtn` `#autoBackup` 五个 id 与 `.side-foot` 里的备份文件名
- 列表行 id 契约：`.wrow[data-w]`、`.pill.pill-<status>`、`button[data-act=del|rev]`、`#drawer.open`、`#dwWord` / `#dwPhon` / `#dwBody` / `#dwPlay` / `#dwReview`
- KPI 锚点 `#kTotal` `#kToday` `#kDue` `#kReviews` `#kForget`、环 `#donutNum` + `#donut.style.background` 含 `conic-gradient`、图例 `#legend .lg`、柱 `#bars .bar`（日 30 / 周 12 / 月 12）、粒度 `#gran button[data-g]`
- 筛选芯片 `.chip[data-f]`、侧栏 `#sideNav button[data-view]`、计数 `#cAll/#cLearned/#cLearning/#cNew/#cPhrase`、`#fAll/#fNew/#fLearning/#fLearned/#fPhrase`
- 字幕查词卡片（`content.js` / `overlay.css`）一行未动

**改了**（本轮新增或重设计）：
- 主题体系：新增浅色主题（默认）+ 右上角切换按钮 + 双持久化
- 布局：侧栏 5 视图 + 备份区 + 隐私脚注（原为单栏堆叠）；KPI 五卡 + 迷你折线；图表双卡；列表六列网格
- 记忆评级：三档按钮 + 配额条 + 图例 + `untagged` 兜底 + 键盘 1/2/3
- 抽屉：从纯信息面板升级为「可复习的工作台」（状态设置 + 删除 + 记一次 + 跳视频集中在不滚动的底栏）
- 侧栏折叠、六档断点、矮窗口侧栏自滚

---

## 11. 验证记录

| 项目 | 命令 | 结果 |
|---|---|---|
| 生词本看板回归 | `node tools/test-wordbook.js` | `RESULT: PASS`（11 项 checks 全 true；删除后 kTotal 8→7，`errors:[]`） |
| 备份/恢复回归 | `node tools/test-backup.js` | `RESULT: PASS`（S1–S28 全 true） |
| 短语回归 | `node tools/test-phrase.js` | `RESULT: PASS`（L1–L21 全 ✓） |
| 背单词模式回归 | `node tools/test-review.js` | `RESULT: PASS`（S1–S17 全 ✓） |
| 无障碍审计（浅） | `node tools/a11y-contrast.js light` | 主页面 194 / 抽屉 48，**未达标 0** |
| 无障碍审计（深） | `node tools/a11y-contrast.js dark` | 主页面 194 / 抽屉 48，**未达标 0** |
| 断点探针 | `node tools/probe-breakpoints.js` | 六档全部 `horizOverflow:false`，KPI 无落单卡 |
| 整页截图 | `node tools/shot-wordbook.js` | 7 张（浅色 / 浅色抽屉 / 浅色短语 / 深色 / 深色抽屉 / 860 窄窗 / 空态），`errors: []` |

⚠ **测试不能并行跑**：`test-phrase` / `test-review` 依赖 YouTube 夹具 + 自然播放采样，同一个 PowerShell 会话里连续跑会互相抢占，出现大面积假 FAIL；单跑（或串行且间隔足够）才可信。`test-wordbook` / `test-backup` 无此问题。

---

## 12. 已知取舍（不是 bug）

1. **深色下备份按钮比浅色更亮** —— 深黑底上必须靠亮金字才读得清，压暗会掉到 4.5:1 以下。这是深色主题的必然结果。
2. **y 轴顶刻度常有一格空档** —— `niceScale` 向上取整到 step 倍数必然留余量。去掉会让柱子顶到卡片边缘，更难看。
3. **音标列参差不齐** —— 没有音标的记录是原始数据里就没有 `phonetic`，不能凭空补。
4. **批量复习是占位** —— 用户明确要求「预留按钮作为 UI 占位」，所以它只有虚线边框 + 「即将支持」小标 + 解释性 toast。
5. **没有发音按钮** —— 原产品无 TTS 能力，加按钮会造假功能。
6. **短语行不单独着紫色条、不做「短语」徽章** —— 徽章位只放学习状态。一格里塞两个不同维度的标签会让每行扫读节拍乱掉；短语身份由行首三横线图标 + 紫系来源标签承载。
7. **侧栏中部有大片留白** —— 这是 `.side-label.push{margin-top:auto}` 把两簇分别钉顶/钉底的结果。用「最近加入」迷你列表填满会违反「充足留白、去除多余装饰」这两条需求。
8. **`#dwReview` 保留旧语义** —— 见 §4.6；它是原逻辑的一部分，且三档评级已覆盖「分级」场景。
