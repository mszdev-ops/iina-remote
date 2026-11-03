#!/usr/bin/env node
// Generates the PNG icons without external packages (zlib + hand-written PNG chunks).
// A dark rounded square with a play triangle and an arc around it.
//
//   node scripts/make-icons.js

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bit, RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const BG_TOP = [38, 42, 58];
const BG_BOTTOM = [14, 15, 22];
const ACCENT = [255, 170, 60];

/** Renders the icon with 4x4 supersampling for anti-aliasing. */
function render(size, { rounded }) {
  const buf = Buffer.alloc(size * size * 4);
  const r = rounded ? size * 0.22 : 0;
  // Triangle vertices (shifted slightly right for optical centering)
  const tri = [[0.38, 0.28], [0.38, 0.72], [0.74, 0.5]].map(([x, y]) => [x * size, y * size]);
  const inTri = (x, y) => {
    const [[x1, y1], [x2, y2], [x3, y3]] = tri;
    const d1 = (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2);
    const d2 = (x - x3) * (y2 - y3) - (x2 - x3) * (y - y3);
    const d3 = (x - x1) * (y3 - y1) - (x3 - x1) * (y - y1);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  const inRoundRect = (x, y) => {
    if (!rounded) return true;
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // Arc (ring segment) around the triangle
  const ringR = size * 0.36, ringW = size * 0.045;
  const inRing = (x, y) => {
    const dx = x - size * 0.5, dy = y - size * 0.5;
    const d = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    return Math.abs(d - ringR) <= ringW / 2 && (ang < -0.35 * Math.PI || ang > 0.35 * Math.PI);
  };

  const S = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgCov = 0, fgCov = 0, ringCov = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = px + (sx + 0.5) / S, y = py + (sy + 0.5) / S;
          if (!inRoundRect(x, y)) continue;
          bgCov++;
          if (inTri(x, y)) fgCov++;
          else if (inRing(x, y)) ringCov++;
        }
      }
      const n = S * S;
      const t = py / size;
      let c = BG_TOP.map((v, i) => lerp(v, BG_BOTTOM[i], t));
      const fgA = fgCov / Math.max(bgCov, 1);
      c = c.map((v, i) => lerp(v, ACCENT[i], fgA));
      const ringA = (ringCov / Math.max(bgCov, 1)) * 0.55;
      c = c.map((v, i) => lerp(v, 255, ringA));
      const o = (py * size + px) * 4;
      buf[o] = Math.round(c[0]);
      buf[o + 1] = Math.round(c[1]);
      buf[o + 2] = Math.round(c[2]);
      buf[o + 3] = Math.round((bgCov / n) * 255);
    }
  }
  return buf;
}

const targets = [
  // iOS rounds the corners itself, so this one is a full square
  { file: 'apple-touch-icon.png', size: 180, rounded: false },
  { file: 'icon-192.png', size: 192, rounded: true },
  { file: 'icon-512.png', size: 512, rounded: true },
  // maskable: full background, content inside the safe zone
  { file: 'icon-maskable-512.png', size: 512, rounded: false },
];

for (const { file, size, rounded } of targets) {
  fs.writeFileSync(path.join(outDir, file), encodePng(size, render(size, { rounded })));
  console.log(`written: public/${file} (${size}×${size})`);
}
