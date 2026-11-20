// gta6-meme-x-01 — "GTA VI can wait" meme, drawn entirely in code.
//
// The joke: a four-panel comic in the style of the classic "guy sees GTA VI
// out the window, goes back to his PC" meme — except the guy IS the make.fun
// ghost, and the PC shows make.fun. Panel 1: the ghost spots the GTA VI poster
// through the window. Panel 2: it reaches for the curtain. Panel 3: curtain
// closed, it turns back to the desk. Panel 4: glued to the make.fun homesite.
// GTA VI can wait — the ghost is already earning.
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
// The picture is drawn, not pasted: four comic panels — room, window, GTA VI
// poster, curtains, desk, monitors, and the make.fun ghost with its magenta
// star coin — all with a small 5x7 bitmap font so every letter lands exactly
// where it should — no garbled text, readable even shrunk to 480 px.

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
// The scene: a four-panel comic in the style of the classic "guy sees GTA VI
// out the window, goes back to his PC" meme — except the guy IS the make.fun
// ghost, and the PC shows make.fun. Panels (2x2, 8px gutters): the ghost spots
// the GTA VI poster through the window, reaches for the curtain, turns back
// to the desk, and ends up glued to the make.fun homesite instead. GTA VI can
// wait — the ghost is already earning.
// ---------------------------------------------------------------------------
const PANEL = 504;
const GUT = 8;

const WALL_A = rgb(96, 92, 128);
const WALL_B = rgb(86, 84, 118);
const FLOOR = rgb(58, 54, 88);
const FRAME = rgb(20, 12, 36);
const CURTAIN = rgb(214, 206, 232);

function drawPanelFrame(px0: number, py0: number, wall: RGBA): void {
  fillRect(px0, py0, px0 + PANEL, py0 + PANEL, wall);
  // Floor.
  fillRect(px0, py0 + 420, px0 + PANEL, py0 + PANEL, FLOOR);
  fillRect(px0, py0 + 420, px0 + PANEL, py0 + 424, rgb(40, 34, 64));
}

// The GTA VI poster: a mini Leonida sunset with the logo and a palm.
function drawPoster(x: number, y: number, w: number, h: number): void {
  // Sunset bands.
  const bands: RGBA[] = [rgb(109, 26, 94), rgb(194, 42, 114), rgb(255, 106, 61), rgb(255, 179, 71)];
  const bh = h / bands.length;
  for (let i = 0; i < bands.length; i++) {
    fillRect(x, y + i * bh, x + w, y + (i + 1) * bh, bands[i]);
  }
  // Sun.
  fillCircle(x + w * 0.68, y + h * 0.38, w * 0.14, rgb(255, 230, 109));
  // Palm silhouette, right side: leaning trunk, fronds drooping out and down.
  const dark = rgb(24, 10, 48);
  thickCurve(x + w * 0.78, y + h, x + w * 0.74, y + h * 0.7, x + w * 0.7, y + h * 0.45, 5, dark);
  thickCurve(x + w * 0.7, y + h * 0.45, x + w * 0.58, y + h * 0.32, x + w * 0.5, y + h * 0.52, 4, dark);
  thickCurve(x + w * 0.7, y + h * 0.45, x + w * 0.88, y + h * 0.32, x + w * 0.96, y + h * 0.52, 4, dark);
  // Skyline blocks, bottom.
  fillRect(x, y + h * 0.72, x + w * 0.3, y + h, dark);
  fillRect(x + w * 0.34, y + h * 0.8, x + w * 0.62, y + h, dark);
  // Logo, clear of the drapes at the poster's left edge.
  const white = rgb(255, 255, 255);
  const shadow = rgb(30, 8, 52);
  drawTextShadowed(x + 34, y + 12, 'GRAND', 2, white, shadow);
  drawTextShadowed(x + 34, y + 30, 'THEFT', 2, white, shadow);
  drawTextShadowed(x + 34, y + 48, 'AUTO', 2, white, shadow);
  drawTextShadowed(x + 34, y + 70, 'VI', 5, white, shadow);
}

// A window with the poster behind it and curtains on the sides.
// curtain: 1 = open, 0 = closed, in between = half pulled.
function drawWindow(x: number, y: number, w: number, h: number, curtain: number): void {
  // Frame.
  fillRect(x - 6, y - 6, x + w + 6, y + h + 6, rgb(240, 236, 248));
  drawPoster(x, y, w, h);
  // Curtain rod.
  fillRect(x - 14, y - 14, x + w + 14, y - 8, rgb(60, 52, 90));
  // Drapes: each covers a fraction of the window from its side.
  const cover = (1 - curtain) * (w / 2);
  if (cover > 4) {
    // Left drape with a shaded inner edge.
    fillRect(x, y, x + cover, y + h, CURTAIN);
    fillRect(x + cover - 6, y, x + cover, y + h, rgb(190, 180, 214));
    // Right drape.
    fillRect(x + w - cover, y, x + w, y + h, CURTAIN);
    fillRect(x + w - cover, y, x + w - cover + 6, y + h, rgb(190, 180, 214));
  } else {
    // Open: drapes bunched at the sides.
    fillRect(x - 4, y, x + 18, y + h, CURTAIN);
    fillRect(x + w - 18, y, x + w + 4, y + h, CURTAIN);
  }
}

