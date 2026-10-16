/* HWPX 저장: 편집된 문단/표의 XML만 다시 만들고 ZIP 항목은 바뀐 섹션만 새로 압축 */
(function (global) {
  'use strict';

  const PX_HWPUNIT = 7200 / 96;
  const toUnit = (px) => String(Math.max(0, Math.round(px * PX_HWPUNIT)));
  const kid = (el, name) => Array.from(el.children).find((c) => c.localName === name) || null;
  const mk = (ref, name) => ref.ownerDocument.createElementNS(ref.namespaceURI, (ref.prefix ? ref.prefix + ':' : '') + name);

  // ---------- 새 문단/셀 (편집기에서 사용) ----------
  function newParaLike(para) {
    const raw = para.raw.cloneNode(false);
    raw.setAttribute('pageBreak', '0');
    raw.setAttribute('columnBreak', '0');
    return { shape: para.shape, items: [], cs: para.cs, raw, dirty: true };
  }

  function newCellLike(cell) {
    return { ...cell, raw: cell.raw.cloneNode(true), paras: [newParaLike(cell.paras[0])] };
  }

  // ---------- 문단 ----------
  function writePara(p) {
    const el = p.raw;
    el.setAttribute('paraPrIDRef', String(p.shape));
    while (el.firstChild) el.removeChild(el.firstChild);
    let run = null, t = null, runCs = null;
    const newRun = (cs) => {
      run = mk(el, 'run');
      run.setAttribute('charPrIDRef', String(cs ?? p.cs ?? 0));
      el.appendChild(run);
      runCs = cs; t = null;
    };
    const textTarget = (cs) => {
      if (!run || runCs !== cs) newRun(cs);
      if (!t) { t = mk(el, 't'); run.appendChild(t); }
      return t;
    };
    for (const it of p.items) {
      if (it.t === 'text') textTarget(it.cs).appendChild(el.ownerDocument.createTextNode(it.text));
      else if (it.t === 'tab' || it.t === 'br') textTarget(it.cs).appendChild(it.xml || mk(el, it.t === 'tab' ? 'tab' : 'lineBreak'));
      else if (it.el) {
        if (it.t === 'table' && it.dirty) writeTable(it);
        newRun(it.runCs ?? it.cs);
        run.appendChild(it.el);
        t = null; runCs = null; run = null;
      }
    }
    if (!el.firstChild) newRun(p.cs);
    p.dirty = false;
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
  }

  // ---------- 표 ----------
  function writeTable(t) {
    const el = t.el;
    const trs = Array.from(el.children).filter((c) => c.localName === 'tr');
    const anchor = trs.length ? trs[trs.length - 1].nextSibling : null;
    trs.forEach((tr) => el.removeChild(tr));
    const zones = kid(el, 'cellzoneList');
    if (zones) el.removeChild(zones);
    el.setAttribute('rowCnt', String(t.rows));
    el.setAttribute('colCnt', String(t.cols));

    const cells = [...t.cells].sort((a, b) => a.row - b.row || a.col - b.col);
    for (let r = 0; r < t.rows; r++) {
      const tr = mk(el, 'tr');
      for (const c of cells.filter((x) => x.row === r)) {
        writeParas(c.paras);
        const tc = c.raw;
        const addr = kid(tc, 'cellAddr'), span = kid(tc, 'cellSpan'), sz = kid(tc, 'cellSz');
        if (addr) { addr.setAttribute('colAddr', String(c.col)); addr.setAttribute('rowAddr', String(c.row)); }
        if (span) { span.setAttribute('colSpan', String(c.colSpan)); span.setAttribute('rowSpan', String(c.rowSpan)); }
        if (sz) { sz.setAttribute('width', toUnit(c.w)); sz.setAttribute('height', toUnit(c.h)); }
        if (c.borderFillId) tc.setAttribute('borderFillIDRef', String(c.borderFillId));
        const mg = kid(tc, 'cellMargin');
        if (mg && c.pad) ['left', 'right', 'top', 'bottom'].forEach((s, i) => mg.setAttribute(s, toUnit(c.pad[i])));
        const sl = kid(tc, 'subList');
        if (sl) sl.setAttribute('vertAlign', { top: 'TOP', middle: 'CENTER', bottom: 'BOTTOM' }[c.valign] || 'CENTER');
        if (sl) {
          Array.from(sl.children).filter((x) => x.localName === 'p').forEach((x) => sl.removeChild(x));
          c.paras.forEach((p) => sl.appendChild(p.raw));
        }
        tr.appendChild(tc);
      }
      el.insertBefore(tr, anchor);
    }
    const colW = global.HwpWriter.colWidths(t);
    const rowH = new Array(t.rows).fill(0);
    for (const c of t.cells) if (c.rowSpan === 1) rowH[c.row] = Math.max(rowH[c.row], c.h || 0);
    const sz = kid(el, 'sz');
    if (sz) {
      sz.setAttribute('width', toUnit(colW.reduce((a, b) => a + b, 0)));
      sz.setAttribute('height', toUnit(rowH.reduce((a, b) => a + b, 0)));
    }
    t.dirty = false;
  }

  async function save(doc) {
    const C = global.HwpContainer;
    const zip = doc.source.zip;
    const changed = new Map();
    for (const sec of doc.sections) {
      writeParas(sec.paras);
      for (const f of sec.footnotes) writeParas(f.paras);
      const root = sec.xml.documentElement;
      Array.from(root.children).filter((c) => c.localName === 'p').forEach((p) => root.removeChild(p));
      sec.paras.forEach((p) => root.appendChild(p.raw));
      const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' + new XMLSerializer().serializeToString(root);
      changed.set(sec.file, new TextEncoder().encode(xml));
    }
    if (doc.source.headerDirty) {
      const h = doc.source.headerXml.documentElement;
      changed.set('Contents/header.xml', new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' + new XMLSerializer().serializeToString(h)));
    }
    const entries = zip.list().map((name) => (changed.has(name) ? { name, data: changed.get(name) } : { name, raw: zip.raw(name) }));
    return C.writeZIP(entries);
  }

  // 기존 글자 모양(charPr)을 바탕으로 크기/굵게만 바꾼 글자 모양 ID (같은 것이 있으면 재사용, 없으면 header.xml에 추가)
  function deriveCharShape(doc, cs, mods) {
    const src = doc.source;
    const els = src.charPrEls;
    const base = els[cs] || els[0];
    const c = base.cloneNode(true);
    if (mods.size != null) {
      const rel = kid(c, 'relSz');
      const r = rel ? Number(rel.getAttribute('hangul')) || 100 : 100;
      c.setAttribute('height', String(Math.round(mods.size * 100 * 100 / r)));
    }
    if (mods.bold != null) {
      const b = kid(c, 'bold');
      if (mods.bold && !b) {
        const nb = mk(c, 'bold');
        const before = kid(c, 'underline') || kid(c, 'strikeout') || kid(c, 'outline') || null;
        c.insertBefore(nb, before);
      } else if (!mods.bold && b) c.removeChild(b);
    }
    const ser = new XMLSerializer();
    const key = (e) => { const x = e.cloneNode(true); x.removeAttribute('id'); return ser.serializeToString(x); };
    const k = key(c);
    for (const [id, e] of Object.entries(els)) if (key(e) === k) return Number(id);
    const newId = Math.max(...Object.keys(els).map(Number)) + 1;
    c.setAttribute('id', String(newId));
    const parent = base.parentNode;
    parent.appendChild(c);
    if (parent.hasAttribute('itemCnt')) parent.setAttribute('itemCnt', String(Array.from(parent.children).filter((x) => x.localName === 'charPr').length));
    els[newId] = c;
    src.headerDirty = true;
    const m = doc.charShapes[cs] || doc.charShapes[0];
    doc.charShapes[newId] = { ...m, size: mods.size ?? m.size, bold: mods.bold ?? m.bold };
    return newId;
  }

  global.HwpxWriter = { save, newParaLike, newCellLike, deriveCharShape };
})(window);
