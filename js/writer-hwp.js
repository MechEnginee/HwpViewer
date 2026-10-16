/* HWP 5.0 저장: 편집된 문단/표만 레코드를 다시 만들고 나머지는 원본 그대로 유지 */
(function (global) {
  'use strict';

  const PX_HWPUNIT = 7200 / 96;
  const { T } = global.HwpRecords;
  const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const rec = (tag, level, data) => ({ tag, level, data, children: [] });
  const cloneNode = (n) => ({ tag: n.tag, level: n.level, data: n.data.slice(), children: n.children.map(cloneNode) });
  const toUnit = (px) => Math.max(0, Math.round(px * PX_HWPUNIT));

  // ---------- 새 문단/셀 (편집기에서 사용) ----------
  function newParaLike(para) {
    const raw = cloneNode(para.raw);
    raw.data[11] = 0; // 쪽/단 나누기 해제
    if (raw.data.length >= 22) view(raw.data).setUint32(18, (Math.random() * 0x7FFFFFFF) >>> 0, true);
    return { shape: para.shape, items: [], cs: para.cs, raw, dirty: true };
  }

  function newCellLike(cell) {
    return {
      ...cell, raw: cloneNode(cell.raw), paras: [newParaLike(cell.paras[0])],
    };
  }

  // ---------- 문단 ----------
  function itemCodes(it) {
    if (it.codes) return it.codes;
    if (it.t === 'br') return [10];
    return [];
  }

  function writePara(p) {
    const node = p.raw;
    const lvl = node.level + 1;
    const codes = [], runs = [], ctrls = [];
    let mask = 0;
    const addRun = (pos, cs) => {
      const last = runs[runs.length - 1];
      if (last && last[1] === cs) return;
      if (last && last[0] === pos) last[1] = cs; else runs.push([pos, cs]);
    };
    for (const it of p.items) {
      if (it.t === 'text') {
        for (let i = 0; i < it.text.length; i++) {
          let c = it.text.charCodeAt(i);
          if (c === 0xA0) c = 30; // 묶음 빈칸
          else if (c < 32) continue;
          addRun(codes.length, it.cs);
          codes.push(c);
        }
        continue;
      }
      if (it.node) ctrls.push(it.node);
      const cc = itemCodes(it);
      if (cc.length) {
        addRun(codes.length, it.cs ?? p.cs);
        if (cc[0] < 32) mask |= 1 << cc[0];
        codes.push(...cc);
      }
    }
    if (!runs.length) runs.push([0, p.cs || 0]);
    runs[0][0] = 0;
    const hasText = codes.length > 0;
    if (hasText) codes.push(13);

    const children = [];
    if (hasText) {
      const t = new Uint8Array(codes.length * 2);
      const tv = view(t);
      codes.forEach((c, i) => tv.setUint16(i * 2, c, true));
      children.push(rec(T.PARA_TEXT, lvl, t));
    }
    const cs = new Uint8Array(runs.length * 8);
    const cv = view(cs);
    runs.forEach(([pos, id], i) => { cv.setUint32(i * 8, pos, true); cv.setUint32(i * 8 + 4, id, true); });
    children.push(rec(T.PARA_CHAR_SHAPE, lvl, cs));
    const ls = node.children.find((c) => c.tag === T.PARA_LINE_SEG && c.data.length >= 36);
    if (ls) {
      const seg = ls.data.slice(0, 36);
      const sv = view(seg);
      sv.setUint32(0, 0, true);
      sv.setUint32(32, sv.getUint32(32, true) & ~3, true);
      children.push(rec(T.PARA_LINE_SEG, lvl, seg));
    }
    for (const c of ctrls) children.push(c);
    node.children = children;

    const hv = view(node.data);
    hv.setUint16(8, p.shape, true);
    const last = hv.getUint32(0, true) & 0x80000000;
    hv.setUint32(0, ((hasText ? codes.length : 1) | last) >>> 0, true);
    hv.setUint32(4, mask >>> 0, true);
    hv.setUint16(12, runs.length, true);
    hv.setUint16(14, 0, true);
    hv.setUint16(16, ls ? 1 : 0, true);
    p.dirty = false;
    p.restack = true;
  }

  function setLast(p, flag) {
    const hv = view(p.raw.data);
    const v = hv.getUint32(0, true) & 0x7FFFFFFF;
    hv.setUint32(0, (v | (flag ? 0x80000000 : 0)) >>> 0, true);
  }

  function writeParas(list) {
    for (const p of list) {
      for (const it of p.items) {
        if (it.t === 'table') {
          if (it.dirty) writeTable(it);
          else it.cells.forEach((c) => writeParas(c.paras));
        } else if (it.t === 'box') writeParas(it.paras);
      }
      if (p.dirty) writePara(p);
    }
    list.forEach((p, i) => setLast(p, i === list.length - 1));
  }

  // ---------- 표 ----------
  function colWidths(t) {
    const colW = new Array(t.cols).fill(null);
    for (const c of t.cells) if (c.colSpan === 1 && colW[c.col] == null) colW[c.col] = c.w;
    for (const c of t.cells) {
      if (c.colSpan <= 1) continue;
      const idx = []; let known = 0;
      for (let i = c.col; i < c.col + c.colSpan && i < t.cols; i++) { if (colW[i] == null) idx.push(i); else known += colW[i]; }
      idx.forEach((i) => { colW[i] = Math.max(1, (c.w - known) / idx.length); });
    }
    return colW.map((w) => w ?? 40);
  }

  function writeTable(t) {
    const node = t.node;
    const tableRec = node.children.find((c) => c.tag === T.TABLE);
    const td = tableRec.data;
    const oldRows = view(td).getUint16(4, true);
    let rest = td.slice(18 + oldRows * 2);
    if (rest.length >= 4 && view(rest).getUint16(2, true) > 0) { rest = rest.slice(0, 4); view(rest).setUint16(2, 0, true); } // 영역 속성 제거
    const data = new Uint8Array(18 + t.rows * 2 + rest.length);
    data.set(td.subarray(0, 18));
    const dv = view(data);
    dv.setUint16(4, t.rows, true);
    dv.setUint16(6, t.cols, true);
    const cells = [...t.cells].sort((a, b) => a.row - b.row || a.col - b.col);
    for (let r = 0; r < t.rows; r++) dv.setUint16(18 + r * 2, cells.filter((c) => c.row === r).length, true);
    data.set(rest, 18 + t.rows * 2);
    tableRec.data = data;

    const children = [tableRec];
    for (const c of cells) {
      writeParas(c.paras);
      const lh = c.raw;
      const lv = view(lh.data);
      const oldW = lv.getUint32(16, true);
      lv.setUint16(0, c.paras.length, true);
      lv.setUint16(8, c.col, true); lv.setUint16(10, c.row, true);
      lv.setUint16(12, c.colSpan, true); lv.setUint16(14, c.rowSpan, true);
      lv.setUint32(16, toUnit(c.w), true); lv.setUint32(20, toUnit(c.h), true);
      const va = { top: 0, middle: 1, bottom: 2 }[c.valign] ?? 1;
      lv.setUint32(4, ((lv.getUint32(4, true) & ~(3 << 5)) | (va << 5)) >>> 0, true);
      if (c.pad) c.pad.forEach((v, i) => lv.setUint16(24 + i * 2, Math.min(0xFFFF, toUnit(v)), true));
      if (lh.data.length >= 34 && c.borderFillId) lv.setUint16(32, c.borderFillId, true);
      if (lh.data.length >= 38 && lv.getUint32(34, true) === oldW) lv.setUint32(34, toUnit(c.w), true);
      children.push(lh, ...c.paras.map((p) => p.raw));
    }
    node.children = children;

    const colW = colWidths(t);
    const rowH = new Array(t.rows).fill(0);
    for (const c of t.cells) if (c.rowSpan === 1) rowH[c.row] = Math.max(rowH[c.row], c.h || 0);
    const nv = view(node.data);
    if (node.data.length >= 24) {
      nv.setUint32(16, toUnit(colW.reduce((a, b) => a + b, 0)), true);
      nv.setUint32(20, toUnit(rowH.reduce((a, b) => a + b, 0)), true);
    }
    t.dirty = false;
  }

  // 위치가 바뀐 문단의 줄 세그먼트 세로 위치를 앞 문단에 이어 붙임 (뷰어 쪽 나눔 추정용)
  function restack(paras) {
    let y = 0;
    for (const p of paras) {
      const ls = p.raw.children.find((c) => c.tag === T.PARA_LINE_SEG && c.data.length >= 36);
      if (!ls) continue;
      const v = view(ls.data);
      if (p.restack && !(p.raw.data[11] & 0x05)) {
        const base = v.getInt32(4, true);
        for (let o = 0; o + 36 <= ls.data.length; o += 36) v.setInt32(o + 4, v.getInt32(o + 4, true) - base + y, true);
      }
      p.restack = false;
      const lo = ls.data.length - 36;
      y = v.getInt32(lo + 4, true) + v.getInt32(lo + 8, true) + v.getInt32(lo + 20, true);
    }
  }

  // ---------- 직렬화 ----------
  function serialize(nodes) {
    const flat = [];
    (function walk(list) { for (const n of list) { flat.push(n); walk(n.children); } })(nodes);
    let size = 0;
    for (const r of flat) size += 4 + (r.data.length >= 0xFFF ? 4 : 0) + r.data.length;
    const out = new Uint8Array(size);
    const dv = view(out);
    let p = 0;
    for (const r of flat) {
      const len = r.data.length;
      dv.setUint32(p, (r.tag | (r.level << 10) | (Math.min(len, 0xFFF) << 20)) >>> 0, true); p += 4;
      if (len >= 0xFFF) { dv.setUint32(p, len, true); p += 4; }
      out.set(r.data, p); p += len;
    }
    return out;
  }

  function plainText(paras) {
    return paras.map((p) => p.items.map((it) => (it.t === 'text' ? it.text : it.t === 'tab' ? '\t' : '')).join('')).filter((s) => s.trim()).join('\r\n');
  }

  async function save(doc) {
    const C = global.HwpContainer;
    const { cfb, compressed } = doc.source;
    const pack = async (u8) => (compressed ? await C.deflateRaw(u8) : u8);
    const streams = new Map();
    for (const path of cfb.list()) streams.set(path, cfb.read(path));

    for (let i = 0; i < doc.sections.length; i++) {
      const sec = doc.sections[i];
      writeParas(sec.paras);
      for (const f of sec.footnotes) writeParas(f.paras);
      restack(sec.paras);
      streams.set('BodyText/Section' + i, await pack(serialize(sec.paras.map((p) => p.raw))));
    }

    // 캐럿 위치 초기화 (삭제된 문단을 가리키지 않도록)
    const di = doc.source.docInfoRecs;
    if (di[0] && di[0].tag === T.DOCUMENT_PROPERTIES && di[0].data.length >= 26) {
      di[0].data = di[0].data.slice();
      const v = view(di[0].data);
      v.setUint32(14, 0, true); v.setUint32(18, 0, true); v.setUint32(22, 0, true);
    }
    streams.set('DocInfo', await pack(serialize(di)));

    // 미리보기 텍스트 갱신
    const prv = plainText(doc.sections.flatMap((s) => s.paras)).slice(0, 1023) + '\0';
    const pt = new Uint8Array(prv.length * 2);
    for (let i = 0; i < prv.length; i++) view(pt).setUint16(i * 2, prv.charCodeAt(i), true);
    if (streams.has('PrvText')) streams.set('PrvText', pt);

    return new Blob([C.writeCFB(streams, cfb.rootClsid)], { type: 'application/x-hwp' });
  }

  // 기존 글자 모양을 바탕으로 크기/굵게만 바꾼 글자 모양 ID (같은 것이 있으면 재사용, 없으면 DocInfo에 추가)
  function deriveCharShape(doc, cs, mods) {
    const src = doc.source;
    const recs = src.charShapeRecs;
    const base = recs[cs] || recs[0];
    const d = base.data.slice();
    const v = view(d);
    if (mods.size != null) {
      const rel = d[28] || 100;
      v.setInt32(42, Math.round(mods.size * 100 * 100 / rel), true);
    }
    if (mods.bold != null) {
      const p = v.getUint32(46, true);
      v.setUint32(46, (mods.bold ? p | 2 : p & ~2) >>> 0, true);
    }
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    const found = recs.findIndex((r) => same(r.data, d));
    if (found >= 0) return found;
    const rec = { tag: base.tag, level: base.level, data: d, children: [] };
    const di = src.docInfoRecs;
    di.splice(di.indexOf(recs[recs.length - 1]) + 1, 0, rec);
    recs.push(rec);
    const idm = di.find((r) => r.tag === T.ID_MAPPINGS);
    if (idm && idm.data.length >= 40) {
      idm.data = idm.data.slice();
      view(idm.data).setInt32(36, recs.length, true); // 글자 모양 개수
    }
    const m = doc.charShapes[cs] || doc.charShapes[0];
    doc.charShapes.push({ ...m, size: mods.size ?? m.size, bold: mods.bold ?? m.bold });
    return recs.length - 1;
  }

  global.HwpWriter = { save, newParaLike, newCellLike, colWidths, deriveCharShape };
})(window);
