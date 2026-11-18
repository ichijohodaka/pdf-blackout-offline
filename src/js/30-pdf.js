/* ==========================================================================
 * 30 PDF 読み込み・描画・黒塗り（復元不可能性の核心）
 *
 * 出力の手順（必ずこの順）:
 *   1. canvas を白で塗り、PDF ページをカラーのまま描画
 *   2. canvas 上の画素を黒 (#000) で直接塗りつぶす（fillRect）
 *   3. 矩形内の全画素が (0,0,0) であることを getImageData で検証（1画素でも違えば例外）
 *   4. その canvas から toBlob で JPEG にする
 * 元のベクトル・テキスト・レイヤーは出力に持ち込まない（画素だけの画像）。
 * ========================================================================== */

const PdfSource = {
  workerUrl: null,
  workerText: '',
  worker: null,        // 自前で作った Web Worker 用の pdfjsLib.PDFWorker（成功した場合）
  mode: '',            // 'Web Worker' | 'メインスレッド（代替方式）'
  prepared: null,

  /**
   * 埋め込んだワーカーのソース文字列から Blob URL を作る。
   * file:// では origin が 'null' になり、pdf.js 標準の起動（blob を importScripts で包む方式）が
   * 失敗して黙ってメインスレッド動作になるため、Worker を自前で作って pdf.js に渡す。
   */
  init() {
    PdfSource.workerText = Util.$('pdfjs-worker-src').textContent;
    PdfSource.workerUrl = URL.createObjectURL(new Blob([PdfSource.workerText], { type: 'text/javascript' }));
    pdfjsLib.GlobalWorkerOptions.workerSrc = PdfSource.workerUrl;
  },

  /** 最初の1回だけ、Web Worker を試し、だめならメインスレッド方式に切り替える。 */
  prepare() {
    if (!PdfSource.prepared) {
      PdfSource.prepared = (async () => {
        try {
          const port = new Worker(PdfSource.workerUrl);
          const w = new pdfjsLib.PDFWorker({ port });
          await Promise.race([
            w.promise,
            new Promise((_, rej) => setTimeout(() => rej(new Error('ワーカーの起動がタイムアウトしました')), 8000)),
          ]);
          PdfSource.worker = w;
          PdfSource.mode = 'Web Worker';
        } catch (e) {
          // 代替方式: ワーカーのスクリプトをメインスレッドで読み込む（pdfjsWorker が公開される）
          PdfSource.worker = null;
          const s = document.createElement('script');
          s.textContent = PdfSource.workerText;
          document.head.appendChild(s);
          PdfSource.mode = 'メインスレッド（代替方式）';
        }
      })();
    }
    return PdfSource.prepared;
  },

  /** File を開く。バイト列を data で渡す（url 指定は connect-src 'none' で止まる）。 */
  async open(file) {
    await PdfSource.prepare();
    const data = new Uint8Array(await file.arrayBuffer());
    const params = { data, isEvalSupported: false, verbosity: 0 };
    if (PdfSource.worker) params.worker = PdfSource.worker;
    const task = pdfjsLib.getDocument(params);
    return await task.promise;
  },
};

