import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readKit } from "../src/kit.js";
import { cssSupport } from "../src/lint/allowed-css.js";
import { declsOf, functionNames, parseDeclarations, resolveVars, splitTopLevel } from "../src/lint/css-values.js";
import { readFontFile, readPostScriptName, realFaces, weightRange } from "../src/lint/fonts.js";
import { physicalNames } from "../src/lint/snapshot.js";
import { mediaTypeProblems } from "../src/lint/rules/U-CSS-012.js";
import { closeStops, findGradients, gradientLineLength, linearAngle, resolveStopOffsets } from "../src/lint/resolve/gradient.js";
import { ellipticalCorners, expandBorderRadius, resolveRadii } from "../src/lint/resolve/radius.js";
import { individualTransformProblem, splitTransform } from "../src/lint/resolve/transform.js";
import { parseSelector, pseudoElement, reachSelector, specificity, structural } from "../src/lint/selectors.js";
import { matchRichStyle, matchTextStyle, readTextStyles } from "../src/lint/text-styles.js";
import { mediaFeatures } from "../src/lint/rules/U-CSS-012.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const kit = readKit(path.join(here, "fixtures", "lint", "kit"));
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe("resolve/radius", () => {
  it("resolves a 9999px pill to half the height (overlapping-curves factor)", () => {
    const r = resolveRadii(expandBorderRadius("9999px")!, { w: 300, h: 80 })!;
    for (const c of Object.values(r)) { close(c.x, 40); close(c.y, 40); }
    expect(ellipticalCorners(r)).toEqual([]);
  });
  it("finds the ellipse of 50% on a non-square box, not on a square", () => {
    const e = resolveRadii(expandBorderRadius("50%")!, { w: 300, h: 80 })!;
    close(e["top-left"].x, 150); close(e["top-left"].y, 40);
    expect(ellipticalCorners(e)).toHaveLength(4);
    expect(ellipticalCorners(resolveRadii(expandBorderRadius("50%")!, { w: 80, h: 80 })!)).toEqual([]);
  });
  it("expands the slash syntax and scales by the smallest side factor", () => {
    expect(expandBorderRadius("10px 20px / 5px")).toEqual({ "top-left": "10px 5px", "top-right": "20px 5px", "bottom-right": "10px 5px", "bottom-left": "20px 5px" });
    const r = resolveRadii({ "top-left": "200px", "top-right": "200px" }, { w: 300, h: 1000 })!;
    close(r["top-left"].x, 150); close(r["top-right"].y, 150); close(r["bottom-left"].x, 0);
    close(resolveRadii({ "top-left": "1rem" }, { w: 100, h: 100 }, { rootFontSize: 16 })!["top-left"].x, 16);
    expect(resolveRadii({ "top-left": "calc(1px + 1px)" }, { w: 100, h: 100 })).toBeNull();
  });
});

describe("resolve/gradient", () => {
  const g = (v: string) => findGradients(v)[0];
  it("measures the gradient line for angles, sides and corners", () => {
    close(gradientLineLength(g("linear-gradient(90deg, red, blue)"), { w: 400, h: 100 })!, 400);
    close(gradientLineLength(g("linear-gradient(red, blue)"), { w: 400, h: 100 })!, 100);
    close(gradientLineLength(g("linear-gradient(45deg, red, blue)"), { w: 100, h: 100 })!, Math.SQRT2 * 100);
    close(gradientLineLength(g("linear-gradient(to top right, red, blue)"), { w: 300, h: 100 })!, (2 * 300 * 100) / Math.hypot(300, 100));
    close(linearAngle("to top right", { w: 100, h: 100 })!, 45);
    close(linearAngle("0.25turn", { w: 1, h: 1 })!, 90);
  });
  it("measures the radial gradient ray", () => {
    close(gradientLineLength(g("radial-gradient(red, blue)"), { w: 400, h: 100 })!, 200 * Math.SQRT2);
    close(gradientLineLength(g("radial-gradient(circle closest-side, red, blue)"), { w: 400, h: 100 })!, 50);
    close(gradientLineLength(g("radial-gradient(circle at left top, red, blue)"), { w: 300, h: 400 })!, 500);
    close(gradientLineLength(g("radial-gradient(40px 20px at center, red, blue)"), { w: 300, h: 400 })!, 40);
  });
  it("applies the stop fix-up and finds stops closer than 1/64", () => {
    expect(resolveStopOffsets(g("linear-gradient(red, lime 50%, blue)"), 100)).toEqual([0, 0.5, 1]);
    expect(resolveStopOffsets(g("linear-gradient(red 50%, blue 20%)"), 100)).toEqual([0.5, 0.5]);
    expect(resolveStopOffsets(g("linear-gradient(red, lime, blue, black 90%)"), 100).map((x) => Math.round(x! * 100))).toEqual([0, 30, 60, 90]);
    const box = { w: 400, h: 100 };
    expect(closeStops(g("linear-gradient(90deg, rgb(255, 0, 0) 50%, rgb(0, 0, 255) 50%)"), box)).toHaveLength(1);
    expect(closeStops(g("linear-gradient(90deg, red 200px, blue 210px)"), box)).toHaveLength(0); // 2.5%
    expect(closeStops(g("linear-gradient(90deg, red 200px, blue 205px)"), box)).toHaveLength(1); // 1.25%
    expect(closeStops(g("linear-gradient(90deg, red 50%, red 50%, blue)"), box)).toHaveLength(0); // same colour
    expect(closeStops(g("linear-gradient(red 40%, blue 40% 60%, green 60%)"), null)).toHaveLength(2); // double position
  });
});

