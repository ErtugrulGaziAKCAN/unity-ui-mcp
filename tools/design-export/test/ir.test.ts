import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stableStringify } from "../src/ir/stableStringify.js";
import { validateIr } from "../src/ir/validate.js";
import { validateBoxes } from "../src/boxes/validate.js";

const contract = (name: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../contracts/${name}`, import.meta.url)), "utf8"));
const raw = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../contracts/${name}`, import.meta.url)), "utf8");

describe("IR contract", () => {
  it("accepts the shared sample", () => {
    expect(validateIr(contract("ir-sample.json"))).toEqual([]);
  });
  it("rejects another irVersion", () => {
    const ir = contract("ir-sample.json");
    ir.irVersion = 2;
    expect(validateIr(ir).join("\n")).toContain("irVersion");
  });
  it("rejects an unknown node kind and a bad shadow", () => {
    const ir = contract("ir-sample.json");
    ir.root.kind = "blob";
    expect(validateIr(ir).length).toBeGreaterThan(0);
    const ir2 = contract("ir-sample.json");
    ir2.root.shadow = { kind: "shadow9" };
    expect(validateIr(ir2).length).toBeGreaterThan(0);
  });
  it("sample exercises the contract surface", () => {
    const flat: any[] = [];
    const walk = (n: any) => { flat.push(n); n.children.forEach(walk); };
    walk(contract("ir-sample.json").root);
    expect(flat.some((n) => n.background)).toBe(true);
    expect(flat.some((n) => n.shadow)).toBe(true);
    expect(flat.some((n) => n.text?.key && n.text.en && n.text.args.length)).toBe(true);
    expect(flat.some((n) => n.bind)).toBe(true);
    expect(flat.some((n) => n.action)).toBe(true);
    expect(flat.some((n) => n.repeat)).toBe(true);
    expect(flat.some((n) => Object.keys(n.style.hover ?? {}).length)).toBe(true);
    expect(flat.some((n) => Object.keys(n.style).some((k) => k.startsWith("state:")))).toBe(true);
    expect(flat.some((n) => Object.keys(n.style).some((k) => k.startsWith("class:is-")))).toBe(true);
    expect(flat.some((n) => n.text?.style)).toBe(true);
    expect(flat.some((n) => n.repeat?.count > 1)).toBe(true);
    const anims = flat.flatMap((n) => n.anims);
    expect(anims.some((a) => a.kind === "transition" && a.phase === "leave" && a.timing.startsWith("cubic-bezier("))).toBe(true);
    expect(anims.some((a) => a.kind === "keyframes" && a.trigger === "show" && a.iterations === "infinite" && a.keyframes.some((k: any) => k.easing))).toBe(true);
    expect(flat.some((n) => Object.keys(n.style).some((k) => k.includes("+")))).toBe(true);
    expect(flat.some((n) => Object.keys(n.style).some((k) => k.startsWith("anc(")))).toBe(true);
    expect(flat.some((n) => Object.keys(n.attrTexts).length)).toBe(true);
    expect(flat.some((n) => n.initial)).toBe(true);
  });
  it("accepts the layer-key grammar and rejects malformed keys and per-kind animation fields", () => {
    const ir = contract("ir-sample.json");
    for (const k of ["bp:narrow+state:loading+class:is-a+anc(card):hover+active", "anc(row__2):class:is-selected", "state:x+focus"]) ir.root.style[k] = {};
    expect(validateIr(ir)).toEqual([]);
    for (const bad of ["hover+", "anc(card)hover", "pseudo:hover", "anc(card):visited"]) {
      const x = contract("ir-sample.json");
      x.root.style[bad] = {};
      expect(validateIr(x).length, bad).toBeGreaterThan(0);
    }
    const t = contract("ir-sample.json");
    const tr = t.root.children[2].anims[0];
    t.root.children[2].anims[0] = { ...tr, keyframes: [{ offset: 0, values: {}, easing: null }] };
    expect(validateIr(t).length).toBeGreaterThan(0);
    const k = contract("ir-sample.json");
    k.root.children[1].anims[0].name = null;
    expect(validateIr(k).length).toBeGreaterThan(0);
  });
  it("rejects untyped anims, unknown triggers and layers", () => {
    const ir = contract("ir-sample.json");
    ir.root.anims = [{ property: "opacity" }];
    expect(validateIr(ir).length).toBeGreaterThan(0);
    const ir2 = contract("ir-sample.json");
    const anim = ir2.root.children.flatMap((c: any) => c.anims)[0];
    ir2.root.anims = [{ ...anim, trigger: "focus-within" }];
    expect(validateIr(ir2).join("\n")).toContain("trigger");
    const ir3 = contract("ir-sample.json");
    ir3.root.style["sibling:x"] = {};
    expect(validateIr(ir3).length).toBeGreaterThan(0);
  });
  it("requires the matched text style and the repeat count", () => {
    const ir = contract("ir-sample.json");
    delete ir.root.children[0].text.style;
    expect(validateIr(ir).join("\n")).toContain("style");
    const ir2 = contract("ir-sample.json");
    const list = ir2.root.children.find((c: any) => c.repeat);
    delete list.repeat.count;
    expect(validateIr(ir2).join("\n")).toContain("count");
    const ir3 = contract("ir-sample.json");
    delete ir3.root.children[1].shadow.tint;
    expect(validateIr(ir3).join("\n")).toContain("tint");
  });
});

describe("boxes contract", () => {
  it("accepts the shared sample", () => {
    expect(validateBoxes(contract("boxes-sample.json"))).toEqual([]);
  });
  it("rejects a missing field", () => {
    const b = contract("boxes-sample.json");
    delete b.scale;
    expect(validateBoxes(b).length).toBeGreaterThan(0);
  });
});

describe("stableStringify", () => {
  it("sorts keys, indents by 2, ends with newline", () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe('{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n');
  });
  it("keeps array order", () => {
    expect(stableStringify({ a: [3, { z: 1, y: 2 }] })).toBe('{\n  "a": [\n    3,\n    {\n      "y": 2,\n      "z": 1\n    }\n  ]\n}\n');
  });
  it("shared fixtures are stable-stringified", () => {
    for (const f of ["ir-sample.json", "boxes-sample.json"]) expect(raw(f)).toBe(stableStringify(JSON.parse(raw(f))));
  });
});
