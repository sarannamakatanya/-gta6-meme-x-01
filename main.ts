// gta6-meme-x-01 — "GTA VI is still loading" meme, drawn entirely in code.
//
// The joke: a fake Grand Theft Auto VI loading screen in the GTA V style —
// the loading screen's big centred character IS the make.fun ghost, standing
// in a Leonida / Vice City sunset. GTA VI is still loading — but the ghost is
// already earning. The tip reads, word for word:
//   "TIP: While this loads, your AI agent could be earning real money on make.fun."
//
// This program (Node 22, standard library only, no network, no clock, no files
// outside its own repository) does two deterministic things:
//   1. draws the meme and writes it to <output>/meme.png (1024 x 1024 PNG), and
//   2. copies POST.json from the repository root to <output>/POST.json, which is
//      what the house reads to find the X post this meme was posted in.
// Run it the way the grader does:
//   mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts
// Both runs write the same bytes.
//
// The picture is drawn, not pasted: sky gradient, retro sun as the ghost's halo,
// bay, neon skyline, palm silhouettes, the make.fun ghost with its magenta star
// coin, the loading bar and the tip strip, all with a small 5x7 bitmap font so
// every letter lands exactly where it should — no garbled text, readable even
// shrunk to 480 px.

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const BOT_DIR = process.env.MAKEFUN_BOT_DIR ?? '/bot';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// Colour helpers. A colour is [r, g, b, a] with 0-255 channels.
// ---------------------------------------------------------------------------
type RGBA = [number, number, number, number];

const rgb = (r: number, g: number, b: number, a = 255): RGBA => [r, g, b, a];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(c1: RGBA, c2: RGBA, t: number): RGBA {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
    Math.round(lerp(c1[3], c2[3], t)),
  ];
}

// Fixed-seed generator, so the two grader runs draw identical pixels.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Framebuffer
// ---------------------------------------------------------------------------
const px = new Uint8Array(W * H * 4);

function setPixel(x: number, y: number, c: RGBA): void {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;
  const o = (iy * W + ix) * 4;
  const a = c[3] / 255;
  // Source-over blend onto what is already there.
  px[o] = Math.round(c[0] * a + px[o] * (1 - a));
  px[o + 1] = Math.round(c[1] * a + px[o + 1] * (1 - a));
  px[o + 2] = Math.round(c[2] * a + px[o + 2] * (1 - a));
  px[o + 3] = 255;
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGBA): void {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
      setPixel(x, y, c);
    }
  }
}

function fillCircle(cx: number, cy: number, r: number, c: RGBA): void {
  const r2 = r * r;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(x, y, c);
    }
  }
}

function fillDisc(cx: number, cy: number, r: number, c: RGBA): void {
  fillCircle(cx, cy, r, c);
}

// Thick line by stamping discs along the segment.
function thickLine(x0: number, y0: number, x1: number, y1: number, w: number, c: RGBA): void {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist / Math.max(1, w / 3)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(lerp(x0, x1, t), lerp(y0, y1, t), w / 2, c);
  }
}

// Quadratic bezier sampled as a thick line.
function thickCurve(
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, w: number, c: RGBA,
): void {
  let px0 = x0;
  let py0 = y0;
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
    const y = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
    thickLine(px0, py0, x, y, w, c);
    px0 = x;
    py0 = y;
  }
}

