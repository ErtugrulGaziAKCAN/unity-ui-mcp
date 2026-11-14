import type { KitConfig } from "../kit.js";
import type { LoadedDesign } from "../load.js";
import { kitFonts } from "./fonts.js";
import { collectSnapshot, type DomSnapshot } from "./snapshot.js";
import { readTextStyles } from "./text-styles.js";
import type { Finding, LintContext, Rule } from "./types.js";
import { rule as U_CSS_001 } from "./rules/U-CSS-001.js";
import { rule as U_CSS_002 } from "./rules/U-CSS-002.js";
import { rule as U_CSS_003 } from "./rules/U-CSS-003.js";
import { rule as U_CSS_004 } from "./rules/U-CSS-004.js";
import { rule as U_CSS_005 } from "./rules/U-CSS-005.js";
import { rule as U_CSS_006 } from "./rules/U-CSS-006.js";
import { rule as U_CSS_007 } from "./rules/U-CSS-007.js";
import { rule as U_CSS_008 } from "./rules/U-CSS-008.js";
import { rule as U_CSS_009 } from "./rules/U-CSS-009.js";
import { rule as U_CSS_010 } from "./rules/U-CSS-010.js";
import { rule as U_CSS_011 } from "./rules/U-CSS-011.js";
import { rule as U_CSS_012 } from "./rules/U-CSS-012.js";
import { rule as U_CSS_013 } from "./rules/U-CSS-013.js";
import { rule as U_CSS_014 } from "./rules/U-CSS-014.js";
import { rule as U_CSS_015 } from "./rules/U-CSS-015.js";
import { rule as U_CSS_016 } from "./rules/U-CSS-016.js";
import { rule as U_CSS_017 } from "./rules/U-CSS-017.js";
import { rule as U_CSS_018 } from "./rules/U-CSS-018.js";
import { rule as U_CSS_019 } from "./rules/U-CSS-019.js";
import { rule as U_CSS_020 } from "./rules/U-CSS-020.js";
import { rule as U_CSS_021 } from "./rules/U-CSS-021.js";
import { rule as U_CSS_022 } from "./rules/U-CSS-022.js";
import { rule as U_CSS_023 } from "./rules/U-CSS-023.js";
import { rule as U_CSS_024 } from "./rules/U-CSS-024.js";
import { rule as U_CSS_025 } from "./rules/U-CSS-025.js";
import { rule as U_CSS_026 } from "./rules/U-CSS-026.js";
import { rule as U_CSS_027 } from "./rules/U-CSS-027.js";
import { rule as U_CSS_028 } from "./rules/U-CSS-028.js";
import { rule as U_CSS_029 } from "./rules/U-CSS-029.js";
import { rule as U_CSS_030 } from "./rules/U-CSS-030.js";
import { rule as U_CSS_031 } from "./rules/U-CSS-031.js";
import { rule as U_CSS_032 } from "./rules/U-CSS-032.js";
import { rule as U_CSS_033 } from "./rules/U-CSS-033.js";
import { rule as U_CSS_034 } from "./rules/U-CSS-034.js";
import { rule as U_CSS_035 } from "./rules/U-CSS-035.js";
import { rule as U_CSS_036 } from "./rules/U-CSS-036.js";
import { rule as U_CSS_037 } from "./rules/U-CSS-037.js";
import { rule as U_CSS_038 } from "./rules/U-CSS-038.js";
import { rule as U_CSS_039 } from "./rules/U-CSS-039.js";
import { rule as U_CSS_040 } from "./rules/U-CSS-040.js";
import { rule as U_CSS_041 } from "./rules/U-CSS-041.js";
import { rule as U_CSS_042 } from "./rules/U-CSS-042.js";
import { rule as U_CSS_043 } from "./rules/U-CSS-043.js";
import { rule as I_MRK_001 } from "./rules/I-MRK-001.js";
import { rule as U_DC_001 } from "./rules/U-DC-001.js";
import { rule as U_DC_002 } from "./rules/U-DC-002.js";
import { rule as U_DC_003 } from "./rules/U-DC-003.js";
import { rule as U_DC_004 } from "./rules/U-DC-004.js";
import { rule as U_DC_005 } from "./rules/U-DC-005.js";
import { rule as U_FONT_001 } from "./rules/U-FONT-001.js";
import { rule as U_FONT_002 } from "./rules/U-FONT-002.js";
import { rule as U_FONT_003 } from "./rules/U-FONT-003.js";
import { rule as U_MRK_001 } from "./rules/U-MRK-001.js";
import { rule as U_MRK_002 } from "./rules/U-MRK-002.js";
import { rule as U_MRK_003 } from "./rules/U-MRK-003.js";
import { rule as U_MRK_004 } from "./rules/U-MRK-004.js";
import { rule as U_MRK_005 } from "./rules/U-MRK-005.js";
import { rule as U_MRK_006 } from "./rules/U-MRK-006.js";
import { rule as U_MRK_007 } from "./rules/U-MRK-007.js";
import { rule as U_MRK_008 } from "./rules/U-MRK-008.js";
import { rule as U_MRK_009 } from "./rules/U-MRK-009.js";
import { rule as U_MRK_010 } from "./rules/U-MRK-010.js";
import { rule as U_MRK_011 } from "./rules/U-MRK-011.js";
import { rule as U_MRK_012 } from "./rules/U-MRK-012.js";
import { rule as U_NET_001 } from "./rules/U-NET-001.js";
import { rule as U_NET_002 } from "./rules/U-NET-002.js";
import { rule as W_FONT_001 } from "./rules/W-FONT-001.js";
import { rule as W_FONT_002 } from "./rules/W-FONT-002.js";

