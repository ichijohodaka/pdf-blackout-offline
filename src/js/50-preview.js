/* ==========================================================================
 * 50 全ページのプレビュー一覧と、ページの拡大表示（出力と同じ処理）・個別補正
 * ========================================================================== */

const Preview = {
  mode: 'full',        // 'full' | 'crop'
  cache: new Map(),    // idx -> マスクなしの縮小 canvas（画面表示専用。保存・出力はしない）
  tiles: [],           // {idx, el, canvas, cap, state}
  queue: [],
  running: 0,
  MAX: 2,
  gen: 0,              // 世代。モードや切り出し範囲が変わったら進める
  observer: null,
  dirty: false,
  cropBox: null,
  cropSig: '',
  THUMB_W: 220,
  CROP_W: 480,

  init() {
    Util.$('selPreviewMode').addEventListener('change', (e) => {
      Preview.mode = e.target.value === 'crop' ? 'crop' : 'full';
      Preview.resetAll();
    });
  },

  visible() { return !Util.$('panePreview').hidden; },

  /** ページ構成が変わったとき（ファイルの読み込み直し） */
  build() {
    Preview.clearCache();
    Preview.gen++;
    Preview.queue = [];
    if (Preview.observer) Preview.observer.disconnect();
    const grid = Util.$('thumbGrid');
    grid.replaceChildren();
    Preview.tiles = [];
    if (!state.pages.length) return;
    Preview.updateCropBox();
    Preview.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) Preview.request(+en.target.dataset.idx);
      }
    }, { rootMargin: '300px' });
    for (const p of state.pages) {
      const canvas = Util.el('canvas', { width: '10', height: '14' });
      const cap = Util.el('div', { class: 'cap' });
      const el = Util.el('button', { type: 'button', class: 'tile', 'data-idx': String(p.idx), onclick: () => PageDialog.open(p.idx) }, canvas, cap);
      grid.append(el);
      Preview.tiles.push({ idx: p.idx, el, canvas, cap, state: 'idle' });
      Preview.observer.observe(el);
    }
    Preview.updateCaptions();
  },

  clearCache() {
    for (const c of Preview.cache.values()) Util.releaseCanvas(c);
    Preview.cache.clear();
  },

  /** モードを切り替えた／切り出し範囲が変わった：作り直す */
  resetAll() {
    Preview.clearCache();
    Preview.gen++;
    Preview.queue = [];
    Preview.updateCropBox();
    for (const t of Preview.tiles) t.state = 'idle';
    // いま画面に見えているものを再度要求する
    if (Preview.visible() && Preview.observer) {
      for (const t of Preview.tiles) {
        const r = t.el.getBoundingClientRect();
        if (r.bottom > -300 && r.top < window.innerHeight + 300) Preview.request(t.idx);
      }
    }
  },

  /** 共通の矩形の周囲（M mm + 10 mm）を含む切り出し範囲（相対座標） */
  updateCropBox() {
    const p = Editor.base();
    if (!p || !state.rects.length) { Preview.cropBox = { x: 0, y: 0, w: 1, h: 1 }; return; }
    const m = Settings.get().growMm + 10;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const r of state.rects) {
      const e = Geometry.expandRel(r, p.wMm, p.hMm, m);
      x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y);
      x1 = Math.max(x1, e.x + e.w); y1 = Math.max(y1, e.y + e.h);
    }
    x0 = Util.clamp(x0, 0, 1); y0 = Util.clamp(y0, 0, 1);
    x1 = Util.clamp(x1, 0, 1); y1 = Util.clamp(y1, 0, 1);
    Preview.cropBox = { x: x0, y: y0, w: Math.max(0.05, x1 - x0), h: Math.max(0.05, y1 - y0) };
    if (Preview.cropBox.x + Preview.cropBox.w > 1) Preview.cropBox.x = 1 - Preview.cropBox.w;
    if (Preview.cropBox.y + Preview.cropBox.h > 1) Preview.cropBox.y = 1 - Preview.cropBox.h;
  },

  /** 矩形やマスク設定が変わった */
  onChanged() {
    Preview.dirty = true;
    if (Preview.visible()) Preview.refresh();
  },

  refresh() {
    if (!Preview.dirty || !state.pages.length) { Preview.dirty = false; return; }
    Preview.dirty = false;
    if (Preview.mode === 'crop') {
      const before = JSON.stringify(Preview.cropBox);
      Preview.updateCropBox();
      if (JSON.stringify(Preview.cropBox) !== before) { Preview.resetAll(); return; }
    }
    for (const idx of Preview.cache.keys()) Preview.paint(idx);
  },

  request(idx) {
    const t = Preview.tiles[idx];
    if (!t || t.state === 'loading' || t.state === 'done') return;
    t.state = 'loading';
    Preview.queue.push({ idx, gen: Preview.gen });
    Preview.pump();
  },

  pump() {
    while (Preview.running < Preview.MAX && Preview.queue.length) {
      const job = Preview.queue.shift();
      Preview.running++;
      Preview.renderTile(job).finally(() => { Preview.running--; Preview.pump(); });
    }
  },

  async renderTile(job) {
    const t = Preview.tiles[job.idx];
    try {
      let base = Preview.cache.get(job.idx);
      if (!base) {
        base = Preview.mode === 'crop'
          ? await Renderer.renderCrop(job.idx, Preview.cropBox, Preview.CROP_W, null)
          : await Renderer.renderPlain(job.idx, Preview.THUMB_W, null);
        if (job.gen !== Preview.gen) { Util.releaseCanvas(base); return; }
        Preview.cache.set(job.idx, base);
      }
      Preview.paint(job.idx);
      t.state = 'done';
    } catch (e) {
      if (job.gen === Preview.gen) {
        t.state = 'error';
        t.cap.textContent = `ページ ${job.idx + 1}: 描画エラー`;
      }
    }
  },

  /** キャッシュ済みの縮小画像に、出力と同じ幾何で黒塗りを当てて表示する */
  paint(idx) {
    const base = Preview.cache.get(idx);
    const t = Preview.tiles[idx];
    if (!base || !t) return;
    const c = t.canvas;
    c.width = base.width;
    c.height = base.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(base, 0, 0);
    const s = Settings.get();
    if (Geometry.applies(state.pages[idx], s.N, s.positions)) {
      const meta = base._meta;
      const fullW = meta ? meta.fullW : base.width;
      const fullH = meta ? meta.fullH : base.height;
      const view = meta ? { originX: meta.originX, originY: meta.originY, width: base.width, height: base.height } : null;
      const { rects } = Geometry.pageRects(idx, s.growMm, fullW, fullH, view);
      Renderer.fillBlack(ctx, rects);
    }
    Preview.updateCaption(idx);
  },

  caption(idx) {
    const p = state.pages[idx];
    let s = `ページ ${idx + 1}`;
    if (state.mismatchSet.has(idx)) {
      s += ` ⚠${Paper.label(p.wMm, p.hMm)} ` + (state.confirmed.has(idx) ? '確認済み' : '未確認');
    }
    return s;
  },

  updateCaption(idx) {
    const t = Preview.tiles[idx];
    if (!t) return;
    t.cap.textContent = Preview.caption(idx);
    t.el.classList.toggle('warn', state.mismatchSet.has(idx) && !state.confirmed.has(idx));
  },

  updateCaptions() { for (const t of Preview.tiles) Preview.updateCaption(t.idx); },
};

