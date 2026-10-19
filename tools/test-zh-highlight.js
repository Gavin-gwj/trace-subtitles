/**
 * 中文高亮专项测试
 *
 * 验证「生词本里的词，在译文里对应中文也高亮」这条链路：
 *   1. 英文词高亮（trace-saved）
 *   2. 中文对应词高亮（trace-saved-zh），位置准确
 *   3. 中文高亮样式 = 青色 + 斜体 + 虚线下划线
 *   4. 译文里不残留哨兵字符 ⟦ ⟧
 *   5. 一句话里多个生词同时高亮
 *   6. 点击中文高亮能打开同一个生词卡
 *   7. 移除生词后中文高亮消失
 *
 * 用法: node test-zh-highlight.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const fx = require('./mock/fixtures');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const ORIGIN = 'https://www.youtube.com';
const WATCH = `${ORIGIN}/watch?v=${fx.VIDEO_ID}`;

(async () => {
  const userDataDir = path.join(__dirname, '.chrome-zhhl');
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
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });

  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    if (p === '/youtubei/v1/player') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' },
        body: JSON.stringify({ playerResponse: fx.playerResponse() }),
      });
    }
    if (p === '/api/timedtext') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' },
        body: fx.json3Body(),
      });
    }
    if (p === '/watch' || p === '/' || p === '') {
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: fx.pageHtml(),
      });
    }
    return route.fulfill({ status: 404, body: 'nf' });
  });

  const logs = [];
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('console', (m) => {
    const t = m.text();
    if (/Trace/i.test(t)) {
      logs.push(t);
      console.log(`  console[${m.type()}] ${t}`);
    }
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  console.log('SW:', sw ? sw.url() : 'NOT FOUND');
  if (!sw) {
    console.log('RESULT: FAIL (no service worker)');
    await ctx.close();
    process.exit(1);
  }

  await page.goto(WATCH, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 等字幕出现
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(700);
    ready = await page.evaluate(() => {
      const o = document.getElementById('trace-sub-overlay');
      return !!(o && o.querySelector('.trace-sub-orig')?.textContent && o.querySelector('.trace-sub-trans')?.textContent);
    });
    if (ready) break;
  }
  console.log('subtitles ready:', ready);

  // 注意：这里不能暂停。MediaStream 不支持 seek，只能靠自然播放推进时间轴，
  // 目标句（含 wordbook 的那句）在第 14~16 秒，必须让它自己播到那里。
  // ---- 直接在 SW 里塞几个生词，避免逐个人工点击太慢 ----
  // 选一句含多个词的：'Click any word to look it up and save it to your wordbook.'
  const seeded = await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    const words = [
      { word: 'word', display: 'word', zh: '单词', meanings: [], example: '', context: '', contextZh: '', videoTitle: 'Mock Video', videoId: 'TESTID00001', time: 0 },
      { word: 'wordbook', display: 'wordbook', zh: '单词本', meanings: [], example: '', context: '', contextZh: '', videoTitle: 'Mock Video', videoId: 'TESTID00001', time: 0 },
    ];
    const out = [];
    for (const w of words) out.push(await D.addWordNotify(w));
    return { added: out.length, keys: await D.wordKeys() };
  });
  console.log('seeded wordbook:', JSON.stringify(seeded));

  // 等含这两个词的那一句出现（自然播放），再暂停
  console.log('waiting for the sentence with word/wordbook...');
  let target = null;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(300);
    target = await page.evaluate(() => {
      const o = document.querySelector('#trace-sub-overlay .trace-sub-orig');
      const t = document.querySelector('#trace-sub-overlay .trace-sub-trans');
      if (!o || !t) return null;
      const orig = o.textContent || '';
      if (!/wordbook/i.test(orig)) return null;
      return { orig, trans: t.textContent || '' };
    });
    if (target) break;
  }
  if (!target) {
    console.log('RESULT: FAIL (没等到含 wordbook 的句子)');
    await ctx.close();
    process.exit(1);
  }
  await page.evaluate(() => window.__mockPause && window.__mockPause());
  await page.waitForTimeout(500);
  console.log('target sentence:', JSON.stringify(target));

  // ---- 等中文对齐高亮出现 ----
  let zh = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    zh = await page.evaluate(() => {
      const t = document.querySelector('#trace-sub-overlay .trace-sub-trans');
      if (!t) return { present: false };
      const spans = [...t.querySelectorAll('.trace-saved-zh')];
      const st = spans[0] ? getComputedStyle(spans[0]) : null;
      return {
        present: true,
        text: t.textContent || '',
        count: spans.length,
        words: spans.map((s) => s.dataset.w),
        zhTexts: spans.map((s) => s.textContent),
        hasSentinel: /[\u27E6\u27E7]/.test(t.textContent || ''),
        italic: st ? st.fontStyle === 'italic' : false,
        underline: st ? st.textDecorationLine.includes('underline') : false,
        dash: st ? st.textDecorationStyle : '',
        color: st ? st.color : '',
      };
    });
    if (zh.count >= 2) break;
  }
  console.log('zh highlight:', JSON.stringify(zh, null, 1));

  // ---- 点击中文高亮，应打开同一个生词卡 ----
  let clickOk = null;
  const zhEl = await page.$('#trace-sub-overlay .trace-saved-zh');
  if (zhEl) {
    await zhEl.click();
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      clickOk = await page.evaluate(() => {
        const p = document.getElementById('trace-word-popup');
        if (!p) return { present: false };
        const b = p.querySelector('[data-act="remove"]') || p.querySelector('[data-act="add"]');
        return {
          present: true,
          hidden: p.classList.contains('trace-hidden'),
          word: p.querySelector('.trace-pop-word')?.textContent || '',
          loading: !!p.querySelector('.trace-pop-loading'),
          btnAct: b?.dataset.act || '',
        };
      });
      if (clickOk.present && !clickOk.loading) break;
    }
  }
  console.log('click zh span:', JSON.stringify(clickOk));

  await page.screenshot({ path: path.join(__dirname, 'shot-zh-highlight.png') });

  // ---- 移除一个词，中文高亮应减少 ----
  let afterRemove = null;
  if (clickOk && clickOk.word) {
    await page.evaluate(() => document.querySelector('#trace-word-popup [data-act="close"]')?.click());
    await page.waitForTimeout(300);
    await sw.evaluate(async (w) => {
      const D = globalThis.__traceDebug;
      return D.removeWord(w);
    }, clickOk.word);
    // 触发一次刷新：重新加载当前句
    await page.evaluate(() => window.__mockPlay && window.__mockPlay());
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__mockPause && window.__mockPause());
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      afterRemove = await page.evaluate(() => {
        const t = document.querySelector('#trace-sub-overlay .trace-sub-trans');
        const o = document.querySelector('#trace-sub-overlay .trace-sub-orig');
        if (!t) return null;
        return {
          zhCount: t.querySelectorAll('.trace-saved-zh').length,
          enCount: o ? o.querySelectorAll('.trace-word.trace-saved').length : 0,
          trans: t.textContent || '',
        };
      });
      if (afterRemove && afterRemove.zhCount < (zh?.count || 99)) break;
    }
  }
  console.log('after remove:', JSON.stringify(afterRemove));

  // ---- 同一个词重复出现时，译文里绝不能漏出哨兵记号 ----
  // 这是 bug 12：Google 对重复词去重时会删掉相邻的一个括号，
  // 早期版本用「成对括号」匹配，坏掉的槽位匹配失败 → `⟦2⟧`、`⟧3⟧` 原样进译文。
  const repeat = await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    const text =
      '>> What you will do Put and the top and prise it open so you got two halves. ' +
      'Cream on the bottom of both halves, dollop of jam on both halves.';
    const r = await D.translateAligned([text], [['halves']], 'en', 'zh-CN');
    const zh = r.texts[0] || '';
    return {
      zh,
      hasSentinel: /[\u27E6\u27E7]/.test(zh),
      // 译文里出现孤立的 0-9（不是「两半」「30 秒」这类正常数字）就算泄漏
      hasStrayDigit: /\d/.test(zh),
      spans: (r.spans[0] || []).map((s) => ({ w: s.word, zh: s.zh })),
    };
  });
  console.log('repeated word:', JSON.stringify(repeat, null, 1));

  await ctx.close();

  const checks = {
    zhPresent: !!(zh && zh.present && zh.count >= 2),
    noSentinel: !!(zh && !zh.hasSentinel),
    styled: !!(zh && zh.italic && zh.underline && zh.dash === 'dashed'),
    cyan: !!(zh && /127,\s*227,\s*212/.test(zh.color || '')),
    clickOpens: !!(clickOk && clickOk.present && !clickOk.hidden && clickOk.btnAct === 'remove'),
    removed: !!(afterRemove && afterRemove.zhCount < (zh?.count || 99)),
    repeatOk: !!(repeat && !repeat.hasSentinel && !repeat.hasStrayDigit && repeat.spans.length >= 1),
  };
  const pass = Object.values(checks).every(Boolean);
  console.log('\nchecks:', JSON.stringify(checks));
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  process.exit(pass ? 0 : 1);
})();
