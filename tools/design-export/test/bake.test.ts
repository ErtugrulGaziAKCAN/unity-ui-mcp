import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import { launchChromium } from "../src/browser.js";
import { decodePng, pixel, type Rgba } from "../src/bake/png.js";
import { bakeShadow, openBakePage, sharedBakePage, splitShadows } from "../src/bake/shadow.js";
import { gradientStopGap, gradientToSvg } from "../src/bake/gradient.js";
import { readKit, type KitConfig } from "../src/kit.js";
import { openDesign } from "../src/load.js";
import { collectSnapshot, lint } from "../src/lint/index.js";
import { buildIr, type IrBuild } from "../src/extract/tree.js";
import type { IrNode } from "../src/ir/types.js";
import { stableStringify } from "../src/ir/stableStringify.js";
import { validateIr as validateIrLoose } from "../src/ir/validate.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const fx = (n: string) => path.join(here, "fixtures", "extract", n);
const kit: KitConfig = readKit(fx("kit"));

let browser: Browser;
let bake: { page: Page; close(): Promise<void> };
/** A page for reference renders: transparent, device scale 1. */
let ref: Page;
const tmpDirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "bake-")); tmpDirs.push(d); return d; };
beforeAll(async () => {
  browser = await launchChromium();
  bake = await openBakePage(browser);
  ref = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 })).newPage();
});
afterAll(async () => {
  await browser.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ---- colour difference (CIEDE2000 on sRGB, D65) -------------------------------------------------------------------
function lab([r, g, b]: number[]): [number, number, number] {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
function de2000(c1: number[], c2: number[]): number {
  const [L1, a1, b1] = lab(c1), [L2, a2, b2] = lab(c2), rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2, C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => { if (a === 0 && b === 0) return 0; const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
  const h1p = hue(b1, a1p), h2p = hue(b2, a2p), dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2), Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) { if (Math.abs(h1p - h2p) > 180) hbp += hbp < 360 ? 360 : -360; hbp /= 2; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2)), Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2), Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}
it("CIEDE2000 helper matches Sharma et al. pair 1 within rounding of the sRGB route", () => {
  expect(de2000([0, 0, 0], [0, 0, 0])).toBe(0);
  expect(de2000([255, 0, 0], [254, 0, 0])).toBeLessThan(1);
});

// ---- pixel helpers ----------------------------------------------------------------------------------------------------
async function shot(page: Page, html: string, clip: { x: number; y: number; width: number; height: number }, transparent = true): Promise<Rgba> {
  await page.setContent(html);
  return decodePng(await page.screenshot({ clip, omitBackground: transparent, animations: "disabled" }));
}
const doc = (body: string, bg = "transparent") => `<!doctype html><html><head><style>html,body{margin:0;background:${bg}}div{position:absolute;box-sizing:border-box}</style></head><body>${body}</body></html>`;

const PAGE = "#0b1f26";

