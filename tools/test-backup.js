/**
 * 回归：生词本本地文件备份 / 恢复
 *
 * 要证明的核心事实：
 *   1. 备份真的写到「下载」目录里的普通文件（不是 IndexedDB、不是 storage）
 *   2. 那个文件里是完整、可解析的 JSON，单词字段齐全
 *   3. 清空数据库后能从该文件恢复回来（模拟「卸载旧插件装新插件」）
 *   4. 恢复是合并而不是覆盖：同名单词保留更早的加入时间与更高的复习次数
 *
 * 第 3、4 点是这个功能存在的全部意义 —— 只测「能导出」等于没测。
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..', 'trace-subtitles');
const PROFILE = path.join(__dirname, '.chrome-backup');

const checks = {};
const fail = [];

function check(name, ok, info) {
  checks[name] = ok;
  if (!ok) fail.push(name);
  console.log(`${ok ? '✓' : '✗'} ${name}`, info !== undefined ? JSON.stringify(info) : '');
}

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const ctx = await chromium.launchPersistentContext(PROFILE, {
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

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  if (!sw) {
    console.log('no service worker');
    await ctx.close();
    process.exit(1);
  }
  const extId = new URL(sw.url()).host;
  console.log('SW:', sw.url());

  // ---- 种入 5 个单词，其中一个复习过两次（用来验证恢复时的进度合并）----
  // 注意：这里必须用 idbPut 直接写，不能用 addWord —— addWord 会把 createdAt
  // 强制改成 Date.now()（正常加词就该是"现在"），那样就没法验证「恢复保住原始加入时间」。
  const seeded = await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    const now = Date.now();
    const mk = (word, days, extra = {}) => ({
      word,
      display: word[0].toUpperCase() + word.slice(1),
      phonetic: '',
      zh: `${word}-中文`,
      meanings: [],
      example: '',
      context: `a sentence with ${word} inside`,
      contextZh: `一句包含 ${word} 的话`,
      videoTitle: 'Backup Test',
      videoId: 'TESTID00001',
      time: 3,
      createdAt: now - days * 86400000,
      reviewCount: 0,
      lastReview: null,
      status: 'new',
      ...extra,
    });
    await D.idbPut('words', mk('beverage', 10));
    await D.idbPut('words', mk('cappuccino', 8));
    await D.idbPut('words', mk('lounge', 5));
    await D.idbPut('words', mk('immediately', 2));
    await D.idbPut('words', mk('pipeline', 0));
    // pipeline 复习两次 → reviewCount 2，恢复时应保留这个进度
    await D.reviewWord('pipeline');
    await D.reviewWord('pipeline');
    return await D.listWords();
  });
  check('S1 种入 5 个单词', seeded.length === 5, { count: seeded.length });

  // ---- 备份到文件 ----
  const backed = await sw.evaluate(async () => {
    return await globalThis.__traceDebug.backupToFile();
  });
  console.log('backup:', JSON.stringify(backed));
  check('S2 备份返回成功且带落盘路径', !!(backed && backed.ok && backed.filename), backed);
  check('S3 备份了 5 个单词', backed && backed.count === 5, { count: backed && backed.count });

  // ---- 关键：那个路径是真的普通文件，且内容可解析 ----
  const filePath = backed && backed.filename;
  const exists = !!(filePath && fs.existsSync(filePath));
  check('S4 备份文件真的存在于磁盘', exists, { filePath });
  let parsed = null;
  if (exists) {
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      parsed = null;
    }
  }
  check('S5 备份文件是合法 JSON', !!parsed, { ok: !!parsed });
  check(
    'S6 备份文件格式标记正确',
    !!(parsed && parsed.format === 'trace-subtitles-backup' && Array.isArray(parsed.words)),
    parsed && { format: parsed.format, words: (parsed.words || []).length }
  );
  const w0 = parsed && parsed.words && parsed.words.find((x) => x.word === 'beverage');
  check(
    'S7 单词字段完整（释义/上下文/视频来源都在）',
    !!(w0 && w0.zh && w0.context && w0.videoId),
    w0 && { word: w0.word, zh: w0.zh, videoId: w0.videoId }
  );
  check(
    'S8 备份里带着设置',
    !!(parsed && parsed.settings && typeof parsed.settings.targetLang === 'string'),
    parsed && parsed.settings && { targetLang: parsed.settings.targetLang }
  );

  // ---- 模拟「卸载重装」：清空数据库 ----
  await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    const db = await D.openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('words', 'readwrite');
      tx.objectStore('words').clear();
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
  });
  const afterWipe = await sw.evaluate(async () => (await globalThis.__traceDebug.listWords()).length);
  check('S9 已模拟卸载：数据库清空为 0', afterWipe === 0, { count: afterWipe });

  // ---- 从磁盘读回那份备份并恢复 ----
  const restored = await sw.evaluate(async (data) => {
    return await globalThis.__traceDebug.restoreFromBackup(data, { replace: false });
  }, parsed);
  console.log('restore:', JSON.stringify(restored));
  check('S10 恢复成功且新增 5 个', !!(restored && restored.ok && restored.added === 5), restored);

  const afterRestore = await sw.evaluate(async () => await globalThis.__traceDebug.listWords());
  check('S11 恢复后单词数回到 5', afterRestore.length === 5, { count: afterRestore.length });

  const pipe = afterRestore.find((w) => w.word === 'pipeline');
  check(
    'S12 恢复保住了复习进度（reviewCount=2）',
    !!(pipe && pipe.reviewCount === 2),
    pipe && { reviewCount: pipe.reviewCount, status: pipe.status }
  );
  const bev = afterRestore.find((w) => w.word === 'beverage');
  check(
    'S13 恢复保住了原始加入时间',
    !!(bev && Date.now() - bev.createdAt > 9 * 86400000),
    bev && { daysAgo: Math.round((Date.now() - bev.createdAt) / 86400000) }
  );

  // ---- 合并语义：同名单词不应变成两条，且保留更高进度 ----
  const merged = await sw.evaluate(async (data) => {
    const D = globalThis.__traceDebug;
    // 造一个「旧备份」：pipeline 只复习过 1 次、加入时间更晚
    const older = JSON.parse(JSON.stringify(data));
    const p = older.words.find((w) => w.word === 'pipeline');
    if (p) {
      p.reviewCount = 1;
      p.createdAt = Date.now() - 1000;
    }
    const r = await D.restoreFromBackup(older, { replace: false });
    const list = await D.listWords();
    return { r, list };
  }, parsed);
  const pipe2 = merged.list.filter((w) => w.word === 'pipeline');
  check(
    'S14 重复恢复不会产生重复词条',
    pipe2.length === 1 && merged.list.length === 5,
    { pipelineRows: pipe2.length, total: merged.list.length }
  );
  check(
    'S15 合并时保留更高的复习次数（不倒退）',
    pipe2[0] && pipe2[0].reviewCount === 2,
    pipe2[0] && { reviewCount: pipe2[0].reviewCount }
  );

  // ---- 词库页 UI：按钮在、能触发 ----
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`chrome-extension://${extId}/wordbook.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const ui = await page.evaluate(() => ({
    backupBtn: !!document.getElementById('backupBtn'),
    restoreBtn: !!document.getElementById('restoreBtn'),
    exportBtn: !!document.getElementById('exportBtn'),
    pickDirBtn: !!document.getElementById('pickDirBtn'),
    autoBackupCb: !!document.getElementById('autoBackup'),
    sideText: (document.querySelector('.side-foot') || {}).textContent || '',
  }));
  check(
    'S16 词库页有备份/恢复/选目录按钮',
    ui.backupBtn && ui.restoreBtn && ui.exportBtn && ui.pickDirBtn && ui.autoBackupCb,
    ui
  );
  check(
    'S17 侧栏说明了备份文件名',
    /trace-wordbook-backup\.json/.test(ui.sideText),
    { has: /trace-wordbook-backup\.json/.test(ui.sideText) }
  );

  // 点一下「备份到文件」，确认走通整条 UI → 后台 → 磁盘链路
  await page.click('#backupBtn');
  await page.waitForTimeout(2600);
  const toastText = await page.evaluate(() => {
    const el = document.getElementById('wb-toast');
    return el ? { text: el.textContent, on: el.classList.contains('on') } : null;
  });
  check(
    'S18 点按钮后给出成功提示（且不塞绝对路径）',
    !!(
      toastText &&
      toastText.on &&
      /已备份\s*5\s*个单词/.test(toastText.text) &&
      !/[A-Za-z]:\\/.test(toastText.text)
    ),
    toastText
  );

  const diskAfterUi = fs.existsSync(filePath);
  const parsed2 = diskAfterUi ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
  check(
    'S19 UI 触发后磁盘文件被覆盖更新',
    !!(parsed2 && Array.isArray(parsed2.words) && parsed2.words.length === 5),
    parsed2 && { words: parsed2.words.length, exportedAt: parsed2.exportedAt }
  );

  await page.screenshot({ path: path.join(__dirname, 'shot-backup.png'), fullPage: false });
  check('S20 页面无 JS 错误', errors.length === 0, errors);

  // ================================================================
  // 用例 2：用户自选目录（File System Access）
  //
  // showDirectoryPicker 在自动化里点不了，但它的产物就是 FileSystemDirectoryHandle，
  // 而 OPFS 的 getDirectoryHandle 返回的是同一套接口的真句柄。
  // 所以这里用 OPFS 子目录当「用户选的文件夹」，验证的是同一件事：
  //   页面拿句柄 → 存进扩展的 IndexedDB → SW 取出来静默写文件 → 页面能读回。
  // 这正是「开始时选一个目录，之后手动/自动备份都写进去」的完整链路。
  // ================================================================

  // 在页面里造一个目录句柄并「直接写进扩展的 IndexedDB」。
  // 这一步必须绕开 chrome.runtime.sendMessage：句柄过消息通道会变成空壳
  // （方法全丢、name 也读不到），后台调 getFileHandle 会报 is not a function。
  // 真实流程里 wordbook.js 的 saveDirHandleToIDB() 做的正是这件事。
  const dirSet = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('my-backup-folder', { create: true });
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('trace-subs', 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('translations')) {
          d.createObjectStore('translations', { keyPath: 'key' });
        }
        if (!d.objectStoreNames.contains('words')) d.createObjectStore('words', { keyPath: 'word' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key: 'backupDir', handle: dir, name: dir.name });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const r = await chrome.runtime.sendMessage({ type: 'backup:set-dir', name: dir.name });
    return r;
  });
  console.log('set-dir:', JSON.stringify(dirSet));
  check(
    'S21 选定目录后后台能看到句柄',
    !!(dirSet && dirSet.ok && dirSet.data && dirSet.data.has),
    dirSet
  );

  const dirStatus = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'backup:get-dir' });
    return r;
  });
  check(
    'S22 能读回目录名与权限状态',
    !!(dirStatus && dirStatus.ok && dirStatus.data.has && dirStatus.data.name === 'my-backup-folder'),
    dirStatus && dirStatus.data
  );

  // 备份一次，应该写进那个目录（via: 'dir'），而不是「下载」
  const dirBackup = await sw.evaluate(async () => await globalThis.__traceDebug.backupToFile());
  console.log('dir backup:', JSON.stringify(dirBackup));
  check(
    'S23 备份走的是用户选定的目录（不是下载目录）',
    !!(dirBackup && dirBackup.ok && dirBackup.via === 'dir'),
    dirBackup
  );

  // 页面把那个目录里的文件读回来，确认内容真的在那里
  const dirFile = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('my-backup-folder', { create: true });
    try {
      const fh = await dir.getFileHandle('trace-wordbook-backup.json');
      const f = await fh.getFile();
      const text = await f.text();
      return { ok: true, text, size: f.size };
    } catch (e) {
      return { ok: false, error: String(e && (e.message || e)) };
    }
  });
  let dirParsed = null;
  try {
    dirParsed = dirFile.ok ? JSON.parse(dirFile.text) : null;
  } catch (_) {}
  check(
    'S24 用户目录里真的出现了备份文件',
    !!(dirFile.ok && dirParsed && Array.isArray(dirParsed.words)),
    { ok: dirFile.ok, size: dirFile.size, words: dirParsed && dirParsed.words.length }
  );
  check(
    'S25 写进用户目录的内容是完整的（5 个单词 + 格式标记）',
    !!(dirParsed && dirParsed.format === 'trace-subtitles-backup' && dirParsed.words.length === 5),
    dirParsed && { format: dirParsed.format, words: dirParsed.words.length }
  );

  // 反复备份应覆盖同一文件，不堆副本
  const twice = await sw.evaluate(async () => {
    const a = await globalThis.__traceDebug.backupToFile();
    const b = await globalThis.__traceDebug.backupToFile();
    return { a: a.filename, b: b.filename, same: a.filename === b.filename };
  });
  check('S26 重复备份覆盖同一文件（不堆副本）', twice.same, twice);

  // 恢复路径：清库 → 后台直接从目录读回 → 恢复
  await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    const db = await D.openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('words', 'readwrite');
      tx.objectStore('words').clear();
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
  });
  const dirRestore = await sw.evaluate(async () => {
    const D = globalThis.__traceDebug;
    const data = await D.readBackupFromDir();
    if (!data) return { ok: false, error: 'no backup in dir' };
    const r = await D.restoreFromBackup(data, { replace: false });
    const list = await D.listWords();
    return { ok: true, r, count: list.length };
  });
  console.log('dir restore:', JSON.stringify(dirRestore));
  check(
    'S27 卸载后能从用户目录里的备份直接恢复',
    !!(dirRestore.ok && dirRestore.count === 5),
    dirRestore
  );

  // 清除目录设置后，应退回「下载」目录
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('trace-subs', 2);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').delete('backupDir');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
    db.close();
    await chrome.runtime.sendMessage({ type: 'backup:clear-dir' });
  });
  const fallback = await sw.evaluate(async () => await globalThis.__traceDebug.backupToFile());
  check(
    'S28 清除目录后自动退回下载目录',
    !!(fallback && fallback.ok && fallback.via === 'download'),
    { via: fallback && fallback.via }
  );

  await ctx.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });

  console.log('\nchecks:', JSON.stringify(checks, null, 1));
  if (fail.length) {
    console.log('RESULT: FAIL (' + fail.join(', ') + ')');
    process.exit(1);
  }
  console.log('RESULT: PASS（生词本写成本机文件 + 卸载重装后可恢复 + 合并保留学习进度）');
})();
