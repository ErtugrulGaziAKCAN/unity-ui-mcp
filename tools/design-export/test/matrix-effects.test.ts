import { describe, expect, it } from "vitest";
import { buildMatrix, captureName, type CaptureJob } from "../src/capture/matrix.js";
import type { IrNode, IrScreen, IrShadow } from "../src/ir/types.js";

// A layer that changes only baked effects (outer shadow, inset shadow, gradient or image background) has no entry in
// `style`: the effect lives in shadowLayers / insetShadowLayers / backgroundLayers. It must still get a golden job.

const node = (id: string, o: Partial<IrNode> = {}): IrNode => ({
  id, kind: "container", external: false, classes: [], style: { base: { display: "flex" } }, text: null, asset: null, background: null,
  shadow: null, shadowLayers: {}, insetShadow: null, insetShadowLayers: {}, backgroundLayers: {}, attrTexts: {}, initial: null, bind: null,
  action: null, repeat: null, anims: [], children: [], ...o,
});
const screen = (root: IrNode, o: Partial<IrScreen> = {}): IrScreen => ({
  irVersion: 1, screen: "s", source: { path: "s.html", sha256: "0".repeat(64) }, referenceViewport: [2560, 1440],
  viewports: [[2560, 1440], [1920, 1080], [1280, 720]], screenMatch: 0.5, states: ["default"], breakpoints: [], tokens: {}, fonts: [],
  root, ...o,
});
const shadow: IrShadow = {
  kind: "shadow9", file: "assets/x.png", sha256: "1".repeat(64), width: 64, height: 64, slice: [24, 24, 24, 24], tint: false, stopGap: null,
  offset: { x: -24, y: -16, w: 48, h: 48 },
};
const gradient = { kind: "svg" as const, file: "assets/g.svg", sha256: "2".repeat(64), width: 100, height: 40, slice: null, tint: false, stopGap: 0.5 };
const names = (jobs: CaptureJob[]) => jobs.map(captureName);
const at2560 = (jobs: CaptureJob[]) => names(jobs).filter((n) => n.includes("@2560x1440"));

describe("buildMatrix: layers that change only baked effects", () => {
  it("captures a hover that only lifts the outer shadow", () => {
    const ir = screen(node("root", { children: [node("card", { shadow, shadowLayers: { hover: { ...shadow, sha256: "3".repeat(64) } } })] }));
    expect(at2560(buildMatrix(ir))).toEqual(["default@2560x1440", "default@2560x1440.hover.card"]);
  });

  it("captures an is-* class that only adds an inset shadow, and its union with hover", () => {
    const ir = screen(node("root", {
      children: [node("well", { insetShadowLayers: { "class:is-pressed": shadow, "class:is-pressed+hover": { ...shadow, sha256: "4".repeat(64) } } })],
    }));
    expect(at2560(buildMatrix(ir))).toEqual([
      "default@2560x1440", "default@2560x1440.hover.well.is-pressed.well", "default@2560x1440.is-pressed.well",
    ]);
  });

  it("captures a pseudo-state that only switches the gradient background, at every declared viewport", () => {
    const ir = screen(node("root", { children: [node("chip", { background: gradient, backgroundLayers: { focus: { ...gradient, sha256: "5".repeat(64) } } })] }));
    const jobs = buildMatrix(ir);
    expect(names(jobs).filter((n) => n.includes(".focus.chip"))).toEqual([
      "default@2560x1440.focus.chip", "default@1920x1080.focus.chip", "default@1280x720.focus.chip",
    ]);
    expect(jobs.find((j) => captureName(j) === "default@2560x1440.focus.chip")!.pseudo).toEqual({ kind: "focus", elementId: "chip" });
  });

  it("captures a layer that removes the effect (null) like one that changes it", () => {
    const ir = screen(node("root", { children: [node("flat", { shadow, shadowLayers: { active: null } })] }));
    expect(at2560(buildMatrix(ir))).toEqual(["default@2560x1440", "default@2560x1440.active.flat"]);
  });

  it("a state layer with only an effect is covered by the state baseline, and a style layer with an effect is one job", () => {
    const ir = screen(node("root", {
      children: [node("hero", {
        background: gradient, backgroundLayers: { "state:loading": { ...gradient, sha256: "6".repeat(64) }, hover: null },
        style: { base: { display: "flex" }, hover: { opacity: "0.5" } },
      })],
    }), { states: ["default", "loading"] });
    expect(at2560(buildMatrix(ir))).toEqual(["default@2560x1440", "loading@2560x1440", "default@2560x1440.hover.hero"]);
  });

  it("refuses an effect layer that names an unknown state or element, like a style layer", () => {
    const unknownState = screen(node("root", { children: [node("a", { shadowLayers: { "state:gone": shadow } })] }));
    expect(() => buildMatrix(unknownState)).toThrow(/state gone/);
    const unknownElement = screen(node("root", { children: [node("a", { insetShadowLayers: { "anc(ghost):hover": shadow } })] }));
    expect(() => buildMatrix(unknownElement)).toThrow(/ghost/);
  });
});
