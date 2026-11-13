import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildTextStyles, INTER_METRICS, lineHeightFor, textStylesJson } from "../src/kit/textStyles.js";

const kitFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../design-kit/text-styles.json");

describe("kit text style table", () => {
  it("reproduces the Inter line heights", () => {
    expect(2478 / 2048).toBe(1.2099609375);
    expect(lineHeightFor(16, INTER_METRICS)).toBe(19.359375);
    expect(lineHeightFor(32, INTER_METRICS)).toBe(38.71875);
    expect(lineHeightFor(48, INTER_METRICS)).toBe(58.078125);
    expect(lineHeightFor(64, INTER_METRICS)).toBe(77.4375);
    expect(lineHeightFor(12, INTER_METRICS)).toBe(14.515625);
    expect(lineHeightFor(24, INTER_METRICS)).toBe(29.046875);
    expect(lineHeightFor(28, INTER_METRICS)).toBe(33.875);
    expect(lineHeightFor(56, INTER_METRICS)).toBe(67.765625);
  });
  it("keeps sizes whole at every declared viewport and line heights on the 1/64 grid", () => {
    for (const r of buildTextStyles(INTER_METRICS)) {
      expect(r.fontSize * 0.75).toBe(Math.round(r.fontSize * 0.75));
      expect(r.fontSize * 0.5).toBe(Math.round(r.fontSize * 0.5));
      expect(r.lineHeight * 64).toBe(Math.round(r.lineHeight * 64));
      expect(Math.abs(r.lineHeight - r.fontSize * 2478 / 2048)).toBeLessThanOrEqual(1 / 128);
    }
  });
  it("rejects a size that is not a multiple of 4", () => {
    expect(() => buildTextStyles(INTER_METRICS, [["odd", 18]])).toThrow(/multiple of 4/);
  });
  it("matches the committed design-kit/text-styles.json", () => {
    expect(JSON.parse(fs.readFileSync(kitFile, "utf8"))).toEqual(textStylesJson(buildTextStyles(INTER_METRICS)));
  });
});