export type { Finding, LintContext, Rule, Severity } from "./types.js";
export { collectSnapshot, SNAP_COMPUTED, type DomSnapshot, type SnapElement, type SnapRule, type SnapSelector } from "./snapshot.js";

/** Every rule, by id. */
export const RULES: readonly Rule[] = [
  U_CSS_001,
  U_CSS_002,
  U_CSS_003,
  U_CSS_004,
  U_CSS_005,
  U_CSS_006,
  U_CSS_007,
  U_CSS_008,
  U_CSS_009,
  U_CSS_010,
  U_CSS_011,
  U_CSS_012,
  U_CSS_013,
  U_CSS_014,
  U_CSS_015,
  U_CSS_016,
  U_CSS_017,
  U_CSS_018,
  U_CSS_019,
  U_CSS_020,
  U_CSS_021,
  U_CSS_022,
  U_CSS_023,
  U_CSS_024,
  U_CSS_025,
  U_CSS_026,
  U_CSS_027,
  U_CSS_028,
  U_CSS_029,
  U_CSS_030,
  U_CSS_031,
  U_CSS_032,
  U_CSS_033,
  U_CSS_034,
  U_CSS_035,
  U_CSS_036,
  U_CSS_037,
  U_CSS_038,
  U_CSS_039,
  U_CSS_040,
  U_CSS_041,
  U_CSS_042,
  U_CSS_043,
  U_DC_001,
  U_DC_002,
  U_DC_003,
  U_DC_004,
  U_DC_005,
  U_FONT_001,
  U_FONT_002,
  U_FONT_003,
  U_MRK_001,
  U_MRK_002,
  U_MRK_003,
  U_MRK_004,
  U_MRK_005,
  U_MRK_006,
  U_MRK_007,
  U_MRK_008,
  U_MRK_009,
  U_MRK_010,
  U_MRK_011,
  U_MRK_012,
  U_NET_001,
  U_NET_002,
  W_FONT_001,
  W_FONT_002,
  I_MRK_001,
];

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Findings sorted by path, then rule id, then detail; exact duplicates removed. */
export function sortFindings(list: Finding[]): Finding[] {
  const seen = new Set<string>();
  return list
    .filter((f) => { const k = `${f.ruleId}\u0000${f.path}\u0000${f.detail}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => cmp(a.path, b.path) || cmp(a.ruleId, b.ruleId) || cmp(a.detail, b.detail));
}

/** Kit data and load results the rules read; built once per lint. */
export function lintContext(d: Pick<LoadedDesign, "blocked" | "missing" | "unresolvedBlobs" | "dynamic">, kit: KitConfig, s: DomSnapshot): LintContext {
  return {
    blocked: d.blocked, missing: d.missing, unresolvedBlobs: d.unresolvedBlobs, dynamic: d.dynamic,
    textStyles: readTextStyles(kit), fonts: kitFonts(kit, s.fontFaces),
  };
}

/** Runs every rule over a collected snapshot (pure apart from reading the kit's text styles, font map and font files). */
export function lintSnapshot(s: DomSnapshot, kit: KitConfig, d: Pick<LoadedDesign, "blocked" | "missing" | "unresolvedBlobs" | "dynamic">): Finding[] {
  const ctx = lintContext(d, kit, s);
  return sortFindings(RULES.flatMap((r) => r.check(s, kit, d.blocked, ctx)));
}

/**
 * Lints an open design. Pass the snapshot when the caller already collected one for this page (the exporter shares
 * it), so the page is read once.
 */
export async function lint(d: LoadedDesign, kit: KitConfig, snapshot?: DomSnapshot): Promise<Finding[]> {
  const s = snapshot ?? (await collectSnapshot(d.page, d.cdp, kit));
  return lintSnapshot(s, kit, d);
}
