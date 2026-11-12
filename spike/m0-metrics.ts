// M0 reference metrics for the findings (docs/findings/m0.md §2, §4, §11) and for the M1 compare implementation.
// Usage: npx tsx spike/m0-metrics.ts [outRoot] [unityDir]   (defaults: spike/out, unity-gamma)
// Writes <outRoot>/m0-metrics/summary.md and summary.json. Dependency-free (Node built-ins only).
//
// 1. Whole-capture non-text SSIM, copy-mask variant: pixels inside text boxes (union of both captures, inflated by
//    2 px) are copied from the golden into the Unity image, then the mean block SSIM over all 8x8 blocks.
//    (spike/compare-unity.ts reports the block-skip variant: blocks touching text boxes inflated by 4 px are skipped.)
// 2. Per-element non-text SSIM (ssimElement): the same copy-masked images, mean block SSIM over the 8-px grid blocks
//    that overlap the union of the element's golden box and its baked-shadow rect. The shadow rect follows the IR
//    `shadow` convention: x/y = element + offset.x/y (image top-left relative to the border box), w/h = element +
//    offset.w/h (image size minus element size). Here it is derived from the fixture's `box-shadow` the way the
//    exporter bakes it: offset by (ox, oy), grown by blur + spread on every side.
// 3. Text-style line limits from the measured rules (UITK height ceil(n*P), Chromium n*L and its baseline formula),
//    for design-kit/text-styles.json and for the integer fallback scale.
// Block SSIM: BT.601 luma, C1 = (0.01*255)^2, C2 = (0.03*255)^2, sample variance (n - 1).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const outRoot = path.resolve(process.argv[2] ?? path.join(here, 'out'));
const unityName = process.argv[3] ?? 'unity-gamma';

interface Img { w: number; h: number; data: Uint8Array }
interface Rect { x: number; y: number; w: number; h: number }
interface El extends Rect { id: string; text?: unknown }

function decodePng(file: string): Img {
  const buf = fs.readFileSync(file);
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), d = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6)) throw new Error(`${file}: unsupported PNG`);
  const bpp = ctype === 6 ? 4 : 3, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2]; out[o + 3] = 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, data: out };
}

function blockSsim(a: Img, b: Img, bx: number, by: number): number {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  const ya: number[] = [], yb: number[] = [];
  for (let y = by; y < by + 8; y++)
    for (let x = bx; x < bx + 8; x++) {
      const o = (y * a.w + x) * 4;
      ya.push(0.299 * a.data[o] + 0.587 * a.data[o + 1] + 0.114 * a.data[o + 2]);
      yb.push(0.299 * b.data[o] + 0.587 * b.data[o + 1] + 0.114 * b.data[o + 2]);
    }
  let ma = 0, mb = 0, va = 0, vb = 0, cov = 0;
  for (let i = 0; i < 64; i++) { ma += ya[i]; mb += yb[i]; }
  ma /= 64; mb /= 64;
  for (let i = 0; i < 64; i++) { va += (ya[i] - ma) ** 2; vb += (yb[i] - mb) ** 2; cov += (ya[i] - ma) * (yb[i] - mb); }
  va /= 63; vb /= 63; cov /= 63;
  return ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
}

function regionSsim(a: Img, b: Img, r: Rect): number {
  const x0 = Math.max(0, Math.floor(r.x / 8) * 8), y0 = Math.max(0, Math.floor(r.y / 8) * 8);
  const x1 = Math.min(a.w, Math.ceil((r.x + r.w) / 8) * 8), y1 = Math.min(a.h, Math.ceil((r.y + r.h) / 8) * 8);
  let s = 0, n = 0;
  for (let by = y0; by + 8 <= y1; by += 8) for (let bx = x0; bx + 8 <= x1; bx += 8) { s += blockSsim(a, b, bx, by); n++; }
  return n ? s / n : NaN;
}

const union = (p: Rect, q: Rect): Rect => {
  const x = Math.min(p.x, q.x), y = Math.min(p.y, q.y);
  return { x, y, w: Math.max(p.x + p.w, q.x + q.w) - x, h: Math.max(p.y + p.h, q.y + q.h) - y };
};

