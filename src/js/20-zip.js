/* ==========================================================================
 * 20 ZIP（無圧縮 STORE・CRC32・UTF-8 フラグ付き）と CSV
 * ========================================================================== */

const Zip = {
  _table: null,

  crcTable() {
    if (!Zip._table) {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
      }
      Zip._table = t;
    }
    return Zip._table;
  },

  crc32(u8) {
    const t = Zip.crcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = t[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  },

  dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  },

  /**
   * ZIP を Blob の断片をつなげて作る。ファイル本体は Blob のまま持ち、CRC32 の計算時にだけ
   * 1ファイルずつ読む（メモリを使いすぎない）。ZIP64 には対応しない。
   */
  Writer: class {
    constructor() {
      this.parts = [];
      this.entries = [];
      this.offset = 0;
      this.stamp = Zip.dosDateTime(new Date());
      this.enc = new TextEncoder();
    }

    async addFile(name, blob) {
      if (this.entries.length >= 0xFFFF) throw new Error('ZIP のファイル数の上限（65535）を超えました。');
      const nameBytes = this.enc.encode(name);
      const size = blob.size;
      if (this.offset + 30 + nameBytes.length + size > 0xFFFFFFFF - 1048576) {
        throw new Error('ZIP の合計サイズが 4GB に近づいたため中止しました（ZIP64 には対応していません）。');
      }
      const crc = Zip.crc32(new Uint8Array(await blob.arrayBuffer()));
      const h = new DataView(new ArrayBuffer(30 + nameBytes.length));
      h.setUint32(0, 0x04034b50, true);
      h.setUint16(4, 20, true);              // 展開に必要なバージョン
      h.setUint16(6, 0x0800, true);          // bit11: ファイル名は UTF-8
      h.setUint16(8, 0, true);               // 圧縮方式: 0 = STORE
      h.setUint16(10, this.stamp.time, true);
      h.setUint16(12, this.stamp.date, true);
      h.setUint32(14, crc, true);
      h.setUint32(18, size, true);
      h.setUint32(22, size, true);
      h.setUint16(26, nameBytes.length, true);
      h.setUint16(28, 0, true);
      new Uint8Array(h.buffer).set(nameBytes, 30);
      this.parts.push(new Uint8Array(h.buffer), blob);
      this.entries.push({ nameBytes, crc, size, offset: this.offset });
      this.offset += h.byteLength + size;
    }

    finish() {
      const cdStart = this.offset;
      let cdSize = 0;
      for (const e of this.entries) {
        const c = new DataView(new ArrayBuffer(46 + e.nameBytes.length));
        c.setUint32(0, 0x02014b50, true);
        c.setUint16(4, 20, true);            // 作成したバージョン
        c.setUint16(6, 20, true);            // 展開に必要なバージョン
        c.setUint16(8, 0x0800, true);
        c.setUint16(10, 0, true);
        c.setUint16(12, this.stamp.time, true);
        c.setUint16(14, this.stamp.date, true);
        c.setUint32(16, e.crc, true);
        c.setUint32(20, e.size, true);
        c.setUint32(24, e.size, true);
        c.setUint16(28, e.nameBytes.length, true);
        c.setUint16(30, 0, true);            // extra
        c.setUint16(32, 0, true);            // comment
        c.setUint16(34, 0, true);            // disk
        c.setUint16(36, 0, true);            // internal attrs
        c.setUint32(38, 0, true);            // external attrs
        c.setUint32(42, e.offset, true);
        new Uint8Array(c.buffer).set(e.nameBytes, 46);
        this.parts.push(new Uint8Array(c.buffer));
        cdSize += c.byteLength;
      }
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(4, 0, true);
      end.setUint16(6, 0, true);
      end.setUint16(8, this.entries.length, true);
      end.setUint16(10, this.entries.length, true);
      end.setUint32(12, cdSize, true);
      end.setUint32(16, cdStart, true);
      end.setUint16(20, 0, true);
      this.parts.push(new Uint8Array(end.buffer));
      return new Blob(this.parts, { type: 'application/zip' });
    }
  },
};

const Csv = {
  /** UTF-8（BOM 付き）・CRLF。Excel で日本語のファイル名を開いても文字化けしない。 */
  build(rows) {
    const esc = (v) => {
      const s = String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const text = '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
    return new Blob([text], { type: 'text/csv;charset=utf-8' });
  },
};
