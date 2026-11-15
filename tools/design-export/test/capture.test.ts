import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { readKit, type KitConfig } from "../src/kit.js";
import { launchChromium } from "../src/browser.js";
import { openDesign } from "../src/load.js";
import { collectSnapshot } from "../src/lint/index.js";
import { buildIr, type IrBuild } from "../src/extract/tree.js";
import type { IrAnim, IrNode, IrScreen } from "../src/ir/types.js";
import { validateBoxes } from "../src/boxes/validate.js";
import type { CaptureBoxes } from "../src/boxes/types.js";
import { breakpointsHold, scaleStep, buildMatrix, captureName, sampleTimes, unsampledAnims, type CaptureJob } from "../src/capture/matrix.js";
import { CaptureSession, captureMatrix, runCapture, TEXT_CEIL_TOLERANCE, type ElementMap } from "../src/capture/capture.js";
import { logicalViewport } from "../src/viewport.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => path.join(here, "fixtures", "capture", n);
const kit: KitConfig = readKit(path.join(here, "fixtures", "extract", "kit"));

const tmpDirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "capture-")); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// ---- synthetic IR -----------------------------------------------------------------------------------------------
const node = (id: string, o: Partial<IrNode> = {}): IrNode => ({
  id, kind: "container", external: false, classes: [], style: { base: { display: "flex" } }, text: null, asset: null, background: null,
  shadow: null, shadowLayers: {}, insetShadow: null, insetShadowLayers: {}, backgroundLayers: {}, attrTexts: {}, initial: null, bind: null, action: null, repeat: null, anims: [], children: [], ...o,
});
const screen = (root: IrNode, o: Partial<IrScreen> = {}): IrScreen => ({
  irVersion: 1, screen: "s", source: { path: "s.html", sha256: "0".repeat(64) }, referenceViewport: [2560, 1440],
  viewports: [[2560, 1440], [1920, 1080], [1280, 720]], screenMatch: 0.5, states: ["default"], breakpoints: [], tokens: {}, fonts: [],
  root, ...o,
});
const anim = (o: Partial<IrAnim>): IrAnim => ({
  kind: "transition", trigger: "hover", phase: "enter", name: null, properties: ["opacity"], duration: 200, delay: 0, timing: "linear",
  iterations: 1, direction: "normal", fillMode: "none", playState: "running", restart: true, keyframes: [], ...o,
});
const layers = (...keys: string[]) => Object.fromEntries([["base", { display: "flex" }], ...keys.map((k) => [k, { opacity: "0.5" }])]);
const names = (jobs: CaptureJob[]) => jobs.map(captureName);

describe("the text-width tolerance", () => {
  it("is the same in the exporter (pageTextCeil) and the runtime (DesignTextFit.Tolerance)", () => {
    // the golden ceils a text-sized box's text forgiving it, and DesignTextFit ceils Unity's text the same way: two
    // literals, one value
    const cs = fs.readFileSync(path.join(here, "../../../packages/com.ertugrulgaziakcan.design-ui/Runtime/DesignTextFit.cs"), "utf8");
    const m = /public const float Tolerance = ([0-9.]+)f;/.exec(cs);
    expect(m, "DesignTextFit.Tolerance").not.toBeNull();
    expect(Number(m![1])).toBe(TEXT_CEIL_TOLERANCE);
  });
});

