"""画面の見た目を確認するためのスクリーンショットを撮る（開発用）。

    uv run --with playwright python tests/screenshot.py <テストPDFのフォルダ> <出力フォルダ>
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
pdfs = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)

with sync_playwright() as pw:
    b = pw.chromium.launch(channel="msedge", headless=True)
    page = b.new_context(viewport={"width": 1500, "height": 1000}).new_page()
    page.goto((ROOT / "pdf-blackout.html").as_uri())
    page.screenshot(path=str(out / "01_empty.png"))
    page.set_input_files("#fileInput", [
        {"name": "doc1_a4.pdf", "mimeType": "application/pdf", "buffer": (pdfs / "a4_5pages.pdf").read_bytes()},
        {"name": "doc9_a3.pdf", "mimeType": "application/pdf", "buffer": (pdfs / "a3_landscape_1page.pdf").read_bytes()},
    ])
    page.wait_for_function("() => state.pages.length === 6", timeout=30000)
    page.wait_for_function("() => document.getElementById('editCanvas').width > 100")
    page.wait_for_timeout(500)
    box = page.locator("#overlay").bounding_box()
    page.mouse.move(box["x"] + 0.04 * box["width"], box["y"] + 0.035 * box["height"])
    page.mouse.down()
    page.mouse.move(box["x"] + 0.62 * box["width"], box["y"] + 0.16 * box["height"], steps=8)
    page.mouse.up()
    page.screenshot(path=str(out / "02_loaded_edit.png"))
    page.check("#chkBlack")
    page.screenshot(path=str(out / "03_black_preview.png"))
    page.click("#btnSizeAck")
    page.click("#tabPreview")
    page.wait_for_function("() => [...document.querySelectorAll('.tile canvas')].filter(c => c.width > 50).length >= 6", timeout=30000)
    page.wait_for_timeout(500)
    page.screenshot(path=str(out / "04_preview.png"))
    page.click(".tile[data-idx='5']")
    page.wait_for_function("() => document.getElementById('pdStatus').textContent.includes('検証済み')", timeout=30000)
    page.screenshot(path=str(out / "05_page_dialog.png"))
    page.keyboard.press("Escape")
    page.click("#tabExport")
    page.screenshot(path=str(out / "06_export.png"))
    b.close()
print("saved", sorted(p.name for p in out.glob("*.png")))