// ---- shadows ------------------------------------------------------------------------------------------------------------
describe("bakeShadow", () => {
  it("cuts a measured 9-slice: 0 8px 24px rgba(0,0,0,0.4) with radius 12px", async () => {
    const out = tmp();
    const s = (await bakeShadow(bake.page, "0 8px 24px rgba(0,0,0,0.4)", "12px", out))!;
    expect(s.kind).toBe("shadow9");
    expect(s.tint).toBe(false);
    expect(s.stopGap).toBeNull();
    const bytes = fs.readFileSync(path.join(out, s.file));
    expect(s.file).toBe(`assets/${s.sha256}.png`);
    expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(s.sha256);
    // measured in Chromium: the blur reaches 27 px beyond the shadow box, the corner bands end where columns and rows
    // stop changing, and each inset keeps one uniform texel so bilinear sampling has no seam
    expect(s.offset).toEqual({ x: -27, y: -19, w: 54, h: 54 });
    expect(s.slice).toEqual([59, 62, 59, 62]);
    const img = decodePng(bytes);
    expect([img.w, img.h]).toEqual([s.width, s.height]);
    // the centre: uniform texels, as many as Chromium needs to draw the shadow the way it draws large boxes
    const centre = s.width - 62 - 62;
    expect(centre).toBeGreaterThanOrEqual(1);
    expect(s.height).toBe(59 + centre + 59);
    // shadow in the band, nothing under the element (CSS clips an outer shadow to outside the border box)
    expect(pixel(img, Math.floor(img.w / 2), 10)[3]).toBeGreaterThan(0);
    expect(pixel(img, Math.floor(img.w / 2), Math.floor(img.h / 2))[3]).toBe(0);
  });

  it("is deterministic: the same input gives the same file, on the same page and on a fresh one", async () => {
    const a = (await bakeShadow(bake.page, "0 8px 24px rgba(0,0,0,0.4)", "12px", tmp()))!;
    const b = (await bakeShadow(bake.page, "0 8px 24px rgba(0,0,0,0.4)", "12px", tmp()))!;
    const fresh = await openBakePage(browser);
    try {
      const c = (await bakeShadow(fresh.page, "0 8px 24px rgba(0,0,0,0.4)", "12px", tmp()))!;
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    } finally { await fresh.close(); }
  });

  it("is Chromium's own rendering: the shared 9-slice stretched to a large element equals its shadow, within one code value", async () => {
    const out = tmp(), W = 600, H = 300, X = 213, Y = 171;
    const s = (await bakeShadow(bake.page, "0 8px 24px rgba(0,0,0,0.4)", "12px", out, { box: { w: W, h: H } }))!;
    const img = decodePng(fs.readFileSync(path.join(out, s.file)));
    const rect = { x: X + s.offset.x, y: Y + s.offset.y, width: W + s.offset.w, height: H + s.offset.h };
    const alone = await shot(ref, doc(`<div style="left:${X}px;top:${Y}px;width:${W}px;height:${H}px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.4)"></div>`), rect);
    const [t, r, b, l] = s.slice!;
    const map = (d: number, size: number, lo: number, hi: number, src: number) => (d < lo ? d : d >= size - hi ? src - (size - d) : lo);
    let worst = 0;
    for (let y = 0; y < alone.h; y++) for (let x = 0; x < alone.w; x++) {
      const a = pixel(alone, x, y), c = pixel(img, map(x, alone.w, l, r, img.w), map(y, alone.h, t, b, img.h));
      worst = Math.max(worst, ...a.map((v, k) => Math.abs(v - c[k])));
    }
    expect(worst).toBeLessThanOrEqual(1);
  });

  it("returns null for a shadow that draws nothing", async () => {
    expect(await bakeShadow(bake.page, "0 0 0 0 rgba(0, 0, 0, 0)", "0px", tmp())).toBeNull();
  });

  it("splits a box-shadow list into outer and inset shadows", () => {
    expect(splitShadows("inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 8px 24px #000, 0 0 2px red inset")).toEqual({
      outer: ["0 8px 24px #000"], inset: ["inset 0 1px 0 rgba(255, 255, 255, 0.1)", "0 0 2px red inset"],
    });
    expect(splitShadows("none")).toEqual({ outer: [], inset: [] });
  });

  /**
   * Chromium's own rendering against the bake composited like UI Toolkit draws it, also by Chromium: the page colour,
   * the 9-slice stretched over the shadow rect (CSS border-image, slices at 1:1), then the element (outer shadows) — or
   * the element with its background and border, then the inset 9-slice over its padding box (inset shadows).
   * Every pixel is within ΔE2000 1, or within two code values per channel: blending a stored 8-bit image is rounded
   * differently from drawing the shadow directly, and one code value is more than ΔE 1 on the darkest colours. Not
   * compared: the anti-aliased inner edge of a curved border, which UI Toolkit paints before the inset image (CSS
   * after it).
   */
  const cases: { name: string; shadow: string; radius: string; w: number; h: number; border?: number; borderColor?: string; bg: string }[] = [
    { name: "soft, large element", shadow: "0 8px 24px rgba(0,0,0,0.4)", radius: "12px", w: 600, h: 300, bg: "rgba(255,255,255,0.08)" },
    { name: "soft, just above the 9-slice minimum", shadow: "0 8px 24px rgba(0,0,0,0.4)", radius: "12px", w: 72, h: 66, bg: "rgba(255,255,255,0.08)" },
    { name: "soft, smaller than the 9-slice (baked at its size)", shadow: "0 8px 24px rgba(0,0,0,0.4)", radius: "12px", w: 24, h: 20, bg: "#16c2d5" },
    { name: "hard offset", shadow: "10px 10px 0 #000000", radius: "0px", w: 300, h: 120, bg: "#123c47" },
    { name: "bottom-only hard", shadow: "0 6px 0 0 #16c2d5", radius: "8px", w: 220, h: 64, bg: "rgba(22,194,213,0.2)" },
    { name: "spread ring", shadow: "0 0 0 1px rgba(255,255,255,0.1)", radius: "12px", w: 320, h: 180, bg: "transparent" },
    { name: "large soft with spread", shadow: "0 12px 40px 8px rgba(0,0,0,0.5)", radius: "24px", w: 640, h: 360, bg: "#123c47" },
    { name: "coloured glow on a pill, several shadows", shadow: "0 0 24px 4px rgba(22,194,213,0.6), 0 2px 4px rgba(0,0,0,0.3)", radius: "24px", w: 240, h: 48, bg: "#16c2d5" },
    { name: "uneven corners", shadow: "0 4px 16px rgba(0,0,0,0.5)", radius: "24px 4px 16px 0px", w: 400, h: 200, bg: "rgba(255,255,255,0.05)" },
    { name: "inset under a translucent border", shadow: "inset 0 2px 6px rgba(0,0,0,0.5)", radius: "12px", w: 300, h: 140, border: 3, borderColor: "rgba(22,194,213,0.5)", bg: "rgba(255,255,255,0.08)" },
    { name: "two inset shadows", shadow: "inset 0 1px 0 rgba(255,255,255,0.2), inset 0 -12px 24px -6px rgba(0,0,0,0.6)", radius: "16px", w: 260, h: 120, bg: "#123c47" },
    { name: "odd size 71×33, opaque", shadow: "0 8px 24px rgba(0,0,0,0.4)", radius: "8px", w: 71, h: 33, bg: "#16c2d5" },
    { name: "odd size 51×41, opaque", shadow: "0 8px 24px rgba(0,0,0,0.4)", radius: "12px", w: 51, h: 41, bg: "#123c47" },
    { name: "odd size 301×121, opaque, hard", shadow: "6px 6px 0 #000000", radius: "10px", w: 301, h: 121, bg: "#123c47" },
  ];
  for (const c of cases) {
    it(`composited bake matches Chromium: ${c.name}`, async () => {
      // a typical page position: Chromium rasterises large blurs slightly differently at a few positions (tiling)
      const X = 213, Y = 171, bw = c.border ?? 0, out = tmp();
      const s = (await bakeShadow(bake.page, c.shadow, c.radius, out, { box: { w: c.w, h: c.h }, borders: [bw, bw, bw, bw], opaqueBackground: /^#/.test(c.bg) }))!;
      expect(s).not.toBeNull();
      const png = fs.readFileSync(path.join(out, s.file)).toString("base64");
      const [t, r, b, l] = s.slice!;
      const nine = `<div style="left:${X + s.offset.x}px;top:${Y + s.offset.y}px;width:${c.w + s.offset.w}px;height:${c.h + s.offset.h}px;` +
        `border-style:solid;border-width:${t}px ${r}px ${b}px ${l}px;border-image:url(data:image/png;base64,${png}) ${t} ${r} ${b} ${l} fill / ${t}px ${r}px ${b}px ${l}px stretch"></div>`;
      const el = (style: string) => `<div style="left:${X}px;top:${Y}px;width:${c.w}px;height:${c.h}px;border-radius:${c.radius};${style}"></div>`;
      const borderCss = bw ? `border:${bw}px solid ${c.borderColor};` : "";
      const region = { x: X - 80, y: Y - 80, width: c.w + 160, height: c.h + 160 };
      const golden = await shot(ref, doc(el(`background:${c.bg};${borderCss}box-shadow:${c.shadow}`), PAGE), region, false);
      // UI Toolkit draws an element's background and border together, then its children: the inset image (a child
      // covering the padding box) comes after both, which is the same as CSS's order because it never covers the border
      const composed = /inset/.test(c.shadow) ? el(`background:${c.bg};${borderCss}`) + nine : nine + el(`background:${c.bg}`);
      const baked = await shot(ref, doc(composed, PAGE), region, false);
      const ring = bw ? await shot(ref, doc(el(borderCss)), region) : null;
      let full = 0;
      if (ring) for (let i = 3; i < ring.data.length; i += 4) full = Math.max(full, ring.data[i]);
      let worst = 0, where = "", over = 0, count = 0;
      for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
        if (ring) { const a = pixel(ring, x, y)[3]; if (a > 0 && a < full) continue; }
        count++;
        const g = pixel(golden, x, y), k = pixel(baked, x, y);
        const d = de2000(k, g);
        if (d <= 1) continue;
        over++;
        const ch = Math.max(...k.map((v, i) => Math.abs(v - g[i])));
        if (ch > 2 && d > worst) { worst = d; where = `${x},${y}: ${k} vs ${g}`; }
      }
      expect(worst, `worst ΔE2000 beyond rounding at ${where}`).toBe(0);
      // rounding differences stay rare
      expect(over / count).toBeLessThan(0.03);
    });
  }
});

describe("bake against Chromium at the golden viewport", () => {
  /** A 2560×1440 page like the golden captures: the shadow alone, at many positions, against the bake drawn as a 9-slice. */
  const worstAt = async (shadow: string, radius: string, w: number, h: number, positions: [number, number][]) => {
    const out = tmp();
    const s = (await bakeShadow(bake.page, shadow, radius, out, { box: { w, h } }))!;
    const img = decodePng(fs.readFileSync(path.join(out, s.file)));
    const [t, r, b, l] = s.slice!;
    const map = (d: number, size: number, lo: number, hi: number, src: number) => (d < lo ? d : d >= size - hi ? src - (size - d) : lo);
    const page = await (await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 })).newPage();
    // the bake against Chromium at each position, and Chromium at each position against itself at the first one
    let worst = 0, where = "";
    try {
      let first: Rgba | null = null;
      for (const [X, Y] of positions) {
        await page.setContent(doc(`<div style="left:${X}px;top:${Y}px;width:${w}px;height:${h}px;border-radius:${radius};box-shadow:${shadow}"></div>`));
        const rect = { x: X + s.offset.x, y: Y + s.offset.y, width: w + s.offset.w, height: h + s.offset.h };
        const alone = decodePng(await page.screenshot({ clip: rect, omitBackground: true }));
        first ??= alone;
        let bake = 0, self = 0;
        for (let y = 0; y < alone.h; y++) for (let x = 0; x < alone.w; x++) {
          const a = pixel(alone, x, y), c = pixel(img, map(x, alone.w, l, r, img.w), map(y, alone.h, t, b, img.h)), f = pixel(first, x, y);
          bake = Math.max(bake, ...a.map((v, k) => Math.abs(v - c[k])));
          self = Math.max(self, ...a.map((v, k) => Math.abs(v - f[k])));
        }
        // beyond one code value, the bake may differ only where Chromium differs from itself between positions
        const excess = bake - Math.max(1, self);
        if (excess > worst) { worst = excess; where = `(${X},${Y}) bake ${bake}, Chromium against itself ${self}`; }
      }
    } finally { await page.context().close(); }
    return { worst, where };
  };
  it("matches at 20 page positions (one raster tile per page)", async () => {
    const positions: [number, number][] = Array.from({ length: 20 }, (_, k) => [120 + ((k * 397) % 1700), 90 + ((k * 211) % 900)]);
    const r = await worstAt("0 12px 40px 8px rgba(0,0,0,0.5)", "24px", 640, 360, [[150, 140], ...positions]);
    expect(r.worst, r.where).toBe(0);
  }, 60000);
  it("matches far above the shared size (each size checked against a direct bake)", async () => {
    for (const [w, h] of [[900, 560], [2100, 1100]] as const) {
      const r = await worstAt("0 12px 40px 8px rgba(0,0,0,0.5)", "24px", w, h, [[150, 140]]);
      expect(r.worst, `${w}×${h} ${r.where}`).toBe(0);
    }
  }, 60000);
  it("one bake page per browser, shared by every screen", async () => {
    expect(await sharedBakePage(browser)).toBe(await sharedBakePage(browser));
  });
});