describe("resolve/transform", () => {
  it("splits translate → rotate → scale lists directly", () => {
    expect(splitTransform("translateY(-2px) rotate(5deg) scale(1.1)")).toEqual({ ok: true, split: { translate: ["0px", "-2px"], rotate: 5, scale: [1.1, 1.1] } });
    expect(splitTransform("translateX(50%) translate(0, 10px) scaleX(2)")).toEqual({ ok: true, split: { translate: ["50%", "10px"], rotate: null, scale: [2, 1] } });
    expect(splitTransform("none")).toEqual({ ok: true, split: { translate: null, rotate: null, scale: null } });
  });
  it("moves a translation in front of rotate/scale when the order allows it", () => {
    const a = splitTransform("rotate(90deg) translateX(10px)");
    expect(a.ok && a.split.translate).toEqual(["0px", "10px"]);
    expect(a.ok && a.split.rotate).toBe(90);
    const b = splitTransform("scale(2) translateX(10px)");
    expect(b.ok && b.split).toEqual({ translate: ["20px", "0px"], rotate: null, scale: [2, 2] });
    expect(splitTransform("scale(2) rotate(45deg)").ok).toBe(true); // uniform scale commutes
    const c = splitTransform("rotate(90deg) translateX(50%)", { w: 40, h: 10 });
    expect(c.ok && c.split.translate).toEqual(["0px", "20px"]);
  });
  it("rejects what translate, rotate and scale cannot express", () => {
    expect(splitTransform("scale(2, 1) rotate(45deg)").ok).toBe(false);
    expect(splitTransform("skewX(10deg)").ok).toBe(false);
    expect(splitTransform("matrix(1, 0, 0, 1, 0, 0)").ok).toBe(false);
    expect(splitTransform("translate3d(0, 0, 0)").ok).toBe(false);
    expect(splitTransform("rotateZ(10deg)").ok).toBe(false);
    expect(splitTransform("perspective(100px)").ok).toBe(false);
    expect(splitTransform("translateX(50%) translateX(10px)").ok).toBe(false);
    expect(splitTransform("rotate(10deg) translateX(50%)").ok).toBe(false); // needs the box
    expect(individualTransformProblem("rotate", "x 45deg")).not.toBeNull();
    expect(individualTransformProblem("translate", "1px 2px 3px")).not.toBeNull();
    expect(individualTransformProblem("scale", "1 2")).toBeNull();
  });
});

describe("selectors", () => {
  it("finds pseudo-elements, interaction states and structural pseudo-classes", () => {
    const p = parseSelector(".a > b:hover::before");
    expect(pseudoElement(p)).toBe("before");
    expect(reachSelector(p)).toBe(".a > b");
    expect(reachSelector(parseSelector(".state-loading .spinner"))).toBe("* .spinner");
    expect(reachSelector(parseSelector("li:not(:hover).x"))).toBe("li.x");
    expect(reachSelector(parseSelector(":is(.a:hover, .b) + .c"))).toBe(":is(.a, .b) + .c");
    expect(reachSelector(parseSelector("input::placeholder"))).toBe("input");
    expect(structural(parseSelector("li:nth-child(2n of .x)"))).toEqual(["nth-child"]);
    expect(structural(parseSelector(".row:not(:last-child)"))).toEqual(["last-child"]);
    expect(specificity(parseSelector("#a .b c"))).toEqual([1, 1, 1]);
    expect(specificity(parseSelector(":where(#a) .b:is(#c, d)::after"))).toEqual([1, 1, 1]);
  });
});

