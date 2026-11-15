import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readKit } from "../src/kit.js";
import { CSS_SUPPORT_DATA, cssSupport, cssSupportDataFrom, cssSupportFrom, readCssSupportFile } from "../src/lint/allowed-css.js";
import { cssPaintOrder, unityPaintOrder, type PaintSibling } from "../src/lint/paint-order.js";
import { badKeywords } from "../src/lint/rules/U-CSS-023.js";
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
import { drawnSize, imageName, scaleOf } from "../src/lint/rules/W-IMG-001.js";
import type { DomSnapshot, SnapElement } from "../src/lint/snapshot.js";

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
  it("matches text styles by whole-pixel size, line height and weight", () => {
    const styles = readTextStyles(kit);
    expect(matchTextStyle(styles, 18, 22, 400)?.name).toBe("label");
    expect(matchTextStyle(styles, 18, 22, 700)?.name).toBe("label-bold");
    for (const [size, lh, name] of [[12, 15, "caption"], [24, 30, "body"], [28, 35, "subtitle"], [32, 36, "title"], [48, 54, "headline"], [56, 63, "display"]] as const)
      expect(matchTextStyle(styles, size, lh, 400)?.name).toBe(name);
    expect(matchTextStyle(styles, 16, 19.359375, 400)).toBeNull();
    expect(matchTextStyle(styles, 16.5, 20, 400)).toBeNull();
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

describe("css-support.json: the single source of CSS support", () => {
  const file = readCssSupportFile();
  it("is what the lint reads, property by property", () => {
    expect(Object.keys(CSS_SUPPORT_DATA.properties).sort()).toEqual(Object.keys(file.properties).sort());
    for (const [n, e] of Object.entries(file.properties)) {
      const p = CSS_SUPPORT_DATA.properties[n];
      expect(p.irHandling, n).toBe(e.handling);
      expect(p.handling, n).toBe(e.authoring?.handling ?? e.handling);
      for (const k of [...(e.keywords ?? []), ...(e.loweredValues ?? []), ...(e.dropValues ?? [])]) expect(p.keywords, n).toContain(k);
    }
    // a property read from another file: the lint follows the data, not code
    const other = cssSupportFrom(cssSupportDataFrom({ ...file, properties: { ...file.properties, "mix-blend-mode": { handling: "direct", keywords: ["normal", "multiply"] } } }));
    expect(other.isAllowedProperty("mix-blend-mode")).toBe(true);
    expect(cssSupport.isAllowedProperty("mix-blend-mode")).toBe(false);
  });
  it("keeps the Unity mapper's reading: IR units, colour functions, rule and fix on errors, a value form on direct entries", () => {
    expect(file.units).toEqual(["px", "%"]);
    expect(file.colors.functions).toEqual(["rgb", "rgba"]);
    for (const [n, e] of Object.entries(file.properties)) {
      if (e.handling === "error") { expect(e.rule, n).toMatch(/^U-CSS-\d{3}$/); expect(e.fix, n).toBeTruthy(); }
      if (e.handling === "direct") expect((e.keywords?.length ?? 0) + (e.types?.length ?? 0), n).toBeGreaterThan(0);
    }
  });
  it("gives every rejected keyword a rule and a fix, and every keyed property a value fix", () => {
    for (const [n, e] of Object.entries(file.properties)) {
      for (const [k, r] of Object.entries(e.rejectedValues ?? {})) { expect(r.rule, `${n}: ${k}`).toMatch(/^U-CSS-\d{3}$/); expect(r.fix, `${n}: ${k}`).toBeTruthy(); }
      if (e.handling !== "error" && (e.keywords?.length || e.types?.length) && !e.valueRule) expect(e.valueFix, n).toBeTruthy();
    }
    expect(cssSupport.rejection("display", "grid")).toMatchObject({ rule: "U-CSS-001" });
    expect(cssSupport.rejection("position", "sticky")).toMatchObject({ rule: "U-CSS-017" });
    expect(cssSupport.rejection("align-items", "baseline")).toMatchObject({ rule: "U-CSS-018" });
    expect(cssSupport.rejection("border-top-style", "dashed")).toMatchObject({ rule: "U-CSS-021" });
    expect(cssSupport.property("backdrop-filter")).toMatchObject({ handling: "error", rule: "U-CSS-007" });
    expect(cssSupport.fixFor("text-align")).toContain("left, center or right");
  });
  it("widens keywords to what the compiler lowers and marks export-resolved forms", () => {
    expect(cssSupport.allowedValuesFor("display")).toEqual(expect.arrayContaining(["flex", "none", "block", "inline", "inline-block", "inline-flex"]));
    expect(cssSupport.allowedValuesFor("position")).toEqual(expect.arrayContaining(["static", "relative", "absolute"]));
    expect(cssSupport.allowedValuesFor("overflow-y")).toEqual(expect.arrayContaining(["auto", "scroll", "clip"]));
    expect(cssSupport.property("transform")).toMatchObject({ handling: "lowered", irHandling: "error", valueRule: "U-CSS-025" });
    expect(file.exportResolved.units).toContain("rem");
    expect(cssSupport.isAllowedUnit("rem") && cssSupport.isAllowedFunction("var") && cssSupport.isAllowedFunction("hsl")).toBe(true);
    // a property with value types and no keyword takes no keyword
    expect(badKeywords(cssSupport.property("padding-left")!, "auto")).toEqual(["auto"]);
    expect(badKeywords(cssSupport.property("opacity")!, "50%")).toEqual(["50%"]);
    expect(badKeywords(cssSupport.property("border-top-width")!, "medium")).toEqual([]);
    expect(badKeywords(cssSupport.property("cursor")!, "pointer")).toEqual([]);
  });
  it("accepts initial-value resets and leaves out those the mapper rejects", () => {
    for (const [n, v] of [["outline-style", "none"], ["outline-width", "0px"], ["text-decoration-line", "none"], ["appearance", "none"], ["float", "none"], ["filter", "none"], ["text-transform", "none"]]) {
      expect(cssSupport.isInitialValue(n, v) || cssSupport.allowedValuesFor(n)?.includes(v), `${n}: ${v}`).toBe(true);
    }
    // filter is written to USS now (invert only), so an explicit filter: none stays in the IR; a rejected property's reset does not
    expect(cssSupport.omittedAtExport("filter", "none")).toBe(false);
    expect(cssSupport.omittedAtExport("backdrop-filter", "none")).toBe(true);
    expect(cssSupport.omittedAtExport("float", "inherit")).toBe(true);
    expect(cssSupport.omittedAtExport("text-decoration-line", "none")).toBe(true);
    expect(cssSupport.omittedAtExport("filter", "blur(2px)")).toBe(false);
    expect(cssSupport.omittedAtExport("transform", "none")).toBe(false); // split into translate/rotate/scale by the exporter
    expect(cssSupport.omittedAtExport("opacity", "1")).toBe(false);
  });
});

describe("paint order (the compiler's sibling order)", () => {
  const sib = (index: number, position: PaintSibling["position"], z: number | null = null, isolates = false): PaintSibling =>
    ({ index, name: `e${index}`, position, z, isolates });
  const order = (r: ReturnType<typeof unityPaintOrder>) => (r.ok ? r.order : r.problem);
  it("moves absolute siblings into the gap that gives them their CSS level", () => {
    expect(order(unityPaintOrder([sib(0, "absolute"), sib(1, "static"), sib(2, "relative")], false))).toEqual([1, 0, 2]);
    expect(order(unityPaintOrder([sib(0, "relative", 1), sib(1, "absolute")], false))).toEqual([1, 0]);
    expect(order(unityPaintOrder([sib(0, "static"), sib(1, "relative", 1), sib(2, "absolute", 0)], false))).toEqual([0, 2, 1]);
    expect(order(unityPaintOrder([sib(0, "absolute", -1), sib(1, "static")], false))).toEqual([0, 1]);
  });
  it("rejects what hierarchy order cannot reproduce", () => {
    expect(unityPaintOrder([sib(0, "absolute"), sib(1, "relative"), sib(2, "static")], false).ok).toBe(false);
    expect(order(unityPaintOrder([sib(0, "relative", 1), sib(1, "static")], false))).toMatch(/paints below e0/);
    expect(order(unityPaintOrder([sib(0, "static", 1)], false))).toMatch(/no effect in CSS/);
    expect(unityPaintOrder([sib(0, "static", 1)], true).ok).toBe(true); // a flex item stacks with its z-index
    expect(unityPaintOrder([sib(0, "static", 0), sib(1, "relative")], false).ok).toBe(true);
  });
  it("knows where CSS paints a faded or transformed sibling", () => {
    const sibs = [sib(0, "absolute"), sib(1, "static", null, true)];
    expect(cssPaintOrder(sibs, true)).toEqual([0, 1]);
    expect(order(unityPaintOrder(sibs, true))).toEqual([1, 0]);
    expect(cssPaintOrder([sib(0, "relative"), sib(1, "static")], false)).toEqual([1, 0]);
  });
});

describe("W-IMG-001 drawn size", () => {
  // a synthetic element: the snapshot's fields drawnSize and scaleOf read
  const el = (tag: string, size: { w: number; h: number }, image: { w: number; h: number; layer?: number }, computed: Record<string, string> = {}, parent = -1, index = 0) =>
    ({ tag, size, index, parent, image: { src: "assets/a.png", raster: true, ...image }, computed }) as unknown as SnapElement;
  const snap = (elements: SnapElement[], rules: unknown[] = [], keyframes: unknown[] = []) => ({ elements, rules, keyframes }) as unknown as DomSnapshot;

  it.each([
    ["img, fill: the content box", "img", { "object-fit": "fill" }, { w: 400, h: 200 }, { w: 400, h: 200 }],
    ["img, contain: the image's aspect inside the box", "img", { "object-fit": "contain" }, { w: 400, h: 400 }, { w: 400, h: 200 }],
    ["img, cover: the image's aspect over the box", "img", { "object-fit": "cover" }, { w: 400, h: 400 }, { w: 800, h: 400 }],
    ["img, none: the natural size", "img", { "object-fit": "none" }, { w: 100, h: 100 }, { w: 200, h: 100 }],
    ["img, scale-down: none when smaller", "img", { "object-fit": "scale-down" }, { w: 400, h: 400 }, { w: 200, h: 100 }],
    ["img with padding and borders: the content box", "img", { "padding-left": "10px", "padding-right": "10px", "border-left-width": "5px", "border-right-width": "5px" }, { w: 430, h: 200 }, { w: 400, h: 200 }],
    ["background, auto: the natural size", "div", { "background-size": "auto" }, { w: 400, h: 400 }, { w: 200, h: 100 }],
    ["background, cover", "div", { "background-size": "cover" }, { w: 400, h: 400 }, { w: 800, h: 400 }],
    ["background, contain", "div", { "background-size": "contain" }, { w: 400, h: 400 }, { w: 400, h: 200 }],
    ["background, percentages of the padding box", "div", { "background-size": "50% 25%" }, { w: 400, h: 400 }, { w: 200, h: 100 }],
    ["background, one auto keeps the aspect", "div", { "background-size": "300px auto" }, { w: 400, h: 400 }, { w: 300, h: 150 }],
    ["background, auto and a height", "div", { "background-size": "auto 50px" }, { w: 400, h: 400 }, { w: 100, h: 50 }],
  ])("%s", (_what, tag, computed, size, expected) => {
    expect(drawnSize(el(tag, size, { w: 200, h: 100 }, computed))).toEqual(expected);
  });

  it("takes the background-size of the image's own layer, a shorter list repeating", () => {
    // the url() is the second layer, behind a gradient
    expect(drawnSize(el("div", { w: 400, h: 400 }, { w: 200, h: 100, layer: 1 }, { "background-size": "cover, 40px 20px" }))).toEqual({ w: 40, h: 20 });
    expect(drawnSize(el("div", { w: 400, h: 400 }, { w: 200, h: 100, layer: 1 }, { "background-size": "40px 20px" }))).toEqual({ w: 40, h: 20 });
  });

  it("scales by the element's and its ancestors' transforms now and in every state and animation", () => {
    const parent = el("div", { w: 1000, h: 1000 }, { w: 1, h: 1 }, { scale: "1.25" }, -1, 0);
    const child = el("img", { w: 100, h: 100 }, { w: 100, h: 100 }, { transform: "matrix(1.2, 0, 0, 1.2, 0, 0)" }, 0, 1);
    expect(scaleOf(snap([parent, child]), 1)).toBeCloseTo(1.5, 6);
    // a hover rule's scale and a keyframe animation the element uses
    const hover = { selectors: [{ elements: [1] }], decls: [{ name: "scale", value: "1.1" }, { name: "animation-name", value: "pop, fade" }] };
    const pop = { name: "pop", frames: [{ key: "0%", decls: [{ name: "transform", value: "scale(1.4)" }] }, { key: "100%", decls: [{ name: "transform", value: "none" }] }] };
    expect(scaleOf(snap([parent, el("img", { w: 100, h: 100 }, { w: 100, h: 100 }, {}, 0, 1)], [hover], [pop]), 1)).toBeCloseTo(1.25 * 1.4, 6);
  });

  it("names a file without failing on a bare % and shortens a data URI", () => {
    expect(imageName("assets/50%.png")).toBe("50%.png");
    expect(imageName("assets/a%20b.png?v=1")).toBe("a b.png");
    expect(imageName("data:image/png;base64,iVBORw0KGgo=")).toBe("image/png data URI");
  });
});