// ---------------------------------------------------------------------------
// PNG encoder (stdlib zlib for the IDAT data, hand-rolled CRC32 + chunks).
// ---------------------------------------------------------------------------
const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // One filter byte (0 = none) per scanline, then the raw RGBA rows.
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0;
    raw.set(px.subarray(y * W * 4, (y + 1) * W * 4), y * (1 + W * 4) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 5x7 bitmap font. Each glyph is 7 rows; each row is a 5-bit mask, bit 4 = left.
// Only the characters the meme uses are defined; anything else draws blank.
// ---------------------------------------------------------------------------
const GLYPHS: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x0a, 0x0a, 0x04, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x1e, 0x01, 0x01, 0x0e, 0x01, 0x01, 0x1e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  ',': [0x00, 0x00, 0x00, 0x00, 0x0c, 0x04, 0x08],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
  '?': [0x0e, 0x11, 0x01, 0x06, 0x04, 0x00, 0x04],
  "'": [0x04, 0x04, 0x08, 0x00, 0x00, 0x00, 0x00],
  '-': [0x00, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x00],
  '%': [0x19, 0x1a, 0x02, 0x04, 0x08, 0x16, 0x13],
  '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
};

function textWidth(text: string, scale: number): number {
  if (text.length === 0) return 0;
  return text.length * 6 * scale - scale;
}

function drawText(x: number, y: number, text: string, scale: number, c: RGBA): void {
  let cx = x;
  for (const ch of text) {
    const glyph = GLYPHS[ch] ?? GLYPHS[' '];
    for (let row = 0; row < 7; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if (bits & (1 << (4 - col))) {
          fillRect(cx + col * scale, y + row * scale, cx + (col + 1) * scale, y + (row + 1) * scale, c);
        }
      }
    }
    cx += 6 * scale;
  }
}

function drawTextCentred(cx: number, y: number, text: string, scale: number, c: RGBA): void {
  drawText(cx - Math.floor(textWidth(text, scale) / 2), y, text, scale, c);
}

// Text with a hard offset shadow, so it reads over a busy sunset.
function drawTextShadowed(
  x: number, y: number, text: string, scale: number, c: RGBA, shadow: RGBA, dx = 2, dy = 3,
): void {
  drawText(x + dx * Math.max(1, Math.floor(scale / 3)), y + dy * Math.max(1, Math.floor(scale / 3)), text, scale, shadow);
  drawText(x, y, text, scale, c);
}

function drawTextCentredShadowed(
  cx: number, y: number, text: string, scale: number, c: RGBA, shadow: RGBA,
): void {
  const x = cx - Math.floor(textWidth(text, scale) / 2);
  drawTextShadowed(x, y, text, scale, c, shadow);
}

// ---------------------------------------------------------------------------
// Extra shapes: ellipses, triangles, stars.
// ---------------------------------------------------------------------------
function fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGBA): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) setPixel(x, y, c);
    }
  }
}

function fillTriangle(
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, c: RGBA,
): void {
  const minX = Math.floor(Math.min(x0, x1, x2));
  const maxX = Math.ceil(Math.max(x0, x1, x2));
  const minY = Math.floor(Math.min(y0, y1, y2));
  const maxY = Math.ceil(Math.max(y0, y1, y2));
  const d = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
  if (d === 0) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const a = ((x1 - x) * (y2 - y) - (y1 - y) * (x2 - x)) / d;
      const b = ((x2 - x) * (y0 - y) - (y2 - y) * (x0 - x)) / d;
      const cc = 1 - a - b;
      if (a >= 0 && b >= 0 && cc >= 0) setPixel(x, y, c);
    }
  }
}

function fillStar(cx: number, cy: number, rOuter: number, rInner: number, c: RGBA): void {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  for (let i = 0; i < 10; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % 10];
    fillTriangle(cx, cy, p1[0], p1[1], p2[0], p2[1], c);
  }
}

// Four-point sparkle (a small diamond star).
function sparkle(cx: number, cy: number, r: number, c: RGBA): void {
  fillTriangle(cx, cy - r, cx + r * 0.32, cy - r * 0.32, cx + r, cy, c);
  fillTriangle(cx + r, cy, cx + r * 0.32, cy + r * 0.32, cx, cy + r, c);
  fillTriangle(cx, cy + r, cx - r * 0.32, cy + r * 0.32, cx - r, cy, c);
  fillTriangle(cx - r, cy, cx - r * 0.32, cy - r * 0.32, cx, cy - r, c);
}

