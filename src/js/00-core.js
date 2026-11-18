'use strict';
/* ==========================================================================
 * PDF 黒塗りツール  アプリ本体
 *   00 共通・状態   10 用紙/座標モデル   20 ZIP/CSV   30 PDF読み込み・描画・黒塗り
 *   40 マスク編集   50 プレビュー・ページ拡大   60 出力   70 起動
 * 状態は JS のメモリ上にのみ持つ（localStorage / IndexedDB は使わない）。
 * ========================================================================== */

class CancelledError extends Error {
  constructor(msg) { super(msg || 'キャンセルされました'); this.name = 'CancelledError'; }
}
class VerifyError extends Error {
  constructor(msg) { super(msg); this.name = 'VerifyError'; }
}

const Util = {
  $(id) { return document.getElementById(id); },

  /** 要素を作る。文字列は textContent 扱い（ファイル名などを HTML として解釈しない）。 */
  el(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (v === true) e.setAttribute(k, '');
        else if (v !== false && v != null) e.setAttribute(k, v);
      }
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  },

  collator: new Intl.Collator('ja', { numeric: true }),
  naturalCompare(a, b) { return Util.collator.compare(a, b); },

  clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); },
  num(v, fallback) { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; },
  pad(n, digits) { return String(n).padStart(digits, '0'); },

  /** [1,2,3,5] -> "1–3, 5" */
  formatRanges(nums) {
    const a = [...nums].sort((x, y) => x - y);
    const out = [];
    let i = 0;
    while (i < a.length) {
      let j = i;
      while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
      out.push(j > i ? `${a[i]}–${a[j]}` : `${a[i]}`);
      i = j + 1;
    }
    return out.join(', ');
  },

  formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  },

  /** Blob をダウンロードさせる（ユーザー操作のクリックから呼ぶこと）。 */
  download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = Util.el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },

  /** 確認ダイアログ。OK なら true。 */
  askConfirm(title, lines, okLabel) {
    return new Promise((resolve) => {
      const dlg = Util.$('dlgConfirm');
      Util.$('cfTitle').textContent = title;
      Util.$('cfBody').replaceChildren(...lines.map((t) => Util.el('li', { text: t })));
      Util.$('cfOk').textContent = okLabel || '続ける';
      dlg.returnValue = '';
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      dlg.showModal();
    });
  },

  tick() { return new Promise((r) => setTimeout(r, 0)); },

  releaseCanvas(c) { if (c) { c.width = 0; c.height = 0; } },
};

/* ---- 状態（メモリのみ） ---- */
const state = {
  files: [],        // {key, name, size, pdf, numPages}（自然順）
  pages: [],        // {idx, fileIdx, fileName, pageInFile, wPt, hPt, wMm, hMm}
  baseIdx: 0,       // マスクを置く基準ページ
  groups: [],       // 用紙サイズのグループ
  majority: null,   // 基準サイズ（多数派）
  mismatch: [],     // 基準サイズと違うページ idx
  mismatchSet: new Set(),
  sizeAck: false,   // 「このまま続ける」を選んだか
  confirmed: new Set(), // 拡大表示で確認したページ idx
  rects: [],        // {id, x, y, w, h}  すべて 0〜1 の相対座標
  nextId: 1,
  selectedId: null,
  adjust: {},       // pageIdx -> {dx, dy, extra:[{id,x,y,w,h}], hidden:[rectId]}
  undo: [],
  redo: [],
  maskPaper: null,  // 読み込んだマスク定義の保存時の用紙サイズ {w,h}（mm）
  exporting: false,
  lastExport: null, // {zip, csv, zipName}
};

/* ---- 設定（入力欄から読む） ---- */
const Settings = {
  lastN: 1,

  sanitizePrefix(s) {
    let t = String(s).replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '');
    while (t.includes('..')) t = t.replace(/\.\./g, '.');
    return t;
  },

  get() {
    const N = Util.clamp(Math.round(Util.num(Util.$('inN').value, 1)), 1, 20);
    const positions = new Set(
      [...document.querySelectorAll('#posBox input:checked')].map((i) => +i.value).filter((k) => k < N)
    );
    return {
      N,
      positions,
      growMm: Util.clamp(Util.num(Util.$('inGrow').value, 1), 0, 30),
      dpi: Util.clamp(Math.round(Util.num(Util.$('inDpi').value, 300)), 72, 300),
      quality: Util.clamp(Util.num(Util.$('inQuality').value, 0.92), 0.1, 1),
      prefix: Settings.sanitizePrefix(Util.$('inPrefix').value),
      csv: Util.$('chkCsv').checked,
    };
  },

  /** N に合わせて「組内の位置」のチェックボックスを作り直す。既存の選択は保つ。 */
  rebuildPositions() {
    const N = Util.clamp(Math.round(Util.num(Util.$('inN').value, 1)), 1, 20);
    const box = Util.$('posBox');
    const prev = new Set([...box.querySelectorAll('input:checked')].map((i) => +i.value));
    const had = box.children.length > 0;
    box.replaceChildren();
    for (let k = 0; k < N; k++) {
      const checked = !had || k >= Settings.lastN || prev.has(k);
      const cb = Util.el('input', { type: 'checkbox', value: String(k) });
      cb.checked = checked;
      cb.addEventListener('change', () => App.changed());
      box.append(Util.el('label', null, cb, ` ${k + 1}ページ目`));
    }
    Settings.lastN = N;
  },
};
