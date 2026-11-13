import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, type Rgba } from "../src/bake/png.js";
import type { CaptureBoxes } from "../src/boxes/types.js";
import type { CaptureJob } from "../src/capture/matrix.js";
import { deltaE2000, deltaE2000Lab, isTransparentColor } from "../src/compare/color.js";
import { compareCapture, compareScreen, readThresholds, WHOLE, type CaptureContext, type Thresholds } from "../src/compare/compare.js";
import { captureContext, indexIr } from "../src/compare/context.js";
import { decodePngAsync, encodePng } from "../src/compare/png.js";
import { writeReport, writeVerdict } from "../src/compare/report.js";
import { blockSsimMap, maskRects, regionSsim, ssimMasked, unionRect } from "../src/compare/ssim.js";
import { runCli } from "../src/commands.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const T: Thresholds = { boxPx: 1, baselinePx: 1, deltaE2000: 1, ssimNonText: 0.99, ssimElement: 0.99 };
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
    expect(v.issues.map((i) => `${i.id}:${i.kind}`)).toEqual(["btn:color"]);
    // a text element's box is copied from the design before SSIM (the pinned definition): no element SSIM for it
    expect(v.elements.find((r) => r.id === "btn")!.ssim).toBeNull();
  });

  it("masks text glyphs and external regions from SSIM and colour", () => {
    const g = scene(), u = scene();
    glyphs(u.png, { x: 51, y: 52, w: 80, h: 12 }, [250, 250, 250]);
    expect(compareCapture(g, u, [], T)).toMatchObject({ pass: true, ssim: 1 });

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

describe("IR context", () => {
  const ir = {
    irVersion: 1, screen: "s", referenceViewport: [2560, 1440], viewports: [[2560, 1440]], screenMatch: 0.5, states: ["default", "busy"],
    breakpoints: [{ name: "narrow", maxWidth: 1000 }],
    root: {
      id: "root", kind: "container", style: { base: { "background-color": "rgb(10, 10, 10)" } }, children: [
        {
          id: "card", kind: "container", style: { base: { "background-color": "rgba(0, 0, 0, 0)" }, "state:busy": { "background-color": "#334455" } },
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

  it("knows which elements paint a background in the capture", () => {
    expect([...captureContext(ix, { state: "default", viewport: [1280, 720], apply: [] }, boxes).backgrounds!].sort()).toEqual(["btn", "root"]);
    expect([...captureContext(ix, { state: "busy", viewport: [1280, 720], apply: [] }, boxes).backgrounds!].sort()).toEqual(["btn", "card", "root"]);
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
    // no external resources
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)=/i);
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
    expect(readThresholds()).toEqual({ boxPx: 1, baselinePx: 1, deltaE2000: 1, ssimNonText: 0.99, ssimElement: 0.99 });
    const bad = path.join(tmp(), "t.json");
    fs.writeFileSync(bad, JSON.stringify({ boxPx: 1 }));
    expect(() => readThresholds(bad)).toThrow(/"baselinePx" must be a number/);
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
    const mine = Object.fromEntries(v.elements.filter((r) => r.ssim !== null).map((r) => [r.id, +r.ssim!.toFixed(5)]));
    expect(mine).toEqual(Object.fromEntries(ref.elements.map((r: { id: string; withShadow: number }) => [r.id, r.withShadow])));
  });
});
