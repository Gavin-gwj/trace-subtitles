// 全量文本对比度审计：遍历所有可见文字节点，算出「实际合成后的背景」与文字色的
// WCAG 对比度，按 WCAG AA 阈值（正文 4.5:1，>=18.66px 或 >=14px 粗体 3:1）判定。
// 背景无法判定（图片/渐变）的元素单独标 unknown，不猜。
//
// 两遍独立审计，因为抽屉打开时背景会被 .scrim 压暗 24%，此时列表里的文字本来
// 就是「刻意的次要态」，把它的对比度算进去会误报（实测会把 .pill-new 从 5.3
// 误判成 4.26）。所以：
//   第一遍 抽屉关闭 → 只审主页面（列表/侧栏/KPI/图表）
//   第二遍 抽屉打开 → 只审 #drawer 内部
// 两遍的失败项取并集，才是「用户真正需要读清的文字」。
const path = require('path');
const { chromium } = require('playwright');
const { seed } = require('./lib/seed-wordbook');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');

// 用法: node a11y-contrast.js [light|dark] [word]
(async () => {
  const theme = process.argv[2] || 'light';
  const word = process.argv[3] || 'pipeline';
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.chrome-a11y-' + process.pid), {
    headless: false,
    executablePath: CHROME,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--mute-audio', ...require('./lib/proxy').proxyArgs()],
    viewport: { width: 1440, height: 940 },
  });
  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  await seed(sw);
  await sw.evaluate(async (t) => { await globalThis.__traceDebug.setSettings({ wbTheme: t }); }, theme);
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/wordbook.html`);
  await page.waitForTimeout(1200);

  const audit = (scopeSel) =>
    page.evaluate((scope) => {
      // color(srgb 0.62 0.31 0.30 / 0.07) 是 color-mix 的计算结果，分量是 0..1，
      // 不能当 0..255 读。rgba() 的 alpha 是第 4 位，color() 同理。
      const parse = (s) => {
        const m = s.match(/[\d.]+/g);
        if (!m) return null;
        let n = m.map(Number);
        let a = 1;
        if (/^color\(srgb/i.test(s)) {
          if (n.length > 3) a = n[3];
          n = n.slice(0, 3).map((v) => Math.round(v * 255));
        } else if (s.startsWith('rgba')) {
          a = n.length > 3 ? n[3] : 1;
        }
        return { r: n[0], g: n[1], b: n[2], a };
      };
      const over = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      });
      const lin = (c) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        return +(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2));
      };

      // 逐级向上合成背景，遇到不透明层就停；遇到渐变/图片则标记未知。
      // 只有当子元素确实落在祖先的边框盒内时，祖先的底色才画在它下面 ——
      // 绝对定位到祖先盒子之外的子元素（如轴刻度）不能把祖先底色算进去。
      const effBg = (el) => {
        let acc = null;
        let node = el;
        let guard = 0;
        let probe = el.getBoundingClientRect();
        while (node && node.nodeType === 1 && guard++ < 40) {
          const cs = getComputedStyle(node);
          const box = node.getBoundingClientRect();
          const inside = probe.left >= box.left - 0.5 && probe.right <= box.right + 0.5 && probe.top >= box.top - 0.5 && probe.bottom <= box.bottom + 0.5;
          if (inside) {
            if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
            const c = parse(cs.backgroundColor);
            if (c && c.a > 0) acc = acc ? over(acc, c) : c;
            if (acc && acc.a >= 0.999) return acc;
          }
          probe = box;
          node = node.parentElement;
        }
        return acc ? over(acc, { r: 255, g: 255, b: 255, a: 1 }) : { r: 255, g: 255, b: 255, a: 1 };
      };

      // 祖先链 opacity 会连乘后把文字色往背景洗淡 —— 实际对比度必须按洗淡后的
      // 颜色算，否则 .w-act（opacity .35）这类会被误判为达标。
      const opacityChain = (el) => {
        let o = 1;
        let n = el;
        while (n && n.nodeType === 1) {
          o *= +getComputedStyle(n).opacity;
          n = n.parentElement;
        }
        return o;
      };

      const root = scope ? document.querySelector(scope) : document.body;
      if (!root) return { total: 0, fails: [] };
      const out = [];
      const seen = new Set();
      const walk = (el) => {
        for (const child of el.childNodes) {
          if (child.nodeType === 3 && child.textContent.trim()) {
            const parent = child.parentElement;
            if (!parent || seen.has(parent)) continue;
            seen.add(parent);
            if (scope && !root.contains(parent)) continue;
            const cs = getComputedStyle(parent);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            const opacity = opacityChain(parent);
            // opacity:0 的文字在屏幕上根本不存在（浮层提示的默认态），不参与审计。
            if (opacity === 0) continue;
            const bg = effBg(parent);
            const fgRaw = parse(cs.color);
            if (!bg || !fgRaw) continue;
            const fg = over(fgRaw, bg);
            const fgShown = opacity < 1
              ? { r: fg.r * opacity + bg.r * (1 - opacity), g: fg.g * opacity + bg.g * (1 - opacity), b: fg.b * opacity + bg.b * (1 - opacity), a: 1 }
              : fg;
            const fs = parseFloat(cs.fontSize);
            const bold = +cs.fontWeight >= 700;
            const large = fs >= 18.66 || (fs >= 14 && bold);
            const need = large ? 3 : 4.5;
            const r = ratio(fgShown, bg);
            out.push({
              txt: child.textContent.trim().replace(/\s+/g, ' ').slice(0, 28),
              sel: parent.className && typeof parent.className === 'string'
                ? '.' + parent.className.trim().split(/\s+/).join('.')
                : parent.tagName.toLowerCase(),
              id: parent.id || undefined,
              fs: +fs.toFixed(1),
              bold,
              color: `rgb(${fg.r | 0},${fg.g | 0},${fg.b | 0})`,
              bg: `rgb(${bg.r | 0},${bg.g | 0},${bg.b | 0})`,
              ratio: r,
              need,
              pass: r >= need,
              opacity: +opacity.toFixed(2),
            });
          } else if (child.nodeType === 1) {
            const cs = getComputedStyle(child);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            walk(child);
          }
        }
      };
      walk(root);
      return { total: out.length, fails: out.filter((x) => !x.pass), dim: out.filter((x) => x.opacity < 1) };
    }, scopeSel);

  const pageAudit = await audit(null);
  await page.click(`.wrow[data-w="${word}"]`);
  await page.waitForTimeout(600);
  const drawerAudit = await audit('#drawer');

  // 复习台是独立页面，一起审。两个页共享同一套 token，但组件完全不同
  // （卡片、热力图、面板），只审 wordbook 会漏掉一半界面。
  // 审计函数体不抽公共模块：它是自包含的一片 DOM 遍历，抽出去反而要处理
  // 两页不同的注入时机；宁可多一份也要保证单页可独立运行。
  const reviewPage = await ctx.newPage();
  await reviewPage.goto(`chrome-extension://${new URL(sw.url()).host}/review.html`);
  await reviewPage.waitForTimeout(1200);

  // 复习台必须审两遍：正面（只有单词和「看释义」）与背面（释义 + 三档评级）。
  // 只审正面会整整漏掉评级按钮里的 .r-hint/.r-k 这些小字 —— 它们恰恰是
  // 全页字号最小（10px）+ 带 opacity 的地方，是最该被这条审计盯住的目标。
  const auditIn = (pg) =>
    pg.evaluate(() => {
    const parse = (s) => {
      const m = s.match(/[\d.]+/g);
      if (!m) return null;
      let n = m.map(Number);
      let a = 1;
      if (/^color\(srgb/i.test(s)) {
        if (n.length > 3) a = n[3];
        n = n.slice(0, 3).map((v) => Math.round(v * 255));
      } else if (n.length > 3) {
        a = n[3];
      }
      return { r: n[0], g: n[1], b: n[2], a };
    };
    const lum = (c) => {
      const f = (v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const blend = (top, bottom) => {
      const a = top.a == null ? 1 : top.a;
      return {
        r: top.r * a + bottom.r * (1 - a),
        g: top.g * a + bottom.g * (1 - a),
        b: top.b * a + bottom.b * (1 - a),
        a: 1,
      };
    };
    const ratio = (f, b) => {
      const L1 = lum(f);
      const L2 = lum(b);
      const hi = Math.max(L1, L2);
      const lo = Math.min(L1, L2);
      return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
    };
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          const t = child.textContent.trim();
          if (!t) continue;
          const parent = child.parentElement;
          if (!parent) continue;
          const cs = getComputedStyle(parent);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const fg = parse(cs.color);
          if (!fg) continue;

          // 背景合成：祖先链从根往下叠，遇到第一个不透明色就停。
          // 渐变背景算不出「那一点上是什么颜色」，和上面 wordbook 那遍
          // 一样直接跳过，不猜（否则 .brand .mark 的金色渐变会被误判）。
          let bg = { r: 255, g: 255, b: 255, a: 1 };
          let opacity = 1;
          const chain = [];
          let unknownBg = false;
          let probe = parent.getBoundingClientRect();
          let el = parent;
          while (el && el !== document.documentElement) {
            const s = getComputedStyle(el);
            const c = parse(s.backgroundColor);
            const op = parseFloat(s.opacity);
            if (!Number.isNaN(op) && op < 1) opacity *= op;
            const box = el.getBoundingClientRect();
            const inside =
              probe.left >= box.left - 0.5 &&
              probe.right <= box.right + 0.5 &&
              probe.top >= box.top - 0.5 &&
              probe.bottom <= box.bottom + 0.5;
            if (inside && s.backgroundImage && s.backgroundImage !== 'none') {
              unknownBg = true;
              break;
            }
            if (inside && c && c.a > 0) chain.push(c);
            probe = box;
            el = el.parentElement;
          }
          if (unknownBg) continue;
          for (let i = chain.length - 1; i >= 0; i -= 1) bg = blend(chain[i], bg);

          // 文字色本身也可能被祖先 opacity 洗淡
          const shown = opacity < 1 ? blend({ ...fg, a: opacity }, bg) : blend(fg, bg);
          const fs = parseFloat(cs.fontSize);
          const fw = parseInt(cs.fontWeight, 10) || 400;
          const bold = fw >= 700;
          const large = fs >= 18.66 || (fs >= 14 && bold);
          const need = large ? 3 : 4.5;
          const r = ratio(shown, bg);
          out.push({
            txt: child.textContent.trim().replace(/\s+/g, ' ').slice(0, 28),
            sel: parent.className && typeof parent.className === 'string'
              ? '.' + parent.className.trim().split(/\s+/).join('.')
              : parent.tagName.toLowerCase(),
            id: parent.id || undefined,
            fs: +fs.toFixed(1),
            bold,
            color: `rgb(${shown.r | 0},${shown.g | 0},${shown.b | 0})`,
            bg: `rgb(${bg.r | 0},${bg.g | 0},${bg.b | 0})`,
            ratio: r,
            need,
            pass: r >= need,
            opacity: +opacity.toFixed(2),
          });
        } else if (child.nodeType === 1) {
          const cs = getComputedStyle(child);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          walk(child);
        }
      }
    };
    walk(document.body);
    return { total: out.length, fails: out.filter((x) => !x.pass), dim: out.filter((x) => x.opacity < 1) };
    });

  const reviewFront = await auditIn(reviewPage);
  // 揭示答案后卡片背面与三档评级才进 DOM 可见态
  await reviewPage.click('#revealBtn');
  await reviewPage.waitForTimeout(420);
  const reviewBack = await auditIn(reviewPage);
  const reviewAudit = {
    total: reviewFront.total + reviewBack.total,
    fails: [...reviewFront.fails, ...reviewBack.fails],
    dim: [...reviewFront.dim, ...reviewBack.dim],
  };

  const label = await page.evaluate(() => document.documentElement.dataset.theme);
  const fails = [...pageAudit.fails, ...drawerAudit.fails, ...reviewAudit.fails];
  console.log(
    `theme: ${label} | 主页面 ${pageAudit.total} 节点 / 抽屉 ${drawerAudit.total} / 复习台 ${reviewAudit.total} | 未达标: ${fails.length}`
  );
  if (fails.length) console.log(JSON.stringify(fails, null, 1));
  const dim = [...pageAudit.dim, ...drawerAudit.dim, ...reviewAudit.dim];
  if (dim.length) {
    console.log(
      'opacity<1 的节点:',
      JSON.stringify(dim.map((d) => ({ txt: d.txt, sel: d.sel, op: d.opacity, ratio: d.ratio })), null, 1)
    );
  }
  await ctx.close();
  // 退出码表达结果，便于在命令里直接判失败
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
