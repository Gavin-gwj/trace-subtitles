// 生成扩展图标（纯 Node，无依赖）：圆角渐变方块 + 白色 "T"
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const R = size * 0.22; // 圆角半径

  const inRoundRect = (x, y) => {
    const min = R, max = size - R;
    if (x >= min && x <= max) return y >= 0 && y <= size;
    if (y >= min && y <= max) return x >= 0 && x <= size;
    const cx = x < min ? min : max;
    const cy = y < min ? min : max;
    return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
  };

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const o = rowStart + 1 + x * 4;
      if (!inRoundRect(x + 0.5, y + 0.5)) {
        raw[o] = raw[o + 1] = raw[o + 2] = raw[o + 3] = 0;
        continue;
      }
      // 135° 渐变 #4c8dff -> #7c4dff
      const t = (x + y) / (2 * size);
      const r = Math.round(0x4c + (0x7c - 0x4c) * t);
      const g = Math.round(0x8d + (0x4d - 0x8d) * t);
      const b = Math.round(0xff + (0xff - 0xff) * t);

      // 白色 "T"
      const cx = size / 2;
      const barW = size * 0.46;
      const barH = size * 0.115;
      const topY = size * 0.27;
      const stemW = size * 0.115;
      const stemH = size * 0.44;

      const inTopBar =
        Math.abs(x + 0.5 - cx) <= barW / 2 &&
        y + 0.5 >= topY &&
        y + 0.5 <= topY + barH;
      const inStem =
        Math.abs(x + 0.5 - cx) <= stemW / 2 &&
        y + 0.5 >= topY &&
        y + 0.5 <= topY + stemH;

      if (inTopBar || inStem) {
        raw[o] = 255; raw[o + 1] = 255; raw[o + 2] = 255; raw[o + 3] = 255;
      } else {
        raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, 'trace-subtitles', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  const buf = png(s);
  fs.writeFileSync(path.join(dir, `icon${s}.png`), buf);
  console.log(`icon${s}.png ${buf.length} bytes`);
}