// ---- gradients ----------------------------------------------------------------------------------------------------------
describe("gradientToSvg", () => {
  it("draws a radial gradient that ends transparent as its ellipse when that lies inside the shape, never sampled past its end", () => {
    // the toggle switch's knob: Unity's VectorImage draws a speckled ring where a radial gradient's pad region starts
    const knob = gradientToSvg("radial-gradient(circle 12px at 16px 16px, #ffffff 10px, rgba(255, 255, 255, 0) 11px)", 64, 32, { radii: [16, 16, 16, 16] });
    expect(knob).toContain('<radialGradient id="g0" gradientUnits="userSpaceOnUse" cx="16" cy="16" r="12">');
    expect(knob).toContain('<ellipse cx="16" cy="16" rx="11.22" ry="11.22" fill="url(#g0)"/>');
    // the importer sizes a VectorImage by its shapes' bounds: the box is pinned with a transparent rect
    expect(knob).toContain('<rect x="0" y="0" width="64" height="32" fill="#000000" fill-opacity="0"/>');
    expect(knob).not.toContain("<path");
    // its last stop at the gradient's end: the end moves out a hair (2 %), the ellipse stays inside it
    const edge = gradientToSvg("radial-gradient(circle 12px at 16px 16px, #ffffff 10px, rgba(255, 255, 255, 0) 12px)", 64, 32, { radii: [16, 16, 16, 16] });
    expect(edge).toContain('r="12.24"');
    expect(edge).toContain('<stop offset="0.980392" stop-color="#ffffff" stop-opacity="0"/>');
    expect(edge).toContain('rx="12.12"');
    // an ellipse that leaves the shape (a corner cut by the radius) or a gradient that ends opaque keeps the shape
    expect(gradientToSvg("radial-gradient(circle 12px at 6px 16px, #ffffff 10px, rgba(255, 255, 255, 0) 11px)", 64, 32, { radii: [16, 16, 16, 16] })).toContain("<path");
    expect(gradientToSvg("radial-gradient(circle 12px at 16px 16px, #ffffff 10px, #000000 11px)", 64, 32)).toContain("<rect");
  });

  it("draws an elliptical gradient that ends transparent as its ellipse (ry scaled like the gradient), pinned with other layers", () => {
    const e = gradientToSvg("radial-gradient(ellipse 20px 10px at 32px 16px, #ffffff 80%, rgba(255, 255, 255, 0) 90%)", 64, 32);
    expect(e).toContain('gradientTransform="translate(32 16) scale(1 0.5) translate(-32 -16)"');
    expect(e).toContain('<ellipse cx="32" cy="16" rx="18.36" ry="9.18" fill="url(#g0)"/>');
    expect(e).toContain('<rect x="0" y="0" width="64" height="32" fill="#000000" fill-opacity="0"/>');
    // the knob over a linear layer: the linear layer fills the shape below the ellipse, the box stays pinned
    const two = gradientToSvg("radial-gradient(circle 12px at 16px 16px, #ffffff 10px, rgba(255, 255, 255, 0) 11px), linear-gradient(90deg, #102030, #304050)", 64, 32, { radii: [16, 16, 16, 16] });
    expect(two).toContain('<rect x="0" y="0" width="64" height="32" fill="#000000" fill-opacity="0"/>');
    expect(two.indexOf('fill="url(#g1)"')).toBeLessThan(two.indexOf('<ellipse cx="16" cy="16" rx="11.22" ry="11.22" fill="url(#g0)"/>'));
    expect(two).toMatch(/<path d="M16 0H48[^"]*" fill="url\(#g1\)"\/>/);
  });

  it("writes a linear gradient in user space over the element box", () => {
    const svg = gradientToSvg("linear-gradient(90deg, #000 0%, #fff 100%)", 200, 50);
    expect(svg).toContain("<linearGradient");
    expect(svg).toContain('gradientUnits="userSpaceOnUse"');
    expect(svg).toContain('x1="0"');
    expect(svg).toContain('x2="200"');
    expect(svg.match(/<stop /g)).toHaveLength(2);
    expect(svg).toContain('<stop offset="0" stop-color="#000000"/>');
    expect(svg).toContain('<stop offset="1" stop-color="#ffffff"/>');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="200" height="50" viewBox="0 0 200 50">/);
  });

  it("matches the gradient geometry measured in M0 (angled line, ellipse transform)", () => {
    expect(gradientToSvg("linear-gradient(45deg, #c0572b, #d4a017)", 400, 200)).toContain('x1="50" y1="250" x2="350" y2="-50"');
    expect(gradientToSvg("radial-gradient(ellipse at center, #d4a017, rgba(212,160,23,0))", 400, 200))
      .toContain('cx="200" cy="100" r="282.842712" gradientTransform="translate(200 100) scale(1 0.5) translate(-200 -100)"');
  });

  it("interpolates like CSS (premultiplied): a transparent stop takes its neighbour's colour", () => {
    const svg = gradientToSvg("linear-gradient(90deg, #ff0000, transparent)", 100, 10);
    expect(svg).toContain('<stop offset="1" stop-color="#ff0000" stop-opacity="0"/>');
  });

  it("records the smallest stop spacing between different colours (U-CSS-022 measure)", () => {
    expect(gradientStopGap("linear-gradient(90deg, red 0%, red 40%, blue 60%)", 400, 100)).toBeCloseTo(0.2, 9);
    expect(gradientStopGap("linear-gradient(90deg, red 0px, blue 100px)", 400, 100)).toBeCloseTo(0.25, 9);
    expect(gradientStopGap("linear-gradient(red, red)", 400, 100)).toBeNull();
    expect(gradientStopGap("linear-gradient(90deg, red, blue), radial-gradient(#000 0%, #fff 10%)", 400, 100)).toBeCloseTo(0.1, 9);
    // stops outside the line extend the SVG vector: the gap is a fraction of what the ramp spans
    expect(gradientStopGap("linear-gradient(90deg, red -50%, blue 150%)", 400, 100)).toBeCloseTo(1, 9);
    expect(gradientStopGap("linear-gradient(90deg, red 0%, red 40%, blue 60%, blue 200%)", 400, 100)).toBeCloseTo(0.1, 9);
    expect(gradientStopGap("radial-gradient(circle 100px, red 0px, blue 50px, green 200px)", 400, 100)).toBeCloseTo(0.25, 9);
  });

  it("cuts the gradient to the rounded border box, as CSS clips a background (UI Toolkit ignores border-radius and clip paths for vector images)", () => {
    const g = "linear-gradient(135deg, #f2b544 0%, #f0605d 50%, #16c2d5 100%)";
    const svg = gradientToSvg(g, 280, 200, { radii: [16, 16, 16, 16] });
    expect(svg).toContain('<path d="M16 0H264A16 16 0 0 1 280 16V184A16 16 0 0 1 264 200H16A16 16 0 0 1 0 184V16A16 16 0 0 1 16 0Z" fill="url(#g0)"/>');
    expect(svg).not.toContain("<rect");
    // per-corner radii, a square corner draws no arc
    expect(gradientToSvg(g, 100, 50, { radii: [8, 0, 4, 0] })).toContain('<path d="M8 0H100V46A4 4 0 0 1 96 50H0V8A8 8 0 0 1 8 0Z" fill="url(#g0)"/>');
    // repeated tiles: only a tile on a box corner gets that corner's arc
    const tiled = gradientToSvg("linear-gradient(90deg, #000, #fff)", 100, 100, { borders: [10, 10, 10, 10], radii: [8, 8, 8, 8] });
    expect(tiled.match(/<path /g)?.length).toBe(4); // the four 10×10 corner tiles
    expect(tiled).toContain("<rect"); // the tile in the middle of the border area touches no corner
    // without radii nothing changes
    expect(gradientToSvg(g, 280, 200, { radii: [0, 0, 0, 0] })).toBe(gradientToSvg(g, 280, 200));
    expect(gradientToSvg(g, 280, 200)).not.toContain("<path");
  });

  it("is deterministic and rejects syntax it cannot reproduce", () => {
    const g = "radial-gradient(circle at 25% 25%, #8e44ad, #0b1f26 70%)";
    expect(gradientToSvg(g, 400, 200)).toBe(gradientToSvg(g, 400, 200));
    expect(() => gradientToSvg("linear-gradient(in oklab, red, blue)", 10, 10)).toThrow(/in oklab/);
    expect(() => gradientToSvg("repeating-linear-gradient(red 0px, blue 10px)", 10, 10)).toThrow(/repeating/);
    expect(() => gradientToSvg("conic-gradient(red, blue)", 10, 10)).toThrow(/conic/);
  });

  /**
   * Chromium's CSS gradient against Chromium's rendering of the SVG at the same size, with the border drawn over it as UI
   * Toolkit does: every border pixel and every 3rd inner pixel within ΔE2000 1, or (unless `strict`) one code value per
   * channel (repeated tiles and stacked translucent gradients round differently; one code exceeds ΔE 1 on dark colours).
   */
  const grads: { g: string; w: number; h: number; border?: number; borderColor?: string; repeat?: string; strict?: boolean }[] = [
    { g: "linear-gradient(90deg, #1f8a70, #2c6fbb)", w: 400, h: 200 },
    { g: "linear-gradient(180deg, #00e5ff, #0b1f26)", w: 400, h: 200 },
    { g: "linear-gradient(45deg, #c0572b, #d4a017)", w: 400, h: 200 },
    { g: "linear-gradient(to top right, #ff0000, #0000ff)", w: 500, h: 120 },
    { g: "linear-gradient(200deg, #ff0000 10%, #00ff00 45%, #0000ff 90%)", w: 300, h: 300 },
    { g: "linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.8))", w: 400, h: 100 },
    { g: "linear-gradient(90deg, #16c2d5, transparent 70%)", w: 400, h: 100 },
    { g: "linear-gradient(90deg, rgba(255,0,0,0.9), rgba(0,0,255,0.2))", w: 400, h: 100 },
    { g: "linear-gradient(90deg, red -20%, blue 120%)", w: 400, h: 100 },
    { g: "linear-gradient(red 20px, blue 80px)", w: 200, h: 150 },
    { g: "radial-gradient(circle at center, #00e5ff, #0b1f26)", w: 400, h: 200 },
    { g: "radial-gradient(ellipse at center, #d4a017, rgba(212,160,23,0))", w: 400, h: 200 },
    { g: "radial-gradient(circle at 25% 25%, #8e44ad, #0b1f26 70%)", w: 400, h: 200 },
    { g: "radial-gradient(closest-side at 30% 60%, #ffffff, #000000)", w: 300, h: 160 },
    { g: "radial-gradient(farthest-side, #ff0000, #0000ff)", w: 200, h: 300 },
    { g: "radial-gradient(circle 60px at 20px 30px, #ffffff, #16c2d5 50%, #0b1f26)", w: 240, h: 140 },
    { g: "radial-gradient(80px 40px at 50% 50%, #ffffff, #000000)", w: 240, h: 140 },
    { g: "linear-gradient(180deg, rgba(0,0,0,0.6), transparent), linear-gradient(90deg, #1f8a70, #2c6fbb)", w: 300, h: 150 },
    { g: "linear-gradient(90deg, #1f8a70, #2c6fbb)", w: 300, h: 150, border: 6 },
    // under a translucent border CSS repeats the padding-box tile (glass card)
    { g: "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))", w: 300, h: 150, border: 1, borderColor: "rgba(255,255,255,0.08)", strict: true },
    { g: "linear-gradient(180deg, #16c2d5, #0b1f26)", w: 300, h: 150, border: 1, borderColor: "rgba(255,255,255,0.08)", strict: true },
    { g: "linear-gradient(180deg, #16c2d5, #0b1f26)", w: 300, h: 150, border: 2, borderColor: "rgba(255,255,255,0.3)", repeat: "no-repeat" },
    { g: "linear-gradient(135deg, #16c2d5, #0b1f26 60%, #8e44ad)", w: 280, h: 140, border: 9, repeat: "repeat-x" },
    { g: "linear-gradient(135deg, #16c2d5, #0b1f26 60%, #8e44ad)", w: 280, h: 140, border: 9, repeat: "repeat-y" },
    { g: "radial-gradient(circle at 30% 40%, #ffffff, #16c2d5 50%, #0b1f26)", w: 240, h: 140, border: 12, repeat: "round" },
    { g: "radial-gradient(circle at 30% 40%, #ffffff, #16c2d5 50%, #0b1f26)", w: 240, h: 140, border: 12, repeat: "space" },
    { g: "linear-gradient(90deg, #ff0000, #0000ff)", w: 200, h: 100, border: 7, repeat: "repeat no-repeat" },
    { g: "linear-gradient(rgba(0,0,0,0.5), transparent), linear-gradient(90deg, #1f8a70, #2c6fbb)", w: 260, h: 120, border: 5, repeat: "no-repeat, repeat" },
    // positions with offsets and degenerate shapes (CSS Images 3 §3.2.4)
    { g: "radial-gradient(circle at right 10px top 20px, #ffffff, #000000)", w: 240, h: 140 },
    { g: "radial-gradient(ellipse at left 20px bottom 10%, #ffffff, #16c2d5 60%, #0b1f26)", w: 240, h: 140 },
    { g: "radial-gradient(closest-side at 0% 50%, #ffffff, #000000)", w: 240, h: 140 },
    { g: "radial-gradient(0px 40px at 40% 50%, #ff0000, #0000ff 60px)", w: 240, h: 140 },
    { g: "radial-gradient(closest-side at 50% 0%, #ffffff, #16c2d5)", w: 240, h: 140 },
    { g: "radial-gradient(circle closest-side at 0 0, #ffffff, #000000)", w: 240, h: 140 },
  ];
  for (const c of grads) {
    it(`SVG renders like the CSS gradient: ${c.g}${c.border ? ` (border ${c.border}px${c.borderColor ? ` ${c.borderColor}` : ""})` : ""}${c.repeat ? ` ${c.repeat}` : ""}`, async () => {
      const b = c.border ?? 0, border = `border:${b}px solid ${c.borderColor ?? "transparent"};`;
      const svg = gradientToSvg(c.g, c.w, c.h, { borders: [b, b, b, b], repeat: c.repeat });
      const clip = { x: 0, y: 0, width: c.w, height: c.h };
      const css = await shot(ref, doc(`<div style="left:0;top:0;width:${c.w}px;height:${c.h}px;background-image:${c.g};${b ? border : ""}${c.repeat ? `background-repeat:${c.repeat};` : ""}"></div>`, PAGE), clip, false);
      const over = b ? `<div style="left:0;top:0;width:${c.w}px;height:${c.h}px;${border}"></div>` : "";
      const img = await shot(ref, doc(`<img style="position:absolute;left:0;top:0;width:${c.w}px;height:${c.h}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">${over}`, PAGE), clip, false);
      let worst = 0, where = "";
      for (let y = 0; y < c.h; y += (y < b + 1 || y >= c.h - b - 1 ? 1 : 3)) for (let x = 0; x < c.w; x += (x < b + 1 || x >= c.w - b - 1 ? 1 : 3)) {
        const a = pixel(css, x, y), k = pixel(img, x, y);
        const d = de2000(a, k);
        if (!c.strict && a.every((v, i) => Math.abs(v - k[i]) <= 1)) continue;
        if (d > worst) { worst = d; where = `${x},${y}: ${a} vs ${k}`; }
      }
      expect(worst, `worst ΔE2000 at ${where}`).toBeLessThanOrEqual(1);
    });
  }
});

