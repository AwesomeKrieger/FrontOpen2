/**
 * Appends the Robot Factory glyph to resources/atlases/icon-atlas.png (col 6).
 *
 * The structure atlas is a 64px-tall row of 64px-wide cells, one column per
 * structure type (see StructurePass.ts STRUCTURE_ORDER). The base atlas
 * (columns 0-5) is pre-built upstream; this script only EXTENDS the row.
 *
 * Dependency-free: the PNG is decoded/re-encoded with node:zlib (8-bit RGBA,
 * non-interlaced, same subset as add-unit-atlas-cols.mjs).
 *
 * Icons are WHITE on transparent (the structure shader tints the glyph with
 * player colors). Spacing rules: glyph is a gear ring with an inner core —
 * draw with simple symmetric primitives.
 *
 * Usage: node scripts/add-icon-atlas-col.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

const ATLAS_URL = "resources/atlases/icon-atlas.png";
const CELL = 64;

function readPng(file) {
  const all = readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!all.subarray(0, 8).equals(sig)) throw new Error("bad PNG signature");
  let i = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (i < all.length) {
    let len = all.readUInt32BE(i);
    const type = all.subarray(i + 4, i + 8);
    const typeStr = type.toString("ascii");
    if (typeStr === "IEND") break;
    const payload = all.subarray(i + 8, i + 8 + len);
    if (typeStr === "IHDR") {
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      bitDepth = payload[8];
      colorType = payload[9];
      interlace = payload[12];
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(
          `unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`,
        );
      }
    } else if (typeStr === "IDAT") {
      idat.push(payload);
    }
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length !== height * (stride + 1)) {
    throw new Error("unexpected raw scanline size");
  }
  const pixels = Buffer.alloc(height * stride);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? row[x - 4] : 0;
      const b = prev[x];
      const c = x >= 4 ? prev[x - 4] : 0;
      let v = src[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          v = (v + a) & 0xff;
          break;
        case 2:
          v = (v + b) & 0xff;
          break;
        case 3:
          v = (v + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default:
          throw new Error(`bad filter ${filter}`);
      }
      row[x] = v;
    }
    row.copy(prev);
  }
  return { width, height, pixels };
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function writeChunk(chunks, type, payload) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length, 0);
  chunks.push(head, Buffer.from(type, "ascii"), payload);
  const crcUp = Buffer.alloc(4 + payload.length);
  Buffer.from(type, "ascii").copy(crcUp, 0);
  payload.copy(crcUp, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcUp), 0);
  chunks.push(crc);
}

function encodePng(width, height, pixels) {
  const chunks = [];
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeChunk(chunks, "IHDR", ihdr);
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  writeChunk(chunks, "IDAT", deflateSync(raw));
  writeChunk(chunks, "IEND", Buffer.alloc(0));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { width, height, pixels } = readPng(ATLAS_URL);
if (height !== CELL || width % CELL !== 0) {
  throw new Error(
    `atlas is ${width}x${height}, expected height ${CELL} and width multiple of ${CELL}`,
  );
}
const baseCols = width / CELL;
const newWidth = width + CELL;
const out = Buffer.alloc(newWidth * height * 4);
for (let y = 0; y < height; y++) {
  pixels.copy(out, y * newWidth * 4, y * width * 4, (y + 1) * width * 4);
}
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    for (let k = 0; k < 4; k++) {
      if (pixels[(y * width + x) * 4 + k] !== out[(y * newWidth + x) * 4 + k]) {
        throw new Error("row-wise copy mismatch");
      }
    }
  }
}

// Robot Factory glyph, white on transparent: a gear — ring + 8 teeth — with an
// inner core square. Drawn with distance primitives, anti-aliased by a soft
// edge so it composites like the upstream vector glyphs.
{
  const X = baseCols * CELL;
  const CX = 32;
  const CY = 32;
  const disc2 = (x, y) => (x - CX) * (x - CX) + (y - CY) * (y - CY);

  // Gear ring: outer radius 22, inner radius 14 (ring body 8px wide).
  const ringOuter = 22;
  const ringInner = 14;
  // Teeth: 8 rectangles at 45° steps, from radius 22 to 26, 6px wide.
  const toothLen = 26;
  const toothHalfWidth = 3.4;
  // Core: rounded square 20x20 centered, as a small dock the tint reads on.
  const coreHalf = 10;

  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const d = Math.sqrt(disc2(x, y));
      // Pixels outside the column are untouched (transparent).
      const off = (y * newWidth + (X + x)) * 4;
      let a = 0;
      if (d <= toothLen) {
        // Teeth check first (they extend past the ring).
        const ang = Math.atan2(y - CY, x - CX);
        const seg = (ang + Math.PI) / (Math.PI / 4); // 8 sectors
        const sectorFrac = Math.abs(seg - Math.round(seg)) * (Math.PI / 4);
        const inTeeth =
          d > ringOuter && Math.abs(sectorFrac) < toothHalfWidth / ringOuter;
        const inRing = d >= ringInner && d <= ringOuter;
        if (inTeeth || inRing) {
          // Anti-alias against the outer edges only; interior edges are fine.
          let edge = 0;
          if (inTeeth && d > toothLen - 1) edge = toothLen - d;
          a = ((inTeeth || inRing) && edge > 0 ? Math.min(1, edge) : 1) * 255;
        }
      }
      // Core square (rounded a touch).
      const dx = Math.abs(x - CX);
      const dy = Math.abs(y - CY);
      if (dx <= coreHalf && dy <= coreHalf) {
        a = 255;
      }
      if (a > 0) {
        out[off] = 255;
        out[off + 1] = 255;
        out[off + 2] = 255;
        out[off + 3] = a;
      }
    }
  }
}

writeFileSync(ATLAS_URL, encodePng(newWidth, height, out));
console.log(
  `icon-atlas.png: ${baseCols} → ${baseCols + 1} columns, robot factory at col ${baseCols}`,
);
