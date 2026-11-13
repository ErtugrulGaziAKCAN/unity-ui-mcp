import zlib from "node:zlib";

/** Straight (not premultiplied) 8-bit RGBA pixels, row-major. */
export interface Rgba { w: number; h: number; data: Uint8Array }

/**
 * Decodes an 8-bit, non-interlaced PNG (truecolour with or without alpha, greyscale with or without alpha), which is
 * what Chromium's screenshots are. Used to measure baked images; the asset bytes themselves are Chromium's PNGs.
 */
export function decodePng(buf: Buffer): Rgba {
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
  const channels: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const bpp = channels[ctype];
  if (depth !== 8 || !bpp || interlace !== 0) throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${ctype}, interlace ${interlace})`);
  const stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat)), out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * bpp;
      if (bpp >= 3) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = bpp === 4 ? cur[s + 3] : 255; }
      else { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = bpp === 2 ? cur[s + 1] : 255; }
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, data: out };
}

/** The pixel at (x, y) as [r, g, b, a]. */
export function pixel(img: Rgba, x: number, y: number): [number, number, number, number] {
  const o = (y * img.w + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

/** Columns x0 and x1 hold the same pixels in every row. */
export function sameColumn(img: Rgba, x0: number, x1: number): boolean {
  for (let y = 0; y < img.h; y++) {
    const a = (y * img.w + x0) * 4, b = (y * img.w + x1) * 4;
    if (img.data[a] !== img.data[b] || img.data[a + 1] !== img.data[b + 1] || img.data[a + 2] !== img.data[b + 2] || img.data[a + 3] !== img.data[b + 3]) return false;
  }
  return true;
}

/** Rows y0 and y1 hold the same pixels. */
export function sameRow(img: Rgba, y0: number, y1: number): boolean {
  const a = img.data.subarray(y0 * img.w * 4, (y0 + 1) * img.w * 4), b = img.data.subarray(y1 * img.w * 4, (y1 + 1) * img.w * 4);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Bounding box of the pixels with alpha > 0, or null when every pixel is transparent. */
export function opaqueBounds(img: Rgba): { x: number; y: number; w: number; h: number } | null {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    if (img.data[(y * img.w + x) * 4 + 3] === 0) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
