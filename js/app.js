/* 뷰어/편집기 UI */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const pagesEl = $('pages');
  const viewport = $('viewport');
  let zoom = 1;
  let pages = [];
  let objectUrls = [];
  let doc = null;
  let fileName = '';
  let editing = false;
  let dirty = false;
  let saveHandle = null;

  const history = new HwpHistory();
  const editor = new HwpEditor({
    container: pagesEl,
    onChange: (kind) => queueRecord(kind),
    onCellFocus: (table) => { $('tableTools').hidden = !(editing && table); },
  });
  editor.onSelection = updateFormatState;
  editor.onPainter = () => updatePainterUI();
  editor.onHistory = (op) => (op === 'undo' ? undo() : redo());

  // ---------- 실행 취소 / 다시 실행 ----------
  // 한 동작(예: 문단 나누기)에서 변경 알림이 여러 번 와도 한 단계로 기록되도록 모아서 처리
  let pending = null;
  function queueRecord(kind) {
    setDirty(true);
    if (pending) { if (kind !== 'type') pending.kind = null; return; }
    pending = { kind: kind === 'type' ? 'type' : null };
    queueMicrotask(flushRecord);
  }

  function flushRecord() {
    if (!pending) return;
    const kind = pending.kind;
    pending = null;
    history.record(editor.caretInfo(), kind);
    updateHistoryUI();
  }

  function updateHistoryUI() {
    $('undoBtn').disabled = !history.canUndo;
    $('redoBtn').disabled = !history.canRedo;
    $('resetBtn').disabled = history.atOrigin;
    setDirty(history.dirty);
  }

  function afterRestore(carets) {
    if (!carets) return;
    editor.stopPainter();
    render();
    editor.restoreCaret(carets);
    updateHistoryUI();
    updateFormatState();
  }

  function undo() {
    if (!doc || !editing) return;
    flushRecord();
    afterRestore(history.undo());
  }

  function redo() {
    if (!doc || !editing) return;
    flushRecord();
    afterRestore(history.redo());
  }

  function resetDoc() {
    if (!doc || !editing) return;
    flushRecord();
    if (history.atOrigin) return;
    if (!confirm('파일을 처음 열었을 때 상태로 모두 되돌릴까요?\n(실행 취소로 다시 복구할 수 있습니다)')) return;
    if (history.resetToOrigin()) afterRestore([]);
    viewport.scrollTop = 0;
  }

  function setDirty(v) {
    dirty = v;
    $('dirtyMark').hidden = !v;
    document.title = (v ? '● ' : '') + (fileName ? fileName + ' - ' : '') + 'HWP 뷰어';
  }

  function setZoom(z) {
    zoom = Math.min(4, Math.max(0.25, Math.round(z * 100) / 100));
    pagesEl.style.zoom = zoom;
    $('zoomReset').textContent = Math.round(zoom * 100) + '%';
  }

  function fitWidth() {
    if (!pages.length) return;
    const w = Math.max(...pages.map((p) => p.offsetWidth));
    setZoom((viewport.clientWidth - 48) / w);
  }

  function updatePageInfo() {
    if (!pages.length) { $('pageInfo').textContent = ''; return; }
    const mid = viewport.getBoundingClientRect().top + viewport.clientHeight / 3;
    let cur = 1;
    pages.forEach((p, i) => { if (p.getBoundingClientRect().top <= mid) cur = i + 1; });
    $('pageInfo').textContent = `${cur} / ${pages.length} 쪽`;
  }

  function render() {
    const top = viewport.scrollTop;
    const renderer = new HwpRenderer(doc, { editable: editing });
    pages = renderer.renderInto(pagesEl);
    editor.attach(doc, renderer);
    pagesEl.classList.toggle('editing', editing);
    viewport.scrollTop = top;
    updatePageInfo();
  }

  function setEditing(v) {
    editing = v;
    $('editBtn').setAttribute('aria-pressed', String(v));
    $('editBtn').classList.toggle('active', v);
    $('editBtn').textContent = v ? '편집 끝내기' : '편집';
    $('tableTools').hidden = true;
    $('editBar').hidden = !v;
    editor.stopPainter();
    render();
  }

  async function openFile(file) {
    if (!file) return;
    if (dirty && !confirm('저장하지 않은 변경 내용이 있습니다. 다른 문서를 열까요?')) return;
    $('empty').hidden = true;
    $('error').hidden = true;
    $('loading').hidden = false;
    pagesEl.innerHTML = '';
    pages = [];
    doc = null;
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls = [];
    fileName = file.name;
    saveHandle = null;
    editing = false;
    setDirty(false);
    $('fileName').textContent = file.name;
    ['editBtn', 'saveBtn', 'saveAsBtn', 'printBtn'].forEach((id) => { $(id).disabled = true; });
    try {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('이 브라우저는 압축 해제(DecompressionStream)를 지원하지 않습니다.\n최신 Chrome 또는 Edge를 사용하세요.');
      }
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
      if (head[0] === 0xD0 && head[1] === 0xCF) doc = await window.parseHWP(buf);
      else if (head[0] === 0x50 && head[1] === 0x4B) doc = await window.parseHWPX(buf);
      else if (/^<\?xml|^<HWPML/i.test(new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(64, buf.byteLength))).trim())) {
        throw new Error('HWPML(XML) 형식은 지원하지 않습니다. 한글에서 .hwp 또는 .hwpx 로 저장해 주세요.');
      } else throw new Error('HWP/HWPX 파일이 아닙니다. (한글 3.0 이하의 구버전 문서는 지원하지 않습니다)');

      objectUrls = Object.values(doc.images).map((i) => i.url).filter(Boolean);
      pending = null;
      history.init(doc);
      updateHistoryUI();
      $('fileName').textContent = `${file.name}  ·  ${doc.format}`;
      setEditing(false);
      ['editBtn', 'saveBtn', 'saveAsBtn', 'printBtn'].forEach((id) => { $(id).disabled = false; });
      viewport.scrollTop = 0;
      if (pages.length && pages[0].offsetWidth + 48 > viewport.clientWidth) fitWidth();
      updatePageInfo();
    } catch (e) {
      console.error(e);
      $('error').textContent = '문서를 열 수 없습니다.\n\n' + (e && e.message ? e.message : e);
      $('error').hidden = false;
    } finally {
      $('loading').hidden = true;
    }
  }

  async function save(asNew) {
    if (!doc) return;
    const active = document.activeElement && document.activeElement.closest && document.activeElement.closest('.hwp-p');
    if (active) editor.sync(active);
    flushRecord();
    const at = history.index;
    const isHwp = doc.source.kind === 'hwp';
    const ext = isHwp ? '.hwp' : '.hwpx';
    $('saveBtn').disabled = $('saveAsBtn').disabled = true;
    try {
      const blob = await (isHwp ? HwpWriter.save(doc) : HwpxWriter.save(doc));
      if (window.showSaveFilePicker) {
        if (!saveHandle || asNew) {
          saveHandle = await window.showSaveFilePicker({
            suggestedName: fileName || '문서' + ext,
            types: [{ description: isHwp ? '한글 문서 (*.hwp)' : '한글 문서 (*.hwpx)', accept: { 'application/octet-stream': [ext] } }],
          });
        }
        const w = await saveHandle.createWritable();
        await w.write(blob);
        await w.close();
        fileName = saveHandle.name;
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName || '문서' + ext;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      }
      $('fileName').textContent = `${fileName}  ·  ${doc.format}`;
      history.markSaved(at);
      setDirty(history.dirty);
      toast('저장했습니다: ' + fileName);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.error(e);
      alert('저장하지 못했습니다.\n\n' + (e && e.message ? e.message : e));
    } finally {
      $('saveBtn').disabled = $('saveAsBtn').disabled = false;
    }
  }

  let toastTimer = null;
  function toast(msg) {
    let t = $('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
  }

  $('fileInput').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
  $('zoomIn').onclick = () => setZoom(zoom + 0.1);
  $('zoomOut').onclick = () => setZoom(zoom - 0.1);
  $('zoomReset').onclick = () => setZoom(1);
  $('zoomFit').onclick = fitWidth;
  $('printBtn').onclick = () => window.print();
  $('editBtn').onclick = () => doc && setEditing(!editing);
  $('saveBtn').onclick = () => save(false);
  $('saveAsBtn').onclick = () => save(true);
  $('undoBtn').onclick = undo;
  $('redoBtn').onclick = redo;
  $('resetBtn').onclick = resetDoc;
  viewport.addEventListener('scroll', updatePageInfo, { passive: true });

  // ---------- 글자 서식 (크기/굵게/서식 복사) ----------
  function currentShape() {
    const cs = editor.currentCs();
    return cs == null || !doc ? null : doc.charShapes[cs] || null;
  }

  function updateFormatState() {
    const sh = currentShape();
    if (document.activeElement !== $('sizeInput')) $('sizeInput').value = sh ? Math.round(sh.size * 10) / 10 : '';
    $('boldBtn').classList.toggle('active', !!(sh && sh.bold));
  }

  function updatePainterUI() {
    const p = editor.painter;
    $('painterBtn').classList.toggle('active', !!p && p.type === 'text');
    $('cellPainterBtn').classList.toggle('active', !!p && p.type === 'cell');
    $('painterHint').hidden = !p;
    $('painterHint').textContent = !p ? '' : p.type === 'text'
      ? '서식을 적용할 글자를 드래그하세요 (Esc: 취소)'
      : '서식을 적용할 셀을 클릭하세요 (Esc: 취소)';
  }

  function setSize(v) {
    v = Math.round(Number(v) * 10) / 10;
    if (!(v >= 1 && v <= 200)) { updateFormatState(); return; }
    if (!editor.setCharFormat({ size: v })) toast('글자 크기를 바꿀 글자나 문단을 먼저 선택하세요.');
    updateFormatState();
  }

  function toggleBold() {
    const sh = currentShape();
    if (!editor.setCharFormat({ bold: !(sh && sh.bold) })) toast('굵게 할 글자나 문단을 먼저 선택하세요.');
    updateFormatState();
  }

  $('sizeInput').addEventListener('change', (e) => setSize(e.target.value));
  $('sizeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setSize(e.target.value); } });
  $('sizeUp').onclick = () => { const sh = currentShape(); if (sh) setSize(Math.floor(sh.size) + 1); };
  $('sizeDown').onclick = () => { const sh = currentShape(); if (sh) setSize(Math.max(1, Math.ceil(sh.size) - 1)); };
  $('boldBtn').onclick = toggleBold;
  $('painterBtn').onclick = () => {
    if (editor.painter && editor.painter.type === 'text') editor.stopPainter();
    else if (!editor.startTextPainter()) toast('서식을 복사할 글자를 먼저 클릭하세요.');
    updatePainterUI();
  };
  $('cellPainterBtn').onclick = () => {
    if (editor.painter && editor.painter.type === 'cell') editor.stopPainter();
    else if (!editor.startCellPainter()) toast('서식을 복사할 셀을 먼저 클릭하세요.');
    updatePainterUI();
  };

  // 편집 도구: 클릭해도 편집 커서가 사라지지 않도록 버튼의 mousedown 기본 동작을 막음
  $('editBar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('tableTools').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-op]');
    if (!b) return;
    if (b.dataset.op === 'tableDelete' && !confirm('이 표를 삭제할까요?')) return;
    editor.tableOp(b.dataset.op);
  });

  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); if (doc) save(e.shiftKey); }
    else if (k === 'e') { e.preventDefault(); if (doc) setEditing(!editing); }
    else if (k === 'b' && editing) { e.preventDefault(); toggleBold(); }
    else if ((k === 'z' || k === 'y') && editing && !e.altKey) {
      if (e.isComposing || e.target.tagName === 'INPUT') return; // 한글 조합 중 / 글자 크기 입력란은 기본 동작
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo(); else undo();
    }
    else if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(zoom + 0.1); }
    else if (e.key === '-') { e.preventDefault(); setZoom(zoom - 0.1); }
    else if (e.key === '0') { e.preventDefault(); setZoom(1); }
    else if (k === 'o') { e.preventDefault(); $('fileInput').click(); }
  });
  viewport.addEventListener('wheel', (e) => {
    if (e.ctrlKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); }
  }, { passive: false });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  // 드래그 앤 드롭 (파일만)
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').hidden = true;
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
  });

  window.__hwpApp = { get doc() { return doc; }, editor, history, save, openFile, setEditing, undo, redo, resetDoc };
})();
