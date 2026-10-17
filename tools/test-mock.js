/**
 * 端到端测试（离线夹具版）
 *
 * 用 Playwright 的 page.route() 把 https://www.youtube.com/* 整体伪造：
 *   /watch              → 仿 YouTube 播放器页面（带 getPlayerResponse）
 *   /youtubei/v1/player → 带 captionTracks 的响应（触发 main-world 钩子）
 *   /api/timedtext      → json3 字幕
 *
 * 这样扩展的 content_scripts 会真正注入、真正跑完整链路，
 * 且完全不依赖 YouTube 真实站点与登录态。
 *
 * 用法: node test-mock.js
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
  const userDataDir = path.join(__dirname, '.chrome-mock');
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
    ],
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });

  // ---- 伪造 YouTube 站点 ----
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
    if (/Trace|trace/i.test(t)) {
      logs.push(`[${m.type()}] ${t}`);
      console.log(`  console[${m.type()}] ${t}`);
    }
  });
  page.on('pageerror', (e) => {
    logs.push(`[pageerror] ${e.message}`);
    console.log('  pageerror:', e.message);
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  console.log('SW:', sw ? sw.url() : 'NOT FOUND');
  if (!sw) {
    console.log('RESULT: FAIL (no service worker)');
    await ctx.close();
    process.exit(1);
  }

  console.log('navigating:', WATCH);
  await page.goto(WATCH, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // ---- 等字幕渲染 ----
  console.log('waiting for subtitles...');
  let ok = false;
  let st = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(700);
    st = await page.evaluate(() => {
      const o = document.getElementById('trace-sub-overlay');
      if (!o) return { present: false };
      return {
        present: true,
        orig: o.querySelector('.trace-sub-orig')?.textContent || '',
        trans: o.querySelector('.trace-sub-trans')?.textContent || '',
        empty: o.classList.contains('trace-empty'),
      };
    }).catch((e) => ({ present: false, err: e.message }));

    if (st.present && st.orig && st.trans) {
      console.log(`  ✓ 双语字幕渲染成功 @${i}:`, JSON.stringify(st));
      ok = true;
      break;
    }
    if (i % 4 === 0) console.log(`  ...${i}`, JSON.stringify(st));
  }

  // ---- 深度诊断 ----
  // 注意：content script 跑在隔离世界，page.evaluate 看不到它的 window 标志位，
  // 所以 __TRACE_CONTENT__ / TraceSubs 为 false 是正常的；主世界标志位可见。
  const diag = await page.evaluate(async () => {
    const out = {};
    out.mainWorld = !!window.__TRACE_MAIN__;
    out.isolatedWorldNotVisible = !window.TraceSubs;
    out.tracks = await new Promise((res) => {
      const id = 'diag' + Math.random();
      const h = (ev) => {
        const d = ev.data;
        if (d && d.type === '__TRACE_RES__' && d.id === id) {
          window.removeEventListener('message', h);
          res(d.ok ? d.data : { error: d.error });
        }
      };
      window.addEventListener('message', h);
      window.postMessage({ type: '__TRACE_REQ__', id, action: 'tracks' }, location.origin);
      setTimeout(() => res({ timeout: true }), 3000);
    });
    out.timedtext = await new Promise((res) => {
      const id = 'diag2' + Math.random();
      const h = (ev) => {
        const d = ev.data;
        if (d && d.type === '__TRACE_RES__' && d.id === id) {
          window.removeEventListener('message', h);
          res(d.ok ? { kind: d.data.kind, len: d.data.text.length } : { error: d.error });
        }
      };
      window.addEventListener('message', h);
      const url = (out.tracks && out.tracks[0] && out.tracks[0].baseUrl) || '/api/timedtext';
      window.postMessage({ type: '__TRACE_REQ__', id, action: 'fetch', payload: { url } }, location.origin);
      setTimeout(() => res({ timeout: true }), 5000);
    });
    out.videoTime = document.querySelector('video')?.currentTime ?? null;
    return out;
  }).catch((e) => ({ err: e.message }));

  console.log('diag:', JSON.stringify(diag, null, 1));

  // 分句结果从内容脚本的 console.info 里取（"N 行字幕 → M 句"）
  const segLine = logs.find((l) => /已加载.*句/.test(l)) || '';
  const segMatch = segLine.match(/已加载\s*(\d+)\s*行字幕\s*→\s*(\d+)\s*句/);
  const seg = segMatch
    ? { rows: Number(segMatch[1]), sentences: Number(segMatch[2]), line: segLine }
    : null;
  console.log('segmentation:', JSON.stringify(seg, null, 1));

  // ---- 点词查词 + 加入生词本 ----
  let wordTest = null;
  let added = null;
  let highlight = null;
  let reopenState = null;
  try {
    // 先暂停播放：查词/生词本/高亮断言都要求字幕停在当前句，
    // 否则真实时间轴推进会让字幕换句，断言目标词就不在屏幕上了。
    await page.evaluate(() => window.__mockPause && window.__mockPause());
    await page.waitForTimeout(400);
    const w = await page.$('#trace-sub-overlay .trace-word');
    if (w) {
      await w.click();
      // 等词典返回（最坏情况 3.5s 词典超时 + 中文翻译）
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(500);
        wordTest = await page.evaluate(() => {
          const p = document.getElementById('trace-word-popup');
          if (!p) return { present: false };
          const loading = !!p.querySelector('.trace-pop-loading');
          return {
            present: true,
            hidden: p.classList.contains('trace-hidden'),
            word: p.querySelector('.trace-pop-word')?.textContent || '',
            zh: p.querySelector('.trace-pop-zh')?.textContent || '',
            phon: p.querySelector('.trace-pop-phon')?.textContent || '',
            meanings: p.querySelectorAll('.trace-pop-meanings li').length,
            hasAddBtn: !!p.querySelector('[data-act="add"]'),
            loading,
          };
        });
        if (!wordTest.loading && wordTest.present) break;
      }
      console.log('word popup:', JSON.stringify(wordTest, null, 1));

      // 点击"加入生词本"
      const btn = await page.$('#trace-word-popup [data-act="add"]');
      let addState = null;
      if (btn) {
        await btn.click();
        await page.waitForTimeout(1500);
        addState = await page.evaluate(() => {
          const p = document.getElementById('trace-word-popup');
          const b = p?.querySelector('[data-act="remove"]') || p?.querySelector('[data-act="add"]');
          return {
            btnText: b?.textContent || '',
            btnAct: b?.dataset.act || '',
            isDone: !!p?.querySelector('.trace-pop-add.trace-done'),
          };
        });
        console.log('add button after click:', JSON.stringify(addState));

        // 通过 SW 直接核对生词本
        const sw = ctx.serviceWorkers()[0];
        if (sw) {
          added = await sw.evaluate(async () => {
            const D = globalThis.__traceDebug;
            return D ? await D.idbAll('words') : null;
          }).catch((e) => ({ err: e.message }));
          console.log('wordbook:', JSON.stringify(added, null, 1));
        }

        // ---- 高亮断言：当前字幕里该词应带 trace-saved ----
        const savedWord = (wordTest?.word || '').toLowerCase();
        highlight = await page.evaluate((w) => {
          const spans = [...document.querySelectorAll('#trace-sub-overlay .trace-word')];
          const hit = spans.find((s) => s.dataset.w?.toLowerCase() === w);
          const savedCount = spans.filter((s) => s.classList.contains('trace-saved')).length;
          return {
            found: !!hit,
            hasSavedClass: !!hit?.classList.contains('trace-saved'),
            savedCount,
          };
        }, savedWord);
        console.log('highlight:', JSON.stringify(highlight));

        // ---- 重新点击该词：弹窗应显示"已在生词本"，而不是"加入生词本" ----
        await page.click('#trace-word-popup [data-act="close"]').catch(() => {});
        await page.waitForTimeout(300);
        const again = await page.$('#trace-sub-overlay .trace-word');
        if (again) {
          await again.click();
          let reopen = null;
          for (let i = 0; i < 20; i++) {
            await page.waitForTimeout(500);
            reopen = await page.evaluate(() => {
              const p = document.getElementById('trace-word-popup');
              if (!p) return { present: false };
              const b = p.querySelector('[data-act="remove"]') || p.querySelector('[data-act="add"]');
              return {
                present: true,
                loading: !!p.querySelector('.trace-pop-loading'),
                btnText: b?.textContent || '',
                btnAct: b?.dataset.act || '',
              };
            });
            if (reopen.present && !reopen.loading) break;
          }
          console.log('reopen popup:', JSON.stringify(reopen));
          reopenState = reopen;
        }
      }
    } else {
      console.log('word popup: no .trace-word found');
    }
  } catch (e) {
    console.log('word click failed:', e.message);
  }

  const shot = path.join(__dirname, 'shot-mock.png');
  await page.screenshot({ path: shot });
  console.log('screenshot:', shot);

  await ctx.close();

  const hlOk = !!(highlight && highlight.found && highlight.hasSavedClass);
  const reopenOk = !!(reopenState && reopenState.btnAct === 'remove');
  const pass = ok && seg && seg.sentences > 0 && hlOk && reopenOk;
  console.log(
    `\nchecks: subs=${!!ok} seg=${seg?.sentences || 0} highlight=${hlOk} reopen=${reopenOk}`
  );
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  process.exit(pass ? 0 : 1);
})();
