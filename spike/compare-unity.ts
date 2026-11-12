// M0 spike: compare the Unity captures (spike/out/unity) with the Chromium goldens (spike/out/chromium).
// Usage: npx tsx spike/compare-unity.ts [outRoot] [unityDir]   (defaults: spike/out, unity)
// Writes <outRoot>/compare-<unityDir>/summary.json and summary.md. Dependency-free: a minimal PNG decoder (8-bit RGB/RGBA,
// non-interlaced), CIEDE2000 on sRGB pixels and an 8x8-block grayscale SSIM.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.resolve(process.argv[2] ?? path.join(here, 'out'));
const unityName = process.argv[3] ?? 'unity';
const W = 2560, H = 1440;

// ------------------------------------------------------------------ PNG

interface Img { w: number; h: number; data: Uint8Array } // RGBA

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
  if (depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6)) throw new Error(`${file}: unsupported PNG depth ${depth} type ${ctype} interlace ${interlace}`);
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
      out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2]; out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, data: out };
}

const px = (img: Img, x: number, y: number): [number, number, number] => {
  const xi = Math.min(img.w - 1, Math.max(0, Math.floor(x))), yi = Math.min(img.h - 1, Math.max(0, Math.floor(y)));
  const o = (yi * img.w + xi) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};
const hex = (c: number[]) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');

// ------------------------------------------------------------------ colour

