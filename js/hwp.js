/* HWP 5.0 바이너리 문서 파서 -> 공통 문서 모델 */
(function (global) {
  'use strict';

  const T = {
    DOCUMENT_PROPERTIES: 0x10, ID_MAPPINGS: 0x11, BIN_DATA: 0x12, FACE_NAME: 0x13,
    BORDER_FILL: 0x14, CHAR_SHAPE: 0x15, PARA_SHAPE: 0x19,
    PARA_HEADER: 0x42, PARA_TEXT: 0x43, PARA_CHAR_SHAPE: 0x44, PARA_LINE_SEG: 0x45,
    CTRL_HEADER: 0x47, LIST_HEADER: 0x48, PAGE_DEF: 0x49, SHAPE_COMPONENT: 0x4C,
    TABLE: 0x4D, SHAPE_PICTURE: 0x55, EQEDIT: 0x58,
  };

  const HWPUNIT_PX = 96 / 7200; // 1 HWPUNIT = 1/7200 inch
  const BORDER_WIDTH_MM = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];
  const BORDER_STYLE = ['none', 'solid', 'dashed', 'dotted', 'dashed', 'dashed', 'dashed', 'dotted',
    'double', 'double', 'double', 'double', 'solid', 'double', 'solid', 'solid', 'solid', 'solid'];
  const ALIGN = ['justify', 'left', 'right', 'center', 'justify', 'justify'];

  function colorref(v) {
    if (v === 0xFFFFFFFF || v == null) return null;
    const r = v & 0xFF, g = (v >> 8) & 0xFF, b = (v >> 16) & 0xFF;
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  function view(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }

  function wstr(u8, off, len) {
    const dv = view(u8);
    let s = '';
    for (let i = 0; i < len && off + i * 2 + 2 <= u8.length; i++) s += String.fromCharCode(dv.getUint16(off + i * 2, true));
    return s;
  }

  function ctrlIdStr(v) {
    return String.fromCharCode((v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF);
  }

  // ---------- 레코드 ----------
  function parseRecords(u8) {
    const dv = view(u8);
    const recs = [];
    let p = 0;
    while (p + 4 <= u8.length) {
      const h = dv.getUint32(p, true);
      p += 4;
      const tag = h & 0x3FF;
      const level = (h >>> 10) & 0x3FF;
      let size = (h >>> 20) & 0xFFF;
      if (size === 0xFFF) { size = dv.getUint32(p, true); p += 4; }
      recs.push({ tag, level, data: u8.subarray(p, p + size), children: [] });
      p += size;
    }
    return recs;
  }

  function buildTree(recs) {
    const root = { tag: -1, level: -1, children: [] };
    const stack = [root];
    for (const r of recs) {
      while (stack.length > 1 && stack[stack.length - 1].level >= r.level) stack.pop();
      stack[stack.length - 1].children.push(r);
      stack.push(r);
    }
    return root.children;
  }

  // ---------- DocInfo ----------
  function parseDocInfo(u8, ver) {
    const recs = parseRecords(u8);
    const info = { idMap: [], faces: [], charShapes: [], paraShapes: [], borderFills: {}, binData: [], recs, charShapeRecs: [] };
    let bfId = 1;
    for (const r of recs) {
      const d = r.data, dv = view(d);
      switch (r.tag) {
        case T.ID_MAPPINGS:
          for (let i = 0; i + 4 <= d.length; i += 4) info.idMap.push(dv.getInt32(i, true));
          break;
        case T.BIN_DATA: {
          const prop = dv.getUint16(0, true);
          const type = prop & 0xF;
          const item = { type, compress: (prop >> 4) & 3 };
          if (type === 1 || type === 2) {
            item.id = dv.getUint16(2, true);
            if (type === 1) {
              const extLen = dv.getUint16(4, true);
              item.ext = wstr(d, 6, extLen).toLowerCase();
            }
          }
          info.binData.push(item);
          break;
        }
        case T.FACE_NAME: {
          const len = dv.getUint16(1, true);
          info.faces.push(wstr(d, 3, len));
          break;
        }
        case T.BORDER_FILL: {
          const bf = { borders: {} };
          let p = 2;
          for (const side of ['left', 'right', 'top', 'bottom']) {
            bf.borders[side] = { type: d[p], width: BORDER_WIDTH_MM[d[p + 1]] || 0.12, color: colorref(dv.getUint32(p + 2, true)) || '#000' };
            p += 6;
          }
          p += 6; // 대각선
          if (p + 4 <= d.length) {
            const fillType = dv.getUint32(p, true);
            p += 4;
            if (fillType & 1 && p + 4 <= d.length) bf.bg = colorref(dv.getUint32(p, true));
          }
          info.borderFills[bfId++] = bf;
          break;
        }
        case T.CHAR_SHAPE: {
          info.charShapeRecs.push(r);
          const faceIds = [];
          for (let i = 0; i < 7; i++) faceIds.push(dv.getUint16(i * 2, true));
          const prop = dv.getUint32(46, true);
          info.charShapes.push({
            faceIds,
            ratio: d[14],
            spacing: dv.getInt8(21),
            relSize: d[28],
            size: dv.getInt32(42, true) / 100,
            italic: !!(prop & 1),
            bold: !!(prop & 2),
            underline: ((prop >> 2) & 3) === 1 ? 'underline' : ((prop >> 2) & 3) === 3 ? 'overline' : null,
            sup: !!(prop & (1 << 15)),
            sub: !!(prop & (1 << 16)),
            strike: !!(prop & (1 << 18)),
            color: colorref(dv.getUint32(52, true)) || '#000',
            shade: d.length >= 64 ? colorref(dv.getUint32(60, true)) : null,
          });
          break;
        }
        case T.PARA_SHAPE: {
          const p1 = dv.getUint32(0, true);
          let lsType = p1 & 3, lsValue = dv.getInt32(24, true);
          if (ver >= 0x05000205 && d.length >= 54) {
            lsType = dv.getUint32(46, true) & 0x1F;
            lsValue = dv.getUint32(50, true);
          }
          info.paraShapes.push({
            align: ALIGN[(p1 >> 2) & 7] || 'justify',
            headType: (p1 >> 23) & 3,
            left: dv.getInt32(4, true) / 2,
            right: dv.getInt32(8, true) / 2,
            indent: dv.getInt32(12, true) / 2,
            before: dv.getInt32(16, true) / 2,
            after: dv.getInt32(20, true) / 2,
            lsType, lsValue,
            borderFillId: dv.getUint16(32, true),
          });
          break;
        }
      }
    }
    // 글꼴 이름을 언어별로 분리 (한글, 영문, 한자, 일어, 기타, 기호, 사용자)
    const fontsByLang = [];
    let fi = 0;
    for (let lang = 0; lang < 7; lang++) {
      const n = info.idMap[lang + 1] || 0;
      fontsByLang.push(info.faces.slice(fi, fi + n));
      fi += n;
    }
    for (const cs of info.charShapes) {
      cs.fontHangul = fontsByLang[0][cs.faceIds[0]] || '';
      cs.fontLatin = fontsByLang[1][cs.faceIds[1]] || cs.fontHangul;
    }
    return info;
  }

  // ---------- BodyText ----------
  const EXT_CTRL = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);
  const INLINE_CTRL = new Set([4, 5, 6, 7, 8, 9, 19, 20]);

  function parseSection(nodes, ctx) {
    const section = { page: null, paras: [], footnotes: [] };
    ctx.section = section;
    let lastVert = -1;
    for (const n of nodes) {
      if (n.tag !== T.PARA_HEADER) continue;
      const para = parsePara(n, ctx);
      // 줄 배치 정보로 쪽 나눔 추정
      if (para.firstLine) {
        if ((para.firstLine.tag & 1) && section.paras.length) para.newPage = true;
        else if (lastVert >= 0 && para.firstLine.vert < lastVert && para.firstLine.vert < 1000) para.newPage = true;
      }
      if (para.lastVert != null) lastVert = para.lastVert;
      section.paras.push(para);
    }
    return section;
  }

  function parsePara(node, ctx) {
    const hd = view(node.data);
    const para = {
      shape: hd.getUint16(8, true),
      items: [],
      newPage: !!(node.data[11] & 0x05),
    };
    let text = null, charShapes = [[0, 0]];
    const ctrls = [];
    for (const c of node.children) {
      if (c.tag === T.PARA_TEXT) text = c.data;
      else if (c.tag === T.PARA_CHAR_SHAPE) {
        const dv = view(c.data);
        charShapes = [];
        for (let i = 0; i + 8 <= c.data.length; i += 8) charShapes.push([dv.getUint32(i, true), dv.getUint32(i + 4, true)]);
      } else if (c.tag === T.PARA_LINE_SEG && c.data.length >= 36) {
        const dv = view(c.data);
        para.firstLine = { vert: dv.getInt32(4, true), tag: dv.getUint32(32, true) };
        const last = c.data.length - 36;
        para.lastVert = dv.getInt32(last + 4, true);
      } else if (c.tag === T.CTRL_HEADER) {
        ctrls.push(c);
      }
    }

    const csAt = (pos) => {
      let id = charShapes[0][1];
      for (const [p, s] of charShapes) { if (p <= pos) id = s; else break; }
      return id;
    };

    const pushText = (s, cs) => {
      const last = para.items[para.items.length - 1];
      if (last && last.t === 'text' && last.cs === cs) last.text += s;
      else para.items.push({ t: 'text', text: s, cs });
    };

    // 컨트롤 문자에 대응하는 CTRL_HEADER 매칭
    const used = new Array(ctrls.length).fill(false);
    const takeCtrl = (id) => {
      for (let i = 0; i < ctrls.length; i++) {
        if (!used[i] && view(ctrls[i].data).getUint32(0, true) === id) { used[i] = true; return ctrls[i]; }
      }
      return null;
    };

    // 편집/저장을 위해 원본 레코드와 컨트롤 문자 코드를 항목에 보존한다
    if (text) {
      const dv = view(text);
      const n = text.length / 2;
      const codesAt = (i, len) => { const a = []; for (let k = 0; k < len && i + k < n; k++) a.push(dv.getUint16((i + k) * 2, true)); return a; };
      for (let i = 0; i < n;) {
        const ch = dv.getUint16(i * 2, true);
        if (ch < 32) {
          if (EXT_CTRL.has(ch)) {
            const id = i * 2 + 6 <= text.length ? dv.getUint32(i * 2 + 2, true) : 0;
            const ctrl = takeCtrl(id);
            const item = (ctrl && handleCtrl(ctrl, para, ctx, csAt(i))) || { t: 'hidden' };
            item.codes = codesAt(i, 8);
            item.node = ctrl;
            item.cs = item.cs ?? csAt(i);
            para.items.push(item);
            i += 8;
          } else if (INLINE_CTRL.has(ch)) {
            para.items.push({ t: ch === 9 ? 'tab' : 'hidden', codes: codesAt(i, 8), cs: csAt(i) });
            i += 8;
          } else {
            if (ch === 10) para.items.push({ t: 'br', codes: [10], cs: csAt(i) });
            else if (ch === 24) pushText('-', csAt(i));
            else if (ch === 30) pushText(' ', csAt(i));
            else if (ch === 31) pushText(' ', csAt(i));
            else if (ch !== 13) para.items.push({ t: 'hidden', codes: [ch], cs: csAt(i) });
            i += 1;
          }
        } else {
          pushText(String.fromCharCode(ch), csAt(i));
          i += 1;
        }
      }
    }
    // 텍스트에 연결되지 않은 컨트롤도 보존
    ctrls.forEach((c, i) => {
      if (used[i]) return;
      const item = handleCtrl(c, para, ctx, csAt(0)) || { t: 'hidden' };
      item.codes = null; item.node = c;
      para.items.push(item);
    });
    para.raw = node;
    para.cs = csAt(0);
    return para;
  }

  // 개체 공통 속성: 글자처럼 취급 여부, 가로 정렬, 가로 오프셋
  function objLayout(dv) {
    if (dv.byteLength < 16) return { inline: true };
    const prop = dv.getUint32(4, true);
    return {
      inline: !!(prop & 1),
      halign: ['left', 'center', 'right', 'left', 'right'][(prop >> 10) & 7] || 'left',
      xOff: dv.getInt32(12, true) * HWPUNIT_PX,
      wrap: (prop >> 21) & 7,
    };
  }

  function handleCtrl(node, para, ctx, cs) {
    const dv = view(node.data);
    const id = ctrlIdStr(dv.getUint32(0, true));
    switch (id) {
      case 'secd': {
        const pd = node.children.find((c) => c.tag === T.PAGE_DEF);
        if (pd && !ctx.section.page) {
          const v = view(pd.data);
          let w = v.getUint32(0, true), h = v.getUint32(4, true);
          if ((v.getUint32(36, true) & 1) && w < h) [w, h] = [h, w];
          ctx.section.page = {
            width: w * HWPUNIT_PX, height: h * HWPUNIT_PX,
            left: v.getUint32(8, true) * HWPUNIT_PX, right: v.getUint32(12, true) * HWPUNIT_PX,
            top: (v.getUint32(16, true) + v.getUint32(24, true)) * HWPUNIT_PX,
            bottom: (v.getUint32(20, true) + v.getUint32(28, true)) * HWPUNIT_PX,
          };
        }
        return { t: 'hidden', keep: true }; // 구역 정의는 삭제되면 안 됨
      }
      case 'tbl ':
        return Object.assign(parseTable(node, ctx), { layout: objLayout(dv) });
      case 'gso ': {
        const w = dv.getUint32(16, true) * HWPUNIT_PX, h = dv.getUint32(20, true) * HWPUNIT_PX;
        const layout = objLayout(dv);
        const pics = [];
        findAll(node, T.SHAPE_PICTURE, pics);
        const imgs = pics.map((pic) => ({
          t: 'image', bin: pic.data.length >= 73 ? view(pic.data).getUint16(71, true) : 0,
          w: pics.length === 1 ? w : null, h: pics.length === 1 ? h : null, layout,
        }));
        if (imgs.length === 1) return imgs[0];
        if (imgs.length > 1) return { t: 'images', list: imgs, layout };
        const paras = collectParas(node, ctx);
        return paras.length ? { t: 'box', paras, w, h, layout } : null;
      }
      case 'eqed': {
        const eq = node.children.find((c) => c.tag === T.EQEDIT);
        if (eq && eq.data.length > 6) {
          const len = view(eq.data).getUint16(4, true);
          return { t: 'equation', text: wstr(eq.data, 6, len) };
        }
        return null;
      }
      case 'fn  ':
      case 'en  ': {
        const paras = collectParas(node, ctx);
        const num = ctx.section.footnotes.length + 1;
        ctx.section.footnotes.push({ num, paras });
        return { t: 'footref', num, cs };
      }
      default:
        return { t: 'hidden', keep: id === 'cold' }; // 머리말/꼬리말, 필드, 책갈피 등은 표시하지 않고 보존
    }
    return null;
  }

  function findAll(node, tag, out) {
    for (const c of node.children) {
      if (c.tag === tag) out.push(c);
      else if (c.tag !== T.PARA_HEADER) findAll(c, tag, out);
    }
  }

  function collectParas(node, ctx) {
    const out = [];
    for (const c of node.children) {
      if (c.tag === T.PARA_HEADER) out.push(parsePara(c, ctx));
      else out.push(...collectParas(c, ctx));
    }
    return out;
  }

  function parseTable(node, ctx) {
    const dv = view(node.data);
    const table = {
      t: 'table',
      w: dv.getUint32(16, true) * HWPUNIT_PX,
      node,
      cells: [], rows: 0, cols: 0, borderFillId: 0,
    };
    let cell = null;
    for (const c of node.children) {
      if (c.tag === T.TABLE) {
        const v = view(c.data);
        table.rows = v.getUint16(4, true);
        table.cols = v.getUint16(6, true);
        const bfOff = 18 + table.rows * 2;
        if (bfOff + 2 <= c.data.length) table.borderFillId = v.getUint16(bfOff, true);
      } else if (c.tag === T.LIST_HEADER) {
        const v = view(c.data);
        const prop = v.getUint32(4, true);
        cell = {
          col: v.getUint16(8, true), row: v.getUint16(10, true),
          colSpan: v.getUint16(12, true) || 1, rowSpan: v.getUint16(14, true) || 1,
          w: v.getUint32(16, true) * HWPUNIT_PX, h: v.getUint32(20, true) * HWPUNIT_PX,
          pad: [v.getUint16(24, true), v.getUint16(26, true), v.getUint16(28, true), v.getUint16(30, true)].map((x) => x * HWPUNIT_PX),
          borderFillId: c.data.length >= 34 ? v.getUint16(32, true) : 0,
          valign: ['top', 'middle', 'bottom'][(prop >> 5) & 3] || 'middle',
          paras: [],
          raw: c,
        };
        table.cells.push(cell);
      } else if (c.tag === T.PARA_HEADER && cell) {
        cell.paras.push(parsePara(c, ctx));
      }
    }
    return table;
  }

  // ---------- 진입점 ----------
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml', webp: 'image/webp' };

  async function parseHWP(buf) {
    const C = global.HwpContainer;
    const cfb = C.parseCFB(buf);
    const fh = cfb.read('FileHeader');
    if (!fh) throw new Error('FileHeader 스트림이 없습니다.');
    const sig = new TextDecoder('ascii').decode(fh.subarray(0, 17));
    if (sig !== 'HWP Document File') throw new Error('HWP 5.0 문서가 아닙니다.');
    const fv = view(fh);
    const ver = fv.getUint32(32, true);
    const flags = fv.getUint32(36, true);
    const compressed = !!(flags & 1);
    if (flags & 2) throw new Error('암호가 설정된 문서는 열 수 없습니다.');
    if (flags & 4) throw new Error('배포용 문서는 지원하지 않습니다.');

    const load = async (path, comp = compressed) => {
      const raw = cfb.read(path);
      if (!raw) return null;
      if (!comp) return raw;
      try { return await C.inflateRaw(raw); } catch (e) { return raw; }
    };

    const info = parseDocInfo(await load('DocInfo'), ver);

    // 이미지 (BinData)
    const images = {};
    for (let i = 0; i < info.binData.length; i++) {
      const b = info.binData[i];
      if (b.type !== 1) continue;
      const name = 'BinData/BIN' + b.id.toString(16).toUpperCase().padStart(4, '0') + '.' + b.ext;
      const comp = b.compress === 0 ? compressed : b.compress === 1;
      const data = await load(name, comp);
      if (!data) continue;
      images[i + 1] = MIME[b.ext]
        ? { url: URL.createObjectURL(new Blob([data], { type: MIME[b.ext] })) }
        : { unsupported: b.ext };
    }

    const ctx = {};
    const sections = [];
    for (let i = 0; ; i++) {
      const data = await load('BodyText/Section' + i);
      if (!data) break;
      sections.push(parseSection(buildTree(parseRecords(data)), ctx));
    }

    return {
      format: 'HWP ' + [ver >>> 24, (ver >> 16) & 0xFF, (ver >> 8) & 0xFF, ver & 0xFF].join('.'),
      charShapes: info.charShapes.map((c) => ({
        fontHangul: c.fontHangul, fontLatin: c.fontLatin, size: c.size * (c.relSize || 100) / 100,
        bold: c.bold, italic: c.italic, underline: c.underline, strike: c.strike,
        sup: c.sup, sub: c.sub, color: c.color, shade: c.shade, spacing: c.spacing, ratio: c.ratio,
      })),
      paraShapes: info.paraShapes.map((p) => ({
        align: p.align, bullet: p.headType === 3,
        left: p.left * HWPUNIT_PX, right: p.right * HWPUNIT_PX, indent: p.indent * HWPUNIT_PX,
        before: p.before * HWPUNIT_PX, after: p.after * HWPUNIT_PX,
        lineHeight: p.lsType === 0 ? { percent: p.lsValue } : p.lsType === 1 ? { px: p.lsValue * HWPUNIT_PX } : { percent: 160 },
        borderFillId: p.borderFillId,
      })),
      borderFills: info.borderFills,
      images,
      sections,
      source: { kind: 'hwp', cfb, compressed, docInfoRecs: info.recs, charShapeRecs: info.charShapeRecs },
    };
  }

  global.parseHWP = parseHWP;
  global.HwpRecords = { T, parseRecords, buildTree, ctrlIdStr };
})(window);
