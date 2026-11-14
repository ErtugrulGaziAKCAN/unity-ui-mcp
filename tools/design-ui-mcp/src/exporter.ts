// The only module that reaches into the exporter workspace (tools/design-export). Everything the server reuses from
// it (kit loading, the browser loader, lint and its CSS whitelist) comes through here; nothing is copied.
export { readKit, type KitConfig } from "../../design-export/src/kit.js";
export { openDesign, type LoadedDesign } from "../../design-export/src/load.js";
export { lint, RULES, type Finding, type Rule } from "../../design-export/src/lint/index.js";
export { CSS_SUPPORT_DATA, type CssSupportData, type PropertySupport } from "../../design-export/src/lint/allowed-css.js";
export { readTextStyles, type TextStyle } from "../../design-export/src/lint/text-styles.js";
export { renderRules } from "../../design-export/src/kit/rulesDoc.js";
export { rulesJson, splitSections, type RulesJson, type RulesSection } from "../../design-export/src/kit/rulesJson.js";
export { exportScreen as runExport, type ExportResult } from "../../design-export/src/export.js";
export { compareScreen as runCompare, readThresholds, summarizeIssues, type ScreenVerdict } from "../../design-export/src/compare/compare.js";
export { writeReport, writeVerdict } from "../../design-export/src/compare/report.js";
export { writeReportPictures, type ReportPictures } from "../../design-export/src/compare/pictures.js";
export { chromiumSandbox, type SandboxState } from "../../design-export/src/browser.js";
export { IR_VERSION } from "../../design-export/src/ir/types.js";
