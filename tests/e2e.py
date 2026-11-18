"""pdf-blackout.html の E2E テスト（Playwright・Edge/Chrome・file:// で開く）。

    uv run --with playwright,pillow,numpy python tests/e2e.py <テストPDFのフォルダ> [--channel msedge|chrome]

事前に tests/make_test_pdfs.py でテストPDFを作っておく。
ネットワークはオフラインにして実行し、http(s) のリクエストが 0 件であることも確認する。
"""
import io
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "pdf-blackout.html"
PDFS = Path(sys.argv[1]).resolve()
CHANNEL = sys.argv[sys.argv.index("--channel") + 1] if "--channel" in sys.argv else "msedge"

# テスト用の矩形（ページ全体に対する相対座標）。機密テキストを覆い、赤丸は覆わない。
RECT = dict(x=0.04, y=0.035, w=0.58, h=0.125)
GROW_MM = 1.0  # 「黒塗り拡大」の既定値
A4_MM = (210.0, 297.0)

results = []


def check(name, cond, detail=""):
    results.append((bool(cond), name, detail))
    print(("  OK  " if cond else "  NG  ") + name + (f"  [{detail}]" if detail and not cond else ""))


def section(title):
    print(f"\n== {title}")


def pdf_file(path, name=None):
    p = PDFS / path
    return {"name": name or p.name, "mimeType": "application/pdf", "buffer": p.read_bytes()}


class Env:
    def __init__(self, pw):
        self.browser = pw.chromium.launch(channel=CHANNEL, headless=True)
        self.requests = []
        self.errors = []
        self.tmp = Path(tempfile.mkdtemp(prefix="am_e2e_"))

    def new_page(self, init_script=None):
        ctx = self.browser.new_context(accept_downloads=True, viewport={"width": 1500, "height": 950})
        ctx.set_offline(True)  # ネットワークをすべてブロックした状態
        if init_script:
            ctx.add_init_script(init_script)
        page = ctx.new_page()
        page.on("request", lambda r: self.requests.append(r.url) if not r.url.startswith(("file:", "blob:", "data:")) else None)
        page.on("pageerror", lambda e: self.errors.append("pageerror: " + str(e)))
        page.on("console", lambda m: self.errors.append("console." + m.type + ": " + m.text) if m.type == "error" else None)
        page.goto(HTML.as_uri())
        return page


def load(page, *files):
    page.set_input_files("#fileInput", list(files))
    page.wait_for_function(
        "() => !App.loading && document.getElementById('loadStatus').textContent.length > 0 && state.pages.length > 0",
        timeout=60000)


RECT_NOW = dict(RECT)  # 直近に画面で作った矩形の実際の相対座標（マウス操作の端数を含む）


def draw_rect(page, rect=RECT):
    global RECT_NOW
    _draw_rect(page, rect)
    r = page.evaluate("state.rects[state.rects.length - 1]")
    RECT_NOW = {k: r[k] for k in ("x", "y", "w", "h")}


def _draw_rect(page, rect=RECT):
    box = page.locator("#overlay").bounding_box()
    x0 = box["x"] + rect["x"] * box["width"]
    y0 = box["y"] + rect["y"] * box["height"]
    x1 = box["x"] + (rect["x"] + rect["w"]) * box["width"]
    y1 = box["y"] + (rect["y"] + rect["h"]) * box["height"]
    page.mouse.move(x0, y0)
    page.mouse.down()
    page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, steps=6)
    page.mouse.move(x1, y1, steps=6)
    page.mouse.up()


def wait_base_rendered(page):
    page.wait_for_function("() => document.getElementById('editCanvas').width > 100", timeout=30000)
    page.wait_for_timeout(300)