// ---- export: baked effects per layer ----------------------------------------------------------------------------------
async function build(file: string, outDir = tmp()): Promise<IrBuild & { outDir: string }> {
  const d = await openDesign(file, kit, [2560, 1440], browser);
  try { return { ...(await buildIr(d, await collectSnapshot(d.page, d.cdp, kit), kit, outDir, file)), outDir }; } finally { await d.close(); }
}
async function lintIds(file: string): Promise<string[]> {
  const d = await openDesign(file, kit, [2560, 1440], browser);
  try { return (await lint(d, kit)).map((f) => `${f.ruleId} ${f.path}: ${f.detail}`); } finally { await d.close(); }
}
const flat = (n: IrNode): IrNode[] => [n, ...n.children.flatMap(flat)];
const byId = (root: IrNode, id: string) => flat(root).find((x) => x.id === id)!;
/** A one-screen design page with the kit's base text style and the given CSS and body. */
const page = (css: string, body: string) => {
  const f = path.join(tmp(), "probe.html");
  fs.writeFileSync(f, `<!doctype html><html><head><meta charset="utf-8"><style>:root{-webkit-font-smoothing:antialiased}body{margin:0}.screen{display:flex;flex-direction:column;width:2560px;height:1440px;font-family:"Inter UI";font-size:16px;line-height:20px;color:#ffffff;background-color:#0b1f26}p{margin:0}${css}</style></head>` +
    `<body><div class="screen" data-u-screen="probe"><p data-l10n="probe.t" data-en="T">Başlık</p>${body}</div></body></html>`);
  return f;
};

