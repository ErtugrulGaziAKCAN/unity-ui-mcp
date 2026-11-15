import { afterAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, type Rgba } from "../src/bake/png.js";
import type { CaptureBoxes } from "../src/boxes/types.js";
import type { CaptureJob } from "../src/capture/matrix.js";
import { deltaE2000, deltaE2000Lab, isTransparentColor } from "../src/compare/color.js";
import { classLines, compareCapture, compareScreen, cornerInRoundBand, inkColourLimit, readThresholds, summarizeIssues, thresholdsFor, WHOLE, type CaptureContext, type CaptureVerdict, type Thresholds } from "../src/compare/compare.js";
import { captureContext, indexIr } from "../src/compare/context.js";
import { flatAt, nearCurve, ringPoints, type RingPoint } from "../src/compare/samples.js";
import { decodePngAsync, encodePng } from "../src/compare/png.js";
import { writeReport, writeVerdict } from "../src/compare/report.js";
import { writeReportPictures } from "../src/compare/pictures.js";
import { blockSsimMap, maskRects, regionSsim, ssimMasked, unionRect } from "../src/compare/ssim.js";
import { runCli } from "../src/commands.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const T: Thresholds = {
  boxPx: 1, baselinePx: 1, deltaE2000: 1, ssimNonText: 0.99, ssimElement: 0.99, textInkDeltaE: 3, textInkRatio: 0.76, textInkCoverage: 0.15,
  textInkFullPx: 14, textInkDeltaESmall: [[12, 5], [9, 10], [0, 14]], textInkMedianTolerance: 0.2, ssimElementSmall: [], ssimPicture: 0.99,
  textInkDeltaELater: [], textInkLaterBelowPx: 12, textInkCoverageLater: 0.15,
  textInkSmallPx: 0, textInkDeltaEFirstSmall: 3, textInkBandSmall: [0.6, 1.2], textInkMedianToleranceSmall: 0.2, textInkShadowHigh: 1.15,
  ssimRotated: 0.99, ssimRoundEdge: 0.99, deltaE2000RoundEdge: 1, deltaE2000Ring: 1.5, ssimFractionalEdge: 0.99, ssimVectorEdge: 0.99, deltaE2000FractionalEdge: 1,
  ssimResampledPicture: 0.99, deltaE2000ResampledPicture: 1, textInkDirection: 0.66,
};
/** The measured element SSIM limit of rotated animation samples (fidelity-thresholds.json, docs/findings/animation.md). */
const ROTATED = 0.975;
const tmpDirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "compare-")); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// ---- synthetic captures -----------------------------------------------------------------------------------------
type Rgb = [number, number, number];
type Box = CaptureBoxes["elements"][string];
interface R { x: number; y: number; w: number; h: number }

function canvas(w: number, h: number, c: Rgb): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) { data[p * 4] = c[0]; data[p * 4 + 1] = c[1]; data[p * 4 + 2] = c[2]; data[p * 4 + 3] = 255; }
  return { w, h, data };
}
function fill(img: Rgba, r: R, c: Rgb): Rgba {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const o = (y * img.w + x) * 4;
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  }
  return img;
}
/** A rect with fractional edges painted as Chromium anti-aliases it: each pixel blends the colour by its covered area. */
function paint(img: Rgba, r: R, c: Rgb): Rgba {
  for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(img.h, Math.ceil(r.y + r.h)); y++) {
    const cy = Math.min(y + 1, r.y + r.h) - Math.max(y, r.y);
    for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(img.w, Math.ceil(r.x + r.w)); x++) {
      const a = cy * (Math.min(x + 1, r.x + r.w) - Math.max(x, r.x)), o = (y * img.w + x) * 4;
      for (let k = 0; k < 3; k++) img.data[o + k] = Math.round(c[k] * a + img.data[o + k] * (1 - a));
    }
  }
  return img;
}
/** Vertical 1-px stripes: stand-in glyphs. */
function glyphs(img: Rgba, r: R, c: Rgb): Rgba {
  for (let x = r.x; x < r.x + r.w; x += 2) fill(img, { x, y: r.y, w: 1, h: r.h }, c);
  return img;
}
const el = (x: number, y: number, w: number, h: number, o: Partial<Box> = {}): Box => ({ x, y, w, h, visible: true, text: false, lines: [], ...o });
const copy = <T>(v: T): T => structuredClone(v);

/** 320×192: root, a red card, a text label on the card (one line), a blue panel. */
function scene(name = "default@320x192"): { png: Rgba; boxes: CaptureBoxes } {
  const png = canvas(320, 192, [16, 24, 32]);
  fill(png, { x: 32, y: 32, w: 128, h: 96 }, [180, 60, 60]);
  glyphs(png, { x: 50, y: 52, w: 80, h: 12 }, [250, 250, 250]);
  fill(png, { x: 192, y: 32, w: 96, h: 96 }, [40, 120, 200]);
  return {
    png,
    boxes: {
      capture: name, viewport: [320, 192], scale: 1, external: [],
      elements: {
        root: el(0, 0, 320, 192),
        card: el(32, 32, 128, 96),
        label: el(48, 48, 96, 20, { text: true, lines: [{ x: 50, y: 50, w: 82, h: 16, baseline: 62 }] }),
        panel: el(192, 32, 96, 96),
      },
    },
  };
}

