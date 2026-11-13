import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/browser.js";
import { lintScreen } from "../src/export.js";
import { readKit, type KitConfig } from "../src/kit.js";
import { kitStylesheet } from "../src/kit/claudeDesignSystem.js";
import { renderRules } from "../src/kit/rulesDoc.js";
import type { Finding } from "../src/lint/index.js";

// Every kit component, every fidelity fixture and the examples in RULES.md / the Claude README lint clean against the
// kit. The repo kit has no fonts until kit sync writes them from a Unity project, so a copy gets the font files a sync
// of the sample project writes (family "Inter UI", 400 and 700).

const here = path.dirname(fileURLToPath(import.meta.url));
const KIT_DIR = path.resolve(here, "../../../design-kit");
const TEST_FONTS = path.join(here, "fixtures", "lint", "kit", "fonts");
/** CSS filter functions UI Toolkit 6.3 also offers: the filters fixture's candidates. */
const FILTER_CANDIDATES = ["blur", "contrast", "grayscale", "hue-rotate", "invert", "opacity", "sepia"];

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
      "colors-gradients", "controls", "filters", "icons", "keyframes", "layout", "object-fit", "pseudo-states",
      "shadows-radii-borders", "states", "text-shadow", "text-styles", "transitions",
    ]);
  });
  for (const file of fixtures.filter((f) => !f.endsWith("filters.html"))) {
    it(path.basename(file), async () => { expect(show(await lintFile(file))).toEqual([]); });
  }

  it("filters.html: clean once the kit lists UI Toolkit's filter functions; until then only U-CSS-015 with its fix", async () => {
    const file = fixtures.find((f) => f.endsWith("filters.html"))!;
    expect(show(await lintFile(file, { ...kit, filterFunctions: FILTER_CANDIDATES }))).toEqual([]);
    const shipped = await lintFile(file, { ...kit, filterFunctions: readKit(KIT_DIR).filterFunctions });
    expect(shipped.length).toBeGreaterThan(0);
    for (const f of shipped) { expect(f.ruleId).toBe("U-CSS-015"); expect(f.fix).toMatch(/filter/); }
  });

  it("CSS filter functions UI Toolkit lacks stay rejected with U-CSS-015 even with the candidates enabled", async () => {
    const dir = tmp();
    const file = path.join(dir, "screen.html");
    const src = fs.readFileSync(fixtures.find((f) => f.endsWith("filters.html"))!, "utf8")
      .replace(".f-blur { filter: blur(4px); }", ".f-blur { filter: brightness(1.2) saturate(2) drop-shadow(0 2px 4px #000000); }");
    fs.writeFileSync(file, src);
    const found = await lintFile(file, { ...kit, filterFunctions: FILTER_CANDIDATES });
    // one finding for the rule (its two elements are named in the detail)
    expect(found.map((f) => f.ruleId)).toEqual(["U-CSS-015"]);
    expect(found[0].detail).toMatch(/\(brightness, saturate, drop-shadow\)/);
    expect(found[0].fix).toMatch(/blur, contrast, grayscale, hue-rotate, invert, opacity, sepia/);
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
    fs.writeFileSync(path.join(dir, "example.html"), exampleOf(md));
    expect(show(await lintFile(path.join(dir, "example.html")))).toEqual([]);
  });

  it("the Claude README example artboard (.dc.html)", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "example.dc.html"), exampleOf(renderRules(kit, "claude")));
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
