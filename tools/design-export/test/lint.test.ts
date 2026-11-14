import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { readKit, type KitConfig } from "../src/kit.js";
import { openDesign } from "../src/load.js";
import { collectSnapshot, lint, RULES, sortFindings, type Finding } from "../src/lint/index.js";
import { memberPart } from "../src/lint/rules/U-MRK-005.js";
import { repeatSamples, sampleHidden } from "../src/lint/repeat.js";

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
  "50-select-lh": [], "51-visibility": [], "52-anim-steps": [], "53-kit-font-local": [], "60-all-unset": [],
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

  it("accepts localization keys in any letter case, exactly as the String Table spells them, but ids stay lowercase and everything ASCII", async () => {
    const dir = tmp();
    const mrk5 = async (body: string) => (await lintFile(write(dir, body))).filter((x) => x.ruleId === "U-MRK-005").map((x) => x.detail);
    expect(await mrk5('<p data-l10n="inbox.main.unreadOnly" data-en="Unread only">Yalnız okunmamışlar</p>' +
      '<p data-l10n="inbox.filter.type.Match" data-en="Match">Maç</p>')).toEqual([]);
    expect(await mrk5('<input data-u-id="query" data-l10n-placeholder="inbox.main.searchHint" data-en-placeholder="Search" placeholder="Ara">')).toEqual([]);
    expect(await mrk5('<p data-l10n="inbox.main.İptal" data-en="Cancel">İptal</p>')).toEqual([
      'data-l10n="inbox.main.İptal" does not match ^[A-Za-z0-9]+([._-][A-Za-z0-9]+)*$',
    ]);
    expect(await mrk5('<p data-l10n="inbox.main.kapalı" data-en="Closed">Kapalı</p>')).toEqual([
      'data-l10n="inbox.main.kapalı" does not match ^[A-Za-z0-9]+([._-][A-Za-z0-9]+)*$',
    ]);
    expect(await mrk5('<p data-u-id="unreadOnly" data-u-bind="unread">3</p>')).toEqual([
      'data-u-id="unreadOnly" does not match ^[a-z0-9]+([._-][a-z0-9]+)*$',
    ]);
  });

  it("rejects a name that gives no C# member exactly as the view generator does (an argument named 0)", async () => {
    const dir = tmp();
    const mrk5 = async (body: string) => (await lintFile(write(dir, body))).filter((x) => x.ruleId === "U-MRK-005");
    const indexed = await mrk5('<p data-l10n="list.count" data-en="{0} events"><span data-u-arg="0">3</span> olay</p>');
    expect(indexed.map((x) => x.detail)).toEqual(['data-u-arg="0" gives no C# member name (it starts with a digit)']);
    expect(indexed[0].path).toBe("[data-u-screen=s] > p:0 > span:0");
    expect(indexed[0].fix).toContain('data-u-arg=\"count\"');
    expect((await mrk5('<p data-u-id="2nd-row" data-u-bind="row.name">Ali</p>')).map((x) => x.detail))
      .toEqual(['data-u-id="2nd-row" gives no C# member name (it starts with a digit)']);
    expect((await mrk5('<p data-l10n="list.count" data-l10n-args="1" data-en="{1} events"><span data-u-arg="1">3</span> olay</p>')).map((x) => x.detail))
      .toEqual(['data-l10n-args="1" names an argument that gives no C# member name (it starts with a digit)', 'data-u-arg="1" gives no C# member name (it starts with a digit)']);
    expect(await mrk5('<p data-l10n="list.count" data-en="{count} events"><span data-u-arg="count">3</span> olay</p>')).toEqual([]);
  });

  it("names members as the generator does for every case of contracts/member-names.json", () => {
    const cases = JSON.parse(fs.readFileSync(path.resolve(here, "../../../contracts/member-names.json"), "utf8")).cases as { name: string; member: string | null }[];
    expect(cases.length).toBeGreaterThan(5);
    for (const c of cases) expect([c.name, memberPart(c.name)]).toEqual([c.name, c.member]);
  });

  it("checks ids inside repeat items against the item view's members, and screen ids against the screen view's", async () => {
    const dir = tmp();
    const list = (id: string) => `<div style="display:flex;flex-direction:column">` +
      `<div data-u-repeat="rows" data-u-id="row" style="display:flex"><p data-u-id="${id}" data-u-bind="name">Ali</p></div></div>`;
    const item = (await lintFile(write(dir, list("index")))).filter((x) => x.ruleId === "U-MRK-011");
    expect(item.map((x) => x.detail)).toEqual([expect.stringContaining('"index" gives the view member Index, which the generated item view')]);
    // State is a screen member only, so it is free inside an item
    expect((await lintFile(write(dir, list("state")))).filter((x) => x.ruleId === "U-MRK-011")).toEqual([]);
  });

  it("an element some written-out items hide by markup and others show needs a data-u-id, and cannot lead a gap", async () => {
    const dir = tmp();
    const rows = (flag: (shown: boolean) => string, gap = "") => `<div style="display:flex;flex-direction:column">` +
      [false, true].map((shown, k) => `<div${k ? "" : ' data-u-repeat="rows"'} data-u-id="row" style="display:flex;height:40px${gap}">` +
        `${flag(shown)}<p data-u-id="name" data-u-bind="name">Ali</p></div>`).join("") + `</div>`;
    const ids = async (html: string) => (await lintFile(write(dir, html))).map((x) => `${x.ruleId} ${x.detail}`);
    // the per-item visibility setter is named from the element's data-u-id
    expect(await ids(rows((shown) => `<div style="width:8px;height:8px;background-color:#16c2d5${shown ? "" : ";display:none"}"></div>`)))
      .toEqual([expect.stringMatching(/^U-MRK-003 .*some written-out items of data-u-repeat "rows" hide by markup and others show .*has no data-u-id/)]);
    expect(await ids(rows((shown) => `<div data-u-id="dot" style="width:8px;height:8px;background-color:#16c2d5${shown ? "" : ";display:none"}"></div>`))).toEqual([]);
    // an element hidden in every item stays style: nothing to name
    expect(await ids(rows(() => `<div style="width:8px;height:8px;display:none"></div>`))).toEqual([]);
    // before every always-shown sibling of a gap container, the gap after it cannot follow the item's markup
    expect(await ids(rows((shown) => `<div data-u-id="dot" style="width:8px;height:8px;background-color:#16c2d5${shown ? "" : ";display:none"}"></div>`, ";gap:8px")))
      .toEqual([expect.stringMatching(/^U-CSS-034 .*dot.* is hidden by markup in some written-out items/)]);
  });

  it("a written-out item its own markup hides is no sample data: lint rejects it, and its root never gets a visibility setter", async () => {
    const dir = tmp();
    // the third item hidden by the hidden attribute (no display rule of its own) or by an inline display: none
    const rows = (third: string) => `<div style="display:flex;flex-direction:column">` +
      ["", "", third].map((hide, k) => `<div${k ? "" : ' data-u-repeat="rows"'} data-u-id="row" class="row"${hide}>` +
        `<p data-u-id="name" data-u-bind="name">Ali</p></div>`).join("") + `</div>`;
    for (const hiding of [" hidden", ' style="display: none"']) {
      const file = write(dir, rows(hiding), ".row{height:40px}");
      const f = (await lintFile(file)).filter((x) => x.ruleId === "U-MRK-013");
      expect(f.map((x) => x.detail), hiding).toEqual([expect.stringMatching(/item 3 of data-u-repeat "rows" .*hidden by its own markup/)]);
      expect(f[0].fix).toContain("emove the item from the samples; for an empty nested list write no items in that sample");
      const d = await openDesign(file, kit, [2560, 1440], browser);
      try {
        const s = await collectSnapshot(d.page, d.cdp, kit);
        const roots = new Set(repeatSamples(s, s.elements.findIndex((e) => e.attrs["data-u-repeat"] === "rows")));
        expect(roots.size).toBe(3);
        expect(Array.from(sampleHidden(s).keys()).filter((i) => roots.has(i)), "an item root is never a per-item visibility element").toEqual([]);
      } finally { await d.close(); }
    }
  });

  it("a later written-out item may leave a nested repeat empty; the template item still writes one out", async () => {
    const dir = tmp();
    const css = ".row{display:flex;flex-direction:column;flex-shrink:0}.events{display:flex;flex-direction:column;flex-shrink:0}";
    const rows = (counts: number[]) => `<div style="display:flex;flex-direction:column">` + counts.map((n, k) =>
      `<div${k ? "" : ' data-u-repeat="rows"'} data-u-id="row" class="row"><p data-u-id="name" data-u-bind="name">Ali</p><div class="events" data-u-id="events">` +
      Array.from({ length: n }, (_, j) => `<p${j ? "" : ' data-u-repeat="events"'} data-u-id="event" data-u-bind="event">Maç</p>`).join("") + `</div></div>`).join("") + `</div>`;
    expect(show(await lintFile(write(dir, rows([2, 0, 1]), css)))).toEqual([]);
    expect(show(await lintFile(write(dir, rows([1, 2, 0]), css)))).toEqual([]);
    const f = await lintFile(write(dir, rows([0, 2]), css));
    expect(show(f)).toEqual([expect.stringMatching(/^U-MRK-010 .*nested data-u-repeat "events".*the first item needs one/)]);
  });

  it("returns warnings without errors for a design with only warnings", async () => {
    const f = await lintFile(fx("W-FONT-002.fail.html"), KIT_FOR["W-FONT-002"]?.fail ?? kit);
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

describe("device grid, group opacity and stacking rules", () => {
  const page = (body: string, css: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-grid-"));
    const p = path.join(dir, "s.html");
    fs.writeFileSync(p, `<!doctype html><html><head><meta charset="utf-8"><style>:root{-webkit-font-smoothing:antialiased}body{margin:0} *,*::before,*::after{box-sizing:border-box}
      .screen{display:flex;flex-direction:column;width:2560px;height:1440px;position:relative;font-family:"Inter UI";font-size:16px;line-height:20px;color:#ffffff;background-color:#0b1f26}
      p{margin:0}${css}</style></head><body><div class="screen" data-u-screen="s">${body}</div></body></html>`);
    return { p, done: () => fs.rmSync(dir, { recursive: true }) };
  };
  const ids = async (body: string, css: string, rule: string) => {
    const { p, done } = page(body, css);
    try { return (await lintFile(p)).filter((f) => f.ruleId === rule); } finally { done(); }
  };

  it("U-CSS-040: a painted box thinner than 8px, and a rem border, must be whole device px at every viewport", async () => {
    const f = await ids(
      `<div class="l1"></div><div class="l2"></div><div class="l6"></div><div class="half"></div><div class="l4"></div><div class="spacer"></div><div class="rule"></div><div class="rem"></div>`,
      `.l1,.l2,.l6,.half,.l4{width:400px;margin-bottom:16px;background-color:#2b6573} .l1{height:1px} .l2{width:2px;height:40px} .l6{height:6px}
       .half{height:0.5px} .l4{height:4px} .spacer{height:2px;margin-bottom:16px} .rule{width:400px;height:4px;border-top:4px solid #2b6573}
       .rem{width:96px;height:64px;border:0.125rem solid #2b6573}`, "U-CSS-040");
    expect(f.map((x) => x.path)).toEqual(["[data-u-screen=s] > div:0", "[data-u-screen=s] > div:1", "[data-u-screen=s] > div:2", "[data-u-screen=s] > div:3", "[data-u-screen=s] > div:7"]);
    expect(f[4].detail).toMatch(/border-top-width: 0\.125rem is 1\.5 device px at 1920×1080/);
    expect(f[0].detail).toMatch(/1px tall: 0\.75 device px at 1920×1080/);
    expect(f[1].detail).toMatch(/2px wide: 1\.5 device px at 1920×1080/);
    expect(f[0].fix).toMatch(/4px/);
    expect(f[0].fix).not.toMatch(/draw a thinner line/);
  });

  it("U-CSS-039: rejects a fade through (0, 1) on overlapping parts: keyframes, a transition, an inline style, a child", async () => {
    const card = `.card{width:200px;height:80px;background-color:#123c47;border:4px solid #2b6573}`;
    expect(await ids(`<div class="card fade"></div>`, `${card} .fade{animation:appear 200ms linear} @keyframes appear{from{opacity:0}to{opacity:1}}`, "U-CSS-039")).toHaveLength(1);
    expect(await ids(`<div class="card fade"></div>`, `${card} .fade{opacity:0;transition:opacity 200ms linear} .fade:hover{opacity:1}`, "U-CSS-039")).toHaveLength(1);
    expect(await ids(`<div class="card" style="opacity:0.5"></div>`, card, "U-CSS-039")).toHaveLength(1);
    const child = await ids(`<div class="box"><div class="dot"></div></div>`, `.box{width:200px;height:80px;background-color:#123c47;opacity:0.5} .dot{width:40px;height:40px;background-color:#16c2d5}`, "U-CSS-039");
    expect(child.map((x) => x.detail)).toEqual([expect.stringMatching(/background of div:0.*background of div:0 > div:0|background of .*dot/)]);
    // one painted part fades the same in both; an opacity that never changes or changes without a transition never shows a fraction
    expect(await ids(`<div class="one fade"></div>`, `.one{width:200px;height:80px;background-color:#123c47} .fade{animation:appear 200ms linear} @keyframes appear{from{opacity:0}to{opacity:1}}`, "U-CSS-039")).toEqual([]);
    expect(await ids(`<div class="card fade"></div>`, `${card} .fade{transition:opacity 200ms linear}`, "U-CSS-039")).toEqual([]);
    expect(await ids(`<div class="card fade"></div>`, `${card} .fade{opacity:0} .fade.is-open{opacity:1}`, "U-CSS-039")).toEqual([]);
  });

  it("animations: the easings and properties the animation player plays pass; linear() points and other properties fail", async () => {
    const box = `.b{width:200px;height:80px;background-color:#123c47}`;
    const t = (timing: string) => ids(`<div class="b"></div>`, `${box} .b{transition:background-color 200ms ${timing}}`, "U-CSS-008");
    for (const ok of ["ease", "step-start", "steps(4, jump-end)", "steps(2)", "cubic-bezier(.68,-0.55,.27,1.55)"]) expect(await t(ok), ok).toEqual([]);
    // (cubic-bezier() with x outside 0–1 and steps(0) are invalid CSS: the browser drops them, as Unity does)
    for (const bad of ["linear(0, 0.5, 1)", "linear(0, 0.25 40%, 1)"]) expect(await t(bad), bad).toHaveLength(1);
    expect(await ids(`<div class="b"></div>`, `${box} .b{transition-timing-function:cubic-bezier(0.1, 0.7, 1, 0.1)}`, "U-CSS-008")).toEqual([]);
    // keyframes: radii play; layout properties (the player never lays out per frame) and other properties fail
    const kf = (decl: string, rule: string) => ids(`<div class="b k"></div>`, `${box} .k{animation:a 200ms linear} @keyframes a{from{${decl}}to{${decl.replace(/\d+px/, "20px")}}}`, rule);
    expect(await kf("border-top-left-radius:4px", "U-CSS-013")).toEqual([]);
    for (const layout of ["width:10px", "margin-left:4px", "padding:4px", "inset:4px", "border-top-width:4px", "flex-basis:10px", "font-size:10px", "line-height:10px"]) {
      expect((await kf(layout, "U-CSS-013")).map((x) => x.fix), layout).toEqual([expect.stringMatching(/translate or scale instead/)]);
    }
    expect(await kf("letter-spacing:1px", "U-CSS-013")).toHaveLength(1);
  });

  it("U-CSS-042: transitions only of what the player animates; layout properties point to transforms", async () => {
    const box = `.b{width:200px;height:80px;flex-shrink:0;background-color:#123c47}`;
    const t = (css: string) => ids(`<div class="b" data-u-id="b"></div>`, `${box} ${css}`, "U-CSS-042");
    // named properties fail even when nothing changes them; all fails only for what a layer really changes
    expect((await t(`.b{transition:height 200ms ease}`)).map((x) => [x.detail, x.fix])).toEqual([[expect.stringMatching(/transition of height \(base\); height lays the screen out/), expect.stringMatching(/translate or scale instead/)]]);
    expect(await t(`.b{transition:letter-spacing 200ms ease}`)).toHaveLength(1);
    expect(await t(`.b{transition:visibility 200ms ease}`)).toHaveLength(1);
    expect(await t(`.b{transition:all 200ms ease} .b:hover{background-color:#16c2d5;scale:1.05}`)).toEqual([]);
    expect((await t(`.b{transition:all 200ms ease} .b:hover{width:220px}`)).map((x) => x.detail)).toEqual([expect.stringMatching(/transition of width \(hover\)/)]);
    // discrete properties change at once in CSS too; a zero or negative combined duration never transitions
    expect(await t(`.b{transition:display 200ms ease, flex-direction 200ms ease}`)).toEqual([]);
    expect(await t(`.b{transition:width 0s ease}`)).toEqual([]);
    expect(await t(`.b{transition:width 100ms ease -200ms}`)).toEqual([]);
    // box-shadow is U-CSS-014's
    expect(await t(`.b{transition:box-shadow 200ms ease}`)).toEqual([]);
  });

  it("animation: none in a layer is valid CSS the player plays (Chromium expands it with animation-duration: auto)", async () => {
    const css = `.b{width:200px;height:80px;flex-shrink:0;background-color:#123c47;animation:a 1s linear infinite} .b.is-still{animation:none} @keyframes a{from{translate:0 0}to{translate:0 4px}}`;
    const page = (await (async () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-none-")); const p = path.join(dir, "s.html");
      fs.writeFileSync(p, `<!doctype html><html><head><meta charset="utf-8"><style>:root{-webkit-font-smoothing:antialiased}body{margin:0} *,*::before,*::after{box-sizing:border-box}
        .screen{display:flex;flex-direction:column;width:2560px;height:1440px;position:relative;font-family:"Inter UI";font-size:16px;line-height:20px;color:#ffffff;background-color:#0b1f26}
        ${css}</style></head><body><div class="screen" data-u-screen="s"><div class="b" data-u-id="b"></div></div></body></html>`);
      return p; })());
    expect(show((await lintFile(page)).filter((f) => f.severity === "error"))).toEqual([]);
  });

  it("U-CSS-044: negative letter-spacing needs as much right padding as the spacing", async () => {
    const text = (css: string) => ids(`<p class="t" data-u-id="t" data-l10n="s.t" data-en="Derby">Derbi</p>`,
      `.t{font-size:48px;line-height:54px;flex-shrink:0;align-self:flex-start;${css}}`, "U-CSS-044");
    expect(await text("letter-spacing:-1.28px")).toEqual([expect.objectContaining({ detail: expect.stringMatching(/needs at least 1\.28px of right padding/) })]);
    expect(await text("letter-spacing:-1.28px;padding-right:1px")).toHaveLength(1);
    expect(await text("letter-spacing:-1.28px;padding-right:2px")).toEqual([]);
    expect(await text("letter-spacing:1.6px")).toEqual([]);
  });

  it("U-CSS-036: content-box with padding on a box that a min or max size or flex-basis sizes", async () => {
    const box = (css: string) => ids(`<div class="b" data-u-id="b"></div>`,
      `.b{box-sizing:content-box;padding:8px;height:40px;flex-shrink:0;align-self:flex-start;background-color:#123c47;${css}}`, "U-CSS-036");
    expect(await box("min-width:200px")).toHaveLength(1);
    expect(await box("max-width:50%")).toHaveLength(1);
    expect(await box("height:auto;min-width:0")).toEqual([]);
    expect(await box("height:auto;max-width:none")).toEqual([]);
  });

  it("U-CSS-045: a box whose width max-width sets while its text wraps", async () => {
    const long = `data-l10n="s.t" data-en="Ticket prices stay the same for the rest of the season.">Bilet fiyatları sezonun geri kalanında aynı kalıyor.`;
    const text = (css: string, words = long) => ids(`<p class="t" data-u-id="t" ${words}</p>`,
      `.t{font-size:24px;line-height:30px;flex-shrink:0;align-self:flex-start;padding:8px 16px;${css}}`, "U-CSS-045");
    expect(await text("max-width:260px")).toEqual([expect.objectContaining({ detail: "max-width 260px sets the width (260px) of a box whose text wraps: UI Toolkit sizes it to its longest line" })]);
    expect(await text("max-width:10%"), "a % of the parent's content width").toHaveLength(1);
    expect(await text("max-width:260px", `data-l10n="s.t" data-en="Short">Kısa`), "the box does not reach its max-width").toEqual([]);
    expect(await text("max-width:260px;width:260px"), "a width of its own").toEqual([]);
    expect(await text("max-width:260px;align-self:stretch"), "a stretched width").toEqual([]);
    // a block parent is a column whose children stretch (the lowering's rule), in CSS and in Unity alike
    const inBlock = (css: string) => ids(`<div class="b"><p class="t" data-u-id="t" ${long}</p></div>`,
      `.b{display:block;width:600px;flex-shrink:0;align-self:flex-start} .t{font-size:24px;line-height:30px;${css}}`, "U-CSS-045");
    expect(await inBlock("max-width:260px"), "a block child of a block parent").toEqual([]);
    expect(await inBlock("max-width:260px;display:flex"), "a block-level flex child").toEqual([]);
    // a container whose wrapping text sets its width
    const box = await ids(`<div class="c" data-u-id="c"><p class="t" ${long}</p></div>`,
      `.c{display:flex;flex-direction:row;flex-shrink:0;align-self:flex-start;max-width:300px} .t{font-size:24px;line-height:30px;flex-shrink:1}`, "U-CSS-045");
    expect(box.map((f) => f.path)).toEqual(["[data-u-screen=s] > div[data-u-id=c]"]);
    // in a row, a flex-grow gives the box its size
    expect(await ids(`<div class="r"><p class="t" data-u-id="t" ${long}</p></div>`,
      `.r{display:flex;flex-direction:row;width:800px} .t{font-size:24px;line-height:30px;flex-grow:1;max-width:260px}`, "U-CSS-045")).toEqual([]);
  });

  it("U-CSS-043: keyframes and a transition of the same property on one element", async () => {
    const box = `.b{width:200px;height:80px;flex-shrink:0;background-color:#123c47;animation:a 1s linear infinite} @keyframes a{from{translate:0 0}to{translate:0 4px}}`;
    const t = (css: string) => ids(`<div class="b" data-u-id="b"></div>`, `${box} ${css}`, "U-CSS-043");
    expect(await t(`.b{transition:all 200ms ease} .b:hover{background-color:#16c2d5}`)).toEqual([]);
    expect((await t(`.b{transition:all 200ms ease} .b:hover{translate:0 8px}`)).map((x) => x.detail)).toEqual([expect.stringMatching(/translate is animated by @keyframes a and transitioned \(hover\)/)]);
    // a transform transition covers the keyframes' translate
    expect(await t(`.b{transition:transform 200ms ease} .b:hover{transform:translateY(8px)}`)).toHaveLength(1);
  });

  it("U-CSS-041: judges positioned elements too, against later plain elements, in the base style", async () => {
    const css = `.row{display:flex;flex-direction:row} .card{width:320px;height:180px;flex-shrink:0;background-color:#123c47;box-shadow:0 8px 24px rgba(0,0,0,0.4)}
      .panel{width:400px;height:120px;background-color:#0f2a33} .rel{position:relative}`;
    const fail = await ids(`<div class="row"><div class="card rel" data-u-id="a"></div></div><div class="panel"></div>`, css, "U-CSS-041");
    expect(fail.map((x) => x.detail)).toEqual([expect.stringMatching(/'a'.*the base style.*div:1/)]);
    expect(await ids(`<div class="row"><div class="card rel" data-u-id="a"></div></div><div class="panel rel"></div>`, css, "U-CSS-041")).toEqual([]);
    // a static card inside a relative wrapper paints with the wrapper, after the later static panel
    const nested = await ids(`<div class="outer"><div class="row rel"><div class="card" data-u-id="a"></div></div></div><div class="panel"></div>`, css, "U-CSS-041");
    expect(nested.map((x) => x.detail)).toEqual([expect.stringMatching(/^'a' paints .* \(inside div:0, which is positioned or a stacking context\).*reaches div:1, which comes later/)]);
    // a transform's translate counts like the translate property
    const moved = await ids(`<div class="row"><div class="card lift" data-u-id="a"></div></div><div class="panel" style="margin-top:40px"></div>`,
      `${css} .card{box-shadow:none} .lift:hover{transform:translateY(48px)}`, "U-CSS-041");
    expect(moved).toHaveLength(1);
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