/* ==========================================================================
 * ページの拡大表示。出力と同じ関数（Renderer.renderMasked）・同じ DPI の結果を表示する。
 * ここでページ個別の補正（平行移動・矩形の追加と除外）ができる。
 * ========================================================================== */
const PageDialog = {
  idx: 0,
  ctl: null,
  token: 0,
  addMode: false,
  timer: null,
  drag: null,
  canvas: null,

  init() {
    const dlg = Util.$('dlgPage');
    Util.$('pdClose').addEventListener('click', () => dlg.close());
    Util.$('pdPrev').addEventListener('click', () => PageDialog.show(PageDialog.idx - 1));
    Util.$('pdNext').addEventListener('click', () => PageDialog.show(PageDialog.idx + 1));
    dlg.addEventListener('close', () => PageDialog.onClose());
    dlg.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); PageDialog.show(PageDialog.idx - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); PageDialog.show(PageDialog.idx + 1); }
    });
    Util.$('pdDx').addEventListener('change', () => PageDialog.onShift());
    Util.$('pdDy').addEventListener('change', () => PageDialog.onShift());
    Util.$('pdAdd').addEventListener('click', () => PageDialog.setAddMode(!PageDialog.addMode));
    Util.$('pdReset').addEventListener('click', () => {
      PageDialog.mutate(() => { delete state.adjust[PageDialog.idx]; });
    });
    const ov = Util.$('pdOverlay');
    ov.addEventListener('pointerdown', (e) => PageDialog.onPointerDown(e));
    ov.addEventListener('pointermove', (e) => PageDialog.onPointerMove(e));
    ov.addEventListener('pointerup', (e) => PageDialog.onPointerUp(e, false));
    ov.addEventListener('pointercancel', (e) => PageDialog.onPointerUp(e, true));
  },

  async open(idx) {
    Util.$('dlgPage').showModal();
    await PageDialog.show(idx);
  },

  onClose() {
    PageDialog.token++;
    if (PageDialog.ctl) PageDialog.ctl.cancel();
    clearTimeout(PageDialog.timer);
    Util.releaseCanvas(PageDialog.canvas);
    PageDialog.canvas = null;
    Util.$('pdCanvasHost').replaceChildren();
    PageDialog.setAddMode(false);
    Preview.updateCaptions();
    App.refreshExportState();
  },

  async show(idx) {
    if (idx < 0 || idx >= state.pages.length) return;
    PageDialog.idx = idx;
    PageDialog.setAddMode(false);
    PageDialog.syncPanel();
    await PageDialog.rerender();
  },

  mutate(fn) {
    Editor.mutate(() => { fn(); Adjust.tidy(PageDialog.idx); });
    PageDialog.syncPanel();
    PageDialog.scheduleRender();
  },

  onShift() {
    const idx = PageDialog.idx;
    const dx = Util.clamp(Util.num(Util.$('pdDx').value, 0), -50, 50);
    const dy = Util.clamp(Util.num(Util.$('pdDy').value, 0), -50, 50);
    PageDialog.mutate(() => { const a = Adjust.ensure(idx); a.dx = dx; a.dy = dy; });
  },

  syncPanel() {
    const idx = PageDialog.idx;
    const p = state.pages[idx];
    const a = state.adjust[idx];
    const s = Settings.get();
    Util.$('pdTitle').textContent = `ページ ${idx + 1} / ${state.pages.length}`;
    Util.$('pdInfo').textContent =
      `${Paper.label(p.wMm, p.hMm)}。` +
      (state.mismatchSet.has(idx) ? '基準サイズと異なるページです。' : '') +
      (Geometry.applies(p, s.N, s.positions) ? '' : 'このページ（組内の位置）には黒塗りを適用しません。');
    Util.$('pdDx').value = a ? String(a.dx) : '0';
    Util.$('pdDy').value = a ? String(a.dy) : '0';

    const box = Util.$('pdRects');
    box.replaceChildren();
    state.rects.forEach((r, i) => {
      const cb = Util.el('input', { type: 'checkbox' });
      cb.checked = !(a && a.hidden.includes(r.id));
      cb.addEventListener('change', () => {
        PageDialog.mutate(() => {
          const adj = Adjust.ensure(idx);
          adj.hidden = adj.hidden.filter((x) => x !== r.id);
          if (!cb.checked) adj.hidden.push(r.id);
        });
      });
      box.append(Util.el('label', null, cb, ` 矩形 ${i + 1} を適用する`));
    });
    if (a) {
      a.extra.forEach((r, i) => {
        box.append(Util.el('div', { class: 'ex' },
          Util.el('span', { text: `追加した矩形 ${i + 1}` }),
          Util.el('button', {
            type: 'button', class: 'btn sm', text: '削除',
            onclick: () => PageDialog.mutate(() => {
              const adj = Adjust.ensure(idx);
              adj.extra = adj.extra.filter((x) => x.id !== r.id);
            }),
          })));
      });
    }
    Util.$('pdAdd').textContent = PageDialog.addMode ? '追加をやめる' : 'このページだけ矩形を追加（ドラッグ）';
  },

  setAddMode(on) {
    PageDialog.addMode = on;
    Util.$('pdOverlay').classList.toggle('on', on);
    if (Util.$('pdAdd')) Util.$('pdAdd').textContent = on ? '追加をやめる' : 'このページだけ矩形を追加（ドラッグ）';
  },

  scheduleRender() {
    clearTimeout(PageDialog.timer);
    PageDialog.timer = setTimeout(() => PageDialog.rerender(), 150);
  },

  async rerender() {
    const my = ++PageDialog.token;
    if (PageDialog.ctl) PageDialog.ctl.cancel();
    const ctl = Renderer.newCtl();
    PageDialog.ctl = ctl;
    const idx = PageDialog.idx;
    const info = state.pages[idx];
    const st = Util.$('pdStatus');
    st.style.color = '';
    st.textContent = '描画中…';
    let dpi = Settings.get().dpi;
    const px = Renderer.pixelCount(info, dpi);
    if (px > Renderer.PIXEL_CAP) dpi = Math.max(36, Math.floor(dpi * Math.sqrt(Renderer.PIXEL_CAP / px)));
    try {
      const res = await Renderer.renderMasked(idx, { dpi, ctl });
      if (my !== PageDialog.token) { Util.releaseCanvas(res.canvas); return; }
      Util.releaseCanvas(PageDialog.canvas);
      PageDialog.canvas = res.canvas;
      Util.$('pdCanvasHost').replaceChildren(res.canvas);
      state.confirmed.add(idx);
      st.textContent = `出力と同じ処理で描画しました（${res.w}×${res.h} px・${dpi} DPI・黒塗り ${res.rects.length} 箇所・検証済み）` +
        (res.applied ? '' : '（このページはマスク対象外）');
      Preview.updateCaption(idx);
      App.refreshExportState();
    } catch (e) {
      if (e instanceof CancelledError || my !== PageDialog.token) return;
      st.style.color = 'var(--danger)';
      st.textContent = '描画に失敗しました: ' + e.message;
    }
  },

  /* ---- このページだけ矩形を追加（ドラッグ） ---- */
  relPoint(e) {
    const b = Util.$('pdOverlay').getBoundingClientRect();
    return { x: Util.clamp((e.clientX - b.left) / b.width, 0, 1), y: Util.clamp((e.clientY - b.top) / b.height, 0, 1) };
  },

  onPointerDown(e) {
    if (!PageDialog.addMode || e.button !== 0) return;
    e.preventDefault();
    Util.$('pdOverlay').setPointerCapture(e.pointerId);
    const pt = PageDialog.relPoint(e);
    PageDialog.drag = { start: pt, cur: pt };
  },

  onPointerMove(e) {
    const d = PageDialog.drag;
    if (!d) return;
    d.cur = PageDialog.relPoint(e);
    const ov = Util.$('pdOverlay');
    let el = ov.firstChild;
    if (!el) { el = Util.el('div', { class: 'drawing' }); ov.append(el); }
    Editor.place(el, {
      x: Math.min(d.start.x, d.cur.x), y: Math.min(d.start.y, d.cur.y),
      w: Math.abs(d.cur.x - d.start.x), h: Math.abs(d.cur.y - d.start.y),
    });
  },

  onPointerUp(e, cancelled) {
    const d = PageDialog.drag;
    if (!d) return;
    PageDialog.drag = null;
    try { Util.$('pdOverlay').releasePointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
    Util.$('pdOverlay').replaceChildren();
    const x = Math.min(d.start.x, d.cur.x), y = Math.min(d.start.y, d.cur.y);
    const w = Math.abs(d.cur.x - d.start.x), h = Math.abs(d.cur.y - d.start.y);
    if (cancelled || w < 0.004 || h < 0.004) return;
    const idx = PageDialog.idx;
    PageDialog.setAddMode(false);
    PageDialog.mutate(() => { Adjust.ensure(idx).extra.push({ id: state.nextId++, x, y, w, h }); });
  },
};
