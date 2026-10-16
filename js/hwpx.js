/* HWPX (OWPML, ZIP + XML) 문서 파서 -> 공통 문서 모델 */
(function (global) {
  'use strict';

  const HWPUNIT_PX = 96 / 7200;
  const ALIGN = { JUSTIFY: 'justify', LEFT: 'left', RIGHT: 'right', CENTER: 'center', DISTRIBUTE: 'justify', DISTRIBUTE_SPACE: 'justify' };
  const BORDER_STYLE = {
    NONE: 0, SOLID: 1, DASH: 2, DOT: 3, DASH_DOT: 4, DASH_DOT_DOT: 5, LONG_DASH: 6, CIRCLE: 7,
    DOUBLE_SLIM: 8, SLIM_THICK: 9, THICK_SLIM: 10, SLIM_THICK_SLIM: 11, WAVE: 12, DOUBLEWAVE: 13,
  };
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' };

  // 네임스페이스 접두어와 무관하게 localName 으로 탐색
  const kids = (el, name) => Array.from(el.children).filter((c) => c.localName === name);
  const kid = (el, name) => Array.from(el.children).find((c) => c.localName === name) || null;
  const desc = (el, name) => el.getElementsByTagNameNS('*', name);
  const num = (v, d = 0) => (v == null || v === '' || isNaN(+v) ? d : +v);
  const color = (v) => (!v || v === 'none' ? null : v);

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new Error('XML 파싱 오류: ' + err.textContent.slice(0, 200));
    return doc;
  }

  // switch/case 안에 있는 요소는 default 값을 우선 사용
  function pickSwitch(el, name) {
    const direct = kid(el, name);
    if (direct) return direct;
    const sw = kid(el, 'switch');
    if (sw) {
      const def = kid(sw, 'default');
      if (def && kid(def, name)) return kid(def, name);
      const c = kid(sw, 'case');
      if (c && kid(c, name)) return kid(c, name);
    }
    return desc(el, name)[0] || null;
  }

  function parseHeader(doc) {
    const fonts = {};
    for (const ff of desc(doc, 'fontface')) {
      const lang = ff.getAttribute('lang');
      fonts[lang] = {};
      for (const f of kids(ff, 'font')) fonts[lang][f.getAttribute('id')] = f.getAttribute('face');
    }

    const charShapes = [];
    for (const cp of desc(doc, 'charPr')) {
      const id = num(cp.getAttribute('id'));
      const fr = kid(cp, 'fontRef');
      const rel = kid(cp, 'relSz');
      const sp = kid(cp, 'spacing');
      const ul = kid(cp, 'underline');
      const so = kid(cp, 'strikeout');
      const ulType = ul ? ul.getAttribute('type') : 'NONE';
      charShapes[id] = {
        fontHangul: fr && fonts.HANGUL ? fonts.HANGUL[fr.getAttribute('hangul')] || '' : '',
        fontLatin: fr && fonts.LATIN ? fonts.LATIN[fr.getAttribute('latin')] || '' : '',
        size: num(cp.getAttribute('height'), 1000) / 100 * (rel ? num(rel.getAttribute('hangul'), 100) : 100) / 100,
        bold: !!kid(cp, 'bold'),
        italic: !!kid(cp, 'italic'),
        underline: ulType === 'BOTTOM' ? 'underline' : ulType === 'TOP' ? 'overline' : null,
        strike: !!(so && so.getAttribute('shape') && so.getAttribute('shape') !== 'NONE'),
        sup: !!kid(cp, 'supscript'),
        sub: !!kid(cp, 'subscript'),
        color: color(cp.getAttribute('textColor')) || '#000',
        shade: color(cp.getAttribute('shadeColor')),
        spacing: sp ? num(sp.getAttribute('hangul')) : 0,
      };
    }

    const paraShapes = [];
    for (const pp of desc(doc, 'paraPr')) {
      const id = num(pp.getAttribute('id'));
      const al = kid(pp, 'align');
      const head = kid(pp, 'heading');
      const mg = pickSwitch(pp, 'margin');
      const ls = pickSwitch(pp, 'lineSpacing');
      const bd = kid(pp, 'border');
      const mv = (n) => { const e = mg && kid(mg, n); return e ? num(e.getAttribute('value')) * HWPUNIT_PX : 0; };
      const lsType = ls ? ls.getAttribute('type') : 'PERCENT';
      const lsVal = ls ? num(ls.getAttribute('value'), 160) : 160;
      paraShapes[id] = {
        align: ALIGN[al && al.getAttribute('horizontal')] || 'justify',
        bullet: head && head.getAttribute('type') === 'BULLET',
        left: mv('left'), right: mv('right'), indent: mv('intent'), before: mv('prev'), after: mv('next'),
        lineHeight: lsType === 'PERCENT' ? { percent: lsVal } : lsType === 'FIXED' ? { px: lsVal * HWPUNIT_PX } : { percent: 160 },
        borderFillId: bd ? num(bd.getAttribute('borderFillIDRef')) : 0,
      };
    }

    const borderFills = {};
    for (const bf of desc(doc, 'borderFill')) {
      const b = { borders: {} };
      for (const side of ['left', 'right', 'top', 'bottom']) {
        const e = kid(bf, side + 'Border');
        b.borders[side] = {
          type: e ? BORDER_STYLE[e.getAttribute('type')] ?? 1 : 0,
          width: e ? parseFloat(e.getAttribute('width')) || 0.12 : 0.12,
          color: e ? e.getAttribute('color') || '#000' : '#000',
        };
      }
      const wb = desc(bf, 'winBrush')[0];
      if (wb) b.bg = color(wb.getAttribute('faceColor'));
      borderFills[bf.getAttribute('id')] = b;
    }
    const charPrEls = {};
    for (const cp of desc(doc, 'charPr')) charPrEls[cp.getAttribute('id')] = cp;
    return { charShapes, paraShapes, borderFills, charPrEls };
  }

  function parseSection(doc, ctx) {
    const section = { page: null, paras: [], footnotes: [] };
    ctx.section = section;
    let lastVert = -1;
    for (const p of kids(doc.documentElement, 'p')) {
      const para = parsePara(p, ctx);
      if (para.firstVert != null) {
        if (lastVert >= 0 && para.firstVert < lastVert && para.firstVert < 1000) para.newPage = true;
        lastVert = para.lastVert;
      }
      section.paras.push(para);
    }
    return section;
  }

  function parsePara(p, ctx) {
    const para = {
      shape: num(p.getAttribute('paraPrIDRef')),
      items: [],
      newPage: p.getAttribute('pageBreak') === '1',
      cs: 0,
    };
    const segs = desc(p, 'lineseg');
    const ownSegs = Array.from(segs).filter((s) => s.parentNode.parentNode === p);
    if (ownSegs.length) {
      para.firstVert = num(ownSegs[0].getAttribute('vertpos'));
      para.lastVert = num(ownSegs[ownSegs.length - 1].getAttribute('vertpos'));
    }

    const pushText = (s, cs) => {
      const last = para.items[para.items.length - 1];
      if (last && last.t === 'text' && last.cs === cs) last.text += s;
      else para.items.push({ t: 'text', text: s, cs });
    };

    // 편집/저장을 위해 런 안의 개체 요소(el)와 런 글자 모양(runCs)을 항목에 보존한다
    let first = true;
    for (const run of kids(p, 'run')) {
      const cs = num(run.getAttribute('charPrIDRef'));
      if (first) { para.cs = cs; first = false; }
      for (const el of run.children) {
        let item = null;
        switch (el.localName) {
          case 't':
            for (const n of el.childNodes) {
              if (n.nodeType === 3) pushText(n.nodeValue, cs);
              else if (n.nodeType === 1) {
                const ln = n.localName;
                if (ln === 'tab') para.items.push({ t: 'tab', cs, xml: n });
                else if (ln === 'lineBreak') para.items.push({ t: 'br', cs, xml: n });
                else if (ln === 'nbSpace' || ln === 'fwSpace') pushText(' ', cs);
                else if (ln === 'hyphen') pushText('-', cs);
                else if (n.textContent) pushText(n.textContent, cs);
              }
            }
            continue;
          case 'secPr': {
            const pp = kid(el, 'pagePr');
            if (pp && !ctx.section.page) {
              const m = kid(pp, 'margin');
              const mv = (n) => (m ? num(m.getAttribute(n)) : 0);
              ctx.section.page = {
                width: num(pp.getAttribute('width'), 59528) * HWPUNIT_PX,
                height: num(pp.getAttribute('height'), 84188) * HWPUNIT_PX,
                left: mv('left') * HWPUNIT_PX, right: mv('right') * HWPUNIT_PX,
                top: (mv('top') + mv('header')) * HWPUNIT_PX, bottom: (mv('bottom') + mv('footer')) * HWPUNIT_PX,
              };
            }
            item = { t: 'hidden', keep: true };
            break;
          }
          case 'tbl':
            item = parseTable(el, ctx);
            break;
          case 'pic':
            item = parsePic(el, ctx);
            break;
          case 'container': {
            const list = Array.from(desc(el, 'pic')).map((pic) => parsePic(pic, ctx));
            item = list.length ? { t: 'images', list, layout: objLayout(el) } : null;
            break;
          }
          case 'rect': case 'ellipse': case 'polygon': case 'curve': case 'arc': {
            const dt = kid(el, 'drawText');
            const sl = dt && kid(dt, 'subList');
            if (sl) {
              const sz = kid(el, 'sz');
              item = {
                t: 'box', layout: objLayout(el), paras: kids(sl, 'p').map((x) => parsePara(x, ctx)),
                w: sz ? num(sz.getAttribute('width')) * HWPUNIT_PX : null,
                h: sz ? num(sz.getAttribute('height')) * HWPUNIT_PX : null,
              };
            }
            break;
          }
          case 'equation': {
            const sc = kid(el, 'script');
            if (sc) item = { t: 'equation', text: sc.textContent };
            break;
          }
          case 'ctrl': {
            const fn = kid(el, 'footNote') || kid(el, 'endNote');
            if (fn) {
              const sl = kid(fn, 'subList');
              const n = ctx.section.footnotes.length + 1;
              ctx.section.footnotes.push({ num: n, paras: sl ? kids(sl, 'p').map((x) => parsePara(x, ctx)) : [] });
              item = { t: 'footref', num: n };
            } else {
              item = { t: 'hidden', keep: !!kid(el, 'colPr') };
            }
            break;
          }
        }
        item = item || { t: 'hidden' };
        item.el = el;
        item.cs = item.cs ?? cs;
        item.runCs = cs;
        para.items.push(item);
      }
    }
    para.raw = p;
    return para;
  }

  function objLayout(el) {
    const pos = kid(el, 'pos');
    if (!pos) return { inline: true };
    const ha = pos.getAttribute('horzAlign');
    return {
      inline: pos.getAttribute('treatAsChar') === '1',
      halign: ha === 'CENTER' ? 'center' : ha === 'RIGHT' || ha === 'OUTSIDE' ? 'right' : 'left',
      xOff: num(pos.getAttribute('horzOffset')) * HWPUNIT_PX,
      wrap: { SQUARE: 0, TOP_AND_BOTTOM: 1, BEHIND_TEXT: 2, IN_FRONT_OF_TEXT: 3 }[el.getAttribute('textWrap')] ?? 1,
    };
  }

  function parseTable(el, ctx) {
    const sz = kid(el, 'sz');
    const table = {
      t: 'table',
      el,
      layout: objLayout(el),
      w: sz ? num(sz.getAttribute('width')) * HWPUNIT_PX : null,
      rows: num(el.getAttribute('rowCnt')), cols: num(el.getAttribute('colCnt')),
      borderFillId: num(el.getAttribute('borderFillIDRef')),
      cells: [],
    };
    for (const tr of kids(el, 'tr')) {
      for (const tc of kids(tr, 'tc')) {
        const addr = kid(tc, 'cellAddr'), span = kid(tc, 'cellSpan'), csz = kid(tc, 'cellSz'), mg = kid(tc, 'cellMargin');
        const sl = kid(tc, 'subList');
        const va = sl ? sl.getAttribute('vertAlign') : 'CENTER';
        table.cells.push({
          col: addr ? num(addr.getAttribute('colAddr')) : 0,
          row: addr ? num(addr.getAttribute('rowAddr')) : 0,
          colSpan: span ? num(span.getAttribute('colSpan'), 1) : 1,
          rowSpan: span ? num(span.getAttribute('rowSpan'), 1) : 1,
          w: csz ? num(csz.getAttribute('width')) * HWPUNIT_PX : null,
          h: csz ? num(csz.getAttribute('height')) * HWPUNIT_PX : null,
          pad: mg ? ['left', 'right', 'top', 'bottom'].map((s) => num(mg.getAttribute(s)) * HWPUNIT_PX) : [1.9, 1.9, 0.6, 0.6],
          borderFillId: num(tc.getAttribute('borderFillIDRef')),
          valign: va === 'TOP' ? 'top' : va === 'BOTTOM' ? 'bottom' : 'middle',
          paras: sl ? kids(sl, 'p').map((x) => parsePara(x, ctx)) : [],
          raw: tc,
        });
      }
    }
    return table;
  }

  function parsePic(el, ctx) {
    const sz = kid(el, 'curSz') || kid(el, 'sz');
    const img = desc(el, 'img')[0];
    return {
      t: 'image',
      layout: objLayout(el),
      bin: img ? img.getAttribute('binaryItemIDRef') : null,
      w: sz ? num(sz.getAttribute('width')) * HWPUNIT_PX || null : null,
      h: sz ? num(sz.getAttribute('height')) * HWPUNIT_PX || null : null,
    };
  }

  async function parseHWPX(buf) {
    const zip = global.HwpContainer.parseZIP(buf);
    const hpfName = zip.list().find((n) => /content\.hpf$/i.test(n)) || 'Contents/content.hpf';
    const hpfText = await zip.readText(hpfName);
    const items = {};
    let sectionFiles = [];
    if (hpfText) {
      const hpf = parseXml(hpfText);
      for (const it of desc(hpf, 'item')) items[it.getAttribute('id')] = { href: it.getAttribute('href'), type: it.getAttribute('media-type') };
      for (const ref of desc(hpf, 'itemref')) {
        const it = items[ref.getAttribute('idref')];
        if (it && /section\d+\.xml$/i.test(it.href)) sectionFiles.push(it.href);
      }
    }
    if (!sectionFiles.length) {
      sectionFiles = zip.list().filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
        .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    }
    const headerText = await zip.readText('Contents/header.xml');
    if (!headerText) throw new Error('Contents/header.xml 이 없습니다.');
    const headerXml = parseXml(headerText);
    const { charPrEls, ...header } = parseHeader(headerXml);

    const images = {};
    for (const [id, it] of Object.entries(items)) {
      if (!it.href || !/^BinData\//i.test(it.href)) continue;
      const ext = (it.href.split('.').pop() || '').toLowerCase();
      const data = await zip.read(it.href);
      if (!data) continue;
      images[id] = MIME[ext] ? { url: URL.createObjectURL(new Blob([data], { type: MIME[ext] })) } : { unsupported: ext };
    }

    const ctx = {};
    const sections = [];
    for (const f of sectionFiles) {
      const t = await zip.readText(f);
      if (!t) continue;
      const xml = parseXml(t);
      const sec = parseSection(xml, ctx);
      sec.xml = xml;
      sec.file = f;
      sections.push(sec);
    }

    return { format: 'HWPX', ...header, images, sections, source: { kind: 'hwpx', zip, headerXml, charPrEls } };
  }

  global.parseHWPX = parseHWPX;
})(window);
