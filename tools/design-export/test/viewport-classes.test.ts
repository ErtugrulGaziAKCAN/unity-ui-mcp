import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildMatrix } from "../src/capture/matrix.js";
import { inkColourLimit, readThresholds, thresholdsFor } from "../src/compare/compare.js";
import { exactViewports, readKit } from "../src/kit.js";
import { rulesJson } from "../src/kit/rulesJson.js";
import { kitScales, wholeBorderWidths } from "../src/lint/rules/U-CSS-040.js";
import type { IrScreen } from "../src/ir/types.js";
import { validateIr } from "../src/ir/validate.js";
import { parseViewports, viewportClassOf, viewportEntries, viewportLabel } from "../src/viewport.js";

const kitDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../design-kit");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vp-classes-"));

/** A copy of the repository kit's config with other viewports. */
function kitWith(viewports: unknown): string {
  const dir = tmp();
  for (const f of fs.readdirSync(kitDir)) if (f !== "fixtures" && f !== "components") fs.cpSync(path.join(kitDir, f), path.join(dir, f), { recursive: true });
  const file = path.join(dir, "kit.config.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), viewports }));
  return dir;
}

describe("viewport classes in kit.config.json", () => {
  it("reads a plain [w, h] as exact and { size, class } with its class, and writes them back in the same forms", () => {
    const list = parseViewports([[2560, 1440], { size: [1920, 1080], class: "exact" }, { size: [1366, 768], class: "scaled" }]);
    expect(list).toEqual([
      { size: [2560, 1440], class: "exact" }, { size: [1920, 1080], class: "exact" }, { size: [1366, 768], class: "scaled" },
    ]);
    expect(viewportEntries(list)).toEqual([[2560, 1440], [1920, 1080], { size: [1366, 768], class: "scaled" }]);
  });

  it("rejects an unknown class, a malformed entry and a viewport listed twice", () => {
    expect(() => parseViewports([{ size: [1366, 768], class: "fuzzy" }])).toThrow(/viewports\[0\]/);
    expect(() => parseViewports([[1366.5, 768]])).toThrow(/whole positive pixels/);
    expect(() => parseViewports([{ size: [1366, 768], class: "scaled", extra: 1 }])).toThrow(/viewports\[0\]/);
    expect(() => parseViewports([[1366, 768], { size: [1366, 768], class: "scaled" }])).toThrow(/1366×768 is listed twice/);
    expect(() => parseViewports([])).toThrow(/non-empty/);
  });

  it("the repository kit declares 2560, 1920, 1280 and 3840 exact, 1600 and 1366 scaled", () => {
    const kit = readKit(kitDir);
    expect(kit.viewports).toEqual([[2560, 1440], [1920, 1080], [1280, 720], [3840, 2160], [1600, 900], [1366, 768]]);
    expect(kit.scaledViewports).toEqual([[1600, 900], [1366, 768]]);
    expect(exactViewports(kit)).toEqual([[2560, 1440], [1920, 1080], [1280, 720], [3840, 2160]]);
    // 3840×2160 is scale 1.5: the kit's 4px grid stays whole there
    expect(kitScales(kit).map((x) => x.scale)).toEqual([1, 0.75, 0.5, 1.5]);
    expect(wholeBorderWidths(kitScales(kit).map((x) => x.scale), 3)).toEqual([4, 8, 12]);
    expect(viewportClassOf(kit.scaledViewports, [1366, 768])).toBe("scaled");
    expect(viewportClassOf(kit.scaledViewports, [3840, 2160])).toBe("exact");
    expect(viewportLabel([1366, 768], "scaled")).toBe("1366×768 (scaled)");
  });

  it("an older kit's plain list is all exact; the reference viewport cannot be scaled", () => {
    const kit = readKit(kitWith([[2560, 1440], [1920, 1080]]));
    expect(kit.scaledViewports).toEqual([]);
    expect(exactViewports(kit)).toEqual([[2560, 1440], [1920, 1080]]);
    expect(() => readKit(kitWith([{ size: [2560, 1440], class: "scaled" }]))).toThrow(/reference viewport 2560×1440 .* cannot be "scaled"/);
  });

  it("the design rules list both classes", () => {
    const kit = readKit(kitDir);
    expect(rulesJson(kit).kit).toMatchObject({ viewports: kit.viewports, scaledViewports: [[1600, 900], [1366, 768]] });
  });
});

describe("goldens and coverage at both classes", () => {
  const ir = (extra: Partial<IrScreen> = {}): IrScreen => ({
    irVersion: 1, screen: "s", source: { path: "s.html", sha256: "0".repeat(64) },
    referenceViewport: [2560, 1440], viewports: [[2560, 1440], [1280, 720], [1366, 768]], scaledViewports: [[1366, 768]], screenMatch: 0.5,
    states: ["default"], breakpoints: [], tokens: {}, fonts: [],
    root: {
      id: "root", kind: "container", external: false, classes: [], style: { base: {} }, text: null, asset: null, background: null, backgroundLayers: {},
      shadow: null, shadowLayers: {}, insetShadow: null, insetShadowLayers: {}, attrTexts: {}, initial: null, bind: null, action: null, repeat: null, anims: [], children: [],
    },
    ...extra,
  });

  it("the IR schema accepts scaledViewports, and an IR without them", () => {
    expect(validateIr(ir())).toEqual([]);
    const { scaledViewports: _, ...older } = ir();
    expect(validateIr(older as IrScreen)).toEqual([]);
  });

  it("every state is captured at every declared viewport of both classes", () => {
    const vps = buildMatrix(ir()).map((j) => j.viewport.join("x"));
    expect(vps).toEqual(["2560x1440", "1280x720", "1366x768"]);
  });

  it("a breakpoint no declared viewport reaches gets a coverage viewport on the exact viewports' scale step", () => {
    const narrow = ir({
      viewports: [[2560, 1440], [1920, 1080], [1280, 720], [1366, 768]],
      breakpoints: [{ name: "narrow", maxAspect: 1.5 }],
      root: { ...ir().root, style: { base: {}, "bp:narrow": { "background-color": "red" } } },
    });
    const added = buildMatrix(narrow).filter((j) => j.coverage);
    // the exact 1, 0.75 and 0.5 keep a 0.25 step (640×1080 is scale 0.5); with the scaled 1366×768 (≈ 0.5335) there would
    // be no step and the added viewport would be 1152×768, where no kit length is whole
    expect(added.map((j) => j.viewport)).toEqual([[640, 1080]]);
  });
});

describe("thresholds per viewport class", () => {
  const base = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fidelity-thresholds.json"), "utf8"));
  const file = (o: object) => { const f = path.join(tmp(), "t.json"); fs.writeFileSync(f, JSON.stringify({ ...base, ...o })); return f; };

  it("a scaled block replaces measured limits at scaled viewports only", () => {
    const t = readThresholds(file({ scaled: { $comment: "measured", ssimElement: 0.985, textInkDeltaE: 2.5 } }));
    expect(t.scaled).toEqual({ ssimElement: 0.985, textInkDeltaE: 2.5 });
    expect(thresholdsFor(t, "exact").ssimElement).toBe(base.ssimElement);
    expect(thresholdsFor(t, "scaled")).toMatchObject({ ssimElement: 0.985, textInkDeltaE: 2.5, boxPx: base.boxPx, baselinePx: base.baselinePx });
  });

  it("never changes the geometry limits, and checks every value as the file's own", () => {
    expect(() => readThresholds(file({ scaled: { boxPx: 2 } }))).toThrow(/"scaled" cannot change "boxPx"/);
    expect(() => readThresholds(file({ scaled: { baselinePx: 2 } }))).toThrow(/"scaled" cannot change "baselinePx"/);
    expect(() => readThresholds(file({ scaled: { nonsense: 1 } }))).toThrow(/unknown threshold key "nonsense"/);
    expect(() => readThresholds(file({ scaled: { ssimRotated: 0.9 } }))).toThrow(/\(scaled\).*"ssimRotated" must lie between/);
    expect(() => readThresholds(file({ scaled: [] }))).toThrow(/"scaled" must be an object/);
  });

  it("the scaled class holds text under 13 device px to the small-text ink limits, the exact class from 12.01 to the full ones", () => {
    // measured (docs/findings/viewport-classes.md, "Text ink at fractional sizes"): whole 13 and 14 px at 1280×720 stay
    // within ΔE2000 2 (1.98, 1.94); the fractional 12.5 px at 1600×900 and 12.8 px at 1366×768 reach 4.29 and 3.80
    const t = readThresholds();
    const exact = thresholdsFor(t, "exact"), scaled = thresholdsFor(t, "scaled");
    for (const px of [12.5, 12.8]) {
      expect(inkColourLimit(exact, px), `exact ${px}`).toBe(exact.textInkDeltaE);
      expect(inkColourLimit(scaled, px), `scaled ${px}`).toBe(scaled.textInkDeltaEFirstSmall);
    }
    for (const px of [13, 14]) expect(inkColourLimit(scaled, px), `scaled ${px}`).toBe(scaled.textInkDeltaE);
    expect(inkColourLimit(exact, 12)).toBe(exact.textInkDeltaEFirstSmall);
  });

  it("the repository's thresholds are the same at both classes unless a measured scaled limit is recorded", () => {
    const t = readThresholds();
    const own = Object.keys(base.scaled ?? {}).filter((k) => !k.startsWith("$"));
    expect(Object.keys(t.scaled ?? {}).sort()).toEqual(own.sort());
  });
});
