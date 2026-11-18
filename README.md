# PDF 黒塗りツール

PDF の指定した範囲を黒塗りし、黒塗り済みの JPEG 画像にして一括で書き出す、ブラウザだけで動く単体 HTML ツールです。
1ページ上に矩形を置くと、同じ相対位置の矩形が全ページに適用されます。仕様は [SPEC.md](SPEC.md) を参照してください。

- **成果物は `pdf-blackout.html` 1ファイル。** ダブルクリックで開き、オフラインで動きます。
- **外部通信は一切しません。** CSP（`connect-src 'none'` など）で禁止しています。PDF はブラウザの中だけで処理されます。
- **出力は黒塗り済みの画素だけの JPEG です。** canvas 上で黒く塗りつぶし、矩形内の全画素が (0,0,0) であることを検証してから書き出します。元の PDF のテキスト・ベクトル・EXIF は出力に入りません。検証に失敗したときは、一部だけを出さずに全体を中止します。
- **入力は PDF のみ、出力は JPEG のみ**（ZIP にまとめます）。

## 動作確認済みの環境

| 項目 | 確認した版 |
|---|---|
| OS | Windows 11（10.0.26300） |
| ブラウザ | Microsoft Edge 157.0.4341.60 / Google Chrome 157.0.8103.79 |

上記以外のブラウザ・OS は確認していません。ブラウザの設定（プライバシー保護機能など）で canvas の読み出しが乱されると、黒塗りの検証が失敗して出力が中止されます。

## 使い方

1. `pdf-blackout.html` を開き、PDF をドラッグ＆ドロップ（複数可）。
2. 「マスク編集」で、隠したい部分に矩形をドラッグして置く。出力時は、置いた矩形の各辺を「黒塗り拡大」（既定 1 mm）だけ外側へ広げて黒く塗ります（スキャンのわずかなずれへの余裕）。
3. 「プレビュー一覧」で全ページの黒塗りを確認する。サムネイルをクリックすると、出力と同じ処理の結果を拡大表示します。そのページだけの補正もここでできます。
4. 「出力」で解像度などを決め、一括出力。既定は **300 DPI・JPEG（品質 0.92）** で、細かい文字も読み取れる設定です（A4 で 1 枚 1MB 前後）。
   **画像の ZIP**（`masked_pages.zip`）と、**対応表 CSV**（出力画像と元のファイル名・ページ番号の対応。作らない選択もできます）を、それぞれダウンロードします。
   ZIP には元のファイル名は入りません。対応表は、画像とは別に保管してください。

PDF が N ページずつの組のくり返し（例：2 ページ組）のときは、「1組のページ数 N」と「黒塗りを適用する組内の位置」で、各組の特定のページだけに黒塗りを適用できます。

## 制限事項

- 入力は PDF のみ、出力は JPEG のみです。
- 1ページの画素数が 40 メガ画素を超える設定（DPI が高すぎる場合）では出力できません。
- ZIP64 には対応しません。ファイル数が 65535 を超える場合は出力前に、合計が 4GB に近づく場合は出力の途中で、中止します。
- 用紙サイズが基準と違うページがあると警告し、確認するまで出力できません。サイズの自動補正や自動回転はしません。

## 性能の参考値

100 ページ（A4・300 dpi のスキャン風画像、PDF は約 110 MB）を既定の 300 DPI で一括出力して、Edge 157 で 53 秒（0.53 秒/ページ）、
ブラウザ全体のメモリのピークは約 1.4 GB でした（ページ数に比例して増え続けることはありません）。ページ数の上限を定めるものではありません。

## 開発環境

ビルドとテストに使った環境です。

