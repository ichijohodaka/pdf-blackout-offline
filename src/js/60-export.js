/* ==========================================================================
 * 60 一括出力
 *   - 出力ガード（矩形0個・位置未選択・用紙サイズ警告・画素数上限）
 *   - ページを1枚ずつ「描画→黒塗り→検証→書き出し」し、ZIP に追加
 *   - 検証失敗・描画失敗・キャンセルのときは全体を中止し、ZIP も CSV も出さない
 * ========================================================================== */

const Exporter = {
  ctl: null,
  cancelRequested: false,

  init() {
    Util.$('btnExport').addEventListener('click', () => Exporter.run());
    Util.$('btnCancelExport').addEventListener('click', () => Exporter.cancel());
    Util.$('dlgProgress').addEventListener('cancel', (e) => e.preventDefault()); // Esc で閉じさせない
    for (const id of ['inDpi', 'inQuality', 'inPrefix']) Util.$(id).addEventListener('change', () => App.changed());
    Util.$('dlZip').addEventListener('click', () => {
      if (state.lastExport) Util.download(state.lastExport.zip, state.lastExport.zipName);
    });
    Util.$('dlCsv').addEventListener('click', () => {
      if (state.lastExport && state.lastExport.csv) Util.download(state.lastExport.csv, 'mapping.csv');
    });
  },

  /** 出力できない理由（blockers）と、始める前に確認する事項（warnings） */
  guards() {
    const blockers = [];
    const warnings = [];
    const s = Settings.get();
    if (!state.pages.length) {
      blockers.push('PDF が読み込まれていません。');
      return { blockers, warnings };
    }
    if (!state.rects.length) blockers.push('マスク用の矩形がありません（0個）。「マスク編集」で矩形を置いてください。');
    if (s.positions.size === 0) blockers.push('黒塗りを適用する組内の位置が1つも選ばれていません。');
    if (state.mismatch.length && !state.sizeAck) {
      blockers.push('用紙サイズが基準と異なるページがあります。「このまま続ける」を選ぶまで出力できません。');
    }
    const over = state.pages.filter((p) => Renderer.pixelCount(p, s.dpi) > Renderer.PIXEL_CAP).map((p) => p.idx + 1);
    if (over.length) {
      blockers.push(`解像度 ${s.dpi} DPI では画素数が上限（${Renderer.PIXEL_CAP / 1e6} メガ画素）を超えるページがあります` +
        `（ページ ${Util.formatRanges(over)}）。DPI を下げてください。`);
    }
    if (state.pages.length > 65535) blockers.push('ページ数が 65535 を超えています（ZIP の上限）。');

    // --- 始める前に確認する事項 ---
    const zero = [];
    for (const p of state.pages) {
      if (!Geometry.applies(p, s.N, s.positions)) continue;
      const size = Renderer.outputSize(p, s.dpi);
      const pr = Geometry.pageRects(p.idx, s.growMm, size.w, size.h);
      if (pr.empty > 0 || pr.rects.length === 0) zero.push(p.idx + 1);
    }
    if (zero.length) {
      warnings.push(`ページ ${Util.formatRanges(zero)}：ページ個別の補正などで、黒塗りされない（範囲外・除外された）矩形があります。`);
    }
    if (state.sizeAck && state.mismatch.length) {
      const unconfirmed = state.mismatch.filter((i) => !state.confirmed.has(i)).map((i) => i + 1);
      if (unconfirmed.length) {
        warnings.push(`ページ ${Util.formatRanges(unconfirmed)}：用紙サイズが基準と違い、プレビューで拡大して確認していません。`);
      }
    }
    for (const f of state.files) {
      if (f.numPages % s.N !== 0) {
        warnings.push(`「${f.name}」のページ数（${f.numPages}）が 1組のページ数 N=${s.N} の倍数ではありません。組内の位置がずれる可能性があります。`);
      }
    }
    return { blockers, warnings };
  },

  refreshState() {
    const { blockers } = Exporter.guards();
    const box = Util.$('exportBlock');
    box.hidden = blockers.length === 0;
    box.replaceChildren();
    if (blockers.length) {
      box.append(Util.el('p', { text: '次の理由で、まだ出力できません：' }),
        Util.el('ul', null, ...blockers.map((t) => Util.el('li', { text: t }))));
    }
    Util.$('btnExport').disabled = blockers.length > 0 || state.exporting;
  },

  cancel() {
    Exporter.cancelRequested = true;
    if (Exporter.ctl) Exporter.ctl.cancel();
    Util.$('progText').textContent = 'キャンセルしています…';
  },

  showError(title, detail) {
    const box = Util.$('exportError');
    box.hidden = false;
    box.replaceChildren(
      Util.el('p', null, Util.el('strong', { text: title })),
      Util.el('p', { text: detail }),
      Util.el('p', { text: 'ZIP も CSV も出力していません（途中までの結果は破棄しました）。' }));
  },

  async run() {
    const g = Exporter.guards();
    if (g.blockers.length || state.exporting) return;
    if (g.warnings.length) {
      const ok = await Util.askConfirm('次の点を確認してください', g.warnings, '承知して出力を始める');
      if (!ok) return;
    }

    // 前回の結果を破棄
    state.lastExport = null;
    Util.$('exportResult').hidden = true;
    Util.$('exportError').hidden = true;

    const s = Settings.get();
    const total = state.pages.length;
    const digits = Math.max(3, String(total).length);
    const zip = new Zip.Writer();
    const rows = [['出力ファイル名', '元ファイルの名前', '元ページ番号']]; // 対応表 CSV（s.csv のときだけ出力）
    let masked = 0;

    state.exporting = true;
    Exporter.cancelRequested = false;
    Exporter.refreshState();
    const dlg = Util.$('dlgProgress');
    Util.$('progBar').max = total;
    Util.$('progBar').value = 0;
    Util.$('progText').textContent = '準備しています…';
    dlg.showModal();
    let current = 0;

    try {
      for (let i = 0; i < total; i++) {
        current = i + 1;
        if (Exporter.cancelRequested) throw new CancelledError();
        Util.$('progText').textContent = `ページ ${i + 1} / ${total} を黒塗りして書き出しています…`;
        const ctl = Renderer.newCtl();
        Exporter.ctl = ctl;
        const res = await Renderer.renderMasked(i, { dpi: s.dpi, ctl });
        if (res.applied && res.rects.length > 0) masked++;
        let blob;
        try {
          blob = await Renderer.toBlob(res.canvas, s.quality);
        } finally {
          Util.releaseCanvas(res.canvas);
        }
        const name = `${s.prefix}${Util.pad(i + 1, digits)}.jpg`;
        await zip.addFile(name, blob);
        rows.push([name, state.pages[i].fileName, state.pages[i].pageInFile + 1]);
        Util.$('progBar').value = i + 1;
        await Util.tick();
      }
      const zipBlob = zip.finish();
      const csvBlob = s.csv ? Csv.build(rows) : null;
      state.lastExport = { zip: zipBlob, csv: csvBlob, zipName: 'masked_pages.zip' };
      Util.$('resTotal').textContent = `${total} 枚`;
      Util.$('resMasked').textContent = `${masked} 枚`;
      Util.$('resErrors').textContent = 'なし';
      Util.$('dlZip').textContent = `画像ZIPをダウンロード（${Util.formatBytes(zipBlob.size)}）`;
      Util.$('dlCsv').hidden = !s.csv;
      Util.$('resNote').textContent = s.csv
        ? 'ZIP にはマスク済みの画像だけが入っています（元のファイル名は含まれません）。対応表 CSV には元のファイル名とページ番号が入っているので、画像とは別に保管してください。'
        : 'ZIP にはマスク済みの画像だけが入っています（元のファイル名は含まれません）。対応表 CSV は作っていないため、出力画像と元のファイル名・ページ番号の対応は、あとから分かりません。';
      Util.$('exportResult').hidden = false;
    } catch (e) {
      zip.parts.length = 0; // 途中までの結果を破棄
      state.lastExport = null;
      if (e instanceof CancelledError) {
        Exporter.showError('キャンセルしました。', `ページ ${current} / ${total} の処理中に中止しました。`);
      } else if (e instanceof VerifyError) {
        Exporter.showError('黒塗りの検証に失敗したため、出力を中止しました。', e.message);
      } else {
        Exporter.showError(`ページ ${current} の処理に失敗したため、出力を中止しました。`, e && e.message ? e.message : String(e));
      }
    } finally {
      dlg.close();
      Exporter.ctl = null;
      state.exporting = false;
      Exporter.refreshState();
    }
  },
};
