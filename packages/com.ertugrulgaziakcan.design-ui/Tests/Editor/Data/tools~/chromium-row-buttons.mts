// Writes ../chromium-row-buttons.json: Chromium's width of the text of each of a row of ten text-sized buttons (TextFitTests'
// row: body bold 24 px text in a <button> as the kit writes it), in device px at every viewport of the kit (exact and
// scaled), measured with the exporter's own page setup and kit fonts. The panel test lays the golden's row out from them
// (the exporter's pageTextCeil rule) and checks Unity's DesignButtons against it. Run it again when the words or the kit's
// fonts change:
//
//   npx tsx packages/com.ertugrulgaziakcan.design-ui/Tests/Editor/Data/tools~/chromium-row-buttons.mts [kitDir]
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
const words = ["Onayla", "Vazgeç", "Kaydet", "Geri", "Sil", "Paylaş", "Yenile", "Düzenle", "Ekle", "Kapat"];
const family = (fs.readFileSync(path.join(kitDir, kit.fontsCss), "utf8").match(/font-family:\s*"([^"]+)"/) ?? [])[1];
if (!family) throw new Error(`no @font-face family in ${kit.fontsCss}`);
// a <button> as the kit's button component writes it (its text's width is ceiled to whole device pixels there, as in the
// kit's goldens; a <div> flex container's anonymous text is not)
const button = "appearance:none;background-color:transparent;color:inherit;font-family:inherit;flex-shrink:0;box-sizing:border-box;height:64px;padding:0 32px;border:4px solid #ffffff;margin:0 24px 0 0;font-size:24px;line-height:32px;font-weight:700;white-space:nowrap;display:flex;align-items:center";
const row = words.map((w, i) => `<button data-i="${i}" style="${button}">${w}</button>`).join("");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "row-buttons-"));
const html = path.join(dir, "row.html");
fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:"${family}";color:#ffffff;background:#0b1f26}</style></head><body>` +
  `<div style="position:relative;width:${kit.reference[0]}px;height:${kit.reference[1]}px"><div style="position:absolute;left:64px;top:100px;display:flex;flex-direction:row;align-items:center">${row}</div></div></body></html>`);
const viewports = kit.viewports; // exact and scaled
const x: Record<string, number[]> = {};
try {
  for (const vp of viewports) {
    const scale = logicalViewport(vp, kit.reference, kit.screenMatch).scale;
    const d = await openDesign(html, kit, vp);
    try {
      const widths = await d.page.evaluate(() => [...document.querySelectorAll("button[data-i]")].map((e) => {
        const range = document.createRange();
        range.selectNodeContents(e);
        return range.getBoundingClientRect().width;
      }));
      x[`${vp[0]}x${vp[1]}`] = widths.map((w) => Math.round(w * scale * 1e6) / 1e6);
    } finally { await d.close(); }
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
const out = {
  $comment: "Chromium's text width in device px of each button of TextFitTests' row of ten (body bold 24 px in a <button>) per viewport; written by tools~/chromium-row-buttons.mts with the kit's fonts.",
  words, family, widths: x,
};
fs.writeFileSync(path.join(here, "..", "chromium-row-buttons.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${words.length} buttons × ${viewports.length} viewports`);
