/**
 * Appends the Tank and Plane sprites to resources/atlases/unit-atlas.png.
 *
 * The unit atlas is a single 13px-tall row of 13px-wide cells, one column per
 * unit type (see src/client/render/gl/passes/UnitPass.ts UNIT_ORDER). The
 * base atlas (columns 0-11) is pre-built upstream; this script only EXTENDS
 * the row — it never rewrites the existing columns — so the sprite source
 * art for columns 0-11 can stay wherever upstream keeps it.
 *
 * Dependency-free: the PNG is decoded/re-encoded with node:zlib. The atlas is
 * an 8-bit RGBA (color type 6), non-interlaced PNG written by the upstream
 * atlas generator, which is exactly the subset decoded here.
 *
 * Sprites are grayscale pixel art: the unit shader (unit.frag.glsl) maps
 * four gray bands to player colors:
 *   180 → territory color, 130 → spawn color,
 *   100 → center accent,   70  → border color.
 * Pixels outside the sprite are transparent.
 *
 * Usage: node scripts/add-unit-atlas-cols.mjs
 */

import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

const ATLAS_URL = "resources/atlases/unit-atlas.png";
const CELL = 13;

/** Gray band values matching unit.frag.glsl. */
const LIGHT = 180;
const MID = 130;
const CENTER = 100;
const DARK = 70;

// ---------------------------------------------------------------------------
// Minimal PNG reader for 8-bit RGBA / non-interlaced
// ---------------------------------------------------------------------------

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
    i += 12 + len; // length + type + data + crc
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length !== height * (stride + 1)) {
    throw new Error("unexpected raw scanline size");
  }
  // Un-filter
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

function encodePng(width, height, pixels) {
  const chunks = [];
  const writeChunk = (type, payload) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(payload.length, 0);
    chunks.push(head, Buffer.from(type, "ascii"), payload);
    const crcUp = Buffer.alloc(4 + payload.length);
    Buffer.from(type, "ascii").copy(crcUp, 0);
    payload.copy(crcUp, 4);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcUp), 0);
    chunks.push(crc);
  };
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  writeChunk("IHDR", ihdr);
  // One filter byte (0) per scanline
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  writeChunk("IDAT", deflateSync(raw));
  writeChunk("IEND", Buffer.alloc(0));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { width, height, pixels } = readPng(ATLAS_URL);
if (height !== CELL || width % CELL !== 0) {
  throw new Error(
    `atlas is ${width}x${height}, expected height ${CELL} and width multiple of ${CELL} - refactor this script`,
  );
}
const baseCols = width / CELL;
const newWidth = width + 2 * CELL;
const out = Buffer.alloc(newWidth * height * 4);
// Row-wise copy: the source rows must be re-laid onto the wider image, so a
// linear bytes.copy() would splice source rows together and bleed sprite
// data across column boundaries.
for (let y = 0; y < height; y++) {
  pixels.copy(out, y * newWidth * 4, y * width * 4, (y + 1) * width * 4);
}
// Sanity: the extended image must match the source exactly in columns 0..baseCols-1.
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const o1 = (y * width + x) * 4;
    const o2 = (y * newWidth + x) * 4;
    for (let k = 0; k < 4; k++) {
      if (pixels[o1 + k] !== out[o2 + k]) {
        throw new Error(
          `row-wise copy mismatch at x=${x} y=${y} (component ${k})`,
        );
      }
    }
  }
}

function px(x, y, gray) {
  const off = (y * newWidth + x) * 4;
  out[off] = gray;
  out[off + 1] = gray;
  out[off + 2] = gray;
  out[off + 3] = 255;
}

// Rect helper: filled gray rectangle.
function rect(x, y, w, h, gray) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) px(xx, yy, gray);
  }
}

// Col 12: Tank (11×11 within the cell's 1..12 margin), facing up.
{
  const X = baseCols * CELL + 1;
  // Barrel (center band) — 1px wide, 4px long, up from the turret.
  rect(X + 5, 1, 1, 4, CENTER);
  // Turret (light band)
  rect(X + 3, 4, 5, 4, LIGHT);
  // Turret hatch (center accent)
  rect(X + 5, 5, 1, 2, CENTER);
  // Hull (mid band)
  rect(X + 2, 8, 7, 3, MID);
  // Tracks (dark band), slightly wider than the hull
  rect(X + 1, 8, 1, 3, DARK);
  rect(X + 9, 8, 1, 3, DARK);
  rect(X + 1, 10, 9, 1, DARK);
}

// Col 13: Plane (9×9), nose up like the other sprites.
{
  const X = (baseCols + 1) * CELL + 2;
  // Fuselage (center band)
  rect(X + 4, 2, 1, 8, CENTER);
  // Nose (light band)
  rect(X + 3, 2, 3, 2, LIGHT);
  // Wings (mid band)
  rect(X + 1, 5, 7, 1, MID);
  rect(X + 2, 4, 5, 1, MID);
  // Tail (dark band)
  rect(X + 2, 9, 5, 1, DARK);
}

writeFileSync(ATLAS_URL, encodePng(newWidth, height, out));
console.log(
  `unit-atlas.png: ${baseCols} → ${baseCols + 2} columns, tank at col ${baseCols}, plane at col ${baseCols + 1}`,
);
