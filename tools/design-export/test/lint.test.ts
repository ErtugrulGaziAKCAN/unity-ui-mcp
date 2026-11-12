import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { readKit, type KitConfig } from "../src/kit.js";
import { openDesign } from "../src/load.js";
import { collectSnapshot, lint, RULES, sortFindings, type Finding } from "../src/lint/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => path.join(here, "fixtures", "lint", n);
const kit: KitConfig = readKit(fx("kit"));
/** Same kit with a second active locale (ar) whose font has no bold face. */
const localesKit: KitConfig = { ...kit, fontsCss: "fonts/locales.css" };
const KIT_FOR: Record<string, KitConfig> = { "W-FONT-001": localesKit };

const fixture = (id: string, kind: "pass" | "fail") => {
  const plain = `${id}.${kind}.html`;
  return fs.existsSync(fx(plain)) ? plain : `${id}.${kind}.dc.html`;
};

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

async function lintFile(file: string, k: KitConfig = kit): Promise<Finding[]> {
  const d = await openDesign(file, k, [2560, 1440], browser);
  try { return await lint(d, k); } finally { await d.close(); }
}

const show = (f: Finding[]) => f.map((x) => `${x.ruleId} ${x.path}: ${x.detail}`);

describe("lint rules: one pass and one fail fixture per rule", () => {
  for (const r of RULES) {
    it(`${r.id}: pass fixture has no findings`, async () => {
      const f = await lintFile(fx(fixture(r.id, "pass")), KIT_FOR[r.id] ?? kit);
      expect(show(f)).toEqual([]);
    });
    it(`${r.id}: fail fixture has exactly one ${r.id} finding with a fix, and nothing else`, async () => {
      const f = await lintFile(fx(fixture(r.id, "fail")), KIT_FOR[r.id] ?? kit);
      const mine = f.filter((x) => x.ruleId === r.id);
      expect(show(mine)).toHaveLength(1);
      expect(mine[0].severity).toBe(r.severity);
      expect(mine[0].fix.trim()).not.toBe("");
      expect(mine[0].detail.trim()).not.toBe("");
      expect(show(f.filter((x) => x.ruleId !== r.id))).toEqual([]);
    });
  }

  it("has fixtures for every rule and a rule for every fixture", () => {
    const ids = new Set(RULES.map((r) => r.id));
    expect(ids.size).toBe(RULES.length);
    const files = fs.readdirSync(fx(".")).filter((n) => /\.(pass|fail)(\.dc)?\.html$/.test(n));
    expect(new Set(files.map((n) => n.split(".")[0]))).toEqual(ids);
    for (const id of ids) for (const k of ["pass", "fail"] as const) expect(fs.existsSync(fx(fixture(id, k)))).toBe(true);
  });
});

