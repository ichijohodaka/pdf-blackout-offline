/* ==========================================================================
 * 40 マスク編集（基準ページに矩形を置く）とマスク定義の保存・読み込み
 * ========================================================================== */

const Editor = {
  zoom: 1,          // 「幅に合わせる」を 1 としたときの倍率
  drag: null,
  baseToken: 0,
  baseCtl: null,
  BASE_WIDTH_PX: 2400, // 編集画面用に描画する幅（画面表示のみ）

  init() {
    const ov = Util.$('overlay');
    ov.addEventListener('pointerdown', (e) => Editor.onPointerDown(e));
    ov.addEventListener('pointermove', (e) => Editor.onPointerMove(e));
    ov.addEventListener('pointerup', (e) => Editor.onPointerUp(e, false));
    ov.addEventListener('pointercancel', (e) => Editor.onPointerUp(e, true));

    Util.$('btnPrevPage').addEventListener('click', () => Editor.setBasePage(state.baseIdx - 1));
    Util.$('btnNextPage').addEventListener('click', () => Editor.setBasePage(state.baseIdx + 1));
    Util.$('inPage').addEventListener('change', (e) => Editor.setBasePage(Math.round(Util.num(e.target.value, 1)) - 1));
    Util.$('btnZoomIn').addEventListener('click', () => Editor.setZoom(Editor.zoom * 1.25));
    Util.$('btnZoomOut').addEventListener('click', () => Editor.setZoom(Editor.zoom / 1.25));
    Util.$('btnFit').addEventListener('click', () => Editor.setZoom(1));
    Util.$('chkBlack').addEventListener('change', () => Editor.syncOverlay());
    Util.$('inGrow').addEventListener('change', () => App.changed());
    Util.$('btnUndo').addEventListener('click', () => Editor.undo());
    Util.$('btnRedo').addEventListener('click', () => Editor.redo());
    Util.$('btnSaveMask').addEventListener('click', () => MaskFile.save());
    Util.$('btnLoadMask').addEventListener('click', () => Util.$('fileMask').click());
    Util.$('fileMask').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) await MaskFile.load(f);
    });

    document.addEventListener('keydown', (e) => Editor.onKeyDown(e));
    Util.$('editScroller').addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return; // 通常のホイールはスクロール
      e.preventDefault();
      Editor.zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
    }, { passive: false });
    window.addEventListener('resize', () => Editor.applyZoom());
  },

  /* ---------- 履歴（元に戻す／やり直し） ---------- */
  snapshot() { return JSON.stringify({ rects: state.rects, adjust: state.adjust }); },

  pushUndo(snap) {
    state.undo.push(snap);
    if (state.undo.length > 200) state.undo.shift();
    state.redo = [];
  },

  restore(snap) {
    const o = JSON.parse(snap);
    state.rects = o.rects;
    state.adjust = o.adjust;
    if (!state.rects.some((r) => r.id === state.selectedId)) state.selectedId = null;
  },

  /** 履歴を戻す／進める。矩形が増えた場合は、増えた矩形を選択状態にする。 */
  travel(from, to) {
    if (!from.length) return;
    to.push(Editor.snapshot());
    const before = new Set(state.rects.map((r) => r.id));
    Editor.restore(from.pop());
    const added = state.rects.find((r) => !before.has(r.id));
    if (added) state.selectedId = added.id;
    App.changed();
  },

  undo() { Editor.travel(state.undo, state.redo); },
  redo() { Editor.travel(state.redo, state.undo); },

  /** 状態を変更する操作を履歴つきで行う */
  mutate(fn) {
    const snap = Editor.snapshot();
    fn();
    if (Editor.snapshot() !== snap) Editor.pushUndo(snap);
    App.changed();
  },

  /* ---------- 基準ページ ---------- */
  base() { return state.pages[state.baseIdx] || null; },
  find(id) { return state.rects.find((r) => r.id === id) || null; },
  sel() { return Editor.find(state.selectedId); },

  setBasePage(idx) {
    if (!state.pages.length) return;
    idx = Util.clamp(idx, 0, state.pages.length - 1);
    state.baseIdx = idx;
    Util.$('inPage').value = String(idx + 1);
    Editor.renderBase();
    Editor.syncAll();
  },

  async renderBase() {
    const my = ++Editor.baseToken;
    if (Editor.baseCtl) Editor.baseCtl.cancel();
    const ctl = Renderer.newCtl();
    Editor.baseCtl = ctl;
    const info = Editor.base();
    const box = Util.$('pageBox');
    if (!info) { box.hidden = true; Util.$('emptyEdit').hidden = false; return; }
    Util.$('emptyEdit').hidden = true;
    box.hidden = false;
    let tmp = null;
    try {
      tmp = await Renderer.renderPlain(info.idx, Editor.BASE_WIDTH_PX, ctl);
      if (my !== Editor.baseToken) { Util.releaseCanvas(tmp); return; }
      const cv = Util.$('editCanvas');
      cv.width = tmp.width;
      cv.height = tmp.height;
      cv.getContext('2d').drawImage(tmp, 0, 0);
      Util.releaseCanvas(tmp);
      Editor.applyZoom();
    } catch (e) {
      Util.releaseCanvas(tmp);
      if (e instanceof CancelledError) return;
      Util.$('loadStatus').textContent = '基準ページの表示に失敗しました: ' + e.message;
      Util.$('loadStatus').classList.add('err');
    }
  },

  /* ---------- ズーム ---------- */
  setZoom(z) {
    Editor.zoom = Util.clamp(z, 0.25, 6);
    Editor.applyZoom();
  },

  applyZoom() {
    const sc = Util.$('editScroller');
    const box = Util.$('pageBox');
    if (box.hidden || sc.clientWidth === 0) return;
    const fit = Math.max(200, sc.clientWidth - 26);
    box.style.width = Math.round(fit * Editor.zoom) + 'px';
    Util.$('lblZoom').textContent = Math.round(Editor.zoom * 100) + '%';
  },

  zoomAt(factor, cx, cy) {
    const sc = Util.$('editScroller');
    const box = Util.$('pageBox');
    if (box.hidden) return;
    const b = box.getBoundingClientRect();
    const rx = (cx - b.left) / b.width;
    const ry = (cy - b.top) / b.height;
    Editor.setZoom(Editor.zoom * factor);
    const nb = box.getBoundingClientRect();
    sc.scrollLeft += (nb.left + rx * nb.width) - cx;
    sc.scrollTop += (nb.top + ry * nb.height) - cy;
  },

  /* ---------- ポインタ操作 ---------- */
  relPoint(e) {
    const b = Util.$('overlay').getBoundingClientRect();
    return {
      x: Util.clamp((e.clientX - b.left) / b.width, 0, 1),
      y: Util.clamp((e.clientY - b.top) / b.height, 0, 1),
    };
  },

  onPointerDown(e) {
    if (e.button !== 0 || !state.pages.length) return;
    e.preventDefault();
    const handle = e.target.closest('.handle');
    const rectEl = e.target.closest('.rect');
    const pt = Editor.relPoint(e);
    Util.$('overlay').setPointerCapture(e.pointerId);
    const snap = Editor.snapshot();
    if (handle && Editor.sel()) {
      const r = Editor.sel();
      Editor.drag = { type: 'resize', h: handle.dataset.h, id: r.id, start: pt, orig: { ...r }, snap };
    } else if (rectEl) {
      const id = +rectEl.dataset.id;
      Editor.select(id);
      Editor.drag = { type: 'move', id, start: pt, orig: { ...Editor.find(id) }, snap };
    } else {
      Editor.select(null);
      Editor.drag = { type: 'create', start: pt, cur: pt, snap };
    }
  },

  onPointerMove(e) {
    const d = Editor.drag;
    if (!d) return;
    const pt = Editor.relPoint(e);
    const dx = pt.x - d.start.x;
    const dy = pt.y - d.start.y;
    if (d.type === 'move') {
      const r = Editor.find(d.id);
      if (!r) return;
      r.x = Util.clamp(d.orig.x + dx, 0, 1 - r.w);
      r.y = Util.clamp(d.orig.y + dy, 0, 1 - r.h);
    } else if (d.type === 'resize') {
      Editor.applyResize(d, dx, dy);
    } else {
      d.cur = pt;
      Editor.drawCreating(d);
    }
    Editor.syncOverlay();
    Editor.updateTable();
  },

  applyResize(d, dx, dy) {
    const r = Editor.find(d.id);
    if (!r) return;
    const o = d.orig;
    let l = o.x, t = o.y, rr = o.x + o.w, b = o.y + o.h;
    if (d.h.includes('w')) l += dx;
    if (d.h.includes('e')) rr += dx;
    if (d.h.includes('n')) t += dy;
    if (d.h.includes('s')) b += dy;
    l = Util.clamp(l, 0, 1); rr = Util.clamp(rr, 0, 1);
    t = Util.clamp(t, 0, 1); b = Util.clamp(b, 0, 1);
    const MIN = 0.002;
    r.x = Math.min(l, rr); r.w = Math.max(MIN, Math.abs(rr - l));
    r.y = Math.min(t, b);  r.h = Math.max(MIN, Math.abs(b - t));
    if (r.x + r.w > 1) r.x = 1 - r.w;
    if (r.y + r.h > 1) r.y = 1 - r.h;
  },

  drawCreating(d) {
    const x = Math.min(d.start.x, d.cur.x), y = Math.min(d.start.y, d.cur.y);
    const w = Math.abs(d.cur.x - d.start.x), h = Math.abs(d.cur.y - d.start.y);
    let el = Util.$('layerDraw').firstChild;
    if (!el) { el = Util.el('div', { class: 'drawing' }); Util.$('layerDraw').append(el); }
    Editor.place(el, { x, y, w, h });
  },

  onPointerUp(e, cancelled) {
    if (!Editor.drag) return;
    if (!cancelled) Editor.onPointerMove(e); // 離した位置まで反映する（直前の move が間引かれても取りこぼさない）
    const d = Editor.drag;
    Editor.drag = null;
    try { Util.$('overlay').releasePointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
    if (d.type === 'create') {
      Util.$('layerDraw').replaceChildren();
      const x = Math.min(d.start.x, d.cur.x), y = Math.min(d.start.y, d.cur.y);
      const w = Math.abs(d.cur.x - d.start.x), h = Math.abs(d.cur.y - d.start.y);
      if (!cancelled && w > 0.004 && h > 0.004) {
        const r = { id: state.nextId++, x, y, w, h };
        state.rects.push(r);
        state.selectedId = r.id;
        Editor.pushUndo(d.snap);
      }
    } else if (Editor.snapshot() !== d.snap) {
      Editor.pushUndo(d.snap);
    }
    App.changed();
  },

  /* ---------- キー操作 ---------- */
  active() {
    return !Util.$('paneEdit').hidden && !document.querySelector('dialog[open]');
  },

  onKeyDown(e) {
    if (!Editor.active()) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
      if (e.key === 'Enter' && t.tagName === 'INPUT') t.blur(); // 確定したらフォーカスを外し、Ctrl+Z を使えるようにする
      return;
    }
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); Editor.undo(); return; }
    if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); Editor.redo(); return; }
    const r = Editor.sel();
    if (!r) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      Editor.mutate(() => {
        state.rects = state.rects.filter((x) => x.id !== r.id);
        state.selectedId = null;
      });
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) {
      e.preventDefault();
      const p = Editor.base();
      const step = e.shiftKey ? 5 : 0.5; // mm
      Editor.mutate(() => {
        r.x = Util.clamp(r.x + arrows[e.key][0] * step / p.wMm, 0, 1 - r.w);
        r.y = Util.clamp(r.y + arrows[e.key][1] * step / p.hMm, 0, 1 - r.h);
      });
    }
  },

  select(id) {
    state.selectedId = id;
    Editor.syncOverlay();
    Editor.updateTable();
  },

  /* ---------- 描画の同期 ---------- */
  place(el, r) {
    el.style.left = (r.x * 100) + '%';
    el.style.top = (r.y * 100) + '%';
    el.style.width = (r.w * 100) + '%';
    el.style.height = (r.h * 100) + '%';
  },

  syncAll() {
    Editor.syncOverlay();
    Editor.updateTable();
    Editor.syncMeta();
  },

  syncMeta() {
    Util.$('btnUndo').disabled = !state.undo.length;
    Util.$('btnRedo').disabled = !state.redo.length;
    const n = state.pages.length;
    Util.$('lblPageCount').textContent = n ? `/ ${n}` : '';
    Util.$('inPage').max = String(Math.max(1, n));
    const p = Editor.base();
    Util.$('lblBase').textContent = p
      ? `基準ページ ${p.idx + 1}：${Paper.label(p.wMm, p.hMm)}（${p.wMm.toFixed(1)}×${p.hMm.toFixed(1)} mm）。` +
        'マスクは全ページ共通で、このページ上の位置が相対座標として保存されます。'
      : '';
    Util.$('pageBox').hidden = !p;
    Util.$('emptyEdit').hidden = !!p;
  },

  syncOverlay() {
    const p = Editor.base();
    const lr = Util.$('layerRect');
    const le = Util.$('layerEx');
    if (!p) { lr.replaceChildren(); le.replaceChildren(); return; }
    const grow = Settings.get().growMm;
    const black = Util.$('chkBlack').checked;
    lr.classList.toggle('black-mode', black);
    le.style.display = black ? '' : 'none';

    const ids = new Set(state.rects.map((r) => r.id));
    const have = new Map([...lr.children].map((el) => [+el.dataset.id, el]));
    const haveEx = new Map([...le.children].map((el) => [+el.dataset.id, el]));
    for (const [id, el] of have) if (!ids.has(id)) el.remove();
    for (const [id, el] of haveEx) if (!ids.has(id)) el.remove();

    state.rects.forEach((r, i) => {
      let el = have.get(r.id);
      if (!el) {
        el = Util.el('div', { class: 'rect', 'data-id': String(r.id) }, Util.el('span', { class: 'lbl' }));
        lr.append(el);
      }
      el.classList.toggle('selected', r.id === state.selectedId);
      el.firstChild.textContent = String(i + 1);
      Editor.place(el, r);
      const hs = el.querySelectorAll('.handle');
      if (r.id === state.selectedId && !hs.length) {
        for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
          el.append(Util.el('div', { class: 'handle', 'data-h': h }));
        }
      } else if (r.id !== state.selectedId && hs.length) {
        hs.forEach((h) => h.remove());
      }

      let ex = haveEx.get(r.id);
      if (!ex) { ex = Util.el('div', { class: 'rect-ex', 'data-id': String(r.id) }); le.append(ex); }
      const e = Geometry.expandRel(r, p.wMm, p.hMm, grow);
      const x0 = Math.max(0, e.x), y0 = Math.max(0, e.y);
      const x1 = Math.min(1, e.x + e.w), y1 = Math.min(1, e.y + e.h);
      Editor.place(ex, { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) });
    });
  },

  /* ---------- 矩形一覧（mm） ---------- */
  makeRow(r) {
    const tr = Util.el('tr', { 'data-id': String(r.id) }, Util.el('td'));
    for (const f of ['x', 'y', 'w', 'h']) {
      const inp = Util.el('input', { type: 'number', step: '0.1', 'data-f': f });
      inp.addEventListener('change', () => Editor.onNum(r.id, f, Util.num(inp.value, NaN)));
      tr.append(Util.el('td', null, inp));
    }
    tr.append(Util.el('td', null, Util.el('button', {
      type: 'button', class: 'btn sm', text: '削除', 'data-act': 'del',
      onclick: (ev) => {
        ev.stopPropagation();
        Editor.mutate(() => {
          state.rects = state.rects.filter((x) => x.id !== r.id);
          if (state.selectedId === r.id) state.selectedId = null;
        });
      },
    })));
    tr.addEventListener('click', () => Editor.select(r.id));
    return tr;
  },

  updateTable() {
    const body = Util.$('rectBody');
    const p = Editor.base();
    const W = p ? p.wMm : 0;
    const H = p ? p.hMm : 0;
    const rows = new Map([...body.children].map((tr) => [+tr.dataset.id, tr]));
    for (const [id, tr] of rows) {
      if (!state.rects.some((r) => r.id === id)) { tr.remove(); rows.delete(id); }
    }
    state.rects.forEach((r, i) => {
      let tr = rows.get(r.id);
      if (!tr) { tr = Editor.makeRow(r); rows.set(r.id, tr); }
      if (body.children[i] !== tr) body.insertBefore(tr, body.children[i] || null);
      tr.classList.toggle('sel', r.id === state.selectedId);
      tr.firstChild.textContent = String(i + 1);
      const vals = { x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H };
      for (const inp of tr.querySelectorAll('input')) {
        if (document.activeElement !== inp) inp.value = vals[inp.dataset.f].toFixed(1);
      }
    });
  },

  /** 数値欄（mm）の編集 */
  onNum(id, field, value) {
    const p = Editor.base();
    const r = Editor.find(id);
    if (!p || !r || !Number.isFinite(value)) { Editor.updateTable(); return; }
    Editor.mutate(() => {
      const W = p.wMm, H = p.hMm;
      const mm = { x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H };
      mm[field] = value;
      mm.x = Util.clamp(mm.x, 0, W - 0.5);
      mm.y = Util.clamp(mm.y, 0, H - 0.5);
      mm.w = Util.clamp(mm.w, 0.5, W - mm.x);
      mm.h = Util.clamp(mm.h, 0.5, H - mm.y);
      r.x = mm.x / W; r.y = mm.y / H; r.w = mm.w / W; r.h = mm.h / H;
    });
  },
};

