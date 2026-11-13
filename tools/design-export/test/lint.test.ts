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
/** Same kit with an extra face whose file cannot be read (local()). */
const unreadableKit: KitConfig = { ...kit, fontsCss: "fonts/unreadable.css" };
const KIT_FOR: Record<string, { pass?: KitConfig; fail?: KitConfig }> = {
  "W-FONT-001": { pass: localesKit, fail: localesKit },
  "W-FONT-002": { fail: unreadableKit },
};

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
      const f = await lintFile(fx(fixture(r.id, "pass")), KIT_FOR[r.id]?.pass ?? kit);
      expect(show(f)).toEqual([]);
    });
    it(`${r.id}: fail fixture has exactly one ${r.id} finding with a fix, and nothing else`, async () => {
      const f = await lintFile(fx(fixture(r.id, "fail")), KIT_FOR[r.id]?.fail ?? kit);
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

/** Reviewer probe pages (rounds 1 and 2): each design must give exactly these rule ids. */
const PROBES: Record<string, string[]> = {
  "01-ua-margins-no-reset": ["U-CSS-026", "U-MRK-006"], "02-ua-button-native": ["U-CSS-026"], "03-shadow-dom": ["U-CSS-029"],
  "04-adopted-sheet": ["U-CSS-001", "U-CSS-015"], "05-container-query": ["U-CSS-028"], "06-layer": ["U-CSS-028"],
  "07-display-table": ["U-CSS-023", "U-CSS-029"], "08-justify-contents": ["U-CSS-023"], "09-property-calc": ["U-CSS-028"],
  "10-iframe": ["U-CSS-029"], "11-common-resets": [], "12-font-shorthand": [], "13-animation-shorthand": [],
  "14-misc-hints": [], "15-inline-svg": [], "16-link-flex-item": ["U-CSS-026"], "17-margin-collapse": ["U-CSS-030"], "18-br": [],
  "19-mixed-content": ["U-CSS-030", "U-MRK-004"], "20-object-fit-bg": [],
  "21-native-controls": ["U-CSS-016", "U-CSS-026", "U-CSS-029", "U-MRK-004"], "22-input-placeholder": ["U-CSS-026", "U-MRK-007"],
  "23-ua-color-hidden": ["U-CSS-016", "U-FONT-003"], "24-text-shadow-multi": ["U-CSS-023"], "25-italic-no-face": ["U-FONT-001"],
  "26-letter-em-logical": ["U-CSS-023"], "27-gradient-hint": ["U-CSS-022"], "28-transform-centre": ["U-CSS-025"],
  "29-supports-false": ["U-CSS-028"], "30-starting-style": ["U-CSS-028"], "40-pseudo-class-whitelist": ["U-CSS-027"],
  "41-l10n-on-ancestor": ["U-MRK-004"], "42-bind-action-turkish": ["U-MRK-005"], "43-has-sibling": ["U-CSS-027"],
  "44-common-ok": ["U-CSS-023", "U-CSS-024"], "45-onclick-div": ["U-MRK-003"], "46-ua-bold-strong-heading": ["U-CSS-026"],
  "50-select-lh": [], "51-visibility": [], "52-anim-steps": ["U-CSS-008"], "53-kit-font-local": [], "60-all-unset": [],
  "61-root-size": ["U-MRK-006"], "62-rem-body": [],
  // review round 2
  "70-reset-unused-button": [], "71-reset-unused-class": [], "72-link-only-block": [], "73-duplicate-sibling-ids": ["U-MRK-002"],
  "74-realistic-screen": ["U-CSS-016"],
};

describe("lint probes (review round 1)", () => {
  it("covers every probe page", () => {
    expect(fs.readdirSync(fx("probes")).map((n) => n.replace(/\.html$/, "")).sort()).toEqual(Object.keys(PROBES).sort());
  });
  for (const [name, ids] of Object.entries(PROBES)) {
    it(`${name}: ${ids.join(", ") || "clean"}`, async () => {
      const f = await lintFile(fx(`probes/${name}.html`));
      expect(Array.from(new Set(f.map((x) => x.ruleId))).sort(), show(f).join("\n")).toEqual([...ids].sort());
    });
  }
});

describe("lint engine", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lint-"));
  const write = (dir: string, body: string, css = "") => {
    const p = path.join(dir, "s.html");
    fs.writeFileSync(p, `<!doctype html><html><head><meta charset="utf-8"><style>:root{-webkit-font-smoothing:antialiased}body{margin:0} *,*::before,*::after{box-sizing:border-box}
      .screen{display:flex;flex-direction:column;width:2560px;height:1440px;font-family:"Inter UI";font-size:16px;line-height:20px;color:#ffffff}
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
        `.state-loading .spinner{display:grid} .card:hover{border:4px dashed var(--line)} :root{--line:#ffffff;--d:grid} .tok{display:var(--d)}`);
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

  it("resolves var() at every element a rule reaches", async () => {
    const dir = tmp();
    try {
      const f = await lintFile(write(dir, '<div class="t" style="width:10px;height:10px"></div><div class="t" style="--d:grid;width:10px;height:10px"></div>',
        ".t{display:var(--d)} :root{--d:flex}"));
      expect(f.map((x) => [x.ruleId, x.path])).toEqual([["U-CSS-001", "[data-u-screen=s] > div:1"]]);
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it("resolves radii against the untransformed box", async () => {
    const dir = tmp();
    try {
      const f = await lintFile(write(dir, '<div style="width:80px;height:80px;border-radius:50%;transform:rotate(45deg)"></div>'));
      expect(show(f)).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it("rejects media types other than screen and all, and not", async () => {
    const dir = tmp();
    try {
      const f = await lintFile(write(dir, "", "@media print{.screen{color:#000000}} @media not all and (min-width: 1px){.screen{color:#000000}}"));
      expect(f.map((x) => x.ruleId)).toEqual(["U-CSS-012", "U-CSS-012"]);
      expect(f.map((x) => x.detail).join(" ")).toContain("media type print");
      expect(f.map((x) => x.detail).join(" ")).toMatch(/: not\b/);
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it("names both duplicates, exact browser-default fixes, and lone inline boxes", async () => {
    const dup = await lintFile(fx("probes/73-duplicate-sibling-ids.html"));
    expect(dup[0].detail).toContain("p:0 (this element is [data-u-screen=s] > div[data-u-id=g] > p:1)");
    const ua = await lintFile(fx("probes/01-ua-margins-no-reset.html"));
    expect(ua.filter((f) => f.ruleId === "U-CSS-026").every((f) => /margin: 0/.test(f.fix))).toBe(true);
    const link = await lintFile(fx("U-CSS-026.fail.html"));
    expect(link[0].fix).toContain("color: rgb(255, 255, 255)");
    expect(link[0].fix).toContain("text-decoration: none");
    const dir = tmp();
    try {
      const f = await lintFile(write(dir, '<ul style="margin:0;padding:0;list-style:none"><li><a data-u-id="l" data-l10n="s.l" data-en="L" style="padding:4px">L</a></li></ul>'));
      expect(f.map((x) => x.ruleId)).toEqual(["U-CSS-009"]);
      expect(f[0].detail).toContain("draws an inline box");
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it("judges rules that reach no element on their own declarations", async () => {
    const dir = tmp();
    try {
      const f = await lintFile(write(dir, "", ".dead{column-gap:8px;flex-wrap:wrap} .dead2{transform:rotate(10deg) translateX(50%)} svg path{fill:none;stroke:#ffffff}"));
      expect(f.map((x) => [x.ruleId, x.path])).toEqual([["U-CSS-011", "style:0 .dead"]]);
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
      expect(title.computed["font-size"]).toBe("16px");
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
        `<div class="row"${i === 0 ? ' data-u-repeat="rows"' : ""} data-u-id="row"><p data-u-id="name" data-u-bind="name">Oyuncu ${i}</p>` +
        `<p data-l10n="big.role" data-en="Role">Rol</p><div class="dot"></div></div>`).join("\n");
      const p = path.join(dir, "big.html");
      fs.writeFileSync(p, `<!doctype html><html><head><meta charset="utf-8"><style>:root{-webkit-font-smoothing:antialiased}body{margin:0} *,*::before,*::after{box-sizing:border-box}
        .screen{display:flex;flex-direction:column;width:2560px;height:1440px;overflow:hidden;font-family:"Inter UI";font-size:16px;line-height:20px;color:#ffffff;background-color:#0b1f26}
        .list{display:flex;flex-direction:column;flex-shrink:0} .row{display:flex;flex-direction:row;height:24px;flex-shrink:0;border-bottom:4px solid #16c2d5}
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
