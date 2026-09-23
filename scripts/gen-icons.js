'use strict';
// 生成应用图标: build/icon.png (512) + build/icon.ico (256, PNG-in-ICO)
// 设计: 深色药丸 (灵动岛) + 白色八分音符, 2x 超采样抗锯齿。electron-builder 自动转换
// png → linux 图标 / mac icns / win ico 资源。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 形状判定 ----
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx, dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 512 逻辑坐标: 药丸 (48,140)-(464,372) + 白色音符
const PILL = { x0: 48, y0: 140, x1: 464, y1: 372, r: 116 };
const HEAD = { cx: 176, cy: 300, rx: 42, ry: 34 };
const STEM = { x0: 210, x1: 228, y0: 150, y1: 308 };
const FLAG = [[228, 150], [326, 186], [296, 268], [228, 212]];

function sampleAt(x, y) {
  const inPill = inRoundedRect(x, y, PILL.x0, PILL.y0, PILL.x1, PILL.y1, PILL.r);
  if (!inPill) return [0, 0, 0, 0];
  const inNote = inEllipse(x, y, HEAD.cx, HEAD.cy, HEAD.rx, HEAD.ry) ||
    inRect(x, y, STEM.x0, STEM.y0, STEM.x1, STEM.y1) ||
    inPolygon(x, y, FLAG);
  if (inNote) return [255, 255, 255, 255];
  const inBorder = !inRoundedRect(x, y, PILL.x0 + 5, PILL.y0 + 5, PILL.x1 - 5, PILL.y1 - 5, PILL.r - 5);
  if (inBorder) return [255, 255, 255, 46]; // 描边 rgba(255,255,255,.18)
  return [20, 18, 24, 255];                 // 药丸填充 #141218
}

function render(size, ss) {
  const big = size * ss;
  const buf = Buffer.alloc(big * big * 4);
  for (let y = 0; y < big; y++) {
    const ly = (y + 0.5) / ss;
    for (let x = 0; x < big; x++) {
      const lx = (x + 0.5) / ss;
      const [r, g, b, a] = sampleAt(lx, ly);
      const o = (y * big + x) * 4;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  const n = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const o = ((y * ss + dy) * big + (x * ss + dx)) * 4;
          r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; a += buf[o + 3];
        }
      }
      const o = (y * size + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

// ICO 携带 PNG 条目 (Vista+), 256 用 0 表示
function buildIco(png256) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);  // reserved
  header.writeUInt16LE(1, 2);  // type: icon
  header.writeUInt16LE(1, 4);  // count
  const entry = Buffer.alloc(16);
  entry[0] = 0;  // width 256
  entry[1] = 0;  // height 256
  entry[2] = 0;  // colors
  entry[3] = 0;  // reserved
  entry.writeUInt16LE(1, 4);               // planes
  entry.writeUInt16LE(32, 6);              // bpp
  entry.writeUInt32LE(png256.length, 8);   // bytes in res
  entry.writeUInt32LE(22, 12);             // offset = 6 + 16
  return Buffer.concat([header, entry, png256]);
}

module.exports = { encodePNG, render, buildIco };

if (require.main === module) {
  const png512 = encodePNG(512, 512, render(512, 2));
  const png256 = encodePNG(256, 256, render(256, 4));
  const ico = buildIco(png256);
  const outDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'icon.png'), png512);
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
  console.log('[icons] build/icon.png', png512.length, 'B | build/icon.ico', ico.length, 'B');
}
