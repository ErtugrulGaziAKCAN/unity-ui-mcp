// Rewrites the default-state goldens of a copy of an export as Chromium draws them without macOS font smoothing
// (`-webkit-font-smoothing: antialiased` on every element), with the exporter's own page setup, kit and viewports. The
// boxes stay: smoothing changes no layout. Compare a Unity capture against the copy to see the renderer difference
// that is left once the smoothing is gone (docs/findings/text-ink.md).
//
//   npx tsx docs/findings/text-ink/smoothing-off-goldens.ts <design.html> <kitDir> <exportCopyDir>
import fs from "node:fs";
import path from "node:path";
import { readKit } from "../../../tools/design-export/src/kit.js";
import { openDesign } from "../../../tools/design-export/src/load.js";

const [html, kitDir, exportDir] = process.argv.slice(2);
if (!html || !kitDir || !exportDir) throw new Error("usage: smoothing-off-goldens.ts <design.html> <kitDir> <exportCopyDir>");
const kit = readKit(kitDir);
const matrix = JSON.parse(fs.readFileSync(path.join(exportDir, "goldens", "matrix.json"), "utf8")) as {
  captures: { name: string; state: string; viewport: [number, number]; apply: unknown[]; anim: unknown }[];
};
for (const job of matrix.captures) {
  if (job.state !== "default" || job.apply.length || job.anim) continue;
  const d = await openDesign(html, kit, job.viewport);
  try {
    await d.page.addStyleTag({ content: "* { -webkit-font-smoothing: antialiased !important; }" });
    fs.writeFileSync(path.join(exportDir, "goldens", `${job.name}.png`), await d.page.screenshot({ type: "png", caret: "initial" }));
    console.log(`rewrote ${job.name}`);
  } finally {
    await d.close();
  }
}
