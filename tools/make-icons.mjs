// Generates the extension icons at build time so the repo carries no binaries.
//
// A minimal PNG encoder: signature, IHDR, one zlib-deflated IDAT, IEND. Node's
// zlib does the only hard part. This is here instead of a dependency because
// the whole extension is meant to be readable end to end by anyone auditing
// the "no network calls" claim, and a four-file icon pipeline is not worth an
// npm package.

import { deflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0, "none") per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// HubSpot orange tile, white lens, dark pupil. Reads at 16px, which is the only
// size that really matters. Both colours are HubSpot's own: #ff7a59 and the
// #33475b they use for dark text. A darkened orange was tried for the pupil and
// read as mud at every size.
const ORANGE = [255, 122, 89];
const WHITE = [255, 255, 255];
const INK = [51, 71, 91];

function blend(px, i, colour, alpha) {
  for (let c = 0; c < 3; c++) {
    px[i + c] = Math.round(px[i + c] * (1 - alpha) + colour[c] * alpha);
  }
  px[i + 3] = Math.max(px[i + 3], Math.round(255 * alpha));
}

// Coverage of a disc over one pixel, sampled 3x3. Cheap antialiasing.
function discCoverage(x, y, cx, cy, r) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px = x + (sx + 0.5) / 3;
      const py = y + (sy + 0.5) / 3;
      if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) hits++;
    }
  }
  return hits / 9;
}

export function renderIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const radius = size * 0.22; // corner rounding
  const c = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Rounded square: inside unless past a corner arc.
      const dx = Math.max(radius - (x + 0.5), x + 0.5 - (size - radius), 0);
      const dy = Math.max(radius - (y + 0.5), y + 0.5 - (size - radius), 0);
      const corner = Math.hypot(dx, dy);
      const inside = corner <= radius ? 1 : 0;
      if (!inside) continue;

      px[i] = ORANGE[0];
      px[i + 1] = ORANGE[1];
      px[i + 2] = ORANGE[2];
      px[i + 3] = 255;

      const lens = discCoverage(x, y, c, c, size * 0.3);
      if (lens > 0) blend(px, i, WHITE, lens);

      const pupil = discCoverage(x, y, c, c, size * 0.13);
      if (pupil > 0) blend(px, i, INK, pupil);
    }
  }

  return encodePng(size, px);
}

export const ICON_SIZES = [16, 32, 48, 128];
