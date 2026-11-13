import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, type Rgba } from "../src/bake/png.js";
import type { CaptureBoxes } from "../src/boxes/types.js";
import type { CaptureJob } from "../src/capture/matrix.js";
import { deltaE2000, deltaE2000Lab, isTransparentColor } from "../src/compare/color.js";
import { compareCapture, compareScreen, readThresholds, summarizeIssues, WHOLE, type CaptureContext, type Thresholds } from "../src/compare/compare.js";
import { captureContext, indexIr } from "../src/compare/context.js";
import { flatAt, nearCurve, ringPoints, type RingPoint } from "../src/compare/samples.js";
import { decodePngAsync, encodePng } from "../src/compare/png.js";
import { writeReport, writeVerdict } from "../src/compare/report.js";
import { blockSsimMap, maskRects, regionSsim, ssimMasked, unionRect } from "../src/compare/ssim.js";
import { runCli } from "../src/commands.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const T: Thresholds = {
  boxPx: 1, baselinePx: 1, deltaE2000: 1, ssimNonText: 0.99, ssimElement: 0.99, textInkDeltaE: 3, textInkRatio: 0.76, textInkCoverage: 0.15,
  textInkFullPx: 14, textInkDeltaESmall: [[12, 5], [9, 10], [0, 14]], textInkMedianTolerance: 0.2, ssimElementSmall: [], ssimPicture: 0.99,
  textInkDeltaELater: [], textInkLaterBelowPx: 12, textInkCoverageLater: 0.15,
  textInkSmallPx: 0, textInkDeltaEFirstSmall: 3, textInkBandSmall: [0.6, 1.2], textInkMedianToleranceSmall: 0.2,
};
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
    const spikeOut = path.resolve(here, "../../../spike/out");
    const files = [path.join(here, "fixtures", "lint", "assets", "logo.png"),
      ...["chromium/f11-gradients/chromium.png", "unity-gamma/f13-hover-active/unity.png"].map((f) => path.join(spikeOut, f))].filter((f) => fs.existsSync(f));
    expect(files.length).toBeGreaterThan(0);
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

describe("compareCapture: fix round checks", () => {
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
    expect(big.issues[0].detail).toMatch(/\(limit ±15 %\)/);
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
  });

  it("knows which elements draw a raster picture at another size than its own", () => {
    const pic = indexIr({ ...ir, root: { ...ir.root, children: [
      { id: "photo", kind: "image", style: { base: {} }, asset: { kind: "image", width: 320, height: 180 }, children: [] },
      { id: "natural", kind: "image", style: { base: {} }, asset: { kind: "image", width: 160, height: 90 }, children: [] },
      { id: "icon", kind: "vector", style: { base: {} }, asset: { kind: "svg", width: 24, height: 24 }, children: [] },
    ] } });
    const b: CaptureBoxes = { ...boxes, elements: { root: el(0, 0, 1280, 720), photo: el(0, 0, 100, 180), natural: el(200, 0, 160, 90), icon: el(400, 0, 12, 12) } };
    const ctx = captureContext(pic, { state: "default", viewport: [1280, 720], apply: [] }, b);
    expect([...ctx.pictures!].sort()).toEqual(["photo"]);
  });

  it("knows each element's corner radii in device px in the capture", () => {
    expect(captureContext(ix, { state: "default", viewport: [1280, 720], apply: [] }, boxes).radii).toEqual({ card: [8, 0, 4, 0] });
    expect(captureContext(ix, { state: "busy", viewport: [1280, 720], apply: [] }, boxes).radii).toEqual({ card: [0, 0, 4, 0] });
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
    expect(o.out).toMatch(/^FAIL inbox/m);
    expect(o.out).toContain("not run: busy@320x192");
    expect(await runCli(["compare", f.exportDir, "--report", report], io().io)).toBe(2);
    expect(await runCli(["compare", path.join(tmp(), "nothing"), "--unity", f.unityDir, "--report", report], io().io)).toBe(2);
  });

  it("reads the thresholds from fidelity-thresholds.json", () => {
    // measured with smoothing-off goldens (docs/findings/text-ink.md) plus the documented margins
    expect(readThresholds()).toEqual({
      ...T, textInkDeltaE: 2, textInkRatio: 1, textInkCoverage: 0.1, textInkFullPx: 9, textInkDeltaESmall: [[8, 3], [0, 10]], textInkMedianTolerance: 0.15,
      ssimElementSmall: [[32768, 0.984]], ssimPicture: 0.985, textInkDeltaELater: [[9, 4.5], [8, 6]], textInkLaterBelowPx: 12, textInkCoverageLater: 0.15,
      textInkSmallPx: 12, textInkDeltaEFirstSmall: 4.5, textInkBandSmall: [0.8, 1.25], textInkMedianToleranceSmall: 0.25,
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
    const areas = (v: unknown, picture = 0.98) => { fs.writeFileSync(bad, JSON.stringify({ ...T, ssimElementSmall: v, ssimPicture: picture })); return () => readThresholds(bad); };
    expect(areas([[1024, 0.975], [4096, 0.985]])()).toMatchObject({ ssimElementSmall: [[1024, 0.975], [4096, 0.985]], ssimPicture: 0.98 });
    expect(areas([[4096, 0.985], [1024, 0.975]])).toThrow(/"ssimElementSmall" must be \[area in device px², SSIM\] pairs by growing area and limit/);
    expect(areas([[1024, 0.98], [4096, 0.975]])).toThrow(/by growing area and limit/);
    expect(areas([[1024, 0.96]])).toThrow(/must lie between 0.97 and ssimElement/);
    expect(areas([], 0.95)).toThrow(/must lie between 0.97 and ssimElement/);
    expect(areas([[1024, 0.995]])).toThrow(/must lie between 0.97 and ssimElement/);
  });
});