def export_and_get(page, env, name_suffix=""):
    """出力タブで一括出力し、ZIP・CSV を保存して返す。"""
    page.click("#tabExport")
    page.wait_for_function("() => !document.getElementById('btnExport').disabled", timeout=10000)
    page.click("#btnExport")
    # 確認ダイアログが出たら承諾する
    page.wait_for_function(
        "() => document.getElementById('dlgConfirm').open || !document.getElementById('exportResult').hidden || !document.getElementById('exportError').hidden",
        timeout=30000)
    if page.evaluate("document.getElementById('dlgConfirm').open"):
        page.click("#cfOk")
    page.wait_for_function(
        "() => !document.getElementById('exportResult').hidden || !document.getElementById('exportError').hidden",
        timeout=600000)
    if page.evaluate("document.getElementById('exportResult').hidden"):
        return None, None
    with page.expect_download() as d1:
        page.click("#dlZip")
    zpath = env.tmp / f"out{name_suffix}.zip"
    d1.value.save_as(zpath)
    env.last_zip_name = d1.value.suggested_filename
    cpath = None
    if page.is_visible("#dlCsv"):  # 「対応表 CSV も作る」を外したときは CSV のボタンが出ない
        with page.expect_download() as d2:
            page.click("#dlCsv")
        cpath = env.tmp / f"mapping{name_suffix}.csv"
        d2.value.save_as(cpath)
    return zpath, cpath


def luminance_max(arr):
    return arr.max(axis=2)


def rect_px(w, h, rect=None, grow_mm=GROW_MM, shift_mm=(0, 0)):
    """アプリと同じ規則（拡大・切り捨て/切り上げ）で期待する画素矩形を求める（実際に作った矩形を基準にする）。"""
    rect = rect or RECT_NOW
    mx, my = grow_mm / A4_MM[0], grow_mm / A4_MM[1]
    x0 = int(np.floor((rect["x"] + shift_mm[0] / A4_MM[0] - mx) * w))
    y0 = int(np.floor((rect["y"] + shift_mm[1] / A4_MM[1] - my) * h))
    x1 = int(np.ceil((rect["x"] + rect["w"] + shift_mm[0] / A4_MM[0] + mx) * w))
    y1 = int(np.ceil((rect["y"] + rect["h"] + shift_mm[1] / A4_MM[1] + my) * h))
    return max(0, x0), max(0, y0), min(w, x1), min(h, y1)


def analyze_zip(zpath, expected_count, shifts=None):
    shifts = shifts or {}
    with zipfile.ZipFile(zpath) as z:
        check("ZIP が壊れていない（testzip / CRC）", z.testzip() is None)
        names = z.namelist()
        check(f"ZIP に {expected_count} 枚、page_001.jpg から連番", names == [f"page_{i + 1:03d}.jpg" for i in range(expected_count)], str(names[:3]))
        check("ファイル名の UTF-8 フラグ", all(i.flag_bits & 0x800 for i in z.infolist()))
        check("STORE（無圧縮）", all(i.compress_type == 0 for i in z.infolist()))
        raw = Path(zpath).read_bytes()
        ok_inner = True
        ok_red = True
        ok_dark_all = True
        ok_jpeg = True
        detail = ""
        for i, n in enumerate(names):
            data = z.read(n)
            if data[:2] != b"\xff\xd8" or b"Exif" in data[:4096]:
                ok_jpeg = False
            im = Image.open(io.BytesIO(data))
            if im.format != "JPEG":
                ok_jpeg = False
            arr = np.asarray(im.convert("RGB"))
            h, w = arr.shape[:2]
            x0, y0, x1, y1 = rect_px(w, h, shift_mm=shifts.get(i, (0, 0)))
            inner = arr[y0 + 8:y1 - 8, x0 + 8:x1 - 8]
            mx = int(luminance_max(inner).max())
            if mx > 16:
                ok_inner = False
                dm = luminance_max(arr) <= 16
                ys, xs = np.where(dm)
                bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())) if len(xs) else None
                detail += f" p{i + 1}:max={mx} expected={(x0, y0, x1, y1)} img={(w, h)} dark_bbox={bbox}"
            # 赤丸（矩形の外側）が残っている
            cx, cy, r = 0.70 * w, 0.60 * h, 0.05 * w
            sub = arr[int(cy - r - 10):int(cy + r + 10), int(cx - r - 10):int(cx + r + 10)].astype(int)
            red = ((sub[..., 0] > 180) & (sub[..., 1] < 90) & (sub[..., 2] < 90)).sum()
            if red < 300:
                ok_red = False
                detail += f" p{i + 1}:red={red}"
        check("矩形内部（端から 8px 以上内側）の最大輝度が 16 以下", ok_inner, detail)
        check("矩形の外側（赤丸）が残っている", ok_red, detail)
        check("出力は JPEG（SOI・Exif なし）", ok_jpeg)
        for needle, label in ((b"a4_5pages", "元PDFのファイル名"), ("ホゲホゲ".encode(), "「ホゲホゲ」(UTF-8)"),
                              ("ホゲホゲ".encode("utf-16-le"), "「ホゲホゲ」(UTF-16)"), (b"12345678", "「12345678」")):
            check(f"ZIP のバイト列に {label} が含まれない", needle not in raw)
        # 標準的な展開ツール（Windows 標準の tar = bsdtar）で展開できる
        outdir = Path(zpath).with_suffix("")
        outdir.mkdir(exist_ok=True)
        r = subprocess.run(["tar", "-xf", str(zpath), "-C", str(outdir)], capture_output=True)
        check("tar（bsdtar）で展開できる", r.returncode == 0 and len(list(outdir.glob("*.jpg"))) == expected_count, r.stderr.decode(errors="ignore")[:200])
    return names