const Renderer = {
  PIXEL_CAP: 40e6, // 1ページの canvas の画素数の上限（40メガ画素）

  async page(info) {
    return state.files[info.fileIdx].pdf.getPage(info.pageInFile + 1);
  },

  /** 描画のキャンセル用ハンドル */
  newCtl() {
    return {
      cancelled: false,
      task: null,
      cancel() {
        this.cancelled = true;
        try { if (this.task) this.task.cancel(); } catch (e) { /* 無視 */ }
      },
    };
  },

  outputSize(info, dpi) {
    return { w: Math.max(1, Math.round(info.wPt * dpi / 72)), h: Math.max(1, Math.round(info.hPt * dpi / 72)) };
  },

  pixelCount(info, dpi) {
    const s = Renderer.outputSize(info, dpi);
    return s.w * s.h;
  },

  /** canvas を白で塗ってからページを描画する。 */
  async draw(pageProxy, canvas, viewport, ctl, transform) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (ctl && ctl.cancelled) throw new CancelledError();
    const task = pageProxy.render({
      canvasContext: ctx,
      viewport,
      background: 'rgb(255,255,255)',
      transform: transform || null,
    });
    if (ctl) ctl.task = task;
    try {
      await task.promise;
    } catch (e) {
      if ((ctl && ctl.cancelled) || (e && e.name === 'RenderingCancelledException')) throw new CancelledError();
      throw e;
    }
    return ctx;
  },

  /** 矩形を黒（#000）で直接塗りつぶす。 */
  fillBlack(ctx, rects) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    for (const r of rects) ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    ctx.restore();
  },

  /** 矩形内の全画素が (0,0,0,255) であることを検証する。違えば VerifyError。 */
  verifyBlack(ctx, rects, label) {
    for (const r of rects) {
      const w = r.x1 - r.x0;
      const h = r.y1 - r.y0;
      const d = ctx.getImageData(r.x0, r.y0, w, h).data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] !== 0 || d[i + 1] !== 0 || d[i + 2] !== 0 || d[i + 3] !== 255) {
          const n = i / 4;
          throw new VerifyError(`${label || ''}黒塗りの検証に失敗しました（画素 ${r.x0 + (n % w)}, ${r.y0 + Math.floor(n / w)}）。`);
        }
      }
    }
  },

  /**
   * 出力と同じ処理で、黒塗り・検証まで済ませた canvas を作る。
   * 一括出力と、プレビューの拡大表示の両方がこの関数を通る。
   */
  async renderMasked(idx, opts) {
    const dpi = opts.dpi;
    const ctl = opts.ctl || null;
    const info = state.pages[idx];
    const settings = Settings.get();
    const page = await Renderer.page(info);
    let canvas = null;
    try {
      const vp = page.getViewport({ scale: dpi / 72 });
      const { w, h } = Renderer.outputSize(info, dpi);
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      // 端数で1画素ずれないよう、描画結果が canvas にちょうど収まるように伸縮する
      const transform = [w / vp.width, 0, 0, h / vp.height, 0, 0];
      const ctx = await Renderer.draw(page, canvas, vp, ctl, transform);

      const applied = Geometry.applies(info, settings.N, settings.positions);
      let rects = [];
      let empty = 0;
      if (applied) {
        const pr = Geometry.pageRects(idx, settings.growMm, w, h);
        rects = pr.rects;
        empty = pr.empty;
        Renderer.fillBlack(ctx, rects);
        Renderer.verifyBlack(ctx, rects, `ページ ${idx + 1}: `);
      }
      return { canvas, ctx, rects, empty, applied, w, h };
    } catch (e) {
      Util.releaseCanvas(canvas);
      throw e;
    } finally {
      page.cleanup();
    }
  },

  /** マスクなしの縮小画像（画面表示用のみ）。幅 targetW px。 */
  async renderPlain(idx, targetW, ctl) {
    const info = state.pages[idx];
    const page = await Renderer.page(info);
    let canvas = null;
    try {
      const scale = targetW / info.wPt;
      const vp = page.getViewport({ scale });
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(vp.width));
      canvas.height = Math.max(1, Math.round(vp.height));
      await Renderer.draw(page, canvas, vp, ctl, [canvas.width / vp.width, 0, 0, canvas.height / vp.height, 0, 0]);
      return canvas;
    } catch (e) {
      Util.releaseCanvas(canvas);
      throw e;
    } finally {
      page.cleanup();
    }
  },

  /**
   * ページの一部（相対座標 box）だけを幅 targetW px で描く（矩形の周辺確認用）。
   * 返す canvas の _meta に、ページ全体を描いたときの寸法と切り出し位置を持たせる。
   */
  async renderCrop(idx, box, targetW, ctl) {
    const info = state.pages[idx];
    const page = await Renderer.page(info);
    let canvas = null;
    try {
      const scale = targetW / (box.w * info.wPt);
      const fullW = info.wPt * scale;
      const fullH = info.hPt * scale;
      const ox = Math.floor(box.x * fullW);
      const oy = Math.floor(box.y * fullH);
      const cw = Math.max(1, Math.ceil((box.x + box.w) * fullW) - ox);
      const ch = Math.max(1, Math.ceil((box.y + box.h) * fullH) - oy);
      const vp = page.getViewport({ scale, offsetX: -ox, offsetY: -oy });
      canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      await Renderer.draw(page, canvas, vp, ctl, null);
      canvas._meta = { fullW, fullH, originX: ox, originY: oy };
      return canvas;
    } catch (e) {
      Util.releaseCanvas(canvas);
      throw e;
    } finally {
      page.cleanup();
    }
  },

  /** canvas を JPEG（quality: 0〜1）にする。出力形式は JPEG のみ。 */
  toBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('画像の書き出しに失敗しました。'))),
        'image/jpeg',
        quality
      );
    });
  },
};
