// Writes ../chromium-kerning-line.json: Chromium's width in device px of one kerned line per (fontSize, weight) of the
// kit's text-style table, at every viewport of the kit, measured with the exporter's own page setup and kit fonts. The
// panel proof (LineBoxStyleTableTests) checks Unity's first layout against it. Run it again whenever the table changes:
//
//   npx tsx packages/com.unity.design-ui/Tests/Editor/Data/tools~/chromium-kerning-line.mts [kitDir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readKit } from "../../../../../../tools/design-export/src/kit.js";
import { openDesign } from "../../../../../../tools/design-export/src/load.js";
import { logicalViewport } from "../../../../../../tools/design-export/src/viewport.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../../../..");
const kitDir = path.resolve(process.argv[2] ?? path.join(repo, "design-kit"));
const kit = readKit(kitDir);
const text = "AVATAR Toyota Wave, Yavuz Tepe To";
const styles = JSON.parse(fs.readFileSync(path.join(kitDir, kit.textStyles), "utf8")) as Record<string, { fontSize: number; lineHeight: number; weight?: number }>;
const keys = [...new Set(Object.entries(styles).filter(([k]) => !k.startsWith("$")).map(([, s]) => `${s.fontSize}/${s.weight ?? 400}`))].sort();
const family = (fs.readFileSync(path.join(kitDir, kit.fontsCss), "utf8").match(/font-family:\s*"([^"]+)"/) ?? [])[1];
if (!family) throw new Error(`no @font-face family in ${kit.fontsCss}`);
const body = keys.map((k, i) => {
  const [size, weight] = k.split("/");
  return `<p style="position:absolute;left:0;top:${i * 100}px;margin:0;white-space:nowrap;font-size:${size}px;line-height:${Math.ceil(Number(size) * 1.5)}px;font-weight:${weight}" data-k="${k}">${text}</p>`;
}).join("\n");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kerning-line-"));
const html = path.join(dir, "line.html");
fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:"${family}"}</style></head><body><div style="position:relative;width:${kit.reference[0]}px;height:${Math.max(kit.reference[1], keys.length * 100)}px">${body}</div></body></html>`);
const widths: Record<string, Record<string, number>> = {};
try {
  for (const vp of kit.viewports) {
    const scale = logicalViewport(vp, kit.reference, kit.screenMatch).scale;
    const d = await openDesign(html, kit, vp);
    try {
      const rects = await d.page.evaluate(() => [...document.querySelectorAll("p[data-k]")].map((e) => [e.getAttribute("data-k"), e.getBoundingClientRect().width] as [string, number]));
      for (const [k, w] of rects) (widths[k] ??= {})[String(scale)] = Math.round(w * scale * 1e6) / 1e6;
    } finally { await d.close(); }
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
const out = {
  $comment: "Chromium's width in device px of one line of `text` per kit text style (fontSize/weight) at each viewport scale, kerning on, with the kit's fonts; written by tools~/chromium-kerning-line.mts from the kit's text-style table. The panel proof checks Unity's first layout against it.",
  text, family, widths,
};
fs.writeFileSync(path.join(here, "..", "chromium-kerning-line.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${keys.length} styles × ${kit.viewports.length} viewports`);