// ---- the M0 reference computation (spike/m0-metrics.ts), on the spike's own captures when they are present ------

const spikeOut = path.resolve(here, "../../../spike/out");
const haveSpike = fs.existsSync(path.join(spikeOut, "m0-metrics", "summary.json")) && fs.existsSync(path.join(spikeOut, "unity-gamma"));

describe.skipIf(!haveSpike)("M0 reference numbers (spike/out, git-ignored)", () => {
  type SpikeEl = { id: string; x: number; y: number; w: number; h: number; text?: { lines?: { x: number; y: number; w: number; h: number; baseline?: number }[]; baseline?: number } };
  const toBoxes = (name: string, els: SpikeEl[]): CaptureBoxes => ({
    capture: name, viewport: [2560, 1440], scale: 1, external: [],
    elements: Object.fromEntries(els.map((e) => [e.id, el(e.x, e.y, e.w, e.h, {
      text: !!e.text, lines: (e.text?.lines ?? []).map((l) => ({ x: l.x, y: l.y, w: l.w, h: l.h, baseline: l.baseline ?? e.text!.baseline ?? l.y })),
    })])),
  });
  /** Shadow rects from the fixture CSS, as spike/m0-metrics.ts derives them. */
  const shadowRects = (html: string, els: SpikeEl[]) => {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const m of html.matchAll(/#([\w-]+)\s*\{[^}]*box-shadow:\s*(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)(?:px)?(?:\s+(-?[\d.]+)px)?/g)) {
      const e = els.find((x) => x.id === m[1]);
      if (!e) continue;
      const grow = +m[4] + (m[5] ? +m[5] : 0);
      out[e.id] = { x: e.x + +m[2] - grow, y: e.y + +m[3] - grow, w: e.w + 2 * grow, h: e.h + 2 * grow };
    }
    return out;
  };
  const summary = haveSpike ? JSON.parse(fs.readFileSync(path.join(spikeOut, "m0-metrics", "summary.json"), "utf8")) : { fixtures: {} };
  const fixtures = Object.keys(summary.fixtures).sort();

  it.each(fixtures)("%s: whole-capture and per-element SSIM equal the reference", (fx) => {
    const cB = JSON.parse(fs.readFileSync(path.join(spikeOut, "chromium", fx, "chromium-boxes.json"), "utf8"));
    const uB = JSON.parse(fs.readFileSync(path.join(spikeOut, "unity-gamma", fx, "unity-boxes.json"), "utf8"));
    const g = { png: decodePng(fs.readFileSync(path.join(spikeOut, "chromium", fx, "chromium.png"))), boxes: toBoxes(fx, cB.elements) };
    const u = { png: decodePng(fs.readFileSync(path.join(spikeOut, "unity-gamma", fx, "unity.png"))), boxes: toBoxes(fx, uB.elements) };
    const html = fs.readFileSync(path.resolve(here, "../../../spike/fixtures", `${fx}.html`), "utf8");
    const ctx: CaptureContext = { root: "root", shadows: shadowRects(html, cB.elements), backgrounds: new Set() };
    const v = compareCapture(g, u, [], { ...T, boxPx: 1e9, baselinePx: 1e9 }, ctx);
    const ref = summary.fixtures[fx];
    expect(+v.ssim!.toFixed(6)).toBe(ref.wholeCopyMask);
    // the reference measures non-text elements; text-carrying elements are measured with their lines copied (not in M0)
    const mine = Object.fromEntries(v.elements.filter((r) => r.ssim !== null && !g.boxes.elements[r.id].text).map((r) => [r.id, +r.ssim!.toFixed(5)]));
    expect(mine).toEqual(Object.fromEntries(ref.elements.map((r: { id: string; withShadow: number }) => [r.id, r.withShadow])));
    // the 1-px offsets never rescue a real defect: M0's failing elements still fail (missing shadows, pill as ellipse, dashed as solid)
    const failing = v.issues.filter((i) => i.kind === "ssim").map((i) => i.id).sort();
    const known: Record<string, string[]> = { "f12-box-shadow": ["f12-glow", "f12-grid", "f12-hard", "f12-radius"], "f14-radius-border": ["f14-dashed", "f14-pill"] };
    if (known[fx]) expect(failing).toEqual(known[fx]);
  });
});
