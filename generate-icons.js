#!/usr/bin/env node
// Run: node generate-icons.js
// Generates icons/icon16.png, icons/icon48.png, icons/icon128.png

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 table
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([l, t, data, c]);
}

function makePNG(size, drawFn) {
  const px = new Uint8Array(size * size * 4).fill(0);
  drawFn(px, size);

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = y * (size * 4 + 1) + 1 + x * 4;
      raw[dst] = px[src]; raw[dst + 1] = px[src + 1];
      raw[dst + 2] = px[src + 2]; raw[dst + 3] = px[src + 3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function setpx(px, size, x, y, r, g, b, a = 255) {
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const i = (y * size + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

function fillRect(px, size, x, y, w, h, r, g, b, a = 255) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      setpx(px, size, Math.floor(x + dx), Math.floor(y + dy), r, g, b, a);
}

function fillCircle(px, size, cx, cy, radius, r, g, b, a = 255) {
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++)
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2)
        setpx(px, size, x, y, r, g, b, a);
}

function fillRoundRect(px, size, x, y, w, h, rx, r, g, b, a = 255) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      let skip = false;
      if (dx < rx && dy < rx) skip = (dx - rx) ** 2 + (dy - rx) ** 2 > rx * rx;
      else if (dx >= w - rx && dy < rx) skip = (dx - (w - rx - 1)) ** 2 + (dy - rx) ** 2 > rx * rx;
      else if (dx < rx && dy >= h - rx) skip = (dx - rx) ** 2 + (dy - (h - rx - 1)) ** 2 > rx * rx;
      else if (dx >= w - rx && dy >= h - rx) skip = (dx - (w - rx - 1)) ** 2 + (dy - (h - rx - 1)) ** 2 > rx * rx;
      if (!skip) setpx(px, size, Math.floor(x + dx), Math.floor(y + dy), r, g, b, a);
    }
  }
}

function drawVaultIcon(px, size) {
  const s = size / 128;

  // Transparent background
  // Rounded royal blue background
  fillRoundRect(px, size, 0, 0, size, size, Math.floor(22 * s), 65, 105, 225, 255);

  // Vault door face (lighter purple)
  fillRoundRect(px, size,
    Math.floor(16 * s), Math.floor(16 * s),
    Math.floor(96 * s), Math.floor(96 * s),
    Math.floor(12 * s), 82, 126, 245, 255);

  // Outer dial ring
  fillCircle(px, size, Math.floor(64 * s), Math.floor(64 * s), Math.floor(24 * s), 13, 13, 20, 255);
  // Inner dial ring
  fillCircle(px, size, Math.floor(64 * s), Math.floor(64 * s), Math.floor(18 * s), 226, 224, 240, 255);
  // Dial center
  fillCircle(px, size, Math.floor(64 * s), Math.floor(64 * s), Math.floor(9 * s), 65, 105, 225, 255);

  // Bolt holes
  const bolts = [[32, 32], [96, 32], [32, 96], [96, 96]];
  for (const [bx, by] of bolts) {
    fillCircle(px, size, Math.floor(bx * s), Math.floor(by * s), Math.floor(6 * s), 13, 13, 20, 255);
    fillCircle(px, size, Math.floor(bx * s), Math.floor(by * s), Math.floor(4 * s), 200, 190, 240, 200);
  }
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

for (const size of [16, 48, 128]) {
  const png = makePNG(size, drawVaultIcon);
  const fp = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(fp, png);
  console.log(`Created ${fp} (${png.length} bytes)`);
}
console.log('Icons generated!');
