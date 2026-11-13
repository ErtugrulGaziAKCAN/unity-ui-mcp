/**
 * PNG I/O for the comparison. Writing: 8-bit RGBA, no interlace (difference images, test fixtures). Reading: a fast
 * path for the two formats captures come in (8-bit RGB from Chromium, 8-bit RGBA from Unity's readback), inflating
 * on the libuv thread pool and unfiltering a row at a time, so many captures decode at once; any other PNG goes
 * through the generic decoder.
 */
import { promisify } from "node:util";
import zlib from "node:zlib";
import { decodePng, type Rgba } from "../bake/png.js";

const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Filtered scanlines; `filter` 0–4 applies that PNG filter type to every row (tests use it to cover the decoder). */
function scanlines(img: Rgba, filter = 0): Buffer {
  const stride = img.w * 4, raw = Buffer.alloc((stride + 1) * img.h), d = img.data;
  for (let y = 0; y < img.h; y++) {
    const o = y * (stride + 1), row = y * stride, up = row - stride;
    raw[o] = filter;
    for (let i = 0; i < stride; i++) {
      const x = d[row + i], a = i >= 4 ? d[row + i - 4] : 0, b = y > 0 ? d[up + i] : 0, c = i >= 4 && y > 0 ? d[up + i - 4] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      raw[o + 1 + i] = (x - pred) & 255;
    }
  }
  return raw;
}

function assemble(img: Rgba, idat: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0);
  ihdr.writeUInt32BE(img.h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** Encodes straight 8-bit RGBA pixels as a PNG. */
export function encodePng(img: Rgba, level = 6, filter = 0): Buffer {
  return assemble(img, zlib.deflateSync(scanlines(img, filter), { level }));
}

/** Same as `encodePng`, compressing on the libuv thread pool so several images can be written at once. */
export async function encodePngAsync(img: Rgba, level = 3): Promise<Buffer> {
  return assemble(img, await deflate(scanlines(img), { level }));
}

/** Decodes a PNG to straight RGBA; 8-bit RGB/RGBA without interlace take the fast path, anything else `decodePng`. */
export async function decodePngAsync(buf: Buffer): Promise<Rgba> {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("latin1", pos + 4, pos + 8), d = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6)) return decodePng(buf);
  const bpp = ctype === 6 ? 4 : 3, stride = w * bpp;
  const raw = await inflate(Buffer.concat(idat));
  if (raw.length < (stride + 1) * h) throw new Error("PNG image data is truncated");
  // RGBA unfilters straight into the output; RGB into a packed buffer that is expanded afterwards
  const px = bpp === 4 ? new Uint8Array(w * h * 4) : new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    switch (f) {
      case 0: px.set(raw.subarray(src, src + stride), dst); break;
      case 1:
        for (let i = 0; i < bpp; i++) px[dst + i] = raw[src + i];
        for (let i = bpp; i < stride; i++) px[dst + i] = (raw[src + i] + px[dst + i - bpp]) & 255;
        break;
      case 2:
        if (y === 0) px.set(raw.subarray(src, src + stride), dst);
        else for (let i = 0; i < stride; i++) px[dst + i] = (raw[src + i] + px[up + i]) & 255;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? px[dst + i - bpp] : 0, b = y > 0 ? px[up + i] : 0;
          px[dst + i] = (raw[src + i] + ((a + b) >> 1)) & 255;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? px[dst + i - bpp] : 0, b = y > 0 ? px[up + i] : 0, c = i >= bpp && y > 0 ? px[up + i - bpp] : 0;
          const p = a + b - c, pa = p > a ? p - a : a - p, pb = p > b ? p - b : b - p, pc = p > c ? p - c : c - p;
          px[dst + i] = (raw[src + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
        }
        break;
      default: throw new Error(`PNG row ${y}: unknown filter type ${f}`);
    }
  }
  if (bpp === 4) return { w, h, data: px };
  const out = new Uint8Array(w * h * 4);
  for (let p = 0, q = 0; p < w * h; p++, q += 3) { const o = p * 4; out[o] = px[q]; out[o + 1] = px[q + 1]; out[o + 2] = px[q + 2]; out[o + 3] = 255; }
  return { w, h, data: out };
}
