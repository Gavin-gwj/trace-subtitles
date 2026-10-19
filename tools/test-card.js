/**
 * 查词卡片回归：详细程度三档 + 四套样式预设 + 词性配色 + 词典多源兜底
 *
 * 起因（用户报障，附两张截图对比）：
 *   「单词翻译能设置的更详细一点吗，然后前端展示页面做的更加好看一点，
 *     这个版本的可以保留，增加几个预设的单词翻译的预设样式，
 *     像图二这样的是不是信息展示的有些少了，然后比如说每个词性用不一样的颜色」
 *
 * 图一 calling 内容齐全（音标 + 4 条带词性标签的义项 + 例句 + 折叠英文原文），
 * 图二 vessel 只有「单词 + 血管 + 按钮」。查了才知道 vessel 不是没数据，
 * 是 dictionaryapi.dev 对它的请求**永久超时**（18s 0 字节，不是 404），
 * 3.5s 超时后静默降级 → 卡片只剩一个 Google 单译。
 *
 * 所以这里要盯住四件事：
 *   1) 词典多源：Datamuse 兜底后，即使 dictionaryapi.dev 不响应也有音标和多义项
 *   2) 详细程度：concise < normal < full 的义项数必须真的递增，
 *      且 concise 不显示英文原文（否则「简洁」名不副实）
 *   3) 样式预设：data-style 切换后卡片背景/字色真的变了（不能只是加了个属性）
 *   4) 词性配色：不同词性拿到不同的 data-pos，且颜色确实不同
 *
 * 第 3 点必须量**计算样式**而不是量属性。第一版只想断言 dataset.style 等于所选值，
 * 那样即使 CSS 里忘了写 [data-style="paper"] 规则也照样 PASS —— 等于没测。
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const F = require('./mock/fixtures');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const userDataDir = path.join(__dirname, '.chrome-card');
const VW = 1280;
const VH = 860;

const checks = {};
const failed = [];

function check(name, ok, extra) {
  checks[name] = !!ok;
  const mark = ok ? '\u2713' : '\u2717';
  const extraStr = extra === undefined ? '' : ' ' + JSON.stringify(extra);
  console.log(`${mark} ${name}${extraStr}`);
  if (!ok) failed.push(name);
}

/** 等卡片填充完成（loading 消失） */
async function waitCard(page) {
  await page.waitForFunction(
    () => {
      const pop = document.getElementById('trace-word-popup');
      if (!pop || pop.classList.contains('trace-hidden')) return false;
      return !pop.querySelector('.trace-pop-loading');
    },
    { timeout: 30000 }
  );
  await page.waitForTimeout(250);
}

/** 点字幕里的某个词，返回是否点到 */
async function clickWord(page, word) {
  const ok = await page.evaluate((w) => {
    const el = [...document.querySelectorAll('.trace-word')].find(
      (n) =>
        (n.textContent || '').toLowerCase().replace(/[^a-z]/g, '') ===
        w.toLowerCase()
    );
    if (!el) return false;
    el.click();
    return true;
  }, word);
  if (ok) await waitCard(page);
  return ok;
}