describe("buildMatrix", () => {
  it("states × viewports, plus one job per hover element per viewport", () => {
    const ir = screen(node("root", { children: [node("open-btn", { style: layers("hover") })] }), { states: ["default", "loading"] });
    const jobs = buildMatrix(ir);
    expect(jobs).toHaveLength(9);
    expect(names(jobs)).toEqual([
      "default@2560x1440", "loading@2560x1440", "default@2560x1440.hover.open-btn",
      "default@1920x1080", "loading@1920x1080", "default@1920x1080.hover.open-btn",
      "default@1280x720", "loading@1280x720", "default@1280x720.hover.open-btn",
    ]);
    expect(jobs[2]).toEqual({
      state: "default", viewport: [2560, 1440], pseudo: { kind: "hover", elementId: "open-btn" },
      apply: [{ kind: "pseudo", pseudo: "hover", elementId: "open-btn" }], coverage: null, anim: null,
    });
    expect(jobs[0].pseudo).toBeNull();
  });

  it("names captures as spec §7 and §11 say", () => {
    const j = (o: Partial<CaptureJob>): CaptureJob => ({ state: "default", viewport: [2560, 1440], pseudo: null, apply: [], coverage: null, anim: null, ...o });
    expect(captureName(j({}))).toBe("default@2560x1440");
    expect(captureName(j({ viewport: [1920, 1080], pseudo: { kind: "hover", elementId: "open-btn" }, apply: [{ kind: "pseudo", pseudo: "hover", elementId: "open-btn" }] })))
      .toBe("default@1920x1080.hover.open-btn");
    expect(captureName(j({ state: "loading", anim: { sampled: [{ elementId: "spin", index: 0 }], runs: [], from: null, sample: 3, time: 500 } })))
      .toBe("loading@2560x1440.anim.spin.3");
  });

  it("covers every layer key: own and ancestor pseudo-states, classes, state compounds, unions", () => {
    const ir = screen(node("root", { children: [
      node("card", { style: layers("hover", "class:is-open"), children: [
        node("title", { style: layers("anc(card):hover", "anc(card):class:is-open", "anc(card):hover+hover") }),
      ] }),
      node("btn", { style: layers("hover", "active", "active+hover", "focus", "state:loading+hover", "state:loading") }),
      node("tab", { style: layers("class:is-selected", "class:is-selected+hover") }),
      node("inp", { style: layers("disabled", "checked") }),
    ] }), { states: ["default", "loading"], viewports: [[2560, 1440]] });
    const jobs = buildMatrix(ir);
    expect(names(jobs)).toEqual([
      "default@2560x1440", "loading@2560x1440",
      "default@2560x1440.active.btn",
      "default@2560x1440.checked.inp",
      "default@2560x1440.disabled.inp",
      "default@2560x1440.focus.btn",
      "default@2560x1440.hover.btn",
      "default@2560x1440.hover.card",            // card's own hover and title's anc(card):hover: one capture
      "default@2560x1440.hover.tab.is-selected.tab",
      "default@2560x1440.hover.title",           // anc(card):hover+hover: hovering title hovers card too
      "default@2560x1440.is-open.card",          // class:is-open and anc(card):class:is-open: one capture
      "default@2560x1440.is-selected.tab",
      "loading@2560x1440.hover.btn",             // state:loading+hover; state:loading alone is the loading baseline
    ]);
    const byName = new Map(jobs.map((j) => [captureName(j), j]));
    expect(byName.get("default@2560x1440.hover.tab.is-selected.tab")!.pseudo).toBeNull();
    expect(byName.get("default@2560x1440.hover.tab.is-selected.tab")!.apply).toEqual([
      { kind: "pseudo", pseudo: "hover", elementId: "tab" }, { kind: "class", name: "is-selected", elementId: "tab" },
    ]);
    expect(byName.get("default@2560x1440.is-open.card")!.apply).toEqual([{ kind: "class", name: "is-open", elementId: "card" }]);
    expect(byName.get("loading@2560x1440.hover.btn")!.state).toBe("loading");
  });

  it("skips unions a disabled control cannot reach: focus or a press on the disabled element itself", () => {
    const ir = screen(node("root", { children: [
      node("btn", { style: layers("disabled", "focus", "active", "disabled+focus", "active+disabled", "disabled+hover") }),
      node("card", { style: layers("hover"), children: [node("inp", { style: layers("disabled", "anc(card):hover+disabled") })] }),
    ] }), { viewports: [[2560, 1440]] });
    expect(names(buildMatrix(ir))).toEqual([
      "default@2560x1440",
      "default@2560x1440.active.btn",
      "default@2560x1440.disabled.btn",
      "default@2560x1440.disabled.btn.hover.btn", // a pointer still hovers a disabled control
      "default@2560x1440.disabled.inp",
      "default@2560x1440.focus.btn",
      "default@2560x1440.hover.card",
      "default@2560x1440.hover.card.disabled.inp",
    ]);
  });

  it("a control its markup disables is never focused or pressed either (a pointer still hovers it)", () => {
    const ir = screen(node("root", { children: [
      node("next", { initial: { disabled: true, checked: false }, style: layers("focus", "active", "hover", "disabled") }),
      node("prev", { initial: { disabled: false, checked: false }, style: layers("focus", "active") }),
    ] }), { viewports: [[2560, 1440]] });
    expect(names(buildMatrix(ir))).toEqual([
      "default@2560x1440",
      "default@2560x1440.active.prev",
      "default@2560x1440.disabled.next",
      "default@2560x1440.focus.prev",
      "default@2560x1440.hover.next",
    ]);
  });

  it("adds a viewport just inside a breakpoint no declared viewport reaches, and marks it", () => {
    const ir = screen(node("root", { children: [node("x", { style: layers("bp:max-width-1919", "bp:max-width-1919+hover", "bp:wide+hover") })] }), {
      breakpoints: [{ name: "max-width-1919", maxWidth: 1919 }, { name: "wide", minWidth: 2000 }],
    });
    const jobs = buildMatrix(ir);
    const extra = jobs.filter((j) => j.coverage);
    expect(names(extra).map((n) => n.replace(/@\d+x\d+/, "@V"))).toEqual(["default@V", "default@V.hover.x"]);
    const vp = extra[0].viewport;
    expect(extra.every((j) => j.viewport[0] === vp[0] && j.viewport[1] === vp[1] && j.coverage!.join() === "max-width-1919")).toBe(true);
    expect([[2560, 1440], [1920, 1080], [1280, 720]]).not.toContainEqual(vp);
    expect(breakpointsHold([{ name: "max-width-1919", maxWidth: 1919 }], vp, ir)).toBe(true);
    // a declared height, and a panel scale on the declared scales' step (0.25), so the design's lengths stay whole device px:
    // 640×1080 renders at 0.5 (1280×2160 logical px), where 853×1080 would be 0.5417
    expect([1440, 1080, 720]).toContain(vp[1]);
    expect(vp).toEqual([640, 1080]);
    expect(logicalViewport(vp, [2560, 1440], 0.5)).toEqual({ width: 1280, height: 2160, scale: 0.5 });
    expect(scaleStep({ referenceViewport: [2560, 1440], screenMatch: 0.5 }, [[2560, 1440], [1920, 1080], [1280, 720]])).toBe(0.25);
    // a breakpoint the declared viewports reach needs no extra viewport
    expect(names(jobs.filter((j) => !j.coverage && j.apply.length))).toEqual(["default@2560x1440.hover.x", "default@1920x1080.hover.x", "default@1280x720.hover.x"]);
    expect(jobs.filter((j) => !j.coverage).every((j) => j.coverage === null)).toBe(true);
  });

  it("refuses a breakpoint no viewport can reach", () => {
    // match 0 scales by width only: the logical width is always 2560
    const ir = screen(node("root", { children: [node("x", { style: layers("bp:narrow") })] }), { screenMatch: 0, breakpoints: [{ name: "narrow", maxWidth: 1919 }] });
    expect(() => buildMatrix(ir)).toThrow(/x: layer bp:narrow: no viewport activates breakpoint\(s\) narrow/);
  });

  it("samples every animation at delay + {0, ¼, ½, ¾, 1} × duration (and 0 within a delay)", () => {
    expect(sampleTimes({ delay: 0, duration: 200 })).toEqual([0, 50, 100, 150, 200]);
    expect(sampleTimes({ delay: 50, duration: 200 })).toEqual([0, 50, 100, 150, 200, 250]);
    expect(sampleTimes({ delay: -100, duration: 400 })).toEqual([0, 100, 200, 300]);
  });

  it("one series per change, with every animation the change starts on the same clock", () => {
    const colour = (o: Partial<IrAnim>) => anim({ properties: ["color"], ...o });
    const ir = screen(node("root", { children: [
      node("card", { style: layers("hover"), anims: [colour({})], children: [
        node("title", { style: layers("anc(card):hover"), anims: [colour({ trigger: "anc(card):hover" })] }),
      ] }),
      node("btn", { style: layers("hover"), anims: [anim({ delay: 50 }), anim({ phase: "leave", duration: 100 })] }),
      node("box", { style: layers("state:loading"), anims: [anim({ trigger: "state:loading", duration: 400 })] }),
      node("spinner", { style: { base: { display: "none" }, "state:loading": { display: "flex" } },
        anims: [anim({ kind: "keyframes", trigger: "show", name: "spin", iterations: "infinite", duration: 1000 })] }),
      node("k", { anims: [anim({ kind: "keyframes", trigger: "show", name: "pulse", duration: 1000 }), anim({ kind: "keyframes", trigger: "hover", name: "pulse", restart: false, playState: "paused" })] }),
      node("still", { style: layers("class:is-still"), anims: [anim({ kind: "keyframes", trigger: "show", name: "pulse", duration: 1000 }),
        anim({ kind: "keyframes", trigger: "class:is-still", name: null, duration: 0, keyframes: [] })] }),
    ] }), { states: ["default", "loading"], viewports: [[2560, 1440]] });
    const jobs = buildMatrix(ir).filter((j) => j.anim);
    const at = (n: string) => jobs.find((j) => captureName(j) === n)!;
    // card's transition and title's inherited copy start with the same change at the same times: one series
    expect(names(jobs.filter((j) => j.anim!.sampled[0].elementId === "card"))).toEqual([0, 1, 2, 3, 4].map((n) => `default@2560x1440.anim.card.${n}`));
    expect(at("default@2560x1440.anim.card.2").anim).toEqual({
      sampled: [{ elementId: "card", index: 0 }, { elementId: "title", index: 0 }], runs: [{ elementId: "card", index: 0 }, { elementId: "title", index: 0 }],
      from: { state: "default", apply: [] }, sample: 2, time: 100,
    });
    expect(at("default@2560x1440.anim.card.2").apply).toEqual([{ kind: "pseudo", pseudo: "hover", elementId: "card" }]);
    // enter (delay 50) then leave of the same element continue the numbering
    expect(jobs.filter((j) => j.anim!.sampled[0].elementId === "btn").map((j) => [captureName(j), j.anim!.time, j.apply.length, j.anim!.from!.apply.length])).toEqual([
      ["default@2560x1440.anim.btn.0", 0, 1, 0], ["default@2560x1440.anim.btn.1", 50, 1, 0], ["default@2560x1440.anim.btn.2", 100, 1, 0],
      ["default@2560x1440.anim.btn.3", 150, 1, 0], ["default@2560x1440.anim.btn.4", 200, 1, 0], ["default@2560x1440.anim.btn.5", 250, 1, 0],
      ["default@2560x1440.anim.btn.6", 0, 0, 1], ["default@2560x1440.anim.btn.7", 25, 0, 1], ["default@2560x1440.anim.btn.8", 50, 0, 1],
      ["default@2560x1440.anim.btn.9", 75, 0, 1], ["default@2560x1440.anim.btn.10", 100, 0, 1],
    ]);
    // a state trigger changes the state; the hidden spinner's show animation starts with the same change (CSS starts it when it gets a box)
    const box = at("loading@2560x1440.anim.box.4");
    expect([box.state, box.anim!.from, box.anim!.time]).toEqual(["loading", { state: "default", apply: [] }, 400]);
    expect(box.anim!.runs).toEqual([{ elementId: "box", index: 0 }, { elementId: "spinner", index: 0 }]);
    expect(at("loading@2560x1440.anim.spinner.0").anim!.from).toEqual({ state: "default", apply: [] });
    // a show animation of a visible element is sampled from load
    expect(at("default@2560x1440.anim.k.4").anim!.from).toBeNull();
    expect(unsampledAnims(ir)).toEqual([{ elementId: "k", index: 1, reason: expect.stringMatching(/running animation/) },
      { elementId: "still", index: 1, reason: expect.stringMatching(/animation: none/) }]);
    // a layer's animation: none has nothing to sample: its static capture shows the element without the animation
    expect(jobs.some((j) => j.anim!.sampled.some((r) => r.elementId === "still" && r.index === 1))).toBe(false);
  });

  it("refuses unknown states, elements and breakpoints", () => {
    expect(() => buildMatrix(screen(node("root", { children: [node("x", { style: layers("state:nope") })] })))).toThrow(/state nope/);
    expect(() => buildMatrix(screen(node("root", { children: [node("x", { style: layers("anc(ghost):hover") })] })))).toThrow(/ghost/);
    expect(() => buildMatrix(screen(node("root", { children: [node("x", { style: layers("bp:ghost") })] })))).toThrow(/breakpoint ghost/);
  });
});