| 用途 | 内容 |
|---|---|
| OS | Windows 11（10.0.26300） |
| ビルド | Node.js v24.16.0（標準モジュールだけを使うので、`npm install` は不要） |
| テスト | Python 3.12.13（[uv](https://docs.astral.sh/uv/) の `uv run --with ...` で実行）、Playwright 1.65.2、PyMuPDF 2.1、Pillow 13.0.0、NumPy 2.5.5、psutil 7.2.2 |
| テストで使うブラウザ | PC にインストール済みの Microsoft Edge / Google Chrome（Playwright の `channel` で指定。`playwright install` は不要） |

- uv を使わない場合は、上の版のパッケージを自分で用意して `python tests/...` を直接実行してください（この手順は確認していません）。
- テスト用 PDF の生成には日本語フォントが必要です。Windows の標準フォント（`msgothic.ttc` など）を自動で探します。他の OS では確認しておらず、`--font` か環境変数 `PDF_TEST_FONT` でフォントファイルを指定してください。

## ビルド

```
node build.js
```

`src/`（HTML・CSS・JS）と `vendor/`（pdf.js）を結合して `pdf-blackout.html` を生成します。ネットワークは使いません。ビルド済みの `pdf-blackout.html` もリポジトリに含めています。

- pdf.js は **`pdfjs-dist@3.11.174`**（Apache-2.0）の `pdf.min.js` と `pdf.worker.min.js` を `vendor/` に置いています。
  ビルド時に `vendor/SHA256SUMS` と照合します。npm の tarball の integrity は
  `sha512-TdTZPf1trZ8/UFu5Cx/GXB7GZM30LT+wWUNfsi6Bq8ePLnb+woNKtDymI2mxZYBpMbonNFqKmiz684DIfnd8dA==` で、
  `npm pack pdfjs-dist@3.11.174` で取得したものと一致することを確認済みです。
- 4.x 系は wasm を使うため CSP の見直しが必要になります。上げないでください。
- `vendor/` は `.gitattributes` で改行変換の対象外にしています（SHA-256 の照合のため）。

## テスト

Playwright（Edge / Chrome を `file://` で使う）で、仕様の受け入れ基準を確認します。

```
uv run --with pymupdf,pillow,numpy python tests/make_test_pdfs.py tests/out/pdfs
uv run --with playwright,pillow,numpy python tests/e2e.py tests/out/pdfs
uv run --with playwright,pillow,numpy python tests/e2e.py tests/out/pdfs --channel chrome

uv run --with pymupdf,pillow,numpy python tests/make_test_pdfs.py tests/out/big --big
uv run --with playwright,pillow,numpy,psutil python tests/e2e_big.py tests/out/big/a4_100pages_scan.pdf
```

`tests/e2e.py` は、既定値、用紙サイズの警告、矩形内の黒塗り、ZIP・CSV の内容、通信が発生しないこと（オフラインで実行し、http(s) リクエスト 0 件を確認）、
検証失敗時に全体中止して何も出力しないこと、Web Worker が使えない場合の代替方式などを確認します。
`tests/e2e_big.py` は、100 ページ（1ページ約 1MB のスキャン風画像）の処理時間・メモリ・キャンセルを確認します。

## ファイル構成

```
build.js               ビルドスクリプト（Node.js）
src/template.html      HTML の骨組み（CSP・UI・埋め込み位置）
src/style.css
src/js/00-core.js      共通ユーティリティ・状態・設定
src/js/10-model.js     用紙サイズ・座標変換（拡大・切り捨て/切り上げ）・ページ個別補正
src/js/20-zip.js       自前の ZIP（STORE・CRC32・UTF-8）と CSV
src/js/30-pdf.js       PDF 読み込み・描画・黒塗り・検証
src/js/40-editor.js    マスク編集・マスク定義(JSON)の保存/読み込み
src/js/50-preview.js   プレビュー一覧・ページ拡大表示・ページ個別補正
src/js/60-export.js    一括出力・出力ガード
src/js/70-app.js       起動・ファイル読み込み
vendor/                pdf.js（本体・ワーカー・ライセンス・ハッシュ）
tests/                 テスト PDF 生成・E2E
pdf-blackout.html      ビルド済みの成果物
SPEC.md                仕様
```

## 設計上の注意

- **状態はメモリ上のみ。** localStorage や IndexedDB には何も保存しません。ページを再読み込みすると、ページ個別の補正などは失われます（マスク定義は JSON で保存できます）。
- **出力ガード。** 矩形が0個、組内の位置が未選択、用紙サイズ警告が未解決、画素数が上限超のときは出力できません。
- **エラー時は全体中止。** 黒塗りの検証失敗・描画失敗・キャンセルのときは、ZIP も CSV も出さず、途中結果を破棄します。
- **PDF.js の Worker。** `file://` では pdf.js 標準の起動方式（blob を `importScripts` で包む）が失敗して黙ってメインスレッド動作になるため、Blob URL から Worker を自前で作って pdf.js に渡しています。Worker を作れない環境ではメインスレッド方式に切り替わります。使われている方式は画面下部に表示されます。

## ライセンス

このリポジトリのコードは [MIT License](LICENSE) です。同梱の pdf.js は Apache License 2.0 です（[vendor/LICENSE-pdfjs](vendor/LICENSE-pdfjs)。`pdf-blackout.html` の中にも、ライセンスの表示を残しています）。