describe("buildIr: baked effects per layer", () => {
  let r: IrBuild & { outDir: string };
  beforeAll(async () => { r = await build(fx("effects.html")); }, 60000);

  it("the fixture passes lint (inset shadows and gradients included)", async () => {
    expect(await lintIds(fx("effects.html"))).toEqual([]);
  });

  it("bakes the base shadow and a hover lift; box-shadow leaves the style layers", () => {
    const card = byId(r.ir.root, "card");
    // the image reaches out from the box by multiples of 4 px (whole device px at 1, 0.75 and 0.5): 27 → 28, 19 → 20,
    // 27 → 28 and 35 → 36 px of transparent margin, so the 9-slice texels start on the device grid at every viewport
    expect(card.shadow).toMatchObject({ kind: "shadow9", slice: [60, 63, 60, 63], offset: { x: -28, y: -20, w: 56, h: 56 }, tint: false, stopGap: null });
    const o = card.shadow!.offset;
    for (const v of [o.x, o.y, o.x + o.w, o.y + o.h]) expect(Math.abs(v % 4)).toBe(0);
    expect(Object.keys(card.shadowLayers)).toEqual(["hover"]);
    expect(card.shadowLayers.hover!.sha256).not.toBe(card.shadow!.sha256);
    expect(card.shadowLayers.hover!.offset.w).toBeGreaterThan(card.shadow!.offset.w);
    for (const layer of Object.values(card.style)) expect(layer["box-shadow"]).toBeUndefined();
    expect(card.style.hover).toEqual({ translate: "0px -4px" });
    expect(card.anims.map((a) => [a.trigger, a.properties])).toEqual([["hover", ["translate"]], ["hover", ["translate"]]]);
    expect(fs.existsSync(path.join(r.outDir, card.shadow!.file))).toBe(true);
  });

  it("shares one 9-slice between sizes and records a layer without a shadow as null", () => {
    expect(byId(r.ir.root, "card-wide").shadow).toEqual(byId(r.ir.root, "card").shadow);
    expect(byId(r.ir.root, "card-flat").shadowLayers).toEqual({ hover: null });
  });

  it("bakes outer and inset shadows of one declaration into two images; the inset one covers the padding box", () => {
    const panel = byId(r.ir.root, "panel");
    expect(panel.shadow).toMatchObject({ kind: "shadow9" });
    expect(panel.insetShadow).toMatchObject({ kind: "shadow9", offset: { x: 4, y: 4, w: -8, h: -8 } });
    expect(panel.insetShadowLayers).toEqual({});
  });

  it("an element smaller than the shared 9-slice gets its own bake", () => {
    const chip = byId(r.ir.root, "chip"), card = byId(r.ir.root, "card");
    expect(chip.shadow!.sha256).not.toBe(card.shadow!.sha256);
    expect(chip.shadow!.width).toBe(24 + chip.shadow!.offset.w);
    expect(chip.shadow!.height).toBe(20 + chip.shadow!.offset.h);
  });

  it("bakes gradients per layer box into SVG with the stop spacing; background-image leaves the style layers", () => {
    const hero = byId(r.ir.root, "hero");
    expect(hero.background).toMatchObject({ kind: "svg", width: 800, height: 200, stopGap: 0.8, slice: null, tint: false });
    const svg = fs.readFileSync(path.join(r.outDir, hero.background!.file), "utf8");
    expect(svg).toBe(gradientToSvg("linear-gradient(180deg, #16c2d5, #0b1f26 80%)", 800, 200));
    // a breakpoint re-lays the gradient out for its box, a state has another gradient, and both together a third
    const keys = Object.keys(hero.backgroundLayers);
    expect(keys).toHaveLength(3);
    const bp = keys.find((k) => k.startsWith("bp:") && !k.includes("+"))!, both = keys.find((k) => k.includes("+"))!;
    expect(hero.backgroundLayers[bp]).toMatchObject({ width: 800, height: 120 });
    expect(hero.backgroundLayers["state:loading"]).toMatchObject({ width: 800, height: 200, stopGap: 1 });
    expect(hero.backgroundLayers[both]).toMatchObject({ width: 800, height: 120 });
    for (const layer of Object.values(hero.style)) expect(layer["background-image"]).toBeUndefined();
    const pill = byId(r.ir.root, "pill");
    expect(fs.readFileSync(path.join(r.outDir, pill.background!.file), "utf8")).toContain("<radialGradient");
  });

  it("records one text shadow as x y blur colour, and object-fit for the compiler", () => {
    expect(byId(r.ir.root, "title").style.base["text-shadow"]).toBe("0px 1px 2px rgba(0, 0, 0, 0.5)");
    expect(byId(r.ir.root, "pic").style.base["object-fit"]).toBe("cover");
  });

  it("is deterministic: byte-identical IR and assets in another folder", async () => {
    const again = await build(fx("effects.html"));
    expect(stableStringify(again.ir)).toBe(stableStringify(r.ir));
    const files = (d: string) => fs.readdirSync(path.join(d, "assets")).sort();
    expect(files(again.outDir)).toEqual(files(r.outDir));
    for (const f of files(r.outDir)) expect(fs.readFileSync(path.join(again.outDir, "assets", f)).equals(fs.readFileSync(path.join(r.outDir, "assets", f)))).toBe(true);
  }, 60000);
});