/** 读卡片的结构化内容 + 计算样式 */
async function readCard(page) {
  return page.evaluate(() => {
    const pop = document.getElementById('trace-word-popup');
    if (!pop) return null;
    const txt = (sel) => pop.querySelector(sel)?.textContent?.trim() || '';
    const cs = getComputedStyle(pop);
    const senses = [...pop.querySelectorAll('.trace-pop-senses li')].map((li) => {
      const tag = li.querySelector('.trace-pop-pos');
      return {
        pos: tag?.textContent?.trim() || '',
        posKey: tag?.dataset.pos || '',
        posColor: tag ? getComputedStyle(tag).color : '',
        posBg: tag ? getComputedStyle(tag).backgroundColor : '',
        text: li.querySelector('.trace-pop-txt')?.textContent?.trim() || '',
      };
    });
    return {
      style: pop.dataset.style || '',
      bg: cs.backgroundColor,
      bgImage: cs.backgroundImage,
      color: cs.color,
      radius: cs.borderTopLeftRadius,
      word: txt('.trace-pop-word'),
      phon: txt('.trace-pop-phon'),
      // 音标必须和单词在同一行（标题行），否则省高度就白改了
      phonInTitle: !!pop.querySelector('.trace-pop-title .trace-pop-phon'),
      phonInBody: !!pop.querySelector('.trace-pop-body > .trace-pop-phon'),
      senseCount: senses.length,
      senses,
      hasMore: !!pop.querySelector('.trace-pop-more'),
      hasExample: [...pop.querySelectorAll('.trace-pop-label')].some((l) =>
        /例句/.test(l.textContent || '')
      ),
      bodyHeight: Math.round(
        pop.querySelector('.trace-pop-body')?.getBoundingClientRect().height || 0
      ),
      popHeight: Math.round(pop.getBoundingClientRect().height),
      // 本句译文的英文行：必须是可读正文，不能退化成 faint 那种「看得见但读不动」的灰
      ctxContrast: (() => {
        const el = pop.querySelector('.trace-pop-ctx');
        if (!el) return null;
        const lin = (c) => {
          c /= 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
        const rgb = (s) => {
          const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s || '');
          return m ? [+m[1], +m[2], +m[3]] : null;
        };
        // 卡片底色可能是渐变，取第一个色标
        let bg = rgb(cs.backgroundColor);
        if (!bg || /rgba\(.*,\s*0(?:\.\d+)?\)$/.test(cs.backgroundColor)) {
          const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cs.backgroundImage || '');
          if (m) bg = [+m[1], +m[2], +m[3]];
        }
        const fg = rgb(getComputedStyle(el).color);
        if (!bg || !fg) return null;
        const a = lum(fg), b = lum(bg);
        return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
      })(),
      ctxFontSize: parseFloat(getComputedStyle(pop.querySelector('.trace-pop-ctx') || pop).fontSize),
    };
  });
}

