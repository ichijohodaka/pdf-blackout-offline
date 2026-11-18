"""100ページ（A4・スキャン風・約 100〜200MB）の処理時間とメモリの確認。

    uv run --with playwright,pillow,numpy,psutil python tests/e2e_big.py <100ページPDF> [--channel msedge|chrome]

- キャンセルで ZIP・CSV が出ないこと
- 一括出力が時間内（5分以内）に終わること
- ブラウザ全体のメモリがページ数に比例して増え続けないこと（ピークと推移を表示）
- 出力画像の抜き取り検査（矩形内が黒・外が残る）
"""
import io
import sys
import threading
import time
import zipfile
from pathlib import Path

import numpy as np
import psutil
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "pdf-blackout.html"
PDF = Path(sys.argv[1]).resolve()
CHANNEL = sys.argv[sys.argv.index("--channel") + 1] if "--channel" in sys.argv else "msedge"
LIMIT_SEC = 300
RECT = dict(x=0.04, y=0.035, w=0.58, h=0.125)

results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("  OK  " if cond else "  NG  ") + name + (f"  [{detail}]" if detail else ""))


class MemSampler(threading.Thread):
    """起動したブラウザのプロセス群の RSS 合計を 1 秒ごとに記録する。"""

    def __init__(self, t0):
        super().__init__(daemon=True)
        self.t0 = t0
        self.samples = []  # (経過秒, RSS MB)
        self.stop = False

    def run(self):
        while not self.stop:
            total = 0
            for p in psutil.process_iter(["name", "create_time", "memory_info"]):
                try:
                    if (p.info["name"] or "").lower() in ("msedge.exe", "chrome.exe") and p.info["create_time"] >= self.t0 - 2:
                        total += p.info["memory_info"].rss
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            self.samples.append((time.time() - self.t0, total / 1024 / 1024))
            time.sleep(1.0)


