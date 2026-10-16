/* 컨테이너 포맷 파서: CFB(OLE 복합 문서, HWP 5.0) / ZIP(HWPX) 와 압축 해제 */
(function (global) {
  'use strict';

  // ---------- 압축 해제 ----------
  // HWP 스트림은 압축 데이터 뒤에 여분 바이트가 붙는 경우가 있어,
  // 그 오류("Junk found after end")는 무시하고 그때까지의 결과를 사용한다.
  async function decompress(data, format) {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    writer.write(data).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
    } catch (e) {
      if (!total || !/junk/i.test(String(e && e.message))) throw e;
    }
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  async function inflateRaw(data) {
    try {
      return await decompress(data, 'deflate-raw');
    } catch (e) {
      return await decompress(data, 'deflate'); // zlib 헤더가 있는 경우
    }
  }

  // ---------- CFB (Compound File Binary) ----------
  const ENDOFCHAIN = 0xFFFFFFFE;
  const FREESECT = 0xFFFFFFFF;

  function parseCFB(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const sig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    for (let i = 0; i < 8; i++) {
      if (u8[i] !== sig[i]) throw new Error('HWP(OLE) 파일 형식이 아닙니다.');
    }
    const sectorSize = 1 << dv.getUint16(30, true);
    const miniSectorSize = 1 << dv.getUint16(32, true);
    const numFatSectors = dv.getUint32(44, true);
    const firstDirSector = dv.getUint32(48, true);
    const miniCutoff = dv.getUint32(56, true);
    const firstMiniFat = dv.getUint32(60, true);
    const firstDifat = dv.getUint32(68, true);
    const numDifat = dv.getUint32(72, true);

    const sectorOffset = (s) => (s + 1) * sectorSize;

    // DIFAT -> FAT 섹터 목록
    const fatSectors = [];
    for (let i = 0; i < 109 && fatSectors.length < numFatSectors; i++) {
      const s = dv.getUint32(76 + i * 4, true);
      if (s === FREESECT) break;
      fatSectors.push(s);
    }
    let difat = firstDifat;
    for (let n = 0; n < numDifat && difat !== ENDOFCHAIN && difat !== FREESECT; n++) {
      const off = sectorOffset(difat);
      const per = sectorSize / 4 - 1;
      for (let i = 0; i < per && fatSectors.length < numFatSectors; i++) {
        fatSectors.push(dv.getUint32(off + i * 4, true));
      }
      difat = dv.getUint32(off + per * 4, true);
    }

    const perSector = sectorSize / 4;
    const fat = new Uint32Array(fatSectors.length * perSector);
    fatSectors.forEach((s, idx) => {
      const off = sectorOffset(s);
      for (let i = 0; i < perSector; i++) {
        if (off + i * 4 + 4 <= u8.length) fat[idx * perSector + i] = dv.getUint32(off + i * 4, true);
      }
    });

    function chain(start, table) {
      const out = [];
      const seen = new Set();
      let s = start;
      while (s !== ENDOFCHAIN && s !== FREESECT && s < table.length && !seen.has(s)) {
        seen.add(s);
        out.push(s);
        s = table[s];
      }
      return out;
    }

    function readChain(start, size) {
      const sectors = chain(start, fat);
      const out = new Uint8Array(sectors.length * sectorSize);
      sectors.forEach((s, i) => {
        const off = sectorOffset(s);
        out.set(u8.subarray(off, Math.min(off + sectorSize, u8.length)), i * sectorSize);
      });
      return size == null ? out : out.subarray(0, size);
    }

    // 디렉터리 엔트리
    const dirData = readChain(firstDirSector);
    const ddv = new DataView(dirData.buffer, dirData.byteOffset, dirData.byteLength);
    const entries = [];
    for (let off = 0; off + 128 <= dirData.length; off += 128) {
      const nameLen = ddv.getUint16(off + 64, true);
      let name = '';
      for (let i = 0; i < Math.max(0, nameLen / 2 - 1); i++) {
        name += String.fromCharCode(ddv.getUint16(off + i * 2, true));
      }
      entries.push({
        name,
        type: dirData[off + 66], // 1 storage, 2 stream, 5 root
        left: ddv.getUint32(off + 68, true),
        right: ddv.getUint32(off + 72, true),
        child: ddv.getUint32(off + 76, true),
        start: ddv.getUint32(off + 116, true),
        size: ddv.getUint32(off + 120, true),
        clsid: dirData.slice(off + 80, off + 96),
      });
    }

    const root = entries[0];
    const miniStream = readChain(root.start, root.size);
    const miniFatRaw = firstMiniFat === ENDOFCHAIN ? new Uint8Array(0) : readChain(firstMiniFat);
    const mdv = new DataView(miniFatRaw.buffer, miniFatRaw.byteOffset, miniFatRaw.byteLength);
    const miniFat = new Uint32Array(miniFatRaw.length / 4);
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = mdv.getUint32(i * 4, true);

    function readEntry(e) {
      if (e.size < miniCutoff) {
        const sectors = chain(e.start, miniFat);
        const out = new Uint8Array(sectors.length * miniSectorSize);
        sectors.forEach((s, i) => {
          const off = s * miniSectorSize;
          out.set(miniStream.subarray(off, off + miniSectorSize), i * miniSectorSize);
        });
        return out.subarray(0, e.size);
      }
      return readChain(e.start, e.size);
    }

    // 경로 맵 구성 (레드-블랙 트리 순회)
    const files = new Map();
    function walk(idx, prefix, seen) {
      if (idx === FREESECT || idx >= entries.length || seen.has(idx)) return;
      seen.add(idx);
      const e = entries[idx];
      walk(e.left, prefix, seen);
      walk(e.right, prefix, seen);
      const path = prefix + e.name;
      if (e.type === 2) files.set(path, e);
      else if (e.type === 1) walk(e.child, path + '/', seen);
    }
    walk(root.child, '', new Set());

    return {
      list: () => Array.from(files.keys()),
      has: (p) => files.has(p),
      read: (p) => (files.has(p) ? readEntry(files.get(p)) : null),
      rootClsid: root.clsid,
    };
  }

  // ---------- CFB 쓰기 ----------
  // streams: Map(path -> Uint8Array). 경로의 '/' 로 스토리지 구성. 512바이트 섹터, 4096 미만은 미니 스트림.
  function writeCFB(streams, rootClsid) {
    const SS = 512, MSS = 64, CUTOFF = 4096, NOSTREAM = 0xFFFFFFFF, FATSECT = 0xFFFFFFFD;
    const tree = { name: 'Root Entry', type: 5, kids: new Map(), data: null };
    for (const [path, data] of streams) {
      const parts = path.split('/');
      let node = tree;
      for (const p of parts.slice(0, -1)) {
        if (!node.kids.has(p)) node.kids.set(p, { name: p, type: 1, kids: new Map(), data: null });
        node = node.kids.get(p);
      }
      node.kids.set(parts[parts.length - 1], { name: parts[parts.length - 1], type: 2, kids: new Map(), data });
    }
    const cmp = (a, b) => (a.name.length - b.name.length) || (a.name.toUpperCase() < b.name.toUpperCase() ? -1 : a.name.toUpperCase() > b.name.toUpperCase() ? 1 : 0);
    const entries = [];
    (function add(n) { n.idx = entries.length; entries.push(n); [...n.kids.values()].sort(cmp).forEach(add); })(tree);
    // 형제 트리: 균형 이진 트리, 가장 깊은 단계만 빨강 → 유효한 레드-블랙 트리
    for (const e of entries) { e.left = e.right = NOSTREAM; e.color = 1; }
    for (const e of entries) {
      const kids = [...e.kids.values()].sort(cmp);
      const placed = [];
      const build = (arr, depth) => {
        if (!arr.length) return NOSTREAM;
        const m = arr.length >> 1, n = arr[m];
        n.depth = depth; placed.push(n);
        n.left = build(arr.slice(0, m), depth + 1);
        n.right = build(arr.slice(m + 1), depth + 1);
        return n.idx;
      };
      e.child = build(kids, 0);
      const maxd = Math.max(-1, ...placed.map((n) => n.depth));
      for (const n of placed) n.color = maxd > 0 && n.depth === maxd ? 0 : 1;
    }
    // 미니 스트림
    const miniParts = [], minifat = [];
    let miniLen = 0;
    for (const e of entries) {
      if (e.type !== 2 || e.data.length >= CUTOFF) continue;
      if (!e.data.length) { e.start = ENDOFCHAIN; continue; }
      const n = Math.ceil(e.data.length / MSS);
      e.start = minifat.length;
      for (let i = 0; i < n - 1; i++) minifat.push(minifat.length + 1);
      minifat.push(ENDOFCHAIN);
      const padded = new Uint8Array(n * MSS); padded.set(e.data);
      miniParts.push(padded); miniLen += padded.length;
    }
    const mini = new Uint8Array(miniLen);
    { let p = 0; for (const m of miniParts) { mini.set(m, p); p += m.length; } }
    // 일반 섹터
    const sectors = [], fat = [];
    const alloc = (b) => {
      if (!b || !b.length) return ENDOFCHAIN;
      const n = Math.ceil(b.length / SS), start = fat.length;
      for (let i = 0; i < n - 1; i++) fat.push(start + i + 1);
      fat.push(ENDOFCHAIN);
      for (let i = 0; i < n; i++) {
        const s = new Uint8Array(SS); s.set(b.subarray(i * SS, Math.min(b.length, (i + 1) * SS))); sectors.push(s);
      }
      return start;
    };
    for (const e of entries) if (e.type === 2 && e.data.length >= CUTOFF) e.start = alloc(e.data);
    tree.start = alloc(mini);
    tree.data = mini;
    let minifatStart = ENDOFCHAIN, minifatSectors = 0;
    if (minifat.length) {
      const words = Math.ceil(minifat.length / 128) * 128;
      const mf = new Uint8Array(words * 4);
      const v = new DataView(mf.buffer);
      for (let i = 0; i < words; i++) v.setUint32(i * 4, i < minifat.length ? minifat[i] : FREESECT, true);
      minifatSectors = words / 128;
      minifatStart = alloc(mf);
    }
    // 디렉터리
    const dirCount = Math.ceil(entries.length / 4) * 4;
    const dir = new Uint8Array(dirCount * 128);
    const dv = new DataView(dir.buffer);
    for (let i = 0; i < dirCount; i++) {
      const o = i * 128;
      const e = entries[i];
      if (!e) { dv.setUint32(o + 68, NOSTREAM, true); dv.setUint32(o + 72, NOSTREAM, true); dv.setUint32(o + 76, NOSTREAM, true); continue; }
      for (let k = 0; k < e.name.length; k++) dv.setUint16(o + k * 2, e.name.charCodeAt(k), true);
      dv.setUint16(o + 64, (e.name.length + 1) * 2, true);
      dir[o + 66] = e.type; dir[o + 67] = e.color;
      dv.setUint32(o + 68, e.left, true); dv.setUint32(o + 72, e.right, true); dv.setUint32(o + 76, e.child, true);
      if (e.type === 5 && rootClsid) dir.set(rootClsid.subarray(0, 16), o + 80);
      if (e.type !== 1) {
        dv.setUint32(o + 116, e.start, true);
        dv.setUint32(o + 120, e.data.length, true);
      }
    }
    const dirStart = alloc(dir);
    // FAT
    let nfat = 1;
    while (Math.ceil((fat.length + nfat) / 128) > nfat) nfat++;
    if (nfat > 109) throw new Error('파일이 너무 커서 저장할 수 없습니다.');
    const fatStart = fat.length;
    for (let i = 0; i < nfat; i++) fat.push(FATSECT);
    const fatBytes = new Uint8Array(nfat * SS);
    const fv = new DataView(fatBytes.buffer);
    for (let i = 0; i < nfat * 128; i++) fv.setUint32(i * 4, i < fat.length ? fat[i] : FREESECT, true);
    for (let i = 0; i < nfat; i++) sectors.push(fatBytes.subarray(i * SS, (i + 1) * SS));
    // 헤더
    const hdr = new Uint8Array(512);
    const hv = new DataView(hdr.buffer);
    hdr.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
    hv.setUint16(24, 0x3E, true); hv.setUint16(26, 3, true); hv.setUint16(28, 0xFFFE, true);
    hv.setUint16(30, 9, true); hv.setUint16(32, 6, true);
    hv.setUint32(44, nfat, true); hv.setUint32(48, dirStart, true);
    hv.setUint32(56, CUTOFF, true); hv.setUint32(60, minifatStart, true); hv.setUint32(64, minifatSectors, true);
    hv.setUint32(68, ENDOFCHAIN, true); hv.setUint32(72, 0, true);
    for (let i = 0; i < 109; i++) hv.setUint32(76 + i * 4, i < nfat ? fatStart + i : FREESECT, true);
    const out = new Uint8Array(512 + sectors.length * SS);
    out.set(hdr);
    sectors.forEach((s, i) => out.set(s, 512 + i * SS));
    return out;
  }

  async function deflateRaw(data) {
    const cs = new CompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------- ZIP 쓰기 ----------
  // entries: [{name, raw:{method, crc, usize, data(압축된 원본)}} | {name, data(새 내용), store?}]
  async function writeZIP(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const e of entries) {
      let method, crc, usize, cdata;
      if (e.raw) ({ method, crc, usize, data: cdata } = e.raw);
      else {
        crc = crc32(e.data); usize = e.data.length;
        if (e.store) { method = 0; cdata = e.data; } else { method = 8; cdata = await deflateRaw(e.data); }
      }
      const name = enc.encode(e.name);
      const lh = new Uint8Array(30 + name.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, method, true); lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, cdata.length, true); lv.setUint32(22, usize, true);
      lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
      lh.set(name, 30);
      const ch = new Uint8Array(46 + name.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, cdata.length, true); cv.setUint32(24, usize, true);
      cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
      ch.set(name, 46);
      parts.push(lh, cdata); central.push(ch);
      offset += lh.length + cdata.length;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    return new Blob([...parts, ...central, eocd]);
  }

  // ---------- ZIP ----------
  function parseZIP(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP(HWPX) 파일 형식이 아닙니다.');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = new Map();
    const dec = new TextDecoder('utf-8');
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const crc = dv.getUint32(p + 16, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      files.set(name, { method, crc, csize, usize, local });
      p += 46 + nameLen + extraLen + commentLen;
    }
    function rawData(f) {
      const lnl = dv.getUint16(f.local + 26, true);
      const lel = dv.getUint16(f.local + 28, true);
      const start = f.local + 30 + lnl + lel;
      return u8.subarray(start, start + f.csize);
    }
    async function read(name) {
      const f = files.get(name);
      if (!f) return null;
      const data = rawData(f);
      if (f.method === 0) return data;
      if (f.method === 8) return await decompress(data, 'deflate-raw');
      throw new Error('지원하지 않는 ZIP 압축 방식: ' + f.method);
    }
    return {
      list: () => Array.from(files.keys()),
      has: (n) => files.has(n),
      read,
      readText: async (n) => { const d = await read(n); return d ? dec.decode(d) : null; },
      raw: (n) => { const f = files.get(n); return f ? { method: f.method, crc: f.crc, usize: f.usize, data: rawData(f) } : null; },
    };
  }

  global.HwpContainer = { parseCFB, parseZIP, inflateRaw, deflateRaw, writeCFB, writeZIP, crc32 };
})(window);
