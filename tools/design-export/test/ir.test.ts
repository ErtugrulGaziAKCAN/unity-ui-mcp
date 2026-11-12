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
