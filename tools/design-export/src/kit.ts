import fs from "node:fs";
import path from "node:path";

export interface KitConfig {
  dir: string;
  fontsCss: string;
  tokensCss: string;
  textStyles: string;
  allowedScriptOrigins: string[];
  reference: [number, number];
  viewports: [number, number][];
  screenMatch: number;
  filterFunctions: string[];
  locales: string[];
}

export function readKit(kitDir: string): KitConfig {
  const dir = path.resolve(kitDir);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "kit.config.json"), "utf8"));
  for (const k of ["fontsCss", "tokensCss", "textStyles", "allowedScriptOrigins", "reference", "viewports", "screenMatch", "filterFunctions", "locales"]) {
    if (raw[k] === undefined) throw new Error(`kit.config.json is missing "${k}"`);
  }
  return { dir, ...raw } as KitConfig;
}
