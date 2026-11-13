import { describe, expect, it } from "vitest";
import { RULES } from "../src/lint/index.js";
import { RULE_SUMMARIES } from "../src/lint/rule-table.js";

describe("lint rule table", () => {
  it("has a summary and a fix for every rule in the registry", () => {
    const missing = RULES.map((r) => r.id).filter((id) => !RULE_SUMMARIES[id]?.when?.trim() || !RULE_SUMMARIES[id]?.fix?.trim());
    expect(missing).toEqual([]);
  });

  it("names only rules the registry has", () => {
    const ids = new Set(RULES.map((r) => r.id));
    expect(Object.keys(RULE_SUMMARIES).filter((id) => !ids.has(id))).toEqual([]);
  });

  it("covers the newer rules and describes U-CSS-004 as the sibling-order rule it is now", () => {
    for (const id of ["U-CSS-031", "U-CSS-032", "U-CSS-033", "U-CSS-034", "U-CSS-035", "U-CSS-036", "U-CSS-037", "U-MRK-008", "U-MRK-009", "U-MRK-010", "I-MRK-001"]) {
      expect(RULE_SUMMARIES[id], id).toBeDefined();
    }
    // not the old "z-index on an element that is not position: absolute"
    expect(RULE_SUMMARIES["U-CSS-004"].when).not.toMatch(/not `position: absolute`/);
    expect(RULE_SUMMARIES["U-CSS-004"].when).toMatch(/sibling order/);
    expect(RULE_SUMMARIES["U-CSS-004"].fix).toMatch(/flex items/);
  });

  it("marks warning and info rules in their summary", () => {
    for (const r of RULES) {
      if (r.severity === "warning") expect(RULE_SUMMARIES[r.id].when, r.id).toMatch(/\(warning\)/);
      if (r.severity === "info") expect(RULE_SUMMARIES[r.id].when, r.id).toMatch(/\(info\)/);
    }
  });
});
