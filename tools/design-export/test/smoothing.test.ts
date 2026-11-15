import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/browser.js";
import { readKit, type KitConfig } from "../src/kit.js";
import { openDesign } from "../src/load.js";
import { lint, type Finding } from "../src/lint/index.js";

// Text renders with grayscale smoothing (no macOS stem dilation), as UI Toolkit draws it: lint requires the computed
// -webkit-font-smoothing: antialiased on every text-bearing element (U-CSS-038); the goldens are screenshots of the
// same page, so they render with it too.

const here = path.dirname(fileURLToPath(import.meta.url));
const kit: KitConfig = readKit(path.join(here, "fixtures", "lint", "kit"));
const tmpDirs: string[] = [];
let browser: Browser;
beforeAll(async () => { browser = await launchChromium(); });
afterAll(async () => { await browser.close(); for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const page = (css: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0}
.screen{display:flex;flex-direction:column;width:2560px;height:1440px;position:relative;font-family:"Inter UI";font-size:18px;line-height:22px;color:#ffffff;background-color:#0b1f26}
p{margin:0}
${css}
</style></head><body><div class="screen" data-u-screen="smooth">${body}</div></body></html>`;
const texts = '<p data-l10n="s.a" data-en="A">Bir</p><p data-l10n="s.b" data-en="B">İki</p><input type="text" data-u-id="field" value="üç" data-u-bind="v">';

async function lintPage(html: string): Promise<Finding[]> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smooth-")));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "s.html"), html);
  const d = await openDesign(path.join(dir, "s.html"), kit, [2560, 1440], browser);
  try { return (await lint(d, kit)).filter((f) => f.ruleId === "U-CSS-038"); } finally { await d.close(); }
}

describe("U-CSS-038: text renders with -webkit-font-smoothing: antialiased", () => {
  it("one finding on the screen root when nothing sets it, with the base stylesheet as the fix", async () => {
    const f = await lintPage(page("", texts));
    expect(f).toHaveLength(1);
    expect(f[0].path).toBe("[data-u-screen=smooth]");
    expect(f[0].severity).toBe("error");
    expect(f[0].detail).toMatch(/-webkit-font-smoothing: auto/);
    expect(f[0].fix).toMatch(/base stylesheet/);
    expect(f[0].fix).toMatch(/-webkit-font-smoothing: antialiased/);
  });

  it("clean when :root, html or the screen sets it, since it inherits to every text and control", async () => {
    for (const css of [":root{-webkit-font-smoothing:antialiased}", "body{-webkit-font-smoothing:antialiased}", ".screen{-webkit-font-smoothing:antialiased}"]) {
      expect(await lintPage(page(css, texts)), css).toEqual([]);
    }
  });

  it("names each text element that overrides it, and the control whose text would draw thicker", async () => {
    const f = await lintPage(page(":root{-webkit-font-smoothing:antialiased} .thick{-webkit-font-smoothing:subpixel-antialiased} input{-webkit-font-smoothing:auto}",
      '<p class="thick" data-l10n="s.a" data-en="A">Bir</p><p data-l10n="s.b" data-en="B">İki</p><input type="text" data-u-id="field" value="üç" data-u-bind="v">'));
    expect(f.map((x) => x.detail).sort()).toEqual([
      "text renders with -webkit-font-smoothing: auto",
      "text renders with -webkit-font-smoothing: subpixel-antialiased",
    ]);
  });

  it("a page without text needs nothing", async () => {
    expect(await lintPage(page("", '<div style="width:10px;height:10px;background-color:#ffffff"></div>'))).toEqual([]);
  });

  it("the page the goldens are captured from keeps the design's smoothing (the loader adds nothing that changes it)", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smooth-")));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, "s.html"), page(":root{-webkit-font-smoothing:antialiased}", texts));
    const d = await openDesign(path.join(dir, "s.html"), kit, [1920, 1080], browser);
    try {
      const values = await d.page.evaluate(() => Array.from(document.querySelectorAll("p, input")).map((e) => getComputedStyle(e).getPropertyValue("-webkit-font-smoothing")));
      expect(values).toEqual(["antialiased", "antialiased", "antialiased"]);
    } finally { await d.close(); }
  });
});