describe("lint and export agree on effects", () => {
  const cases: { name: string; css: string; body: string; rule: string | null; error: RegExp | null; others?: string[] }[] = [
    { name: "a box-shadow transition", css: ".c{width:100px;height:60px;flex-shrink:0;box-shadow:0 2px 4px #000000;transition:box-shadow 0.2s ease}.c:hover{box-shadow:0 8px 16px #000000}",
      body: '<div class="c" data-u-id="c"></div>', rule: "U-CSS-014", error: /box-shadow changes in layer hover with a 200ms transition/ },
    { name: "transition: all over a hover shadow", css: ".c{width:100px;height:60px;flex-shrink:0;box-shadow:0 2px 4px #000000;transition:all 0.2s ease}.c:hover{box-shadow:0 8px 16px #000000}",
      body: '<div class="c" data-u-id="c"></div>', rule: "U-CSS-014", error: /box-shadow changes in layer hover/ },
    { name: "a gradient transition", css: ".c{width:100px;height:60px;flex-shrink:0;background-image:linear-gradient(#000000,#ffffff);transition:background-image 0.3s ease}.state-x .c{background-image:linear-gradient(#ffffff,#000000)}",
      body: '<div class="c" data-u-id="c"></div>', rule: "U-CSS-014", error: /background-image changes in layer state:x/ },
    { name: "an image with a gradient", css: ".c{width:100px;height:60px;flex-shrink:0;background-image:url(assets/logo.png),linear-gradient(#000000,#ffffff)}",
      body: '<div class="c" data-u-id="c"></div>', rule: "U-CSS-014", error: /UI Toolkit draws one image/ },
    { name: "a gradient tile", css: ".c{width:100px;height:60px;flex-shrink:0;background-image:linear-gradient(#000000,#ffffff);background-size:100% 4px}",
      body: '<div class="c" data-u-id="c"></div>', rule: "U-CSS-014", error: /background-size 100% 4px/ },
    { name: "a colour space", css: ".c{width:100px;height:60px;flex-shrink:0;background-image:linear-gradient(in oklab,#ff0000,#0000ff)}",
      body: '<div class="c" data-u-id="c"></div>', rule: "U-CSS-014", error: /in oklab/ },
    { name: "a conic gradient (a function U-CSS-024 owns)", css: ".c{width:100px;height:60px;flex-shrink:0;background-image:conic-gradient(#ff0000,#0000ff)}",
      body: '<div class="c" data-u-id="c"></div>', rule: "U-CSS-024", error: /conic/ },
    { name: "a repeating gradient (a function U-CSS-024 owns)", css: ".c{width:100px;height:60px;flex-shrink:0;background-image:repeating-linear-gradient(#ff0000 0px,#0000ff 10px)}",
      body: '<div class="c" data-u-id="c"></div>', rule: "U-CSS-024", error: /repeating/ },
    { name: "a radius transition on a shadowed element", css: ".c{width:100px;height:60px;flex-shrink:0;border-radius:8px;box-shadow:0 2px 4px #000000;transition:border-radius 0.2s ease}.c:hover{border-radius:16px}",
      body: '<div class="c" data-u-id="c"></div>', rule: "U-CSS-014", error: /border-top-left-radius changes in layer hover with a 200ms transition \(entering\), which changes the baked shadow/ },
    { name: "an opaque-to-translucent background transition under a shadow", css: ".c{width:100px;height:60px;flex-shrink:0;background-color:#123c47;box-shadow:0 2px 4px #000000;transition:background-color 0.2s ease}.c:hover{background-color:rgba(18,60,71,0.5)}",
      body: '<div class="c" data-u-id="c"></div>', rule: "U-CSS-014", error: /background-color changes in layer hover .*opaque and translucent/ },
    { name: "an opaque background colour transition under a shadow (same bake)", css: ".c{width:100px;height:60px;flex-shrink:0;background-color:#123c47;box-shadow:0 2px 4px #000000;transition:background-color 0.2s ease}.c:hover{background-color:#16505e}",
      body: '<div class="c" data-u-id="c"></div>', rule: null, error: null },
    { name: "a stop the bake cannot place", css: ".c{width:100px;height:60px;flex-shrink:0;background-image:linear-gradient(#ff0000 1vw,#0000ff)}",
      body: '<div class="c" data-u-id="c"></div>', rule: "U-CSS-014", error: /a stop position cannot be resolved/, others: ["U-CSS-006"] },
    { name: "a radial position with offsets (supported)", css: ".c{width:100px;height:60px;flex-shrink:0;background-image:radial-gradient(circle at right 10px top 20px,#ffffff,#000000)}",
      body: '<div class="c" data-u-id="c"></div>', rule: null, error: null },
    { name: "a zero-radius radial gradient (supported)", css: ".c{width:100px;height:60px;flex-shrink:0;background-image:radial-gradient(closest-side at 0% 50%,#ffffff,#000000)}",
      body: '<div class="c" data-u-id="c"></div>', rule: null, error: null },
    { name: "an inset shadow (supported)", css: ".c{width:100px;height:60px;flex-shrink:0;box-shadow:inset 0 2px 4px #000000}",
      body: '<div class="c" data-u-id="c"></div>', rule: null, error: null },
    { name: "two text shadows", css: ".g{text-shadow:0 1px 0 #000000,0 2px 0 #ff0000}", body: '<p class="g" data-u-id="g" data-l10n="probe.g" data-en="G">Gölge</p>',
      rule: "U-CSS-023", error: /one text shadow/ },
    { name: "object-position other than centre", css: ".i{width:40px;height:40px;flex-shrink:0;object-fit:cover;object-position:left top}",
      body: '<img class="i" data-u-id="i" src="assets/logo.png">', rule: "U-CSS-023", error: null },
    { name: "object-fit none", css: ".i{width:40px;height:40px;flex-shrink:0;object-fit:none}", body: '<img class="i" data-u-id="i" src="assets/logo.png">', rule: "U-CSS-023", error: null },
  ];
  for (const c of cases) {
    it(`${c.name}: ${c.rule ?? "accepted"} by lint${c.error ? ", rejected by export with the same reason" : ""}`, async () => {
      const f = page(c.css, c.body);
      fs.mkdirSync(path.join(path.dirname(f), "assets"), { recursive: true });
      fs.copyFileSync(fx("assets/logo.png"), path.join(path.dirname(f), "assets", "logo.png"));
      // warnings (layout transitions) and the rules named in `others` aside
      const found = (await lintIds(f)).filter((x) => !x.startsWith("W-") && !(c.others ?? []).some((o) => x.startsWith(o)));
      if (c.rule) expect(found, found.join("\n")).toHaveLength(1);
      if (c.rule) expect(found[0].startsWith(c.rule)).toBe(true);
      else expect(found).toEqual([]);
      if (c.error) {
        expect(found.find((x) => x.startsWith(c.rule!))).toMatch(c.error);
        await expect(build(f)).rejects.toThrow(c.error);
      } else if (!c.rule) {
        const r = await build(f);
        expect(validateIrLoose(r.ir)).toEqual([]);
      }
    });
  }
});

