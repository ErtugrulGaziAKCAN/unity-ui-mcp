import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readKit } from "../src/kit.js";
import { assertTextFloor, buildTextStyles, minimumKitTextPx, minimumTextPx, RATIO_4_3, RATIO_5_4, RATIO_6_5, RATIO_7_5, TEXT_FLOOR_PX, textFloorProblems,
  textStylesJson, textStyleScaleProblems } from "../src/kit/textStyles.js";
import { readTextStyles } from "../src/lint/text-styles.js";

const kitDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../design-kit");
const kitFile = path.join(kitDir, "text-styles.json");

describe("kit text style table", () => {
  it("builds the line-box table: sizes and line heights in multiples of 4, ratios 5:4, 4:3, 6:5 and 7:5", () => {
    const by = Object.fromEntries(buildTextStyles().map((r) => [r.name, r]));
    // caption and label at the readable-text floor's smallest whole size (20 px), each with the line box nearest its own ratio
    const table = [
      ["caption", 20, 28], ["label", 20, 24], ["body", 24, 32], ["subtitle", 32, 40], ["title", 36, 48], ["headline", 48, 60], ["display", 64, 80],
    ] as const;
    for (const [n, s, l] of table) {
      expect(by[n]).toMatchObject({ fontSize: s, lineHeight: l, weight: 400 });
      expect(by[`${n}-bold`]).toMatchObject({ fontSize: s, lineHeight: l, weight: 700 });
    }
    expect(Object.keys(by)).toHaveLength(table.length * 2);
    expect(RATIO_5_4).toEqual({ num: 5, den: 4 });
    expect(RATIO_4_3).toEqual({ num: 4, den: 3 });
    expect(RATIO_6_5).toEqual({ num: 6, den: 5 });
    expect(RATIO_7_5).toEqual({ num: 7, den: 5 });
  });

  it("keeps every size and line height a multiple of 4 px", () => {
    for (const r of buildTextStyles()) {
      expect(r.fontSize % 4, r.name).toBe(0);
      expect(r.lineHeight % 4, r.name).toBe(0);
    }
  });

  it("rejects a size whose line height is not a whole multiple of 4 px, and an unknown ratio", () => {
    expect(() => buildTextStyles([{ name: "odd", fontSize: 18, ratio: RATIO_5_4 }])).toThrow(/multiple of 4/);
    expect(() => buildTextStyles([{ name: "odd", fontSize: 20, ratio: RATIO_5_4 }])).toThrow(/line height 25/);
    expect(() => buildTextStyles([{ name: "odd", fontSize: 16, ratio: RATIO_4_3 }])).toThrow(/line height 21\.3/);
    expect(() => buildTextStyles([{ name: "odd", fontSize: 16, ratio: RATIO_6_5 }])).toThrow(/line height 19\.2/);
    expect(() => buildTextStyles([{ name: "odd", fontSize: 16, ratio: { num: 3, den: 2 } }])).toThrow(/ratio 3:2 is not 5:4, 4:3, 6:5, 7:5/);
  });

  it("matches the committed design-kit/text-styles.json", () => {
    expect(JSON.parse(fs.readFileSync(kitFile, "utf8"))).toEqual(textStylesJson(buildTextStyles()));
  });
});

describe("whole device pixels at every declared viewport scale", () => {
  it("the kit's text styles have whole-pixel sizes and line heights at every scale of kit.config.json", () => {
    const kit = readKit(kitDir);
    expect(textStyleScaleProblems(readTextStyles(kit), kit)).toEqual([]);
  });

  it("names the style, the viewport and the fractional value", () => {
    const kit = readKit(kitDir);
    // the previous table's caption (12/15) and a style that is whole everywhere (28/36: 21/27 and 14/18 device px)
    const old = [{ name: "caption", fontSize: 12, lineHeight: 15, weight: 400 }, { name: "whole", fontSize: 28, lineHeight: 36, weight: 400 }];
    expect(textStyleScaleProblems(old, kit)).toEqual([
      "caption: line height 15 px is 11.25 device px at 1920×1080 (scale 0.75)",
      "caption: line height 15 px is 7.5 device px at 1280×720 (scale 0.5)",
      "caption: line height 15 px is 22.5 device px at 3840×2160 (scale 1.5)",
    ]);
    // a viewport whose scale is not a multiple of 1/4 needs finer sizes when it is exact
    const odd = { ...kit, viewports: [[2560, 1440], [1366, 768]] as [number, number][], scaledViewports: [] };
    expect(textStyleScaleProblems([{ name: "label", fontSize: 16, lineHeight: 20, weight: 400 }], odd).length).toBeGreaterThan(0);
  });

  it("judges exact viewports only: a scaled viewport is exempt", () => {
    const kit = readKit(kitDir);
    expect(kit.scaledViewports).toEqual([[1600, 900], [1366, 768]]);
    const label = [{ name: "label", fontSize: 16, lineHeight: 20, weight: 400 }];
    expect(textStyleScaleProblems(label, { ...kit, viewports: [[2560, 1440], [1366, 768]], scaledViewports: [[1366, 768]] })).toEqual([]);
    expect(textStyleScaleProblems(label, { ...kit, viewports: [[2560, 1440], [1366, 768]], scaledViewports: [] })).not.toEqual([]);
  });
});

describe("the readable-text floor", () => {
  it("is 9 device px at the smallest declared viewport of either class: 18 px design text with the default viewports, 20 on the kit's grid", () => {
    const kit = readKit(kitDir);
    expect(TEXT_FLOOR_PX).toBe(9);
    expect(minimumTextPx(kit)).toBe(18);
    expect(minimumKitTextPx(kit)).toBe(20);
    expect(textFloorProblems(readTextStyles(kit), kit)).toEqual([]);
    // the previous table's caption and label
    const old = [{ name: "caption", fontSize: 12, lineHeight: 16, weight: 400 }, { name: "label", fontSize: 16, lineHeight: 20, weight: 400 }];
    expect(textFloorProblems(old, kit)).toEqual([
      "caption: 12px draws 6 device px at 1280×720 (scale 0.5); the minimum is 18px",
      "label: 16px draws 8 device px at 1280×720 (scale 0.5); the minimum is 18px",
    ]);
    expect(() => assertTextFloor(old, kit)).toThrow(/text-styles\.json: no text may draw below 9 device px .*Raise these styles to at least 18px, .*\(20px with these viewports\)/);
  });

  it("judges scaled viewports too: 1366×768 alone puts the minimum at 16.88 px", () => {
    const kit = readKit(kitDir);
    const scaledOnly = { ...kit, viewports: [[2560, 1440], [1366, 768]] as [number, number][], scaledViewports: [[1366, 768]] as [number, number][] };
    expect(minimumTextPx(scaledOnly)).toBe(16.88);
    expect(textFloorProblems([{ name: "label", fontSize: 16, lineHeight: 20, weight: 400 }], scaledOnly)).toEqual([
      "label: 16px draws 8.54 device px at 1366×768 (scale 0.533463542); the minimum is 16.88px",
    ]);
  });
});
