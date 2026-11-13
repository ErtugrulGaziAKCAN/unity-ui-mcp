import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readKit } from "../src/kit.js";
import { buildTextStyles, RATIO_4_3, RATIO_5_4, textStylesJson, textStyleScaleProblems } from "../src/kit/textStyles.js";
import { readTextStyles } from "../src/lint/text-styles.js";

const kitDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../design-kit");
const kitFile = path.join(kitDir, "text-styles.json");

describe("kit text style table", () => {
  it("builds the line-box table: sizes and line heights in multiples of 4, ratios 5:4 and 4:3", () => {
    const by = Object.fromEntries(buildTextStyles().map((r) => [r.name, r]));
    const table = [
      ["caption", 12, 16], ["label", 16, 20], ["body", 24, 32], ["subtitle", 32, 40], ["title", 36, 48], ["headline", 48, 60], ["display", 64, 80],
    ] as const;
    for (const [n, s, l] of table) {
      expect(by[n]).toMatchObject({ fontSize: s, lineHeight: l, weight: 400 });
      expect(by[`${n}-bold`]).toMatchObject({ fontSize: s, lineHeight: l, weight: 700 });
    }
    expect(Object.keys(by)).toHaveLength(table.length * 2);
    expect(RATIO_5_4).toEqual({ num: 5, den: 4 });
    expect(RATIO_4_3).toEqual({ num: 4, den: 3 });
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
    expect(() => buildTextStyles([{ name: "odd", fontSize: 16, ratio: { num: 6, den: 5 } }])).toThrow(/ratio/);
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
    ]);
    // a viewport whose scale is not a multiple of 1/4 needs finer sizes
    const odd = { ...kit, viewports: [[2560, 1440], [1366, 768]] as [number, number][] };
    expect(textStyleScaleProblems([{ name: "label", fontSize: 16, lineHeight: 20, weight: 400 }], odd).length).toBeGreaterThan(0);
  });
});
