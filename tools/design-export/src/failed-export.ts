/**
 * An export whose capture failed is not thrown away: its folder (the IR, the goldens finished so far and their
 * boxes.jsonl lines) is kept beside the output folder as `<outDir>.failed`, with EXPORT_FAILURE_FILE saying why. One per
 * output folder: a newer failure replaces it, a successful export removes it. It is never an export: it has no
 * export-report.json, the comparison refuses it, and nothing reads it as one.
 */
export const failedExportDir = (outDir: string): string => `${outDir}.failed`;
/** Written into the kept folder: what failed, the error and how many captures were finished. */
export const EXPORT_FAILURE_FILE = "export-failure.json";
