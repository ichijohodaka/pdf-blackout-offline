/* ==========================================================================
 * 70 起動・ファイル読み込み・画面全体の調整
 * ========================================================================== */

const App = {
  loading: false,

  init() {
    PdfSource.init();
    Settings.rebuildPositions();
    Editor.init();
    Preview.init();
    PageDialog.init();
    Exporter.init();

    // 汎用の確認ダイアログ
    Util.$('cfOk').addEventListener('click', () => Util.$('dlgConfirm').close('ok'));
    Util.$('cfCancel').addEventListener('click', () => Util.$('dlgConfirm').close('cancel'));

    // ファイルの選択・ドロップ
    const input = Util.$('fileInput');
    Util.$('btnPick').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.value = '';
      await App.addFiles(files);
    });
    Util.$('btnClear').addEventListener('click', () => App.clearAll());
    const zone = Util.$('dropZone');
    // ページ全体で、ドロップによるファイルの表示（ページ遷移）を防ぐ
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      await App.addFiles([...e.dataTransfer.files]);
    });

    Util.$('inN').addEventListener('change', () => { Settings.rebuildPositions(); App.changed(); App.updateSummary(); });
    Util.$('btnSizeAck').addEventListener('click', () => {
      state.sizeAck = true;
      App.updateSummary();
      App.changed();
    });

    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => App.showTab(tab.dataset.pane));
    }
    App.showTab('paneEdit');
    App.changed();
  },

  showTab(paneId) {
    for (const tab of document.querySelectorAll('.tab')) {
      const on = tab.dataset.pane === paneId;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      Util.$(tab.dataset.pane).hidden = !on;
    }
    if (paneId === 'paneEdit') { Editor.applyZoom(); }
    if (paneId === 'panePreview') {
      Preview.dirty = true;
      Preview.refresh();
    }
    if (paneId === 'paneExport') Exporter.refreshState();
  },

  /** 矩形・設定・補正が変わったときに、画面全体を同期する */
  changed() {
    Editor.syncAll();
    Preview.onChanged();
    Exporter.refreshState();
  },

  refreshExportState() { Exporter.refreshState(); },

  setStatus(text, isError) {
    const el = Util.$('loadStatus');
    el.textContent = text;
    el.classList.toggle('err', !!isError);
  },

  /* ---------- ファイルの読み込み ---------- */
  async addFiles(list) {
    if (App.loading || state.exporting) return;
    const files = list.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) { App.setStatus('PDF ファイルが選ばれていません。', true); return; }
    if (Adjust.any() || state.confirmed.size) {
      const ok = await Util.askConfirm('ファイルを追加します',
        ['ページの番号が変わるため、ページ個別の補正と「確認済み」の印はリセットされます。'], '追加する');
      if (!ok) return;
    }
    App.loading = true;
    const errors = [];
    try {
      let n = 0;
      for (const f of files) {
        n++;
        const key = `${f.name}|${f.size}|${f.lastModified}`;
        if (state.files.some((x) => x.key === key)) continue;
        App.setStatus(`読み込み中 (${n}/${files.length}) ${f.name}`);
        await Util.tick();
        try {
          const pdf = await PdfSource.open(f);
          state.files.push({ key, name: f.name, size: f.size, pdf, numPages: pdf.numPages });
        } catch (e) {
          errors.push(`${f.name}: ${e && e.message ? e.message : e}`);
        }
      }
      state.files.sort((a, b) => Util.naturalCompare(a.name, b.name));
      await App.rebuildPages();
      if (state.files.length) {
        Util.$('workerMode').textContent = 'PDF 処理: ' + PdfSource.mode;
      }
    } finally {
      App.loading = false;
    }
    App.setStatus(errors.length ? '読み込めなかったファイルがあります: ' + errors.join(' / ') : `${state.pages.length} ページを読み込みました。`, errors.length > 0);
  },

  async rebuildPages() {
    state.pages = [];
    state.adjust = {};
    state.confirmed = new Set();
    state.sizeAck = false;
    let idx = 0;
    for (let fi = 0; fi < state.files.length; fi++) {
      const f = state.files[fi];
      for (let p = 1; p <= f.numPages; p++) {
        const page = await f.pdf.getPage(p);
        const vp = page.getViewport({ scale: 1 }); // 回転を反映した幅・高さ（pt）
        state.pages.push({
          idx,
          fileIdx: fi,
          fileName: f.name,
          pageInFile: p - 1,
          wPt: vp.width,
          hPt: vp.height,
          wMm: vp.width / 72 * 25.4,
          hMm: vp.height / 72 * 25.4,
        });
        idx++;
        if (idx % 20 === 0) { App.setStatus(`ページ情報を読み込み中… ${idx}`); await Util.tick(); }
      }
    }
    const an = Paper.analyze(state.pages);
    state.groups = an.groups;
    state.majority = an.majority;
    state.mismatch = an.mismatch;
    state.mismatchSet = new Set(an.mismatch);
    // 基準ページの既定: 基準サイズのページのうち最初のもの
    const first = state.pages.find((p) => !state.mismatchSet.has(p.idx));
    state.baseIdx = first ? first.idx : 0;
    Util.$('inPage').value = String(state.baseIdx + 1);

    App.renderFileList();
    App.updateSummary();
    Preview.build();
    MaskFile.checkPaper();
    Editor.renderBase();
    App.changed();
  },

  renderFileList() {
    const ol = Util.$('fileList');
    ol.replaceChildren();
    state.files.forEach((f, i) => {
      ol.append(Util.el('li', null,
        `${f.name}（${f.numPages} ページ・${Util.formatBytes(f.size)}）`,
        Util.el('button', { type: 'button', class: 'btn sm rm', text: '取り除く', onclick: () => App.removeFile(i) })));
    });
  },

  async removeFile(i) {
    if (App.loading || state.exporting) return;
    if (Adjust.any() || state.confirmed.size) {
      const ok = await Util.askConfirm('ファイルを取り除きます',
        ['ページの番号が変わるため、ページ個別の補正と「確認済み」の印はリセットされます。'], '取り除く');
      if (!ok) return;
    }
    const [f] = state.files.splice(i, 1);
    try { f.pdf.destroy(); } catch (e) { /* 無視 */ }
    await App.rebuildPages();
    App.setStatus(`${state.pages.length} ページ`);
  },

  async clearAll() {
    if (App.loading || state.exporting) return;
    if (Adjust.any() || state.confirmed.size) {
      const ok = await Util.askConfirm('すべてクリアします',
        ['読み込んだ PDF と、ページ個別の補正を破棄します。マスクの矩形は残ります。'], 'クリアする');
      if (!ok) return;
    }
    for (const f of state.files) { try { f.pdf.destroy(); } catch (e) { /* 無視 */ } }
    state.files = [];
    state.lastExport = null;
    Util.$('exportResult').hidden = true;
    Util.$('exportError').hidden = true;
    await App.rebuildPages();
    App.setStatus('');
  },

  /* ---------- 概要・警告 ---------- */
  updateSummary() {
    const box = Util.$('summary');
    const warn = Util.$('warnList');
    const sizeWarn = Util.$('sizeWarn');
    box.replaceChildren();
    warn.replaceChildren();
    warn.hidden = true;
    sizeWarn.hidden = true;
    if (!state.pages.length) return;

    const maj = state.majority;
    box.append(Util.el('div', { text: `全 ${state.pages.length} ページ（${state.files.length} ファイル）` }));
    const groups = [...state.groups].sort((a, b) => b.count - a.count);
    for (const g of groups) {
      const isBase = g === maj;
      box.append(Util.el('div', {
        text: `用紙サイズ: ${Paper.label(g.rep.wMm, g.rep.hMm)}　${g.count} ページ` + (isBase ? '（基準サイズ）' : ''),
      }));
    }

    if (state.mismatch.length) {
      if (!state.sizeAck) {
        sizeWarn.hidden = false;
        const parts = state.mismatch.slice(0, 40).map((i) => `${i + 1}（${Paper.label(state.pages[i].wMm, state.pages[i].hMm)}）`);
        Util.$('sizeWarnBody').textContent =
          `基準サイズ ${Paper.label(maj.rep.wMm, maj.rep.hMm)} と異なるページ（${state.mismatch.length} 枚）：ページ ` +
          Util.formatRanges(state.mismatch.map((i) => i + 1)) +
          (state.mismatch.length <= 40 ? `  内訳: ${parts.join('、')}` : '');
      } else {
        box.append(Util.el('div', { class: 'muted', text: `用紙サイズが基準と異なるページ ${state.mismatch.length} 枚は「このまま続ける」で承認済みです（プレビューで拡大して確認してください）。` }));
      }
    }

    const s = Settings.get();
    const bad = state.files.filter((f) => f.numPages % s.N !== 0);
    if (bad.length) {
      warn.hidden = false;
      warn.append(Util.el('p', { text: `1組のページ数 N=${s.N} の倍数でないファイルがあります（組内の位置がずれる可能性があります）：` }),
        Util.el('ul', null, ...bad.map((f) => Util.el('li', { text: `${f.name}（${f.numPages} ページ）` }))));
    }
  },
};

App.init();