describe("buildIr: effect details", () => {
  it("an <img> keeps a gradient background beside its content image", async () => {
    const f = page(".i{width:120px;height:80px;flex-shrink:0;background-image:linear-gradient(90deg,#16c2d5,#0b1f26)}", '<img class="i" data-u-id="i" src="assets/logo.png">');
    fs.mkdirSync(path.join(path.dirname(f), "assets"), { recursive: true });
    fs.copyFileSync(fx("assets/logo.png"), path.join(path.dirname(f), "assets", "logo.png"));
    expect(await lintIds(f)).toEqual([]);
    const i = byId((await build(f)).ir.root, "i");
    expect(i.kind).toBe("image");
    expect(i.asset).toMatchObject({ kind: "image" });
    expect(i.background).toMatchObject({ kind: "svg", width: 120, height: 80 });
    expect(i.style.base["background-image"]).toBeUndefined();
  });

  it("a text shadow without a colour follows the colour of each layer and of the text that inherits it", async () => {
    const f = page(".g{color:#ffffff;text-shadow:0 1px 2px}.g:hover{color:#ff0000}.w{display:flex;flex-direction:column;flex-shrink:0;color:#ffffff;text-shadow:0 2px 0 currentcolor}.w .t{color:#16c2d5}",
      '<p class="g" data-u-id="g" data-l10n="probe.g" data-en="G">Gölge</p><div class="w" data-u-id="w"><p class="t" data-u-id="t" data-l10n="probe.u" data-en="U">Alt</p></div>');
    const r = await build(f);
    expect(byId(r.ir.root, "g").style.base["text-shadow"]).toBe("0px 1px 2px #ffffff");
    expect(byId(r.ir.root, "g").style.hover).toMatchObject({ color: "#ff0000", "text-shadow": "0px 1px 2px #ff0000" });
    // CSS keeps currentcolor in the computed value, so the inheriting text uses its own colour
    const d = await openDesign(f, kit, [2560, 1440], browser);
    try { expect(await d.page.evaluate(() => getComputedStyle(document.querySelector("[data-u-id=t]")!).textShadow)).toContain("rgb(22, 194, 213)"); } finally { await d.close(); }
    expect(byId(r.ir.root, "t").style.base["text-shadow"]).toBe("0px 2px 0px #16c2d5");
    expect(byId(r.ir.root, "w").style.base["text-shadow"]).toBe("0px 2px 0px #ffffff");
  });

  it("an em shadow is baked again where the font size changes", async () => {
    const f = page(".c{width:200px;height:120px;flex-shrink:0;font-size:16px;box-shadow:0 0.5em 1em rgba(0,0,0,0.4)}.c:hover{font-size:24px}", '<div class="c" data-u-id="c"></div>');
    const c = byId((await build(f)).ir.root, "c");
    expect(c.shadow).not.toBeNull();
    expect(c.shadowLayers.hover!.offset.h).toBeGreaterThan(c.shadow!.offset.h);
  });

  it("odd-sized opaque elements are baked at their exact size", async () => {
    const f = page(".c{width:51px;height:41px;flex-shrink:0;background-color:#123c47;box-shadow:0 8px 24px rgba(0,0,0,0.4)}", '<div class="c" data-u-id="c"></div>');
    const c = byId((await build(f)).ir.root, "c");
    expect(c.shadow!.offset).toMatchObject({ w: 56, h: 56 });
    expect([c.shadow!.width, c.shadow!.height]).toEqual([51 + 56, 41 + 56]);
  });

  it("every screen of a run shares the browser's bake page and its cache", async () => {
    const f = page(".c{width:200px;height:120px;flex-shrink:0;box-shadow:0 3px 9px rgba(0,0,0,0.37)}", '<div class="c" data-u-id="c"></div>');
    const first = await build(f), second = await build(f);
    expect(second.ir.root.children[1].shadow).toEqual(first.ir.root.children[1].shadow);
    expect(second.timings.bake).toBeLessThan(Math.max(5, first.timings.bake / 4));
  });
});

