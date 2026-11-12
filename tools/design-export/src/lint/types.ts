import type { KitConfig } from "../kit.js";
import type { DcDynamic, LoadedDesign } from "../load.js";
import type { KitFonts } from "./fonts.js";
import type { DomSnapshot } from "./snapshot.js";
import type { TextStyle } from "./text-styles.js";

export interface Finding { ruleId: string; severity: "error" | "warning"; path: string; detail: string; fix: string }

/** What a rule may read besides the snapshot: load results and kit data read at lint time. */
export interface LintContext {
  blocked: LoadedDesign["blocked"];
  missing: string[];
  unresolvedBlobs: string[];
  dynamic: DcDynamic[];
  textStyles: TextStyle[];
  fonts: KitFonts;
}

export interface Rule {
  id: string;
  severity: "error" | "warning";
  /** Pure function of its inputs. */
  check(s: DomSnapshot, kit: KitConfig, blocked: LoadedDesign["blocked"], ctx: LintContext): Finding[];
}