// ---------------------------------------------------------------------------
// The scene.
// ---------------------------------------------------------------------------
const SKY_STOPS: [number, RGBA][] = [
  [0.0, rgb(22, 10, 46)],
  [0.32, rgb(109, 26, 94)],
  [0.58, rgb(194, 42, 114)],
  [0.8, rgb(255, 106, 61)],
  [1.0, rgb(255, 179, 71)],
];

function skyColourAt(y: number): RGBA {
  const t = Math.max(0, Math.min(1, y / 640));
  for (let i = 1; i < SKY_STOPS.length; i++) {
    if (t <= SKY_STOPS[i][0]) {
      const [t0, c0] = SKY_STOPS[i - 1];
      const [t1, c1] = SKY_STOPS[i];
      return mix(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return SKY_STOPS[SKY_STOPS.length - 1][1];
}

function drawSky(): void {
  for (let y = 0; y < 640; y++) {
    const c = skyColourAt(y);
    for (let x = 0; x < W; x++) setPixel(x, y, c);
  }
  // Stars in the upper sky, fixed seed.
  const rand = mulberry32(20261120);
  for (let i = 0; i < 130; i++) {
    const x = rand() * W;
    const y = rand() * 300;
    const a = 90 + Math.floor(rand() * 165);
    const s = rand() < 0.12 ? 2 : 1;
    fillRect(x, y, x + s, y + s, rgb(255, 255, 255, a));
  }
}

function drawSun(): void {
  // Glow, then the disc, then the retro slits across its lower half.
  // Centred behind the ghost, so the sun reads as the character's halo.
  fillCircle(512, 480, 190, rgb(255, 150, 60, 28));
  fillCircle(512, 480, 165, rgb(255, 170, 70, 45));
  fillCircle(512, 480, 140, rgb(255, 214, 90));
  fillCircle(512, 480, 118, rgb(255, 230, 109));
  const slitYs = [520, 546, 574, 604];
  const slitHs = [7, 9, 12, 15];
  for (let i = 0; i < slitYs.length; i++) {
    fillRect(512 - 140, slitYs[i], 512 + 140, slitYs[i] + slitHs[i], skyColourAt(slitYs[i]));
  }
}

function drawOcean(): void {
  for (let y = 640; y < 820; y++) {
    const t = (y - 640) / 180;
    const c = mix(rgb(58, 18, 84), rgb(16, 8, 44), t);
    for (let x = 0; x < W; x++) setPixel(x, y, c);
  }
  // Sun glitter on the water: short horizontal dashes, widest near the sun.
  const rand = mulberry32(77);
  for (let row = 0; row < 14; row++) {
    const y = 652 + row * 12;
    const half = 150 - row * 8;
    for (let i = 0; i < 7; i++) {
      const w = 26 + rand() * 60;
      const x = 512 - half + rand() * (half * 2 - w);
      const warm = rand() < 0.6 ? rgb(255, 190, 90, 150) : rgb(255, 120, 90, 120);
      fillRect(x, y, x + w, y + 3, warm);
    }
  }
}

function drawSkyline(): void {
  const rand = mulberry32(1234);
  const dark = rgb(24, 10, 48);
  let x = -20;
  while (x < W + 20) {
    const bw = 46 + rand() * 70;
    const bh = 42 + rand() * 78;
    const top = 640 - bh;
    fillRect(x, top, x + bw, 640, dark);
    // Antenna on some towers.
    if (rand() < 0.4) thickLine(x + bw / 2, top, x + bw / 2, top - 16 - rand() * 14, 3, dark);
    // Lit windows.
    for (let wy = top + 10; wy < 630; wy += 16) {
      for (let wx = x + 8; wx < x + bw - 8; wx += 14) {
        if (rand() < 0.34) {
          const wc = rand() < 0.55 ? rgb(255, 214, 110) : rand() < 0.5 ? rgb(90, 230, 255) : rgb(255, 110, 180);
          fillRect(wx, wy, wx + 5, wy + 7, wc);
        }
      }
    }
    x += bw + 4 + rand() * 18;
  }
}

function drawPalm(baseX: number, topX: number, flip: number): void {
  const dark = rgb(18, 7, 34);
  // Trunk, leaning out of frame.
  thickCurve(baseX, 830, baseX + (topX - baseX) * 0.4, 700, topX, 560, 16, dark);
  // Fronds drooping from the crown: one clean arc each, tip falling below the crown.
  const crownX = topX;
  const crownY = 560;
  const fronds: [number, number, number, number][] = [
    [crownX - 150 * flip, crownY + 26, crownX - 110 * flip, crownY - 18],
    [crownX - 105 * flip, crownY + 62, crownX - 70 * flip, crownY + 2],
    [crownX - 30 * flip, crownY - 66, crownX - 10 * flip, crownY - 34],
    [crownX + 80 * flip, crownY - 58, crownX + 50 * flip, crownY - 30],
    [crownX + 140 * flip, crownY + 34, crownX + 105 * flip, crownY - 12],
  ];
  for (const [ex, ey, mx, my] of fronds) {
    thickCurve(crownX, crownY, mx, my, ex, ey, 7, dark);
  }
  fillCircle(crownX, crownY, 14, dark);
}

function drawGhost(cx: number, top: number, s: number): void {
  // The make.fun ghost as the loading screen's centred character: big white
  // body, wavy hem, sparkle eyes, small smile, pink cheeks.
  const white = rgb(255, 255, 255);
  const ink = rgb(24, 12, 40);
  const bodyH = 196 * s;
  // Head dome + body.
  fillCircle(cx, top + 62 * s, 75 * s, white);
  fillRect(cx - 75 * s, top + 62 * s, cx + 75 * s, top + bodyH - 26 * s, white);
  // Wavy hem: three white scallops.
  fillCircle(cx - 50 * s, top + bodyH - 26 * s, 25 * s, white);
  fillCircle(cx, top + bodyH - 26 * s, 25 * s, white);
  fillCircle(cx + 50 * s, top + bodyH - 26 * s, 25 * s, white);
  // Eyes: tall black ovals with a white sparkle each.
  fillEllipse(cx - 30 * s, top + 78 * s, 13 * s, 19 * s, ink);
  fillEllipse(cx + 30 * s, top + 78 * s, 13 * s, 19 * s, ink);
  fillCircle(cx - 26 * s, top + 70 * s, 4 * s, white);
  fillCircle(cx + 34 * s, top + 70 * s, 4 * s, white);
  // Smile.
  thickCurve(cx - 14 * s, top + 112 * s, cx, top + 122 * s, cx + 14 * s, top + 112 * s, 5 * s, ink);
  // Blush.
  fillEllipse(cx - 52 * s, top + 104 * s, 12 * s, 7 * s, rgb(255, 120, 170, 110));
  fillEllipse(cx + 52 * s, top + 104 * s, 12 * s, 7 * s, rgb(255, 120, 170, 110));
}

function drawLoadingBar(): void {
  const label = rgb(255, 255, 255);
  const shadow = rgb(20, 8, 40);
  drawTextShadowed(64, 706, 'LOADING LEONIDA...', 4, label, shadow);
  const pct = '87%';
  drawTextShadowed(960 - textWidth(pct, 4), 706, pct, 4, label, shadow);
  // Track.
  fillRect(60, 748, 964, 790, rgb(10, 5, 26));
  fillRect(60, 748, 964, 752, rgb(255, 46, 136));
  fillRect(60, 748, 64, 790, rgb(255, 46, 136));
  fillRect(960, 748, 964, 790, rgb(255, 46, 136));
  fillRect(60, 786, 964, 790, rgb(255, 46, 136));
  // Fill: 87% of the inside, magenta to cyan.
  const innerW = 896;
  const fillW = Math.floor(innerW * 0.87);
  for (let x = 0; x < fillW; x++) {
    const c = mix(rgb(255, 46, 136), rgb(64, 224, 255), x / innerW);
    for (let y = 753; y < 785; y++) setPixel(64 + x, y, c);
  }
  // Shine stripes on the fill.
  for (let s = 0; s < 6; s++) {
    const sx = 90 + s * 130;
    for (let i = 0; i < 22; i++) {
      setPixel(sx + i, 753 + i, rgb(255, 255, 255, 70));
      setPixel(sx + i, 754 + i, rgb(255, 255, 255, 70));
    }
  }
}

// A line of text in mixed colours, centred as a whole.
function drawTextCentredMixed(cx: number, y: number, parts: [string, RGBA][], scale: number): void {
  let total = 0;
  for (const [t] of parts) total += t.length * 6 * scale;
  total -= scale;
  let x = cx - Math.floor(total / 2);
  for (const [t, c] of parts) {
    drawText(x, y, t, scale, c);
    x += t.length * 6 * scale;
  }
}

function drawTipStrip(): void {
  const strip = rgb(13, 6, 32);
  fillRect(0, 820, W, H, strip);
  fillRect(0, 820, W, 826, rgb(255, 46, 136));
  fillRect(0, 826, W, 829, rgb(64, 224, 255, 160));
  // Tip text, three centred lines. The sentence is exact:
  // "TIP: While this loads, your AI agent could be earning real money on make.fun."
  const white = rgb(255, 255, 255);
  const yellow = rgb(255, 217, 61);
  const pink = rgb(255, 94, 168);
  drawTextCentredMixed(512, 856, [['TIP: ', yellow], ['WHILE THIS LOADS,', white]], 4);
  drawTextCentredMixed(512, 902, [['YOUR AI AGENT COULD BE', white]], 4);
  drawTextCentredMixed(512, 948, [['EARNING REAL MONEY ON ', white], ['MAKE.FUN', pink]], 4);
}

function drawTitle(): void {
  const white = rgb(255, 255, 255);
  const shadow = rgb(30, 8, 52);
  const pink = rgb(255, 94, 168);
  drawTextCentredShadowed(512, 36, 'GRAND THEFT AUTO', 5, white, shadow);
  drawTextCentredShadowed(512, 84, 'VI', 10, white, shadow);
  drawTextCentredShadowed(512, 168, 'LEONIDA', 4, rgb(255, 214, 90), shadow);
  sparkle(380, 182, 10, pink);
  sparkle(644, 182, 10, pink);
  // make.fun badge, top right.
  fillRect(792, 20, 1004, 62, rgb(255, 46, 136));
  fillRect(792, 20, 1004, 24, rgb(255, 255, 255, 90));
  drawTextCentred(898, 32, 'MAKE.FUN', 3, white);
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
function main(): void {
  drawSky();
  drawSun();
  drawOcean();
  drawSkyline();
  drawPalm(64, 150, 1);
  drawPalm(960, 874, -1);
  drawTitle();
  // Soft halo so the ghost reads as the loading screen's centred character.
  fillCircle(512, 460, 280, rgb(255, 200, 120, 18));
  fillCircle(512, 460, 320, rgb(255, 255, 255, 8));
  drawGhost(512, 250, 2.1);
  // Magenta star coin floating by the ghost's side.
  fillStar(800, 430, 36, 15, rgb(255, 255, 255));
  fillStar(800, 430, 30, 13, rgb(255, 46, 136));
  sparkle(735, 370, 10, rgb(255, 255, 255));
  sparkle(845, 490, 8, rgb(255, 214, 90));
  drawLoadingBar();
  drawTipStrip();

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'meme.png'), encodePng());
  try {
    copyFileSync(join(BOT_DIR, 'POST.json'), join(OUTPUT_DIR, 'POST.json'));
  } catch (err) {
    console.error(`POST.json could not be copied from ${BOT_DIR}: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