(async () => {
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: CHROME,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      ...require('./lib/proxy').proxyArgs(),
    ],
    viewport: { width: VW, height: VH },
    locale: 'zh-CN',
  });

  const errors = [];
  ctx.on('page', (p) => {
    p.on('pageerror', (e) => errors.push(String(e)));
  });

  // 用 vessel 当主角：它正是用户图二里信息最少那个词，
  // 而且 dictionaryapi.dev 对它永久超时 —— 最能验证 Datamuse 兜底是否生效。
  const CUES = [
    [0.0, 3.0, 'They boarded the vessel at dawn.'],
    [3.0, 2.0, 'The vessel sailed away.'],
  ];

  await ctx.route('https://www.youtube.com/**', async (route) => {
    const u = route.request().url();
    if (u.includes('/api/timedtext')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': 'https://www.youtube.com' },
        body: F.json3Body(CUES),
      });
    }
    if (u.includes('/youtubei/v1/player')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': 'https://www.youtube.com' },
        body: JSON.stringify({ playerResponse: F.playerResponse(F.VIDEO_ID) }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: F.pageHtml(F.VIDEO_ID, { cues: CUES }),
    });
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  console.log('SW:', sw.url());

  // 词典是真实网络（Datamuse + dictionaryapi.dev + translate.googleapis.com）。
  // 只清缓存，不 mock —— 兜底链到底有没有用，必须看真链路。
  await sw.evaluate(async () => {
    const db = await globalThis.__traceDebug.openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('translations', 'readwrite');
      tx.objectStore('translations').clear();
      tx.oncomplete = res;
      tx.onerror = rej;
    });
  });

  const page = await ctx.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${F.VIDEO_ID}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('.trace-sub-orig', { timeout: 20000 });
  await page.waitForFunction(
    () => {
      const t = document.querySelector('.trace-sub-trans');
      return t && t.textContent.trim().length > 0;
    },
    { timeout: 30000 }
  );

  // ============================================================
  // C1-C5：默认档（normal）+ 默认样式，重点是「vessel 不再只有一行」
  // ============================================================
  const clicked = await clickWord(page, 'vessel');
  check('C1 字幕里找到并点击了 vessel', clicked);
  if (!clicked) {
    await ctx.close();
    return finish();
  }

  const normal = await readCard(page);
  check('C2 卡片标题是 vessel', /^vessel$/i.test(normal.word || ''), {
    word: normal.word,
  });

  // 音标：Datamuse 的 pron: tag 或 dictionaryapi 补的都算。
  // vessel 在 dictionaryapi.dev 上会超时，所以这条音标只可能来自 Datamuse ——
  // 它同时也是「兜底生效」的证据。
  check('C3 有音标（vessel 的词典源超时，靠 Datamuse 兜底）', !!normal.phon, {
    phon: normal.phon,
  });
  check('C4 音标在标题行内（不单独占行）', normal.phonInTitle && !normal.phonInBody, {
    phonInTitle: normal.phonInTitle,
    phonInBody: normal.phonInBody,
  });

  // 多义项：vessel 至少有「船」和「容器/血管」两类，≥2 才算「信息够」
  check('C5 义项 ≥ 2 条（不再是图二那样只剩一条）', normal.senseCount >= 2, {
    senseCount: normal.senseCount,
    texts: normal.senses.map((s) => s.text).slice(0, 4),
  });

  // ============================================================
  // C6-C7：词性配色 —— 直接遍历全部词性量颜色
  // ============================================================
  // 不能靠「vessel 的义项颜色是否互不相同」来验证：vessel 的义项恰好全是名词，
  // 那样 distinctColors.size 恒等于 1、断言恒真。必须把每一种词性都造出来量。
  const posTags = normal.senses.filter((s) => s.posKey);
  check('C6 义项带 data-pos 配色键', posTags.length >= 1, {
    posKeys: [...new Set(posTags.map((s) => s.posKey))],
  });

  // 把 14 种词性标签临时插进卡片里量实际颜色（量完移除）
  const posPalette = await page.evaluate(() => {
    const pop = document.getElementById('trace-word-popup');
    if (!pop) return null;
    const keys = [
      'noun', 'verb', 'adj', 'adv', 'pron', 'prep', 'conj',
      'interj', 'num', 'aux', 'art', 'part', 'phrase', 'other',
    ];
    const host = document.createElement('div');
    host.style.position = 'absolute';
    host.style.visibility = 'hidden';
    pop.appendChild(host);
    const out = {};
    for (const k of keys) {
      const el = document.createElement('i');
      el.className = 'trace-pop-pos';
      el.dataset.pos = k;
      host.appendChild(el);
      const cs = getComputedStyle(el);
      out[k] = { fg: cs.color, bg: cs.backgroundColor };
    }
    host.remove();
    return out;
  });
  const paletteFgs = Object.values(posPalette || {}).map((v) => v.fg);
  const paletteBgs = Object.values(posPalette || {}).map((v) => v.bg);
  check(
    'C7 14 种词性各有不同颜色（前景与背景都互不相同）',
    paletteFgs.length === 14 &&
      new Set(paletteFgs).size === 14 &&
      new Set(paletteBgs).size === 14,
    {
      distinctFg: new Set(paletteFgs).size,
      distinctBg: new Set(paletteBgs).size,
      sample: { noun: posPalette?.noun, verb: posPalette?.verb },
    }
  );

  // ============================================================
  // C8-C11：详细程度三档，义项数必须真的递增
  // ============================================================
  // 换档位后要清缓存：缓存键里带了档位，但 vessel 这一轮已经把 normal 写进去了，
  // 换档会走新键，无需清。这里只改设置即可。
  const setDetail = async (v) => {
    await sw.evaluate(async (detail) => {
      await globalThis.__traceDebug.setSettings({ dictDetail: detail });
    }, v);
  };

  await setDetail('concise');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.trace-sub-orig', { timeout: 20000 });
  await page.waitForFunction(
    () => {
      const t = document.querySelector('.trace-sub-trans');
      return t && t.textContent.trim().length > 0;
    },
    { timeout: 30000 }
  );
  await clickWord(page, 'vessel');
  const concise = await readCard(page);

  await setDetail('full');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.trace-sub-orig', { timeout: 20000 });
  await page.waitForFunction(
    () => {
      const t = document.querySelector('.trace-sub-trans');
      return t && t.textContent.trim().length > 0;
    },
    { timeout: 30000 }
  );
  await clickWord(page, 'vessel');
  const full = await readCard(page);

  check(
    'C8 详细程度递增：concise ≤ normal ≤ full 的义项数',
    concise.senseCount <= normal.senseCount && normal.senseCount <= full.senseCount,
    {
      concise: concise.senseCount,
      normal: normal.senseCount,
      full: full.senseCount,
    }
  );
  // 至少要有某一档真的比另一档多 —— 否则三档只是同一个东西换了个名字
  check(
    'C9 三档不是同一个东西（至少一处条数真的不同）',
    concise.senseCount !== full.senseCount ||
      concise.bodyHeight !== full.bodyHeight,
    {
      conciseSenses: concise.senseCount,
      fullSenses: full.senseCount,
      conciseH: concise.bodyHeight,
      fullH: full.bodyHeight,
    }
  );
  // 简洁档不显示英文原文：选了「简洁」还拖着折叠的英文释义，就名不副实
  check('C10 简洁档不显示英文原文释义', !concise.hasMore, {
    conciseHasMore: concise.hasMore,
    fullHasMore: full.hasMore,
  });

  // ============================================================
  // C11-C15：四套样式预设 —— 必须量计算样式，不能只量属性
  // ============================================================
  const styleSamples = {};
  for (const style of ['classic', 'paper', 'ink', 'aurora']) {
    await sw.evaluate(async (s) => {
      await globalThis.__traceDebug.setSettings({ cardStyle: s });
    }, style);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.trace-sub-orig', { timeout: 20000 });
    await page.waitForFunction(
      () => {
        const t = document.querySelector('.trace-sub-trans');
        return t && t.textContent.trim().length > 0;
      },
      { timeout: 30000 }
    );
    await clickWord(page, 'vessel');
    styleSamples[style] = await readCard(page);
    // 字体必须在**该样式生效时**量。第一版在循环外面量，量到的是最后一档
    // aurora 的字体，却拿去断言 paper —— 而且正则里的 serif 会匹配到
    // sans-serif，于是这条断言永远为真，等于没测。
    styleSamples[style].wordFont = await page.evaluate(() => {
      const w = document
        .getElementById('trace-word-popup')
        ?.querySelector('.trace-pop-word');
      return w ? getComputedStyle(w).fontFamily : '';
    });
  }

  check(
    'C11 四套样式都应用到了 data-style',
    ['classic', 'paper', 'ink', 'aurora'].every(
      (s) => styleSamples[s] && styleSamples[s].style === s
    ),
    Object.fromEntries(
      Object.entries(styleSamples).map(([k, v]) => [k, v?.style || null])
    )
  );

  // 背景色 + 圆角 + 字色三者至少各有一项不同 —— 这是「样式真的换了」的实证。
  // 只看 data-style 属性的话，CSS 里漏写规则也照样 PASS。
  const sig = (c) => `${c.bg}|${c.bgImage}|${c.color}|${c.radius}`;
  const sigs = ['classic', 'paper', 'ink', 'aurora'].map((s) =>
    styleSamples[s] ? sig(styleSamples[s]) : 'missing'
  );
  const distinctSigs = new Set(sigs);
  check('C12 四套样式的实际外观互不相同', distinctSigs.size === 4, {
    sigs,
    distinct: distinctSigs.size,
  });

  // 深色主题必须是深底浅字 —— 如果 CSS 变量没接上，ink/aurora 会退回白卡
  const isDark = (c) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c.bg || '');
    if (!m) return false;
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    return (r * 299 + g * 587 + b * 114) / 1000 < 90;
  };
  check(
    'C13 ink / aurora 是深色底（CSS 变量真的接上了）',
    isDark(styleSamples.ink) && isDark(styleSamples.aurora),
    {
      inkBg: styleSamples.ink?.bg,
      auroraBg: styleSamples.aurora?.bg,
      auroraImage: (styleSamples.aurora?.bgImage || '').slice(0, 40),
    }
  );
  check(
    'C14 classic / paper 是浅色底',
    !isDark(styleSamples.classic) && !isDark(styleSamples.paper),
    {
      classicBg: styleSamples.classic?.bg,
      paperBg: styleSamples.paper?.bg,
    }
  );

  // paper 用衬线字体，这是它「像翻词典」的核心特征。
  // 正则里**不能**写 serif —— sans-serif 也含 serif，那样断言恒真。
  const paperFont = styleSamples.paper.wordFont || '';
  const classicFont = styleSamples.classic.wordFont || '';
  check(
    'C15 paper 的单词用衬线字体（且与 classic 不同）',
    /Georgia|Songti|SimSun/i.test(paperFont) &&
      !/Georgia|Songti|SimSun/i.test(classicFont),
    { paperFont, classicFont }
  );

  // ============================================================
  // C16：词性配色在深色主题下依然可分辨（只调亮度不调色相）
  // ============================================================
  // 同样不能只看 vessel 的义项（全是名词），必须遍历全部词性
  const inkPalette = await page.evaluate(() => {
    const pop = document.getElementById('trace-word-popup');
    if (!pop) return null;
    const keys = [
      'noun', 'verb', 'adj', 'adv', 'pron', 'prep', 'conj',
      'interj', 'num', 'aux', 'art', 'part', 'phrase', 'other',
    ];
    const host = document.createElement('div');
    host.style.position = 'absolute';
    host.style.visibility = 'hidden';
    pop.appendChild(host);
    const out = {};
    for (const k of keys) {
      const el = document.createElement('i');
      el.className = 'trace-pop-pos';
      el.dataset.pos = k;
      host.appendChild(el);
      const cs = getComputedStyle(el);
      out[k] = { fg: cs.color, bg: cs.backgroundColor };
    }
    host.remove();
    return out;
  });
  const inkFgs = Object.values(inkPalette || {}).map((v) => v.fg);
  check(
    'C16 深色主题下 14 种词性颜色仍互不相同',
    inkFgs.length === 14 && new Set(inkFgs).size === 14,
    {
      style: styleSamples.ink?.style,
      distinctFg: new Set(inkFgs).size,
      sample: { noun: inkPalette?.noun, verb: inkPalette?.verb },
    }
  );

  // C17：本句译文的英文行在四套主题下都要达到 WCAG AA 对比度 4.5:1。
  // 这条是量出来的，不是看截图看出来的 —— 四套主题原来全部只有 2.66~3.90:1，
  // 视觉上就是「有字，但读不动」，而当时的测试没有任何断言管这件事。
  const ctxRatios = ['classic', 'paper', 'ink', 'aurora'].map((s) => ({
    style: s,
    cr: styleSamples[s]?.ctxContrast,
    fs: styleSamples[s]?.ctxFontSize,
  }));
  check(
    'C17 本句译文英文行在四套主题下对比度 ≥ 4.5:1',
    ctxRatios.every((r) => typeof r.cr === 'number' && r.cr >= 4.5),
    Object.fromEntries(ctxRatios.map((r) => [r.style, `${r.cr}:1`]))
  );
  check(
    'C18 本句译文英文行字号 ≥ 13px（12px 在深底上再高的对比度也吃力）',
    ctxRatios.every((r) => r.fs >= 13),
    Object.fromEntries(ctxRatios.map((r) => [r.style, `${r.fs}px`]))
  );

  check('C19 无 JS 错误', errors.length === 0, { errors: errors.slice(0, 3) });

  await ctx.close();
  finish();

  function finish() {
    const pass = failed.length === 0;
    console.log('');
    if (!pass) console.log('FAILED:', failed.join(', '));
    console.log(
      `RESULT: ${pass ? 'PASS' : 'FAIL'}（查词卡片：详细程度三档 + 四套样式 + 词性配色 + 词典多源兜底）`
    );
    process.exit(pass ? 0 : 1);
  }
})().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