describe("css values", () => {
  it("resolves var() with fallbacks and splits at top level", () => {
    const vars: Record<string, string> = { "--a": "8px", "--empty": " " };
    const look = (n: string) => vars[n];
    expect(resolveVars("calc(var(--a) + var(--none, var(--a)))", look)).toBe("calc(8px + 8px)");
    expect(resolveVars("var(--empty, 2px) var(--none)", look)).toBe("2px ");
    expect(splitTopLevel("rgb(1, 2, 3) 1px, url(a,b) 2px", ",")).toEqual(["rgb(1, 2, 3) 1px", "url(a,b) 2px"]);
    expect(functionNames('url("x(y).png") min(1px, calc(2px))')).toEqual(["url", "min", "calc"]);
    expect(parseDeclarations('a: b; content: "x;y" !important;')).toEqual([{ name: "a", value: "b", important: false }, { name: "content", value: '"x;y"', important: true }]);
    expect(declsOf([{ name: "border-top-width", value: "", important: false }], "border: 1px solid var(--x);")).toEqual([{ name: "border", value: "1px solid var(--x)", important: false }]);
  });
  it("maps logical and shorthand properties to physical longhands", () => {
    expect(physicalNames("margin-block-start")).toEqual(["margin-top"]);
    expect(physicalNames("padding-inline-end")).toEqual(["padding-right"]);
    expect(physicalNames("border-inline-start-width")).toEqual(["border-left-width"]);
    expect(physicalNames("min-inline-size")).toEqual(["min-width"]);
    expect(physicalNames("margin-inline")).toEqual(["margin-left", "margin-right"]);
    expect(physicalNames("color")).toEqual(["color"]);
  });
  it("finds unsupported media types and not", () => {
    expect(mediaTypeProblems("print")).toEqual(["media type print"]);
    expect(mediaTypeProblems("only screen and (min-width: 1px), all")).toEqual([]);
    expect(mediaTypeProblems("not all and (min-width: 1px)")).toEqual(["not"]);
  });
  it("reads media features, including range syntax", () => {
    expect(mediaFeatures("(min-width: 1px) and (hover: hover), print and (width >= 10px), (10px < height)")).toEqual(["min-width", "hover", "width", "height"]);
  });
});

describe("kit data", () => {
  it("matches text styles numerically (whole sizes, fractional line heights as Blink serialises them)", () => {
    const styles = readTextStyles(kit);
    expect(matchTextStyle(styles, 16, 19.359375, 400)?.name).toBe("label");
    expect(matchTextStyle(styles, 16, 19.3594, 700)?.name).toBe("label-bold"); // 6 significant digits
    for (const [size, lh, name] of [[12, 14.5156, "caption"], [24, 29.0469, "body"], [28, 33.875, "subtitle"], [32, 38.7188, "title"], [48, 58.0781, "headline"], [56, 67.7656, "display"]] as const)
      expect(matchTextStyle(styles, size, lh, 400)?.name).toBe(name);
    expect(matchTextStyle(styles, 16, 20, 400)).toBeNull();
    expect(matchTextStyle(styles, 16.5, 19.359375, 400)).toBeNull();
    expect(matchTextStyle(styles, 16, null, 400)).toBeNull();
    expect(matchRichStyle(styles, 12, 400)?.name).toBe("caption");
  });
  it("answers CSS support questions through one interface", () => {
    expect(cssSupport.isAllowedProperty("mix-blend-mode")).toBe(false);
    expect(cssSupport.isAllowedProperty("outline")).toBe(false);
    expect(cssSupport.isAllowedProperty("cursor")).toBe(true);
    expect(cssSupport.allowedValuesFor("text-align")).toEqual(["left", "center", "right", "start", "end"]);
    expect(cssSupport.isInitialValue("border-image-source", "none")).toBe(true);
    expect(cssSupport.isInitialValue("outline-style", "solid")).toBe(false);
    expect(cssSupport.isAllowedFunction("clamp")).toBe(false);
    expect(cssSupport.isAllowedUnit("em")).toBe(false);
    expect(cssSupport.isAllowedUnit("rem")).toBe(true);
  });
  it("reads the kit font's character map and real faces", () => {
    const { cmap } = readFontFile(path.join(kit.dir, "fonts", "Inter_18pt-Regular.ttf"));
    expect(cmap).not.toBeNull();
    for (const ch of "AzÇĞİÖŞÜçğıöşü€") expect(cmap!.has(ch.codePointAt(0)!)).toBe(true);
    expect(cmap!.has("漢".codePointAt(0)!)).toBe(false);
    const faces = [{ family: "F", weightMin: 400, weightMax: 400, style: "normal", file: null, cmap: null }];
    expect(realFaces(faces, 400, false)).toHaveLength(1);
    expect(realFaces(faces, 700, false)).toHaveLength(0);
    expect(realFaces(faces, 400, true)).toHaveLength(0);
  });
  it("whitelists elements and input types", () => {
    expect(cssSupport.isAllowedElement("div", {})).toBe(true);
    expect(cssSupport.isAllowedElement("input", {})).toBe(true);
    expect(cssSupport.isAllowedElement("input", { type: "checkbox" })).toBe(true);
    expect(cssSupport.isAllowedElement("input", { type: "date" })).toBe(false);
    expect(cssSupport.isAllowedElement("table", {})).toBe(false);
    expect(cssSupport.isAllowedPseudoClass("hover")).toBe(true);
    expect(cssSupport.isAllowedPseudoClass("focus-visible")).toBe(false);
    expect(cssSupport.atRule("layer")).toBeNull();
    expect(cssSupport.atRule("import")).toBe("kit");
  });
  it("reads kit font names and weight ranges", () => {
    expect(readPostScriptName(path.join(kit.dir, "fonts", "Inter_18pt-Bold.ttf"))).toBe("Inter18pt-Bold");
    expect(readPostScriptName(path.join(kit.dir, "fonts", "OFL.txt"))).toBeNull();
    expect(weightRange("100 900")).toEqual([100, 900]);
    expect(weightRange("")).toEqual([400, 400]);
    expect(weightRange("bold")).toEqual([700, 700]);
  });
});
