import { describe, expect, it } from "vitest";
import { RULES } from "../src/lint/index.js";
import fs from "node:fs";
import { RULE_SUMMARIES } from "../src/lint/rule-table.js";
import { RESERVED_VIEW_MEMBERS, viewMember } from "../src/lint/rules/U-MRK-011.js";

describe("lint rule table", () => {
  it("has a summary and a fix for every rule in the registry", () => {
    const missing = RULES.map((r) => r.id).filter((id) => !RULE_SUMMARIES[id]?.when?.trim() || !RULE_SUMMARIES[id]?.fix?.trim());
    expect(missing).toEqual([]);
  });

  it("names only rules the registry has", () => {
    const ids = new Set(RULES.map((r) => r.id));
    expect(Object.keys(RULE_SUMMARIES).filter((id) => !ids.has(id))).toEqual([]);
  });

  it("covers the newer rules", () => {
    for (const id of ["U-CSS-031", "U-CSS-032", "U-CSS-033", "U-CSS-034", "U-CSS-035", "U-CSS-036", "U-CSS-037", "U-CSS-038", "U-CSS-039", "U-CSS-040", "U-CSS-041", "U-MRK-008", "U-MRK-009", "U-MRK-010", "U-MRK-011", "I-MRK-001"]) {
      expect(RULE_SUMMARIES[id], id).toBeDefined();
    }
  });

  it("marks warning and info rules in their summary", () => {
    for (const r of RULES) {
      if (r.severity === "warning") expect(RULE_SUMMARIES[r.id].when, r.id).toMatch(/\(warning\)/);
      if (r.severity === "info") expect(RULE_SUMMARIES[r.id].when, r.id).toMatch(/\(info\)/);
    }
  });

  it("U-MRK-011 names the members the compiler's view class reserves, as it names them", () => {
    const cs = fs.readFileSync(new URL("../../../packages/com.unity.design-ui/Editor/Compile/ViewCodeWriter.cs", import.meta.url), "utf8");
    const m = /static readonly string\[\] Reserved = \{([^}]*)\}/.exec(cs);
    expect(m).not.toBeNull();
    expect(Array.from(m![1].matchAll(/"([^"]+)"/g), (x) => x[1]).sort()).toEqual([...RESERVED_VIEW_MEMBERS].sort());
    // Naming.Pascal: parts split at . - _, first letter upper-cased, the rest kept
    expect(viewMember("state")).toBe("State");
    expect(viewMember("set-state")).toBe("SetState");
    expect(viewMember("screen_root")).toBe("ScreenRoot");
    expect(viewMember("fidelity.text-shadow")).toBe("FidelityTextShadow");
    expect(viewMember("get-hashCode")).toBe("GetHashCode");
  });
});