describe("deltaE2000", () => {
  it("is 0 for equal colours and below 1 for a one-step grey change", () => {
    expect(deltaE2000([255, 0, 0], [255, 0, 0])).toBe(0);
    const d = deltaE2000([50, 50, 50], [51, 50, 50]);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  });

  it("matches Sharma, Wu and Dalal (2005), pair 1", () => {
    expect(deltaE2000Lab([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
  });

  it("tells painted from transparent CSS colours", () => {
    for (const v of ["transparent", "rgba(0, 0, 0, 0)", "rgb(10 20 30 / 0)", "#0000", "#11223300", "hsla(0, 0%, 0%, 0)", undefined]) expect(isTransparentColor(v)).toBe(true);
    for (const v of ["#112233", "rgb(1, 2, 3)", "rgba(0, 0, 0, 0.1)", "rgb(10 20 30 / 50%)", "#1234", "red"]) expect(isTransparentColor(v)).toBe(false);
  });
});

describe("pinned SSIM", () => {
  it("is 1 for identical images and ignores masked pixels, which are copied from the first image", () => {
    const a = scene().png, b = copy(a);
    expect(ssimMasked(a, b, new Uint8Array(a.w * a.h))).toBe(1);
    fill(b, { x: 200, y: 40, w: 20, h: 20 }, [0, 0, 0]);
    expect(ssimMasked(a, b, new Uint8Array(a.w * a.h))).toBeLessThan(1);
    expect(ssimMasked(a, b, maskRects(a.w, a.h, [{ x: 200, y: 40, w: 20, h: 20 }], 2))).toBe(1);
  });

  it("averages the 8-px grid blocks that overlap a region", () => {
    const a = canvas(64, 64, [0, 0, 0]), b = copy(a);
    fill(b, { x: 8, y: 8, w: 4, h: 8 }, [255, 255, 255]);
    const map = blockSsimMap(a, b, null);
    expect(map.cols).toBe(8);
    const block = map.values[1 * 8 + 1];
    expect(block).toBeLessThan(0.5);
    expect(regionSsim(map, { x: 9, y: 9, w: 6, h: 6 })).toBe(block);
    expect(regionSsim(map, { x: 4, y: 8, w: 8, h: 8 })).toBe((1 + block) / 2);
    expect(regionSsim(map, unionRect({ x: 8, y: 8, w: 8, h: 8 }, { x: 16, y: 8, w: 8, h: 8 }))).toBe((block + 1) / 2);
  });
});

describe("PNG decoding", () => {
  it("decodes every filter type exactly like the generic decoder", async () => {
    const img = scene().png;
    for (let x = 0; x < 320; x += 7) fill(img, { x, y: (x * 3) % 180, w: 3, h: 9 }, [x % 256, (x * 5) % 256, 255 - (x % 256)]);
    for (const filter of [0, 1, 2, 3, 4]) {
      const png = encodePng(img, 6, filter);
      expect(await decodePngAsync(png)).toEqual(decodePng(png));
      expect((await decodePngAsync(png)).data).toEqual(img.data);
    }
  });

  it("decodes RGB captures (Chromium) and other PNGs like the generic decoder", async () => {
    // a Chromium screenshot (colour type 2, RGB) and an RGBA asset (colour type 6)
    const files = [path.join(here, "fixtures", "compare", "chromium-rgb.png"), path.join(here, "fixtures", "lint", "assets", "logo.png")];
    expect(files.map((f) => fs.readFileSync(f)[25])).toEqual([2, 6]);
    for (const f of files) {
      const b = fs.readFileSync(f), fast = await decodePngAsync(b), slow = decodePng(b);
      expect([fast.w, fast.h]).toEqual([slow.w, slow.h]);
      expect(Buffer.compare(Buffer.from(fast.data), Buffer.from(slow.data))).toBe(0);
    }
  });
});

describe("compareCapture", () => {
  it("passes identical captures with SSIM 1", () => {
    const g = scene(), u = scene();
    const v = compareCapture(g, u, [], T);
    expect(v.issues).toEqual([]);
    expect(v).toMatchObject({ pass: true, ssim: 1, capture: "default@320x192" });
    expect(v.maxBoxDelta!.px).toBe(0);
  });

  it("fails an element shifted by 2 px and passes one shifted by 1 px", () => {
    const g = scene();
    const u2 = scene(); u2.boxes.elements.panel.x += 2;
    const v2 = compareCapture(g, u2, [], T);
    expect(v2.pass).toBe(false);
    expect(v2.issues).toEqual([expect.objectContaining({ id: "panel", kind: "box" })]);
    expect(v2.issues[0].detail).toContain("Δx +2.00");
    const u1 = scene(); u1.boxes.elements.panel.x += 1; u1.boxes.elements.panel.h -= 1;
    expect(compareCapture(g, u1, [], T)).toMatchObject({ pass: true, issues: [] });
  });

  it("checks each text line's ink extent: ink 2 px off sideways, or 2 px narrower, fails per line; 1 px passes", () => {
    // the same line box, baseline, ink colour and amount: only the glyphs' horizontal place differs (spacing, kerning, alignment)
    const moved = (dx: number, w = 80) => {
      const s = scene();
      fill(s.png, { x: 32, y: 32, w: 128, h: 96 }, [180, 60, 60]);
      glyphs(s.png, { x: 50 + dx, y: 52, w, h: 12 }, [250, 250, 250]);
      return s;
    };
    const g = scene();
    expect(compareCapture(g, moved(0), [], T)).toMatchObject({ pass: true, issues: [] });
    expect(compareCapture(g, moved(1), [], T)).toMatchObject({ pass: true, issues: [] });
    const off = compareCapture(g, moved(2), [], T);
    expect(off.issues.map((i) => `${i.id}:${i.kind}`)).toEqual(["label:inkExtent"]);
    expect(off.issues[0].detail).toBe("line 1 of 1: text ink left Δ +2.00 px, right Δ +2.00 px, width Δ +0.00 px (limit ±1 px)");
    const narrow = compareCapture(g, moved(0, 76), [], T);
    expect(narrow.issues.map((i) => `${i.id}:${i.kind}`)).toEqual(["label:inkExtent"]);
    expect(narrow.issues[0].detail).toBe("line 1 of 1: text ink left Δ +0.00 px, right Δ -4.00 px, width Δ -4.00 px (limit ±1 px)");
    expect(off.elements.find((r) => r.id === "label")?.inkExtent).toBe(2);
    expect(compareCapture(g, g, [], T).elements.find((r) => r.id === "label")?.inkExtent).toBe(0);
  });

  it("measures where a line's glyphs sit, not how thick a renderer draws their strokes", () => {
    // the same 1-px stems every 6 px; Unity's strokes half a pixel thicker on each side (the outer ink edges move by 0.5,
    // the stems' centres do not)
    const stems = (thick: boolean) => {
      const s = scene();
      fill(s.png, { x: 32, y: 32, w: 128, h: 96 }, [180, 60, 60]);
      for (let x = 51; x < 129; x += 6) {
        fill(s.png, { x, y: 52, w: 1, h: 12 }, [250, 250, 250]);
        if (thick) { paint(s.png, { x: x - 0.5, y: 52, w: 0.5, h: 12 }, [250, 250, 250]); paint(s.png, { x: x + 1, y: 52, w: 0.5, h: 12 }, [250, 250, 250]); }
      }
      return s;
    };
    const v = compareCapture(stems(false), stems(true), [], { ...T, textInkRatio: 1, textInkCoverage: 1 });
    expect(v.issues.filter((i) => i.kind === "inkExtent")).toEqual([]);
    expect(v.elements.find((r) => r.id === "label")!.inkExtent!).toBeLessThan(0.1);
  });

  it("compares boxes and baselines with a float epsilon of 1e-3 px, never a wider tolerance", () => {
    // a frame at a half CSS pixel at scale 0.75 (366 → 274.5 device px) that UI Toolkit snaps: 1 px off, plus float32 noise
    const line = (y: number) => ({ x: 50, y, w: 82, h: 16, baseline: y + 12 });
    const g = scene(), u = scene();
    u.boxes.elements.panel.x += 1.000008;
    g.boxes.elements.label.lines = [line(50)];
    u.boxes.elements.label.lines = [{ ...line(50), baseline: 62 + 1.0004 }];
    expect(compareCapture(g, u, [], T)).toMatchObject({ pass: true, issues: [] });
    const far = scene(); far.boxes.elements.panel.x += 1.002;
    far.boxes.elements.label.lines = [{ ...line(50), baseline: 62 - 1.0011 }];
    expect(compareCapture(g, far, [], T).issues.map((i) => `${i.id}:${i.kind}`).sort()).toEqual(["label:baseline", "panel:box"]);
  });

  it("skips an element hidden on both sides and reports one hidden only in Unity as a visibility issue, never a box delta", () => {
    const g = scene(), u = scene();
    g.boxes.elements.panel = el(0, 0, 0, 0, { visible: false });
    u.boxes.elements.panel = el(192, 32, 96, 96, { visible: false });
    fill(g.png, { x: 192, y: 32, w: 96, h: 96 }, [16, 24, 32]);
    fill(u.png, { x: 192, y: 32, w: 96, h: 96 }, [16, 24, 32]);
    expect(compareCapture(g, u, [], T)).toMatchObject({ pass: true, issues: [] });

    const g2 = scene(), u2 = scene();
    u2.boxes.elements.panel = el(0, 0, 0, 0, { visible: false });
    fill(u2.png, { x: 192, y: 32, w: 96, h: 96 }, [16, 24, 32]);
    const v = compareCapture(g2, u2, [], T);
    expect(v.pass).toBe(false);
    expect(v.issues.filter((i) => i.id === "panel").map((i) => i.kind)).toEqual(["visibility"]);
    expect(v.issues.find((i) => i.id === "panel")!.detail).toBe("visible in the design, hidden in Unity");
  });

  it("accepts an element the compiler removed and reports any other absent element as missing", () => {
    const g = scene(), u = scene();
    g.boxes.elements.wrapper = el(32, 32, 128, 96);
    expect(compareCapture(g, u, ["wrapper"], T)).toMatchObject({ pass: true, issues: [] });
    const v = compareCapture(g, u, [], T);
    expect(v.issues).toEqual([expect.objectContaining({ id: "wrapper", kind: "missing" })]);
  });

  it("fails a text with a different line count, and a baseline off by more than baselinePx", () => {
    const line = (y: number) => ({ x: 50, y, w: 82, h: 16, baseline: y + 12 });
    const g = scene(), u = scene();
    g.boxes.elements.label.lines = [line(50), line(70), line(90)];
    u.boxes.elements.label.lines = [line(50), line(70)];
    expect(compareCapture(g, u, [], T).issues).toEqual([expect.objectContaining({ id: "label", kind: "lines", detail: "3 lines in the design, 2 in Unity" })]);

    const g2 = scene(), u2 = scene();
    g2.boxes.elements.label.lines = [line(50), line(70)];
    u2.boxes.elements.label.lines = [line(50), { ...line(70), baseline: 82 + 1.5 }];
    const v = compareCapture(g2, u2, [], T);
    expect(v.issues).toEqual([expect.objectContaining({ id: "label", kind: "baseline" })]);
    expect(v.issues[0].detail).toContain("line 2 of 2: baseline Δ +1.50 px");
    u2.boxes.elements.label.lines[1].baseline = 82 + 0.75;
    expect(compareCapture(g2, u2, [], T).pass).toBe(true);
  });

  it("does not compare lines of text that is not in DOM text (inputs, selects)", () => {
    const g = scene(), u = scene();
    g.boxes.elements.field = el(200, 140, 80, 24, { text: true, lines: [] });
    u.boxes.elements.field = el(200, 140, 80, 24, { text: true, lines: [{ x: 204, y: 144, w: 40, h: 16, baseline: 156 }] });
    const v = compareCapture(g, u, [], T);
    expect(v.pass).toBe(true);
    expect(v.linesNotCompared).toEqual(["field"]);
    expect(v.elements.find((r) => r.id === "field")!.lines).toBe("not compared");
  });

  it("samples background colours and fails a ΔE2000 above the limit", () => {
    const g = scene(), u = scene();
    fill(u.png, { x: 192, y: 32, w: 96, h: 96 }, [40, 126, 200]);
    const v = compareCapture(g, u, [], T);
    const c = v.issues.find((i) => i.id === "panel" && i.kind === "color")!;
    expect(c.detail).toMatch(/^ΔE2000 \d+\.\d\d at \(\d+, \d+\): design #2878c8, Unity #287ec8 \(limit 1\)$/);
    // a one-step change stays within the limit
    const u2 = scene();
    fill(u2.png, { x: 192, y: 32, w: 96, h: 96 }, [41, 120, 200]);
    expect(compareCapture(g, u2, [], T).pass).toBe(true);
    // elements the IR says paint no background are not sampled
    expect(compareCapture(g, u, [], T, { backgrounds: new Set(["root", "card"]) }).issues.some((i) => i.kind === "color")).toBe(false);
  });

  it("samples the background of an element that carries its own text (a button) outside its text lines", () => {
    const mk = (bg: Rgb) => {
      const s = scene();
      fill(s.png, { x: 192, y: 140, w: 96, h: 40 }, bg);
      glyphs(s.png, { x: 214, y: 154, w: 52, h: 12 }, [255, 255, 255]);
      s.boxes.elements.btn = el(192, 140, 96, 40, { text: true, lines: [{ x: 212, y: 152, w: 56, h: 16, baseline: 164 }] });
      return s;
    };
    const g = mk([30, 140, 90]);
    expect(compareCapture(g, mk([30, 140, 90]), [], T).pass).toBe(true);
    const v = compareCapture(g, mk([30, 150, 90]), [], T);
    expect(v.issues.map((i) => `${i.id}:${i.kind}`).sort()).toEqual(["btn:color", "btn:edge", "btn:ssim"]);
    // measured with only its text lines copied from the design
    expect(v.elements.find((r) => r.id === "btn")!.ssim).toBeLessThan(0.99);
  });

  it("masks text glyphs and external regions from SSIM and colour", () => {
    // the same glyphs rasterised 1 px to the right
    const g = scene(), u = scene();
    fill(u.png, { x: 48, y: 48, w: 96, h: 20 }, [180, 60, 60]);
    glyphs(u.png, { x: 51, y: 52, w: 80, h: 12 }, [250, 250, 250]);
    expect(compareCapture(g, u, [], T)).toMatchObject({ pass: true, ssim: 1, issues: [] });

    const g2 = scene(), u2 = scene();
    g2.boxes.elements.video = el(208, 48, 64, 64); g2.boxes.external = ["video"];
    u2.boxes.elements.video = el(208, 48, 64, 64); u2.boxes.external = ["video"];
    fill(u2.png, { x: 208, y: 48, w: 64, h: 64 }, [0, 0, 0]);
    expect(compareCapture(g2, u2, [], T)).toMatchObject({ pass: true, ssim: 1 });

    // the design paints an external placeholder (a host's shell), the compiled screen keeps its box and paints nothing
    const g3 = scene(), u3 = scene();
    g3.boxes.elements.shell = el(0, 0, 320, 40); g3.boxes.external = ["shell"];
    u3.boxes.elements.shell = el(0, 0, 320, 40); u3.boxes.external = ["shell"];
    fill(g3.png, { x: 0, y: 0, w: 320, h: 40 }, [11, 31, 38]);
    const v3 = compareCapture(g3, u3, [], T);
    expect(v3.issues).toEqual([]);
    expect(v3.pass).toBe(true);
  });

  it("finds an element-sized defect with the element SSIM that the whole-capture SSIM dilutes", () => {
    const mk = () => {
      const png = canvas(640, 384, [30, 30, 30]);
      fill(png, { x: 96, y: 96, w: 32, h: 32 }, [200, 200, 200]);
      return { png, boxes: { capture: "c", viewport: [640, 384] as [number, number], scale: 1, external: [], elements: { root: el(0, 0, 640, 384), chip: el(96, 96, 32, 32) } } };
    };
    const g = mk(), u = mk();
    // the design's chip has a dashed inner pattern, Unity's is solid
    for (let x = 98; x < 126; x += 4) fill(g.png, { x, y: 98, w: 2, h: 28 }, [30, 30, 30]);
    const v = compareCapture(g, u, [], T, { backgrounds: new Set() });
    expect(v.ssim!).toBeGreaterThan(0.99);
    expect(v.issues).toEqual([expect.objectContaining({ id: "chip", kind: "ssim" })]);
    expect(v.worstElement!.id).toBe("chip");
  });

  it("checks the band of a baked shadow, so a faint missing shadow fails", () => {
    const mk = () => {
      const png = canvas(320, 192, [40, 40, 40]);
      fill(png, { x: 120, y: 60, w: 80, h: 64 }, [90, 90, 160]);
      return { png, boxes: { capture: "c", viewport: [320, 192] as [number, number], scale: 1, external: [], elements: { root: el(0, 0, 320, 192), card: el(120, 60, 80, 64) } } };
    };
    const g = mk(), u = mk();
    const shadow = { x: 108, y: 56, w: 104, h: 88 };
    // faint shadow in the design: the band 4 levels darker
    for (let y = shadow.y; y < shadow.y + shadow.h; y++) for (let x = shadow.x; x < shadow.x + shadow.w; x++) {
      if (x >= 120 && x < 200 && y >= 60 && y < 124) continue;
      fill(g.png, { x, y, w: 1, h: 1 }, [36, 36, 36]);
    }
    const ctx: CaptureContext = { shadows: { card: shadow }, backgrounds: new Set(["card"]) };
    const v = compareCapture(g, u, [], T, ctx);
    const kinds = v.issues.filter((i) => i.id === "card").map((i) => i.kind);
    expect(kinds).toContain("shadow");
    expect(v.issues.find((i) => i.kind === "shadow")!.detail).toMatch(/^shadow band ΔE2000 \d+\.\d\d: design #242424, Unity #282828 \(limit 1\)$/);
    expect(v.elements.find((r) => r.id === "card")!.band).toBeGreaterThan(1);
    // Unity draws it: no issue
    expect(compareCapture(g, copy(g), [], T, ctx)).toMatchObject({ pass: true });
  });

  it("refuses to compare images of different sizes (a HiDPI capture)", () => {
    const g = scene(), u = scene();
    u.png = canvas(640, 384, [16, 24, 32]);
    const v = compareCapture(g, u, [], T);
    expect(v).toMatchObject({ pass: false, ssim: null });
    expect(v.issues).toEqual([expect.objectContaining({ id: WHOLE, kind: "size", detail: "Unity capture is 640×384 px, the design 320×192 px; images not compared" })]);
  });

  it("fails the whole capture when the SSIM over everything drops below ssimNonText", () => {
    const g = scene(), u = scene();
    fill(u.png, { x: 0, y: 140, w: 320, h: 52 }, [240, 240, 240]);
    const v = compareCapture(g, u, [], T);
    expect(v.issues.some((i) => i.id === WHOLE && i.kind === "ssim")).toBe(true);
  });
});

describe("compareCapture: edge, colour and ink checks", () => {
  /** 320×192, a card with a child panel covering its whole inset grid. */
  const covered = (cardColour: Rgb) => {
    const png = canvas(320, 192, [16, 24, 32]);
    fill(png, { x: 40, y: 40, w: 200, h: 100 }, cardColour);
    fill(png, { x: 48, y: 48, w: 184, h: 84 }, [200, 200, 200]);
    return { png, boxes: { capture: "c", viewport: [320, 192] as [number, number], scale: 1, external: [],
      elements: { root: el(0, 0, 320, 192), card: el(40, 40, 200, 100), panel: el(48, 48, 184, 84) } } };
  };

  it("never skips a background silently: covered grid points fall back to samples inside the border", () => {
    const ctx: CaptureContext = { order: ["root", "card", "panel"], backgrounds: new Set(["root", "card", "panel"]), painters: new Set(["root", "card", "panel"]) };
    const g = covered([120, 40, 160]);
    expect(compareCapture(g, covered([120, 40, 160]), [], T, ctx)).toMatchObject({ pass: true, notSampled: [] });
    const v = compareCapture(g, covered([40, 120, 160]), [], T, ctx);
    expect(v.issues.find((i) => i.id === "card" && i.kind === "color")!.detail).toMatch(/inside the (top|bottom|left|right) edge/);
    expect(v.elements.find((r) => r.id === "card")!.samples).toBeGreaterThan(0);
  });

  it("reports an element with no sample left as not sampled", () => {
    const mk = () => {
      const s = covered([120, 40, 160]);
      fill(s.png, { x: 40, y: 40, w: 200, h: 100 }, [200, 200, 200]);
      s.boxes.elements.panel = el(40, 40, 200, 100);
      return s;
    };
    const ctx: CaptureContext = { order: ["root", "card", "panel"], backgrounds: new Set(["root", "card", "panel"]), painters: new Set(["root", "card", "panel"]) };
    const v = compareCapture(mk(), mk(), [], T, ctx);
    expect(v.notSampled).toEqual(["card"]);
    expect(v.elements.find((r) => r.id === "card")).toMatchObject({ samples: 0, deltaE: null });
  });

  it("does not let an element that paints nothing cover another's samples", () => {
    const g = covered([120, 40, 160]), u = covered([40, 120, 160]);
    for (const s of [g, u]) fill(s.png, { x: 48, y: 48, w: 184, h: 84 }, s === g ? [120, 40, 160] : [40, 120, 160]);
    // the panel is a transparent wrapper: the card's own colour shows through it and is sampled on the grid
    const ctx: CaptureContext = { order: ["root", "card", "panel"], backgrounds: new Set(["root", "card"]), painters: new Set(["root", "card"]) };
    const v = compareCapture(g, u, [], T, ctx);
    expect(v.issues.find((i) => i.id === "card" && i.kind === "color")!.detail).toMatch(/^ΔE2000 [\d.]+ at \(\d+, \d+\)/);
  });

  /** A 160×48 badge on a dark background: radius r (0 = square), a border, its text in the middle. */
  const badge = (o: { r?: number; border?: Rgb; text?: Rgb; thick?: number; bg?: Rgb } = {}) => {
    const png = canvas(320, 192, [16, 24, 32]);
    const r = o.r ?? 0, x0 = 80, y0 = 72, w = 160, h = 48;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const cx = Math.min(Math.max(x + 0.5, x0 + r), x0 + w - r), cy = Math.min(Math.max(y + 0.5, y0 + r), y0 + h - r);
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) continue;
      const edge = x < x0 + 2 || x >= x0 + w - 2 || y < y0 + 2 || y >= y0 + h - 2;
      fill(png, { x, y, w: 1, h: 1 }, edge && !r ? (o.border ?? [90, 200, 120]) : (o.bg ?? [30, 140, 90]));
    }
    for (let x = 120; x < 200; x += 4) fill(png, { x, y: 90, w: o.thick ?? 1, h: 12 }, o.text ?? [250, 250, 250]);
    return { png, boxes: { capture: "c", viewport: [320, 192] as [number, number], scale: 1, external: [],
      elements: { root: el(0, 0, 320, 192), badge: el(x0, y0, w, h, { text: true, lines: [{ x: 118, y: 88, w: 84, h: 16, baseline: 100 }] }) } } };
  };
  const bctx: CaptureContext = { order: ["root", "badge"], backgrounds: new Set(["root", "badge"]), painters: new Set(["root", "badge"]), borders: { badge: [2, 2, 2, 2] } };

  it("checks a text-carrying element's corners, border and background around its text", () => {
    expect(compareCapture(badge(), badge(), [], T, bctx)).toMatchObject({ pass: true, issues: [] });
    const round = compareCapture(badge(), badge({ r: 24 }), [], T, bctx);
    expect(round.issues.map((i) => i.kind)).toEqual(expect.arrayContaining(["edge", "ssim"]));
    expect(round.issues.find((i) => i.kind === "edge")!.detail).toMatch(/corner|border/);
    const border = compareCapture(badge(), badge({ border: [200, 90, 120] }), [], T, bctx);
    expect(border.issues.find((i) => i.kind === "edge")!.detail).toMatch(/border/);
  });

  it("judges a text line a later element partly covers on its visible part only", () => {
    // an open popup (later in paint order, an opaque fill with rounded corners) covers the right half of the label's line;
    // its content differs between the renderers (bright text in the design, another colour in Unity)
    const ctx: CaptureContext = {
      order: ["root", "card", "label", "panel", "popup"], backgrounds: new Set(["root", "card", "panel", "popup"]),
      painters: new Set(["root", "card", "panel", "popup"]), opaque: new Set(["root", "card", "panel", "popup"]), fontPx: { label: 16 },
      radii: { popup: [4, 4, 4, 4] },
    };
    const pop = (s: ReturnType<typeof scene>, text: Rgb) => {
      fill(s.png, { x: 90, y: 44, w: 60, h: 40 }, [20, 40, 52]);
      glyphs(s.png, { x: 96, y: 52, w: 40, h: 12 }, text);
      s.boxes.elements.popup = el(90, 44, 60, 40);
      return s;
    };
    const g = pop(scene(), [255, 255, 255]), u = pop(scene(), [90, 200, 255]);
    const v = compareCapture(g, u, [], T, ctx);
    expect(v.issues.filter((i) => i.id === "label")).toEqual([]);
    expect(v.elements.find((r) => r.id === "label")!.ink).toBe(0);
    expect(v.linesCovered).toEqual([]);
    // the visible part is still judged: a wrong colour there fails
    const wrong = pop(scene(), [90, 200, 255]);
    glyphs(wrong.png, { x: 50, y: 52, w: 40, h: 12 }, [250, 210, 60]);
    expect(compareCapture(g, wrong, [], T, ctx).issues.map((i) => `${i.id}:${i.kind}`)).toContain("label:ink");
  });

  it("still judges text under a translucent scrim, a border-only box or a shadow", () => {
    // a later full-screen scrim (half-transparent black: a painter, not opaque) over the label: a wrong text colour fails
    const ctx: CaptureContext = {
      order: ["root", "card", "label", "panel", "scrim"], backgrounds: new Set(["root", "card", "panel", "scrim"]),
      painters: new Set(["root", "card", "panel", "scrim"]), opaque: new Set(["root", "card", "panel"]), fontPx: { label: 16 },
      shadows: { scrim: { x: 0, y: 0, w: 320, h: 192 } },
    };
    const scrim = (s: ReturnType<typeof scene>, text: Rgb) => {
      glyphs(s.png, { x: 50, y: 52, w: 80, h: 12 }, text);
      for (let i = 0; i < s.png.data.length; i += 4) for (let k = 0; k < 3; k++) s.png.data[i + k] = Math.round(s.png.data[i + k] / 2);
      s.boxes.elements.scrim = el(0, 0, 320, 192);
      return s;
    };
    const g = scrim(scene(), [250, 250, 250]);
    expect(compareCapture(g, scrim(scene(), [250, 250, 250]), [], T, ctx).issues.filter((i) => i.id === "label")).toEqual([]);
    expect(compareCapture(g, scrim(scene(), [250, 210, 60]), [], T, ctx).issues.map((i) => `${i.id}:${i.kind}`)).toContain("label:ink");
  });

  it("reports a line an opaque later element covers entirely as not judged (covered)", () => {
    const ctx: CaptureContext = {
      order: ["root", "card", "label", "panel", "sheet"], backgrounds: new Set(["root", "card", "panel", "sheet"]),
      painters: new Set(["root", "card", "panel", "sheet"]), opaque: new Set(["root", "card", "panel", "sheet"]), fontPx: { label: 16 },
    };
    const sheet = (s: ReturnType<typeof scene>) => { fill(s.png, { x: 40, y: 40, w: 110, h: 40 }, [20, 40, 52]); s.boxes.elements.sheet = el(40, 40, 110, 40); return s; };
    const v = compareCapture(sheet(scene()), sheet(scene()), [], T, ctx);
    expect(v.linesCovered).toEqual(["label: line 1 of 1"]);
    expect(v.elements.find((r) => r.id === "label")!.lines).toBe("1/1, 1 not judged (covered)");
  });

  it("checks the text ink: colour and amount", () => {
    expect(compareCapture(badge(), badge(), [], T, bctx).elements.find((r) => r.id === "badge")).toMatchObject({ ink: 0, inkRatio: 1 });
    const colour = compareCapture(badge(), badge({ text: [250, 210, 60] }), [], T, bctx);
    expect(colour.issues.map((i) => `${i.id}:${i.kind}`)).toEqual(["badge:ink"]);
    expect(colour.issues[0].detail).toMatch(/^line 1 of 1: text colour ΔE2000 [\d.]+, design #fafafa, Unity #fad23c \(limit 5 at 12 px\)$/);
    const bold = compareCapture(badge(), badge({ thick: 2 }), [], T, bctx);
    expect(bold.issues.map((i) => `${i.id}:${i.kind}`)).toEqual(["badge:inkCoverage"]);
    expect(bold.issues[0].detail).toMatch(/Unity draws 2\.00× the design's text ink \(expected 0\.65–1\.15×\)/);
    // a thinner renderer within the measured ratio passes
    expect(compareCapture(badge({ thick: 2 }), badge({ thick: 2, text: [250, 250, 250] }), [], T, bctx).pass).toBe(true);
  });

  it("limits a line's ink colour by its device font size: textInkDeltaE from textInkFullPx, the measured table below", () => {
    // Unity's thinner stems never reach the design's colour at small sizes (macOS font smoothing in the golden)
    const lighter = badge({ text: [222, 222, 222] });
    const at = (px: number): CaptureContext => ({ ...bctx, fontPx: { badge: px } });
    const de = compareCapture(badge(), lighter, [], T, at(16)).elements.find((r) => r.id === "badge")!.ink!;
    expect(de).toBeGreaterThan(5);
    expect(de).toBeLessThan(10);
    const full = compareCapture(badge(), lighter, [], T, at(16));
    expect(full.issues.map((i) => `${i.id}:${i.kind}`)).toEqual(["badge:ink"]);
    expect(full.issues[0].detail).toMatch(/\(limit 3 at 16 px\)$/);
    expect(compareCapture(badge(), lighter, [], T, at(12)).issues[0].detail).toMatch(/\(limit 5 at 12 px\)$/);
    expect(compareCapture(badge(), lighter, [], T, at(9)).pass).toBe(true);
    expect(compareCapture(badge(), lighter, [], T, at(6)).pass).toBe(true);
    // a wrong colour still fails at any size
    expect(compareCapture(badge(), badge({ text: [250, 210, 60] }), [], T, at(6)).issues.map((i) => i.kind)).toEqual(["ink"]);
    // without the IR's font size the line box height stands in (16 px line × 3/4: 12 px)
    expect(compareCapture(badge(), lighter, [], T, bctx).issues[0].detail).toMatch(/\(limit 5 at 12 px\)$/);
  });

  it("lets a line whose text has a blurred shadow draw up to textInkShadowHigh of the design's ink, and holds its colour as usual", () => {
    // the glow's pixels inside the line count as ink, and Unity's glow edge puts a little more of it there
    const mk = (stripes: number, ink: Rgb = [250, 250, 250]) => {
      const png = canvas(320, 192, [16, 24, 32]);
      for (let k = 0; k < stripes; k++) fill(png, { x: 50 + 2 * k, y: 52, w: 1, h: 12 }, ink);
      return { png, boxes: { capture: "c", viewport: [320, 192] as [number, number], scale: 1, external: [], elements: {
        root: el(0, 0, 320, 192), label: el(46, 48, 160, 20, { text: true, lines: [{ x: 48, y: 50, w: 150, h: 16, baseline: 62 }] }),
      } } };
    };
    const t: Thresholds = { ...T, textInkRatio: 1, textInkCoverage: 0.1, textInkShadowHigh: 1.15 };
    const plain: CaptureContext = { fontPx: { label: 24 }, backgrounds: new Set(), painters: new Set() };
    const glow: CaptureContext = { ...plain, textShadows: new Set(["label"]) };
    // 45 stripes for the design's 40: 1.125× (the stand-in runs differ in length too: their ink extent is left out here, it
    // has its own test)
    const kinds = (v: ReturnType<typeof compareCapture>) => v.issues.map((i) => i.kind).filter((k) => k !== "inkExtent");
    expect(kinds(compareCapture(mk(40), mk(45), [], t, plain))).toEqual(["inkCoverage"]);
    expect(kinds(compareCapture(mk(40), mk(45), [], t, glow))).toEqual([]);
    // more than the limit, a colour error and too little ink still fail
    expect(kinds(compareCapture(mk(40), mk(48), [], t, glow))).toEqual(["inkCoverage"]);
    expect(kinds(compareCapture(mk(40), mk(45, [250, 210, 60]), [], t, glow))).toEqual(["ink"]);
    expect(kinds(compareCapture(mk(40), mk(34), [], t, glow))).toEqual(["inkCoverage"]);
  });

  it("holds text of at most textInkSmallPx device px to the measured small-text limits and text above it to the usual ones", () => {
    // small text: the renderer's stems differ by fractions of a pixel, so the ink colour and amount scatter more than at larger sizes
    const t: Thresholds = { ...T, textInkFullPx: 9, textInkDeltaE: 2, textInkDeltaESmall: [[8, 3], [0, 10]], textInkSmallPx: 12, textInkDeltaEFirstSmall: 4.5, textInkBandSmall: [0.8, 1.25] };
    const at = (px: number): CaptureContext => ({ ...bctx, fontPx: { badge: px } });
    const text: Rgb = [232, 232, 232];
    const de = compareCapture(badge(), badge({ text }), [], t, at(12)).elements.find((r) => r.id === "badge")!.ink!;
    // inside the small-text limit (4.5), over the usual one (2)
    expect(de).toBeGreaterThan(2);
    expect(de).toBeLessThan(4.5);
    expect(compareCapture(badge(), badge({ text }), [], t, at(12)).issues).toEqual([]);
    expect(compareCapture(badge(), badge({ text }), [], t, at(9)).issues).toEqual([]);
    // the same colour error on text above the small-text size still fails
    const big = compareCapture(badge(), badge({ text }), [], t, at(14));
    expect(big.issues.map((i) => `${i.id}:${i.kind}`)).toEqual(["badge:ink"]);
    expect(big.issues[0].detail).toMatch(/\(limit 2 at 14 px\)$/);
    // and a wrong colour fails at the small size too
    expect(compareCapture(badge(), badge({ text: [250, 210, 60] }), [], t, at(12)).issues.map((i) => i.kind)).toEqual(["ink"]);
  });

  it("compares light text and dark text each with its own median ink ratio (font smoothing differs by polarity)", () => {
    const mk = (lines: { thick: number; dark: boolean }[]) => {
      const png = canvas(320, 320, [16, 24, 32]);
      const elements: Record<string, Box> = { root: el(0, 0, 320, 320) };
      lines.forEach((l, k) => {
        const y = 20 + k * 48;
        if (l.dark) fill(png, { x: 30, y: y - 8, w: 220, h: 32 }, [240, 242, 244]);
        for (let x = 40; x < 200; x += 24) fill(png, { x, y: y + 2, w: l.thick, h: 12 }, l.dark ? [12, 30, 38] : [250, 250, 250]);
        elements[`t${k}`] = el(36, y - 2, 200, 20, { text: true, lines: [{ x: 38, y, w: 164, h: 16, baseline: y + 12 }] });
      });
      return { png, boxes: { capture: "c", viewport: [320, 320] as [number, number], scale: 1, external: [], elements } };
    };
    const design = [...[0, 1, 2].map(() => ({ thick: 10, dark: false })), ...[0, 1, 2].map(() => ({ thick: 10, dark: true }))];
    // light text at 0.7 of the design's ink, dark text at the design's: one capture-wide median (0.85) would fail both groups
    const unity = [...[0, 1, 2].map(() => ({ thick: 7, dark: false })), ...[0, 1, 2].map(() => ({ thick: 10, dark: true }))];
    expect(compareCapture(mk(design), mk(unity), [], T).issues.filter((i) => i.kind === "inkCoverage")).toEqual([]);
    // within its group a line still stands out
    const odd = unity.map((l, k) => (k === 1 ? { ...l, thick: 10 } : l));
    const v = compareCapture(mk(design), mk(odd), [], T);
    expect(v.issues.filter((i) => i.kind === "inkCoverage").map((i) => i.id)).toEqual(["t1"]);
    expect(v.issues.find((i) => i.kind === "inkCoverage")!.detail).toMatch(/against the median 0\.70× of this capture's light text \(limit ±20 %\)/);
  });

  it("lets text of at most textInkSmallPx device px deviate further from the capture's median ink ratio (textInkMedianToleranceSmall)", () => {
    const mk = (thick: number[]) => {
      const png = canvas(320, 224, [16, 24, 32]);
      const elements: Record<string, Box> = { root: el(0, 0, 320, 224) };
      thick.forEach((w, k) => {
        const y = 20 + k * 48;
        for (let x = 40; x < 200; x += 40) fill(png, { x, y: y + 2, w, h: 12 }, [250, 250, 250]);
        elements[`t${k}`] = el(36, y - 2, 200, 20, { text: true, lines: [{ x: 38, y, w: 164, h: 16, baseline: y + 12 }] });
      });
      return { png, boxes: { capture: "c", viewport: [320, 224] as [number, number], scale: 1, external: [], elements } };
    };
    // Unity draws 0.8 of the design's ink on three lines and 0.96 on the fourth: +20 % against the median
    const design = mk([25, 25, 25, 25]), unity = mk([20, 20, 20, 24]);
    const t: Thresholds = { ...T, textInkMedianTolerance: 0.15, textInkSmallPx: 12, textInkDeltaEFirstSmall: 4.5, textInkBandSmall: [0.6, 1.2], textInkMedianToleranceSmall: 0.25 };
    const px = (n: number): CaptureContext => ({ fontPx: { t0: n, t1: n, t2: n, t3: n }, backgrounds: new Set(), painters: new Set() });
    expect(compareCapture(design, unity, [], t, px(8)).issues.filter((i) => i.kind === "inkCoverage")).toEqual([]);
    const big = compareCapture(design, unity, [], t, px(14));
    expect(big.issues.filter((i) => i.kind === "inkCoverage").map((i) => i.id)).toEqual(["t3"]);
    expect(big.issues.find((i) => i.kind === "inkCoverage")!.detail).toMatch(/\(limit ±15 %\)/);
    // a line that stands out by more than the small-text tolerance still fails
    expect(compareCapture(design, mk([20, 20, 20, 26]), [], t, px(8)).issues.filter((i) => i.kind === "inkCoverage").map((i) => i.id)).toEqual(["t3"]);
  });

  it("compares a line's ink with the capture's median ratio when there are 3 or more lines", () => {
    const mk = (thick: number[]) => {
      const png = canvas(320, 192, [16, 24, 32]);
      const elements: Record<string, Box> = { root: el(0, 0, 320, 192) };
      thick.forEach((t, k) => {
        const y = 20 + k * 40;
        for (let x = 40; x < 200; x += 12) fill(png, { x, y: y + 2, w: t, h: 12 }, [250, 250, 250]);
        elements[`t${k}`] = el(36, y - 2, 200, 20, { text: true, lines: [{ x: 38, y, w: 164, h: 16, baseline: y + 12 }] });
      });
      return { png, boxes: { capture: "c", viewport: [320, 192] as [number, number], scale: 1, external: [], elements } };
    };
    // a renderer drawing every line at 4/5 of the ink passes; one line at the design's own weight among them stands out
    expect(compareCapture(mk([5, 5, 5, 5]), mk([4, 4, 4, 4]), [], T).pass).toBe(true);
    const v = compareCapture(mk([5, 5, 5, 5]), mk([4, 4, 5, 4]), [], T);
    expect(v.issues.map((i) => `${i.id}:${i.kind}`)).toEqual(["t2:inkCoverage"]);
    expect(v.issues[0].detail).toMatch(/1\.00× the design's, \+25 % against the median 0\.80× of this capture's light text \(limit ±20 %\)/);
  });

  it("flags an element only Unity shows and does not mask its text", () => {
    const g = scene(), u = scene();
    u.boxes.elements.stray = el(200, 140, 80, 24, { text: true, lines: [{ x: 204, y: 144, w: 60, h: 16, baseline: 156 }] });
    glyphs(u.png, { x: 204, y: 146, w: 60, h: 12 }, [250, 250, 250]);
    const v = compareCapture(g, u, [], T);
    expect(v.issues.filter((i) => i.id === "stray").map((i) => i.kind)).toEqual(["extra"]);
    expect(v.elements.find((r) => r.id === "stray")!.status).toBe("extra");
    expect(v.masked.some((r) => r.x >= 190 && r.y >= 130)).toBe(false);
    expect(v.pixelsOff).toBeGreaterThan(0);
  });

  it("lets a contrasting element move by 1 px (the box allowance) but not by 2 px", () => {
    const mk = (dx: number, dy: number, dh = 0) => {
      const png = canvas(320, 192, [16, 24, 32]);
      fill(png, { x: 100 + dx, y: 60 + dy, w: 96, h: 48 + dh }, [230, 230, 230]);
      return { png, boxes: { capture: "c", viewport: [320, 192] as [number, number], scale: 1, external: [], elements: { root: el(0, 0, 320, 192), tile: el(100 + dx, 60 + dy, 96, 48 + dh) } } };
    };
    const one = compareCapture(mk(0, 0), mk(1, 1), [], T, { backgrounds: new Set() });
    expect(one.pass).toBe(true);
    const row = one.elements.find((r) => r.id === "tile")!;
    expect(row.ssim!).toBeLessThan(0.99);
    expect(row.ssimShifted!).toBeGreaterThan(0.99);
    expect(compareCapture(mk(0, 0), mk(0, 0, 1), [], T, { backgrounds: new Set() }).pass).toBe(true);
    const two = compareCapture(mk(0, 0), mk(2, 0), [], T, { backgrounds: new Set() });
    expect(two.issues.map((i) => i.kind).sort()).toEqual(["box", "ssim"]);
  });

  it("refuses a compiler-removed element that carries text or paints", () => {
    const g = scene(), u = scene();
    delete u.boxes.elements.label;
    expect(compareCapture(g, u, ["label"], T).issues.find((i) => i.id === "label")!.detail).toMatch(/listed as removed by the compiler, but it carries text/);
  });

  it("lets a small element meet its area's measured SSIM limit only when its box and colours match", () => {
    const mk = (edge: Rgb, inner: Rgb) => {
      const png = canvas(320, 192, [30, 30, 30]);
      fill(png, { x: 96, y: 96, w: 32, h: 32 }, edge);
      fill(png, { x: 97, y: 97, w: 30, h: 30 }, inner);
      return { png, boxes: { capture: "c", viewport: [320, 192] as [number, number], scale: 1, external: [], elements: { root: el(0, 0, 320, 192), chip: el(96, 96, 32, 32) } } };
    };
    // the design's chip has a lighter anti-aliased rim than Unity's: same box, same inside colour
    const g = mk([170, 170, 170], [200, 200, 200]), u = mk([160, 160, 160], [200, 200, 200]);
    const strict = compareCapture(g, u, [], T);
    const ssim = strict.elements.find((e) => e.id === "chip")!;
    const best = Math.max(ssim.ssim!, ssim.ssimShifted!);
    expect(best).toBeGreaterThan(0.97);
    expect(best).toBeLessThan(0.99);
    expect(strict.issues).toEqual([expect.objectContaining({ id: "chip", kind: "ssim" })]);

    const small: Thresholds = { ...T, ssimElementSmall: [[2048, Math.floor(best * 1000) / 1000]] };
    const relaxed = compareCapture(g, u, [], small);
    expect(relaxed.issues).toEqual([]);
    expect(relaxed.elements.find((e) => e.id === "chip")!.ssimLimit).toBe(small.ssimElementSmall[0][1]);
    // a larger element keeps ssimElement
    expect(compareCapture(g, u, [], { ...T, ssimElementSmall: [[1024, 0.97]] }).issues).toEqual([expect.objectContaining({ id: "chip", kind: "ssim" })]);

    // a wrong colour inside fails the colour check, and then the small-element limit does not apply either
    const wrong = mk([160, 160, 160], [200, 140, 140]);
    const v = compareCapture(g, wrong, [], small);
    expect(v.issues.map((i) => i.kind).sort()).toEqual(["color", "ssim"]);
    expect(v.issues.find((i) => i.kind === "ssim")!.detail).toMatch(/needs its other checks to pass/);
  });

  it("lets a scaled raster picture meet ssimPicture only when its colours match", () => {
    const mk = (stripe: Rgb) => {
      const png = canvas(320, 192, [30, 30, 30]);
      fill(png, { x: 64, y: 32, w: 128, h: 128 }, [40, 160, 200]);
      fill(png, { x: 127, y: 32, w: 2, h: 128 }, stripe);
      return { png, boxes: { capture: "c", viewport: [320, 192] as [number, number], scale: 1, external: [], elements: { root: el(0, 0, 320, 192), pic: el(64, 32, 128, 128) } } };
    };
    // a resampled edge inside the picture: the design blends it in sRGB, Unity in linear light
    const g = mk([23, 92, 115]), u = mk([28, 120, 150]);
    const strict = compareCapture(g, u, [], T);
    const row = strict.elements.find((e) => e.id === "pic")!;
    const best = Math.max(row.ssim!, row.ssimShifted ?? -1);
    expect(best).toBeLessThan(0.99);
    expect(best).toBeGreaterThan(0.97);
    const t: Thresholds = { ...T, ssimPicture: 0.97 };
    expect(compareCapture(g, u, [], t, { pictures: new Set(["pic"]) }).issues).toEqual([]);
    expect(compareCapture(g, u, [], t).issues).toEqual([expect.objectContaining({ id: "pic", kind: "ssim" })]);
  });

  it("lets an element an animation sample shows rotated off the axes meet ssimRotated only when its other checks pass", () => {
    const mk = (rim: Rgb, inner: Rgb) => {
      const png = canvas(320, 192, [30, 30, 30]);
      fill(png, { x: 64, y: 32, w: 128, h: 128 }, rim);
      fill(png, { x: 66, y: 34, w: 124, h: 124 }, inner);
      return { png, boxes: { capture: "c", viewport: [320, 192] as [number, number], scale: 1, external: [], elements: { root: el(0, 0, 320, 192), dot: el(64, 32, 128, 128) } } };
    };
    // the design's rim is softer (Chromium resamples a layer under a running transform animation)
    const g = mk([70, 110, 120], [22, 194, 213]), u = mk([50, 90, 100], [22, 194, 213]);
    const row = compareCapture(g, u, [], T).elements.find((e) => e.id === "dot")!;
    const best = Math.max(row.ssim!, row.ssimShifted ?? -1);
    expect(best).toBeLessThan(0.99);
    expect(best).toBeGreaterThan(0.97);
    const t: Thresholds = { ...T, ssimRotated: 0.97 };
    const relaxed = compareCapture(g, u, [], t, { rotated: new Set(["dot"]) });
    expect(relaxed.issues).toEqual([]);
    expect(relaxed.elements.find((e) => e.id === "dot")!.ssimLimit).toBe(0.97);
    expect(compareCapture(g, u, [], t).issues).toEqual([expect.objectContaining({ id: "dot", kind: "ssim" })]);
    // a wrong colour fails, and then the rotated limit does not apply
    const wrong = compareCapture(g, mk([40, 60, 70], [200, 60, 60]), [], t, { rotated: new Set(["dot"]) });
    expect(wrong.issues.filter((i) => i.id === "dot").map((i) => i.kind).sort()).toEqual(["color", "ssim"]);
  });

  it("does not sample a painted line under half a device pixel on both sides: it paints nothing (a closed drawer)", () => {
    // 0 px wide at a fractional x (1366×768): its one centre-line pixel lies in the off-grid band
    const mk = () => ({ png: canvas(320, 192, [30, 30, 30]), boxes: { capture: "c", viewport: [320, 192] as [number, number], scale: 1, external: [],
      elements: { root: el(0, 0, 320, 192), drawer: el(173.62, 40, 0, 100) } } });
    const ctx: CaptureContext = { order: ["root", "drawer"], backgrounds: new Set(["root", "drawer"]), painters: new Set(["root", "drawer"]) };
    const v = compareCapture(mk(), mk(), [], T, ctx);
    expect(v.issues).toEqual([]);
    // a line the design paints and Unity loses is still a box issue
    const g = mk(); g.boxes.elements.drawer = el(173.62, 40, 2, 100); fill(g.png, { x: 174, y: 40, w: 2, h: 100 }, [200, 200, 200]);
    expect(compareCapture(g, mk(), [], T, ctx).issues.map((i) => i.kind)).toContain("box");
  });

  it("lets an element at a scaled viewport meet ssimRoundEdge only when its difference lies in the edge band of its round shapes", () => {
    // a 40 px circle drawn with an anti-aliasing ramp of `ramp` px (the scaled class draws its layout scale's ramp)
    const disc = (png: Rgba, cx: number, cy: number, r: number, ramp: number, c: Rgb, bg: Rgb) => {
      for (let y = Math.floor(cy - r - 2); y <= cy + r + 2; y++) for (let x = Math.floor(cx - r - 2); x <= cx + r + 2; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const a = Math.max(0, Math.min(1, (r + ramp / 2 - d) / ramp));
        const o = (y * png.w + x) * 4;
        for (let k = 0; k < 3; k++) png.data[o + k] = Math.round(c[k] * a + bg[k] * (1 - a));
      }
      return png;
    };
    const bg: Rgb = [30, 30, 30], knob: Rgb = [240, 240, 240];
    const mk = (ramp: number, dent = false) => {
      const png = disc(canvas(320, 192, bg), 120, 96, 20, ramp, knob, bg);
      if (dent) fill(png, { x: 116, y: 92, w: 8, h: 8 }, [120, 120, 120]); // a defect inside the shape, away from its edge
      return { png, boxes: { capture: "c", viewport: [320, 192] as [number, number], scale: 1, external: [], elements: { root: el(0, 0, 320, 192), knob: el(100, 76, 40, 40) } } };
    };
    const ctx = { radii: { knob: [20, 20, 20, 20] as [number, number, number, number] } };
    const g = mk(0.8), u = mk(1.8);
    const row = compareCapture(g, u, [], T, ctx).elements.find((e) => e.id === "knob")!;
    const best = Math.max(row.ssim!, row.ssimShifted ?? -1);
    expect(best).toBeLessThan(0.99);
    expect(row.ssimRoundEdgeMasked).toBeUndefined(); // off where ssimRoundEdge is ssimElement (exact viewports)
    const scaled: Thresholds = { ...T, ssimRoundEdge: 0.95 };
    const v = compareCapture(g, u, [], scaled, ctx);
    expect(v.issues).toEqual([]);
    const r = v.elements.find((e) => e.id === "knob")!;
    expect(r.ssimRoundEdgeMasked).toBeGreaterThanOrEqual(0.99);
    expect(r.ssimLimit).toBe(0.95);
    // a difference away from the edge band is not the ramp: masked, it still fails, and so does the element
    const dented = compareCapture(g, mk(1.8, true), [], scaled, ctx);
    const issue = dented.issues.find((i) => i.id === "knob" && i.kind === "ssim")!;
    expect(issue.detail).toMatch(/with the edge band of round shapes masked \(below 0.99: not confined to that band\)/);
    // without radii the band is empty: the limit never applies
    expect(compareCapture(g, u, [], scaled).issues).toEqual([expect.objectContaining({ id: "knob", kind: "ssim" })]);

    // at an exact viewport (ruling R119) only a round element without text and a moved edge get the band: the same knob
    // passes there, the same knob carrying a text line does not (it does at a scaled viewport)
    expect(compareCapture(g, u, [], scaled, { ...ctx, viewportClass: "exact" }).issues).toEqual([]);
    const withText = (s: ReturnType<typeof mk>) => ({ ...s, boxes: { ...s.boxes, elements: { ...s.boxes.elements, knob: el(100, 76, 40, 40, { text: true, lines: [{ x: 300, y: 4, w: 8, h: 8, baseline: 10 }] }) } } });
    expect(compareCapture(withText(g), withText(u), [], scaled, { ...ctx, viewportClass: "exact" }).issues).toEqual([expect.objectContaining({ id: "knob", kind: "ssim" })]);
    expect(compareCapture(withText(g), withText(u), [], scaled, { ...ctx, viewportClass: "scaled" }).issues.filter((i) => i.kind === "ssim")).toEqual([]);
  });

  it("the repository's thresholds: ssimRoundEdge at every viewport, the scaled class's own measured keys only in its block", () => {
    const t = readThresholds();
    expect(t.ssimRoundEdge).toBe(0.974); // R119: the measured floor at every viewport
    expect(t.deltaE2000RoundEdge).toBe(t.deltaE2000);
    for (const k of ["ssimFractionalEdge", "ssimVectorEdge"] as const) expect(t[k], k).toBe(t.ssimElement);
    expect(t.deltaE2000FractionalEdge).toBe(t.deltaE2000);
    expect(Object.keys(t.scaled ?? {}).sort()).toEqual(["deltaE2000FractionalEdge", "deltaE2000ResampledPicture", "deltaE2000RoundEdge", "ssimFractionalEdge", "ssimResampledPicture", "ssimRoundEdge",
      "ssimVectorEdge", "textInkDeltaEFirstSmall", "textInkSmallPx"]);
    expect(t.ssimResampledPicture).toBe(t.ssimElement);
    expect(t.deltaE2000ResampledPicture).toBe(t.deltaE2000);
  });

  it("catches a missing or wrong-colour ring on a round element without text, also one of another hue at the same lightness", () => {
    // an 80 px avatar at a scaled viewport: a light disc with a 2 px grey ring, drawn with the same ramp on both sides; the
    // ring lies wholly in the edge band (the outer curve and the border's inner curve, a pixel either side)
    const bg: Rgb = [30, 30, 30], disc: Rgb = [200, 200, 200];
    const draw = (ring: Rgb | null, width = 2) => {
      const png = canvas(320, 192, bg);
      for (let y = 50; y < 142; y++) for (let x = 74; x < 166; x++) {
        const d = Math.hypot(x + 0.5 - 120, y + 0.5 - 96);
        const a = Math.max(0, Math.min(1, 40.5 - d)), c = ring && d > 40 - width ? ring : disc;
        const o = (y * png.w + x) * 4;
        for (let k = 0; k < 3; k++) png.data[o + k] = Math.round(c[k] * a + bg[k] * (1 - a));
      }
      return png;
    };
    const boxes: CaptureBoxes = { capture: "c", viewport: [320, 192], scale: 0.5335, external: [], elements: { root: el(0, 0, 320, 192), avatar: el(80, 56, 80, 80) } };
    const ctx: CaptureContext = { borders: { avatar: [2, 2, 2, 2] }, radii: { avatar: [40, 40, 40, 40] }, backgrounds: new Set(["avatar"]), painters: new Set(["avatar"]), order: ["root", "avatar"], root: "root", viewportClass: "scaled" };
    const scaled: Thresholds = { ...T, ssimRoundEdge: 0.95, deltaE2000RoundEdge: 5.5 };
    const golden = { png: draw([150, 150, 150]), boxes };
    expect(compareCapture(golden, { png: draw([150, 150, 150]), boxes }, [], scaled, ctx).issues).toEqual([]);
    // the ring missing: its colour check (deltaE2000Ring, every viewport) and its width check (ruling R127) fail, and the
    // element's SSIM, which masked would meet ssimRoundEdge, is held to ssimElement (its other checks fail)
    expect(compareCapture(golden, { png: draw(null), boxes }, [], scaled, ctx).issues).toEqual([
      expect.objectContaining({ id: "avatar", kind: "color", detail: expect.stringMatching(/^ring \w+ border: ΔE2000 [\d.]+, .*\(limit 1\.5\): the ring's colour differs/) }),
      expect.objectContaining({ id: "avatar", kind: "edge", detail: expect.stringMatching(/^ring \w+ border: drawn 0\.\d+ device px wide, the design's 2\.00 \(limit ±0\.5\): the ring's width differs/) }),
      expect.objectContaining({ id: "avatar", kind: "ssim", detail: expect.stringMatching(/needs its other checks to pass/) })]);
    // another colour: the colour check fails; with no ring colour limit of its own the relaxation's evidence (ruling R130,
    // the file's deltaE2000Ring) still holds the element: the ring in the band is not the design's
    const blue = compareCapture(golden, { png: draw([96, 120, 168]), boxes }, [], scaled, ctx);
    expect(blue.issues.map((i) => i.kind)).toEqual(["color", "ssim"]);
    expect(blue.issues[1].detail).toMatch(/needs its other checks to pass/);
    // a ring of another hue at the same lightness keeps the element's SSIM at 0.99 or more; its colour check fails, at
    // an exact viewport too
    const hue = compareCapture(golden, { png: draw([128, 154, 168]), boxes }, [], T, ctx);
    expect(hue.elements.find((e) => e.id === "avatar")!.ssim).toBeGreaterThanOrEqual(0.99);
    expect(hue.issues).toEqual([expect.objectContaining({ id: "avatar", kind: "color", detail: expect.stringMatching(/^ring \w+ border: .*the ring's colour differs/) })]);
    expect(compareCapture(golden, { png: draw([150, 150, 150]), boxes }, [], T, ctx).elements.find((e) => e.id === "avatar")!.ring).toBe(0);
    // an animation sample that moves it is not judged for it (Chromium resamples the moving layer); the value is still
    // recorded. One whose animation does not move it (a colour, an opacity) is judged as a static capture (ruling R132)
    const moving = compareCapture(golden, { png: draw([128, 154, 168]), boxes }, [], T, { ...ctx, anim: true, moving: new Set(["avatar"]) });
    expect(moving.issues).toEqual([]);
    expect(moving.elements.find((e) => e.id === "avatar")!.ring).toBeGreaterThan(1.5);
    expect(compareCapture(golden, { png: draw([128, 154, 168]), boxes }, [], T, { ...ctx, anim: true, moving: new Set() }).issues).toEqual([
      expect.objectContaining({ id: "avatar", kind: "color", detail: expect.stringMatching(/^ring \w+ border: .*the ring's colour differs/) })]);
    // a ring under 2 device px (1.25 here: 2 px at 1600×900) has no sample to give evidence: a missing one is held to ssimElement
    const thin: CaptureContext = { ...ctx, borders: { avatar: [1.25, 1.25, 1.25, 1.25] } };
    const thinGolden = { png: draw([150, 150, 150], 1.25), boxes };
    expect(compareCapture(thinGolden, { png: draw([150, 150, 150], 1.25), boxes }, [], scaled, thin).issues).toEqual([]);
    expect(compareCapture(thinGolden, { png: draw(null), boxes }, [], scaled, thin).issues).toEqual([
      expect.objectContaining({ id: "avatar", kind: "ssim", detail: expect.stringMatching(/but the border of avatar \(a side under 2 device px, or no usable point on it\) gives no evidence of its colour/) })]);
    // at an exact viewport (ssimRoundEdge off) nothing is relaxed: a missing ring fails its colour and width checks and SSIM
    expect(compareCapture(golden, { png: draw(null), boxes }, [], T, ctx).issues.map((i) => i.kind)).toEqual(["color", "edge", "ssim"]);
  });

  describe("ssimRoundEdge at every viewport (ruling R119): crops of the suite's 1280×720 captures", () => {
    // the design's and Unity's pixels around two elements of the fidelity suite at 1280×720 (scale 0.5), with their boxes
    const crop = (name: string, side: "design" | "unity") => decodePng(fs.readFileSync(path.join(here, "fixtures", "compare", `r119-${name}.${side}.png`)));
    const at = (x: number, y: number, w: number, h: number, ox: number, oy: number) => el(x - ox, y - oy, w, h);
    // the limits of fidelity-thresholds.json at an exact viewport: a small element's 0.984, ssimRoundEdge the measured floor
    const exact: Thresholds = { ...T, ssimElementSmall: [[32768, 0.984]], ssimRoundEdge: 0.974, deltaE2000Ring: 3.1 };
    const off: Thresholds = { ...exact, ssimRoundEdge: 0.99 };
    const issuesOf = (v: CaptureVerdict, id: string) => v.issues.filter((i) => i.id === id);

    // controls radio-b: an unchecked 20 device px radio, a 2 device px ring (#2b6573) on #123c47, at (416, 168)
    // (crops start on the 8 px block grid of the whole capture, so each block's SSIM is the capture's)
    const radioBoxes = (): CaptureBoxes => ({ capture: "c", viewport: [48, 48], scale: 0.5, external: [], elements: { root: at(400, 152, 48, 48, 400, 152), radio: at(416, 168, 20, 20, 400, 152) } });
    const radioCtx: CaptureContext = { borders: { radio: [2, 2, 2, 2] }, radii: { radio: [10, 10, 10, 10] }, backgrounds: new Set(["radio"]), painters: new Set(["radio"]), order: ["root", "radio"], root: "root", viewportClass: "exact" };
    /** Unity's radio with its ring's inner edge a device pixel further out: the ring 1 device px thinner. */
    const thinner = (img: Rgba): Rgba => {
      const out = { ...img, data: img.data.slice() }, fillC = [0x12, 0x3c, 0x47];
      for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
        const d = Math.hypot(x + 0.5 - 26, y + 0.5 - 26), a = Math.max(0, Math.min(1, 9 - d)); // the fill now reaches radius 9
        const o = (y * img.w + x) * 4;
        if (d < 10) for (let k = 0; k < 3; k++) out.data[o + k] = Math.round(fillC[k] * a + img.data[o + k] * (1 - a));
      }
      return out;
    };

    it("passes the radio's ring anti-aliasing (SSIM 0.98088 against 0.984): its difference lies in the edge band, its ring colour matches", () => {
      const design = { png: crop("radio-1280", "design"), boxes: radioBoxes() }, unity = { png: crop("radio-1280", "unity"), boxes: radioBoxes() };
      const held = compareCapture(design, unity, [], off, radioCtx);
      expect(issuesOf(held, "radio")).toEqual([expect.objectContaining({ kind: "ssim" })]);
      const v = compareCapture(design, unity, [], exact, radioCtx);
      expect(issuesOf(v, "radio")).toEqual([]);
      const row = v.elements.find((e) => e.id === "radio")!;
      expect(Math.max(row.ssim!, row.ssimShifted!)).toBeCloseTo(0.98088, 4);
      expect(row.ssimRoundEdgeMasked).toBeGreaterThanOrEqual(0.99);
      expect(row.ssimLimit).toBe(0.974);
      expect(row.ring).toBeLessThan(3.1);
    });

    it("still fails a ring 1 device px thinner: below the floor unmasked (the band holds the whole 2 px ring)", () => {
      const design = { png: crop("radio-1280", "design"), boxes: radioBoxes() }, unity = { png: thinner(crop("radio-1280", "unity")), boxes: radioBoxes() };
      const v = compareCapture(design, unity, [], exact, radioCtx);
      expect(issuesOf(v, "radio")).toEqual([expect.objectContaining({ kind: "ssim", detail: expect.stringMatching(/0\.95207 with offsets up to 1 px\) .* below 0\.974 unmasked/) })]);
    });

    // transitions active-ease, sample 6: a 100×48 device px cell (2 px border, radius 8) 0.774 device px down a running
    // translate, at (308, 153.774); Chromium draws it from its resampled layer, UI Toolkit on whole pixels
    const cellBoxes = (dy = 0): CaptureBoxes => ({ capture: "c", viewport: [120, 64], scale: 0.5, external: [], elements: { root: at(296, 144, 120, 64, 296, 144), cell: at(308, 153.774475 + dy, 100, 48, 296, 144) } });
    const cellCtx: CaptureContext = { borders: { cell: [2, 2, 2, 2] }, radii: { cell: [8, 8, 8, 8] }, backgrounds: new Set(["cell"]), painters: new Set(["cell"]), order: ["root", "cell"], root: "root",
      anim: true, moving: new Set(["cell"]), viewportClass: "exact" };
    /** Unity's pixels one device pixel lower (its box says so too). */
    const lower = (img: Rgba): Rgba => {
      const out = { ...img, data: img.data.slice() };
      for (let y = img.h - 1; y >= 1; y--) out.data.copyWithin(y * img.w * 4, (y - 1) * img.w * 4, y * img.w * 4);
      return out;
    };

    it("passes a sample whose element sits at a fractional device offset (SSIM 0.98296 against 0.984): the difference is in its moved edges' band", () => {
      const design = { png: crop("transition-1280", "design"), boxes: cellBoxes() }, unity = { png: crop("transition-1280", "unity"), boxes: cellBoxes() };
      expect(issuesOf(compareCapture(design, unity, [], off, cellCtx), "cell")).toEqual([expect.objectContaining({ kind: "ssim" })]);
      const v = compareCapture(design, unity, [], exact, cellCtx);
      expect(issuesOf(v, "cell")).toEqual([]);
      const row = v.elements.find((e) => e.id === "cell")!;
      expect(Math.max(row.ssim!, row.ssimShifted!)).toBeCloseTo(0.98296, 4);
      expect(row.ssimRoundEdgeMasked).toBeGreaterThanOrEqual(0.99);
      // a static capture, or an element the sample does not move, gets no band for its straight edges (and, as in a static
      // capture, its ring's colour is judged: this crop's moving layer blends the border's centre, ruling R132)
      expect(issuesOf(compareCapture(design, unity, [], exact, { ...cellCtx, moving: new Set() }), "cell").map((i) => i.kind)).toEqual(["color", "ssim"]);
      expect(issuesOf(compareCapture(design, unity, [], exact, { ...cellCtx, anim: false, moving: new Set() }), "cell").map((i) => i.kind)).toEqual(["color", "ssim"]);
    });

    it("still fails the moving border a device pixel off (its box within the limit): the band is the design's and Unity's edge both", () => {
      const design = { png: crop("transition-1280", "design"), boxes: cellBoxes() }, unity = { png: lower(crop("transition-1280", "unity")), boxes: cellBoxes(1) };
      const v = compareCapture(design, unity, [], exact, cellCtx);
      const ssim = issuesOf(v, "cell").find((i) => i.kind === "ssim");
      expect(ssim?.detail).toMatch(/with the edge band of round shapes and moved edges masked \(below 0\.99: not confined to that band\)/);
    });
  });

  describe("the scaled class's measured keys for straight edges, vectors and corners (ruling R121): crops of the suite's captures", () => {
    const crop = (name: string, side: "design" | "unity") => decodePng(fs.readFileSync(path.join(here, "fixtures", "compare", `r121-${name}.${side}.png`)));
    const boxesOf = (w: number, h: number, ox: number, oy: number, scale: number, id: string, b: Box): CaptureBoxes =>
      ({ capture: "c", viewport: [w, h], scale, external: [], elements: { root: el(0, 0, w, h), [id]: { ...b, x: b.x - ox, y: b.y - oy, lines: b.lines.map((l) => ({ ...l, x: l.x - ox, y: l.y - oy })) } } });
    const scaled: Thresholds = { ...T, ssimElementSmall: [[32768, 0.984]], ssimRoundEdge: 0.974, deltaE2000RoundEdge: 5.5, deltaE2000Ring: 3.1 };
    const issuesOf = (v: CaptureVerdict, id: string) => v.issues.filter((i) => i.id === id);
    /** `img` with a square of colour `c` at (x, y). */
    const dent = (img: Rgba, x: number, y: number, n: number, c: Rgb) => fill({ ...img, data: img.data.slice() }, { x, y, w: n, h: n }, c);

    // colors-gradients root__1__11 at 1366×768: a 102×68 device px box with a 4.27 device px border of four colours, its
    // edges between device pixels; UI Toolkit draws them a fraction of a pixel away with its own ramp
    const border = (side: "design" | "unity") => ({ png: crop("border-1366", side), boxes: boxesOf(112, 80, 1232, 48, 0.533464, "box",
      side === "design" ? el(1237.635417, 55.480208, 102.425, 68.283333) : el(1237.635353, 55.480206, 102.425006, 68.283332)) });
    const borderCtx: CaptureContext = { borders: { box: [4.267708, 4.267708, 4.267708, 4.267708] }, backgrounds: new Set(["box"]), painters: new Set(["box"]),
      order: ["root", "box"], root: "root", viewportClass: "scaled" };

    it("ssimFractionalEdge: a box whose difference lies on its straight edges between device pixels (SSIM 0.9735)", () => {
      expect(issuesOf(compareCapture(border("design"), border("unity"), [], scaled, borderCtx), "box")).toEqual([expect.objectContaining({ kind: "ssim" })]);
      const v = compareCapture(border("design"), border("unity"), [], { ...scaled, ssimFractionalEdge: 0.97 }, borderCtx);
      expect(issuesOf(v, "box")).toEqual([]);
      const row = v.elements.find((e) => e.id === "box")!;
      expect(Math.max(row.ssim!, row.ssimShifted!)).toBeCloseTo(0.9735, 4);
      expect(row.ssimFractionalEdgeMasked).toBeGreaterThanOrEqual(0.99);
      // a difference inside the box is not on its edges; and at an exact viewport the key does not apply
      const dented = { ...border("unity"), png: dent(crop("border-1366", "unity"), 40, 30, 6, [200, 60, 60]) };
      expect(issuesOf(compareCapture(border("design"), dented, [], { ...scaled, ssimFractionalEdge: 0.97 }, borderCtx), "box")[0].detail)
        .toMatch(/with the straight edges between device pixels masked as well \(below 0\.99: not confined to them\)/);
      expect(issuesOf(compareCapture(border("design"), border("unity"), [], { ...scaled, ssimFractionalEdge: 0.97 }, { ...borderCtx, viewportClass: "exact" }), "box")).toHaveLength(1);
    });

    // icons root__2__1__0 at 1600×900: a 30 device px vector star, 0.16 device px left of the design's
    const star = (side: "design" | "unity", png = crop("star-1600", side)) => ({ png, boxes: boxesOf(48, 40, 240, 200, 0.625, "star",
      side === "design" ? el(248.496094, 202.5, 30, 30) : el(248.3333, 202.499962, 30, 30)) });
    const starCtx: CaptureContext = { painters: new Set(["star"]), backgrounds: new Set(), vectors: new Set(["star"]), order: ["root", "star"], root: "root", viewportClass: "scaled" };

    it("ssimVectorEdge: a vector picture whose difference lies in the band of its drawn edges (SSIM 0.98096 against 0.984)", () => {
      expect(issuesOf(compareCapture(star("design"), star("unity"), [], scaled, starCtx), "star")).toEqual([expect.objectContaining({ kind: "ssim" })]);
      const v = compareCapture(star("design"), star("unity"), [], { ...scaled, ssimVectorEdge: 0.975 }, starCtx);
      expect(issuesOf(v, "star")).toEqual([]);
      expect(v.elements.find((e) => e.id === "star")!.ssimVectorEdgeMasked).toBeGreaterThanOrEqual(0.99);
      // another shape: the star's inside dented, or an element that is no vector
      const dented = star("unity", dent(crop("star-1600", "unity"), 19, 11, 8, [20, 60, 70])); // a hole in its middle
      expect(issuesOf(compareCapture(star("design"), dented, [], { ...scaled, ssimVectorEdge: 0.975 }, starCtx), "star")[0].detail).toMatch(/with the vector's edge band masked \(below 0\.99: not confined to it\)/);
      expect(issuesOf(compareCapture(star("design"), star("unity"), [], { ...scaled, ssimVectorEdge: 0.975 }, { ...starCtx, vectors: new Set() }), "star")).toHaveLength(1);
    });

    // repeat-items notes-toggle at 1366×768, focused: a text button with a 2.13 device px focus ring, 0.28 device px left of
    // the design's; its top-left corner sample (4 px in) reaches the ring's straight edges between device pixels
    const focus = (side: "design" | "unity", png = crop("focus-1366", side)) => ({ png, boxes: boxesOf(80, 48, 1272, 16, 0.533464, "toggle", side === "design"
      ? el(1282.729757, 25.60625, 57.33066, 34.141667, { text: true, lines: [{ x: 1295.532882, y: 36.275521, w: 31.674398, h: 12.803125, baseline: 46.411328 }] })
      : el(1282.446305, 25.606249, 57.614054, 34.141666, { text: true, lines: [{ x: 1295.249407, y: 36.275583, w: 31.669744, h: 12.802997, baseline: 46.411388 }] })) });
    const focusCtx: CaptureContext = { borders: { toggle: [2.133854, 2.133854, 2.133854, 2.133854] }, radii: { toggle: [4.267708, 4.267708, 4.267708, 4.267708] },
      backgrounds: new Set(["toggle"]), painters: new Set(["toggle"]), order: ["root", "toggle"], root: "root", viewportClass: "scaled", fontPx: { toggle: 10.669271 } };

    it("deltaE2000FractionalEdge: a corner sample whose window reaches the straight edges between device pixels (ΔE2000 4.90)", () => {
      const edgeIssue = (t: Thresholds, png?: Rgba) => issuesOf(compareCapture(focus("design"), focus("unity", png), [], t, focusCtx), "toggle").filter((i) => i.kind === "edge");
      expect(edgeIssue(scaled)).toEqual([expect.objectContaining({ detail: expect.stringMatching(/^top-left corner, 4 px in: ΔE2000 4\.90/) })]);
      expect(edgeIssue({ ...scaled, deltaE2000FractionalEdge: 5.3 })).toEqual([]);
      // a ring of another colour: its pixels outside the bands differ, the corner keeps deltaE2000
      const recolour = (img: Rgba) => {
        const out = { ...img, data: img.data.slice() };
        for (let p = 0; p < img.w * img.h; p++) if (img.data[p * 4 + 2] > 150 && img.data[p * 4] < 200) { out.data[p * 4] = 200; out.data[p * 4 + 1] = 120; }
        return out;
      };
      expect(edgeIssue({ ...scaled, deltaE2000FractionalEdge: 5.3 }, recolour(crop("focus-1366", "unity")))).toHaveLength(1);
    });
  });

  describe("edge-band evidence and the scaled class's residual keys (rulings R124 to R130)", () => {
    const repo = readThresholds();
    const exactT = thresholdsFor(repo, "exact"), scaledT = thresholdsFor(repo, "scaled");
    const issuesOf = (v: CaptureVerdict, id: string) => v.issues.filter((i) => i.id === id);
    /** A round element with a ring, anti-aliased by its covered area (8×8 samples a pixel): fill inside, ring, background. */
    const avatar = (size: number, x0: number, y0: number, outer: number, ring: number, ringC: Rgb, fillC: Rgb, bgC: Rgb, w: number, h: number) => {
      const png = canvas(w, h, bgC), r = outer / 2, cx = x0 + r, cy = y0 + r;
      for (let y = Math.floor(y0) - 1; y < Math.ceil(y0 + outer) + 1; y++) for (let x = Math.floor(x0) - 1; x < Math.ceil(x0 + outer) + 1; x++) {
        let inRing = 0, inFill = 0;
        for (let sy = 0; sy < 8; sy++) for (let sx = 0; sx < 8; sx++) {
          const d = Math.hypot(x + (sx + 0.5) / 8 - cx, y + (sy + 0.5) / 8 - cy);
          if (d < r - ring) inFill++; else if (d < r) inRing++;
        }
        const a = inFill / 64, b = inRing / 64, o = (y * w + x) * 4;
        for (let k = 0; k < 3; k++) png.data[o + k] = Math.round(fillC[k] * a + ringC[k] * b + bgC[k] * (1 - a - b));
      }
      void size;
      return png;
    };

    it("R129, R127, R135: an avatar whose ring Unity draws 3 CSS px wide instead of 4 fails wherever that is 0.75 device px or more", () => {
      // the re-review's probe (N4-1): a text-less avatar of 80 or 160 CSS px with a 4 CSS px ring at each exact scale, drawn
      // the same way on both sides but the ring's width; repository thresholds
      const ringC: Rgb = [22, 194, 213], fillC: Rgb = [60, 70, 80], bgC: Rgb = [11, 31, 38];
      const at: string[] = [];
      for (const css of [80, 160]) for (const scale of [0.5, 0.75, 1, 1.5]) {
        const outer = css * scale, W = Math.ceil(outer / 8) * 8 + 32, x0 = 16;
        const boxes: CaptureBoxes = { capture: "c", viewport: [W, W], scale, external: [], elements: { root: el(0, 0, W, W), avatar: el(x0, x0, outer, outer) } };
        const ctx: CaptureContext = { borders: { avatar: [4 * scale, 4 * scale, 4 * scale, 4 * scale] }, radii: { avatar: [outer / 2, outer / 2, outer / 2, outer / 2] },
          backgrounds: new Set(["avatar"]), painters: new Set(["avatar"]), order: ["root", "avatar"], root: "root", viewportClass: "exact" };
        const design = { png: avatar(css, x0, x0, outer, 4 * scale, ringC, fillC, bgC, W, W), boxes };
        const same = compareCapture(design, { png: avatar(css, x0, x0, outer, 4 * scale, ringC, fillC, bgC, W, W), boxes }, [], exactT, ctx);
        expect(issuesOf(same, "avatar"), `${css} px at ${scale}`).toEqual([]);
        const v = compareCapture(design, { png: avatar(css, x0, x0, outer, 3 * scale, ringC, fillC, bgC, W, W), boxes }, [], exactT, ctx);
        // the drawn width differs by a quarter of the design's ring (the largest over the sides' middles, exact to 0.01
        // there, and the diagonals, where the measure reads up to 0.16 device px more on a thinner ring)
        const width = v.elements.find((e) => e.id === "avatar")!.ringWidth!;
        expect(width, `${css} px at ${scale}`).toBeGreaterThan(scale - 0.02);
        expect(width, `${css} px at ${scale}`).toBeLessThan(scale + 0.2);
        // (the element's own verdict: on this small canvas the avatar is most of the capture, whose SSIM a screen dilutes)
        const own = issuesOf(v, "avatar");
        at.push(`${css}@${scale}:${own.length ? own.map((i) => i.kind).join("+") : "pass"}`);
      }
      // a ring 0.75 device px or more too thin fails its width (R127) and, with it, every relaxation (R129). At 1280×720 the
      // ring is 0.5 device px thinner: the width check decides reliably from 0.75 device px only (ruling R135: its limit
      // stays "more than 0.5"; a correct ring can read up to 0.506 and a 0.5 px thinner one 0.498 to 0.635 by its grid
      // position), so a ring 1 CSS px thinner at 1280×720 can pass. The 160 px avatar does here (0.498 at this position;
      // its SSIM passes too), a documented limit, not part of this red test; the 80 px one fails on SSIM below the floor
      expect(at).toEqual(["80@0.5:ssim", "80@0.75:edge+ssim", "80@1:edge+ssim", "80@1.5:edge+ssim",
        expect.stringMatching(/^160@0\.5:(pass|edge\+ssim|edge)$/), "160@0.75:edge+ssim", "160@1:edge+ssim", "160@1.5:edge+ssim"]);
    });

    it("R129: a relaxation needs every SSIM block and every 3×3 window outside its band to match, and its borders' widths", () => {
      // the 160 px avatar at 3840×2160 in an animation sample that moves it to a fractional offset (its own ring checks are
      // for static captures), with Unity's ring drawn by a coarser ramp (a few pixels along the curves differ, as between
      // the renderers): the band-masked mean (the earlier rule) meets 0.99 in each case below, the evidence does not
      const ringC: Rgb = [240, 240, 240], fillC: Rgb = [20, 24, 28], bgC: Rgb = [0, 0, 0], outer = 240, W = 272, x0 = 16.4;
      const boxes: CaptureBoxes = { capture: "c", viewport: [W, W], scale: 1.5, external: [], elements: { root: el(0, 0, W, W), avatar: el(x0, x0, outer, outer) } };
      const ctx: CaptureContext = { borders: { avatar: [6, 6, 6, 6] }, radii: { avatar: [120, 120, 120, 120] }, backgrounds: new Set(["avatar"]), painters: new Set(["avatar"]),
        order: ["root", "avatar"], root: "root", viewportClass: "exact", anim: true, moving: new Set(["avatar"]) };
      /** Unity's drawing: its curves 0.4 device px further in, their pixels rounded to whole coverage (a hard ramp). */
      const coarse = (ring: number) => {
        const img = avatar(160, x0 + 0.4, x0 + 0.4, outer - 0.8, ring, ringC, fillC, bgC, W, W), ref = avatar(160, x0 + 0.4, x0 + 0.4, outer - 0.8, ring, ringC, fillC, bgC, W, W);
        for (let p = 0; p < W * W; p++) {
          const o = p * 4, near = (c: Rgb) => Math.hypot(ref.data[o] - c[0], ref.data[o + 1] - c[1], ref.data[o + 2] - c[2]);
          const c = [bgC, ringC, fillC].reduce((a, k) => (near(k) < near(a) ? k : a));
          img.data.set(c, o);
        }
        return img;
      };
      const design = { png: avatar(160, x0, x0, outer, 6, ringC, fillC, bgC, W, W), boxes };
      const run = (png: Rgba) => { const v = compareCapture(design, { png, boxes }, [], exactT, ctx); return { v, row: v.elements.find((e) => e.id === "avatar")! }; };
      const ok = run(coarse(6));
      expect(Math.max(ok.row.ssim!, ok.row.ssimShifted!)).toBeLessThan(0.99);
      expect(issuesOf(ok.v, "avatar")).toEqual([]);
      expect(ok.row.ssimLimit).toBe(exactT.ssimRoundEdge);
      // a 3 px dent of another colour inside the fill, outside the band: one block and its windows show it
      const dented = coarse(6);
      fill(dented, { x: 110, y: 110, w: 3, h: 3 }, [200, 80, 40]); // between the colour grid's points
      const d = run(dented);
      expect(d.row.ssimRoundEdgeMasked).toBeGreaterThanOrEqual(0.99);
      expect(issuesOf(d.v, "avatar")).toEqual([expect.objectContaining({ kind: "ssim", detail: expect.stringMatching(/masked, but an SSIM block outside the band, the 8 px block at \(\d+, \d+\), is 0\.\d+ \(below 0\.99: not confined to it\)/) })]);
      // the ring 4.5 device px instead of 6: its inner edge half a pixel past the band; Unity's colour within 1 px matches
      // there (the box allowance), so the windows do not show it: its width does (R127)
      const thin = run(coarse(4.5));
      expect(thin.row.ssimRoundEdgeMasked).toBeGreaterThanOrEqual(0.99);
      expect(thin.row.bandEvidence!.maxDe).toBeLessThanOrEqual(1);
      expect(thin.row.bandEvidence!.width).toBeGreaterThan(1.4);
      expect(issuesOf(thin.v, "avatar")).toEqual([expect.objectContaining({ kind: "ssim",
        detail: expect.stringMatching(/masked, but avatar \w+ (border|corner) is drawn 4\.\d+ device px wide, the design's 6\.\d+ \(limit ±0\.5\): the border in that band is not the design's/) })]);
    });

    it("R130: a straight border of another colour in the band of straight edges gives no evidence (the re-review's N4-3 probe)", () => {
      // a text-less 113 × 57 CSS px box with a 4 CSS px border at 1366×768 (2.13 device px), its edges between device pixels:
      // Chromium covers the edge pixels partly, UI Toolkit draws them whole at the nearest pixel
      const s0 = 0.533464, fillC: Rgb = [18, 60, 71], line: Rgb = [200, 210, 220], bgC: Rgb = [11, 31, 38], bw = 4 * s0;
      const box = { x: 16 * s0, y: 29 * s0, w: 58 * s0, h: 77 * s0 };
      const draw = (whole: boolean, c: Rgb) => {
        const r = whole ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.x + box.w) - Math.round(box.x), h: Math.round(box.y + box.h) - Math.round(box.y) } : box;
        const b = whole ? 2 : bw;
        const png = canvas(128, 88, bgC);
        const put = whole ? (img: Rgba, q: R, col: Rgb) => fill(img, { x: Math.round(q.x), y: Math.round(q.y), w: Math.round(q.w), h: Math.round(q.h) }, col) : paint;
        put(png, r, c);
        put(png, { x: r.x + b, y: r.y + b, w: r.w - 2 * b, h: r.h - 2 * b }, fillC);
        return png;
      };
      const boxes = (whole: boolean): CaptureBoxes => ({ capture: "c", viewport: [128, 88], scale: 0.533464, external: [], elements: { root: el(0, 0, 128, 88),
        box: whole ? el(Math.round(box.x), Math.round(box.y), Math.round(box.x + box.w) - Math.round(box.x), Math.round(box.y + box.h) - Math.round(box.y)) : el(box.x, box.y, box.w, box.h) } });
      const ctx: CaptureContext = { borders: { box: [bw, bw, bw, bw] }, backgrounds: new Set(["box"]), painters: new Set(["box"]), order: ["root", "box"], root: "root", viewportClass: "scaled" };
      const golden = { png: draw(false, line), boxes: boxes(false) };
      const right = compareCapture(golden, { png: draw(true, line), boxes: boxes(true) }, [], scaledT, ctx);
      const row = right.elements.find((e) => e.id === "box")!;
      expect(Math.max(row.ssim!, row.ssimShifted!)).toBeLessThan(0.984);
      expect(issuesOf(right, "box")).toEqual([]);
      expect(row.ssimLimit).toBe(scaledT.ssimFractionalEdge);
      // the border ΔE2000 7 or more off: its SSIM with the band masked still meets 0.99; its centre's colour does not
      const wrong = compareCapture(golden, { png: draw(true, [216, 196, 168]), boxes: boxes(true) }, [], scaledT, ctx);
      expect(wrong.elements.find((e) => e.id === "box")!.ssimFractionalEdgeMasked).toBeGreaterThanOrEqual(0.99);
      // no 3×3 window outside the band reaches the border (R129 sees nothing there): its centre's colour holds it (R130)
      expect(issuesOf(wrong, "box")).toEqual([expect.objectContaining({ kind: "ssim",
        detail: expect.stringMatching(/masked as well, but the centre of box \w+ border differs by ΔE2000 [\d.]+ \(design #\w+, Unity #\w+; limit 3\.1\): the border in that band is not the design's/) })]);
      expect(wrong.elements.find((e) => e.id === "box")!.bandEvidence!.maxDe).toBeLessThanOrEqual(1);
      // R132 (the re-review's N5-2): in an animation sample whose animation does not move the box (a colour, an opacity)
      // it gets the static checks, its centre colour too; one that moves it keeps R130 to static captures (Chromium draws
      // it from its resampled layer, where a correct 2.13 device px border's centre blends)
      const sample = (moving: string[]) => compareCapture(golden, { png: draw(true, [216, 196, 168]), boxes: boxes(true) }, [], scaledT, { ...ctx, anim: true, moving: new Set(moving) });
      expect(issuesOf(sample([]), "box")).toEqual([expect.objectContaining({ kind: "ssim",
        detail: expect.stringMatching(/masked as well, but the centre of box \w+ border differs by ΔE2000 [\d.]+ \(design #\w+, Unity #\w+; limit 3\.1\)/) })]);
      expect(issuesOf(sample(["box"]), "box")).toEqual([]);
      expect(issuesOf(compareCapture(golden, { png: draw(true, line), boxes: boxes(true) }, [], scaledT, { ...ctx, anim: true, moving: new Set() }), "box")).toEqual([]);
    });

    it("R124: the edge bands of a repeat's later items come from their boxes; a later item's wrong divider is not the design's", () => {
      // a table at 1366×768: three rows of a repeat, each with a 2.13 device px bottom border between device pixels; the
      // captures hold the IR's first row, and the later ones in `items`
      const s0 = 0.533464, fillC: Rgb = [18, 60, 71], line: Rgb = [36, 90, 104], bgC: Rgb = [11, 31, 38], bw = 4 * s0;
      const rows = [0, 1, 2].map((k) => ({ x: 16 * s0, y: (16 + 30 * k) * s0, w: 210 * s0, h: 30 * s0 }));
      const draw = (whole: boolean, last: Rgb = line) => {
        const png = canvas(128, 80, bgC);
        rows.forEach((r, k) => {
          const q = whole ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.x + r.w) - Math.round(r.x), h: Math.round(r.y + r.h) - Math.round(r.y) } : r;
          const b = whole ? 2 : bw;
          (whole ? fill : paint)(png, q, fillC);
          const div = { x: q.x, y: q.y + q.h - b, w: q.w, h: b };
          (whole ? fill : paint)(png, whole ? { ...div, y: Math.round(div.y) } : div, k === 2 ? last : line);
        });
        return png;
      };
      const boxes = (whole: boolean, items: boolean): CaptureBoxes => {
        const at = (k: number) => whole ? { x: Math.round(rows[k].x), y: Math.round(rows[k].y), w: Math.round(rows[k].x + rows[k].w) - Math.round(rows[k].x), h: Math.round(rows[k].y + rows[k].h) - Math.round(rows[k].y) } : rows[k];
        const b: CaptureBoxes = { capture: "c", viewport: [128, 80], scale: s0, external: [], elements: { root: el(0, 0, 128, 80), table: el(16 * s0, 16 * s0, 210 * s0, 90 * s0),
          list: el(16 * s0, 16 * s0, 210 * s0, 90 * s0), row: el(at(0).x, at(0).y, at(0).w, at(0).h) } };
        if (items) b.items = { "row#1": { ...at(1), visible: true, text: false, lines: [] }, "row#2": { ...at(2), visible: true, text: false, lines: [] } };
        return b;
      };
      const ctx: CaptureContext = { borders: { row: [0, 0, bw, 0] }, backgrounds: new Set(["table", "row"]), painters: new Set(["table", "row"]), order: ["root", "table", "list", "row"],
        root: "root", parent: new Map([["table", "root"], ["list", "table"], ["row", "list"]]), repeats: new Set(["list"]), viewportClass: "scaled" };
      const run = (items: boolean, last?: Rgb) => compareCapture({ png: draw(false), boxes: boxes(false, items) }, { png: draw(true, last), boxes: boxes(true, items) }, [], scaledT, ctx);
      const without = run(false);
      expect(issuesOf(without, "table")).toEqual([expect.objectContaining({ kind: "ssim", detail: expect.stringMatching(/masked as well \(below 0\.99: not confined to them\)/) })]);
      const withItems = run(true);
      expect(issuesOf(withItems, "table")).toEqual([]);
      expect(withItems.elements.find((e) => e.id === "table")!.ssimLimit).toBe(scaledT.ssimFractionalEdge);
      // the last row's divider in another colour: its band hides it, its centre does not
      const wrong = run(true, [92, 64, 104]);
      expect(wrong.elements.find((e) => e.id === "table")!.ssimFractionalEdgeMasked).toBeGreaterThanOrEqual(0.99);
      expect(issuesOf(wrong, "table")).toEqual([expect.objectContaining({ kind: "ssim", detail: expect.stringMatching(/masked as well, but the centre of row#2 bottom border differs by ΔE2000/) })]);
    });

    it("R133: a repeat's later items' text is masked as the IR elements' and gets their text checks", () => {
      // the R124 table at 1366×768 with a text in each row (10.67 device px): the renderers' glyphs differ (the design's stems
      // anti-aliased at a fractional x, Unity's whole pixels 0.3 px left), as the suite's 12.8 px rows do; the first row's
      // text is the IR element `name`, the later rows' its copies `name#1`, `name#2`
      const s0 = 0.533464, fillC: Rgb = [18, 60, 71], line: Rgb = [36, 90, 104], bgC: Rgb = [11, 31, 38], ink: Rgb = [240, 240, 240], bw = 4 * s0;
      const rows = [0, 1, 2].map((k) => ({ x: 16 * s0, y: (16 + 30 * k) * s0, w: 210 * s0, h: 30 * s0 }));
      const whole = (r: R): R => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.x + r.w) - Math.round(r.x), h: Math.round(r.y + r.h) - Math.round(r.y) });
      const lineOf = (k: number, unity: boolean) => {
        const q = unity ? whole(rows[k]) : rows[k];
        return { x: Math.floor(q.x) + 4 + (unity ? 0 : 0.3), y: Math.floor(q.y) + 3, w: 38, h: 8, baseline: Math.floor(q.y) + 9 };
      };
      const draw = (unity: boolean, text: Rgb[] = [ink, ink, ink]) => {
        const png = canvas(128, 80, bgC);
        rows.forEach((r, k) => {
          const q = unity ? whole(r) : r;
          const b = unity ? 2 : bw;
          (unity ? fill : paint)(png, q, fillC);
          const div = { x: q.x, y: q.y + q.h - b, w: q.w, h: b };
          (unity ? fill : paint)(png, unity ? { ...div, y: Math.round(div.y) } : div, line);
          const l = lineOf(k, unity);
          for (let x = 0; x < 5; x++) (unity ? fill : paint)(png, { x: l.x + 8 * x, y: l.y, w: 2, h: l.h }, text[k]);
        });
        return png;
      };
      const boxes = (unity: boolean): CaptureBoxes => {
        const at = (k: number) => (unity ? whole(rows[k]) : rows[k]);
        const text = (k: number) => { const l = lineOf(k, unity); return { x: l.x, y: l.y - 1, w: 40, h: 10, visible: true, text: true, lines: [l] }; };
        return { capture: "c", viewport: [128, 80], scale: s0, external: [], elements: { root: el(0, 0, 128, 80), table: el(16 * s0, 16 * s0, 210 * s0, 90 * s0),
          list: el(16 * s0, 16 * s0, 210 * s0, 90 * s0), row: el(at(0).x, at(0).y, at(0).w, at(0).h), name: el(text(0).x, text(0).y, 40, 10, { text: true, lines: text(0).lines }) },
          items: { "row#1": { ...at(1), visible: true, text: false, lines: [] }, "row#2": { ...at(2), visible: true, text: false, lines: [] }, "name#1": text(1), "name#2": text(2) } };
      };
      const ctx: CaptureContext = { borders: { row: [0, 0, bw, 0] }, backgrounds: new Set(["table", "row"]), painters: new Set(["table", "row"]), order: ["root", "table", "list", "row", "name"],
        root: "root", parent: new Map([["table", "root"], ["list", "table"], ["row", "list"], ["name", "row"]]), repeats: new Set(["list"]), viewportClass: "scaled", fontPx: { name: 20 * s0 } };
      const run = (text?: Rgb[]) => compareCapture({ png: draw(false), boxes: boxes(false) }, { png: draw(true, text), boxes: boxes(true) }, [], scaledT, ctx);
      const v = run();
      // the dividers confined to the band of straight edges, the later rows' text masked from the table's evidence and
      // checked on its own: the copies have rows of their own with their lines and ink (on this small canvas the dividers
      // are most of the capture, whose SSIM a screen dilutes)
      const own = (x: CaptureVerdict) => x.issues.filter((i) => i.id !== WHOLE);
      expect(own(v)).toEqual([]);
      const table = v.elements.find((e) => e.id === "table")!;
      expect(Math.max(table.ssim!, table.ssimShifted ?? 0)).toBeLessThan(0.99);
      expect(table.ssimLimit).not.toBeNull();
      for (const k of ["name", "name#1", "name#2"]) {
        const row = v.elements.find((e) => e.id === k)!;
        expect(row, k).toMatchObject({ status: "ok", lines: "1/1" });
        expect(row.ink, k).toBeLessThan(1);
        expect(row.inkRatio, k).toBeGreaterThan(0.9);
      }
      // a later row's text in another colour fails its ink check; nothing else does
      const wrong = run([ink, ink, [240, 120, 90]]);
      expect(own(wrong)).toEqual([expect.objectContaining({ id: "name#2", kind: "ink", detail: expect.stringMatching(/^line 1 of 1: text colour ΔE2000 [\d.]+, design #\w+, Unity #\w+ \(limit 5\.89 at 10\.67 px\)/) })]);
      // a copy whose text Unity does not draw, or draws on two lines, fails as the IR element's would
      const twoLines = boxes(true);
      twoLines.items!["name#1"].lines = [lineOf(1, true), { ...lineOf(1, true), y: lineOf(1, true).y + 8, baseline: lineOf(1, true).baseline + 8 }];
      expect(own(compareCapture({ png: draw(false), boxes: boxes(false) }, { png: draw(true), boxes: twoLines }, [], scaledT, ctx)))
        .toEqual([expect.objectContaining({ id: "name#1", kind: "lines", detail: "1 line in the design, 2 in Unity" })]);
      const noCopy = boxes(true);
      delete noCopy.items!["name#2"];
      expect(compareCapture({ png: draw(false), boxes: boxes(false) }, { png: draw(true), boxes: noCopy }, [], scaledT, ctx).issues.map((i) => `${i.id} ${i.kind}`))
        .toContain("name#2 missing");
    });

    it("fix round 1, I-1: a repeat copy's paint stays judged, only its text lines are masked", () => {
      // the reviewer's probe: a three-row list, each row holding a text chip (IR `chip`, copies `chip#1`, `chip#2`) that
      // paints a 64×20 background behind a line of glyphs; Unity paints chip#2's background in another colour
      const bgC: Rgb = [16, 24, 32], rowC: Rgb = [30, 44, 56], chipC: Rgb = [180, 60, 60], ink: Rgb = [240, 240, 240];
      const chips = [0, 1, 2].map((k) => ({ x: 16, y: 8 + 28 * k, w: 64, h: 20 }));
      const draw = (last: Rgb = chipC) => {
        const png = canvas(160, 96, bgC);
        chips.forEach((c, k) => {
          fill(png, { x: 8, y: c.y - 4, w: 144, h: 28 }, rowC);
          fill(png, c, k === 2 ? last : chipC);
          glyphs(png, { x: c.x + 6, y: c.y + 6, w: 40, h: 8 }, ink);
        });
        return png;
      };
      const line = (k: number) => ({ x: chips[k].x + 6, y: chips[k].y + 5, w: 40, h: 10, baseline: chips[k].y + 13 });
      const boxes: CaptureBoxes = { capture: "c", viewport: [160, 96], scale: 1, external: [], elements: { root: el(0, 0, 160, 96), list: el(8, 4, 144, 84),
        row: el(8, 4, 144, 28), chip: el(chips[0].x, chips[0].y, 64, 20, { text: true, lines: [line(0)] }) },
        items: { "row#1": { ...el(8, 32, 144, 28), text: false, lines: [] }, "row#2": { ...el(8, 60, 144, 28), text: false, lines: [] },
          "chip#1": { ...el(chips[1].x, chips[1].y, 64, 20), text: true, lines: [line(1)] }, "chip#2": { ...el(chips[2].x, chips[2].y, 64, 20), text: true, lines: [line(2)] } } };
      const ctx: CaptureContext = { backgrounds: new Set(["row", "chip"]), painters: new Set(["row", "chip"]), order: ["root", "list", "row", "chip"], root: "root",
        parent: new Map([["list", "root"], ["row", "list"], ["chip", "row"]]), repeats: new Set(["list"]), viewportClass: "exact" };
      const right = compareCapture({ png: draw(), boxes }, { png: draw(), boxes }, [], T, ctx);
      expect(right.issues).toEqual([]);
      const wrong = compareCapture({ png: draw(), boxes }, { png: draw([60, 160, 200]), boxes }, [], T, ctx);
      // the copy's background is no longer hidden from the whole capture's and the list's SSIM
      expect(wrong.pass).toBe(false);
      expect(wrong.issues.map((i) => `${i.id} ${i.kind}`)).toContain("list ssim");
      // its text is still masked and checked on its own
      expect(wrong.elements.find((e) => e.id === "chip#2")).toMatchObject({ lines: "1/1" });
    });

    it("R138: a hairline line (no fully covered pixel) is judged by its ink's colour direction, not its lightness or amount", () => {
      // a 10 device px em dash in the secondary text colour on a row's fill (repeat-items row-time#2 at 1280×720): Chromium
      // splits its 1.2 px stroke over two pixel rows (covering 0.84 and 0.44 of each), UI Toolkit draws most of it in one
      const bgC: Rgb = [18, 60, 71], secondary: Rgb = [185, 208, 214];
      const draw = (rows: [number, number][], c: Rgb) => {
        const png = canvas(32, 16, bgC);
        for (const [y, cov] of rows) for (let x = 10; x < 20; x++) {
          const o = (y * 32 + x) * 4;
          for (let k = 0; k < 3; k++) png.data[o + k] = Math.round(bgC[k] + cov * (c[k] - bgC[k]));
        }
        return png;
      };
      const design = draw([[6, 0.84], [7, 0.44]], secondary);
      const line = { x: 9, y: 2, w: 12, h: 10, baseline: 9 };
      // the text's colour and opacity as the capture records them (ruling R141)
      const recorded = (color?: Rgb): CaptureBoxes => ({ capture: "c", viewport: [32, 16], scale: 0.5, external: [], elements: { root: el(0, 0, 32, 16),
        t: el(9, 2, 12, 10, { text: true, lines: [line], ...(color ? { color: [...color, 1] as [number, number, number, number], opacity: 1 } : {}) }) } });
      const boxes = recorded(secondary);
      const ctx: CaptureContext = { fontPx: { t: 10 }, backgrounds: new Set(), painters: new Set(), order: ["root", "t"], root: "root", viewportClass: "exact" };
      const exactT = thresholdsFor(readThresholds(), "exact");
      const run = (png: Rgba, b = boxes) => compareCapture({ png: design, boxes: b }, { png, boxes: b }, [], exactT, ctx).issues.filter((i) => i.id === "t");
      // the correct dash, drawn over other rows: its lightness and amount measure coverage there, so they are not judged
      const right = draw([[5, 0.01], [6, 1], [7, 0.12]], secondary);
      expect(run(right)).toEqual([]);
      const row = compareCapture({ png: design, boxes }, { png: right, boxes }, [], exactT, ctx).elements.find((e) => e.id === "t")!;
      expect(row.inkDirection).toBeLessThan(exactT.textInkDirection);
      // without the recorded colour nothing is recognised: the usual checks, which fail on the coverage
      expect(run(right, recorded()).map((i) => i.kind).sort()).toEqual(["ink", "inkCoverage"]);
      // a dash of another hue (the accent or the warning colour) fails on its direction
      for (const hue of [[22, 194, 213], [242, 181, 68]] as Rgb[])
        expect(run(draw([[5, 0.01], [6, 1], [7, 0.12]], hue)), hue.join()).toEqual([expect.objectContaining({ kind: "ink",
          detail: expect.stringMatching(/^line 1 of 1: a hairline line \(fewer than 3 fully covered pixels in the design\): its ink's colour direction from the background differs by [\d.]+° .*limit 0\.\d+°/) })]);
      // the documented limit: a lightness-only error of a hairline line (the declared colour 30 % toward the background,
      // the same direction from it) is not caught
      const lighter: Rgb = [135, 164, 171];
      expect(run(draw([[5, 0.01], [6, 1], [7, 0.12]], lighter))).toEqual([]);
      // a normal line, with fully covered pixels, keeps the usual checks: the same lightness error fails its ink colour
      const stems = (c: Rgb) => { const png = canvas(32, 16, bgC); for (let x = 10; x < 20; x += 3) fill(png, { x, y: 3, w: 2, h: 7 }, c); return png; };
      const normal = compareCapture({ png: stems(secondary), boxes }, { png: stems(lighter), boxes }, [], exactT, ctx);
      expect(normal.issues.filter((i) => i.id === "t").map((i) => i.kind)).toContain("ink");
      expect(normal.elements.find((e) => e.id === "t")!.inkDirection ?? null).toBeNull();
      expect(compareCapture({ png: stems(secondary), boxes }, { png: stems(secondary), boxes }, [], exactT, ctx).issues).toEqual([]);
    });

    describe("R141: a hairline line is only a small, unattenuated, uncovered text in its own colour", () => {
      // kit colours: rows on surface-700, secondary and muted text
      const bgC: Rgb = [18, 60, 71], secondary: Rgb = [185, 208, 214], muted: Rgb = [134, 167, 176], veilC: Rgb = [11, 31, 38];
      const exactT = thresholdsFor(readThresholds(), "exact");
      const mix = (c: Rgb, k: number, under: Rgb = bgC): Rgb => [0, 1, 2].map((j) => Math.round(under[j] + k * (c[j] - under[j]))) as Rgb;
      /** Five stems 2 device px wide (an ordinary glyph run), `k` of the colour over the background, from `first` to `last`. */
      const stems = (c: Rgb, k = 1, first = 0, last = 5, veil = 0) => {
        const png = canvas(48, 24, bgC);
        for (let s2 = first; s2 < last; s2++) fill(png, { x: 8 + 6 * s2, y: 5, w: 2, h: 12 }, mix(c, k));
        if (veil) for (let p = 0; p < 48 * 24; p++) { const o = p * 4; for (let j = 0; j < 3; j++) png.data[o + j] = Math.round((1 - veil) * png.data[o + j] + veil * veilC[j]); }
        return png;
      };
      /** The R138 dash: rows of coverage of the colour. */
      const dash = (rows: [number, number][], c: Rgb) => {
        const png = canvas(48, 24, bgC);
        for (const [y, cov] of rows) for (let x = 10; x < 20; x++) { const o = (y * 48 + x) * 4; const m = mix(c, cov); for (let j = 0; j < 3; j++) png.data[o + j] = m[j]; }
        return png;
      };
      const line = { x: 7, y: 3, w: 30, h: 16, baseline: 15 };
      /** The golden boxes: element `t` (or its copy `t#1`) with its computed colour and opacity as the capture records them. */
      const boxes = (color: Rgb, opacity: number, copy = false, more: Record<string, Box> = {}): CaptureBoxes => {
        const own = { color: [...color, 1] as [number, number, number, number], opacity };
        const t = el(7, 3, 30, 16, { text: true, lines: [line], ...(copy ? {} : own) });
        return { capture: "c", viewport: [48, 24], scale: 0.5, external: [], elements: { root: el(0, 0, 48, 24), list: el(0, 0, 48, 24), t: copy ? el(7, 3, 30, 16, { visible: false }) : t, ...more },
          ...(copy ? { items: { "t#1": { ...t, ...own } } } : {}) };
      };
      // (851cf10 took the colour from the IR's static style for the element and its copies, the secondary here)
      const ctxOf = (px: number, _ir: Rgb, more: Partial<CaptureContext> = {}): CaptureContext => ({ fontPx: { t: px }, backgrounds: new Set(), painters: new Set(),
        order: ["root", "list", "t"], root: "root", parent: new Map([["list", "root"], ["t", "list"]]), repeats: new Set(["list"]), viewportClass: "exact", ...more });
      const kinds = (gp: Rgba, gb: CaptureBoxes, up: Rgba, c: CaptureContext, id = "t") =>
        compareCapture({ png: gp, boxes: gb }, { png: up, boxes: gb }, [], exactT, c).issues.filter((i) => i.id === id).map((i) => i.kind).sort();

      it("an opacity-animation sample (design at 0.6) with Unity at 0.8 or missing glyphs fails, at 16 and at 10 px", () => {
        for (const px of [16, 10]) {
          const c = ctxOf(px, secondary, { anim: true, moving: new Set() });
          const gb = boxes(secondary, 0.6);
          expect(kinds(stems(secondary, 0.6), gb, stems(secondary, 0.8), c), `${px} px, wrong opacity`).toContain("ink");
          expect(kinds(stems(secondary, 0.6), gb, stems(secondary, 0.6, 0, 3), c), `${px} px, missing glyphs`).toContain("inkCoverage");
        }
      });

      it("text under a later layer at 30 % with Unity at 0.7 or missing glyphs fails, at 16 and at 10 px", () => {
        for (const px of [16, 10]) {
          const veil = el(0, 0, 48, 24);
          const c = ctxOf(px, secondary, { order: ["root", "list", "t", "veil"], painters: new Set(["veil"]) });
          const gb = boxes(secondary, 1, false, { veil });
          expect(kinds(stems(secondary, 1, 0, 5, 0.3), gb, stems(secondary, 0.7, 0, 5, 0.3), c), `${px} px, lighter`).toContain("ink");
          expect(kinds(stems(secondary, 1, 0, 5, 0.3), gb, stems(secondary, 1, 0, 3, 0.3), c), `${px} px, missing glyphs`).toContain("inkCoverage");
        }
      });

      it("a later item's muted copy (the IR element secondary) drawn lighter or with missing glyphs fails, at 16 and at 10 px", () => {
        for (const px of [16, 10]) {
          const c = ctxOf(px, secondary);
          const gb = boxes(muted, 1, true);
          expect(kinds(stems(muted), gb, stems(muted, 0.75), c, "t#1"), `${px} px, lighter`).toContain("ink");
          expect(kinds(stems(muted), gb, stems(muted, 1, 0, 3), c, "t#1"), `${px} px, missing glyphs`).toContain("inkCoverage");
        }
      });

      it("a hairline dash keeps an ink amount between 0.5 and 2 times the design's: at 0.09 it fails", () => {
        const c = ctxOf(10, secondary);
        const gb = boxes(secondary, 1);
        const design = dash([[6, 0.84], [7, 0.44]], secondary);
        expect(kinds(design, gb, dash([[5, 0.01], [6, 1], [7, 0.12]], secondary), c)).toEqual([]);
        expect(kinds(design, gb, dash([[6, 0.12]], secondary), c)).toEqual(["inkCoverage"]);
      });
    });

    describe("fix round 3: what paints over a hairline line, and the colours drawn on it", () => {
      // the kit's surfaces and text colours; the kit's shadows are black (--shadow-card: 0 8px 24px rgba(0, 0, 0, 0.4))
      const surfaces: Record<string, Rgb> = { "surface-900": [11, 31, 38], "surface-800": [15, 42, 51], "surface-700": [18, 60, 71] };
      const colours: Record<string, Rgb> = { primary: [255, 255, 255], secondary: [185, 208, 214], muted: [134, 167, 176] };
      const exactT = thresholdsFor(readThresholds(), "exact");
      /** Stems 2 device px wide in `c` (five, or those `drawn`), `k` of it over `bg`, under black at `shade` (a shadow). */
      const stems = (bg: Rgb, c: Rgb, k = 1, shade = 0, drawn = [0, 1, 2, 3, 4]) => {
        const png = canvas(48, 40, bg);
        for (const s2 of drawn) fill(png, { x: 8 + 6 * s2, y: 5, w: 2, h: 12 }, [0, 1, 2].map((j) => Math.round(bg[j] + k * (c[j] - bg[j]))) as Rgb);
        if (shade) for (let p = 0; p < 48 * 40; p++) { const o = p * 4; for (let j = 0; j < 3; j++) png.data[o + j] = Math.round((1 - shade) * png.data[o + j]); }
        return png;
      };
      const line = { x: 7, y: 3, w: 30, h: 16, baseline: 15 };
      // two middle glyphs missing: the ends stay, so the extent check does not decide
      const missing = [0, 2, 4];
      const own = (c: Rgb, more: Partial<Box> = {}) => ({ color: [...c, 1] as [number, number, number, number], opacity: 1, ...more });
      const kinds = (gp: Rgba, gb: CaptureBoxes, up: Rgba, c: CaptureContext, id = "t") =>
        compareCapture({ png: gp, boxes: gb }, { png: up, boxes: gb }, [], exactT, c).issues.filter((i) => i.id === id).map((i) => i.kind).sort();

      it("N-5: a 10 px line under a later card's black shadow at 0.15 to 0.4, Unity at 0.7 or missing glyphs, fails", () => {
        // the card is painted after the text, its box below the line, its outer shadow over it
        const card = el(0, 26, 48, 14);
        const boxes = (c: Rgb): CaptureBoxes => ({ capture: "c", viewport: [48, 40], scale: 0.5, external: [],
          elements: { root: el(0, 0, 48, 40), t: el(7, 3, 30, 16, { text: true, lines: [line], ...own(c) }), card } });
        const ctx: CaptureContext = { fontPx: { t: 10 }, backgrounds: new Set(["card"]), painters: new Set(["card"]), order: ["root", "t", "card"], root: "root",
          viewportClass: "exact", shadows: { card: { x: -12, y: 0, w: 72, h: 52 } } };
        const passed: string[] = [];
        for (const [sn, bg] of Object.entries(surfaces)) for (const [cn, c] of Object.entries(colours)) for (const shade of [0.15, 0.25, 0.4]) {
          const design = stems(bg, c, 1, shade);
          if (!kinds(design, boxes(c), stems(bg, c, 0.7, shade), ctx).length) passed.push(`${sn} ${cn} ${shade}: lighter`);
          if (!kinds(design, boxes(c), stems(bg, c, 1, shade, missing), ctx).length) passed.push(`${sn} ${cn} ${shade}: missing glyphs`);
          expect(kinds(design, boxes(c), stems(bg, c, 1, shade), ctx), `${sn} ${cn} ${shade}: the same text`).toEqual([]);
        }
        expect(passed).toEqual([]);
      });

      it("N-5: a later repeat item's copy over the line counts as a later layer, the line's own row does not", () => {
        // the list's rows overlap: row #1's veil (a 30 % layer) lies over the first row's text
        const bg = surfaces["surface-700"], c = colours.secondary, veilC: Rgb = [11, 31, 38];
        const veiled = (k: number, drawn?: number[]) => {
          const png = stems(bg, c, k, 0, drawn);
          for (let y = 0; y < 22; y++) for (let x = 0; x < 48; x++) { const o = (y * 48 + x) * 4; for (let j = 0; j < 3; j++) png.data[o + j] = Math.round(0.7 * png.data[o + j] + 0.3 * veilC[j]); }
          return png;
        };
        const boxes: CaptureBoxes = { capture: "c", viewport: [48, 40], scale: 0.5, external: [],
          elements: { root: el(0, 0, 48, 40), list: el(0, 0, 48, 40), row: el(0, 0, 48, 22), t: el(7, 3, 30, 16, { text: true, lines: [line], ...own(c) }), veil: el(0, 40, 48, 0, { visible: false }) },
          items: { "row#1": el(0, 0, 48, 22), "t#1": el(7, 30, 30, 8, { visible: false }), "veil#1": el(0, 0, 48, 22) } };
        const ctx: CaptureContext = { fontPx: { t: 10 }, backgrounds: new Set(["veil"]), painters: new Set(["veil"]), order: ["root", "list", "row", "t", "veil"], root: "root",
          parent: new Map([["list", "root"], ["row", "list"], ["t", "row"], ["veil", "row"]]), repeats: new Set(["list"]), viewportClass: "exact" };
        expect(kinds(veiled(1), boxes, veiled(0.7), ctx), "lighter").toContain("ink");
        expect(kinds(veiled(1), boxes, veiled(1, missing), ctx), "missing glyphs").toContain("inkCoverage");
        expect(kinds(veiled(1), boxes, veiled(1), ctx), "the same text").toEqual([]);
      });

      it("N-6: a 10 px line drawn in a muted span inside secondary text, Unity lighter or missing glyphs, fails", () => {
        const bg = surfaces["surface-700"], secondary = colours.secondary, muted = colours.muted;
        // the capture records the element's colour (secondary) and that the line holds text in another colour
        const boxes = (mixed: boolean): CaptureBoxes => ({ capture: "c", viewport: [48, 40], scale: 0.5, external: [],
          elements: { root: el(0, 0, 48, 40), t: el(7, 3, 30, 16, { text: true, lines: [{ ...line, ...(mixed ? { mixed: true } : {}) }], ...own(secondary) }) } });
        const ctx: CaptureContext = { fontPx: { t: 10 }, backgrounds: new Set(), painters: new Set(), order: ["root", "t"], root: "root", viewportClass: "exact" };
        for (const k of [1, 0.85]) {
          const design = stems(bg, muted, k);
          expect(kinds(design, boxes(true), stems(bg, muted, 0.75 * k), ctx), `${k}: lighter`).toContain("ink");
          expect(kinds(design, boxes(true), stems(bg, muted, k, 0, missing), ctx), `${k}: missing glyphs`).toContain("inkCoverage");
          expect(kinds(design, boxes(true), stems(bg, muted, k), ctx), `${k}: the same text`).toEqual([]);
        }
      });
    });

    it("R133: the evidence names every condition that does not hold, not only the first", () => {
      // the R129 avatar in an animation sample that moves it: a dent outside the band and a ring 1.5 device px thinner
      const ringC: Rgb = [240, 240, 240], fillC: Rgb = [20, 24, 28], bgC: Rgb = [0, 0, 0], outer = 240, W = 272, x0 = 16.4;
      const boxes: CaptureBoxes = { capture: "c", viewport: [W, W], scale: 1.5, external: [], elements: { root: el(0, 0, W, W), avatar: el(x0, x0, outer, outer) } };
      const ctx: CaptureContext = { borders: { avatar: [6, 6, 6, 6] }, radii: { avatar: [120, 120, 120, 120] }, backgrounds: new Set(["avatar"]), painters: new Set(["avatar"]),
        order: ["root", "avatar"], root: "root", viewportClass: "exact", anim: true, moving: new Set(["avatar"]) };
      const coarse = (ring: number) => {
        const img = avatar(160, x0 + 0.4, x0 + 0.4, outer - 0.8, ring, ringC, fillC, bgC, W, W), ref = avatar(160, x0 + 0.4, x0 + 0.4, outer - 0.8, ring, ringC, fillC, bgC, W, W);
        for (let p = 0; p < W * W; p++) {
          const o = p * 4, near = (c: Rgb) => Math.hypot(ref.data[o] - c[0], ref.data[o + 1] - c[1], ref.data[o + 2] - c[2]);
          img.data.set([bgC, ringC, fillC].reduce((a, k) => (near(k) < near(a) ? k : a)), o);
        }
        return img;
      };
      const both = coarse(4.5);
      fill(both, { x: 110, y: 110, w: 3, h: 3 }, [200, 80, 40]);
      const v = compareCapture({ png: avatar(160, x0, x0, outer, 6, ringC, fillC, bgC, W, W), boxes }, { png: both, boxes }, [], exactT, ctx);
      expect(issuesOf(v, "avatar")).toEqual([expect.objectContaining({ kind: "ssim",
        detail: expect.stringMatching(/masked, but an SSIM block outside the band, .* \(below 0\.99: not confined to it\), and .*avatar \w+ (border|corner) is drawn 4\.\d+ device px wide, the design's 6\.\d+ \(limit ±0\.5\)/) })]);
    });

    it("R125: a raster picture resampled at a scaled viewport meets ssimResampledPicture and its colour limit, nowhere else", () => {
      // background-images root__1__0 at 1600×900: a 225 × 135 device px picture exported for 3840×2160 drawn at 0.42 of its
      // pixels (crop of the suite's capture, on the 8 px block grid)
      const crop = (side: string) => decodePng(fs.readFileSync(path.join(here, "fixtures", "compare", `r125-picture-1600.${side}.png`)));
      const boxes: CaptureBoxes = { capture: "c", viewport: [256, 168], scale: 0.625, external: [], elements: { root: el(0, 0, 256, 168), pic: el(14, 16, 225, 135) } };
      const ctx: CaptureContext = { pictures: new Set(["pic"]), backgrounds: new Set(["pic"]), painters: new Set(["pic"]), order: ["root", "pic"], root: "root", viewportClass: "scaled" };
      const v = (t: Thresholds, c: CaptureContext = ctx) => compareCapture({ png: crop("design"), boxes }, { png: crop("unity"), boxes }, [], t, c);
      const scaled = v(scaledT);
      expect(issuesOf(scaled, "pic")).toEqual([]);
      const row = scaled.elements.find((e) => e.id === "pic")!;
      expect(Math.max(row.ssim!, row.ssimShifted!)).toBeCloseTo(0.95522, 4); // 0.95284 in the whole capture (its text masks), the suite's lowest
      expect(row.ssimLimit).toBe(0.95);
      expect(row.deltaE).toBeCloseTo(3.22, 2);
      // the same crop held to the exact class's limits, or as an element that is no picture
      expect(issuesOf(v(exactT, { ...ctx, viewportClass: "exact" }), "pic").map((i) => i.kind).sort()).toEqual(["color", "ssim"]);
      expect(issuesOf(v(scaledT, { ...ctx, pictures: new Set() }), "pic").map((i) => i.kind).sort()).toEqual(["color", "ssim"]);
      // a picture below the measured floor fails at a scaled viewport too
      expect(issuesOf(v({ ...scaledT, ssimResampledPicture: 0.96 }), "pic")).toEqual([expect.objectContaining({ kind: "ssim" })]);
    });

    it("R126: text under 13 device px at a scaled viewport takes the measured small-text ink limit, capped at 6.5", () => {
      // stacked-text value-12 at 1366×768: a 10.67 device px line, ink colour ΔE2000 5.49 (crop of the suite's capture)
      const crop = (side: string) => decodePng(fs.readFileSync(path.join(here, "fixtures", "compare", `r126-ink-1366.${side}.png`)));
      const line = (x: number, w: number) => ({ x: x - 792, y: 206.983854 - 200, w, h: 12.803125, baseline: 217.119662 - 200 });
      const boxes = (unity: boolean): CaptureBoxes => ({ capture: "c", viewport: [56, 24], scale: 0.533464, external: [], elements: { root: el(0, 0, 56, 24),
        v: unity ? el(798.061391 - 792, 206.983855 - 200, 39.831947, 12.803126, { text: true, lines: [line(798.061391, 39.883033)] })
          : el(798.061459 - 792, 206.983854 - 200, 39.993095, 12.803125, { text: true, lines: [line(798.061459, 39.884735)] }) } });
      const ctx: CaptureContext = { fontPx: { v: 10.669271 }, backgrounds: new Set(), painters: new Set(), order: ["root", "v"], root: "root", viewportClass: "scaled" };
      const v = (t: Thresholds) => compareCapture({ png: crop("design"), boxes: boxes(false) }, { png: crop("unity"), boxes: boxes(true) }, [], t, ctx);
      expect(scaledT.textInkDeltaEFirstSmall).toBe(5.89);
      expect(inkColourLimit(scaledT, 10.67)).toBe(5.89);
      expect(inkColourLimit(scaledT, 13)).toBe(scaledT.textInkDeltaE);
      expect(inkColourLimit(exactT, 10.67)).toBe(exactT.textInkDeltaEFirstSmall); // 4.5: text of at most 12 device px
      expect(issuesOf(v(scaledT), "v")).toEqual([]);
      expect(v(scaledT).elements.find((e) => e.id === "v")!.ink).toBeCloseTo(5.49, 2);
      expect(issuesOf(v({ ...scaledT, textInkDeltaEFirstSmall: 4.5 }), "v")).toEqual([expect.objectContaining({ kind: "ink", detail: expect.stringMatching(/ΔE2000 5\.49/) })]);
    });
  });

  it("masks for ssimRoundEdge the edge band of the element's own and its descendants' round shapes, not of others", () => {
    // a square card 64 px wide with a round 40 px knob over it, drawn with a ramp of 0.5 px in the design and 2.5 in Unity
    const bg: Rgb = [30, 30, 30], cardC: Rgb = [60, 70, 80], knob: Rgb = [240, 240, 240];
    const draw = (ramp: number) => {
      const png = fill(canvas(320, 192, bg), { x: 88, y: 64, w: 64, h: 64 }, cardC);
      for (let y = 70; y < 122; y++) for (let x = 94; x < 146; x++) {
        const d = Math.hypot(x + 0.5 - 120, y + 0.5 - 96);
        const a = Math.max(0, Math.min(1, (20 + ramp / 2 - d) / ramp)), o = (y * png.w + x) * 4;
        for (let k = 0; k < 3; k++) png.data[o + k] = Math.round(knob[k] * a + png.data[o + k] * (1 - a));
      }
      return png;
    };
    const boxes: CaptureBoxes = { capture: "c", viewport: [320, 192], scale: 0.5335, external: [], elements: { root: el(0, 0, 320, 192), card: el(88, 64, 64, 64), knob: el(100, 76, 40, 40) } };
    const scaled: Thresholds = { ...T, ssimRoundEdge: 0.95 };
    const run = (parent: string) => {
      const ctx: CaptureContext = { radii: { knob: [20, 20, 20, 20] }, backgrounds: new Set(["card", "knob"]), painters: new Set(["card", "knob"]), order: ["root", "card", "knob"], root: "root",
        parent: new Map([["card", "root"], ["knob", parent]]), viewportClass: "scaled" };
      return compareCapture({ png: draw(0.5), boxes }, { png: draw(2.5), boxes }, [], scaled, ctx);
    };
    // the knob inside the card: the card's region holds its descendant's ramp, masked
    expect(run("card").issues).toEqual([]);
    // the knob a sibling drawn over the card: its ramp is the knob's (relaxed there), not the card's
    const v = run("root");
    expect(v.issues.filter((i) => i.id === "knob")).toEqual([]);
    expect(v.issues).toEqual([expect.objectContaining({ id: "card", kind: "ssim", detail: expect.stringMatching(/not confined to that band/) })]);
  });

  it("samples a border where both renderers paint it: Chromium snaps a box to whole CSS px, UI Toolkit to device px", () => {
    // a content-sized button at 1920×1080 (scale 0.75): laid out at x 180.996 (241.328 CSS px), Chromium paints it from
    // 241 CSS px = 180.75 device px (a quarter-covered first column), UI Toolkit from 181; a 3-px border either way
    const bg: Rgb = [11, 31, 38], fillC: Rgb = [18, 60, 71], line: Rgb = [43, 101, 115];
    const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((k) => Math.round(a[k] * t + b[k] * (1 - t))) as Rgb;
    const draw = (x0: number, lead: number, border: Rgb) => {
      const png = canvas(320, 200, bg);
      fill(png, { x: x0, y: 100, w: 300 - x0, h: 48 }, fillC);
      fill(png, { x: x0, y: 100, w: 300 - x0, h: 3 }, border); fill(png, { x: x0, y: 145, w: 300 - x0, h: 3 }, border);
      fill(png, { x: 297, y: 100, w: 3, h: 48 }, border);
      if (lead > 0) { // first column partly covered, the border ends a fraction into the fourth
        fill(png, { x: x0 - 1, y: 100, w: 1, h: 48 }, mix(border, bg, lead));
        fill(png, { x: x0, y: 100, w: 2, h: 48 }, border);
        fill(png, { x: x0 + 2, y: 103, w: 1, h: 42 }, mix(border, fillC, 1 - lead));
      } else fill(png, { x: x0, y: 100, w: 3, h: 48 }, border);
      glyphs(png, { x: 220, y: 116, w: 40, h: 16 }, [250, 250, 250]);
      return png;
    };
    const boxes = (x: number, w: number): CaptureBoxes => ({
      capture: "c", viewport: [320, 200], scale: 0.75, external: [],
      elements: { root: el(0, 0, 320, 200), btn: el(x, 100, w, 48, { text: true, lines: [{ x: 220, y: 114, w: 40, h: 20, baseline: 130 }] }) },
    });
    const ctx: CaptureContext = { borders: { btn: [3, 3, 3, 3] }, backgrounds: new Set(["btn"]), painters: new Set(["btn"]), order: ["root", "btn"], root: "root" };
    const golden = { png: draw(181, 0.25, line), boxes: boxes(180.996094, 118.992188) };
    const unity = { png: draw(181, 0, line), boxes: boxes(181, 119) };
    const v = compareCapture(golden, unity, [], T, ctx);
    expect(v.issues.filter((i) => i.kind === "edge" || i.kind === "color")).toEqual([]);
    // a wrong border colour still fails
    const wrong = { png: draw(181, 0, [70, 140, 160]), boxes: boxes(181, 119) };
    expect(compareCapture(golden, wrong, [], T, ctx).issues.map((i) => i.kind)).toContain("edge");
  });

  it("samples every border side of an element whose four edges are off the device grid", () => {
    // a button at 1280×720 (scale 0.5) laid out at 161, 101 CSS px, 240×60, with a 4px border: Chromium paints it from
    // 80.5, 50.5 device px with every outer edge and the border's inner edges half covered; UI Toolkit from 81, 51
    const bg: Rgb = [11, 31, 38], fillC: Rgb = [18, 60, 71], line: Rgb = [43, 101, 115], wrong: Rgb = [70, 140, 160];
    const draw = (b: R, edge: Rgb, sides: Partial<Record<"top" | "right" | "bottom" | "left", Rgb>> = {}) => {
      const png = canvas(320, 200, bg);
      paint(png, b, edge);
      const bands = { top: { x: b.x, y: b.y, w: b.w, h: 2 }, bottom: { x: b.x, y: b.y + b.h - 2, w: b.w, h: 2 }, left: { x: b.x, y: b.y, w: 2, h: b.h }, right: { x: b.x + b.w - 2, y: b.y, w: 2, h: b.h } };
      for (const [side, c] of Object.entries(sides)) paint(png, bands[side as keyof typeof bands], c);
      paint(png, { x: b.x + 2, y: b.y + 2, w: b.w - 4, h: b.h - 4 }, fillC);
      glyphs(png, { x: 120, y: 60, w: 40, h: 12 }, [250, 250, 250]);
      return png;
    };
    const boxes = (x: number, y: number): CaptureBoxes => ({
      capture: "c", viewport: [320, 200], scale: 0.5, external: [],
      elements: { root: el(0, 0, 320, 200), btn: el(x, y, 120, 30, { text: true, lines: [{ x: 118, y: 58, w: 44, h: 16, baseline: 70 }] }) },
    });
    const ctx: CaptureContext = { borders: { btn: [2, 2, 2, 2] }, backgrounds: new Set(["btn"]), painters: new Set(["btn"]), order: ["root", "btn"], root: "root" };
    const golden = { png: draw({ x: 80.5, y: 50.5, w: 120, h: 30 }, line), boxes: boxes(80.5, 50.5) };
    const unity = (sides: Partial<Record<"top" | "right" | "bottom" | "left", Rgb>> = {}) => ({ png: draw({ x: 81, y: 51, w: 120, h: 30 }, line, sides), boxes: boxes(81, 51) });
    const colourIssues = (v: ReturnType<typeof compareCapture>) => v.issues.filter((i) => i.kind === "edge" || i.kind === "color");
    expect(colourIssues(compareCapture(golden, unity(), [], T, ctx))).toEqual([]);
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const v = compareCapture(golden, unity({ [side]: wrong }), [], T, ctx);
      expect(colourIssues(v).map((i) => i.detail), side).toEqual([expect.stringMatching(new RegExp(`^${side} border: ΔE2000`))]);
    }
  });

  it("checks a thin element on its painted centre line: a divider Unity drops or colours wrongly fails, one it draws passes", () => {
    // dividers at 1920×1080 (scale 0.75) laid out at 52, 130 CSS px, 320 CSS px wide: 1 CSS px (0.75 device px from 97.5,
    // which UI Toolkit rounds to nothing) and 4 CSS px (3 device px from 97.5; UI Toolkit draws 98 to 101)
    const bg: Rgb = [11, 31, 38], line: Rgb = [43, 101, 115];
    const mk = (b: R | null, c: Rgb, box: R) => {
      const png = canvas(320, 200, bg);
      if (b) paint(png, b, c);
      return { png, boxes: { capture: "c", viewport: [320, 200] as [number, number], scale: 0.75, external: [], elements: { root: el(0, 0, 320, 200), line: el(box.x, box.y, box.w, box.h) } } };
    };
    const ctx: CaptureContext = { backgrounds: new Set(["root", "line"]), painters: new Set(["root", "line"]), order: ["root", "line"], root: "root" };
    const hair = { x: 39, y: 97.5, w: 240, h: 0.75 };
    const golden1 = mk(hair, line, hair);
    const dropped = compareCapture(golden1, mk(null, line, { x: 39, y: 98, w: 240, h: 0 }), [], T, ctx);
    expect(dropped.pass).toBe(false);
    expect(dropped.issues.filter((i) => i.id === "line").map((i) => i.kind)).toEqual(expect.arrayContaining(["box", "color"]));
    const wrongColour = compareCapture(golden1, mk({ x: 39, y: 98, w: 240, h: 1 }, [120, 40, 40], { x: 39, y: 98, w: 240, h: 1 }), [], T, ctx);
    expect(wrongColour.issues.filter((i) => i.id === "line").map((i) => i.kind)).toContain("color");

    const bar = { x: 39, y: 97.5, w: 240, h: 3 }, unityBar = { x: 39, y: 98, w: 240, h: 3 };
    const golden4 = mk(bar, line, bar);
    const drawn = compareCapture(golden4, mk(unityBar, line, unityBar), [], T, ctx);
    expect(drawn.issues).toEqual([]);
    expect(drawn.elements.find((e) => e.id === "line")!.samples).toBeGreaterThan(0);
    const missing = compareCapture(golden4, mk(null, line, unityBar), [], T, ctx);
    expect(missing.issues.filter((i) => i.id === "line").map((i) => i.kind)).toEqual(["color"]);
    const recoloured = compareCapture(golden4, mk(unityBar, [120, 40, 40], unityBar), [], T, ctx);
    expect(recoloured.issues.filter((i) => i.id === "line").map((i) => i.kind)).toEqual(["color"]);
  });

  it("copies the anti-aliased column of an edge the design paints off the device grid, and only that column", () => {
    // a 24-px-tall tile at scale 0.75 laid out from 120.996 device px (161.33 CSS px): Chromium paints it from 161 CSS px,
    // 120.75 device px, so column 120 is a quarter covered; UI Toolkit paints from 121
    const bg: Rgb = [11, 31, 38], c: Rgb = [22, 194, 213];
    const mk = (lead: boolean) => {
      const png = canvas(320, 200, bg);
      fill(png, { x: 121, y: 96, w: 41, h: 24 }, c);
      if (lead) fill(png, { x: 120, y: 96, w: 1, h: 24 }, [14, 72, 82]);
      return png;
    };
    const boxes = (x: number, w: number): CaptureBoxes => ({ capture: "c", viewport: [320, 200], scale: 0.75, external: [], elements: { root: el(0, 0, 320, 200), tile: el(x, 96, w, 24) } });
    const ctx: CaptureContext = { painters: new Set(["tile"]), backgrounds: new Set(["tile"]), order: ["root", "tile"], root: "root" };
    const v = compareCapture({ png: mk(true), boxes: boxes(120.996094, 41.003906) }, { png: mk(false), boxes: boxes(121, 41) }, [], T, ctx);
    expect(v.issues).toEqual([]);
    expect(v.offGridEdges).toBe(1);
    expect(v.elements.find((e) => e.id === "tile")!.ssim).toBe(1);
    // on the grid nothing is copied: the same column counts
    const on = compareCapture({ png: mk(true), boxes: boxes(120, 42) }, { png: mk(false), boxes: boxes(120, 42) }, [], T, ctx);
    expect(on.offGridEdges).toBe(0);
    expect(on.elements.find((e) => e.id === "tile")!.ssim).toBeLessThan(0.999);
  });

  it("holds later lines of small text to the measured later-line ink limit, and first lines to the usual one", () => {
    const mk = (l1: Rgb, l2: Rgb) => {
      const png = canvas(320, 192, [16, 24, 32]);
      glyphs(png, { x: 50, y: 52, w: 80, h: 6 }, l1);
      glyphs(png, { x: 50, y: 64, w: 80, h: 6 }, l2);
      return { png, boxes: { capture: "c", viewport: [320, 192] as [number, number], scale: 1, external: [], elements: {
        root: el(0, 0, 320, 192),
        label: el(48, 48, 96, 24, { text: true, lines: [{ x: 50, y: 50, w: 82, h: 10, baseline: 58 }, { x: 50, y: 62, w: 82, h: 10, baseline: 70 }] }),
      } } };
    };
    const t: Thresholds = { ...T, textInkFullPx: 9, textInkDeltaE: 2, textInkDeltaESmall: [[8, 3], [0, 10]], textInkDeltaELater: [[9, 4.5], [8, 6]] };
    const ctx: CaptureContext = { fontPx: { label: 9 }, backgrounds: new Set(), painters: new Set() };
    const white: Rgb = [250, 250, 250], grey: Rgb = [232, 232, 232];
    const later = compareCapture(mk(white, white), mk(white, grey), [], t, ctx);
    expect(later.elements.find((e) => e.id === "label")!.ink!).toBeGreaterThan(2);
    expect(later.issues.filter((i) => i.kind === "ink")).toEqual([]);
    const first = compareCapture(mk(white, white), mk(grey, white), [], t, ctx);
    expect(first.issues.filter((i) => i.kind === "ink")).toEqual([expect.objectContaining({ id: "label", detail: expect.stringMatching(/line 1 of 2.*limit 2 at 9 px\)/) })]);
    // from textInkLaterBelowPx up every line keeps the usual limit
    expect(compareCapture(mk(white, white), mk(white, grey), [], t, { ...ctx, fontPx: { label: 12 } }).issues.filter((i) => i.kind === "ink")).toHaveLength(1);
  });

  it("does not compare what lies outside the screen root (a coverage viewport of another aspect)", () => {
    // the 2560×1440 screen at 640×1080 (scale 0.5): 1280×720 device px of screen, then the page's white in the golden and
    // the panel's clear colour in Unity
    const mk = (below: Rgb) => {
      const png = canvas(320, 192, [11, 31, 38]);
      fill(png, { x: 0, y: 96, w: 320, h: 96 }, below);
      fill(png, { x: 40, y: 20, w: 64, h: 40 }, [22, 194, 213]);
      return { png, boxes: { capture: "c", viewport: [320, 192] as [number, number], scale: 0.5, external: [], elements: { root: el(0, 0, 320, 96), tile: el(40, 20, 64, 40) } } };
    };
    const ctx: CaptureContext = { root: "root", order: ["root", "tile"], backgrounds: new Set(["root", "tile"]), painters: new Set(["root", "tile"]) };
    const v = compareCapture(mk([255, 255, 255]), mk([255, 0, 255]), [], T, ctx);
    expect(v.issues).toEqual([]);
    expect(v.outsideScreen).toBe(true);
    expect(compareCapture(mk([255, 255, 255]), mk([255, 0, 255]), [], T, { ...ctx, root: null }).issues.map((i) => i.kind)).toContain("ssim");
  });

  it("compares translucent Unity pixels premultiplied", () => {
    const g = scene(), u = scene();
    for (let p = 3; p < u.png.data.length; p += 4) u.png.data[p] = 254;
    const v = compareCapture(g, u, [], T);
    expect(v.translucent).toBe(320 * 192);
    expect(v.pass).toBe(true);
    for (let p = 3; p < u.png.data.length; p += 4) u.png.data[p] = 128;
    expect(compareCapture(g, u, [], T).pass).toBe(false);
  });
});

describe("IR context", () => {
  const ir = {
    irVersion: 1, screen: "s", referenceViewport: [2560, 1440], viewports: [[2560, 1440]], screenMatch: 0.5, states: ["default", "busy"],
    breakpoints: [{ name: "narrow", maxWidth: 1000 }],
    root: {
      id: "root", kind: "container", style: { base: { "background-color": "rgb(10, 10, 10)" } }, children: [
        {
          id: "card", kind: "container", style: { base: { "background-color": "rgba(0, 0, 0, 0)", "border-top-left-radius": "16px", "border-bottom-right-radius": "8px" },
            "state:busy": { "background-color": "#334455", "border-top-left-radius": "0px" } },
          shadow: { offset: { x: -4, y: -2, w: 8, h: 10 } },
          shadowLayers: { hover: { offset: { x: -10, y: -6, w: 20, h: 24 } }, "state:busy": null },
          children: [{ id: "btn", kind: "button", style: { base: {} }, background: { kind: "svg" }, children: [] }],
        },
      ],
    },
  };
  const boxes: CaptureBoxes = {
    capture: "x", viewport: [1280, 720], scale: 0.5, external: [],
    elements: { root: el(0, 0, 1280, 720), card: el(100, 100, 200, 100), btn: el(120, 120, 50, 20) },
  };
  const ix = indexIr(ir);

  it("scales the base shadow offset to device px and picks a layer's shadow when it holds", () => {
    const base = captureContext(ix, { state: "default", viewport: [1280, 720], apply: [] }, boxes);
    expect(base.order).toEqual(["root", "card", "btn"]);
    expect(base.shadows).toEqual({ card: { x: 98, y: 99, w: 204, h: 105 } });
    // hovering a descendant hovers the card (real pointer)
    const hover = captureContext(ix, { state: "default", viewport: [1280, 720], apply: [{ kind: "pseudo", pseudo: "hover", elementId: "btn" }] }, boxes);
    expect(hover.shadows).toEqual({ card: { x: 95, y: 97, w: 210, h: 112 } });
    // a layer can remove the shadow
    expect(captureContext(ix, { state: "busy", viewport: [1280, 720], apply: [] }, boxes).shadows).toEqual({});
    // a pointer in a later written-out repeat item is not on the IR's own elements, whose boxes the capture measures
    const later = captureContext(ix, { state: "default", viewport: [1280, 720], apply: [{ kind: "pseudo", pseudo: "hover", elementId: "btn", item: [2] }] }, boxes);
    expect(later.shadows).toEqual(base.shadows);
  });

  it("knows which elements draw a raster picture at another size than its own", () => {
    const pic = indexIr({ ...ir, root: { ...ir.root, children: [
      { id: "photo", kind: "image", style: { base: {} }, asset: { kind: "image", width: 320, height: 180 }, children: [] },
      { id: "natural", kind: "image", style: { base: {} }, asset: { kind: "image", width: 160, height: 90 }, children: [] },
      { id: "icon", kind: "vector", style: { base: {} }, asset: { kind: "svg", width: 24, height: 24 }, children: [] },
      // url() background images: resampled unless drawn at their own size (background-size auto, or their px size)
      { id: "tiled", kind: "container", style: { base: { "background-size": "auto" } }, background: { kind: "image", width: 40, height: 24 }, children: [] },
      { id: "own", kind: "container", style: { base: { "background-size": "40px 24px" } }, background: { kind: "image", width: 40, height: 24 }, children: [] },
      { id: "cover", kind: "container", style: { base: { "background-size": "cover" } }, background: { kind: "image", width: 40, height: 24 }, children: [] },
      { id: "hover-size", kind: "container", style: { base: {}, hover: { "background-size": "80px 48px" } }, background: { kind: "image", width: 40, height: 24 }, children: [] },
      { id: "gradient", kind: "container", style: { base: { "background-size": "auto" } }, background: { kind: "svg", width: 0, height: 0 }, children: [] },
    ] } });
    const b: CaptureBoxes = { ...boxes, scale: 1, elements: { root: el(0, 0, 1280, 720), photo: el(0, 0, 100, 180), natural: el(200, 0, 160, 90), icon: el(400, 0, 12, 12),
      tiled: el(0, 200, 100, 100), own: el(100, 200, 100, 100), cover: el(200, 200, 100, 100), "hover-size": el(300, 200, 100, 100), gradient: el(400, 200, 100, 100) } };
    const ctx = captureContext(pic, { state: "default", viewport: [2560, 1440], apply: [] }, b);
    expect([...ctx.pictures!].sort()).toEqual(["cover", "photo"]);
    const hovered = captureContext(pic, { state: "default", viewport: [2560, 1440], apply: [{ kind: "pseudo", pseudo: "hover", elementId: "hover-size" }] }, b);
    expect([...hovered.pictures!].sort()).toEqual(["cover", "hover-size", "photo"]);
    // at another scale than the reference every background image is resampled
    const half = captureContext(pic, { state: "default", viewport: [1280, 720], apply: [] }, { ...b, scale: 0.5 });
    expect([...half.pictures!].sort()).toEqual(["cover", "hover-size", "own", "photo", "tiled"]);
  });

  it("knows which elements an animation sample shows rotated off the axes (the design's rotation on the screen)", () => {
    const b: CaptureBoxes = { ...boxes, elements: { root: el(0, 0, 1280, 720), card: { ...el(100, 100, 200, 100), rotation: 10 }, btn: { ...el(120, 120, 50, 20), rotation: -90 } } };
    const anim = { sampled: [{ elementId: "card", index: 0 }], runs: [{ elementId: "card", index: 0 }], from: null, sample: 1, time: 100 };
    expect([...captureContext(ix, { state: "default", viewport: [1280, 720], apply: [], anim }, b).rotated!]).toEqual(["card"]);
    // a static capture: Chromium draws a rotated element without a composited layer, as UI Toolkit does
    expect([...captureContext(ix, { state: "default", viewport: [1280, 720], apply: [] }, b).rotated!]).toEqual([]);
  });

  it("counts an element as moving in an animation sample only when an animation that runs changes its geometry (ruling R132)", () => {
    const animated = indexIr({ ...ir, root: { ...ir.root, children: [{ ...ir.root.children[0], anims: [
      { kind: "transition", properties: ["background-color", "border-top-color", "opacity"] },
      { kind: "keyframes", properties: ["background-color", "translate"] },
      { kind: "transition", properties: ["width"] },
      { kind: "keyframes", properties: ["box-shadow", "filter", "color"] },
      { kind: "transition" },
    ] }] } });
    const anim = (...index: number[]) => ({ sampled: [{ elementId: "card", index: index[0] }], runs: index.map((i) => ({ elementId: "card", index: i })), from: null, sample: 1, time: 100 });
    const moving = (...index: number[]) => [...captureContext(animated, { state: "default", viewport: [1280, 720], apply: [], anim: anim(...index) }, boxes).moving!].sort();
    // a colour, an opacity, a shadow or a filter does not move it; a translate or a size does, with what it holds
    expect(moving(0)).toEqual([]);
    expect(moving(3)).toEqual([]);
    expect(moving(1)).toEqual(["btn", "card"]);
    expect(moving(2)).toEqual(["btn", "card"]);
    expect(moving(0, 3, 1)).toEqual(["btn", "card"]);
    // an IR without the animation's properties: it may move
    expect(moving(4)).toEqual(["btn", "card"]);
  });

  it("knows which text has a blurred text-shadow in the capture", () => {
    const shadowed = indexIr({ ...ir, root: { ...ir.root, children: [
      { id: "soft", kind: "text", text: { tr: "a" }, style: { base: { "text-shadow": "0px 2px 4px rgba(0, 0, 0, 0.6)" } }, children: [] },
      { id: "hard", kind: "text", text: { tr: "b" }, style: { base: { "text-shadow": "3px 3px 0px #f0605d" } }, children: [] },
      { id: "hover", kind: "text", text: { tr: "c" }, style: { base: { "text-shadow": "none" }, hover: { "text-shadow": "0px 4px 12px rgba(22, 194, 213, 0.9)" } }, children: [] },
    ] } });
    const b: CaptureBoxes = { ...boxes, elements: { root: el(0, 0, 1280, 720), soft: el(0, 0, 100, 20), hard: el(0, 40, 100, 20), hover: el(0, 80, 100, 20) } };
    const at = (apply: CaptureJob["apply"]) => [...captureContext(shadowed, { state: "default", viewport: [1280, 720], apply }, b).textShadows!].sort();
    expect(at([])).toEqual(["soft"]);
    expect(at([{ kind: "pseudo", pseudo: "hover", elementId: "hover" }])).toEqual(["hover", "soft"]);
  });

  it("knows each element's corner radii in device px in the capture", () => {
    expect(captureContext(ix, { state: "default", viewport: [1280, 720], apply: [] }, boxes).radii).toEqual({ card: [8, 0, 4, 0] });
    expect(captureContext(ix, { state: "busy", viewport: [1280, 720], apply: [] }, boxes).radii).toEqual({ card: [0, 0, 4, 0] });
  });

  it("tells a corner sample in the edge band of a round shape (scaled class: deltaE2000RoundEdge) from one away from it", () => {
    // a focused button at 1600×900: radius 5 device px, the focus border 2.5 device px; its 4 px corner sample's window
    // reaches the border's inner curve (radius 2.5 about (5, 5)): in the band
    const box = { x: 40, y: 40, w: 100, h: 40 };
    const corner = ringPoints(box, box, [2.5, 2.5, 2.5, 2.5], ["corner"], [5, 5, 5, 5]).find((p) => p.where === "top-left corner, 4 px in")!;
    expect(cornerInRoundBand(corner, box, box, [2.5, 2.5, 2.5, 2.5], [5, 5, 5, 5])).toBe(true);
    // square corners have no band; a deeper sample of a large radius lies well inside its curves
    expect(cornerInRoundBand(corner, box, box, [2.5, 2.5, 2.5, 2.5], undefined)).toBe(false);
    const deep = ringPoints(box, box, undefined, ["corner"], [8, 8, 8, 8]).find((p) => p.where === "top-left corner, 11 px in")!;
    expect(cornerInRoundBand(deep, box, box, undefined, [8, 8, 8, 8])).toBe(false);
    // an edge sample never takes the corner's limit
    const edge = ringPoints(box, box, [2.5, 2.5, 2.5, 2.5], ["edge"], [5, 5, 5, 5])[0];
    expect(cornerInRoundBand(edge, box, box, [2.5, 2.5, 2.5, 2.5], [5, 5, 5, 5])).toBe(false);
  });

  it("gives a corner sample deltaE2000RoundEdge only with evidence: three or more matching window pixels outside the band", () => {
    // a text-carrying button, radius r, border bw, painted by Chromium from 40.75 (scale 0.25: 163 CSS px) and by UI
    // Toolkit from 40; near the top-left corner each renderer paints the pixels within ROUND_EDGE_BAND of its own curves
    // in its own ramp colour (the scaled class's ramps differ), and Unity also the pixels outside the band where asked
    const fillC: Rgb = [60, 120, 180], rampG: Rgb = [96, 146, 196], rampU: Rgb = [72, 128, 184], off: Rgb = [70, 128, 190], bg: Rgb = [16, 24, 32];
    const run = (bw: number, r: number, outsideToo: boolean, t: Thresholds) => {
      const border = [bw, bw, bw, bw] as [number, number, number, number], radii = [r, r, r, r] as [number, number, number, number];
      const boxes = (x: number): CaptureBoxes => ({
        capture: "c", viewport: [320, 200], scale: 0.25, external: [],
        elements: { root: el(0, 0, 320, 200), btn: el(x, x, 100, 40, { text: true, lines: [{ x: 100, y: 52, w: 30, h: 16, baseline: 64 }] }) },
      });
      const draw = () => glyphs(fill(canvas(320, 200, bg), { x: 40, y: 40, w: 101, h: 41 }, fillC), { x: 102, y: 54, w: 26, h: 12 }, [250, 250, 250]);
      const golden = { png: draw(), boxes: boxes(40.75) }, unity = { png: draw(), boxes: boxes(40) };
      const g = { x: 40.75, y: 40.75, w: 100, h: 40 }, u = { x: 40, y: 40, w: 100, h: 40 };
      for (let y = 37; y < 52; y++) for (let x = 37; x < 52; x++) {
        if (nearCurve(g, border, radii, x, y, 1)) fill(golden.png, { x, y, w: 1, h: 1 }, rampG);
        if (nearCurve(u, border, radii, x, y, 1)) fill(unity.png, { x, y, w: 1, h: 1 }, rampU);
        else if (outsideToo && !nearCurve(g, border, radii, x, y, 1)) fill(unity.png, { x, y, w: 1, h: 1 }, off);
      }
      const ctx: CaptureContext = { borders: { btn: border }, radii: { btn: radii }, backgrounds: new Set(["btn"]), painters: new Set(["btn"]), order: ["root", "btn"], root: "root" };
      const v = compareCapture(golden, unity, [], t, ctx);
      return { edge: v.elements.find((e) => e.id === "btn")!.edge!, issues: v.issues.filter((i) => i.kind === "edge") };
    };
    const scaled: Thresholds = { ...T, ssimRoundEdge: 0.95, deltaE2000RoundEdge: 5.5 };
    // border 2, radius 5: the 4 px corner window keeps pixels outside the band; they match, the rest is the ramp
    const confined = run(2, 5, false, scaled);
    expect(confined.edge).toBeGreaterThan(1);
    expect(confined.issues).toEqual([]);
    expect(run(2, 5, false, T).issues).toEqual([expect.objectContaining({ id: "btn", detail: expect.stringMatching(/top-left corner, 4 px in: .*\(limit 1\)/) })]);
    // the same corner where the pixels outside the band differ too (at every offset): not the ramp, held to deltaE2000
    expect(run(2, 5, true, scaled).issues).toEqual([expect.objectContaining({ id: "btn", detail: expect.stringMatching(/top-left corner, \d+ px in: .*\(limit 1/) })]);
    // a border under 2 device px has no centre pixel to show its colour (ruling R130): no evidence, held to deltaE2000
    expect(run(1.5, 5, false, scaled).issues).toEqual([expect.objectContaining({ id: "btn",
      detail: expect.stringMatching(/top-left corner, 4 px in: .*\(limit 1; the corner limits of edge bands need the evidence: the border of btn \(a side under 2 device px/) })]);
    // border 2.5, radius 6: the window keeps at most 2 pixels outside the band at any offset, too few to show where its
    // difference lies: held to deltaE2000
    const thin = run(2.5, 6, false, scaled);
    expect(thin.edge).toBeGreaterThan(1);
    expect(thin.issues).toEqual([expect.objectContaining({ id: "btn", detail: expect.stringMatching(/top-left corner, 4 px in: .*\(limit 1\)/) })]);
  });

  it("keeps ring samples off a rounded corner's anti-aliased curve", () => {
    const pill = { x: 10, y: 10, w: 110, h: 56 };
    const plain = ringPoints(pill, pill, undefined, ["edge", "corner"]);
    const round = ringPoints(pill, pill, undefined, ["edge", "corner"], [28, 28, 28, 28]);
    // the right edge at 25 %: 3 px in sits on the curve (3.75 px in at 14 px from the end), so it moves 2 px past it
    const at = (pts: RingPoint[], where: string) => pts.find((p) => p.where === where)!;
    expect(at(plain, "inside the right edge at 25%").gx).toBe(119 - 3);
    expect(at(round, "inside the right edge at 25%").gx).toBe(119 - 6);
    // the top edge at 25 % (27.5 px from the end) is past the curve: unchanged
    expect(at(round, "inside the top edge at 25%").gy).toBe(at(plain, "inside the top edge at 25%").gy);
    // on the diagonal the curve of radius 28 crosses 8.2 px in: the 7 px corner samples go, the others stay
    expect(round.filter((p) => p.kind === "corner").map((p) => p.where)).not.toContain("top-left corner, 7 px in");
    expect(round.filter((p) => p.kind === "corner").map((p) => p.where)).toContain("top-left corner, 2 px in");
    expect(round.filter((p) => p.kind === "corner").map((p) => p.where)).toContain("top-left corner, 11 px in");
    // a square corner keeps every sample
    expect(plain.filter((p) => p.where.startsWith("top-left corner")).length).toBe(5);
  });

  it("tells the colour grid which points sit on a rounded corner's curve, outer or inside a border", () => {
    const radio = { x: 64, y: 284, w: 32, h: 32 };
    // a checked radio: 10 px border, radius 16, so the inner dot has radius 6 around (80, 300)
    expect(nearCurve(radio, [10, 10, 10, 10], [16, 16, 16, 16], 79, 294)).toBe(true);
    expect(nearCurve(radio, [10, 10, 10, 10], [16, 16, 16, 16], 79, 299)).toBe(false);
    expect(nearCurve(radio, [10, 10, 10, 10], [16, 16, 16, 16], 70, 290)).toBe(false);
    // the outer curve; square corners have none
    expect(nearCurve(radio, undefined, [16, 16, 16, 16], 68, 289)).toBe(true);
    expect(nearCurve(radio, undefined, undefined, 64, 284)).toBe(false);
    expect(nearCurve(radio, undefined, [0, 0, 0, 0], 64, 284)).toBe(false);
  });

  it("samples a background colour only where the design is flat", () => {
    const img = { w: 20, h: 10, data: new Uint8Array(20 * 10 * 4) } as Rgba;
    for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) {
      const o = (y * 20 + x) * 4, dark = x === 10;
      img.data.set(dark ? [6, 23, 28, 255] : [242, 181, 68, 255], o);
    }
    expect(flatAt(img, 4, 5)).toBe(true);
    expect(flatAt(img, 7, 5)).toBe(true); // 3 px from the line: the 5×5 window stops short of it
    expect(flatAt(img, 8, 5)).toBe(false);
    expect(flatAt(img, 12, 5)).toBe(false);
  });

  it("knows which elements paint a background in the capture", () => {
    expect([...captureContext(ix, { state: "default", viewport: [1280, 720], apply: [] }, boxes).backgrounds!].sort()).toEqual(["btn", "root"]);
    expect([...captureContext(ix, { state: "busy", viewport: [1280, 720], apply: [] }, boxes).backgrounds!].sort()).toEqual(["btn", "card", "root"]);
  });

  it("gives each text element its font size in device px, from the layer that holds", () => {
    const text = indexIr({ ...ir, root: { ...ir.root, children: [
      { id: "t", kind: "text", style: { base: { "font-size": "16px" }, "state:busy": { "font-size": "24px" } }, text: { tr: "a" }, children: [] },
      { id: "box", kind: "container", style: { base: { "font-size": "16px" } }, children: [] },
    ] } });
    const tb: CaptureBoxes = { ...boxes, elements: { root: el(0, 0, 1280, 720), t: el(10, 10, 50, 10, { text: true }), box: el(0, 40, 50, 10) } };
    expect(captureContext(text, { state: "default", viewport: [1280, 720], apply: [] }, tb).fontPx).toEqual({ t: 8 });
    expect(captureContext(text, { state: "busy", viewport: [1280, 720], apply: [] }, tb).fontPx).toEqual({ t: 12 });
  });
});

// ---- screen: export and Unity folders on disk -------------------------------------------------------------------

interface Fixture { exportDir: string; unityDir: string; names: string[] }
const job = (state: string, viewport: [number, number], anim: CaptureJob["anim"] = null): CaptureJob => ({ state, viewport, pseudo: null, apply: [], coverage: null, anim });

/** An export folder with three captures (default, busy, one animation sample pair) and a Unity folder with the given ones. */
function screenFixture(unity: (name: string, s: ReturnType<typeof scene>) => ReturnType<typeof scene> | null): Fixture {
  const root = tmp(), exportDir = path.join(root, "export"), unityDir = path.join(root, "unity");
  fs.mkdirSync(path.join(exportDir, "goldens"), { recursive: true });
  fs.mkdirSync(unityDir, { recursive: true });
  const animRef = [{ elementId: "panel", index: 0 }];
  const entries = [
    { name: "default@320x192", ...job("default", [320, 192]) },
    { name: "busy@320x192", ...job("busy", [320, 192]) },
    { name: "default@320x192.anim.panel.1", ...job("default", [320, 192], { sampled: animRef, runs: animRef, from: null, sample: 1, time: 150 }) },
    { name: "default@320x192.anim.panel.0", ...job("default", [320, 192], { sampled: animRef, runs: animRef, from: null, sample: 0, time: 0 }) },
  ];
  const gBoxes: Record<string, CaptureBoxes> = {}, uBoxes: Record<string, CaptureBoxes> = {};
  for (const e of entries) {
    const s = scene(e.name);
    gBoxes[e.name] = s.boxes;
    fs.writeFileSync(path.join(exportDir, "goldens", `${e.name}.png`), encodePng(s.png));
    const us = unity(e.name, scene(e.name));
    if (us) { uBoxes[e.name] = us.boxes; fs.writeFileSync(path.join(unityDir, `${e.name}.png`), encodePng(us.png)); }
  }
  fs.writeFileSync(path.join(exportDir, "goldens", "boxes.json"), JSON.stringify(gBoxes));
  fs.writeFileSync(path.join(exportDir, "goldens", "matrix.json"), JSON.stringify({ chromium: "158.0.8127.18", platform: "darwin-arm64", captures: entries, unsampled: [] }));
  fs.writeFileSync(path.join(exportDir, "export-report.json"), JSON.stringify({ ok: true, screen: "inbox", timings: { load: 50, lint: 120, extract: 80, bake: 0, capture: 400, write: 10 }, totalMs: 700 }));
  fs.writeFileSync(path.join(unityDir, "boxes.json"), JSON.stringify(uBoxes));
  fs.writeFileSync(path.join(unityDir, "capture-done.json"), JSON.stringify({ runId: "r1", jobs: entries.length, captured: Object.keys(uBoxes).length, notCaptured: 0 }));
  return { exportDir, unityDir, names: entries.map((e) => e.name) };
}

describe("compareScreen", () => {
  it("passes when every golden capture has an identical Unity capture, and writes difference images", async () => {
    // busy: 2×2 px off by 2 levels (within every threshold), so it passes and has a difference image
    const f = screenFixture((name, s) => (name === "busy@320x192" ? { ...s, png: fill(s.png, { x: 100, y: 150, w: 2, h: 2 }, [16, 24, 40]) } : s));
    const diffDir = path.join(tmp(), "diff");
    const v = await compareScreen(f.exportDir, f.unityDir, T, { diffDir, timings: { capture: 900 } });
    expect(v).toMatchObject({ screen: "inbox", pass: true, notRun: [], extra: [] });
    expect(v.captures.map((c) => c.capture)).toEqual(f.names);
    expect(v.timings).toMatchObject({ lint: 120, export: 700, capture: 900 });
    expect(v.timings.compare).toBeGreaterThanOrEqual(0);
    expect(v.platform).toEqual({ chromium: "158.0.8127.18", platform: "darwin-arm64" });
    expect(v.captures[0].diff).toBeNull();
    expect(v.captures[1].pixelsOff).toBeGreaterThan(4 / (320 * 192));
    expect(v.captures[1].pixelsOff).toBeLessThan(5 / (320 * 192));
    const diff = decodePng(fs.readFileSync(v.captures[1].diff!));
    expect([diff.w, diff.h]).toEqual([320, 192]);
    expect(Array.from(diff.data.subarray((150 * 320 + 100) * 4, (150 * 320 + 100) * 4 + 4))).toEqual([255, 202, 0, 195]);
    expect(diff.data[(10 * 320 + 10) * 4 + 3]).toBe(0);
    expect(v.captures[1].info).toMatchObject({ state: "busy", viewport: [320, 192], anim: null });
    expect(v.animations).toEqual([{ element: "panel", sampled: ["panel"], viewport: [320, 192], frames: [
      { capture: "default@320x192.anim.panel.0", time: 0 }, { capture: "default@320x192.anim.panel.1", time: 150 },
    ] }]);
  });

  it("reports each capture's viewport class and the captures per class (an IR without scaledViewports: all exact)", async () => {
    const f = screenFixture((name, s) => (name === "busy@320x192" ? null : s));
    const exact = await compareScreen(f.exportDir, f.unityDir, T);
    expect(exact.byClass).toEqual({ exact: { viewports: [[320, 192]], pass: 3, fail: 0, notRun: 1 } });
    expect(exact.captures[0].info?.viewportClass).toBe("exact");
    expect(classLines(exact)).toEqual(["exact 320×192: 3 pass, 0 fail, 1 not run"]);
    const ir = { irVersion: 1, screen: "inbox", referenceViewport: [320, 192], viewports: [[320, 192]], scaledViewports: [[320, 192]], screenMatch: 0.5, breakpoints: [],
      root: { id: "root", kind: "container", style: { base: {} }, children: [
        { id: "card", kind: "container", style: { base: {} }, children: [{ id: "label", kind: "text", style: { base: {} }, children: [] }] },
        { id: "panel", kind: "container", style: { base: {} }, children: [] }] } };
    fs.writeFileSync(path.join(f.exportDir, "screen.ir.json"), JSON.stringify(ir));
    const scaled = await compareScreen(f.exportDir, f.unityDir, { ...T, scaled: { ssimElement: 0.98 } });
    expect(scaled.byClass).toEqual({ scaled: { viewports: [[320, 192]], pass: 3, fail: 0, notRun: 1 } });
    expect(scaled.captures.map((c) => c.info?.viewportClass)).toEqual(["scaled", "scaled", "scaled"]);
    expect(classLines(scaled)).toEqual(["scaled 320×192: 3 pass, 0 fail, 1 not run"]);
  });

  it("marks a golden capture without a Unity capture as not run and the screen as not passing; extra Unity captures are only listed", async () => {
    const f = screenFixture((name, s) => (name === "busy@320x192" ? null : s));
    fs.writeFileSync(path.join(f.unityDir, "stray@320x192.png"), encodePng(canvas(4, 4, [0, 0, 0])));
    const v = await compareScreen(f.exportDir, f.unityDir, T);
    expect(v.notRun).toEqual(["busy@320x192"]);
    expect(v.notRunReasons["busy@320x192"]).toBe("no Unity capture PNG");
    expect(v.extra).toEqual(["stray@320x192"]);
    expect(v.captures.every((c) => c.pass)).toBe(true);
    expect(v.pass).toBe(false);
  });

  it("lists the design's hidden jobs and calls a screen with any of them incomplete, never a pass", async () => {
    const f = screenFixture((_, s) => s);
    const all = await compareScreen(f.exportDir, f.unityDir, T);
    expect(all).toMatchObject({ pass: true, status: "pass", hidden: [] });
    const mf = path.join(f.exportDir, "goldens", "matrix.json");
    const m = JSON.parse(fs.readFileSync(mf, "utf8"));
    m.hidden = [{ name: "default@320x192.hover.ghost", reason: "ghost not visible in this setup or in any context its layers give (tried none)" }];
    fs.writeFileSync(mf, JSON.stringify(m));
    const v = await compareScreen(f.exportDir, f.unityDir, T);
    expect(v.captures.every((c) => c.pass)).toBe(true);
    expect(v).toMatchObject({ pass: false, status: "incomplete", hidden: ["default@320x192.hover.ghost"] });
    expect(v.hiddenReasons["default@320x192.hover.ghost"]).toMatch(/not visible/);
    expect(summarizeIssues(v)).toContain("default@320x192.hover.ghost: hidden in the design, not compared (ghost not visible in this setup or in any context its layers give (tried none))");
    // a failing capture still makes it a fail
    const bad = screenFixture((name, s) => (name === "busy@320x192" ? { ...s, png: fill(s.png, { x: 0, y: 0, w: 320, h: 192 }, [255, 0, 0]) } : s));
    fs.writeFileSync(path.join(bad.exportDir, "goldens", "matrix.json"), JSON.stringify(m));
    expect(await compareScreen(bad.exportDir, bad.unityDir, T)).toMatchObject({ pass: false, status: "fail" });
    // a capture Unity did not make fails the screen, as before
    const missing = screenFixture((name, s) => (name === "busy@320x192" ? null : s));
    fs.writeFileSync(path.join(missing.exportDir, "goldens", "matrix.json"), JSON.stringify(m));
    expect(await compareScreen(missing.exportDir, missing.unityDir, T)).toMatchObject({ pass: false, status: "fail" });
  });

  it("does not run anything when the Unity folder is empty", async () => {
    const f = screenFixture(() => null);
    fs.rmSync(path.join(f.unityDir, "boxes.json"));
    const v = await compareScreen(f.exportDir, f.unityDir, T);
    expect(v.notRun).toEqual(f.names);
    expect(v).toMatchObject({ pass: false, captures: [] });
  });

  it("treats a Unity folder without capture-done.json as not captured", async () => {
    const f = screenFixture((_, s) => s);
    fs.rmSync(path.join(f.unityDir, "capture-done.json"));
    const v = await compareScreen(f.exportDir, f.unityDir, T);
    expect(v.notRun).toEqual(f.names);
    for (const n of f.names) expect(v.notRunReasons[n]).toBe("Unity capture did not finish");
    expect(v).toMatchObject({ pass: false, captures: [], extra: [] });
  });

  it("reports the not-captured reasons of boxes.meta.json as not run", async () => {
    const f = screenFixture((name, s) => (name === "busy@320x192" ? null : s));
    fs.writeFileSync(path.join(f.unityDir, "boxes.meta.json"), JSON.stringify({ status: "done", notCaptured: [{ capture: "busy@320x192", reason: "animation player not available" }] }));
    const v = await compareScreen(f.exportDir, f.unityDir, T);
    expect(v.notRun).toEqual(["busy@320x192"]);
    expect(v.notRunReasons["busy@320x192"]).toBe("animation player not available");
    expect(summarizeIssues(v)).toContain("busy@320x192: not run (animation player not available)");
    expect(v.pass).toBe(false);
  });

  it("reports the colour space and path the Unity capture rendered with, and warns for a linear on-screen panel", async () => {
    const f = screenFixture((_, s) => s);
    const meta = (unity: Record<string, string>) => fs.writeFileSync(path.join(f.unityDir, "boxes.meta.json"), JSON.stringify({ status: "complete", notCaptured: [], unity }));
    meta({ colorSpace: "Linear", colorPath: "gamma-composite" });
    let v = await compareScreen(f.exportDir, f.unityDir, T);
    expect(v.colour).toEqual({ space: "Linear", path: "gamma-composite" });
    expect(v.warnings.filter((w) => /colour/.test(w))).toEqual([]);
    expect(v.pass).toBe(true);
    meta({ colorSpace: "Linear", colorPath: "linear-panel" });
    v = await compareScreen(f.exportDir, f.unityDir, T);
    expect(v.colour).toEqual({ space: "Linear", path: "linear-panel" });
    expect(v.warnings.filter((w) => /colour/.test(w))).toEqual([expect.stringMatching(/^Linear colour space, colour path Linear Panel: .*DesignUiGammaComposite/)]);
    meta({ colorSpace: "Gamma", colorPath: "linear-panel" });
    v = await compareScreen(f.exportDir, f.unityDir, T);
    expect(v.colour).toEqual({ space: "Gamma", path: "linear-panel" });
    expect(v.warnings.filter((w) => /colour/.test(w))).toEqual([]);
    // the gamma composite in a Linear project whose scenes and prefabs do not have it: the game will not show these colours
    meta({ colorSpace: "Linear", colorPath: "gamma-composite", gammaCompositeInProject: false } as unknown as Record<string, string>);
    v = await compareScreen(f.exportDir, f.unityDir, T);
    expect(v.warnings.filter((w) => /colour/.test(w))).toEqual([expect.stringMatching(/^Linear colour space, captured through the gamma composite, but no scene or prefab of the project has DesignUiGammaComposite/)]);
    meta({ colorSpace: "Linear", colorPath: "gamma-composite", gammaCompositeInProject: true } as unknown as Record<string, string>);
    expect((await compareScreen(f.exportDir, f.unityDir, T)).warnings.filter((w) => /colour/.test(w))).toEqual([]);
    // a Gamma project records its own path: nothing to warn about
    meta({ colorSpace: "Gamma", colorPath: "gamma-project" });
    expect((await compareScreen(f.exportDir, f.unityDir, T)).colour).toEqual({ space: "Gamma", path: "gamma-project" });
    // a capture of an earlier package writes no colour path: the gamma composite it always rendered with
    meta({ colorSpace: "Linear" });
    expect((await compareScreen(f.exportDir, f.unityDir, T)).colour).toEqual({ space: "Linear", path: "gamma-composite" });
    fs.rmSync(path.join(f.unityDir, "boxes.meta.json"));
    expect((await compareScreen(f.exportDir, f.unityDir, T)).colour).toBeNull();
  });

  it("reads the compiler-removed elements from the generated manifest in the Unity folder", async () => {
    const f = screenFixture((_, s) => s);
    const gb = JSON.parse(fs.readFileSync(path.join(f.exportDir, "goldens", "boxes.json"), "utf8"));
    for (const n of f.names) gb[n].elements.wrapper = el(32, 32, 128, 96);
    fs.writeFileSync(path.join(f.exportDir, "goldens", "boxes.json"), JSON.stringify(gb));
    expect((await compareScreen(f.exportDir, f.unityDir, T)).pass).toBe(false);
    fs.writeFileSync(path.join(f.unityDir, ".design-ui.json"), JSON.stringify({ removedElements: ["wrapper"] }));
    const v = await compareScreen(f.exportDir, f.unityDir, T);
    expect(v).toMatchObject({ pass: true, removed: ["wrapper"] });
  });

  it("rejects an invalid Unity boxes.json instead of guessing", async () => {
    const f = screenFixture((_, s) => s);
    fs.writeFileSync(path.join(f.unityDir, "boxes.json"), JSON.stringify({ "default@320x192": { capture: "x" } }));
    await expect(compareScreen(f.exportDir, f.unityDir, T)).rejects.toThrow(/Unity boxes\.json .*default@320x192 is invalid/);
  });

  it("refuses capture names that could leave the folders", async () => {
    const f = screenFixture((_, s) => s);
    const gb = JSON.parse(fs.readFileSync(path.join(f.exportDir, "goldens", "boxes.json"), "utf8"));
    gb["../evil"] = gb["default@320x192"];
    fs.writeFileSync(path.join(f.exportDir, "goldens", "boxes.json"), JSON.stringify(gb));
    await expect(compareScreen(f.exportDir, f.unityDir, T)).rejects.toThrow(/invalid capture name "\.\.\/evil"/);
  });

  it("warns, visibly, when the IR is missing", async () => {
    const f = screenFixture((_, s) => s);
    const v = await compareScreen(f.exportDir, f.unityDir, T);
    expect(v.warnings).toEqual([expect.stringMatching(/^screen\.ir\.json not found: shadow bands, paint order, background and border checks were skipped/)]);
  });

  it("uses the IR's shadows (scaled) and backgrounds", async () => {
    const f = screenFixture((name, s) => s);
    const ir = { irVersion: 1, screen: "inbox", referenceViewport: [320, 192], screenMatch: 0.5, breakpoints: [], root: {
      id: "root", kind: "container", style: { base: { "background-color": "#101820" } }, children: [
        { id: "card", kind: "container", style: { base: { "background-color": "#b43c3c" } }, shadow: { offset: { x: -6, y: -6, w: 12, h: 12 } }, children: [
          { id: "label", kind: "text", style: { base: {} }, children: [] }] },
        { id: "panel", kind: "container", style: { base: { "background-color": "#2878c8" } }, children: [] },
      ] } };
    fs.writeFileSync(path.join(f.exportDir, "screen.ir.json"), JSON.stringify(ir));
    // the design has a shadow ring around the card; Unity does not
    for (const n of f.names) {
      const file = path.join(f.exportDir, "goldens", `${n}.png`);
      const png = decodePng(fs.readFileSync(file));
      fill(png, { x: 26, y: 26, w: 140, h: 6 }, [8, 12, 16]);
      fs.writeFileSync(file, encodePng(png));
    }
    const v = await compareScreen(f.exportDir, f.unityDir, T);
    expect(v.notes).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.captures[0].issues.filter((i) => i.id === "card").map((i) => i.kind)).toContain("shadow");
  });
});

describe("writeReport and writeVerdict", () => {
  it("lists the viewport classes and the measured scaled-class limits it applies", async () => {
    const f = screenFixture((_, s) => s);
    const out = tmp(), report = path.join(out, "report.html");
    const v = await compareScreen(f.exportDir, f.unityDir, { ...T, scaled: { ssimElement: 0.985 } });
    writeReport(v, f.exportDir, f.unityDir, report);
    const html = fs.readFileSync(report, "utf8");
    expect(html).toContain("<h2>Viewport classes</h2>");
    expect(html).toContain("<code>scaled: ssimElement</code></th><td class=\"num\">0.985</td>");
    // without a scaled block nothing is listed for it
    writeReport(await compareScreen(f.exportDir, f.unityDir, T), f.exportDir, f.unityDir, report);
    expect(fs.readFileSync(report, "utf8")).not.toContain("scaled: ");
  });

  it("with kept pictures shows thumbnails and an issue crop of each failing capture only, and works without the captures", async () => {
    const f = screenFixture((name, s) => {
      if (name === "busy@320x192") s.boxes.elements.panel.x += 3;
      return s;
    });
    const out = tmp(), report = path.join(out, "report.html"), pics = path.join(out, ".pics");
    const v = await compareScreen(f.exportDir, f.unityDir, T, { diffDir: path.join(out, "diff") });
    const kept = await writeReportPictures(v, f.exportDir, f.unityDir, pics);
    expect([...kept.keys()]).toEqual(["busy@320x192"]);
    const busy = kept.get("busy@320x192")!;
    expect(busy.crops.map((c) => c.detail)).toEqual([expect.stringMatching(/^panel: .*Δx \+3\.00/)]);
    writeReport(v, f.exportDir, f.unityDir, report, kept);
    // the captures and difference images go: every picture the report shows is one it kept
    fs.rmSync(f.unityDir, { recursive: true });
    fs.rmSync(path.join(out, "diff"), { recursive: true, force: true });
    const html = fs.readFileSync(report, "utf8");
    const srcs = Array.from(html.matchAll(/src="([^"]+)"/g)).map((m) => decodeURIComponent(m[1]));
    const files = [busy.design, busy.unity, busy.diff, ...busy.crops.flatMap((c) => [c.design, c.unity, c.diff])].filter((x): x is string => !!x).map((x) => path.relative(out, x));
    expect(new Set(srcs)).toEqual(new Set(files));
    for (const s of srcs) {
      expect(s.startsWith(".pics/"), s).toBe(true);
      expect(fs.existsSync(path.resolve(out, s)), s).toBe(true);
    }
    expect(html).toMatch(/Passed: its pictures are not kept/);
    expect(html).not.toMatch(/Images are linked, not embedded/);
    // the crop is the issue's place with a margin, at full resolution
    const crop = await decodePngAsync(fs.readFileSync(busy.crops[0].unity));
    expect(crop.w).toBeLessThanOrEqual(640);
    expect(crop.w).toBeGreaterThan(96);
  });

  it("writes one self-contained HTML naming every capture, FAIL for failing ones, with relative image paths", async () => {
    const f = screenFixture((name, s) => {
      if (name === "busy@320x192") s.boxes.elements.panel.x += 3;
      return name === "default@320x192.anim.panel.1" ? null : s;
    });
    const out = tmp(), report = path.join(out, "report.html"), diffDir = path.join(out, ".report", "diff");
    const v = await compareScreen(f.exportDir, f.unityDir, T, { diffDir });
    writeReport(v, f.exportDir, f.unityDir, report);
    const html = fs.readFileSync(report, "utf8");
    for (const n of f.names) expect(html).toContain(n);
    expect(html).toContain("FAIL");
    expect(html).toContain("PASS");
    expect(html).toContain("NOT RUN");
    expect(html).toMatch(/prefers-color-scheme: dark/);
    expect(html).toContain("Δx +3.00");
    // images: relative paths only, next to the report
    const srcs = Array.from(html.matchAll(/src="([^"]+)"/g)).map((m) => m[1]);
    expect(srcs.length).toBeGreaterThan(0);
    for (const s of srcs) {
      expect(s.startsWith("/") || /^[a-z]+:/i.test(s)).toBe(false);
      expect(fs.existsSync(path.resolve(out, decodeURIComponent(s)))).toBe(true);
    }
    // no external resources; it says the images are linked next to it, the effective tolerance and the warning
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)=/i);
    expect(html).toMatch(/Images are linked, not embedded/);
    expect(html).toMatch(/offset by up to 1 px/);
    expect(html).toMatch(/class="warning"[^>]*>[\s\S]*screen\.ir\.json not found/);
    expect(html).toContain("textInkRatio");
    expect(html).toContain("lint");
    expect(html).toContain("ssimElement");

    const vf = path.join(out, ".report", "verdict.json");
    writeVerdict(v, vf);
    expect(JSON.parse(fs.readFileSync(vf, "utf8"))).toMatchObject({ screen: "inbox", pass: false, notRun: ["default@320x192.anim.panel.1"] });
  });

  it("escapes text from the design and the captures", async () => {
    const f = screenFixture((_, s) => s);
    const v = await compareScreen(f.exportDir, f.unityDir, T);
    v.screen = "<img src=x onerror=alert(1)>";
    v.captures[0].issues.push({ id: "a<b", kind: "box", detail: "<script>alert(1)</script>" });
    const report = path.join(tmp(), "r.html");
    writeReport(v, f.exportDir, f.unityDir, report);
    const html = fs.readFileSync(report, "utf8");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("design-export compare", () => {
  const io = () => { const o = { out: "", err: "" }; return { o, io: { out: (s: string) => { o.out += s; }, err: (s: string) => { o.err += s; } } }; };

  it("exits 0 on a pass and writes the report and verdict.json next to it", async () => {
    const f = screenFixture((_, s) => s);
    const out = tmp(), report = path.join(out, "report.html");
    const { o, io: cli } = io();
    expect(await runCli(["compare", f.exportDir, "--unity", f.unityDir, "--report", report], cli)).toBe(0);
    expect(fs.existsSync(report)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(out, "verdict.json"), "utf8")).pass).toBe(true);
    // identical captures: no difference images
    expect(fs.readdirSync(path.join(out, "report-diff"))).toEqual([]);
    expect(o.out).toMatch(/^PASS inbox: 4\/4 captures pass/m);
    expect(o.out).toMatch(/^warning: screen\.ir\.json not found/m);
  });

  it("exits 1 when a capture fails or is not run, 2 on usage errors", async () => {
    const f = screenFixture((name, s) => (name === "busy@320x192" ? null : s));
    const report = path.join(tmp(), "r.html");
    const { o, io: cli } = io();
    expect(await runCli(["compare", f.exportDir, "--unity", f.unityDir, "--report", report], cli)).toBe(1);
    expect(o.out).toMatch(/^FAIL inbox: 3\/4 captures pass/m);
    expect(o.out).toContain("not run: busy@320x192");
    // every capture passes, but the design hides a job in every context: incomplete
    const g = screenFixture((_, s) => s);
    const mf = path.join(g.exportDir, "goldens", "matrix.json");
    fs.writeFileSync(mf, JSON.stringify({ ...JSON.parse(fs.readFileSync(mf, "utf8")), hidden: [{ name: "default@320x192.hover.ghost", reason: "not visible" }] }));
    const h = io();
    expect(await runCli(["compare", g.exportDir, "--unity", g.unityDir, "--report", report], h.io)).toBe(1);
    expect(h.o.out).toMatch(/^INCOMPLETE inbox: 4\/5 captures pass/m);
    expect(h.o.out).toContain("hidden in the design (not compared): default@320x192.hover.ghost");
    expect(fs.readFileSync(report, "utf8")).toContain("INCOMPLETE");
    expect(await runCli(["compare", f.exportDir, "--report", report], io().io)).toBe(2);
    expect(await runCli(["compare", path.join(tmp(), "nothing"), "--unity", f.unityDir, "--report", report], io().io)).toBe(2);
  });

  it("reads the thresholds from fidelity-thresholds.json", () => {
    // measured with smoothing-off goldens (docs/findings/text-ink.md) plus the documented margins
    expect(readThresholds()).toEqual({
      ...T, textInkDeltaE: 2, textInkRatio: 1, textInkCoverage: 0.1, textInkFullPx: 9, textInkDeltaESmall: [[8, 3], [0, 10]], textInkMedianTolerance: 0.15,
      ssimElementSmall: [[32768, 0.984]], ssimPicture: 0.985, textInkDeltaELater: [[9, 4.5], [8, 6]], textInkLaterBelowPx: 12, textInkCoverageLater: 0.15,
      textInkSmallPx: 12, textInkDeltaEFirstSmall: 4.5, textInkBandSmall: [0.8, 1.25], textInkMedianToleranceSmall: 0.25, textInkShadowHigh: 1.15,
      ssimRotated: ROTATED,
      // edge bands (docs/findings/viewport-classes.md): ssimRoundEdge at every viewport (R119); the round-edge corner limit and
      // the scaled class's own keys (R121) off at exact viewports, measured at scaled ones
      ssimRoundEdge: 0.974, deltaE2000RoundEdge: 1, deltaE2000Ring: 3.1, ssimFractionalEdge: 0.99, ssimVectorEdge: 0.99, deltaE2000FractionalEdge: 1,
      ssimResampledPicture: 0.99, deltaE2000ResampledPicture: 1,
      // the scaled class: R109, R115, R121, and R125 (resampled pictures), R126 (small text ink, at most 6.5)
      scaled: { ssimRoundEdge: 0.974, deltaE2000RoundEdge: 5.5, textInkSmallPx: 12.99, ssimFractionalEdge: 0.97, ssimVectorEdge: 0.975, deltaE2000FractionalEdge: 5.3,
        ssimResampledPicture: 0.95, deltaE2000ResampledPicture: 5.89, textInkDeltaEFirstSmall: 5.89 },
    });
    const bad = path.join(tmp(), "t.json");
    fs.writeFileSync(bad, JSON.stringify({ boxPx: 1 }));
    expect(() => readThresholds(bad)).toThrow(/"baselinePx" must be a number/);
    const table = (v: unknown) => { fs.writeFileSync(bad, JSON.stringify({ ...T, textInkDeltaESmall: v })); return () => readThresholds(bad); };
    expect(table([[9, 10], [12, 5], [0, 14]])).toThrow(/"textInkDeltaESmall" must be \[device px, ΔE2000\] pairs from the largest size down to 0/);
    expect(table([[12, 5], [9, 10]])).toThrow(/textInkDeltaESmall/);
    expect(table("5")).toThrow(/textInkDeltaESmall/);
    expect(table([[16, 5], [0, 14]])).toThrow(/must start below textInkFullPx/);
    expect(table([[12, 2], [0, 14]])).toThrow(/limits of at least textInkDeltaE/);
    const small = (o: object) => { fs.writeFileSync(bad, JSON.stringify({ ...T, ...o })); return () => readThresholds(bad); };
    expect(small({ textInkBandSmall: [0.9, 1.2] })).toThrow(/"textInkBandSmall" must be \[lowest, highest\]/);
    expect(small({ textInkBandSmall: [0.6, 1.1] })).toThrow(/"textInkBandSmall"/);
    expect(small({ textInkMedianToleranceSmall: 0.1 })).toThrow(/"textInkMedianToleranceSmall" must be at least textInkMedianTolerance/);
    expect(small({ textInkDeltaEFirstSmall: 1 })).toThrow(/"textInkDeltaEFirstSmall" must be at least textInkDeltaE/);
    expect(small({ textInkShadowHigh: 1.1 })).toThrow(/"textInkShadowHigh" must be at least 1 \+ textInkCoverage/);
    const areas = (v: unknown, picture = 0.98) => { fs.writeFileSync(bad, JSON.stringify({ ...T, ssimElementSmall: v, ssimPicture: picture })); return () => readThresholds(bad); };
    expect(areas([[1024, 0.975], [4096, 0.985]])()).toMatchObject({ ssimElementSmall: [[1024, 0.975], [4096, 0.985]], ssimPicture: 0.98 });
    expect(areas([[4096, 0.985], [1024, 0.975]])).toThrow(/"ssimElementSmall" must be \[area in device px², SSIM\] pairs by growing area and limit/);
    expect(areas([[1024, 0.98], [4096, 0.975]])).toThrow(/by growing area and limit/);
    expect(areas([[1024, 0.96]])).toThrow(/must lie between 0.97 and ssimElement/);
    expect(areas([], 0.95)).toThrow(/must lie between 0.97 and ssimElement/);
    expect(areas([[1024, 0.995]])).toThrow(/must lie between 0.97 and ssimElement/);
    expect(small({ ssimRotated: 0.96 })).toThrow(/"ssimRotated" must lie between 0.97 and ssimElement/);
    expect(small({ ssimRotated: 0.995 })).toThrow(/"ssimRotated" must lie between 0.97 and ssimElement/);
    // the round-edge limits are off in the file's own values (they apply at exact viewports): only "scaled" may hold measured ones
    // ssimRoundEdge applies at every viewport (ruling R119), never below the floor; the scaled class's own keys stay off here
    expect(small({ ssimRoundEdge: 0.974 })()).toMatchObject({ ssimRoundEdge: 0.974 });
    expect(small({ ssimRoundEdge: 0.96 })).toThrow(/"ssimRoundEdge" must lie between 0\.97 and 1/);
    for (const k of ["ssimFractionalEdge", "ssimVectorEdge"])
      expect(small({ [k]: 0.98 })).toThrow(new RegExp(`"${k}" must lie between ssimElement and 1 \\(off\\): only "scaled" may lower it`));
    expect(small({ deltaE2000FractionalEdge: 5 })).toThrow(/"deltaE2000FractionalEdge" must equal deltaE2000 \(off\): only "scaled" may raise it/);
    expect(small({ deltaE2000RoundEdge: 2 })).toThrow(/"deltaE2000RoundEdge" must equal deltaE2000 \(off\): only "scaled" may raise it/);
    expect(small({ scaled: { ssimRoundEdge: 0.96 } })).toThrow(/\(scaled\): "ssimRoundEdge" must lie between 0.97 and 1/);
    expect(small({ scaled: { deltaE2000RoundEdge: 0.5 } })).toThrow(/\(scaled\): "deltaE2000RoundEdge" must be at least deltaE2000/);
    // R125: the resampled-picture keys are off in the file's own values; the scaled block's SSIM floor is 0.95
    expect(small({ ssimResampledPicture: 0.95 })).toThrow(/"ssimResampledPicture" must lie between ssimElement and 1 \(off\): only "scaled" may lower it/);
    expect(small({ deltaE2000ResampledPicture: 5 })).toThrow(/"deltaE2000ResampledPicture" must equal deltaE2000 \(off\)/);
    expect(small({ scaled: { ssimResampledPicture: 0.95, deltaE2000ResampledPicture: 5.89 } })()).toMatchObject({ scaled: { ssimResampledPicture: 0.95, deltaE2000ResampledPicture: 5.89 } });
    expect(small({ scaled: { ssimResampledPicture: 0.94 } })).toThrow(/\(scaled\): "ssimResampledPicture" must lie between 0\.95 and 1/);
    // R126: the scaled class's small-text ink limit, at most 6.5; R130: the scaled block cannot change the ring limit
    expect(small({ scaled: { textInkDeltaEFirstSmall: 6.6 } })).toThrow(/\(scaled\): "textInkDeltaEFirstSmall" may not exceed 6\.5/);
    expect(small({ scaled: { deltaE2000Ring: 5.5 } })).toThrow(/"scaled" cannot change "deltaE2000Ring"/);
    expect(small({ scaled: { ssimRoundEdge: 0.975, deltaE2000RoundEdge: 4 } })()).toMatchObject({ ssimRoundEdge: 0.99, deltaE2000RoundEdge: 1, scaled: { ssimRoundEdge: 0.975, deltaE2000RoundEdge: 4 } });
    expect(small({ deltaE2000Ring: 0.5 })).toThrow(/"deltaE2000Ring" must be at least deltaE2000/);
  });
});