describe("bake speed", () => {
  it("bakes a screen with 20 shadowed elements (8 distinct shadows, hover lifts) on one warm page", async () => {
    const shadows = ["0 1px 2px rgba(0,0,0,0.3)", "0 2px 4px rgba(0,0,0,0.3)", "0 4px 8px rgba(0,0,0,0.35)", "0 8px 24px rgba(0,0,0,0.4)",
      "0 12px 40px 8px rgba(0,0,0,0.5)", "0 0 16px 2px rgba(22,194,213,0.5)", "inset 0 4px 0 rgba(255,255,255,0.1)", "12px 12px 0 #000000"];
    const css = shadows.map((v, k) => `.s${k}{box-shadow:${v}}.s${k}.lift:hover{box-shadow:${shadows[(k + 3) % shadows.length]}}`).join("") +
      ".b{width:200px;height:120px;flex-shrink:0;margin:8px;border-radius:12px;background-color:#123c47}.row{display:flex;flex-direction:row;flex-wrap:wrap;flex-shrink:0}";
    const body = `<div class="row" data-u-id="row">${Array.from({ length: 20 }, (_, k) => `<div class="b s${k % shadows.length}${k % 3 === 0 ? " lift" : ""}" data-u-id="b${k}" style="width:${160 + k * 8}px"></div>`).join("")}</div>`;
    const f = page(css, body);
    expect(await lintIds(f)).toEqual([]);
    const r = await build(f);
    const nodes = flat(r.ir.root).filter((n) => n.shadow || n.insetShadow);
    expect(nodes).toHaveLength(20);
    const files = new Set(nodes.flatMap((n) => [n.shadow, n.insetShadow, ...Object.values(n.shadowLayers)].filter(Boolean).map((a) => a!.sha256)));
    console.log(`bake: 20 shadowed elements, ${files.size} files, ${r.timings.bake} ms (extract total ${r.timings.total} ms)`);
    expect(r.timings.bake).toBeLessThan(10000);
  }, 60000);
});
