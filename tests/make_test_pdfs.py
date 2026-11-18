"""テスト用PDFを作る。

    uv run --with pymupdf,pillow,numpy python tests/make_test_pdfs.py <出力フォルダ> [--big] [--font <日本語フォントのパス>]

スキャン画像の PDF を想定して、ページ全体が画像の PDF にする。
日本語を埋め込みフォントなしのテキストにすると、pdf.js が外部の CMap を読もうとして失敗するため、
文字は画像として描く。例外として、「テキスト層つき」のPDFだけは、出力にテキストが残らないことの
確認用に、不可視のテキスト（隠したい文字列）を重ねる。

各ページの決まった位置に、隠したい文字列（「機密テキスト：ホゲホゲ」「管理番号：12345678」）と赤丸を描く。

日本語フォントは、--font か環境変数 PDF_TEST_FONT で指定できる。指定がなければ Windows の標準フォントを探す
（他の OS では未検証。フォントのパスを指定すること）。
"""
import io
import os
import sys
from pathlib import Path

import pymupdf as fitz  # PyMuPDF
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [r"C:\Windows\Fonts\msgothic.ttc", r"C:\Windows\Fonts\meiryo.ttc", r"C:\Windows\Fonts\YuGothM.ttc"]
_given = sys.argv[sys.argv.index("--font") + 1] if "--font" in sys.argv and sys.argv.index("--font") + 1 < len(sys.argv) else os.environ.get("PDF_TEST_FONT")
FONT = _given if _given else next((f for f in FONT_CANDIDATES if Path(f).exists()), None)
if FONT is None or not Path(FONT).exists():
    sys.exit("日本語フォントが見つかりません。--font <フォントファイルのパス> で指定してください。")

A4 = (210.0, 297.0)
A3 = (297.0, 420.0)
SECRET1_TEXT = "機密テキスト：ホゲホゲ"
SECRET2_TEXT = "管理番号：12345678"

# 画面上の位置（ページ全体に対する相対座標）。テストの矩形はこれを覆う。
SECRET1_POS = (0.08, 0.06)
SECRET2_POS = (0.08, 0.11)
CIRCLE = (0.70, 0.60, 0.05)  # 中心x, 中心y, 半径（幅に対する比）


def mm_to_px(mm, dpi):
    return round(mm / 25.4 * dpi)


def make_page(w_mm, h_mm, dpi, page_no, noise_seed=None):
    w, h = mm_to_px(w_mm, dpi), mm_to_px(h_mm, dpi)
    im = Image.new("RGB", (w, h), (255, 255, 255))
    d = ImageDraw.Draw(im)
    fsize = max(12, round(w * 0.037))
    font = ImageFont.truetype(FONT, fsize, index=0)
    small = ImageFont.truetype(FONT, max(10, round(w * 0.022)), index=0)
    # 隠したい文字列（真っ黒）。マスクの内側に入る。
    d.text((SECRET1_POS[0] * w, SECRET1_POS[1] * h), SECRET1_TEXT, font=font, fill=(0, 0, 0))
    d.text((SECRET2_POS[0] * w, SECRET2_POS[1] * h), SECRET2_TEXT, font=font, fill=(0, 0, 0))
    # 本文（灰色。マスクの外側）
    for i in range(12):
        d.text((0.08 * w, (0.22 + i * 0.03) * h), f"問{i + 1}  これは本文の行です。（ページ {page_no}）", font=small, fill=(90, 90, 90))
    # 赤ペンの〇（マスクの外側）
    cx, cy, r = CIRCLE[0] * w, CIRCLE[1] * h, CIRCLE[2] * w
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(220, 20, 20), width=max(3, round(w * 0.006)))
    if noise_seed is not None:
        rng = np.random.default_rng(noise_seed)
        arr = np.asarray(im, dtype=np.int16)
        arr = arr + rng.integers(-12, 13, size=arr.shape, dtype=np.int16)
        im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    return im


def jpeg_bytes(im, quality=88):
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def build_pdf(path, pages, text_layer=False):
    """pages: [(PIL.Image, 幅mm, 高さmm), ...]"""
    doc = fitz.open()
    for im, w_mm, h_mm in pages:
        page = doc.new_page(width=w_mm / 25.4 * 72, height=h_mm / 25.4 * 72)
        page.insert_image(page.rect, stream=jpeg_bytes(im))
        if text_layer:
            w, h = page.rect.width, page.rect.height
            for text, pos in ((SECRET1_TEXT, SECRET1_POS), (SECRET2_TEXT, SECRET2_POS)):
                page.insert_text(
                    fitz.Point(pos[0] * w, pos[1] * h + 20), text,
                    fontfile=FONT, fontname="jp", fontsize=16, render_mode=3,  # 不可視
                )
    doc.save(str(path), garbage=4, deflate=True)
    doc.close()


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    big = "--big" in sys.argv

    if not big:
        dpi = 150
        build_pdf(out / "a4_5pages.pdf", [(make_page(*A4, dpi, i + 1), *A4) for i in range(5)])
        build_pdf(out / "a3_landscape_1page.pdf", [(make_page(A3[1], A3[0], dpi, 1), A3[1], A3[0])])
        pages = [(make_page(*A4, dpi, i + 1), *A4) for i in range(4)]
        pages.append((make_page(A4[1], A4[0], dpi, 5), A4[1], A4[0]))  # 5ページ目だけ A4 横
        build_pdf(out / "a4_with_landscape.pdf", pages)
        build_pdf(out / "a4_textlayer_3pages.pdf", [(make_page(*A4, dpi, i + 1), *A4) for i in range(3)], text_layer=True)
        print("作成:", ", ".join(sorted(p.name for p in out.glob("*.pdf"))))
    else:
        # 100 ページ（A4）。1ページ 1〜2MB 程度のスキャン風（ノイズつき）画像にする。
        dpi = 300  # 300dpi の A4（約 870 万画素）にノイズを乗せて、1ページ 1〜2MB 程度にする
        pages = [(make_page(*A4, dpi, i + 1, noise_seed=i), *A4) for i in range(100)]
        build_pdf(out / "a4_100pages_scan.pdf", pages)
        p = out / "a4_100pages_scan.pdf"
        print(f"作成: {p.name} {p.stat().st_size / 1024 / 1024:.0f} MB")


if __name__ == "__main__":
    main()
