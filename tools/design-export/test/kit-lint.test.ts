import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/browser.js";
import { lintScreen } from "../src/export.js";
import { openDesign } from "../src/load.js";
import { cssSupport, enabledFilterFunctions } from "../src/lint/allowed-css.js";
import { readKit, type KitConfig } from "../src/kit.js";
import { kitStylesheet } from "../src/kit/claudeDesignSystem.js";
import { EXAMPLE_STYLESHEET_LINE, renderRules } from "../src/kit/rulesDoc.js";
import type { Finding } from "../src/lint/index.js";

// Every kit component, every fidelity fixture and the examples in RULES.md / the Claude README lint clean against the
// kit. The repo kit has no fonts until kit sync writes them from a Unity project, so a copy gets the font files a sync
// of the sample project writes (family "Inter UI", 400 and 700).

const here = path.dirname(fileURLToPath(import.meta.url));
const KIT_DIR = path.resolve(here, "../../../design-kit");
const TEST_FONTS = path.join(here, "fixtures", "lint", "kit", "fonts");
/** Fixtures the fidelity suite skips for now, with the reason (fidelity's fixture list reads the same file). */
const PENDING: Record<string, string> = JSON.parse(fs.readFileSync(path.join(KIT_DIR, "fixtures", "fidelity", "pending.json"), "utf8"));

const tmpDirs: string[] = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kit-lint-"))); tmpDirs.push(d); return d; };

function lintKitDir(): string {
  if (fs.existsSync(path.join(KIT_DIR, "fonts", "fonts.css"))) return KIT_DIR;
  const dir = tmp();
  for (const f of ["kit.config.json", "tokens.css", "text-styles.json", "base.css"]) fs.copyFileSync(path.join(KIT_DIR, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, "fonts"));
  for (const f of ["Inter_18pt-Regular.ttf", "Inter_18pt-Bold.ttf"]) fs.copyFileSync(path.join(TEST_FONTS, f), path.join(dir, "fonts", f));
  fs.writeFileSync(path.join(dir, "fonts", "fonts.css"),
    '@font-face { font-family: "Inter UI"; font-weight: 400; src: url("Inter_18pt-Regular.ttf") format("truetype"); }\n' +
    '@font-face { font-family: "Inter UI"; font-weight: 700; src: url("Inter_18pt-Bold.ttf") format("truetype"); }\n');
  return dir;
}