describe("lint engine", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lint-"));
  const write = (dir: string, body: string, css = "") => {
    const p = path.join(dir, "s.html");
    fs.writeFileSync(p, `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}
      .screen{display:flex;flex-direction:column;width:2560px;height:1440px;font-family:"Inter UI";font-size:16.515625px;line-height:20px;color:#ffffff}
      p{margin:0}${css}</style></head><body><div class="screen" data-u-screen="s">${body}</div></body></html>`);
    return p;
  };

  it("rejects a Turkish dotted capital I in an id (never case-folds it)", async () => {
    const f = await lintFile(fx("U-MRK-005.fail.html"));
    expect(f).toHaveLength(1);
    expect(f[0].ruleId).toBe("U-MRK-005");
    expect(f[0].detail).toContain('data-u-id="gelen-kutusu-İ"');
    expect(f[0].path).toBe('[data-u-screen=lint.sample] > div[data-u-id="gelen-kutusu-İ"]');
  });

  it("returns warnings without errors for a design with only warnings", async () => {
    const f = await lintFile(fx("W-CSS-001.fail.html"));
    expect(f.length).toBeGreaterThan(0);
    expect(f.some((x) => x.severity === "error")).toBe(false);
  });

  it("reaches rules of other interaction and screen states, and resolves var()", async () => {
    const dir = tmp();
    try {
      const p = write(dir, `<div class="state-root"><div class="spinner" style="width:10px;height:10px"></div></div>
        <div class="card" style="width:10px;height:10px"></div><div class="tok" style="width:10px;height:10px"></div>`,
        `.state-loading .spinner{display:grid} .card:hover{border:1px dashed var(--line)} :root{--line:#ffffff;--d:grid} .tok{display:var(--d)}`);
      const f = await lintFile(p);
      expect(f.map((x) => [x.ruleId, x.path])).toEqual([
        ["U-CSS-001", "[data-u-screen=s] > div:0 > div:0"],
        ["U-CSS-021", "[data-u-screen=s] > div:1"],
        ["U-CSS-001", "[data-u-screen=s] > div:2"],
      ].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1)));
      expect(f.find((x) => x.ruleId === "U-CSS-021")!.detail).toContain("dashed");
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it("reports a dead rule at the rule itself and ignores data-u-external regions", async () => {
    const dir = tmp();
    try {
      const p = write(dir, `<div data-u-external data-u-id="shell" style="width:10px;height:10px"><p>Kabuk</p><div style="display:grid"></div></div>`,
        `.nowhere{float:left}`);
      const f = await lintFile(p);
      expect(f.map((x) => [x.ruleId, x.path])).toEqual([["U-CSS-017", "style:0 .nowhere"]]);
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it("treats list markers as generated content and accepts list-style: none", async () => {
    const dir = tmp();
    try {
      const li = '<ul style="margin:0;padding:0"><li data-l10n="s.item" data-en="Item">Öğe</li></ul>';
      const f = await lintFile(write(dir, li));
      expect(f.map((x) => [x.ruleId, x.path, x.detail])).toEqual([["U-CSS-002", "[data-u-screen=s] > ul:0 > li:0", "list item renders a ::marker (disc)"]]);
      expect(show(await lintFile(write(dir, li.replace("padding:0", "padding:0;list-style:none"))))).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it("sorts findings by path, then rule id", async () => {
    const dir = tmp();
    try {
      const p = write(dir, `<p>a</p><div style="display:grid;width:calc(1px + 2px)"></div>`);
      const f = await lintFile(p);
      expect(f).toEqual(sortFindings([...f].reverse()));
      // "[…] > div:1" sorts before "[…] > p:0"
      expect(f.map((x) => x.ruleId)).toEqual(["U-CSS-001", "U-CSS-005", "U-MRK-004"]);
    } finally { fs.rmSync(dir, { recursive: true }); }
  });
});

describe("collectSnapshot", () => {
  it("records paths, matched kit text styles and fonts, and leaves the page as it was", async () => {
    const d = await openDesign(fx("U-CSS-019.fail.html"), kit, [2560, 1440], browser);
    try {
      const html = await d.page.evaluate(() => document.documentElement.outerHTML);
      const s = await collectSnapshot(d.page, d.cdp, kit);
      expect(await d.page.evaluate(() => document.documentElement.outerHTML)).toBe(html);
      const title = s.elements.find((e) => e.attrs["data-l10n"] === "lint.sample.title")!;
      expect(title.path).toBe("[data-u-screen=lint.sample] > p:0");
      expect(title.textStyle).toBe("label");
      expect(title.computed["font-size"]).toBe("16.5156px");
      expect(title.textFonts[0]!.every((f) => f.isCustomFont)).toBe(true);
      const long = s.elements.find((e) => e.attrs["data-l10n"] === "lint.sample.long")!;
      expect(long.minAuto!.axis).toBe("row");
      expect(long.minAuto!.before.w).toBeGreaterThan(long.minAuto!.after.w);
      expect(s.elements[0].path).toBe("body");
      // the same snapshot lints to the same findings without reading the page again
      expect(await lint(d, kit, s)).toEqual(await lint(d, kit));
    } finally { await d.close(); }
  });

  it("lints a large screen in a few seconds on a warm browser", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-big-"));
    try {
      const rows = Array.from({ length: 150 }, (_, i) =>
        `<div class="row"${i === 0 ? ' data-u-repeat="rows"' : ""} data-u-id="row"><p data-u-bind="name">Oyuncu ${i}</p>` +
        `<p data-l10n="big.role" data-en="Role">Rol</p><div class="dot"></div></div>`).join("\n");
      const p = path.join(dir, "big.html");
      fs.writeFileSync(p, `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}
        .screen{display:flex;flex-direction:column;width:2560px;height:1440px;overflow:hidden;font-family:"Inter UI";font-size:16.515625px;line-height:20px;color:#ffffff;background-color:#0b1f26}
        .list{display:flex;flex-direction:column;flex-shrink:0} .row{display:flex;flex-direction:row;height:24px;flex-shrink:0;border-bottom:1px solid #16c2d5}
        .row:hover{background-color:#123c47} p{margin:0;flex-shrink:0} .dot{width:8px;height:8px;border-radius:4px;background-color:#16c2d5}
        @media (max-width: 1919px){.row{height:20px}}</style></head>
        <body><div class="screen" data-u-screen="big"><p data-l10n="big.title" data-en="Players">Oyuncular</p><div class="list">${rows}</div></div></body></html>`);
      const d = await openDesign(p, kit, [2560, 1440], browser);
      try {
        await lint(d, kit); // warm-up (CDP domains, caches)
        const t0 = performance.now();
        const s = await collectSnapshot(d.page, d.cdp, kit);
        const f = await lint(d, kit, s);
        const ms = performance.now() - t0;
        console.log(`[lint timing] ${s.elements.length} elements, ${s.rules.length} rules: ${ms.toFixed(0)} ms`, s.timings);
        expect(show(f)).toEqual([]);
        expect(ms).toBeLessThan(5000);
      } finally { await d.close(); }
    } finally { fs.rmSync(dir, { recursive: true }); }
  });
});
