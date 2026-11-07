export const subtitleLines = [
  {
    en: [
      { text: "We learn best " },
      { text: "when the words " },
      { text: "stay", word: "stay", active: true },
      { text: " with us." },
    ],
    zh: "那些留在脑海里的词，才是真正学会的。",
    offset: 0,
  },
  {
    en: [
      { text: "A word only matters " },
      { text: "when you meet it " },
      { text: "again", word: "again" },
      { text: " in another story." },
    ],
    zh: "同一个词在另一个故事里再次出现，它才真正属于你。",
    offset: 5.6,
  },
  {
    en: [
      { text: "So we keep the " },
      { text: "context", word: "context" },
      { text: " close, and let the meaning " },
      { text: "grow", word: "grow" },
      { text: " from there." },
    ],
    zh: "所以让上下文留在手边，让词义自然生长。",
    offset: 11.2,
  },
];

export const wordDefinitions = {
  stay: {
    word: "stay",
    phonetic: "/steɪ/",
    meaning: "停留；留下",
    partOfSpeech: "动词",
    gloss: "停留；继续处于某个状态。",
    original: "to remain in the same place or condition",
    english: "to remain in the same place or condition",
    context: "when the words stay with us",
    contextZh: "当这些词留在我们心里",
  },
  again: {
    word: "again",
    phonetic: "/əˈɡen/",
    meaning: "再次；又一次",
    partOfSpeech: "副词",
    gloss: "再一次；又一次。",
    original: "one more time",
    english: "one more time",
    context: "when you meet it again in another story",
    contextZh: "当你在另一个故事里再次遇见它",
  },
  context: {
    word: "context",
    phonetic: "/ˈkɒntekst/",
    meaning: "语境；上下文",
    partOfSpeech: "名词",
    gloss: "帮助理解词义的语境或上下文。",
    original: "the situation that gives something its meaning",
    english: "the situation that gives something its meaning",
    context: "we keep the context close",
    contextZh: "我们把语境留在身边",
  },
  grow: {
    word: "grow",
    phonetic: "/ɡrəʊ/",
    meaning: "生长；逐渐形成",
    partOfSpeech: "动词",
    gloss: "生长；逐渐形成。",
    original: "to develop or become larger over time",
    english: "to develop or become larger over time",
    context: "let the meaning grow from there",
    contextZh: "让词义从那里逐渐生长",
  },
};

export const featureRows = [
  {
    number: "01",
    title: "双语字幕",
    lead: "英文在上，中文在下。",
    body: "按完整句子显示，跟着视频推进。长句在合适的地方断开，不需要暂停，也不必来回扫视。",
    detail: "四套卡片样式 / 三档详细程度 / 全屏等比缩放",
    visual: "subtitles",
  },
  {
    number: "02",
    title: "点词，不离开画面",
    lead: "看不懂的词，点一下。",
    body: "音标、释义和这个词在当前句子里的意思一起出现。拖选连续几个词，可以查整个短语。",
    detail: "划短语 / 语境释义 / 不遮挡正在看的字幕",
    visual: "lookup",
  },
  {
    number: "03",
    title: "生词会自己回来",
    lead: "收藏过的词，下次再见还认得。",
    body: "跨视频自动高亮。再次出现时，中文释义先模糊起来，回忆够了再揭开；学习进度保留在本机文件中。",
    detail: "跨视频高亮 / 单词形态归一 / 卸载重装后可恢复",
    visual: "review",
  },
];

export const reviewWords = [
  { word: "context", phonetic: "/ˈkɒntekst/", memory: "模糊", status: "review", age: "今天" },
  { word: "persist", phonetic: "/pəˈsɪst/", memory: "记住了", status: "known", age: "2 天前" },
  { word: "settle", phonetic: "/ˈsetl/", memory: "再遇见一次", status: "new", age: "3 天前" },
  { word: "bring back", phonetic: "/brɪŋ bæk/", memory: "记住了", status: "known", age: "5 天前" },
  { word: "subtle", phonetic: "/ˈsʌtl/", memory: "模糊", status: "review", age: "1 周前" },
];

export const glossary = [
  { word: "context", meaning: "语境", status: "review" },
  { word: "persist", meaning: "持续存在", status: "known" },
  { word: "subtle", meaning: "微妙的", status: "review" },
  { word: "retain", meaning: "保留", status: "new" },
];

export const installSteps = [
  {
    title: "下载并打开扩展页",
    body: "获取项目文件夹，打开 Chrome 的扩展程序管理页，再开启右上角的开发者模式。",
  },
  {
    title: "加载 Trace 文件夹",
    body: "点击加载已解压的扩展程序，选择 trace-subtitles 文件夹。不需要账号或 API Key。",
  },
  {
    title: "打开任意英文视频",
    body: "回到 YouTube 播放视频，双语字幕会自动出现。设置、样式和生词本都收纳在播放器的悬浮面板里。",
  },
];

export const faqs = [
  {
    question: "真的不用注册吗？",
    answer:
      "不用。安装后即可使用默认翻译引擎。生词本、学习进度和设置都保存在本地，也可以导出成本机文件。",
  },
  {
    question: "能把数据同步到别的电脑吗？",
    answer:
      "目前以本机保存为主，可以通过生词本文件进行迁移或恢复，不依赖账号云同步。",
  },
  {
    question: "为什么叫 Trace？",
    answer:
      "Trace 是留下的痕迹。你点过的词、读过的句子和复习过的上下文，会慢慢积累成自己的英语轨迹。",
  },
  {
    question: "可以用自己的大模型接口吗？",
    answer:
      "可以。设置里支持 OpenAI 兼容接口，让习语、术语和上下文翻译更准确；默认引擎无需配置。",
  },
];