def main():
    size_mb = PDF.stat().st_size / 1024 / 1024
    print(f"入力: {PDF.name}  {size_mb:.0f} MB")
    t_launch = time.time()
    sampler = MemSampler(t_launch)
    sampler.start()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel=CHANNEL, headless=True)
        ctx = browser.new_context(accept_downloads=True, viewport={"width": 1500, "height": 950})
        ctx.set_offline(True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(HTML.as_uri())

        t = time.time()
        page.set_input_files("#fileInput", str(PDF))
        page.wait_for_function("() => !App.loading && state.pages.length === 100", timeout=300000)
        print(f"   読み込み {time.time() - t:.1f} 秒")
        check("100 ページを読み込めた（A4 縦）", "A4 縦" in page.inner_text("#summary") and page.is_hidden("#sizeWarn"))
        page.wait_for_function("() => document.getElementById('editCanvas').width > 100", timeout=60000)
        page.wait_for_timeout(500)

        box = page.locator("#overlay").bounding_box()
        page.mouse.move(box["x"] + RECT["x"] * box["width"], box["y"] + RECT["y"] * box["height"])
        page.mouse.down()
        page.mouse.move(box["x"] + (RECT["x"] + RECT["w"]) * box["width"], box["y"] + (RECT["y"] + RECT["h"]) * box["height"], steps=8)
        page.mouse.up()
        rect = page.evaluate("state.rects[0]")
        s = page.evaluate("Settings.get()")
        GROW_MM = s["growMm"]  # 画面の既定値（黒塗り拡大）
        check("既定値が 300 DPI・黒塗り拡大 1mm", s["dpi"] == 300 and GROW_MM == 1, str(s))

        # --- プレビュー一覧を開く（遅延描画で重くならないこと） ---
        t = time.time()
        page.click("#tabPreview")
        page.wait_for_function("() => [...document.querySelectorAll('.tile canvas')].filter(c => c.width > 50).length >= 8", timeout=120000)
        n_done = page.evaluate("[...document.querySelectorAll('.tile canvas')].filter(c => c.width > 50).length")
        print(f"   プレビュー: 最初の {n_done} 枚まで {time.time() - t:.1f} 秒")
        check("プレビューは見えている分だけ遅延描画される（100枚すべては描かない）", n_done < 100, str(n_done))

        # --- キャンセル ---
        page.click("#tabExport")
        page.click("#btnExport")
        page.wait_for_function("() => document.getElementById('dlgProgress').open || document.getElementById('dlgConfirm').open", timeout=30000)
        if page.evaluate("document.getElementById('dlgConfirm').open"):
            page.click("#cfOk")
        page.wait_for_function("() => document.getElementById('progBar').value >= 2", timeout=120000)
        page.click("#btnCancelExport")
        page.wait_for_function("() => !document.getElementById('exportError').hidden", timeout=60000)
        err = page.inner_text("#exportError")
        check("キャンセルすると中止され、ZIP・CSV が出ない", "キャンセル" in err and page.is_hidden("#exportResult") and page.evaluate("state.lastExport") is None, err[:80])

        # --- 全ページ出力 ---
        t = time.time()
        page.click("#btnExport")
        page.wait_for_function("() => document.getElementById('dlgProgress').open || document.getElementById('dlgConfirm').open", timeout=30000)
        if page.evaluate("document.getElementById('dlgConfirm').open"):
            page.click("#cfOk")
        prog = []
        while True:
            st = page.evaluate("""() => ({
                done: !document.getElementById('exportResult').hidden,
                err: !document.getElementById('exportError').hidden,
                val: document.getElementById('progBar').value,
                heap: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0 })""")
            prog.append((time.time() - t, st["val"], st["heap"]))
            if st["done"] or st["err"]:
                break
            if time.time() - t > LIMIT_SEC + 120:
                break
            time.sleep(1.0)
        t_done = time.time()
        elapsed = t_done - t
        print(f"   一括出力 {elapsed:.1f} 秒（{elapsed / 100:.2f} 秒/ページ）")
        check(f"100 ページの一括出力が {LIMIT_SEC} 秒以内に完了", st["done"] and elapsed <= LIMIT_SEC, f"{elapsed:.0f}s")
        if st["done"]:
            with page.expect_download() as d:
                page.click("#dlZip")
            zp = Path(d.value.path())
            print(f"   ZIP {zp.stat().st_size / 1024 / 1024:.1f} MB")
            with zipfile.ZipFile(zp) as z:
                check("ZIP が壊れていない", z.testzip() is None)
                names = z.namelist()
                check("100 枚・連番", names == [f"page_{i + 1:03d}.jpg" for i in range(100)])
                bad = 0
                for n in names[::9] + names[-1:]:
                    a = np.asarray(Image.open(io.BytesIO(z.read(n))).convert("RGB"))
                    h, w = a.shape[:2]
                    mx, my = GROW_MM / 210, GROW_MM / 297
                    x0 = int(np.floor((rect["x"] - mx) * w)); x1 = int(np.ceil((rect["x"] + rect["w"] + mx) * w))
                    y0 = int(np.floor((rect["y"] - my) * h)); y1 = int(np.ceil((rect["y"] + rect["h"] + my) * h))
                    inner = a[y0 + 8:y1 - 8, x0 + 8:x1 - 8].max()
                    cx, cy, r = 0.70 * w, 0.60 * h, 0.05 * w
                    sub = a[int(cy - r - 10):int(cy + r + 10), int(cx - r - 10):int(cx + r + 10)].astype(int)
                    red = ((sub[..., 0] > 180) & (sub[..., 1] < 90) & (sub[..., 2] < 90)).sum()
                    if inner > 16 or red < 300:
                        bad += 1
                check("抜き取り検査（矩形内が黒・赤丸が残る）", bad == 0, f"不合格 {bad}")
        check("ページエラーなし", not errors, str(errors[:3]))
        browser.close()

    sampler.stop = True
    time.sleep(1.2)
    s = sampler.samples
    peak = max(m for _, m in s)
    # 出力開始以降の推移（約 25%/50%/75%/100% の時点）
    base_t = t - t_launch
    end_t = t_done - t_launch
    run = [(tt - base_t, m) for tt, m in s if base_t <= tt <= end_t]  # 一括出力の最中だけ
    def at(frac):
        if not run:
            return 0
        i = min(len(run) - 1, int(len(run) * frac))
        return run[i][1]
    q = [at(0.25), at(0.5), at(0.75), at(0.99)]
    heap_max = max(h for _, _, h in prog) if prog else 0
    print(f"   ブラウザ全体のメモリ(RSS 合計): ピーク {peak:.0f} MB / 出力中の推移 25%:{q[0]:.0f} 50%:{q[1]:.0f} 75%:{q[2]:.0f} 終了時:{q[3]:.0f} MB / JS ヒープ最大 {heap_max:.0f} MB")
    check("メモリがページ数に比例して増え続けない（終了時 ≦ 25% 時点の 1.6 倍）", q[3] <= q[0] * 1.6 + 50, f"{q[0]:.0f} → {q[3]:.0f} MB")
    check("ピークのメモリが 4GB 未満", peak < 4096, f"{peak:.0f} MB")
    ng = results.count(False)
    print(f"\n==== {len(results) - ng} / {len(results)} 件 OK ====")
    sys.exit(1 if ng else 0)


if __name__ == "__main__":
    main()