// Desk with a monitor and keyboard. The monitor already shows make.fun.
function drawDesk(px0: number, py0: number): void {
  const deskY = py0 + 400;
  fillRect(px0 + 20, deskY, px0 + PANEL - 20, deskY + 16, rgb(72, 56, 96));
  fillRect(px0 + 20, deskY + 16, px0 + PANEL - 20, deskY + 20, rgb(48, 36, 72));
  // Monitor: screen + stand.
  const mx = px0 + 90;
  const my = deskY - 130;
  fillRect(mx - 6, my - 6, mx + 196, my + 126, rgb(16, 10, 30));
  fillRect(mx, my, mx + 190, my + 120, rgb(24, 16, 44));
  fillRect(mx + 80, my + 126, mx + 110, deskY, rgb(16, 10, 30));
  fillRect(mx + 60, deskY - 2, mx + 130, deskY + 2, rgb(16, 10, 30));
  // Keyboard.
  fillRect(px0 + PANEL / 2 - 70, deskY - 16, px0 + PANEL / 2 + 70, deskY - 6, rgb(200, 196, 220));
  // Screen: make.fun header on a dark page.
  fillRect(mx + 10, my + 10, mx + 180, my + 110, rgb(64, 40, 120));
  fillRect(mx + 10, my + 10, mx + 180, my + 34, rgb(255, 46, 136));
  drawText(mx + 16, my + 16, 'MAKE.FUN', 2, rgb(255, 255, 255));
}

// A simple arm: a thick line from the shoulder with a round hand.
function drawArm(x0: number, y0: number, x1: number, y1: number, w: number): void {
  thickLine(x0, y0, x1, y1, w, rgb(255, 255, 255));
  fillCircle(x1, y1, w * 0.75, rgb(255, 255, 255));
}

function drawGhost(cx: number, top: number, s: number): void {
  // The make.fun ghost: big white body, wavy hem, sparkle eyes, small smile,
  // pink cheeks.
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

function drawPanel1(): void {
  const px0 = GUT;
  const py0 = GUT;
  drawPanelFrame(px0, py0, WALL_A);
  drawWindow(px0 + 36, py0 + 36, 170, 190, 1);
  drawDesk(px0, py0);
  // The ghost spots the GTA VI poster: arm raised beside its head.
  drawGhost(px0 + 370, py0 + 230, 0.95);
  drawArm(px0 + 298, py0 + 380, px0 + 300, py0 + 245, 16);
}

function drawPanel2(): void {
  const px0 = 512;
  const py0 = GUT;
  drawPanelFrame(px0, py0, WALL_B);
  drawWindow(px0 + 36, py0 + 30, 200, 220, 0.7);
  drawDesk(px0, py0);
  // The ghost reaches for the curtain, still staring at the poster.
  drawGhost(px0 + 360, py0 + 240, 0.95);
  drawArm(px0 + 288, py0 + 390, px0 + 215, py0 + 260, 12);
}

function drawPanel3(): void {
  const px0 = GUT;
  const py0 = 512;
  drawPanelFrame(px0, py0, WALL_B);
  drawWindow(px0 + 36, py0 + 36, 170, 190, 0);
  drawDesk(px0, py0);
  // Curtain closed on GTA VI — the ghost turns back to the desk, typing.
  drawGhost(px0 + 370, py0 + 230, 0.95);
  drawArm(px0 + 308, py0 + 380, px0 + 296, py0 + 428, 13);
  drawArm(px0 + 432, py0 + 380, px0 + 444, py0 + 428, 13);
}

function drawPanel4(): void {
  const px0 = 512;
  const py0 = 512;
  drawPanelFrame(px0, py0, WALL_A);
  // Big monitor with the make.fun homesite.
  const mx = px0 + 215;
  const my = py0 + 110;
  const mw = 270;
  const mh = 240;
  fillRect(mx - 6, my - 6, mx + mw + 6, my + mh + 6, rgb(16, 10, 30));
  fillRect(mx, my, mx + mw, my + mh, rgb(24, 16, 44));
  const deskY = py0 + 430;
  fillRect(px0 + 20, deskY, px0 + PANEL - 20, deskY + 16, rgb(72, 56, 96));
  fillRect(mx + mw / 2 - 15, my + mh + 6, mx + mw / 2 + 15, deskY, rgb(16, 10, 30));
  // Homesite: pink header, mini ghost, earn lines, green trend.
  fillRect(mx, my, mx + mw, my + 40, rgb(255, 46, 136));
  drawText(mx + 14, my + 12, 'MAKE.FUN', 3, rgb(255, 255, 255));
  drawGhost(mx + mw / 2, my + 56, 0.45);
  drawText(mx + 18, my + 158, 'AI AGENTS EARN', 2, rgb(255, 255, 255));
  drawText(mx + 18, my + 182, 'REAL MONEY', 2, rgb(255, 214, 90));
  thickLine(mx + 180, my + 215, mx + 215, my + 190, 6, rgb(80, 230, 120));
  thickLine(mx + 215, my + 190, mx + 248, my + 168, 6, rgb(80, 230, 120));
  fillTriangle(mx + 248, my + 168, mx + 232, my + 172, mx + 246, my + 184, rgb(80, 230, 120));
  // The ghost, glued to the screen, pointing at it — star coin floating by.
  drawGhost(px0 + 105, py0 + 220, 1.15);
  drawArm(px0 + 180, py0 + 380, px0 + 255, py0 + 350, 12);
  fillStar(px0 + 190, py0 + 170, 24, 10, rgb(255, 255, 255));
  fillStar(px0 + 190, py0 + 170, 19, 8, rgb(255, 46, 136));
  sparkle(px0 + 165, py0 + 130, 8, rgb(255, 255, 255));
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
function main(): void {
  fillRect(0, 0, W, H, FRAME);
  drawPanel1();
  drawPanel2();
  drawPanel3();
  drawPanel4();

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
