/* 실행 취소 / 다시 실행: 편집할 때마다 문서 모델(문단 목록, 문단 내용, 표 구조)의 스냅숏을 쌓고 되돌림 */
(function (global) {
  'use strict';

  const sameArr = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const CELL_KEYS = ['row', 'col', 'rowSpan', 'colSpan', 'w', 'h', 'borderFillId', 'valign'];
  const samePad = (a, b) => a === b || (!!a && !!b && sameArr(a, b));
  const sameCell = (c, s) => CELL_KEYS.every((k) => c[k] === s[k]) && samePad(c.pad, s.pad);

  // 문서 전체 상태를 기록. prev 와 같은 부분은 기록을 재사용해 메모리를 아낌
  function snapshot(doc, prev) {
    const paras = new Map(), tables = new Map(), lists = [];
    const old = prev || { paras: new Map(), tables: new Map(), listMap: new Map() };
    const listMap = new Map();

    const walkList = (list, table) => {
      if (listMap.has(list)) return;
      const o = old.listMap.get(list);
      const rec = o && sameArr(list, o.arr) ? o : { list, arr: list.slice(), table };
      listMap.set(list, rec);
      lists.push(rec);
      list.forEach(walkPara);
    };
    const walkPara = (p) => {
      if (paras.has(p)) return;
      const o = old.paras.get(p);
      paras.set(p, o && o.cs === p.cs && o.shape === p.shape && sameArr(p.items, o.items)
        ? o : { items: p.items.slice(), cs: p.cs, shape: p.shape });
      for (const it of p.items) {
        if (it.t === 'table') walkTable(it);
        else if (it.t === 'box' && it.paras) walkList(it.paras);
      }
    };
    const walkTable = (t) => {
      if (tables.has(t)) return;
      const o = old.tables.get(t);
      const same = o && o.rows === t.rows && o.cols === t.cols && sameArr(t.cells, o.cells)
        && o.props.every((s, i) => sameCell(t.cells[i], s));
      tables.set(t, same ? o : {
        rows: t.rows, cols: t.cols, cells: t.cells.slice(),
        props: t.cells.map((c) => {
          const s = {};
          CELL_KEYS.forEach((k) => { s[k] = c[k]; });
          s.pad = c.pad && c.pad.slice();
          return s;
        }),
      });
      for (const c of t.cells) walkList(c.paras, t);
    };

    for (const sec of doc.sections) {
      walkList(sec.paras);
      for (const f of sec.footnotes || []) walkList(f.paras);
    }
    return { paras, tables, lists, listMap };
  }

  // 스냅숏 상태로 되돌림. 실제로 바뀐 문단/표만 dirty 로 표시해 저장 시 다시 쓰이게 함
  function restore(snap) {
    for (const rec of snap.lists) {
      if (sameArr(rec.list, rec.arr)) continue;
      rec.list.splice(0, rec.list.length, ...rec.arr);
      if (rec.table) rec.table.dirty = true;
    }
    for (const [p, s] of snap.paras) {
      if (p.cs === s.cs && p.shape === s.shape && sameArr(p.items, s.items)) continue;
      p.items = s.items.slice();
      p.cs = s.cs;
      p.shape = s.shape;
      p.dirty = true;
    }
    for (const [t, s] of snap.tables) {
      const same = t.rows === s.rows && t.cols === s.cols && sameArr(t.cells, s.cells)
        && s.props.every((p, i) => sameCell(t.cells[i], p));
      if (same) continue;
      t.cells = s.cells.slice();
      t.rows = s.rows;
      t.cols = s.cols;
      t.cells.forEach((c, i) => {
        const p = s.props[i];
        CELL_KEYS.forEach((k) => { c[k] = p[k]; });
        c.pad = p.pad && p.pad.slice();
      });
      t.dirty = true;
    }
  }

  const LIMIT = 300;
  const TYPE_MERGE_MS = 1500;

  class History {
    init(doc) {
      this.doc = doc;
      this.origin = snapshot(doc);
      this.stack = [{ snap: this.origin, caret: null, origin: true }];
      this.index = 0;
      this.saved = 0;
      this.savedOrigin = true;
      this.last = null;
    }

    get canUndo() { return !!this.stack && this.index > 0; }
    get canRedo() { return !!this.stack && this.index < this.stack.length - 1; }
    get atOrigin() { return !this.stack || this.stack[this.index].origin; }
    get dirty() { return !!this.stack && this.index !== this.saved && !(this.atOrigin && this.savedOrigin); }

    // 편집 직후 호출. kind === 'type' 이면 같은 문단에서 이어지는 입력을 한 단계로 묶음
    record(caret, kind, origin) {
      if (!this.stack) return;
      const top = this.stack[this.index];
      const snap = snapshot(this.doc, top.snap);
      const now = Date.now();
      const merge = kind === 'type' && this.last && this.last.kind === 'type' && now - this.last.time < TYPE_MERGE_MS
        && this.index > 0 && this.index !== this.saved && !top.origin
        && caret && top.caret && caret.para === top.caret.para;
      const entry = { snap, caret, origin: !!origin };
      if (merge) this.stack[this.index] = entry;
      else {
        if (this.saved > this.index) this.saved = -1;
        this.stack.splice(this.index + 1);
        this.stack.push(entry);
        this.index++;
        if (this.stack.length > LIMIT) { this.stack.shift(); this.index--; this.saved--; }
      }
      this.last = { kind, time: now };
    }

    // 반환값: 커서를 둘 후보 위치 (앞쪽 우선)
    undo() {
      if (!this.canUndo) return null;
      const undone = this.stack[this.index];
      this.index--;
      restore(this.stack[this.index].snap);
      this.last = null;
      return [undone.caret, this.stack[this.index].caret];
    }

    redo() {
      if (!this.canRedo) return null;
      this.index++;
      restore(this.stack[this.index].snap);
      this.last = null;
      return [this.stack[this.index].caret];
    }

    // 파일을 처음 열었을 때 상태로. 이 동작도 실행 취소할 수 있도록 새 단계로 쌓음
    resetToOrigin() {
      if (!this.stack || this.atOrigin) return false;
      restore(this.origin);
      this.last = null;
      this.record(null, 'reset', true);
      return true;
    }

    markSaved(index) {
      if (!this.stack || index < 0 || index >= this.stack.length) return;
      this.saved = index;
      this.savedOrigin = this.stack[index].origin;
    }
  }

  global.HwpHistory = History;
})(window);
