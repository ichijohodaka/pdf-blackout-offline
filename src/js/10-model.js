/* ==========================================================================
 * 10 用紙サイズ・座標モデル
 * ========================================================================== */

const Paper = {
  TOL: 0.02, // 2%
  // JIS 規格（B5 = 182×257、B4 = 257×364）
  NAMES: [['A5', 148, 210], ['A4', 210, 297], ['A3', 297, 420], ['B5', 182, 257], ['B4', 257, 364]],

  near(a, b) { return Math.abs(a - b) / b <= Paper.TOL; },

  /** 幅・高さのどちらかが 2% を超えて違えば true */
  differs(p, ref) {
    return Math.abs(p.wMm - ref.wMm) / ref.wMm > Paper.TOL ||
           Math.abs(p.hMm - ref.hMm) / ref.hMm > Paper.TOL;
  },

  label(wMm, hMm) {
    for (const [name, w, h] of Paper.NAMES) {
      if (Paper.near(wMm, w) && Paper.near(hMm, h)) return `${name} 縦`;
      if (Paper.near(wMm, h) && Paper.near(hMm, w)) return `${name} 横`;
    }
    return `${Math.round(wMm)}×${Math.round(hMm)} mm`;
  },

  /**
   * ページを 2% 以内で同じサイズごとにまとめ、最も多いものを基準サイズ（多数派）とする。
   * 同数なら先に現れたほう。基準と違うページを mismatch として返す。
   */
  analyze(pages) {
    const groups = [];
    for (const p of pages) {
      let g = groups.find((x) => !Paper.differs(p, x.rep));
      if (!g) { g = { rep: p, count: 0 }; groups.push(g); }
      g.count++;
    }
    let majority = null;
    for (const g of groups) if (!majority || g.count > majority.count) majority = g;
    const mismatch = majority ? pages.filter((p) => Paper.differs(p, majority.rep)).map((p) => p.idx) : [];
    return { groups, majority, mismatch };
  },
};

const Geometry = {
  EPS: 1e-6,

  /** 相対矩形を各辺 M mm だけ外側へ広げる（相対座標のまま。クランプはしない）。 */
  expandRel(rel, pageWmm, pageHmm, growMm) {
    const mx = growMm / pageWmm;
    const my = growMm / pageHmm;
    return { x: rel.x - mx, y: rel.y - my, w: rel.w + 2 * mx, h: rel.h + 2 * my };
  },

  /**
   * 相対矩形 → 整数画素矩形。M mm 拡大し、左・上は切り捨て、右・下は切り上げ（隠す側に丸める）、
   * 画像範囲内にクランプする。範囲が空なら null。
   *   fullW/fullH : ページ全体を描いたときの画素寸法
   *   view        : 一部だけ描いた canvas のとき {originX, originY, width, height}
   */
  toPixelRect(rel, page, growMm, fullW, fullH, view) {
    const e = Geometry.expandRel(rel, page.wMm, page.hMm, growMm);
    const ox = view ? view.originX : 0;
    const oy = view ? view.originY : 0;
    const vw = view ? view.width : Math.round(fullW);
    const vh = view ? view.height : Math.round(fullH);
    const x0 = Math.max(0, Math.floor(e.x * fullW - Geometry.EPS) - ox);
    const y0 = Math.max(0, Math.floor(e.y * fullH - Geometry.EPS) - oy);
    const x1 = Math.min(vw, Math.ceil((e.x + e.w) * fullW + Geometry.EPS) - ox);
    const y1 = Math.min(vh, Math.ceil((e.y + e.h) * fullH + Geometry.EPS) - oy);
    return (x1 > x0 && y1 > y0) ? { x0, y0, x1, y1 } : null;
  },

  /** そのページが、黒塗りを適用する「組内の位置」にあたるか */
  applies(page, N, positions) { return positions.has(page.pageInFile % N); },

  /** ページ個別補正を反映した、そのページの相対矩形一覧 */
  effectiveRects(idx) {
    const p = state.pages[idx];
    const adj = state.adjust[idx];
    const dx = adj ? adj.dx / p.wMm : 0;
    const dy = adj ? adj.dy / p.hMm : 0;
    const out = [];
    for (const r of state.rects) {
      if (adj && adj.hidden.includes(r.id)) continue;
      out.push({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
    }
    if (adj) for (const r of adj.extra) out.push({ x: r.x, y: r.y, w: r.w, h: r.h });
    return out;
  },

  /** そのページの画素矩形一覧。empty は範囲外などで空になった矩形の数。 */
  pageRects(idx, growMm, fullW, fullH, view) {
    const page = state.pages[idx];
    const rels = Geometry.effectiveRects(idx);
    const rects = [];
    let empty = 0;
    for (const r of rels) {
      const p = Geometry.toPixelRect(r, page, growMm, fullW, fullH, view);
      if (p) rects.push(p); else empty++;
    }
    return { rects, empty, expected: rels.length };
  },
};

/** ページ個別補正の補助 */
const Adjust = {
  ensure(idx) {
    if (!state.adjust[idx]) state.adjust[idx] = { dx: 0, dy: 0, extra: [], hidden: [] };
    return state.adjust[idx];
  },
  /** 何も補正がなければ削除して状態を軽くする */
  tidy(idx) {
    const a = state.adjust[idx];
    if (a && a.dx === 0 && a.dy === 0 && !a.extra.length && !a.hidden.length) delete state.adjust[idx];
  },
  any() { return Object.keys(state.adjust).length > 0; },
};
