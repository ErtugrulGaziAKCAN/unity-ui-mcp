import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildTextStyles, LARGE_RATIO, SMALL_RATIO, textStylesJson } from "../src/kit/textStyles.js";

const kitFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../design-kit/text-styles.json");

describe("kit text style table", () => {
  it("builds the line-box table from the two ratios", () => {
    const by = Object.fromEntries(buildTextStyles().map((r) => [r.name, r]));
    for (const [n, s, l] of [["caption", 12, 15], ["label", 16, 20], ["body", 24, 30], ["subtitle", 28, 35], ["title", 32, 36], ["headline", 48, 54], ["display", 56, 63]] as const) {
      expect(by[n]).toMatchObject({ fontSize: s, lineHeight: l, weight: 400 });
      expect(by[`${n}-bold`]).toMatchObject({ fontSize: s, lineHeight: l, weight: 700 });
    }
    expect(SMALL_RATIO).toBe(1.25);
    expect(LARGE_RATIO).toBe(1.125);
  });
  it("keeps sizes and line heights whole pixels, and sizes whole at every declared viewport", () => {
    for (const r of buildTextStyles()) {
      expect(Number.isInteger(r.lineHeight)).toBe(true);
      expect(r.fontSize * 0.75).toBe(Math.round(r.fontSize * 0.75));
      expect(r.fontSize * 0.5).toBe(Math.round(r.fontSize * 0.5));
    }
  });
  it("rejects a size off its ratio's step or an unknown ratio", () => {
    expect(() => buildTextStyles([{ name: "odd", fontSize: 18, ratio: SMALL_RATIO }])).toThrow(/multiple of 4/);
    expect(() => buildTextStyles([{ name: "odd", fontSize: 28, ratio: LARGE_RATIO }])).toThrow(/multiple of 8/);
    expect(() => buildTextStyles([{ name: "odd", fontSize: 16, ratio: 1.2 }])).toThrow(/ratio/);
  });
  it("matches the committed design-kit/text-styles.json", () => {
    expect(JSON.parse(fs.readFileSync(kitFile, "utf8"))).toEqual(textStylesJson(buildTextStyles()));
  });
});