// ---- captures in Chromium -----------------------------------------------------------------------------------------
function decodePng(buf: Buffer): { w: number; h: number; px: (x: number, y: number) => number[] } {
  let pos = 8, w = 0, h = 0, ctype = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8), d = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ctype = d[9]; } else if (type === "IDAT") idat.push(d);
    pos += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat)), out = new Uint8Array(w * h * 3);
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
    for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = cur[x * bpp + k];
    [prev, cur] = [cur, prev];
  }
  return { w, h, px: (x, y) => Array.from(out.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)) };
}
const near = (got: number[], want: number[], tol = 1) => got.every((v, k) => Math.abs(v - want[k]) <= tol);
/** Centre pixel of an element's box (device px). */
const centre = (png: ReturnType<typeof decodePng>, b: CaptureBoxes, id: string) => {
  const e = b.elements[id];
  return png.px(Math.floor(e.x + e.w / 2), Math.floor(e.y + e.h / 2));
};
const job = (o: Partial<CaptureJob>): CaptureJob => ({ state: "default", viewport: [2560, 1440], pseudo: null, apply: [], coverage: null, anim: null, ...o });

describe("captures", () => {
  let browser: Browser;
  let built: IrBuild;
  beforeAll(async () => {
    // with the pipeline's Chromium flags, which lay out and rasterize the goldens
    browser = await launchChromium();
    const d = await openDesign(fx("screen.html"), kit, [2560, 1440], browser);
    try { built = await buildIr(d, await collectSnapshot(d.page, d.cdp, kit), kit, tmp(), fx("screen.html")); } finally { await d.close(); }
  });
  afterAll(async () => { await browser.close(); });

  const capture = async (j: CaptureJob, dir = tmp()) => {
    const d = await openDesign(fx("screen.html"), kit, j.viewport, browser);
    try {
      const boxes = await runCapture(d, built.ir, j, dir, built.elements);
      const png = fs.readFileSync(path.join(dir, `${captureName(j)}.png`));
      return { boxes, png, dir };
    } finally { await d.close(); }
  };

  it("buildIr exposes the DOM element of every IR id", () => {
    expect(Object.keys(built.elements).sort()).toEqual(["box", "btn", "card", "go", "pulse", "root", "spinner", "tab", "title", "wrap"]);
    expect(built.elements.root).toBe(1);
  });

  it("writes a PNG of exactly W×H device pixels on any display, and boxes in device pixels (§12)", async () => {
    const { boxes, png, dir } = await capture(job({ viewport: [1920, 1080] }));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1920, 1080]);
    expect(validateBoxes(boxes)).toEqual([]);
    expect(boxes.capture).toBe("default@1920x1080");
    expect(boxes.viewport).toEqual([1920, 1080]);
    expect(boxes.scale).toBe(0.75);
    expect(boxes.elements.box).toMatchObject({ x: 0, y: 0, w: 75, h: 30, visible: true, text: false, lines: [] });
    expect(boxes.elements.root).toMatchObject({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(Object.keys(boxes.elements).sort()).toEqual(Object.keys(built.elements).sort());
    expect(JSON.parse(fs.readFileSync(path.join(dir, "boxes.json"), "utf8"))).toEqual({ "default@1920x1080": boxes });
  });

  it("reports hidden elements as not visible, and their state as visible", async () => {
    expect((await capture(job({}))).boxes.elements.spinner).toEqual({ x: 0, y: 0, w: 0, h: 0, visible: false, text: false, lines: [] });
    const loading = (await capture(job({ state: "loading" }))).boxes.elements.spinner;
    expect(loading).toMatchObject({ w: 32, h: 32, visible: true });
  });

  it("records text lines with baselines (findings R7) at every scale", async () => {
    for (const vp of [[2560, 1440], [1280, 720]] as [number, number][]) {
      const s = logicalViewport(vp, [2560, 1440], 0.5).scale;
      const { boxes } = await capture(job({ viewport: vp }));
      const wrap = boxes.elements.wrap;
      expect(wrap.text).toBe(true);
      expect(wrap.lines).toHaveLength(3);
      // Inter at 16px: line pitch 20 (the exact UI Toolkit pitch); the glyph box is the font's rounded ascent + descent
      wrap.lines.forEach((l, k) => {
        expect(l.y - wrap.lines[0].y).toBeCloseTo(20 * k * s, 5);
        if (k === 0) expect(Math.abs(l.y - wrap.y)).toBeLessThanOrEqual(1);
        expect(l.h).toBeGreaterThanOrEqual(20 * s - 1);
        expect(l.h).toBeLessThanOrEqual(20 * s + 1);
        expect(l.baseline - l.y).toBeGreaterThanOrEqual(15 * s);
        expect(l.baseline - l.y).toBeLessThanOrEqual(16 * s + 0.5);
        expect(l.x).toBeCloseTo(wrap.x, 5);
        expect(l.w).toBeLessThanOrEqual(wrap.w + 1e-6);
      });
      expect(boxes.elements.title.lines).toHaveLength(1);
    }
  });

  it("applies pseudo-states, ancestor pseudo-states, classes and states, then leaves the page as it was", async () => {
    const hover = await capture(job({ pseudo: { kind: "hover", elementId: "btn" }, apply: [{ kind: "pseudo", pseudo: "hover", elementId: "btn" }] }));
    expect(near(centre(decodePng(hover.png), hover.boxes, "btn"), [0x16, 0xc2, 0xd5])).toBe(true);
    const focus = await capture(job({ apply: [{ kind: "pseudo", pseudo: "focus", elementId: "go" }] }));
    expect(near(centre(decodePng(focus.png), focus.boxes, "go"), [255, 0, 0])).toBe(true);
    const sel = await capture(job({ apply: [{ kind: "class", name: "is-selected", elementId: "tab" }] }));
    expect(near(centre(decodePng(sel.png), sel.boxes, "tab"), [0x16, 0xc2, 0xd5])).toBe(true);
    const loading = await capture(job({ state: "loading" }));
    expect(near(centre(decodePng(loading.png), loading.boxes, "box"), [255, 0, 255])).toBe(true);
    // active implies hover on the element (a real pointer): opacity 0.5 over the hover colour
    const active = await capture(job({ apply: [{ kind: "pseudo", pseudo: "active", elementId: "btn" }] }));
    expect(near(centre(decodePng(active.png), active.boxes, "btn"), [0x10, 0x71, 0x7e], 2)).toBe(true);

    // the same page, reused: capture with states applied, then the baseline equals a fresh baseline byte for byte
    const dir = tmp();
    const d = await openDesign(fx("screen.html"), kit, [2560, 1440], browser);
    try {
      const html = await d.page.evaluate(() => document.documentElement.outerHTML);
      await runCapture(d, built.ir, job({ state: "loading", apply: [{ kind: "pseudo", pseudo: "hover", elementId: "card" }, { kind: "class", name: "is-selected", elementId: "tab" }] }), dir, built.elements);
      await runCapture(d, built.ir, job({}), dir, built.elements);
      expect(await d.page.evaluate(() => document.documentElement.outerHTML)).toBe(html);
    } finally { await d.close(); }
    const fresh = await capture(job({}));
    expect(fs.readFileSync(path.join(dir, "default@2560x1440.png")).equals(fresh.png)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "boxes.json"), "utf8"))["default@2560x1440"]).toEqual(fresh.boxes);
  });

  it("an ancestor's pseudo-state reaches the descendant's layer", async () => {
    const r = await capture(job({ apply: [{ kind: "pseudo", pseudo: "hover", elementId: "card" }] }));
    const png = decodePng(r.png), t = r.boxes.elements.title;
    // some pixel of the title text is the hover colour
    let found = false;
    for (let y = Math.floor(t.y); y < t.y + t.h && !found; y++) for (let x = Math.floor(t.x); x < t.x + t.w && !found; x++) found = near(png.px(x, y), [0x16, 0xc2, 0xd5], 3);
    expect(found).toBe(true);
  });

  it("samples a transition and a keyframe animation at their times (CDP Animation domain)", async () => {
    const jobs = buildMatrix(built.ir).filter((j) => j.anim && j.viewport[0] === 2560);
    const hoverIn = jobs.find((j) => j.anim!.sampled[0].elementId === "btn" && j.apply.length === 1 && j.anim!.time === 100)!;
    expect(hoverIn.anim!.from).toEqual({ state: "default", apply: [] });
    const r = await capture(hoverIn);
    // linear 200 ms from #123c47 to #16c2d5: half way
    expect(near(centre(decodePng(r.png), r.boxes, "btn"), [20, 127, 142])).toBe(true);
    const hoverOut = jobs.find((j) => j.anim!.sampled[0].elementId === "btn" && j.apply.length === 0 && j.anim!.time === 50)!;
    const o = await capture(hoverOut);
    // leaving: a quarter of the way back
    expect(near(centre(decodePng(o.png), o.boxes, "btn"), [21, 161, 178], 1)).toBe(true);
    const pulse = jobs.find((j) => j.anim!.sampled[0].elementId === "pulse" && j.anim!.time === 500)!;
    expect(pulse.anim!.from).toBeNull();
    const p = await capture(pulse);
    // opacity 1 → 0.2 linear over 1 s: 0.6 at 500 ms, white over #0b1f26
    expect(near(centre(decodePng(p.png), p.boxes, "pulse"), [157, 165, 168], 2)).toBe(true);
    expect(p.boxes.capture).toBe(captureName(pulse));
  });

  it("plays every animation of the change on one clock; a show animation of a hidden element starts with its state", async () => {
    const d0 = await openDesign(fx("clock.html"), kit, [2560, 1440], browser);
    let clock: IrBuild;
    try { clock = await buildIr(d0, await collectSnapshot(d0.page, d0.cdp, kit), kit, tmp(), fx("clock.html")); } finally { await d0.close(); }
    const jobs = buildMatrix(clock.ir).filter((j) => j.anim && j.viewport[0] === 2560);
    const dir = tmp();
    const r = await captureMatrix(fx("clock.html"), kit, clock.ir, clock.elements, dir, { browser, jobs });
    const px = (name: string, id: string) => centre(decodePng(fs.readFileSync(path.join(dir, `${name}.png`))), r.boxes[name], id);
    // card (400 ms) and its dot (100 ms) start with the same hover: at 200 ms the card is half way, the dot has arrived
    const at = (id: string, time: number, enter = true) => captureName(jobs.find((j) => j.anim!.sampled[0].elementId === id && j.anim!.time === time && (j.apply.length > 0) === enter)!);
    expect(near(px(at("card", 200), "card"), [20, 127, 142])).toBe(true);
    expect(px(at("card", 200), "dot")).toEqual([255, 255, 255]);
    expect(near(px(at("dot", 50), "dot"), [128, 128, 128])).toBe(true);
    expect(near(px(at("dot", 50), "card"), [19, 77, 89])).toBe(true);
    // leaving: both run back
    expect(near(px(at("card", 100, false), "card"), [21, 161, 178])).toBe(true);
    // the spinner's animation starts when state busy gives it a box: 0.6 opacity at 500 ms
    const spin = jobs.find((j) => j.anim!.sampled[0].elementId === "spin" && j.anim!.time === 500)!;
    expect([spin.state, spin.anim!.from]).toEqual(["busy", { state: "default", apply: [] }]);
    expect(near(px(captureName(spin), "spin"), [157, 165, 168], 2)).toBe(true);
  });

  it("every series from the page's opening plays its animations, also a later one whose animation has no forwards fill", async () => {
    const d0 = await openDesign(fx("load-series.html"), kit, [2560, 1440], browser);
    let b: IrBuild;
    try { b = await buildIr(d0, await collectSnapshot(d0.page, d0.cdp, kit), kit, tmp(), fx("load-series.html")); } finally { await d0.close(); }
    const jobs = buildMatrix(b.ir).filter((j) => j.viewport[0] === 2560);
    const series = (id: string) => jobs.filter((j) => j.anim && j.anim.sampled[0].elementId === id);
    expect(series("b").map((j) => j.anim!.time)).toEqual([0, 100, 150, 200, 250, 300]);
    const dir = tmp();
    // a's series runs first and ends every animation; b's series (fill none, delay 100 ms) starts again at 0
    const r = await captureMatrix(fx("load-series.html"), kit, b.ir, b.elements, dir, { browser, jobs });
    const x = (j: CaptureJob, id: string) => r.boxes[captureName(j)].elements[id].x;
    const own = x(series("a")[0], "b");
    expect(series("b").map((j) => x(j, "b") - own)).toEqual([0, 0, 50, 100, 150, 0]); // before its delay and after its end: no effect
    expect(series("b").map((j) => x(j, "a") - x(series("a")[0], "a"))).toEqual([0, 50, 75, 100, 125, 150]); // a runs on the same clock
  });

  it("a trigger class the markup already has: the page shows the layer's end, and the trigger still runs off and on", async () => {
    const d0 = await openDesign(fx("initial-trigger.html"), kit, [2560, 1440], browser);
    let b: IrBuild;
    try { b = await buildIr(d0, await collectSnapshot(d0.page, d0.cdp, kit), kit, tmp(), fx("initial-trigger.html")); } finally { await d0.close(); }
    const jobs = buildMatrix(b.ir).filter((j) => j.viewport[0] === 2560);
    const open = { kind: "class", name: "is-open", elementId: "panel" } as const;
    const entering = (j: CaptureJob) => j.apply.some((a) => a.kind === "class" && !a.absent);
    const series = (id: string, enter: boolean) => jobs.filter((j) => j.anim && j.anim.sampled[0].elementId === id && entering(j) === enter);
    // the off side takes the markup's class off; the on side has it
    expect(series("panel", true)[0].anim!.from).toEqual({ state: "default", apply: [{ ...open, absent: true }] });
    expect(series("panel", false)[0].apply).toEqual([{ ...open, absent: true }]);
    expect(series("panel", false)[0].anim!.from).toEqual({ state: "default", apply: [open] });
    expect(series("menu", true)).toHaveLength(5);
    const dir = tmp();
    const r = await captureMatrix(fx("initial-trigger.html"), kit, b.ir, b.elements, dir, { browser, jobs }); // did not start: an error before the fix
    const x = (name: string, id: string) => r.boxes[name].elements[id].x, y = (name: string, id: string) => r.boxes[name].elements[id].y;
    expect(x("default@2560x1440", "panel")).toBe(0); // the static screen: open, nothing running
    expect(series("panel", true).map((j) => x(captureName(j), "panel"))).toEqual([-300, -225, -150, -75, 0]);
    expect(series("panel", false).map((j) => x(captureName(j), "panel"))).toEqual([0, -75, -150, -225, -300]);
    const menuY = y("default@2560x1440", "menu");
    expect(series("menu", true).map((j) => y(captureName(j), "menu") - menuY)).toEqual([-40, -30, -20, -10, 0]);
    // every page is given back with the markup's classes
    const d1 = await openDesign(fx("initial-trigger.html"), kit, [2560, 1440], browser);
    try {
      const s = await CaptureSession.open(d1, b.ir, b.elements, [2560, 1440]);
      for (const j of series("panel", false).slice(0, 2)) await s.capture(j, tmp());
      await s.close();
      expect(await d1.page.evaluate(() => document.querySelector(".panel")!.className)).toBe("panel is-open");
    } finally { await d1.close(); }
  });

  it("records each element's rotation on the screen (own and ancestors' rotate and transform), at animation samples too", async () => {
    const d0 = await openDesign(fx("rotation.html"), kit, [2560, 1440], browser);
    let b: IrBuild;
    try { b = await buildIr(d0, await collectSnapshot(d0.page, d0.cdp, kit), kit, tmp(), fx("rotation.html")); } finally { await d0.close(); }
    const jobs = buildMatrix(b.ir).filter((j) => j.viewport[0] === 2560 && (!j.anim || j.anim.time === 250));
    const dir = tmp();
    const r = await captureMatrix(fx("rotation.html"), kit, b.ir, b.elements, dir, { browser, jobs });
    const still = r.boxes["default@2560x1440"].elements;
    expect(validateBoxes(r.boxes["default@2560x1440"])).toEqual([]);
    expect(still.plain.rotation).toBeUndefined();
    expect(still.tilt.rotation).toBeCloseTo(10, 4);
    expect(still.wrap.rotation).toBeCloseTo(-30, 4);
    expect(still.inner.rotation).toBeCloseTo(-30, 4);
    expect(still.quarter.rotation).toBeCloseTo(90, 4);
    expect(still.spin.rotation).toBeCloseTo(90, 4); // static captures show an animation's end
    const sample = Object.values(r.boxes).find((x) => x.capture.includes(".anim.spin."))!;
    expect(sample.elements.spin.rotation).toBeCloseTo(22.5, 4);
  });

  it("refuses an element map that does not fit the page, and a page at another viewport", async () => {
    const d = await openDesign(fx("screen.html"), kit, [2560, 1440], browser);
    try {
      await expect(runCapture(d, built.ir, job({}), tmp(), { ...built.elements, box: built.elements.btn })).rejects.toThrow(/box.*data-u-id.*btn/);
      await expect(runCapture(d, built.ir, job({ viewport: [1920, 1080] }), tmp(), built.elements)).rejects.toThrow(/viewport/);
    } finally { await d.close(); }
  });

  it("text lines: one per baseline, also with a line height below the ascent; laid-out lines whatever the clipping", async () => {
    const d0 = await openDesign(fx("text.html"), kit, [2560, 1440], browser);
    let text: IrBuild;
    try { text = await buildIr(d0, await collectSnapshot(d0.page, d0.cdp, kit), kit, tmp(), fx("text.html")); } finally { await d0.close(); }
    for (const vp of [[2560, 1440], [1280, 720]] as [number, number][]) {
      const s = logicalViewport(vp, [2560, 1440], 0.5).scale;
      const d = await openDesign(fx("text.html"), kit, vp, browser);
      let b: CaptureBoxes;
      try { b = await runCapture(d, text.ir, job({ viewport: vp }), tmp(), text.elements); } finally { await d.close(); }
      // one word per line at 32px with line-height 0.7, 0.8, 0.9: neighbouring text boxes overlap, still 4 lines one line-height apart
      for (const [id, lh] of [["lh7", 0.7], ["lh8", 0.8], ["lh9", 0.9]] as const) {
        const lines = b.elements[id].lines;
        expect(lines, `${id} at ${vp[0]}`).toHaveLength(4);
        for (let k = 1; k < 4; k++) expect(Math.abs(lines[k].baseline - lines[k - 1].baseline - 32 * lh * s), `${id} ${k}`).toBeLessThan(0.05);
      }
      // a 2-line clamp lays out 3 lines; lines are the laid-out lines (clipping ignored, as Unity's caret route reports them)
      expect(b.elements.clamp.lines).toHaveLength(3);
      // an ellipsis line is one line, with the laid-out width of the whole text
      expect(b.elements.ellipsis.lines).toHaveLength(1);
      expect(b.elements.ellipsis.lines[0].w).toBeGreaterThan(b.elements.ellipsis.w);
      // regular, bold and a larger span share the first line's baseline
      const mixed = b.elements.mixed.lines;
      expect(mixed).toHaveLength(2);
      expect(mixed[0].h).toBeGreaterThan(mixed[1].h);
    }
  });

  describe("controls, ancestor classes and late fonts", () => {
    let ctl: IrBuild;
    beforeAll(async () => {
      const d = await openDesign(fx("controls.html"), kit, [2560, 1440], browser);
      try { ctl = await buildIr(d, await collectSnapshot(d.page, d.cdp, kit), kit, tmp(), fx("controls.html")); } finally { await d.close(); }
    });
    const shoot = async (j: CaptureJob) => {
      const dir = tmp();
      const d = await openDesign(fx("controls.html"), kit, j.viewport, browser);
      try {
        const boxes = await runCapture(d, ctl.ir, j, dir, ctl.elements);
        const after = await d.page.evaluate(() => {
          const q = (s: string) => document.querySelector(s) as HTMLInputElement;
          return [q("[data-u-id=chk]").checked, q("[data-u-id=off]").disabled, q("[data-u-id=card]").className];
        });
        return { boxes, png: decodePng(fs.readFileSync(path.join(dir, `${captureName(j)}.png`))), after };
      } finally { await d.close(); }
    };

    it("captures disabled, checked and an ancestor's is-* class, and gives the controls back", async () => {
      const names = buildMatrix(ctl.ir).filter((j) => j.viewport[0] === 2560).map(captureName);
      expect(names).toEqual(expect.arrayContaining(["default@2560x1440.checked.chk", "default@2560x1440.disabled.off", "default@2560x1440.is-open.card"]));
      const at = (n: string) => buildMatrix(ctl.ir).find((j) => captureName(j) === n)!;
      const chk = await shoot(at("default@2560x1440.checked.chk"));
      expect(near(centre(chk.png, chk.boxes, "chk"), [0x16, 0xc2, 0xd5])).toBe(true);
      const off = await shoot(at("default@2560x1440.disabled.off"));
      expect(near(centre(off.png, off.boxes, "off"), [255, 0, 0])).toBe(true);
      const open = await shoot(at("default@2560x1440.is-open.card"));
      const t = open.boxes.elements.title;
      let red = false;
      for (let y = Math.floor(t.y); y < t.y + t.h && !red; y++) for (let x = Math.floor(t.x); x < t.x + t.w && !red; x++) red = near(open.png.px(x, y), [255, 0, 0], 3);
      expect(red).toBe(true);
      for (const r of [chk, off, open]) expect(r.after).toEqual([false, false, "card"]);
    });

    it("text a state shows in a face loaded only then is measured in that face", async () => {
      const r = await shoot(job({ state: "late" }));
      expect(r.boxes.elements.late.w).toBe(r.boxes.elements.ref.w);
      expect(r.boxes.elements.late.lines.map((l) => l.baseline - l.y)).toEqual(r.boxes.elements.ref.lines.map((l) => l.baseline - l.y));
    });

    it("a failure midway still gives the page back on close: classes, forced states, timeline, global, caller's CDP session", async () => {
      const d = await openDesign(fx("controls.html"), kit, [2560, 1440], browser);
      try {
        const before = await d.page.evaluate(() => [document.documentElement.outerHTML, getComputedStyle(document.querySelector("[data-u-id=off]")!).backgroundColor]);
        const s = await CaptureSession.open(d, ctl.ir, ctl.elements, [2560, 1440]);
        await s.capture(job({ state: "late" }), tmp()); // fills the ascent cache
        // make the second forced pseudo-state fail: the class and the first forced state are applied by then
        const real = (s as unknown as { send: (m: string, p?: object) => Promise<unknown> }).send.bind(s);
        let forced = 0;
        (s as unknown as { send: unknown }).send = (m: string, p?: object) => {
          if (m === "CSS.forcePseudoState" && ++forced === 2) return Promise.reject(new Error("injected failure"));
          return real(m, p);
        };
        const fail = job({ apply: [{ kind: "class", name: "is-open", elementId: "card" }, { kind: "pseudo", pseudo: "active", elementId: "title" }, { kind: "pseudo", pseudo: "checked", elementId: "chk" }] });
        await expect(s.capture(fail, tmp())).rejects.toThrow(/injected failure/);
        await s.close();
        const after = await d.page.evaluate(async () => {
          const a = document.body.animate([{ opacity: 0 }, { opacity: 1 }], 1000);
          await new Promise((r) => setTimeout(r, 60));
          const t = Number(a.currentTime);
          a.cancel();
          return [document.documentElement.outerHTML, getComputedStyle(document.querySelector("[data-u-id=off]")!).backgroundColor,
            (document.querySelector("[data-u-id=chk]") as HTMLInputElement).checked, document.querySelector(":hover, :active") === null,
            "__designUiAscent" in window, t > 0];
        });
        expect(after).toEqual([before[0], before[1], false, true, false, true]);
        // the caller's CDP session keeps working (the capture used its own)
        await expect(d.cdp.send("DOM.getDocument", { depth: 0 })).resolves.toBeTruthy();
      } finally { await d.close(); }
    });
  });

  it("captures an interaction of a hidden element in the context where it shows, and lists one hidden in every context", async () => {
    const d = await openDesign(fx("hidden-contexts.html"), kit, [2560, 1440], browser);
    let b: IrBuild;
    try { b = await buildIr(d, await collectSnapshot(d.page, d.cdp, kit), kit, tmp(), fx("hidden-contexts.html")); } finally { await d.close(); }
    const dir = tmp();
    const jobs = buildMatrix(b.ir).filter((j) => j.viewport[0] === 1280);
    expect(names(jobs)).toEqual(expect.arrayContaining(["default@1280x720.hover.option", "default@1280x720.hover.link", "default@1280x720.hover.drawer-btn",
      "default@1280x720.hover.retry", "default@1280x720.hover.ghost", "default@1280x720.is-selected.option"]));
    const r = await captureMatrix(fx("hidden-contexts.html"), kit, b.ir, b.elements, dir, { browser, jobs });
    const got = names(r.jobs);
    // a closed popup, a collapsed row, a zero-width clipping drawer, a state's content: the context each layer gives
    expect(got).toEqual(expect.arrayContaining([
      "default@1280x720.is-open.menu.hover.option", "default@1280x720.is-open.menu.hover.option.is-selected.option", "default@1280x720.is-open.menu.is-selected.option",
      "default@1280x720.hover.link.is-expanded.row", "default@1280x720.focus.link.is-expanded.row", "default@1280x720.is-open.drawer.hover.drawer-btn",
      "busy@1280x720.hover.retry", "busy@1280x720.focus.retry", "default@1280x720.hover.plain", "default@1280x720.focus.plain",
    ]));
    for (const gone of ["hover.option", "is-selected.option", "hover.link", "focus.link", "hover.drawer-btn", "hover.retry", "focus.retry", "hover.ghost"]) {
      expect(got, gone).not.toContain(`default@1280x720.${gone}`);
    }
    // every element that can be hovered in the design keeps a hover capture; the one no context shows is listed
    for (const id of ["plain", "option", "link", "drawer-btn", "retry"]) expect(got.some((n) => n.includes(`.hover.${id}`)), id).toBe(true);
    const matrix = JSON.parse(fs.readFileSync(path.join(dir, "matrix.json"), "utf8"));
    expect(matrix.captures.map((c: { name: string }) => c.name)).toEqual(got);
    expect(matrix.hidden).toEqual([{ name: "default@1280x720.hover.ghost", reason: expect.stringMatching(/not visible.*in any context/) }]);
    const option = matrix.captures.find((c: { name: string }) => c.name === "default@1280x720.is-open.menu.hover.option");
    expect(option.context).toEqual({ state: "default", apply: [{ kind: "class", name: "is-open", elementId: "menu" }] });
    expect(matrix.captures.find((c: { name: string }) => c.name === "busy@1280x720.hover.retry").context).toEqual({ state: "busy", apply: [] });
    expect(matrix.captures.find((c: { name: string }) => c.name === "default@1280x720.hover.plain").context).toBeUndefined();
    for (const n of ["default@1280x720.is-open.menu.hover.option", "default@1280x720.hover.link.is-expanded.row", "default@1280x720.is-open.drawer.hover.drawer-btn", "busy@1280x720.hover.retry"]) {
      const target = /hover\.([a-z-]+)/.exec(n)![1];
      expect(r.boxes[n].elements[target].visible, n).toBe(true);
      expect(r.boxes[n].elements[target].w, n).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(dir, `${n}.png`))).toBe(true);
    }
    expect(fs.existsSync(path.join(dir, "default@1280x720.hover.ghost.png"))).toBe(false);
    // an element only a later written-out repeat item shows (the first two items' markup hides it): captured in the third
    expect(got).toContain("default@1280x720.hover.more~2");
    expect(got).not.toContain("default@1280x720.hover.more");
    const more = matrix.captures.find((c: { name: string }) => c.name === "default@1280x720.hover.more~2");
    expect(more.context).toEqual({ state: "default", apply: [], item: [2] });
    expect(more.apply).toEqual([{ kind: "pseudo", pseudo: "hover", elementId: "more", item: [2] }]);
    expect(fs.existsSync(path.join(dir, "default@1280x720.hover.more~2.png"))).toBe(true);
  }, 60000);

  it("a failing viewport stops the others and fails the matrix once every page is closed", async () => {
    const all = buildMatrix(built.ir);
    const bad = job({ apply: [{ kind: "pseudo", pseudo: "hover", elementId: "ghost" }] });
    const jobs = [bad, ...all.filter((j) => j.viewport[0] === 1920)];
    const dir = tmp();
    const contextsBefore = browser.contexts().length;
    await expect(captureMatrix(fx("screen.html"), kit, built.ir, built.elements as ElementMap, dir, { browser, jobs, concurrency: 2 })).rejects.toThrow(/ghost/);
    expect(browser.contexts().length).toBe(contextsBefore);
    const files = fs.readdirSync(dir).length;
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.readdirSync(dir).length).toBe(files);
    expect(fs.existsSync(path.join(dir, "boxes.json"))).toBe(false);
  });

  describe("the whole matrix", () => {
    let dirA: string, dirB: string;
    let runA: Awaited<ReturnType<typeof captureMatrix>>;
    beforeAll(async () => {
      dirA = tmp(); dirB = tmp();
      runA = await captureMatrix(fx("screen.html"), kit, built.ir, built.elements, dirA, { browser, concurrency: 1 });
      await captureMatrix(fx("screen.html"), kit, built.ir, built.elements, dirB, { browser, concurrency: 2 });
    }, 120000);

    it("captures every job: exact PNG sizes, boxes for every capture, the job list with sample times", () => {
      const jobs = buildMatrix(built.ir);
      const all = names(jobs);
      const files = fs.readdirSync(dirA).sort();
      expect(files).toEqual([...all.map((n) => `${n}.png`), "boxes.json", "matrix.json"].sort());
      for (const j of jobs) {
        const png = fs.readFileSync(path.join(dirA, `${captureName(j)}.png`));
        expect([png.readUInt32BE(16), png.readUInt32BE(20)], captureName(j)).toEqual(j.viewport);
      }
      const boxes = JSON.parse(fs.readFileSync(path.join(dirA, "boxes.json"), "utf8")) as Record<string, CaptureBoxes>;
      expect(Object.keys(boxes)).toEqual([...all].sort());
      for (const [n, b] of Object.entries(boxes)) expect(validateBoxes(b), n).toEqual([]);
      const matrix = JSON.parse(fs.readFileSync(path.join(dirA, "matrix.json"), "utf8"));
      expect(matrix.captures.map((c: { name: string }) => c.name)).toEqual(all);
      expect(matrix.captures.find((c: { name: string }) => c.name === "default@2560x1440.anim.btn.2").anim.time).toBe(100);
      expect(matrix.chromium).toBe(browser.version());
      // the breakpoint layer got its own viewport
      expect(jobs.filter((j) => j.coverage).map((j) => j.coverage)).toEqual([["max-width-1919"]]);
      const covJob = jobs.find((j) => j.coverage)!;
      const cov = boxes[captureName(covJob)];
      const covPng = fs.readFileSync(path.join(dirA, `${captureName(covJob)}.png`));
      expect([[2560, 1440], [1920, 1080], [1280, 720]]).not.toContainEqual(covJob.viewport);
      expect([covPng.readUInt32BE(16), covPng.readUInt32BE(20)]).toEqual(covJob.viewport);
      expect(cov.scale).toBe(logicalViewport(covJob.viewport, [2560, 1440], 0.5).scale);
      expect(cov.elements.box.w).toBeCloseTo(80 * cov.scale, 5);
      expect(runA.timings.totalMs).toBeGreaterThan(0);
      expect(Object.keys(runA.timings.jobs).sort()).toEqual([...all].sort());
      console.log(`capture matrix: ${jobs.length} captures (${jobs.filter((j) => j.anim).length} animation samples) in ${runA.timings.totalMs} ms; ` +
        `per viewport ${JSON.stringify(runA.timings.viewports)}`);
    });

    it("is deterministic, whatever the concurrency: byte-identical PNGs, boxes.json and matrix.json (1 vs 2 pages at a time)", () => {
      const files = fs.readdirSync(dirA).sort();
      expect(fs.readdirSync(dirB).sort()).toEqual(files);
      const differ = files.filter((f) => !fs.readFileSync(path.join(dirA, f)).equals(fs.readFileSync(path.join(dirB, f))));
      expect(differ).toEqual([]);
    });

    it("a reused page gives the same capture as a fresh page for every job", async () => {
      const jobs = buildMatrix(built.ir).filter((j) => j.viewport[0] === 1280);
      const dir = tmp();
      for (const j of jobs) {
        const d = await openDesign(fx("screen.html"), kit, j.viewport, browser);
        try { await runCapture(d, built.ir, j, dir, built.elements); } finally { await d.close(); }
      }
      const differ = jobs.map(captureName).filter((n) => !fs.readFileSync(path.join(dir, `${n}.png`)).equals(fs.readFileSync(path.join(dirA, `${n}.png`))));
      expect(differ).toEqual([]);
      const fresh = JSON.parse(fs.readFileSync(path.join(dir, "boxes.json"), "utf8"));
      const reused = JSON.parse(fs.readFileSync(path.join(dirA, "boxes.json"), "utf8"));
      for (const n of jobs.map(captureName)) expect(fresh[n], n).toEqual(reused[n]);
    }, 120000);
  });

  describe("rules the golden shares with UI Toolkit", () => {
    let rules: IrBuild;
    beforeAll(async () => {
      const d = await openDesign(fx("engine-rules.html"), kit, [2560, 1440], browser);
      try { rules = await buildIr(d, await collectSnapshot(d.page, d.cdp, kit), kit, tmp(), fx("engine-rules.html")); } finally { await d.close(); }
    });

    it("gives a text-sized box the width UI Toolkit lays out (text rounded up, borders whole device pixels); other widths stay", async () => {
      for (const vp of [[2560, 1440], [1920, 1080]] as [number, number][]) {
        const s = logicalViewport(vp, [2560, 1440], 0.5).scale;
        const d = await openDesign(fx("engine-rules.html"), kit, vp, browser);
        try {
          const html = await d.page.evaluate(() => document.documentElement.outerHTML);
          const b = (await runCapture(d, rules.ir, job({ viewport: vp }), tmp(), rules.elements)).elements;
          // padding + borders as Unity lays them out (whole device pixels), device px
          const inline = 10 * 2 * s + 2 * Math.max(1, Math.round(1 * s));
          for (const id of ["a", "b"]) {
            const content = b[id].w - inline;
            // to Chromium's layout precision (1/64 CSS px)
            expect(Math.abs(content - Math.round(content)), `${id} at ${vp[0]}: ${content}`).toBeLessThan(s / 64 + 1e-6);
            expect(content - b[id].lines[0].w, `${id} at ${vp[0]}: text ${b[id].lines[0].w}`).toBeGreaterThan(-TEXT_CEIL_TOLERANCE);
            expect(content - b[id].lines[0].w, `${id} at ${vp[0]}: text ${b[id].lines[0].w}`).toBeLessThan(1);
          }
          // with letter-spacing, UI Toolkit's standard generator measures the text without the spacing after the last
          // character and the compiler adds that spacing as right padding: the text rounded up without it, plus it
          // (Yoga snaps that box, whose padding is now fractional, to whole device pixels)
          const track = 1.2 * s;
          expect(b.e.w, `e at ${vp[0]}`).toBeCloseTo(Math.round(Math.ceil(b.e.lines[0].w - track - TEXT_CEIL_TOLERANCE) + track + inline), 1);
          expect(b.e.w - inline - b.e.lines[0].w, `e at ${vp[0]}`).toBeGreaterThan(-0.5);
          // the next box follows the rounded one, as Yoga lays it out
          expect(b.b.x).toBeCloseTo(b.a.x + b.a.w + 4 * s, 4);
          expect(b.c.w).toBeCloseTo(100 * s, 4);
          // a box not sized by its text keeps its width
          expect(b.d.w).toBeCloseTo(100 * s, 4);
          // the page is given back as it was
          expect(await d.page.evaluate(() => document.documentElement.outerHTML)).toBe(html);
        } finally { await d.close(); }
      }
    });

    it("measures a text-sized width once the face that text shows for the first time has loaded", async () => {
      // the bold face is used by nothing but the state's text: a fresh page loads it only when the state shows the text
      const d = await openDesign(fx("engine-rules.html"), kit, [1920, 1080], browser);
      try {
        const b = (await runCapture(d, rules.ir, job({ state: "on", viewport: [1920, 1080] }), tmp(), rules.elements)).elements.late;
        expect(b.lines).toHaveLength(1);
        expect(b.w).toBeGreaterThanOrEqual(b.lines[0].w);
        expect(b.w - b.lines[0].w).toBeLessThan(1);
      } finally { await d.close(); }
    });

    it("keeps radios independent, as Unity's toggles are: checking one leaves the other checked, and the next capture starts as the markup", async () => {
      const d = await openDesign(fx("engine-rules.html"), kit, [2560, 1440], browser);
      try {
        const html = await d.page.evaluate(() => document.documentElement.outerHTML);
        const s = await CaptureSession.open(d, rules.ir, rules.elements, [2560, 1440]);
        const dir = tmp();
        let checked: CaptureBoxes, plain: CaptureBoxes;
        try {
          checked = await s.capture(job({ pseudo: { kind: "checked", elementId: "r2" }, apply: [{ kind: "pseudo", pseudo: "checked", elementId: "r2" }] }), dir);
          plain = await s.capture(job({}), dir);
        } finally { await s.close(); }
        const one = decodePng(fs.readFileSync(path.join(dir, `${checked.capture}.png`)));
        expect(near(centre(one, checked, "r1"), [0x16, 0xc2, 0xd5]), "r1 keeps its checked state").toBe(true);
        expect(near(centre(one, checked, "r2"), [0x16, 0xc2, 0xd5]), "r2 checked").toBe(true);
        const two = decodePng(fs.readFileSync(path.join(dir, `${plain.capture}.png`)));
        expect(near(centre(two, plain, "r1"), [0x16, 0xc2, 0xd5]), "r1 as the markup").toBe(true);
        expect(near(centre(two, plain, "r2"), [0x12, 0x3c, 0x47]), "r2 as the markup").toBe(true);
        expect(await d.page.evaluate(() => document.documentElement.outerHTML)).toBe(html);
        expect(await d.page.evaluate(() => (document.querySelector("[data-u-id=r1]") as HTMLInputElement).name)).toBe("pick");
      } finally { await d.close(); }
    });

    it("records the keyframe animations a static capture shows frozen, in matrix.json", async () => {
      const dir = tmp();
      const jobs = buildMatrix(rules.ir).filter((j) => !j.anim && j.viewport[0] === 2560);
      await captureMatrix(fx("engine-rules.html"), kit, rules.ir, rules.elements, dir, { browser, jobs });
      const matrix = JSON.parse(fs.readFileSync(path.join(dir, "matrix.json"), "utf8"));
      const def = matrix.captures.find((c: { name: string }) => c.name === "default@2560x1440");
      expect(def.frozen).toEqual([["mover", "slide"]]);
    });
  });
});