let browser: Browser;
let kit: KitConfig;
beforeAll(async () => { browser = await launchChromium(); kit = readKit(lintKitDir()); });
afterAll(async () => { await browser.close(); for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const lintFile = async (file: string, k: KitConfig = kit): Promise<Finding[]> => (await lintScreen(file, k, { browser })).findings;
const show = (f: Finding[]) => f.map((x) => `${x.severity} ${x.ruleId} ${x.path}: ${x.detail}`);
const html = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith(".html")).sort().map((f) => path.join(dir, f));
const components = html(path.join(KIT_DIR, "components"));
const fixtures = html(path.join(KIT_DIR, "fixtures", "fidelity"));

describe("kit components lint clean", () => {
  it("there are the nine components", () => {
    expect(components.map((f) => path.basename(f, ".html"))).toEqual(
      ["button", "card", "dialog", "dropdown", "list-row", "scroll-area", "tabs", "text-field", "toggle"]);
  });
  for (const file of components) {
    it(path.basename(file), async () => { expect(show(await lintFile(file))).toEqual([]); });
  }
});

describe("fidelity fixtures lint clean", () => {
  it("there is one fixture per feature group", () => {
    expect(fixtures.map((f) => path.basename(f, ".html"))).toEqual([
      "background-images", "colors-gradients", "controls", "filters", "half-pixel-frame", "icons", "initial-trigger", "keyframes", "layout", "letter-spacing", "object-fit",
      "pseudo-states", "repeat-items", "shadows-radii-borders", "sizing-visibility", "stacked-text", "states", "text-row", "text-shadow", "text-spacing", "text-styles",
      "transitions",
    ]);
  });
  for (const file of fixtures.filter((f) => !PENDING[path.basename(f)])) {
    it(path.basename(file), async () => { expect(show(await lintFile(file))).toEqual([]); });
  }

  it("pending.json names only fixtures, each with a note", () => {
    for (const [name, note] of Object.entries(PENDING)) {
      expect(fixtures.map((f) => path.basename(f)), name).toContain(name);
      expect(note).toMatch(/pending/);
    }
  });

  it("the lint-only page fails every rejected filter function with U-CSS-015 and css-support.json's fix", async () => {
    const page = path.join(KIT_DIR, "fixtures", "lint", "filters-rejected.html");
    const found = await lintFile(page);
    const fns = ["blur", "contrast", "grayscale", "hue-rotate", "opacity", "sepia", "brightness", "saturate", "drop-shadow", "url"];
    expect(found.map((f) => f.ruleId)).toEqual(fns.map(() => "U-CSS-015"));
    for (const fn of fns) {
      const f = found.find((x) => x.path.endsWith(`[data-u-id=tile-${fn}]`));
      expect(f, `${fn}: still rejected? (remove its tile once css-support.json enables it)`).toBeDefined();
      expect(f!.detail).toContain(`(${fn})`);
      expect(f!.fix).toBe(cssSupport.fixFor("filter"));
    }
    // the kit's filterFunctions cannot widen what css-support.json enables
    const widened = await lintFile(page, { ...kit, filterFunctions: [...fns, "invert"] });
    expect(widened.map((f) => f.ruleId)).toEqual(found.map((f) => f.ruleId));
  });

  it("filters.html uses only the functions css-support.json enables", () => {
    const used = Array.from(fs.readFileSync(fixtures.find((f) => f.endsWith("filters.html"))!, "utf8").matchAll(/filter:\s*([a-z-]+)\(/g), (m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const fn of used) expect(enabledFilterFunctions()).toContain(fn);
  });
});

describe("the kit base stylesheet", () => {
  it("neutralises every browser default lint reports (U-CSS-026) and sizes every box as border-box, for every allowed element", async () => {
    const dir = tmp();
    fs.copyFileSync(path.join(KIT_DIR, "fixtures", "fidelity", "assets", "quadrants-16x9.png"), path.join(dir, "pic.png"));
    const base = fs.readFileSync(path.join(KIT_DIR, "base.css"), "utf8");
    const t = (k: string, tag = "p") => `<${tag} data-l10n="base.${k}" data-en="${k}">${k}</${tag}>`;
    const inputs = ["text", "search", "password", "number", "email", "tel", "url"].map((type) =>
      `<input type="${type}" data-u-id="in-${type}" placeholder="yaz" data-l10n-placeholder="base.ph-${type}" data-en-placeholder="type">`).join("");
    const page = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><style>\n${base}\n` +
      ".screen { display: flex; flex-direction: column; width: 2560px; height: 1440px; position: relative; }\n" +
      "</style></head><body><div class=\"screen\" data-u-screen=\"base.elements\">" +
      ["h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "label", "section", "header", "footer", "nav", "main", "aside", "article"].map((tag) => t(tag, tag)).join("") +
      `<p data-l10n="base.rich" data-en="plain bold strong">düz <b>kalın</b> <strong>güçlü</strong></p>` +
      `<ul><li data-l10n="base.ul" data-en="item">öğe</li></ul><ol><li data-l10n="base.ol" data-en="item">öğe</li></ol>` +
      `<a data-u-id="link" data-u-action="open" data-l10n="base.a" data-en="link">bağlantı</a>` +
      `<button data-u-id="btn" data-u-action="go" data-l10n="base.button" data-en="button">düğme</button>` +
      inputs + `<input type="checkbox" data-u-id="chk"><input type="radio" data-u-id="rad">` +
      `<textarea data-u-id="area" placeholder="yaz" data-l10n-placeholder="base.ph-area" data-en-placeholder="type"></textarea>` +
      `<select data-u-id="sel"><option data-l10n="base.opt" data-en="option">seçenek</option></select>` +
      `<img src="pic.png" width="160" height="90"><svg width="24" height="24" viewBox="0 0 24 24"><path d="M2 2 L22 22" stroke="currentColor"/></svg>` +
      "</div></body></html>";
    fs.writeFileSync(path.join(dir, "elements.html"), page);
    const found = await lintFile(path.join(dir, "elements.html"));
    expect(show(found.filter((f) => f.ruleId === "U-CSS-026" || f.ruleId === "U-CSS-036"))).toEqual([]);
  });
});

describe("kit pages fit the reference artboard with the kit's text styles", () => {
  for (const file of [...components, ...fixtures]) {
    it(path.relative(KIT_DIR, file), async () => {
      const d = await openDesign(file, kit, kit.reference, browser);
      try {
        const r = await d.page.evaluate(() => {
          const root = document.querySelector("[data-u-screen]") as HTMLElement;
          // a text sample wider than its own box would overlap its neighbour
          const spill = Array.from(document.querySelectorAll<HTMLElement>(".sample")).filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.dataset.uId);
          return { w: root.scrollWidth, h: root.scrollHeight, spill };
        });
        expect(r).toEqual({ w: kit.reference[0], h: kit.reference[1], spill: [] });
      } finally { await d.close(); }
    });
  }
});

/** The ```html block after the "## Example" heading. */
const exampleOf = (md: string): string => {
  const at = md.indexOf("## Example");
  const m = /```html\n([\s\S]*?)\n```/.exec(md.slice(at));
  if (at < 0 || !m) throw new Error("no example block");
  return m[1];
};

describe("documented examples lint clean", () => {
  it("the RULES.md example screen", async () => {
    const md = renderRules(readKit(KIT_DIR), "kit");
    expect(md).toBe(fs.readFileSync(path.join(KIT_DIR, "RULES.md"), "utf8"));
    const dir = tmp();
    // the example names the base stylesheet shown above it instead of repeating it
    expect(md.split(fs.readFileSync(path.join(KIT_DIR, "base.css"), "utf8").trim())).toHaveLength(2);
    fs.writeFileSync(path.join(dir, "example.html"), exampleOf(md).replace(EXAMPLE_STYLESHEET_LINE("kit"), fs.readFileSync(path.join(KIT_DIR, "base.css"), "utf8").trim()));
    expect(show(await lintFile(path.join(dir, "example.html")))).toEqual([]);
  });

  it("the Claude README example artboard (.dc.html)", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "example.dc.html"), exampleOf(renderRules(kit, "claude")).replace(EXAMPLE_STYLESHEET_LINE("claude"), kitStylesheet(kit)));
    expect(show(await lintFile(path.join(dir, "example.dc.html")))).toEqual([]);
  });

  it("a kit component written as a Claude artboard the README's way (kit stylesheet in <helmet>, markup in <x-dc>)", async () => {
    const src = fs.readFileSync(components.find((f) => f.endsWith("button.html"))!, "utf8");
    const style = /<style>([\s\S]*?)<\/style>/.exec(src)![1];
    const body = /<body>([\s\S]*?)<\/body>/.exec(src)![1];
    const own = style.slice(style.indexOf("/* kit-base: end */") + "/* kit-base: end */".length);
    const dc = `<!doctype html><html><head><meta charset="utf-8"><script src="./support.js"></script></head><body><x-dc><helmet><style>\n` +
      `${kitStylesheet(kit)}\n${own}</style></helmet>${body}</x-dc>` +
      `<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":2560,"height":1440}}'>class Component extends DCLogic { renderVals(){ return {}; } }</script></body></html>`;
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "button.dc.html"), dc);
    expect(show(await lintFile(path.join(dir, "button.dc.html")))).toEqual([]);
  });
});
