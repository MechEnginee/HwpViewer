/* 문서 편집기: 화면(DOM) <-> 문서 모델 동기화, 문단 나누기/합치기, 표 행·열 편집 */
(function (global) {
  'use strict';

  const EDITABLE = '.hwp-p[contenteditable="true"]';
  const ZWS = /​/g;

  class Editor {
    constructor({ container, onChange, onCellFocus }) {
      this.container = container;
      this.onChange = onChange || (() => {});
      this.onCellFocus = onCellFocus || (() => {});
      this.doc = null;
      this.renderer = null;
      this.enabled = false;
      this.cellCtx = null;
      this.saved = null;
      this.painter = null;
      this._bind();
    }

    attach(doc, renderer) {
      this.doc = doc;
      this.renderer = renderer;
      this.enabled = renderer.editable;
      this.cellCtx = null;
      this.saved = null;
      this.onCellFocus(null);
    }

    adapter() { return this.doc.source.kind === 'hwp' ? global.HwpWriter : global.HwpxWriter; }

    // ---------- DOM -> 모델 ----------
    collect(root, cs0) {
      const items = [];
      const pushText = (s, cs) => {
        s = s.replace(ZWS, '');
        if (!s) return;
        const last = items[items.length - 1];
        if (last && last.t === 'text' && last.cs === cs) last.text += s;
        else items.push({ t: 'text', text: s, cs });
      };
      (function walk(node, cs) {
        for (const ch of node.childNodes) {
          if (ch.nodeType === 3) pushText(ch.nodeValue, cs);
          else if (ch.nodeType === 1) {
            if (ch._skip) continue;
            if (ch._item) { items.push(ch._item); continue; }
            if (ch.tagName === 'BR') continue; // 브라우저가 넣은 자리표시 줄바꿈
            walk(ch, ch.dataset && ch.dataset.cs != null ? +ch.dataset.cs : cs);
          }
        }
      })(root, cs0);
      return items;
    }

    sync(host) {
      if (!host || !host._para) return;
      const para = host._para;
      let items = this.collect(host, para.cs);
      // 구역/단 정의 같은 필수 숨김 항목은 지워지지 않게 복구
      const keep = para.items.filter((it) => it.keep && !items.includes(it));
      if (keep.length) items = keep.concat(items);
      const same = items.length === para.items.length && items.every((a, i) => {
        const b = para.items[i];
        return a === b || (a.t === 'text' && b.t === 'text' && a.text === b.text && a.cs === b.cs);
      });
      if (!same) {
        para.items = items;
        para.dirty = true;
        this.onChange();
      }
    }

    // ---------- 커서 유틸 ----------
    hostOf(node) {
      const e = node && (node.nodeType === 1 ? node : node.parentElement);
      return e ? e.closest(EDITABLE) : null;
    }

    range() {
      const sel = getSelection();
      return sel.rangeCount ? sel.getRangeAt(0) : null;
    }

    isEmptyFrag(frag) {
      frag.querySelectorAll('.hwp-bullet, .hwp-hidden').forEach((e) => e.remove());
      if (frag.textContent.replace(ZWS, '').length) return false;
      return !frag.querySelector('img, table, br, .hwp-tab, .hwp-eq, sup, .hwp-box, .hwp-obj, .hwp-img-missing');
    }

    atStart(host, r) {
      const pre = document.createRange();
      pre.setStart(host, 0);
      pre.setEnd(r.startContainer, r.startOffset);
      return this.isEmptyFrag(pre.cloneContents());
    }

    atEnd(host, r) {
      const post = document.createRange();
      post.setStart(r.endContainer, r.endOffset);
      post.setEnd(host, host.childNodes.length);
      return this.isEmptyFrag(post.cloneContents());
    }

    placeCaret(el, atEnd) {
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(!atEnd);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }

    textLength(para) {
      return para.items.reduce((n, it) => n + (it.t === 'text' ? it.text.length : 0), 0);
    }

    placeCaretAtText(el, n) {
      el.focus();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (t) => {
          for (let p = t.parentNode; p && p !== el; p = p.parentNode) if (p._item || p._skip) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let t, left = n;
      while ((t = walker.nextNode())) {
        const len = t.nodeValue.replace(ZWS, '').length;
        if (left <= len) {
          const r = document.createRange();
          r.setStart(t, Math.min(left, t.nodeValue.length));
          r.collapse(true);
          const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
          return;
        }
        left -= len;
      }
      this.placeCaret(el, true);
    }

    elOf(para) {
      return Array.from(this.container.querySelectorAll('.hwp-p')).find((e) => e._para === para) || null;
    }

    containerChanged(owner) {
      if (owner && owner.kind === 'cell') owner.table.dirty = true;
      this.onChange();
    }

    rerender(host) {
      const n = this.renderer.paraEl(host._para, host._list, host._owner);
      host.replaceWith(n);
      return n;
    }

    // ---------- 문단 나누기 / 합치기 ----------
    split(host) {
      const r = this.range();
      if (!r) return null;
      if (!r.collapsed) r.deleteContents();
      const owner = host._owner;
      if (owner.kind === 'box' || owner.kind === 'foot') { this.lineBreak(host); return host; }
      const para = host._para, list = host._list;
      const after = document.createRange();
      after.setStart(r.startContainer, r.startOffset);
      after.setEnd(host, host.childNodes.length);
      const frag = after.extractContents();
      const tail = this.collect(frag, para.cs).filter((it) => !it.keep); // 필수 숨김 항목은 앞 문단에 남김
      this.sync(host);
      const head = para.items;
      const np = this.adapter().newParaLike(para);
      const lastHeadText = [...head].reverse().find((it) => it.t === 'text');
      np.cs = tail.length && tail[0].cs != null ? tail[0].cs : lastHeadText ? lastHeadText.cs : para.cs;
      np.items = tail;
      para.dirty = true;
      list.splice(list.indexOf(para) + 1, 0, np);
      this.containerChanged(owner);
      const a = this.rerender(host);
      const b = this.renderer.paraEl(np, list, owner);
      a.after(b);
      this.placeCaret(b, false);
      return b;
    }

    merge(host, backward) {
      const owner = host._owner;
      if (owner.kind === 'box' || owner.kind === 'foot') return;
      const list = host._list;
      const idx = list.indexOf(host._para);
      const first = backward ? list[idx - 1] : host._para;
      const second = backward ? host._para : list[idx + 1];
      if (!first || !second || second.items.some((it) => it.keep)) return;
      const firstEl = backward ? this.elOf(first) : host;
      const secondEl = backward ? host : this.elOf(second);
      if (!firstEl || !secondEl) return;
      this.sync(firstEl); this.sync(secondEl);
      const caret = this.textLength(first);
      first.items = first.items.concat(second.items);
      first.dirty = true;
      list.splice(list.indexOf(second), 1);
      this.containerChanged(owner);
      secondEl.remove();
      const n = this.rerender(firstEl);
      this.placeCaretAtText(n, caret);
    }

    lineBreak(host) {
      const r = this.range();
      if (!r) return;
      r.deleteContents();
      const span = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
      const csEl = span.closest('[data-cs]');
      const br = document.createElement('br');
      br._item = { t: 'br', codes: [10], cs: csEl && host.contains(csEl) ? +csEl.dataset.cs : host._para.cs };
      r.insertNode(br);
      const z = document.createTextNode('​');
      br.after(z);
      const nr = document.createRange();
      nr.setStart(z, 1); nr.collapse(true);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(nr);
      this.sync(host);
    }

    // ---------- 표 편집 ----------
    cellAtSelection() {
      const r = this.range();
      if (!r) return null;
      const e = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
      const td = e && e.closest('td');
      return td && td._cell && this.container.contains(td) ? td : null;
    }

    tableOp(op) {
      const td = this.cellAtSelection() || (this.cellCtx && this.cellCtx.td);
      if (!td || !td.isConnected) return;
      const t = td._table, cell = td._cell;
      const host = td.closest('table').parentElement.closest('.hwp-p');
      td.querySelectorAll(EDITABLE).forEach((h) => this.sync(h));
      let focusCell = cell;
      const A = this.adapter();
      const colW = global.HwpWriter.colWidths(t);
      const setWidths = (widths) => {
        for (const c of t.cells) c.w = widths.slice(c.col, c.col + c.colSpan).reduce((a, b) => a + b, 0);
      };

      if (op === 'rowAbove' || op === 'rowBelow') {
        const p = op === 'rowAbove' ? cell.row : cell.row + cell.rowSpan;
        const ref = op === 'rowAbove' ? cell.row : p - 1;
        const tmpl = t.cells.filter((c) => c.row <= ref && ref < c.row + c.rowSpan);
        const covered = new Set();
        for (const c of t.cells) {
          if (c.row >= p) c.row++;
          else if (c.row + c.rowSpan > p) { c.rowSpan++; for (let i = c.col; i < c.col + c.colSpan; i++) covered.add(i); }
        }
        let first = null;
        for (const tc of tmpl.sort((a, b) => a.col - b.col)) {
          if (covered.has(tc.col)) continue;
          const nc = A.newCellLike(tc);
          Object.assign(nc, { row: p, col: tc.col, rowSpan: 1, colSpan: tc.colSpan, h: tc.rowSpan > 1 ? tc.h / tc.rowSpan : tc.h });
          t.cells.push(nc);
          if (!first || tc === cell) first = nc;
        }
        t.rows++;
        focusCell = first || cell;
      } else if (op === 'rowDelete') {
        if (t.rows <= 1) return this.tableOp('tableDelete');
        const r = cell.row;
        t.cells = t.cells.filter((c) => {
          if (c.row === r) { if (c.rowSpan > 1) { c.rowSpan--; return true; } return false; }
          if (c.row < r && c.row + c.rowSpan > r) c.rowSpan--;
          else if (c.row > r) c.row--;
          return true;
        });
        t.rows--;
        focusCell = t.cells.find((c) => c.row === Math.min(r, t.rows - 1)) || t.cells[0];
      } else if (op === 'colLeft' || op === 'colRight') {
        const p = op === 'colLeft' ? cell.col : cell.col + cell.colSpan;
        const ref = op === 'colLeft' ? cell.col : p - 1;
        const tmpl = t.cells.filter((c) => c.col <= ref && ref < c.col + c.colSpan);
        const covered = new Set();
        for (const c of t.cells) {
          if (c.col >= p) c.col++;
          else if (c.col + c.colSpan > p) { c.colSpan++; for (let i = c.row; i < c.row + c.rowSpan; i++) covered.add(i); }
        }
        let first = null;
        for (const tc of tmpl.sort((a, b) => a.row - b.row)) {
          if (covered.has(tc.row)) continue;
          const nc = A.newCellLike(tc);
          Object.assign(nc, { row: tc.row, col: p, rowSpan: tc.rowSpan, colSpan: 1 });
          t.cells.push(nc);
          if (!first || tc === cell) first = nc;
        }
        const total = colW.reduce((a, b) => a + b, 0);
        const widths = colW.slice();
        widths.splice(p, 0, colW[ref]);
        const k = total / widths.reduce((a, b) => a + b, 0);
        t.cols++;
        setWidths(widths.map((w) => w * k));
        focusCell = first || cell;
      } else if (op === 'colDelete') {
        if (t.cols <= 1) return this.tableOp('tableDelete');
        const col = cell.col;
        t.cells = t.cells.filter((c) => {
          if (c.col === col) { if (c.colSpan > 1) { c.colSpan--; return true; } return false; }
          if (c.col < col && c.col + c.colSpan > col) c.colSpan--;
          else if (c.col > col) c.col--;
          return true;
        });
        const total = colW.reduce((a, b) => a + b, 0);
        const widths = colW.slice();
        widths.splice(col, 1);
        const k = total / widths.reduce((a, b) => a + b, 0);
        t.cols--;
        setWidths(widths.map((w) => w * k));
        focusCell = t.cells.find((c) => c.row === cell.row && c.col === Math.min(col, t.cols - 1)) || t.cells[0];
      } else if (op === 'tableDelete') {
        if (!host) return;
        this.sync(host);
        host._para.items = host._para.items.filter((it) => it !== t);
        host._para.dirty = true;
        this.containerChanged(host._owner);
        const n = this.rerender(host);
        this.placeCaret(n, true);
        this.cellCtx = null;
        this.onCellFocus(null);
        return;
      }
      t.dirty = true;
      this.onChange();
      if (!host) return;
      const n = this.rerender(host);
      const ntd = Array.from(n.querySelectorAll('td')).find((x) => x._cell === focusCell);
      const target = ntd && ntd.querySelector(EDITABLE);
      if (target) this.placeCaret(target, false);
    }

    // ---------- 선택 영역 <-> 글자 위치 ----------
    textNodes(host) {
      const out = [];
      const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
        acceptNode: (t) => {
          for (let p = t.parentNode; p && p !== host; p = p.parentNode) if (p._item || p._skip) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let t;
      while ((t = w.nextNode())) out.push(t);
      return out;
    }

    textOffset(host, node, offset) {
      const pt = document.createRange();
      pt.setStart(node, offset);
      let n = 0;
      for (const t of this.textNodes(host)) {
        if (t === node) return n + t.nodeValue.slice(0, offset).replace(ZWS, '').length;
        if (pt.comparePoint(t, t.nodeValue.length) < 0) n += t.nodeValue.replace(ZWS, '').length;
        else break;
      }
      return n;
    }

    // \uAE00\uC790 \uC704\uCE58 n \uC758 DOM \uC9C0\uC810. preferNext: \uB450 \uAE00\uC790 \uB369\uC5B4\uB9AC \uACBD\uACC4\uBA74 \uB4A4 \uB369\uC5B4\uB9AC\uC758 \uC2DC\uC791\uC744 \uC120\uD0DD
    pointAt(host, n, preferNext) {
      let left = n, last = null;
      for (const t of this.textNodes(host)) {
        const v = t.nodeValue;
        let i = 0, cnt = 0;
        for (; i < v.length && cnt < left; i++) if (v[i] !== '\u200B') cnt++;
        if (cnt === left && !(preferNext && i === v.length && left > 0)) return [t, i];
        left -= cnt; last = t;
      }
      return last ? [last, last.nodeValue.length] : [host, host.childNodes.length];
    }

    selectText(host, start, end) {
      host.focus();
      const r = document.createRange();
      r.setStart(...this.pointAt(host, start, start !== end));
      r.setEnd(...this.pointAt(host, end));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }

    // 현재 선택을 { host, start, end } (글자 위치)로 기억 — 도구 모음을 눌러 초점이 옮겨가도 적용할 수 있도록
    rememberSelection() {
      const r = this.range();
      if (!r) return;
      const host = this.hostOf(r.startContainer);
      if (!host || host !== this.hostOf(r.endContainer)) return;
      this.saved = { host, start: this.textOffset(host, r.startContainer, r.startOffset), end: this.textOffset(host, r.endContainer, r.endOffset) };
    }

    currentCs() {
      const sv = this.saved;
      if (!sv || !sv.host.isConnected) return null;
      const r = this.range();
      let e = r && sv.host.contains(r.startContainer) ? r.startContainer : null;
      e = e && (e.nodeType === 1 ? e : e.parentElement);
      const c = e && e.closest('[data-cs]');
      if (c && sv.host.contains(c)) return +c.dataset.cs;
      const first = sv.host._para.items.find((it) => it.t === 'text');
      return first ? first.cs : sv.host._para.cs;
    }

    // 선택한 글자(선택이 없으면 문단 전체)의 글자 모양을 바꿈. fn: 기존 cs -> 새 cs
    applyChar(fn) {
      const sv = this.saved;
      if (!sv || !sv.host.isConnected) return false;
      const host = sv.host;
      this.sync(host);
      const para = host._para;
      let { start, end } = sv;
      if (start > end) [start, end] = [end, start];
      const total = this.textLength(para);
      if (start === end) { start = 0; end = total; }
      const out = [];
      let pos = 0;
      const push = (text, cs) => {
        if (!text) return;
        const last = out[out.length - 1];
        if (last && last.t === 'text' && last.cs === cs) last.text += text;
        else out.push({ t: 'text', text, cs });
      };
      for (const it of para.items) {
        if (it.t !== 'text') { out.push(it); continue; }
        const a = pos, b = pos + it.text.length;
        const s1 = Math.min(Math.max(start, a), b) - a, e1 = Math.min(Math.max(end, a), b) - a;
        push(it.text.slice(0, s1), it.cs);
        if (e1 > s1) push(it.text.slice(s1, e1), fn(it.cs));
        push(it.text.slice(e1), it.cs);
        pos = b;
      }
      if (!total) para.cs = fn(para.cs); // 빈 문단: 이후 입력할 글자 모양
      para.items = out;
      para.dirty = true;
      this.onChange();
      const n = this.rerender(host);
      this.saved = { host: n, start, end };
      this.selectText(n, start, end);
      return true;
    }

    setCharFormat(mods) {
      const A = this.adapter();
      return this.applyChar((cs) => A.deriveCharShape(this.doc, cs, mods));
    }

    // ---------- 서식 복사 ----------
    startTextPainter() {
      const cs = this.currentCs();
      if (cs == null) return false;
      this.painter = { type: 'text', cs };
      this.container.classList.add('painting');
      return true;
    }

    startCellPainter() {
      const td = this.cellAtSelection() || (this.cellCtx && this.cellCtx.td);
      if (!td) return false;
      const c = td._cell;
      this.painter = {
        type: 'cell',
        from: c,
        style: { borderFillId: c.borderFillId, pad: c.pad && c.pad.slice(), valign: c.valign, shape: c.paras[0] && c.paras[0].shape },
      };
      this.container.classList.add('painting');
      return true;
    }

    stopPainter() {
      this.painter = null;
      this.container.classList.remove('painting');
      if (this.onPainter) this.onPainter(null);
    }

    applyCellStyle(td, st) {
      const c = td._cell, t = td._table;
      td.querySelectorAll(EDITABLE).forEach((h) => this.sync(h));
      Object.assign(c, { borderFillId: st.borderFillId, pad: st.pad && st.pad.slice(), valign: st.valign });
      if (st.shape != null) c.paras.forEach((p) => { p.shape = st.shape; p.dirty = true; });
      t.dirty = true;
      this.onChange();
      const host = td.closest('table').parentElement.closest('.hwp-p');
      if (host) {
        const n = this.rerender(host);
        const ntd = Array.from(n.querySelectorAll('td')).find((x) => x._cell === c);
        const target = ntd && ntd.querySelector(EDITABLE);
        if (target) this.placeCaret(target, true);
      }
    }

    // ---------- 표 선 끌어서 크기 조절 ----------
    borderAt(e) {
      const td = e.target.closest && e.target.closest('td');
      if (!td || !td._cell || !this.container.contains(td)) return null;
      const r = td.getBoundingClientRect();
      const tol = 4, c = td._cell;
      if (Math.abs(e.clientX - r.right) <= tol) return { td, kind: 'col', index: c.col + c.colSpan };
      if (Math.abs(e.clientX - r.left) <= tol && c.col > 0) return { td, kind: 'col', index: c.col };
      if (Math.abs(e.clientY - r.bottom) <= tol) return { td, kind: 'row', index: c.row + c.rowSpan };
      if (Math.abs(e.clientY - r.top) <= tol && c.row > 0) return { td, kind: 'row', index: c.row };
      return null;
    }

    startResize(hit, e) {
      const tableEl = hit.td.closest('table');
      const t = hit.td._table;
      const scale = tableEl.getBoundingClientRect().width / tableEl.offsetWidth || 1;
      const colW = global.HwpWriter.colWidths(t);
      const cols = Array.from(tableEl.querySelectorAll(':scope > colgroup > col'));
      const rowEls = Array.from(tableEl.querySelectorAll(':scope > tbody > tr'));
      const MIN = 8;
      const st = { x: e.clientX, y: e.clientY, rowH0: 20 };
      if (hit.kind === 'row') {
        const tr = rowEls[hit.index - 1];
        if (tr) st.rowH0 = tr.getBoundingClientRect().height / scale;
      }
      const apply = (d) => {
        if (hit.kind === 'col') {
          const w = colW.slice(), b = hit.index;
          if (b >= w.length) w[w.length - 1] = Math.max(MIN, w[w.length - 1] + d);
          else {
            const dd = Math.max(MIN - w[b - 1], Math.min(w[b] - MIN, d));
            w[b - 1] += dd; w[b] -= dd;
          }
          cols.forEach((c, i) => { c.style.width = w[i] + 'px'; });
          tableEl.style.width = w.reduce((a, x) => a + x, 0) + 'px';
          st.w = w;
        } else {
          const h = Math.max(MIN, st.rowH0 + d);
          const tr = rowEls[hit.index - 1];
          if (tr) Array.from(tr.children).forEach((td) => { if (td._cell.rowSpan === 1) td.style.height = h + 'px'; });
          st.h = h;
        }
      };
      const move = (ev) => { ev.preventDefault(); apply((hit.kind === 'col' ? ev.clientX - st.x : ev.clientY - st.y) / scale); };
      const up = () => {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        this.container.classList.remove('resizing-col', 'resizing-row');
        if (hit.kind === 'col' && st.w) {
          for (const c of t.cells) c.w = st.w.slice(c.col, c.col + c.colSpan).reduce((a, b) => a + b, 0);
        } else if (hit.kind === 'row' && st.h) {
          const r = hit.index - 1;
          const delta = st.h - st.rowH0;
          for (const c of t.cells) {
            if (c.row === r && c.rowSpan === 1) c.h = st.h;
            else if (c.row <= r && c.row + c.rowSpan - 1 === r) c.h = Math.max(MIN, (c.h || 0) + delta);
          }
        } else return;
        t.dirty = true;
        this.onChange();
        const host = tableEl.parentElement.closest('.hwp-p');
        if (host) this.rerender(host);
      };
      this.container.classList.add(hit.kind === 'col' ? 'resizing-col' : 'resizing-row');
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
    }

    // ---------- 이벤트 ----------
    _bind() {
      const c = this.container;
      c.addEventListener('input', (e) => { if (this.enabled) this.sync(this.hostOf(e.target)); });
      c.addEventListener('beforeinput', (e) => {
        if (this.enabled && e.inputType && e.inputType.startsWith('format')) e.preventDefault(); // 서식 단축키는 지원하지 않음
      });
      c.addEventListener('paste', (e) => {
        if (!this.enabled) return;
        const host = this.hostOf(e.target);
        if (!host) return;
        e.preventDefault();
        const lines = (e.clipboardData.getData('text/plain') || '').replace(/\r/g, '').split('\n');
        let h = host;
        lines.forEach((line, i) => {
          if (i > 0) h = this.split(h) || h;
          if (line) document.execCommand('insertText', false, line.replace(/\t/g, ' '));
        });
        this.sync(this.hostOf(this.range() && this.range().startContainer) || h);
      });
      c.addEventListener('keydown', (e) => this._keydown(e));
      // 표 선 위: 크기 조절 커서 / 끌기
      c.addEventListener('mousemove', (e) => {
        if (!this.enabled || e.buttons) return;
        const hit = this.borderAt(e);
        c.classList.toggle('hover-col', !!hit && hit.kind === 'col');
        c.classList.toggle('hover-row', !!hit && hit.kind === 'row');
      });
      c.addEventListener('mousedown', (e) => {
        if (!this.enabled || e.button !== 0) return;
        const hit = this.borderAt(e);
        if (!hit) return;
        e.preventDefault();
        this.startResize(hit, e);
      }, true);
      // 서식 복사 적용
      c.addEventListener('mouseup', () => {
        if (!this.enabled || !this.painter) return;
        setTimeout(() => {
          const p = this.painter;
          if (!p) return;
          if (p.type === 'cell') {
            const td = this.cellAtSelection();
            if (td && td._cell !== p.from) { this.applyCellStyle(td, p.style); this.stopPainter(); }
            return;
          }
          const r = this.range();
          if (!r || r.collapsed) return;
          this.rememberSelection();
          if (this.applyChar(() => p.cs)) this.stopPainter();
        }, 0);
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.painter) this.stopPainter(); });
      c.addEventListener('drop', (e) => { if (this.enabled) e.preventDefault(); });
      document.addEventListener('selectionchange', () => {
        if (!this.enabled) return;
        const td = this.cellAtSelection();
        if (td) this.cellCtx = { td };
        this.onCellFocus(td ? td._table : null);
        this.rememberSelection();
        if (this.onSelection) this.onSelection();
      });
    }

    _keydown(e) {
      if (!this.enabled || e.isComposing || e.keyCode === 229) return;
      const host = this.hostOf(e.target);
      if (!host) return;
      const r = this.range();
      if (!r) return;
      if ((e.ctrlKey || e.metaKey) && /^[biu]$/i.test(e.key)) { e.preventDefault(); return; }

      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) this.lineBreak(host); else this.split(host);
        return;
      }
      if (e.key === 'Backspace' && r.collapsed && this.atStart(host, r)) {
        e.preventDefault();
        this.merge(host, true);
        return;
      }
      if (e.key === 'Delete' && r.collapsed && this.atEnd(host, r)) {
        e.preventDefault();
        this.merge(host, false);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const td = host.closest('td');
        if (!td) return;
        const tds = Array.from(td.closest('table').querySelectorAll(':scope > tbody > tr > td'));
        const next = tds[tds.indexOf(td) + (e.shiftKey ? -1 : 1)];
        const target = next && next.querySelector(EDITABLE);
        if (target) this.placeCaret(target, false);
        return;
      }
      // 문단 경계에서 방향키로 이웃 문단으로 이동 (문단마다 편집 영역이 따로라서 필요)
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !e.shiftKey && r.collapsed) {
        const before = [r.startContainer, r.startOffset];
        requestAnimationFrame(() => {
          const r2 = this.range();
          if (!r2 || r2.startContainer !== before[0] || r2.startOffset !== before[1]) return;
          const all = Array.from(this.container.querySelectorAll(EDITABLE));
          const fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight';
          const next = all[all.indexOf(host) + (fwd ? 1 : -1)];
          if (next) this.placeCaret(next, !fwd);
        });
      }
    }
  }

  global.HwpEditor = Editor;
})(window);