def main():
    with sync_playwright() as pw:
        env = Env(pw)
        try:
            run_all(env)
        finally:
            env.browser.close()

    ng = [r for r in results if not r[0]]
    print(f"\n==== {len(results) - len(ng)} / {len(results)} 件 OK ====")
    for _, name, detail in ng:
        print("  NG:", name, detail)
    if env.requests:
        print("  外部リクエスト:", env.requests[:5])
    sys.exit(1 if ng else 0)


def run_all(env):
    # ------------------------------------------------------------------
    section("A4 の5ページを読み込む")
    page = env.new_page()
    csp_first = page.evaluate("""() => {
        const kids = [...document.head.children];
        return [kids[0].tagName + ':' + (kids[0].getAttribute('charset')||''), kids[1].getAttribute('http-equiv')];
    }""")
    check("CSP の meta が <head> の charset の直後にある", csp_first[1] == "Content-Security-Policy", str(csp_first))
    defaults = page.evaluate("""() => {
        // 画面に出る文言（スクリプトは除く。title 属性は含める）
        const c = document.body.cloneNode(true);
        c.querySelectorAll('script').forEach((s) => s.remove());
        const text = c.textContent + ' ' + [...document.querySelectorAll('[title]')].map((e) => e.title).join(' ');
        return {
            grow: document.getElementById('inGrow').value, dpi: document.getElementById('inDpi').value,
            q: document.getElementById('inQuality').value, prefix: document.getElementById('inPrefix').value,
            hasFormat: !!document.getElementById('selFormat'), hasPng: /PNG/i.test(text),
            s: Settings.get(), text };
    }""")
    check("既定値：黒塗り拡大 1mm・300 DPI・品質 0.92・接頭辞 page_・対応表 CSV あり（画面の値と Settings.get が一致）",
          defaults["grow"] == "1" and defaults["dpi"] == "300" and defaults["q"] == "0.92" and defaults["prefix"] == "page_"
          and defaults["s"]["growMm"] == 1 and defaults["s"]["dpi"] == 300 and defaults["s"]["quality"] == 0.92
          and defaults["s"]["prefix"] == "page_" and defaults["s"]["csv"] is True,
          str(defaults["s"]))
    check("出力形式は JPEG のみ（形式の選択も PNG の記述もない）", not defaults["hasFormat"] and not defaults["hasPng"])
    check("画面に「黒塗り拡大」があり、「余白」という語は出ない",
          "黒塗り拡大" in defaults["text"] and "余白" not in defaults["text"])
    check("矩形が0個のときは出力できない（ガード）", True)  # 下で実際に確認
    load(page, pdf_file("a4_5pages.pdf"))
    summary = page.inner_text("#summary")
    check("用紙サイズが「A4 縦」と表示される", "A4 縦" in summary, summary)
    check("警告が出ない", page.is_hidden("#sizeWarn") and page.is_hidden("#warnList"))
    check("基準ページが1ページ目", page.evaluate("state.baseIdx") == 0)
    worker_mode = page.inner_text("#workerMode")
    print("   ", worker_mode)
    check("file:// で Blob ワーカー（別スレッド）が動く", "Web Worker" in worker_mode, worker_mode)
    wait_base_rendered(page)

    page.click("#tabExport")
    check("矩形が0個の間は出力ボタンが無効", page.is_disabled("#btnExport"))
    check("無効な理由に「矩形」が出る", "矩形" in page.inner_text("#exportBlock"))
    page.click("#tabEdit")

    # --- 矩形を作る ---
    draw_rect(page)
    rects = page.evaluate("state.rects")
    check("ドラッグで矩形が1つできる", len(rects) == 1)
    if rects:
        r = rects[0]
        check("相対座標が指定位置に近い", abs(r["x"] - RECT["x"]) < 0.01 and abs(r["y"] - RECT["y"]) < 0.01 and abs(r["w"] - RECT["w"]) < 0.02, str(r))
    mm = [float(v) for v in page.eval_on_selector_all("#rectBody input", "els => els.map(e => e.value)")]
    check("矩形一覧に mm の値が出る（x≈8.4mm）", len(mm) == 4 and abs(mm[0] - 0.04 * 210) < 2.5, str(mm))

    # --- 元に戻す／やり直し・矢印・Delete ---
    page.keyboard.press("Control+z")
    check("Ctrl+Z で矩形が消える", page.evaluate("state.rects.length") == 0)
    page.keyboard.press("Control+y")
    check("Ctrl+Y で矩形が戻る", page.evaluate("state.rects.length") == 1)
    x_before = page.evaluate("state.rects[0].x")
    page.keyboard.press("ArrowRight")
    x_after = page.evaluate("state.rects[0].x")
    check("矢印キーで 0.5mm 動く", abs((x_after - x_before) * 210 - 0.5) < 0.05, f"{(x_after - x_before) * 210}")
    page.keyboard.press("Shift+ArrowLeft")
    x_shift = page.evaluate("state.rects[0].x")
    check("Shift+矢印キーで 5mm 動く", abs((x_after - x_shift) * 210 - 5) < 0.05, f"{(x_after - x_shift) * 210}")
    page.keyboard.press("Shift+ArrowRight")
    page.keyboard.press("ArrowLeft")  # 元の位置へ戻す（+0.5 -5 +5 -0.5）
    check("矢印キーで元の位置に戻る", abs(page.evaluate("state.rects[0].x") - x_before) < 0.001)
    page.keyboard.press("Delete")
    check("Delete で削除できる", page.evaluate("state.rects.length") == 0)
    page.keyboard.press("Control+z")
    check("削除を元に戻せる", page.evaluate("state.rects.length") == 1)

    # --- 黒塗りプレビュー・ズーム・数値編集 ---
    page.check("#chkBlack")
    check("黒塗りプレビューで不透明な黒の要素ができる", page.locator(".rect-ex").count() == 1)
    page.uncheck("#chkBlack")
    z0 = page.evaluate("Editor.zoom")
    page.click("#btnZoomIn")
    check("ズームボタンで拡大される", page.evaluate("Editor.zoom") > z0)
    page.click("#btnFit")
    check("「幅に合わせる」で 100% に戻る", page.evaluate("Editor.zoom") == 1)
    inp = page.locator("#rectBody input[data-f=w]")
    w_before = page.evaluate("state.rects[0].w")
    inp.fill("120")
    inp.press("Enter")  # 確定するとフォーカスが外れ、Ctrl+Z がアプリの履歴に効く
    check("数値欄（mm）の編集が反映される", abs(page.evaluate("state.rects[0].w") * 210 - 120) < 0.2)
    page.keyboard.press("Control+z")  # 数値編集を元に戻す
    check("数値編集も元に戻せる", abs(page.evaluate("state.rects[0].w") - w_before) < 1e-9)

    # --- 全ページのプレビュー ---
    section("プレビュー一覧と拡大表示")
    page.click("#tabPreview")
    page.wait_for_function("() => [...document.querySelectorAll('.tile canvas')].filter(c => c.width > 50).length >= 5", timeout=30000)
    dark = page.evaluate("""() => {
        const c = document.querySelectorAll('.tile canvas')[0];
        const ctx = c.getContext('2d');
        const w = c.width, h = c.height;
        const d = ctx.getImageData(Math.floor(w*0.1), Math.floor(h*0.06), Math.floor(w*0.3), Math.floor(h*0.05)).data;
        let max = 0; for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i+1], d[i+2]);
        return max;
    }""")
    check("サムネイルに黒塗りが適用されている", dark <= 16, str(dark))
    page.select_option("#selPreviewMode", "crop")
    page.wait_for_function("() => [...document.querySelectorAll('.tile canvas')].filter(c => c.width > 50).length >= 5", timeout=30000)
    page.wait_for_timeout(500)
    cw = page.evaluate("document.querySelectorAll('.tile canvas')[0].width")
    check("周辺確認ビュー（矩形の周辺を拡大）が描画される", cw >= 300, str(cw))
    page.select_option("#selPreviewMode", "full")
    page.click(".tile[data-idx='0']")
    page.wait_for_function("() => document.getElementById('pdStatus').textContent.includes('検証済み')", timeout=30000)
    check("拡大表示が出力と同じ処理（検証済み）で描画される", True)
    st = page.inner_text("#pdStatus")
    check("拡大表示の DPI が出力設定（既定の 300）と同じ", "300 DPI" in st, st)
    # ページ個別補正: ページ2 を右へ 10mm 動かす
    page.click("#pdNext")
    page.wait_for_function("() => document.getElementById('pdTitle').textContent.startsWith('ページ 2')", timeout=10000)
    page.fill("#pdDx", "10")
    page.dispatch_event("#pdDx", "change")
    check("ページ個別の平行移動が状態に入る", page.evaluate("state.adjust[1] && state.adjust[1].dx") == 10)
    page.wait_for_function("() => document.getElementById('pdStatus').textContent.includes('検証済み')", timeout=30000)
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.getElementById('dlgPage').open")

    # ------------------------------------------------------------------
    section("一括出力（A4 × 5ページ・ページ2を +10mm 補正）")
    zpath, cpath = export_and_get(page, env)
    check("出力が完了し ZIP・CSV が得られる", zpath is not None and cpath is not None)
    if zpath:
        check("ZIP の名前が masked_pages.zip", env.last_zip_name == "masked_pages.zip", env.last_zip_name)
        check("完了画面に枚数が出る", "5 枚" in page.inner_text("#resTotal") and "5 枚" in page.inner_text("#resMasked") and "なし" in page.inner_text("#resErrors"))
        analyze_zip(zpath, 5, shifts={1: (10, 0)})
        csv_bytes = cpath.read_bytes()
        check("CSV は UTF-8 の BOM 付き", csv_bytes[:3] == b"\xef\xbb\xbf")
        lines = csv_bytes.decode("utf-8-sig").split("\r\n")
        check("CSV の列と内容", lines[0] == "出力ファイル名,元ファイルの名前,元ページ番号" and lines[1] == "page_001.jpg,a4_5pages.pdf,1" and lines[5] == "page_005.jpg,a4_5pages.pdf,5", str(lines[:2]))
        # 補正したページだけマスク位置がずれている
        with zipfile.ZipFile(zpath) as z:
            def dark_left(n):
                a = np.asarray(Image.open(io.BytesIO(z.read(n))).convert("RGB")).max(axis=2)
                cols = np.where((a[:400] <= 12).sum(axis=0) > 100)[0]
                return int(cols.min())
            d = dark_left("page_002.jpg") - dark_left("page_001.jpg")
            want = 10 / 25.4 * 300  # 既定 300 DPI で +10mm ≈ 118px
            check(f"ページ個別補正が出力に反映される（+10mm ≈ {want:.0f}px）", want - 5 <= d <= want + 5, str(d))

    # ------------------------------------------------------------------
    section("対応表 CSV を作らない（「対応表 CSV も作る」を外す）")
    page.click("#tabExport")
    page.uncheck("#chkCsv")
    zpath2, cpath2 = export_and_get(page, env, "_nocsv")
    check("ZIP だけが得られ、CSV は作られない", zpath2 is not None and cpath2 is None)
    check("CSV のボタンが出ず、保持もしない", page.is_hidden("#dlCsv") and page.evaluate("state.lastExport.csv") is None)
    check("画面に「対応表は作っていない」旨が出る", "作っていない" in page.inner_text("#resNote"), page.inner_text("#resNote"))
    if zpath2:
        with zipfile.ZipFile(zpath2) as z:
            names = z.namelist()
            check("ZIP の中身は画像だけ（5 枚）", names == [f"page_{i + 1:03d}.jpg" for i in range(5)], str(names))
    page.check("#chkCsv")

    # ------------------------------------------------------------------
    section("黒塗り検証の失敗 → 全体中止（ZIP・CSV を出さない）")
    page.evaluate("() => { window.__origFill = Renderer.fillBlack; Renderer.fillBlack = () => {}; }")
    page.click("#tabExport")
    page.click("#btnExport")
    page.wait_for_function("() => document.getElementById('dlgConfirm').open || !document.getElementById('exportError').hidden", timeout=30000)
    if page.evaluate("document.getElementById('dlgConfirm').open"):
        page.click("#cfOk")
    page.wait_for_function("() => !document.getElementById('exportError').hidden", timeout=60000)
    err = page.inner_text("#exportError")
    check("検証失敗でエラー表示・中止", "検証" in err and "出力していません" in err, err)
    check("結果（ダウンロード）が出ない", page.is_hidden("#exportResult") and page.evaluate("state.lastExport") is None)
    page.evaluate("() => { Renderer.fillBlack = window.__origFill; }")

    # ------------------------------------------------------------------
    section("JSON の保存・読み込み")
    page.click("#tabEdit")
    with page.expect_download() as dl:
        page.click("#btnSaveMask")
    jpath = env.tmp / "mask.json"
    dl.value.save_as(jpath)
    obj = json.loads(jpath.read_text(encoding="utf-8"))
    check("JSON に形式・バージョン・用紙サイズ・矩形が入る", obj["format"] == "pdf-blackout-mask" and obj["version"] == 1 and abs(obj["paperMm"]["w"] - 210) < 1 and len(obj["rects"]) == 1)
    check("JSON にファイル名・PDF 内の文字が含まれない", "a4_5pages" not in jpath.read_text(encoding="utf-8") and "ホゲ" not in jpath.read_text(encoding="utf-8"))
    page.set_input_files("#fileMask", {"name": "bad.json", "mimeType": "application/json", "buffer": b'{"format":"pdf-blackout-mask","version":1,"rects":[{"x":2,"y":0,"w":1,"h":1}]}'})
    page.wait_for_function("() => !document.getElementById('maskWarn').hidden")
    check("不正な JSON は読み込まれず理由が出る", "読み込めませんでした" in page.inner_text("#maskWarn") and page.evaluate("state.rects.length") == 1)
    a3 = {"format": "pdf-blackout-mask", "version": 1, "paperMm": {"w": 297, "h": 210}, "rects": [{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.1}, {"x": 0.5, "y": 0.5, "w": 0.2, "h": 0.1}]}
    page.set_input_files("#fileMask", {"name": "a3.json", "mimeType": "application/json", "buffer": json.dumps(a3).encode()})
    page.wait_for_function("() => state.rects.length === 2")
    check("用紙サイズが違う定義を読み込むと警告が出る（縦横入れ替わりも）", "異なります" in page.inner_text("#maskWarn") and "入れ替わって" in page.inner_text("#maskWarn"), page.inner_text("#maskWarn"))
    page.close()

    # ------------------------------------------------------------------
    section("用紙サイズ違い: A3 横（名前順で後ろ）を A4 に加える")
    page = env.new_page()
    load(page, pdf_file("a4_5pages.pdf", "doc1_a4.pdf"))
    wait_base_rendered(page)
    draw_rect(page)
    load_more = pdf_file("a3_landscape_1page.pdf", "doc9_a3.pdf")
    page.set_input_files("#fileInput", [load_more])
    page.wait_for_function("() => state.pages.length === 6", timeout=30000)
    check("警告が出て A3 のページ番号（6）が示される", page.is_visible("#sizeWarn") and page.evaluate("state.mismatch") == [5], page.inner_text("#sizeWarnBody"))
    check("警告に「A3 横」が出る", "A3 横" in page.inner_text("#sizeWarnBody"))
    page.click("#tabExport")
    check("「このまま続ける」を選ぶまで出力できない", page.is_disabled("#btnExport") and "このまま続ける" in page.inner_text("#exportBlock"))
    page.click("#tabEdit")
    page.click("#btnSizeAck")
    page.click("#tabExport")
    check("「このまま続ける」で出力ボタンが有効になる", page.is_enabled("#btnExport"))
    page.click("#btnExport")
    page.wait_for_function("() => document.getElementById('dlgConfirm').open", timeout=10000)
    cf = page.inner_text("#cfBody")
    check("未確認ページの確認ダイアログが出る", "6" in cf and "確認していません" in cf, cf)
    page.click("#cfCancel")
    page.close()

    section("用紙サイズ違い: A3 のファイルが名前順で先頭に来る")
    page = env.new_page()
    page.set_input_files("#fileInput", [pdf_file("a3_landscape_1page.pdf", "0_a3.pdf"), pdf_file("a4_5pages.pdf", "1_a4.pdf")])
    page.wait_for_function("() => state.pages.length === 6", timeout=30000)
    check("警告に挙がるのは A3 の1ページ目だけ（A4 の5ページではない）", page.evaluate("state.mismatch") == [0], str(page.evaluate("state.mismatch")))
    check("基準ページの既定は基準サイズ（A4）の最初のページ（2ページ目）", page.evaluate("state.baseIdx") == 1)
    page.close()

    section("縦横が入れ替わったページ")
    page = env.new_page()
    load(page, pdf_file("a4_with_landscape.pdf"))
    check("A4 横のページが警告に挙がる（5ページ目）", page.evaluate("state.mismatch") == [4] and page.is_visible("#sizeWarn"))
    page.close()

    # ------------------------------------------------------------------
    section("テキスト層つきPDF: 出力にテキストが残らない")
    page = env.new_page()
    load(page, pdf_file("a4_textlayer_3pages.pdf"))
    wait_base_rendered(page)
    draw_rect(page)
    zpath, cpath = export_and_get(page, env, "_text")
    check("テキスト層つきPDFも出力できる", zpath is not None)
    if zpath:
        raw = zpath.read_bytes()
        check("出力に機密テキストの文字列が残らない", all(n not in raw for n in ("ホゲホゲ".encode(), "ホゲホゲ".encode("utf-16-le"), b"12345678")))
        with zipfile.ZipFile(zpath) as z:
            a = np.asarray(Image.open(io.BytesIO(z.read("page_001.jpg"))).convert("RGB"))
            h, w = a.shape[:2]
            x0, y0, x1, y1 = rect_px(w, h)
            check("テキスト層つきでも矩形内が黒", a[y0 + 8:y1 - 8, x0 + 8:x1 - 8].max() <= 16)
    page.close()

    # ------------------------------------------------------------------
    section("代替方式: Web Worker が使えない環境でもメインスレッドで動く")
    page = env.new_page(init_script="window.Worker = function () { throw new Error('Worker blocked for test'); };")
    load(page, pdf_file("a4_5pages.pdf"))
    wait_base_rendered(page)
    mode = page.inner_text("#workerMode")
    check("Worker を作れないとき、メインスレッド方式に切り替わる", "代替方式" in mode, mode)
    check("代替方式でも5ページを読み込んで描画できる", page.evaluate("state.pages.length") == 5 and page.evaluate("document.getElementById('editCanvas').width") > 100)
    draw_rect(page)
    zpath, _ = export_and_get(page, env, "_fallback")
    check("代替方式でも一括出力できる", zpath is not None and len(zipfile.ZipFile(zpath).namelist()) == 5)
    page.close()

    # ------------------------------------------------------------------
    section("静的確認（通信しないこと）")
    html = HTML.read_text(encoding="utf-8")
    app = re.search(r'<script id="app-main">(.*?)</script>', html, re.S).group(1)
    tmpl = re.sub(r'(<script id="pdfjs-lib">).*?(</script>)', r"\1\2", html, flags=re.S)
    tmpl = re.sub(r'(<script type="text/plain" id="pdfjs-worker-src">).*?(</script>)', r"\1\2", tmpl, flags=re.S)
    check("<link>・<script src>・<img>・@import・外部 url() がない", not re.search(r"<link\b|<script[^>]*\bsrc=|<img\b|@import|url\(\s*['\"]?https?:", tmpl))
    urls = set(re.findall(r"https?://[^\s'\"<>)]+", tmpl))
    check("pdf.js 以外の部分に外部URLは、ライセンスのコメントだけ", urls <= {"http://www.apache.org/licenses/LICENSE-2.0"}, str(urls))
    code = re.sub(r"/\*.*?\*/", "", app, flags=re.S)           # コメントは除く
    code = re.sub(r"(?m)^\s*//.*$|(?<=[;{}\s])//[^\n'\"`]*$", "", code)
    banned = [w for w in ("fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "localStorage", "sessionStorage", "indexedDB", "importScripts", "EventSource") if w in code]
    check("アプリのコードに通信・永続化の API がない", not banned, str(banned))
    check("実行時の外部リクエスト（http/https）が 0 件", not env.requests, str(env.requests[:5]))
    ignorable = ("Failed to load resource",)
    errs = [e for e in env.errors if not any(i in e for i in ignorable)]
    check("ページエラー・コンソールエラーが出ていない", not errs, str(errs[:5]))


if __name__ == "__main__":
    main()