/* ==========================================================================
 * マスク定義（JSON）の保存・読み込み。個人情報は含まない。
 * ========================================================================== */
const MaskFile = {
  FORMAT: 'pdf-blackout-mask',
  VERSION: 1,

  serialize() {
    const p = Editor.base();
    return JSON.stringify({
      format: MaskFile.FORMAT,
      version: MaskFile.VERSION,
      paperMm: p ? { w: +p.wMm.toFixed(2), h: +p.hMm.toFixed(2) } : null,
      rects: state.rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
    }, null, 2);
  },

  save() {
    Util.download(new Blob([MaskFile.serialize()], { type: 'application/json' }), 'mask-definition.json');
  },

  /** 検証つきで解釈する。不正なら Error（理由つき）。 */
  parse(text) {
    let o;
    try { o = JSON.parse(text); } catch (e) { throw new Error('JSON として読めません。'); }
    if (!o || o.format !== MaskFile.FORMAT) throw new Error('マスク定義のファイルではありません。');
    if (o.version !== MaskFile.VERSION) throw new Error(`未対応のバージョンです（${o.version}）。`);
    if (!Array.isArray(o.rects) || o.rects.length > 500) throw new Error('矩形の一覧が不正です。');
    const ok = (v) => typeof v === 'number' && Number.isFinite(v);
    const rects = o.rects.map((r, i) => {
      if (!r || !ok(r.x) || !ok(r.y) || !ok(r.w) || !ok(r.h)) throw new Error(`矩形 ${i + 1} の値が数値ではありません。`);
      if (r.x < 0 || r.y < 0 || r.x > 1 || r.y > 1) throw new Error(`矩形 ${i + 1} の位置が 0〜1 の範囲外です。`);
      if (r.w <= 0 || r.h <= 0 || r.w > 1 || r.h > 1) throw new Error(`矩形 ${i + 1} の幅・高さが不正です。`);
      if (r.x + r.w > 1 + 1e-6 || r.y + r.h > 1 + 1e-6) throw new Error(`矩形 ${i + 1} がページの外にはみ出しています。`);
      return { x: r.x, y: r.y, w: Math.min(r.w, 1 - r.x), h: Math.min(r.h, 1 - r.y) };
    });
    let paper = null;
    if (o.paperMm != null) {
      if (!ok(o.paperMm.w) || !ok(o.paperMm.h) || o.paperMm.w <= 0 || o.paperMm.h <= 0) throw new Error('用紙サイズの値が不正です。');
      paper = { w: o.paperMm.w, h: o.paperMm.h };
    }
    return { rects, paper };
  },

  async load(file) {
    let parsed;
    try {
      parsed = MaskFile.parse(await file.text());
    } catch (e) {
      const box = Util.$('maskWarn');
      box.hidden = false;
      box.className = 'warnbox danger';
      box.textContent = 'マスク定義を読み込めませんでした: ' + e.message;
      return;
    }
    Editor.mutate(() => {
      state.rects = parsed.rects.map((r) => ({ id: state.nextId++, ...r }));
      state.selectedId = null;
      for (const a of Object.values(state.adjust)) a.hidden = [];
    });
    state.maskPaper = parsed.paper;
    MaskFile.checkPaper();
  },

  /** 保存時の用紙サイズが今回の基準サイズと 2% を超えて違えば警告する。 */
  checkPaper() {
    const box = Util.$('maskWarn');
    const mp = state.maskPaper;
    if (!mp || !state.majority) { box.hidden = true; return; }
    const ref = state.majority.rep;
    const cur = { wMm: mp.w, hMm: mp.h };
    if (!Paper.differs(cur, ref)) { box.hidden = true; return; }
    const swapped = !Paper.differs({ wMm: mp.h, hMm: mp.w }, ref);
    box.hidden = false;
    box.className = 'warnbox';
    box.textContent =
      `読み込んだマスク定義の用紙サイズ（${Paper.label(mp.w, mp.h)}）が、今回の基準サイズ（${Paper.label(ref.wMm, ref.hMm)}）と異なります。` +
      (swapped ? '縦と横が入れ替わっています。' : '') +
      '同じ位置に隠したい内容がない可能性があるので、プレビューで確認してください。';
  },
};
