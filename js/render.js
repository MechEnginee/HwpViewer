/* 공통 문서 모델 -> HTML 렌더러 */
(function (global) {
  'use strict';

  const BORDER_CSS = ['none', 'solid', 'dashed', 'dotted', 'dashed', 'dotted', 'dashed', 'dotted',
    'double', 'double', 'double', 'double', 'solid', 'double', 'solid', 'solid', 'solid', 'solid'];
  const DEFAULT_PAGE = { width: 793.7, height: 1122.5, left: 113.4, right: 113.4, top: 132.3, bottom: 113.4 };

  function el(tag, cls, style) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (style) Object.assign(e.style, style);
    return e;
  }

  function fontFamily(cs) {
    const names = [];
    if (cs.fontLatin) names.push(cs.fontLatin);
    if (cs.fontHangul && cs.fontHangul !== cs.fontLatin) names.push(cs.fontHangul);
    const all = names.join(' ');
    const serif = /바탕|명조|궁서|batang|myeongjo|gungsuh|times|serif/i.test(all);
    const fallback = serif
      ? ['함초롬바탕', 'Batang', '바탕', 'Noto Serif KR', 'serif']
      : ['함초롬돋움', 'Malgun Gothic', '맑은 고딕', 'Noto Sans KR', 'sans-serif'];
    return names.concat(fallback).map((n) => (/^(serif|sans-serif)$/.test(n) ? n : '"' + n.replace(/"/g, '') + '"')).join(', ');
  }

  function borderCss(b) {
    if (!b || !b.type) return 'none';
    const px = Math.max(1, Math.round(b.width * 96 / 25.4 * 10) / 10);
    const style = BORDER_CSS[b.type] || 'solid';
    return (style === 'double' ? Math.max(3, px) : px) + 'px ' + style + ' ' + (b.color || '#000');
  }

  class Renderer {
    constructor(doc, opts = {}) {
      this.doc = doc;
      this.csCache = new Map();
      this.editable = !!opts.editable;
    }

    charStyle(id) {
      if (this.csCache.has(id)) return this.csCache.get(id);
      const cs = this.doc.charShapes[id] || this.doc.charShapes[0] || { size: 10, color: '#000' };
      const st = {
        fontFamily: fontFamily(cs),
        fontSize: (cs.size || 10) + 'pt',
        color: cs.color || '#000',
      };
      if (cs.bold) st.fontWeight = 'bold';
      if (cs.italic) st.fontStyle = 'italic';
      const deco = [cs.underline, cs.strike && 'line-through'].filter(Boolean);
      if (deco.length) st.textDecoration = deco.join(' ');
      if (cs.shade && cs.shade.toLowerCase() !== '#ffffff') st.backgroundColor = cs.shade;
      if (cs.spacing) st.letterSpacing = (cs.spacing / 100) + 'em';
      if (cs.sup || cs.sub) { st.verticalAlign = cs.sup ? 'super' : 'sub'; st.fontSize = (cs.size * 0.7) + 'pt'; }
      this.csCache.set(id, st);
      return st;
    }

    // list: 문단이 속한 배열, owner: { kind: 'section' | 'cell' | 'box' | 'foot', table, cell }
    paraEl(para, list, owner) {
      const ps = this.doc.paraShapes[para.shape] || {};
      const st = {
        textAlign: ps.align || 'justify',
        paddingLeft: ((ps.left || 0) + (ps.indent < 0 ? -ps.indent : 0)) + 'px',
        paddingRight: (ps.right || 0) + 'px',
        textIndent: (ps.indent || 0) + 'px',
        paddingTop: (ps.before || 0) + 'px',
        paddingBottom: (ps.after || 0) + 'px',
      };
      if (ps.lineHeight) {
        st.lineHeight = ps.lineHeight.px ? ps.lineHeight.px + 'px' : Math.max(0.8, ps.lineHeight.percent / 100) * 1.0 + '';
      }
      const bf = ps.borderFillId && this.doc.borderFills[ps.borderFillId];
      if (bf && bf.bg && bf.bg.toLowerCase() !== '#ffffff') st.backgroundColor = bf.bg;
      if (bf) {
        for (const side of ['left', 'right', 'top', 'bottom']) {
          const b = bf.borders[side];
          if (b && b.type) st['border' + side[0].toUpperCase() + side.slice(1)] = borderCss(b);
        }
      }
      const p = el('div', 'hwp-p', st);
      p._para = para; p._list = list; p._owner = owner || { kind: 'section' };
      if (this.editable) { p.contentEditable = 'true'; p.spellcheck = false; }
      const base = this.charStyle(para.cs);
      p.style.fontSize = base.fontSize;
      p.style.fontFamily = base.fontFamily;

      if (ps.bullet) {
        const b = el('span', 'hwp-bullet', this.charStyle(para.cs));
        b.textContent = '• ';
        b._skip = true;
        b.contentEditable = 'false';
        p.appendChild(b);
      }

      let hasContent = false;
      for (const it of para.items) {
        let node = this.itemEl(it);
        if (!node) continue;
        // 글자처럼 취급하지 않는 개체는 별도 블록으로 배치
        if (it.layout && !it.layout.inline) {
          const wrap = el('div', 'hwp-obj', { textAlign: it.layout.halign });
          if (it.layout.halign === 'left' && it.layout.xOff > 0) wrap.style.paddingLeft = it.layout.xOff + 'px';
          wrap.appendChild(node);
          node = wrap;
        }
        if (it.t === 'text') node.dataset.cs = it.cs;
        else {
          node._item = it;
          if (this.editable && it.t !== 'br') node.contentEditable = 'false';
        }
        p.appendChild(node);
        if (it.t !== 'hidden') hasContent = true;
      }
      if (!hasContent || (para.items.length && para.items[para.items.length - 1].t === 'br')) {
        p.appendChild(document.createTextNode('​'));
      }
      return p;
    }

    itemEl(it) {
      switch (it.t) {
        case 'text': {
          const s = el('span', null, this.charStyle(it.cs));
          s.textContent = it.text;
          return s;
        }
        case 'tab': {
          const s = el('span', 'hwp-tab');
          s.textContent = '\t';
          return s;
        }
        case 'br':
          return el('br');
        case 'hidden':
          return el('span', 'hwp-hidden');
        case 'images': {
          const s = el('span', 'hwp-images');
          it.list.forEach((im) => s.appendChild(this.imageEl(im)));
          return s;
        }
        case 'footref': {
          const s = el('sup', 'hwp-footref');
          s.textContent = it.num + ')';
          return s;
        }
        case 'equation': {
          const s = el('span', 'hwp-eq');
          s.textContent = it.text;
          s.title = '수식 (스크립트 표시)';
          return s;
        }
        case 'image':
          return this.imageEl(it);
        case 'table':
          return this.tableEl(it);
        case 'box': {
          const d = el('div', 'hwp-box', { width: it.w ? it.w + 'px' : null });
          for (const p of it.paras) d.appendChild(this.paraEl(p, it.paras, { kind: 'box' }));
          return d;
        }
      }
      return null;
    }

    imageEl(it) {
      const img = this.doc.images[it.bin];
      const size = { width: it.w ? it.w + 'px' : null, height: it.h ? it.h + 'px' : null };
      if (img && img.url) {
        const i = el('img', 'hwp-img', size);
        i.src = img.url;
        i.alt = '';
        return i;
      }
      const ph = el('span', 'hwp-img-missing', { width: (it.w || 120) + 'px', height: (it.h || 60) + 'px' });
      ph.textContent = img && img.unsupported ? `[${img.unsupported.toUpperCase()} 그림 - 표시 불가]` : '[그림]';
      return ph;
    }

    tableEl(t) {
      // 열 너비 계산
      const cols = t.cols || Math.max(0, ...t.cells.map((c) => c.col + c.colSpan));
      const rows = t.rows || Math.max(0, ...t.cells.map((c) => c.row + c.rowSpan));
      const colW = new Array(cols).fill(null);
      for (const c of t.cells) if (c.colSpan === 1 && c.w && colW[c.col] == null) colW[c.col] = c.w;
      for (const c of t.cells) {
        if (c.colSpan <= 1 || !c.w) continue;
        const idx = [];
        let known = 0;
        for (let i = c.col; i < c.col + c.colSpan && i < cols; i++) {
          if (colW[i] == null) idx.push(i); else known += colW[i];
        }
        if (idx.length) idx.forEach((i) => { colW[i] = Math.max(4, (c.w - known) / idx.length); });
      }
      const knownW = colW.filter((w) => w != null);
      const avg = knownW.length ? knownW.reduce((a, b) => a + b, 0) / knownW.length : 60;
      for (let i = 0; i < cols; i++) if (colW[i] == null) colW[i] = avg;
      const total = colW.reduce((a, b) => a + b, 0);

      const table = el('table', 'hwp-table', { width: total + 'px' });
      const cg = el('colgroup');
      colW.forEach((w) => cg.appendChild(el('col', null, { width: w + 'px' })));
      table.appendChild(cg);

      const byRow = [];
      for (let r = 0; r < rows; r++) byRow.push([]);
      for (const c of t.cells) (byRow[c.row] || (byRow[c.row] = [])).push(c);
      const tbody = el('tbody');
      for (const rc of byRow) {
        const tr = el('tr');
        rc.sort((a, b) => a.col - b.col);
        for (const c of rc) {
          const bf = this.doc.borderFills[c.borderFillId] || this.doc.borderFills[t.borderFillId];
          const st = {
            height: c.h ? c.h + 'px' : null,
            padding: c.pad ? `${c.pad[2]}px ${c.pad[1]}px ${c.pad[3]}px ${c.pad[0]}px` : null,
            verticalAlign: c.valign || 'middle',
          };
          if (bf) {
            st.borderLeft = borderCss(bf.borders.left);
            st.borderRight = borderCss(bf.borders.right);
            st.borderTop = borderCss(bf.borders.top);
            st.borderBottom = borderCss(bf.borders.bottom);
            if (bf.bg) st.backgroundColor = bf.bg;
          }
          const td = el('td', null, st);
          td._cell = c; td._table = t;
          if (c.colSpan > 1) td.colSpan = c.colSpan;
          if (c.rowSpan > 1) td.rowSpan = c.rowSpan;
          for (const p of c.paras) td.appendChild(this.paraEl(p, c.paras, { kind: 'cell', table: t, cell: c }));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      return table;
    }

    renderInto(container) {
      container.innerHTML = '';
      const pages = [];
      for (const sec of this.doc.sections) {
        const pg = Object.assign({}, DEFAULT_PAGE, sec.page || {});
        let page = null, body = null;
        const newPage = () => {
          page = el('div', 'hwp-page', {
            width: pg.width + 'px', minHeight: pg.height + 'px',
            padding: `${pg.top}px ${pg.right}px ${pg.bottom}px ${pg.left}px`,
          });
          body = el('div', 'hwp-body');
          page.appendChild(body);
          container.appendChild(page);
          pages.push(page);
        };
        newPage();
        for (const para of sec.paras) {
          if (para.newPage && body.childNodes.length) newPage();
          body.appendChild(this.paraEl(para, sec.paras, { kind: 'section', section: sec }));
        }
        if (sec.footnotes.length) {
          const fn = el('div', 'hwp-footnotes');
          for (const f of sec.footnotes) {
            const row = el('div', 'hwp-footnote');
            const n = el('span', 'hwp-footnote-num');
            n.textContent = f.num + ')';
            row.appendChild(n);
            for (const p of f.paras) row.appendChild(this.paraEl(p, f.paras, { kind: 'foot' }));
            fn.appendChild(row);
          }
          body.appendChild(fn);
        }
      }
      pages.forEach((p, i) => {
        const n = el('div', 'hwp-page-num');
        n.textContent = `- ${i + 1} -`;
        p.appendChild(n);
      });
      return pages;
    }
  }

  global.HwpRenderer = Renderer;
})(window);
