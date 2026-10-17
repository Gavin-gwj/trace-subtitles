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

  window.TraceSubs = { parse, segment, hash, findByTime, SENT_END };
})();