/** Shadow rect per element id from `#id { ... box-shadow: ox oy blur spread colour }` in the fixture HTML. */
function shadowRects(html: string, els: Map<string, El>): Map<string, Rect> {
  const out = new Map<string, Rect>();
  for (const m of html.matchAll(/#([\w-]+)\s*\{[^}]*box-shadow:\s*(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)(?:px)?(?:\s+(-?[\d.]+)px)?/g)) {
    const e = els.get(m[1]);
    if (!e) continue;
    const ox = +m[2], oy = +m[3], blur = +m[4], spread = m[5] ? +m[5] : 0, grow = blur + spread;
    const offset = { x: ox - grow, y: oy - grow, w: 2 * grow, h: 2 * grow };   // IR `shadow.offset` convention
    out.set(e.id, { x: e.x + offset.x, y: e.y + offset.y, w: e.w + offset.w, h: e.h + offset.h });
  }
  return out;
}

const summary: any = { unityDir: unityName, fixtures: {}, textStyles: {} };
const md: string[] = ['# M0 reference metrics', '', `Unity captures: \`${unityName}\``, ''];
md.push('## Image metrics (copy-mask)', '', '| Fixture | Whole-capture SSIM | Worst element | Element SSIM (box) | Element SSIM (box + shadow) |', '|---|---|---|---|---|');
const all: any[] = [];
for (const fx of fs.readdirSync(path.join(outRoot, 'chromium')).filter(n => /^f\d\d-/.test(n)).sort()) {
  const uB = path.join(outRoot, unityName, fx, 'unity-boxes.json');
  if (!fs.existsSync(uB)) continue;
  const cBoxes = JSON.parse(fs.readFileSync(path.join(outRoot, 'chromium', fx, 'chromium-boxes.json'), 'utf8'));
  const uBoxes = JSON.parse(fs.readFileSync(uB, 'utf8'));
  const a = decodePng(path.join(outRoot, 'chromium', fx, 'chromium.png'));
  const b = decodePng(path.join(outRoot, unityName, fx, 'unity.png'));
  const textBoxes: El[] = [...cBoxes.elements, ...uBoxes.elements].filter((e: El) => e.text);
  for (const t of textBoxes)
    for (let y = Math.max(0, Math.floor(t.y - 2)); y < Math.min(a.h, Math.ceil(t.y + t.h + 2)); y++)
      for (let x = Math.max(0, Math.floor(t.x - 2)); x < Math.min(a.w, Math.ceil(t.x + t.w + 2)); x++) {
        const o = (y * a.w + x) * 4;
        b.data[o] = a.data[o]; b.data[o + 1] = a.data[o + 1]; b.data[o + 2] = a.data[o + 2];
      }
  const whole = regionSsim(a, b, { x: 0, y: 0, w: a.w, h: a.h });
  const els = new Map<string, El>(cBoxes.elements.map((e: El) => [e.id, e]));
  const html = fs.readFileSync(path.join(here, 'fixtures', `${fx}.html`), 'utf8');
  const shadows = shadowRects(html, els);
  const rows = cBoxes.elements
    .filter((e: El) => e.id !== 'root' && !e.text && e.w >= 16 && e.h >= 16)
    .map((e: El) => {
      const sh = shadows.get(e.id);
      const box = regionSsim(a, b, e);
      return { fixture: fx, id: e.id, box: +box.toFixed(5), withShadow: +(sh ? regionSsim(a, b, union(e, sh)) : box).toFixed(5), shadow: sh ?? null };
    });
  rows.sort((p: any, q: any) => p.withShadow - q.withShadow);
  all.push(...rows);
  summary.fixtures[fx] = { wholeCopyMask: +whole.toFixed(6), elements: rows };
  const w = rows[0];
  md.push(`| ${fx} | ${whole.toFixed(6)} | ${w ? w.id : '-'} | ${w ? w.box : '-'} | ${w ? w.withShadow : '-'} |`);
}
md.push('', '### Elements with a shadow rect', '', '| Element | Box | Box + shadow |', '|---|---|---|');
for (const r of all.filter(r => r.shadow)) md.push(`| ${r.id} | ${r.box} | ${r.withShadow} |`);
md.push('', `Elements: ${all.length}. Lowest five (box + shadow): ${[...all].sort((p, q) => p.withShadow - q.withShadow).slice(0, 5).map(r => `${r.id} ${r.withShadow}`).join(', ')}.`, '');

// ---------------------------------------------------------------- text-style line limits
function fontMetrics(ttf: string) {
  const b = fs.readFileSync(ttf), n = b.readUInt16BE(4), t: Record<string, number> = {};
  for (let i = 0; i < n; i++) { const o = 12 + i * 16; t[b.toString('ascii', o, o + 4)] = b.readUInt32BE(o + 8); }
  const upm = b.readUInt16BE(t.head + 18), asc = b.readInt16BE(t.hhea + 4), desc = -b.readInt16BE(t.hhea + 6), gap = b.readInt16BE(t.hhea + 8);
  return { upm, asc: asc / upm, desc: desc / upm, gap: gap / upm };
}
const F = fontMetrics(path.join(repo, 'samples/FidelityProject/Assets/Fonts/Inter/Inter_18pt-Regular.ttf'));
const floor64 = (v: number) => Math.floor(v * 64) / 64;

/** Lines (1..n) that keep the box and every line's baseline within ±1 px at one scale. */
function lines(f: number, L: number, scale: number, pitch: number): { n: number; firstBaselineD: number } {
  const A = F.asc * f, D = F.desc * f;
  const Ac = Math.round(A * scale), Dc = Math.round(D * scale), Ls = L * scale;
  const Bc = Ac + Math.floor((Ls - Ac - Dc) / 2), b = Bc - A * scale;
  let n = 0;
  for (let k = 1; k <= 2000; k++) {
    const box = k * Ls - Math.ceil(k * pitch * scale - 1e-9), base = (k - 1) * (L - pitch) * scale + b;
    if (Math.abs(box) <= 1 && Math.abs(base) <= 1) n = k; else break;
  }
  return { n, firstBaselineD: +b.toFixed(2) };
}
function styleRow(name: string, f: number, L: number) {
  const P = f * (F.asc + F.desc + F.gap);
  const at = [1, 0.75, 0.5].map(s => lines(f, L, s, P));
  return { name, fontSize: f, lineHeight: L, P: +P.toFixed(5), eps: +(L - P).toFixed(5), ceilP: Math.ceil(P - 1e-9),
    firstBaselineD: at.map(x => x.firstBaselineD), linesStandard: Math.min(...at.map(x => x.n)),
    linesAdvanced: lines(f, L, 1, floor64(P)).n };
}
const styles = JSON.parse(fs.readFileSync(path.join(repo, 'design-kit/text-styles.json'), 'utf8'));
const kit = Object.entries(styles).filter(([k]) => !k.endsWith('-bold')).map(([k, v]: [string, any]) => styleRow(k, v.fontSize, v.lineHeight));
const fallback = [['caption', 13, 16], ['label', 16, 20], ['body', 23, 28], ['subtitle', 26, 32], ['title', 33, 40], ['headline', 46, 56], ['display', 56, 68]]
  .map(([k, f, L]) => styleRow(k as string, f as number, L as number));
summary.textStyles = { font: F, kit, integerFallback: fallback };
md.push('## Text-style line limits', '', `Inter: UPM ${F.upm}, hhea ascent ${F.asc * F.upm}, descent ${F.desc * F.upm}, line gap ${F.gap * F.upm}.`,
  'Lines = box and every baseline within ±1 px; standard = minimum over scales 1/0.75/0.5 (Chromium metrics rounded at the scaled size); advanced = pitch floored to 1/64, scale 1.', '');
for (const [title, rows] of [['design-kit/text-styles.json', kit], ['Integer fallback', fallback]] as const) {
  md.push(`### ${title}`, '', '| Style | fontSize | lineHeight | P | L − P | ceil(P) | 1st baseline Δ (1/0.75/0.5) | Lines standard | Lines advanced |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) md.push(`| ${r.name} | ${r.fontSize} | ${r.lineHeight} | ${r.P} | ${r.eps} | ${r.ceilP} | ${r.firstBaselineD.join(' / ')} | ${r.linesStandard} | ${r.linesAdvanced} |`);
  md.push('');
}

const dir = path.join(outRoot, 'm0-metrics');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
fs.writeFileSync(path.join(dir, 'summary.md'), md.join('\n') + '\n');
console.log(`m0-metrics: ${all.length} elements, ${kit.length} text styles -> ${path.relative(process.cwd(), dir)}`);
