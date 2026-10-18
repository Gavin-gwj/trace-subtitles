/**
 * Trace 字幕翻译 —— 字幕解析与分句
 *
 * 与 content.js 共享同一个内容脚本世界，挂到 window.TraceSubs 上。
 * 关键点（复刻 Trancy 的核心做法）：
 *   - YouTube 的字幕行是按“显示窗口”切好的碎片，常常半句就断开；
 *   - 翻译必须按“句”送出去，否则机翻质量极差；
 *   - 所以先把碎片行按标点/停顿合并成完整句子，再批量翻译。
 */
(() => {
  'use strict';
  if (window.TraceSubs) return;

  const SENT_END = /[.!?。！？…]["'”’)）\]]*\s*$/;
  const CLAUSE_END = /[,;:，；：、]\s*$/;

  /** 解析 json3 */
  function parseJson3(text) {
    const data = JSON.parse(text);
    const out = [];
    (data.events || []).forEach((e) => {
      if (!e.segs) return;
      const raw = e.segs.map((s) => s.utf8 || '').join('');
      const t = raw.replace(/\n/g, ' ').trim();
      if (!t) return;
      const start = (e.tStartMs || 0) / 1000;
      const dur = (e.dDurationMs || 0) / 1000;
      out.push({ start, end: start + dur, text: t });
    });
    return out;
  }

  /** 解析 srv3 (XML) */
  function parseSrv3(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const out = [];
    doc.querySelectorAll('p').forEach((p) => {
      const t = (p.getAttribute('t') || '0');
      const d = (p.getAttribute('d') || '0');
      const start = parseInt(t, 10) / 1000;
      const dur = parseInt(d, 10) / 1000;
      // srv3 用 <s> 子节点并带换行，取全部文本
      let s = '';
      p.querySelectorAll('s').forEach((n) => {
        s += (n.textContent || '') + ' ';
      });
      if (!s) s = p.textContent || '';
      s = s.replace(/\s+/g, ' ').trim();
      if (!s) return;
      out.push({ start, end: start + dur, text: s });
    });
    return out;
  }

  function parse(kind, text) {
    let rows;
    if (kind === 'json3') rows = parseJson3(text);
    else rows = parseSrv3(text);

    rows = rows
      .filter((r) => r.text)
      .sort((a, b) => a.start - b.start);

    // 去重（YouTube 有时会给重叠的滚动字幕）
    const dedup = [];
    for (const r of rows) {
      const prev = dedup[dedup.length - 1];
      if (prev && prev.text === r.text && Math.abs(prev.start - r.start) < 0.05) continue;
      dedup.push(r);
    }
    // 补全 end
    for (let i = 0; i < dedup.length; i++) {
      if (!dedup[i].end || dedup[i].end <= dedup[i].start) {
        const next = dedup[i + 1];
        dedup[i].end = next ? Math.min(next.start, dedup[i].start + 5) : dedup[i].start + 3;
      }
    }
    return dedup;
  }

  /**
   * 把碎片行合并成句子。
   * 规则：遇到句末标点就收句；单句过长（>maxLen）在逗号处断开；
   * 相邻行间隔过大（>gap）也断开。
   */
  function segment(rows, { maxLen = 180, gap = 2.0 } = {}) {
    const sentences = [];
    let cur = null;

    const flush = () => {
      if (cur && cur.text.trim()) {
        cur.text = cur.text.replace(/\s+/g, ' ').trim();
        sentences.push(cur);
      }
      cur = null;
    };

    for (const r of rows) {
      const piece = r.text.trim();
      if (!piece) continue;

      if (!cur) {
        cur = { start: r.start, end: r.end, text: piece, rows: [r] };
      } else {
        const tooFar = r.start - cur.end > gap;
        const tooLong = (cur.text.length + piece.length) > maxLen;
        if (tooFar || tooLong) flush();
        if (!cur) {
          cur = { start: r.start, end: r.end, text: piece, rows: [r] };
        } else {
          cur.text += ' ' + piece;
          cur.end = r.end;
          cur.rows.push(r);
        }
      }

      // 收句判断
      if (SENT_END.test(cur.text)) {
        flush();
      } else if (CLAUSE_END.test(cur.text) && cur.text.length > maxLen * 0.7) {
        flush();
      }
    }
    flush();
    return sentences;
  }

  /** 稳定哈希，用于翻译缓存 key */
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  /** 按时间查找当前应显示的句子 */
  function findByTime(sentences, t) {
    if (!sentences.length) return null;
    let lo = 0, hi = sentences.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sentences[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (ans < 0) return null;
    // 允许微小提前量，避免字幕闪现延迟
    for (let i = ans; i >= Math.max(0, ans - 1); i--) {
      const s = sentences[i];
      if (t >= s.start - 0.15 && t <= s.end + 0.3) return s;
    }
    return null;
  }

  // ------------------------------------------------------------ 词形归一化
    // >>> WORD_FORMS_BEGIN  (本段在 subtitles.js 与 bg.js 里各有一份，内容必须一致，tools/test-forms.js 会逐行比对)
  // 生词本存的是某个词形（beverage），字幕里出现的可能是另一个词形（beverages）。
  // 这里给出「一个词形可能对应的其它词形」，匹配时看两个集合有没有交集。
  // 取舍：
  //   1) 只做形态学猜测，不做词性标注 —— 多出来的候选只有在生词本里真有那个词时才命中，
  //      误报代价很低；宁可多给候选，也不漏掉词形变化。
  //   2) 双向都生成：存了 beverage 要能命中 beverages，存了 beverages 也要能命中 beverage。
  //   3) 收录不规则**名词**复数（children / knives / halves…），不收录不规则**动词**：
  //      saw(锯子)/saw(see 的过去式)、left(左)/left(leave 的过去式)、found(建立)/found(find 的过去式)
  //      这类同形冲突太多，误报比漏报更烦人。
  //   4) be / have / do 三族一律不收（is/are/was/has/had/does…）：超高频功能词，
  //      一旦收藏会让整屏字幕都在高亮，纯噪音。长度 < 4 的词也不做形态猜测。
  //   5) 单复数同形或不可数词（news/series/species/data…）列进 INVARIANT，
  //      既不拆成词干（news 不能变成 new），也不接受正向加 s。
  const IRREGULAR = {
    // ---- 不规则复数 ----
    children: 'child', men: 'man', women: 'woman', people: 'person',
    feet: 'foot', teeth: 'tooth', mice: 'mouse', geese: 'goose', oxen: 'ox', lice: 'louse',
    halves: 'half', knives: 'knife', wives: 'wife', lives: 'life', leaves: 'leaf',
    loaves: 'loaf', thieves: 'thief', shelves: 'shelf', wolves: 'wolf', calves: 'calf',
    elves: 'elf', scarves: 'scarf', hooves: 'hoof', selves: 'self',
  };

  /** 单复数同形 / 不可数：不能再套 -s 规则（否则 news 会变成 new） */
  const INVARIANT = new Set([
    'news', 'series', 'species', 'means', 'physics', 'mathematics', 'economics',
    'politics', 'ethics', 'measles', 'data', 'media',
  ]);

  /** 返回这个词形可能对应的其它词形（含自身，统一小写） */
  function wordForms(w) {
    const word = String(w || '').toLowerCase();
    const out = new Set([word]);
    if (!word) return out;
    const irr = IRREGULAR[word];
    if (irr) out.add(irr);
    if (word.length < 4) return out;
    const invariant = INVARIANT.has(word);

    // ===== 反向：把变形还原成原形（beverages → beverage）=====
    if (!invariant) {
      if (/(?:s|x|z|ch|sh)es$/.test(word)) out.add(word.slice(0, -2)); // boxes→box
      if (/[^aeiou]ies$/.test(word)) out.add(word.slice(0, -3) + 'y'); // cities→city
      if (/[^aeiou]ves$/.test(word)) {
        const stem = word.slice(0, -3);
        out.add(stem + 'f'); // wolves→wolf
        out.add(stem + 'fe'); // knives→knife
      }
      if (/s$/.test(word) && !/ss$/.test(word) && !/us$/.test(word) && !/is$/.test(word)) {
        out.add(word.slice(0, -1)); // beverages→beverage
      }
    }
    if (/ied$/.test(word)) out.add(word.slice(0, -3) + 'y'); // carried→carry
    else if (/ed$/.test(word)) {
      const base = word.slice(0, -2);
      out.add(base); // walked→walk
      if (/([bcdfgklmnprstvz])\1$/.test(base)) out.add(base.slice(0, -1)); // stopped→stop
      if (base.length >= 2 && !/^(sh|th|wh|ye|the)$/.test(base)) out.add(base + 'e'); // used→use
    }
    if (/ing$/.test(word) && word.length > 5) {
      const base = word.slice(0, -3);
      out.add(base); // walking→walk
      if (/([bcdfgklmnprstvz])\1$/.test(base)) out.add(base.slice(0, -1)); // running→run
      if (base.length >= 2 && !/^(sh|th|wh|ye|the)$/.test(base)) out.add(base + 'e'); // making→make
    }
    if (/ier$/.test(word)) out.add(word.slice(0, -3) + 'y'); // happier→happy
    else if (/er$/.test(word) && word.length > 5) {
      const base = word.slice(0, -2);
      out.add(base); // faster→fast
      if (/([bcdfgklmnprstvz])\1$/.test(base)) out.add(base.slice(0, -1)); // bigger→big
    }
    if (/iest$/.test(word)) out.add(word.slice(0, -4) + 'y'); // happiest→happy
    else if (/est$/.test(word) && word.length > 6) {
      const base = word.slice(0, -3);
      out.add(base); // fastest→fast
      if (/([bcdfgklmnprstvz])\1$/.test(base)) out.add(base.slice(0, -1)); // biggest→big
    }

    // ===== 正向：把原形展开成常见变形（beverage → beverages）=====
    // 只在生词本里真有那个词时才命中，所以多给几个候选不会让画面变乱。
    // 唯一要防的是「展开出来的词本身是高频词」：如果结果是 INVARIANT 里的词就不加，
    // 否则收藏了 new 会让所有 news 都高亮。
    // 已经像变形词的（-s/-es/-ed/-ing/-er/-est）不再继续展开，
    // 否则 beverages 会派生出 beverageses 这种永远匹配不上的垃圾候选。
    const looksInflected = /(?:s|ed|ing|er|est)$/.test(word);
    if (!invariant && !looksInflected) {
      const addForm = (f) => { if (!INVARIANT.has(f)) out.add(f); };
      // 复数 / 三单
      if (/[^aeiou]y$/.test(word)) addForm(word.slice(0, -1) + 'ies'); // city→cities
      else if (/(?:s|x|z|ch|sh)$/.test(word)) addForm(word + 'es'); // box→boxes
      else addForm(word + 's'); // beverage→beverages
      if (/fe$/.test(word)) addForm(word.slice(0, -2) + 'ves'); // knife→knives
      else if (/f$/.test(word)) addForm(word.slice(0, -1) + 'ves'); // half→halves
      // 过去式 / 现在分词
      if (/e$/.test(word)) {
        addForm(word + 'd'); // use→used
        addForm(word.slice(0, -1) + 'ing'); // make→making
      } else if (/[^aeiou]y$/.test(word)) {
        addForm(word.slice(0, -1) + 'ied'); // carry→carried
        addForm(word + 'ing');
      } else {
        addForm(word + 'ed'); // walk→walked
        addForm(word + 'ing'); // walk→walking
      }
      // 比较级 / 最高级（短词才加）
      if (word.length <= 6) {
        if (/[^aeiou]y$/.test(word)) { addForm(word.slice(0, -1) + 'ier'); addForm(word.slice(0, -1) + 'iest'); }
        else { addForm(word + 'er'); addForm(word + 'est'); }
      }
    }

    return out;
  }
  // >>> WORD_FORMS_END

  window.TraceSubs = { parse, segment, hash, findByTime, wordForms, SENT_END };
})();
