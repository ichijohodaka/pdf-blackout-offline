#!/usr/bin/env node
'use strict';
/**
 * pdf-blackout.html を生成するビルドスクリプト。
 *   node build.js
 *
 * - src/template.html の各マーカーを、CSS・アプリJS・pdf.js（本体とワーカー）で置き換える。
 * - vendor/ のファイルは SHA256SUMS と照合する（改ざん・取り違えの検出）。ネットワークは使わない。
 * - 埋め込むソースに「</script」「<!--」（CSS は「</style」）が含まれていたら失敗する。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const rd = (p) => fs.readFileSync(path.join(root, p));
const rdText = (p) => rd(p).toString('utf8');

function fail(msg) {
  console.error('ビルド失敗: ' + msg);
  process.exit(1);
}

// 1. vendor のハッシュ検証
for (const line of rdText('vendor/SHA256SUMS').split(/\r?\n/).filter(Boolean)) {
  const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
  if (!m) fail('SHA256SUMS の形式が不正です: ' + line);
  const actual = crypto.createHash('sha256').update(rd('vendor/' + m[2])).digest('hex');
  if (actual !== m[1]) fail(`vendor/${m[2]} のハッシュが一致しません`);
}

// 2. 埋め込むソースの用意
const jsDir = path.join(root, 'src', 'js');
const appFiles = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')).sort();
const parts = {
  CSS: rdText('src/style.css'),
  PDFJS: rdText('vendor/pdf.min.js'),
  PDFJS_WORKER: rdText('vendor/pdf.worker.min.js'),
  APP: appFiles.map((f) => `/* ---- ${f} ---- */\n` + rdText('src/js/' + f)).join('\n'),
};

// 3. 埋め込み安全性の検査
const bad = (name, re) => {
  if (re.test(parts[name])) fail(`${name} に ${re} に一致する文字列が含まれています（HTML に埋め込めません）`);
};
bad('CSS', /<\/style/i);
bad('CSS', /<!--/);
for (const k of ['PDFJS', 'PDFJS_WORKER', 'APP']) {
  bad(k, /<\/script/i);
  bad(k, /<!--/);
}

// 4. 置換（関数で置換し、$& などの特殊パターンを無効にする）
let html = rdText('src/template.html');
for (const [k, v] of Object.entries(parts)) {
  const marker = `/*__${k}__*/`;
  if (!html.includes(marker)) fail('template.html にマーカーがありません: ' + marker);
  html = html.split(marker).join('\u0000').replace('\u0000', () => v);
  if (html.includes('\u0000')) fail('マーカーが複数あります: ' + marker);
}
if (/\/\*__[A-Z_]+__\*\//.test(html.replace(parts.PDFJS, '').replace(parts.PDFJS_WORKER, ''))) {
  fail('未置換のマーカーが残っています');
}

const out = path.join(root, 'pdf-blackout.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`生成しました: ${path.relative(root, out)} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