function lab([r, g, b]: number[]): [number, number, number] {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
  const Z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

function de2000(l1: number[], l2: number[]): number {
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2, rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => { if (a === 0 && b === 0) return 0; const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
  const h1p = hue(b1, a1p), h2p = hue(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp * rad / 2);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) { if (Math.abs(h1p - h2p) > 180) hbp += hbp < 360 ? 360 : -360; hbp /= 2; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + 0.015 * (Lbp - 50) ** 2 / Math.sqrt(20 + (Lbp - 50) ** 2), Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}
// Sharma et al. 2005, pair 1: expected 2.0425
const selfCheck = de2000([50, 2.6772, -79.7751], [50, 0, -82.7485]);
if (Math.abs(selfCheck - 2.0425) > 1e-3) throw new Error(`CIEDE2000 self-check failed: ${selfCheck}`);
const dE = (c1: number[], c2: number[]) => de2000(lab(c1), lab(c2));

// ------------------------------------------------------------------ SSIM (8x8 blocks, luma)

function ssim(a: Img, b: Img, skip?: (x: number, y: number) => boolean): { ssim: number; blocks: number } {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let sum = 0, n = 0;
  for (let by = 0; by + 8 <= a.h; by += 8)
    for (let bx = 0; bx + 8 <= a.w; bx += 8) {
      if (skip && skip(bx, by)) continue;
      let ma = 0, mb = 0, va = 0, vb = 0, cov = 0;
      const ya: number[] = [], yb: number[] = [];
      for (let y = by; y < by + 8; y++)
        for (let x = bx; x < bx + 8; x++) {
          const o = (y * a.w + x) * 4;
          ya.push(0.299 * a.data[o] + 0.587 * a.data[o + 1] + 0.114 * a.data[o + 2]);
          yb.push(0.299 * b.data[o] + 0.587 * b.data[o + 1] + 0.114 * b.data[o + 2]);
        }
      for (let i = 0; i < 64; i++) { ma += ya[i]; mb += yb[i]; }
      ma /= 64; mb /= 64;
      for (let i = 0; i < 64; i++) { va += (ya[i] - ma) ** 2; vb += (yb[i] - mb) ** 2; cov += (ya[i] - ma) * (yb[i] - mb); }
      va /= 63; vb /= 63; cov /= 63;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      n++;
    }
  return { ssim: n ? sum / n : NaN, blocks: n };
}

function diffFraction(a: Img, b: Img, tol: number, skip?: (x: number, y: number) => boolean): number {
  let n = 0, d = 0;
  for (let y = 0; y < a.h; y++)
    for (let x = 0; x < a.w; x++) {
      if (skip && skip(x, y)) continue;
      const o = (y * a.w + x) * 4;
      n++;
      if (Math.abs(a.data[o] - b.data[o]) > tol || Math.abs(a.data[o + 1] - b.data[o + 1]) > tol || Math.abs(a.data[o + 2] - b.data[o + 2]) > tol) d++;
    }
  return n ? d / n : NaN;
}

// ------------------------------------------------------------------ boxes

interface Line { x: number; y: number; w: number; h: number; baseline?: number }
interface TextInfo { lines: Line[]; baseline: number | null; lineBoxHeight: number | null; content: string; routes?: Record<string, { lineCount: number; lines: Line[]; error?: string }> }
interface El { id: string; x: number; y: number; w: number; h: number; hidden?: boolean; text?: TextInfo }
interface Boxes { fixture: string; state: string; elements: El[] }

const load = (f: string): Boxes | null => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
const r2 = (v: number) => Math.round(v * 100) / 100;
const inside = (e: { x: number; y: number; w: number; h: number }, x: number, y: number, pad = 0) => x >= e.x - pad && x < e.x + e.w + pad && y >= e.y - pad && y < e.y + e.h + pad;

function boxDeltas(c: Boxes, u: Boxes) {
  const ue = new Map(u.elements.map(e => [e.id, e]));
  const rows: any[] = [];
  for (const e of c.elements) {
    const o = ue.get(e.id);
    if (!o) { rows.push({ id: e.id, missing: true }); continue; }
    if (!!o.hidden !== !!e.hidden) { rows.push({ id: e.id, visibilityMismatch: true }); continue; }
    const d = { dx: r2(o.x - e.x), dy: r2(o.y - e.y), dw: r2(o.w - e.w), dh: r2(o.h - e.h) };
    rows.push({ id: e.id, ...d, max: Math.max(...Object.values(d).map(Math.abs)), chromium: [e.x, e.y, e.w, e.h].map(r2), unity: [o.x, o.y, o.w, o.h].map(r2) });
  }
  return rows;
}

const ROUTES = ['internal', 'handle', 'cursor', 'glyphs'];

function textRows(c: Boxes, u: Boxes) {
  const ue = new Map(u.elements.map(e => [e.id, e]));
  const rows: any[] = [];
  for (const e of c.elements) {
    const o = ue.get(e.id);
    if (!e.text || !o?.text) continue;
    const ct = e.text, ut = o.text, routes = ut.routes ?? {};
    const cBase = ct.baseline == null ? null : ct.baseline - e.y;
    const per: Record<string, any> = {};
    for (const k of ROUTES) {
      const r = routes[k] as any;
      if (!r) continue;
      per[k] = {
        lines: r.lineCount,
        error: r.error ?? undefined,
        baselineD: r.baseline == null || cBase == null ? null : r2((r.baseline - o.y) - cBase),
        lineTopD: r.lines.map((l: Line, i: number) => ct.lines[i] ? r2((l.y - o.y) - (ct.lines[i].y - e.y)) : null),
        lineHD: r.lines.map((l: Line, i: number) => ct.lines[i] ? r2(l.h - ct.lines[i].h) : null),
        widthD: r.lines.map((l: Line, i: number) => ct.lines[i] ? r2(l.w - ct.lines[i].w) : null),
      };
    }
    rows.push({
      id: e.id,
      lines: { chromium: ct.lines.length, ...Object.fromEntries(Object.entries(per).map(([k, v]) => [k, v.lines])) },
      h: { chromium: r2(e.h), unity: r2(o.h), d: r2(o.h - e.h) },
      baselineFromTop: { chromium: cBase == null ? null : r2(cBase), unity: ut.baseline == null ? null : r2(ut.baseline - o.y), d: cBase == null || ut.baseline == null ? null : r2((ut.baseline - o.y) - cBase) },
      baselineAbsD: ct.baseline == null || ut.baseline == null ? null : r2(ut.baseline - ct.baseline),
      lineBoxHeight: { chromium: ct.lineBoxHeight == null ? null : r2(ct.lineBoxHeight), unity: ut.lineBoxHeight == null ? null : r2(ut.lineBoxHeight) },
      widths: { chromium: ct.lines.map(l => r2(l.w)), cursor: (routes.cursor?.lines ?? []).map(l => r2(l.w)) },
      routes: per,
    });
  }
  return rows;
}

const fmtText = (t: any) => {
  const r = t.routes, f = (k: string) => r[k] ? `${r[k].lines}` : '-';
  return `${t.id}: lines ${t.lines.chromium}/${f('internal')}/${f('handle')}/${f('cursor')}/${f('glyphs')}; h ${t.h.chromium}/${t.h.unity} (d ${t.h.d}); ` +
    `baseline d internal ${r.internal?.baselineD ?? '-'} handle ${r.handle?.baselineD ?? '-'} cursor ${r.cursor?.baselineD ?? '-'}; ` +
    `line tops d (cursor) ${(r.cursor?.lineTopD ?? []).join(',')}; line h d (cursor) ${(r.cursor?.lineHD ?? []).join(',')}; width d (cursor) ${(r.cursor?.widthD ?? []).join(',')}`;
};

const FX = [0.1, 0.3, 0.5, 0.7, 0.9], FY = [0.25, 0.5, 0.75];

/** Colour samples per element: a 5x3 grid inside the box (inset 6 px), skipping points covered by any later element
 *  (descendants and later siblings paint on top) or by any text box (glyphs are compared elsewhere). */
function colorRows(c: Boxes, u: Boxes, ci: Img, ui: Img, opts: { ids?: string[] } = {}) {
  const ue = new Map(u.elements.map(e => [e.id, e]));
  const textBoxes = [...c.elements, ...u.elements].filter(e => e.text);
  const rows: any[] = [];
  c.elements.forEach((e, idx) => {
    if (opts.ids && !opts.ids.includes(e.id)) return;
    const o = ue.get(e.id);
    if (!o || e.text || e.w < 16 || e.h < 16) return;
    const later = c.elements.slice(idx + 1);
    const x0 = Math.max(e.x, o.x) + 6, x1 = Math.min(e.x + e.w, o.x + o.w) - 6, y0 = Math.max(e.y, o.y) + 6, y1 = Math.min(e.y + e.h, o.y + o.h) - 6;
    if (x1 <= x0 || y1 <= y0) return;
    const samples: any[] = [];
    for (const fy of FY) for (const fx of FX) {
      const x = Math.floor(x0 + (x1 - x0) * fx), y = Math.floor(y0 + (y1 - y0) * fy);
      if (later.some(l => inside(l, x, y, 2)) || textBoxes.some(t => inside(t, x, y, 4))) continue;
      const a = px(ci, x, y), b = px(ui, x, y);
      samples.push({ x, y, chromium: hex(a), unity: hex(b), dE: r2(dE(a, b)) });
    }
    if (!samples.length) return;
    const des = samples.map(s => s.dE);
    rows.push({ id: e.id, n: samples.length, maxDE: Math.max(...des), meanDE: r2(des.reduce((p, v) => p + v, 0) / des.length), samples });
  });
  return rows;
}

function textMask(c: Boxes, u: Boxes) {
  const tb = [...c.elements, ...u.elements].filter(e => e.text);
  return (x: number, y: number) => tb.some(t => x + 8 > t.x - 4 && x < t.x + t.w + 4 && y + 8 > t.y - 4 && y < t.y + t.h + 4);
}

// ------------------------------------------------------------------ run

const summary: any = { outRoot, fixtures: {} };
const md: string[] = ['# Unity vs Chromium (M0 spike)', ''];
const chromiumDir = path.join(outRoot, 'chromium'), unityDir = path.join(outRoot, unityName);
const compareDir = path.join(outRoot, `compare-${unityName}`);
const fixtures = fs.readdirSync(chromiumDir).filter(n => /^f\d\d-/.test(n)).sort();

function compareCapture(fx: string, cState: string, uSuffix: string, label: string) {
  const cB = load(path.join(chromiumDir, fx, `chromium${cState}-boxes.json`)), uB = load(path.join(unityDir, fx, `unity${uSuffix}-boxes.json`));
  const cP = path.join(chromiumDir, fx, `chromium${cState}.png`), uP = path.join(unityDir, fx, `unity${uSuffix}.png`);
  if (!cB || !uB || !fs.existsSync(uP)) return null;
  const ci = decodePng(cP), ui = decodePng(uP);
  if (ci.w !== W || ci.h !== H || ui.w !== W || ui.h !== H) throw new Error(`${fx}${uSuffix}: size ${ci.w}x${ci.h} vs ${ui.w}x${ui.h}`);
  const boxes = boxDeltas(cB, uB), text = textRows(cB, uB), colors = colorRows(cB, uB, ci, ui);
  const mask = textMask(cB, uB);
  const res = {
    label,
    boxes: { n: boxes.length, within1px: boxes.filter(b => b.max !== undefined && b.max <= 1).length, max: Math.max(0, ...boxes.filter(b => b.max !== undefined).map(b => b.max)), over1px: boxes.filter(b => b.max === undefined || b.max > 1) },
    text,
    colors: { maxDE: Math.max(0, ...colors.map(c => c.maxDE)), over1: colors.filter(c => c.maxDE > 1).map(c => ({ id: c.id, maxDE: c.maxDE, meanDE: c.meanDE, worst: c.samples.reduce((p: any, s: any) => s.dE > p.dE ? s : p) })), rows: colors },
    image: {
      ssim: r2(ssim(ci, ui).ssim * 10000) / 10000,
      ssimNonText: r2(ssim(ci, ui, mask).ssim * 10000) / 10000,
      diffFracTol3: r2(diffFraction(ci, ui, 3) * 10000) / 10000,
      diffFracTol3NonText: r2(diffFraction(ci, ui, 3, (x, y) => mask(x - (x % 8), y - (y % 8))) * 10000) / 10000,
    },
  };
  return res;
}

for (const fx of fixtures) {
  const entry: any = {};
  summary.fixtures[fx] = entry;
  const def = compareCapture(fx, '', '', 'default');
  if (!def) { md.push(`## ${fx}: no Unity capture`, ''); continue; }
  entry.default = def;
  md.push(`## ${fx}`, '');
  md.push(`- boxes: ${def.boxes.within1px}/${def.boxes.n} within 1 px, max delta ${def.boxes.max} px`);
  for (const b of def.boxes.over1px) md.push(`  - ${b.id}: ${b.missing ? 'missing in Unity' : b.visibilityMismatch ? 'visibility mismatch' : `dx ${b.dx} dy ${b.dy} dw ${b.dw} dh ${b.dh} (chromium ${b.chromium.join(',')} unity ${b.unity.join(',')})`}`);
  md.push(`- image: SSIM ${def.image.ssim}, SSIM non-text ${def.image.ssimNonText}, pixels off by >3: ${(def.image.diffFracTol3 * 100).toFixed(2)}% (non-text ${(def.image.diffFracTol3NonText * 100).toFixed(2)}%)`);
  md.push(`- colour samples: max dE2000 ${def.colors.maxDE.toFixed(2)} over ${def.colors.rows.length} elements`);
  for (const c of def.colors.over1) md.push(`  - ${c.id}: max dE ${c.maxDE} mean ${c.meanDE}; worst (${c.worst.x},${c.worst.y}) chromium ${c.worst.chromium} unity ${c.worst.unity}`);
  if (def.text.length) {
    md.push('- text (lines chromium/internal/handle/cursor/glyphs; element height; baseline-from-top deltas per route; cursor-route line top/height/width deltas):');
    for (const t of def.text) md.push(`  - ${fmtText(t)}`);
  }
  // advanced text generator variant
  const adv = compareCapture(fx, '', '-advanced', 'advanced text generator');
  if (adv) {
    entry.advanced = adv;
    md.push(`- advanced generator: boxes ${adv.boxes.within1px}/${adv.boxes.n} within 1 px (max ${adv.boxes.max}); SSIM ${adv.image.ssim}`);
    for (const t of adv.text) md.push(`  - ${fmtText(t)}`);
  }
  // f13 pseudo-states: Chromium forces the state on both buttons; Unity hovers/presses one at a time
  if (fx === 'f13-hover-active') {
    const states: Array<[string, string, string]> = [
      ['-hover', '-hover', 'f13-btn'], ['-hover', '-hover-btn2', 'f13-btn2'],
      ['-active', '-active', 'f13-btn'], ['-active', '-active-btn2', 'f13-btn2'],
      ['-active', '-active-noclickable', 'f13-btn'], ['-active', '-active-noclickable-btn2', 'f13-btn2'],
    ];
    entry.states = {};
    md.push('- pseudo-states (target button colour samples + 1 px inside the left border):');
    for (const [cs, us, id] of states) {
      const cB = load(path.join(chromiumDir, fx, `chromium${cs}-boxes.json`)), uB = load(path.join(unityDir, fx, `unity${us}-boxes.json`));
      const uP = path.join(unityDir, fx, `unity${us}.png`);
      if (!cB || !uB || !fs.existsSync(uP)) { md.push(`  - unity${us}: missing`); continue; }
      const ci = decodePng(path.join(chromiumDir, fx, `chromium${cs}.png`)), ui = decodePng(uP);
      const rows = colorRows(cB, uB, ci, ui, { ids: [id] });
      const e = cB.elements.find(x => x.id === id)!;
      const bx = Math.floor(e.x) + 1, by = Math.floor(e.y + e.h / 2);
      const border = { x: bx, y: by, chromium: hex(px(ci, bx, by)), unity: hex(px(ui, bx, by)), dE: r2(dE(px(ci, bx, by), px(ui, bx, by))) };
      entry.states[us] = { target: id, chromiumState: cs, rows, border };
      const r = rows[0];
      md.push(`  - unity${us} vs chromium${cs} (${id}): fill max dE ${r ? r.maxDE : 'n/a'} (chromium ${r?.samples[0].chromium} unity ${r?.samples[0].unity}); border px dE ${border.dE} (chromium ${border.chromium} unity ${border.unity})`);
    }
  }
  // R8 colour routes
  const r8Dir = path.join(unityDir, fx, 'r8');
  if (fs.existsSync(r8Dir)) {
    const cB = load(path.join(chromiumDir, fx, 'chromium-boxes.json'))!, uB = load(path.join(unityDir, fx, 'unity-boxes.json')) ?? cB;
    const ci = decodePng(path.join(chromiumDir, fx, 'chromium.png'));
    entry.r8 = {};
    md.push('- R8 colour routes (all colour samples, non-root):');
    for (const f of fs.readdirSync(r8Dir).filter(n => n.endsWith('.png')).sort()) {
      const ui = decodePng(path.join(r8Dir, f));
      const rows = colorRows(cB, uB, ci, ui).filter(r => r.id !== 'root');
      const des = rows.flatMap(r => r.samples.map((s: any) => s.dE));
      const res = { maxDE: r2(Math.max(...des)), meanDE: r2(des.reduce((p, v) => p + v, 0) / des.length), samples: des.length, perElement: rows.map(r => ({ id: r.id, maxDE: r.maxDE, meanDE: r.meanDE, first: `${r.samples[0].chromium}/${r.samples[0].unity}` })) };
      entry.r8[f] = res;
      md.push(`  - ${f}: mean dE ${res.meanDE}, max dE ${res.maxDE} (${res.samples} samples)`);
    }
  }
  md.push('');
}

fs.mkdirSync(compareDir, { recursive: true });
fs.writeFileSync(path.join(compareDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
fs.writeFileSync(path.join(compareDir, 'summary.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
console.log(`\nwritten: ${path.join(compareDir, 'summary.json')} and summary.md (CIEDE2000 self-check ${selfCheck.toFixed(4)})`);
