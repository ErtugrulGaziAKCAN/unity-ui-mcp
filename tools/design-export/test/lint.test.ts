import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { readKit, type KitConfig } from "../src/kit.js";
import { openDesign } from "../src/load.js";
import { parseScreenContract, readContractFile, type ContractLoad } from "../src/contract.js";
import { collectSnapshot, lint, lintSnapshot, RULES, sortFindings, type Finding } from "../src/lint/index.js";
import { designInventory, normalizeText } from "../src/lint/contract-scan.js";
import { memberPart } from "../src/lint/rules/U-MRK-005.js";
import { repeatSamples, sampleHidden } from "../src/lint/repeat.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => path.join(here, "fixtures", "lint", n);
const kit: KitConfig = readKit(fx("kit"));
/** Same kit with a second active locale (ar) whose font has no bold face. */
const localesKit: KitConfig = { ...kit, fontsCss: "fonts/locales.css" };
/** Same kit with an extra face whose file cannot be read (local()). */
const unreadableKit: KitConfig = { ...kit, fontsCss: "fonts/unreadable.css" };
/** Same kit with English as the reference locale (the package's default): the visible text is the English entry. */
const englishKit: KitConfig = { ...kit, locales: ["en"] };
/** Same kit with the screen contract required: a design without one is an error (U-CON-001). */
const requiredKit: KitConfig = { ...kit, screenContract: "required" };
const KIT_FOR: Record<string, { pass?: KitConfig; fail?: KitConfig }> = {
  "W-FONT-001": { pass: localesKit, fail: localesKit },
  "W-FONT-002": { fail: unreadableKit },
  "U-MRK-014": { pass: englishKit, fail: englishKit },
  "U-CON-001": { pass: requiredKit, fail: requiredKit },
};
/** The contract rules read the contract beside their fixture (`<id>.<pass|fail>.contract.json`, absent when there is none); other rules get none. */
const contractFor = (id: string, file: string): ContractLoad | null =>
  /^[UI]-CON-/.test(id) ? readContractFile(file.replace(/\.(dc\.)?html$/, ".contract.json")) : null;

const fixture = (id: string, kind: "pass" | "fail") => {
  const plain = `${id}.${kind}.html`;
  return fs.existsSync(fx(plain)) ? plain : `${id}.${kind}.dc.html`;
};

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

async function lintFile(file: string, k: KitConfig = kit, contract?: ContractLoad | null): Promise<Finding[]> {
  const d = await openDesign(file, k, [2560, 1440], browser);
  try { return await lint(d, k, undefined, contract); } finally { await d.close(); }
}

const show = (f: Finding[]) => f.map((x) => `${x.ruleId} ${x.path}: ${x.detail}`);

describe("the English entry when the reference locale is en", () => {
  it("takes the visible text: data-en may be left out, and a data-en that is not the visible text is an error", async () => {
    // with the reference locale tr, data-en is the English source (its own text), required, and never compared
    const tr = await lintFile(fx("U-MRK-014.pass.html"));
    expect(show(tr.filter((x) => x.ruleId === "U-MRK-004" || x.ruleId === "U-MRK-007")).length).toBe(3);
    expect(show(tr.filter((x) => x.ruleId === "U-MRK-008"))).toEqual([]);
    expect(show((await lintFile(fx("U-MRK-014.fail.html"))).filter((x) => x.ruleId === "U-MRK-014"))).toEqual([]);
    // with en: the visible text is the entry, so data-en (and data-en-<attr>) repeats it or is left out
    expect(show(await lintFile(fx("U-MRK-014.pass.html"), englishKit))).toEqual([]);
    const f = (await lintFile(fx("U-MRK-014.fail.html"), englishKit)).filter((x) => x.ruleId === "U-MRK-014");
    expect(f.map((x) => [x.severity, x.detail])).toEqual([["error", 'data-en "Save" is not the visible text "Save changes"']]);
    expect(f[0].fix).toMatch(/leave data-en out/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-en-"));
    try {
      const page = fs.readFileSync(fx("U-MRK-014.pass.html"), "utf8")
        .replace('data-en-placeholder="Search"', 'data-en-placeholder="Search players"');
      fs.writeFileSync(path.join(dir, "attr.html"), page);
      const a = (await lintFile(path.join(dir, "attr.html"), englishKit)).filter((x) => x.ruleId === "U-MRK-014");
      expect(a.map((x) => x.detail)).toEqual(['data-en-placeholder "Search players" is not the placeholder "Search"']);
      // text that does not render is not the visible text (as the import reads it); a no-break space is not a plain space
      const base = fs.readFileSync(fx("U-MRK-014.pass.html"), "utf8");
      fs.writeFileSync(path.join(dir, "hidden.html"), base.replace('<p data-l10n="lint.sample.title" data-en="Title">Title</p>',
        '<p data-l10n="lint.sample.title" data-en="Title">Title<span hidden> more</span></p>'));
      expect((await lintFile(path.join(dir, "hidden.html"), englishKit)).filter((x) => x.ruleId === "U-MRK-014")).toEqual([]);
      fs.writeFileSync(path.join(dir, "space.html"), base.replace('data-en="10&nbsp;km"', 'data-en="10 km"'));
      const sp = (await lintFile(path.join(dir, "space.html"), englishKit)).filter((x) => x.ruleId === "U-MRK-014");
      expect(sp.map((x) => x.detail)).toEqual(['data-en "10 km" is not the visible text "10\u00a0km"']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("lint rules: one pass and one fail fixture per rule", () => {
  for (const r of RULES) {
    it(`${r.id}: pass fixture has no findings`, async () => {
      const file = fx(fixture(r.id, "pass"));
      const f = await lintFile(file, KIT_FOR[r.id]?.pass ?? kit, contractFor(r.id, file));
      expect(show(f)).toEqual([]);
    });
    it(`${r.id}: fail fixture has exactly one ${r.id} finding with a fix, and nothing else`, async () => {
      const file = fx(fixture(r.id, "fail"));
      const f = await lintFile(file, KIT_FOR[r.id]?.fail ?? kit, contractFor(r.id, file));
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
    // a contract fixture sits beside its design
    for (const n of fs.readdirSync(fx(".")).filter((x) => x.endsWith(".contract.json"))) expect(fs.existsSync(fx(n.replace(/\.contract\.json$/, ".html"))), n).toBe(true);
  });
});

describe("screen contract", () => {
  const valid = (json: unknown): ContractLoad => {
    const r = parseScreenContract(json);
    if ("problems" in r) throw new Error(r.problems.join("; "));
    return { state: "valid", file: "screen.contract.json", contract: r.contract, sha: "" };
  };
  const json = (name: string): any => JSON.parse(fs.readFileSync(fx(name), "utf8"));
  const con = (f: Finding[]) => show(f.filter((x) => /^[UI]-CON-/.test(x.ruleId)));
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lint-contract-"));
  const ROW = "[data-u-screen=lint.sample] > div[data-u-id=rows] > div[data-u-id=row]";

  it("normalizes text: whitespace runs collapsed, trimmed, NFC", () => {
    expect(normalizeText("  A.\n\t Novak  ")).toBe("A. Novak");
    expect(normalizeText("10\u00a0km")).toBe("10 km");
    expect(normalizeText("Mu\u0308ller")).toBe("M\u00fcller");
  });

  it("matches names per scope", async () => {
    // "title" is bound in the screen and in the player repeat: a contract with only the screen one lacks the other
    const c = json("U-CON-002.pass.contract.json");
    c.values = c.values.filter((v: { repeat?: string }) => v.repeat === undefined);
    expect(con(await lintFile(fx("U-CON-002.pass.html"), kit, valid(c))))
      .toEqual([`U-CON-002 ${ROW} > p[data-u-id=role]: value "title" in repeat "player" is not in the screen contract`]);
    // and an action listed in the screen is not the repeat's: one extra, one missing
    const a = json("U-CON-002.pass.contract.json");
    delete a.actions[0].repeat;
    expect(con(await lintFile(fx("U-CON-002.pass.html"), kit, valid(a)))).toEqual([
      `U-CON-002 ${ROW} > div[data-u-id=open]: action "open-player" in repeat "player" is not in the screen contract`,
      'U-CON-003 document: action "open-player" is in the screen contract but not in the design',
    ]);
  });

  it("scopes a value, an action and a nested repeat by the repeat whose written-out item holds them", async () => {
    const dir = tmp();
    try {
      const players = (names: string[]) => '<div class="rows" data-u-id="players">' + names.map((n, k) =>
        `<div class="row"${k === 0 ? ' data-u-repeat="player"' : ""} data-u-id="player" data-u-action="open-player"><p data-u-id="name" data-u-bind="player-name">${n}</p></div>`).join("") + "</div>";
      const groups = '<div class="rows" data-u-id="groups">' +
        `<div class="group" data-u-repeat="group" data-u-id="group"><p data-u-id="group-name" data-u-bind="group-name">Defenders</p>${players(["A. Novak", "B. Kaya"])}</div>` +
        `<div class="group" data-u-id="group"><p data-u-id="group-name" data-u-bind="group-name">Forwards</p>${players(["C. Diaz"])}</div></div>`;
      const page = fs.readFileSync(fx("U-CON-002.pass.html"), "utf8").replace(/<p data-u-id="heading"[^\n]*\n<div class="rows"[^\n]*\n/, groups + "\n");
      fs.writeFileSync(path.join(dir, "nested.html"), page);
      const d = await openDesign(path.join(dir, "nested.html"), kit, [2560, 1440], browser);
      try {
        const items = designInventory(await collectSnapshot(d.page, d.cdp, kit), kit);
        expect(items.map((x) => [x.kind, x.name, x.repeat, x.samples])).toEqual([
          ["text", "lint.sample.title", null, []],
          ["repeat", "group", null, []],
          ["value", "group-name", "group", ["Defenders", "Forwards"]],
          ["action", "open-player", "player", []],
          ["repeat", "player", "group", []],
          ["value", "player-name", "player", ["A. Novak", "B. Kaya", "C. Diaz"]],
        ]);
      } finally { await d.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("checks every sample row", async () => {
    // the third row's name is not a sample; "B.  Kaya" in the contract is the design's "B. Kaya" (whitespace collapsed)
    const f = await lintFile(fx("U-CON-005.fail.html"), kit, readContractFile(fx("U-CON-005.fail.contract.json")));
    expect(con(f)).toEqual([`U-CON-005 ${ROW} > p[data-u-id=name]: value "player-name" in repeat "player" shows "Z. Unknown", not among the screen contract's samples`]);
    // up to three unknown samples are named
    const dir = tmp();
    try {
      const names = ["A. Novak", "C. One", "D. Two", "E. Three", "F. Four", "C. One"];
      const rows = '<div class="rows" data-u-id="rows">' + names.map((n, k) =>
        `<div class="row"${k === 0 ? ' data-u-repeat="player"' : ""} data-u-id="row"><p data-u-id="name" data-u-bind="player-name">${n}</p></div>`).join("") + "</div>";
      fs.writeFileSync(path.join(dir, "rows.html"), fs.readFileSync(fx("U-CON-005.fail.html"), "utf8").replace(/<div class="rows"[^\n]*/, rows));
      const g = (await lintFile(path.join(dir, "rows.html"), kit, readContractFile(fx("U-CON-005.fail.contract.json")))).filter((x) => x.ruleId === "U-CON-005");
      expect(g.map((x) => x.detail)).toEqual(['value "player-name" in repeat "player" shows "C. One", "D. Two", "E. Three" and 1 more, not among the screen contract\'s samples']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads a bound field's value and a dropdown's selected option as their samples, as the IR's sample data does", async () => {
    const dir = tmp();
    try {
      const page = fs.readFileSync(fx("U-CON-006.pass.html"), "utf8").replace(/<p data-l10n="lint.sample.greet"[^\n]*\n<input[^\n]*\n/,
        '<input class="field" data-u-id="manager" value="Sam Whitfield" data-u-bind="manager-name">\n' +
        '<textarea class="field" data-u-id="note" data-u-bind="note">Fit  again</textarea>\n' +
        '<select class="field" data-u-id="formation" data-u-bind="formation"><option>4-4-2</option><option selected>4-3-3</option></select>\n');
      fs.writeFileSync(path.join(dir, "fields.html"), page);
      const d = await openDesign(path.join(dir, "fields.html"), kit, [2560, 1440], browser);
      try {
        const values = designInventory(await collectSnapshot(d.page, d.cdp, kit), kit).filter((x) => x.kind === "value");
        expect(values.map((x) => [x.name, x.samples])).toEqual([["manager-name", ["Sam Whitfield"]], ["note", ["Fit again"]], ["formation", ["4-3-3"]]]);
      } finally { await d.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("skips samples of image binds and of requested values without a source", async () => {
    const file = fx("U-CON-005.pass.html");
    const c = json("U-CON-005.pass.contract.json");
    expect(con(await lintFile(file, kit, valid(c)))).toEqual([]);
    // the same design values are checked once the crest is not an image bind and the form has a source
    for (const v of c.values) {
      if (v.name === "club-crest") { delete v.image; v.samples = ["Crest"]; }
      if (v.name === "form") { v.source = "the results reader's last five results"; v.samples = ["LLLLL"]; }
    }
    expect(con(await lintFile(file, kit, valid(c)))).toEqual([
      'U-CON-005 [data-u-screen=lint.sample] > div[data-u-id=crest]: value "club-crest" shows "", not among the screen contract\'s samples',
      'U-CON-005 [data-u-screen=lint.sample] > p[data-u-id=form]: value "form" shows "WWDLW", not among the screen contract\'s samples',
    ]);
  });

  it("keeps an element hidden in a sample row", async () => {
    const dir = tmp();
    try {
      // every written-out row hides its injury note by its own markup: it is still the design's
      const page = fs.readFileSync(fx("U-CON-005.pass.html"), "utf8")
        .replace(/(<p data-u-id="name" data-u-bind="player-name">[^<]*<\/p>)/g, '$1<p data-u-id="injury" data-u-bind="injury" style="display: none">Hamstring</p>');
      fs.writeFileSync(path.join(dir, "hidden.html"), page);
      const c = json("U-CON-005.pass.contract.json");
      c.values.push({ name: "injury", repeat: "player", source: "the medical reader's current injury", samples: ["Hamstring"], origin: "existing" });
      expect(con(await lintFile(path.join(dir, "hidden.html"), kit, valid(c)))).toEqual([]);
      // visibility: hidden keeps the element's box: its text is still its sample (as the IR's sample data reads it), and checked
      fs.writeFileSync(path.join(dir, "invisible.html"), page.replaceAll('style="display: none"', 'style="visibility: hidden"'));
      expect(con(await lintFile(path.join(dir, "invisible.html"), kit, valid(c)))).toEqual([]);
      c.values.at(-1).samples = ["Ankle"];
      expect(con(await lintFile(path.join(dir, "invisible.html"), kit, valid(c))))
        .toEqual([`U-CON-005 ${ROW} > p[data-u-id=injury]: value "injury" in repeat "player" shows "Hamstring", not among the screen contract's samples`]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("compares English and reference text", async () => {
    // reference tr: data-en against the contract's en
    const fail = await lintFile(fx("U-CON-006.fail.html"), kit, readContractFile(fx("U-CON-006.fail.contract.json")));
    expect(con(fail)).toEqual(['U-CON-006 [data-u-screen=lint.sample] > p:0: text "lint.sample.title": its English "Title" is not the contract\'s en "Club overview"']);
    // reference tr: the visible text (a variable as {name}) and an attribute value against the contract's ref
    const c = json("U-CON-006.pass.contract.json");
    c.texts[1].ref = "Merhaba {name}";
    c.texts[2].ref = "Bul";
    expect(con(await lintFile(fx("U-CON-006.pass.html"), kit, valid(c)))).toEqual([
      'U-CON-006 [data-u-screen=lint.sample] > input[data-u-id=search]: text "lint.sample.search": its visible text "Ara" is not the contract\'s ref "Bul"',
      'U-CON-006 [data-u-screen=lint.sample] > p:1: text "lint.sample.greet": its visible text "Selam {name}" is not the contract\'s ref "Merhaba {name}"',
    ]);
    // reference en: the visible text is the English (data-en left out), and ref is not compared
    const dir = tmp();
    try {
      const page = fs.readFileSync(fx("U-CON-006.pass.html"), "utf8")
        .replace('data-en="Title">Başlık', ">Title")
        .replace('data-en="Hi {name}">Selam ', ">Hi ")
        .replace('placeholder="Ara" data-l10n-placeholder="lint.sample.search" data-en-placeholder="Search"', 'placeholder="Search" data-l10n-placeholder="lint.sample.search"');
      fs.writeFileSync(path.join(dir, "en.html"), page);
      const en = json("U-CON-006.pass.contract.json");
      expect(show(await lintFile(path.join(dir, "en.html"), englishKit, valid(en)))).toEqual([]);
      en.texts[0].en = "Club overview";
      expect(con(await lintFile(path.join(dir, "en.html"), englishKit, valid(en))))
        .toEqual(['U-CON-006 [data-u-screen=lint.sample] > p:0: text "lint.sample.title": its English "Title" is not the contract\'s en "Club overview"']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports a contract it cannot check against once, and checks nothing else against it", async () => {
    const d = await openDesign(fx("U-CON-001.pass.html"), kit, [2560, 1440], browser);
    try {
      const s = await collectSnapshot(d.page, d.cdp, kit);
      const run = (c: ContractLoad | null, k: KitConfig = kit) => con(lintSnapshot(s, k, d, c));
      const absent: ContractLoad = { state: "absent", file: "screen.contract.json" };
      expect(run(null, requiredKit)).toEqual([]);
      expect(run(absent)).toEqual(["I-CON-001 document: no screen.contract.json beside the design: it is not checked against what the game has for this screen"]);
      expect(run(absent, requiredKit)).toEqual(["U-CON-001 document: no screen.contract.json beside the design, and the kit requires one (screenContract: required)"]);
      expect(run({ state: "invalid", file: "screen.contract.json", sha: "", problems: ["contract must be 1", "screen is missing"] }))
        .toEqual(["U-CON-001 document: the screen contract is not valid: contract must be 1; screen is missing"]);
      // a contract for another screen: its items are not compared (the design's club-name would be extra)
      const other = json("U-CON-001.pass.contract.json");
      other.screen = "club.overview";
      other.values = [];
      expect(run(valid(other))).toEqual(['U-CON-001 document: screen.contract.json is for screen "club.overview", but the design\'s data-u-screen is "lint.sample"']);
    } finally { await d.close(); }
  });

  it("skips every contract rule when the caller passes no contract", async () => {
    for (const r of RULES.filter((x) => /^[UI]-CON-/.test(x.id))) {
      expect(con(await lintFile(fx(fixture(r.id, "fail")), KIT_FOR[r.id]?.fail ?? kit)), r.id).toEqual([]);
    }
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
      .screen{display:flex;flex-direction:column;width:2560px;height:1440px;font-family:"Inter UI";font-size:18px;line-height:22px;color:#ffffff}
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
      .screen{display:flex;flex-direction:column;width:2560px;height:1440px;position:relative;font-family:"Inter UI";font-size:18px;line-height:22px;color:#ffffff;background-color:#0b1f26}
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

  it("U-CSS-046: a padding, margin or gap off the device grid at an exact viewport names the element, property, viewport and nearest lengths", async () => {
    // the pilot's grid: a frame centred at 398 px (298.5 device px at 1920×1080) and cells padded 10 / 14 px
    const body = `<div class="frame"><div class="grid"><div class="day">1</div><div class="weekday">Mon</div><div class="gapped"><div class="i"></div><div class="i"></div></div><div class="hover" data-u-id="h" tabindex="0"></div><div class="moved"></div></div></div>`;
    const css = `.frame{display:flex;flex-direction:row;justify-content:center;width:2560px;height:600px} .grid{display:flex;flex-direction:column;width:1764px;height:600px}
      .day{padding:10px} .weekday{padding-left:14px} .gapped{display:flex;flex-direction:row;column-gap:6px;margin-top:0.5rem} .i{width:40px;height:40px;background-color:#16c2d5}
      .hover{width:40px;height:40px;padding:4px} .hover:hover{padding:2px 4px} .moved{position:relative;left:10px;top:6px;width:40px;height:40px;transform:translate(10px,2px);margin-left:-12px}`;
    const f = await ids(body, css, "U-CSS-046");
    const by = (cls: number) => f.find((x) => x.path.endsWith(cls === 3 ? "div[data-u-id=h]" : `div:0 > div:${cls}`));
    expect(f.map((x) => x.path.replace(/^.* > /, ""))).toEqual(["div:0", "div:1", "div:2", "div[data-u-id=h]"]);
    expect(by(0)!.detail).toMatch(/padding-top: 10px is 7\.5 device px at 1920×1080 .*nearest whole at every exact viewport: 8px or 12px/);
    expect(by(1)!.detail).toMatch(/padding-left: 14px is 10\.5 device px at 1920×1080 .*12px or 16px/);
    expect(by(2)!.detail).toMatch(/column-gap: 6px is 4\.5 device px at 1920×1080 .*4px or 8px/);
    expect(by(2)!.detail).not.toMatch(/margin-top/); // 0.5rem is 8px
    expect(by(3)!.detail).toMatch(/padding-top: 2px is 1\.5 device px at 1920×1080.*\.hover:hover/);
    expect(by(0)!.fix).toMatch(/multiples of 4px/);

    // offsets, translate and a negative margin of 12 px are laid out as given or on the grid: nothing for div:4
    expect(f.some((x) => x.path.endsWith("div:4"))).toBe(false);
    // a kit without 1920×1080: these lengths are whole at 1 and 0.5; 1920×1080 as a scaled viewport is exempt
    const { p, done } = page(body, css);
    try {
      const noHalf = (await lintFile(p, { ...kit, viewports: [[2560, 1440], [1280, 720]] })).filter((x) => x.ruleId === "U-CSS-046");
      expect(noHalf).toEqual([]);
      const scaled = (await lintFile(p, { ...kit, viewports: [[2560, 1440], [1920, 1080], [1280, 720]], scaledViewports: [[1920, 1080]] }))
        .filter((x) => x.ruleId === "U-CSS-046");
      expect(scaled).toEqual([]);
      // 1 px is half a device pixel at 1280×720
      const odd = await ids(`<div class="odd"></div>`, `.odd{width:40px;height:40px;margin-bottom:1px}`, "U-CSS-046");
      expect(odd[0].detail).toMatch(/margin-bottom: 1px is 0\.75 device px at 1920×1080, 0\.5 device px at 1280×720 .*0px or 4px/);
    } finally { done(); }
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
        .screen{display:flex;flex-direction:column;width:2560px;height:1440px;position:relative;font-family:"Inter UI";font-size:18px;line-height:22px;color:#ffffff;background-color:#0b1f26}
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

describe("U-FONT-004: the readable-text floor", () => {
  it("names the element, its text style, the viewports it draws below 9 device px at and the minimum design size", async () => {
    const f = (await lintFile(fx("U-FONT-004.fail.html"))).filter((x) => x.ruleId === "U-FONT-004");
    expect(f.map((x) => `${x.path}: ${x.detail}`)).toEqual([
      "[data-u-screen=lint.sample] > p:1: text style caption (12px) draws 6 device px at 1280×720: below the readable-text floor of 9 device px; the minimum design size here is 18px",
    ]);
    expect(f[0].fix).toMatch(/No text may draw below 9 device px at any declared viewport \(the smallest is 1280×720, scale 0\.5\): use a text style of at least 18px, such as label \(18px \/ 22px, 400\)/);
  });

  it("counts the scale a transform draws the text at in a state it is drawn in, its font size in a state, not an animation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "floor-"));
    const page = (css: string, cls = "box") => {
      const file = path.join(dir, `p${Math.random().toString(36).slice(2)}.html`);
      fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>:root{-webkit-font-smoothing:antialiased}body{margin:0}
        .screen{display:flex;flex-direction:column;width:2560px;height:1440px;position:relative;font-family:"Inter UI";font-size:24px;line-height:30px;color:#ffffff;background-color:#0b1f26}
        p{margin:0} .box{display:flex;flex-direction:column;flex-shrink:0;transform-origin:0 0} ${css}</style></head>
        <body><div class="screen" data-u-screen="lint.sample"><div class="${cls}" data-u-id="box"><p data-l10n="lint.sample.t" data-en="T">Metin</p></div></div></body></html>`);
      return file;
    };
    const floor = async (css: string, cls?: string) => (await lintFile(page(css, cls))).filter((x) => x.ruleId === "U-FONT-004").map((x) => x.detail);
    try {
      // 24 px × 0.5 × 0.5 = 6 device px: the minimum is 36 px under that transform
      expect(await floor(".box{transform:scale(0.5)}")).toEqual([expect.stringMatching(/^text style body \(24px\), scaled ×0\.5 by its transforms, draws 6 device px at 1280×720: .* the minimum design size here is 36px$/)]);
      expect(await floor(".box{scale:0.75}")).toEqual([]);
      // a hover state that shrinks it counts; an animation passing through a small scale does not
      expect(await floor(".box:hover{scale:0.5}")).toHaveLength(1);
      expect(await floor("@keyframes pop{from{scale:0.2}to{scale:1}} .box{animation:pop 200ms linear}")).toEqual([]);
      // a pop-in whose hidden state is scale 0 (or 0.5) with opacity 0: never drawn there, so never judged there
      for (const closed of ["0", "0.5"])
        expect(await floor(`.box{transform:scale(${closed});opacity:0;transition:transform 200ms,opacity 200ms} .box.is-open{transform:scale(1);opacity:1}`)).toEqual([]);
      // a visible state at 0.4 is drawn below the floor
      expect(await floor(".box.is-open{scale:0.4}")).toEqual([expect.stringMatching(/scaled ×0\.4 by its transforms, draws 4\.8 device px at 1280×720, 7\.2 device px at 1920×1080/)]);
      // a state's transform multiplies with the scale: 24 × 0.75 × 0.9 × 0.5 = 8.1
      expect(await floor(".box{scale:0.75} .box:active{transform:scale(0.9)}")).toEqual([expect.stringMatching(/scaled ×0\.675 by its transforms, draws 8\.1 device px at 1280×720/)]);
      // a state's font-size in em, % or rem is judged at the parent's size; one that cannot be resolved is named
      expect(await floor(".box:hover p{font-size:0.5em}")).toEqual(["font-size: 0.5em (12px) [style:0 .box:hover p] draws 6 device px at 1280×720: below the readable-text floor of 9 device px; the minimum design size here is 18px"]);
      expect(await floor(".box:hover p{font-size:calc(1em - 2px)}")).toEqual([expect.stringMatching(/font-size: calc\(1em - 2px\) \[style:0 .box:hover p\] cannot be resolved to px here/)]);
      for (const css of [".box{transform:scale(0)}", ".box{scale:0} .box:hover{scale:0.2}"]) for (const d of await floor(css)) expect(d).not.toMatch(/Infinity|NaN/);
      // text the design keeps hidden (a closed dialog, menu, toast) is judged where a rule or code shows it: a rule that only
      // shows it keeps the now scale, and so does a hidden container's text
      for (const css of [".box{scale:0.5;opacity:0} .box.is-open{opacity:1}", ".box{scale:0.5;visibility:hidden} .box.is-open{visibility:visible}",
        ".box{scale:0.5;display:none} .box.is-open{display:flex}", ".box{opacity:0} .box.is-open{opacity:1} .box p{scale:0.5}", ".box{scale:0.5;display:none}"])
        expect(await floor(css), css).toEqual([expect.stringMatching(/scaled ×0\.5 by its transforms, draws 6 device px at 1280×720/)]);
      // two state rules that apply together multiply: hovered and pressed, 24 × 0.8 × 0.8 × 0.5 = 7.68
      expect(await floor(".box:hover{scale:0.8} .box:active{transform:scale(0.8)}")).toEqual([expect.stringMatching(/scaled ×0\.64 by its transforms, draws 7\.68 device px at 1280×720/)]);
      // drawn open at 1, never at the closed 0.5: an animation that ends visible and keeps its end shows it at its last
      // keyframe; a closed scale under :not(.is-open) cannot apply while open; a reveal split over two rules of one state
      for (const css of ["@keyframes pop{to{opacity:1;transform:scale(1)}} .box{opacity:0;transform:scale(0.5)} .box.is-open{animation:pop 300ms ease-out forwards}",
        ".box{opacity:0} .box.is-open{opacity:1} .box:not(.is-open){transform:scale(0.5)}",
        ".box{opacity:0;transform:scale(0.5)} .box.is-open{opacity:1} .box.is-open{transform:none}"])
        expect(await floor(css), css).toEqual([]);
      // an animation that does not keep its end, or ends at the closed scale, leaves it drawn there
      expect(await floor("@keyframes pop{to{opacity:1;transform:scale(1)}} .box{opacity:0;transform:scale(0.5)} .box.is-open{opacity:1;animation:pop 300ms ease-out}")).toHaveLength(1);
      expect(await floor("@keyframes pop{to{opacity:1;transform:scale(0.5)}} .box{opacity:0} .box.is-open{animation:pop 300ms ease-out forwards}")).toHaveLength(1);
      // drawn at 0.5 while open: a rule of no state that a state rule replaces only while closed
      expect(await floor(".box{transform:scale(0.5)} .box:not(.is-open){transform:none}")).toEqual([expect.stringMatching(/scaled ×0\.5 by its transforms, draws 6 device px at 1280×720/)]);
      // never drawn at 0.5: a more specific or a later rule of no state overrides it, also when a state rule sets the property
      // (a hover's scale); the one of no state that wins without the state rule is judged (the cascade's, !important first)
      for (const [css, cls] of [[".box{transform:scale(0.5)} .box.wide{transform:none} .box:hover{transform:scale(1.1)}", "box wide"],
        [".box{transform:scale(0.5)} .box{transform:none} .box:hover{transform:scale(1.1)}", "box"],
        [".box{transform:scale(0.5)} .box{transform:none}", "box"],
        [".box{transform:scale(0.5)} .box.wide{transform:none} .box.is-open{transform:scale(1.1)}", "box wide is-open"]])
        expect(await floor(css, cls), css).toEqual([]);
      for (const [css, cls] of [[".box.wide{transform:scale(0.5)} .box{transform:none} .box:not(.is-open){transform:scale(1.1)}", "box wide"],
        [".box{transform:scale(0.5) !important} .box.wide{transform:none} .box:hover{transform:scale(1.1)}", "box wide"]])
        expect(await floor(css, cls), css).toEqual([expect.stringMatching(/scaled ×0\.5 by its transforms, draws 6 device px at 1280×720/)]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("judges a breakpoint's font size only at the declared viewports where its @media holds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "floor-bp-"));
    const page = (css: string) => {
      const file = path.join(dir, `p${Math.random().toString(36).slice(2)}.html`);
      fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>:root{-webkit-font-smoothing:antialiased}body{margin:0}
        .screen{display:flex;flex-direction:column;width:2560px;height:1440px;position:relative;font-family:"Inter UI";font-size:24px;line-height:30px;color:#ffffff;background-color:#0b1f26}
        p{margin:0} .box{display:flex;flex-direction:column;flex-shrink:0} ${css}</style></head>
        <body><div class="screen" data-u-screen="lint.sample"><div class="box" data-u-id="box"><p data-l10n="lint.sample.t" data-en="T">Metin</p></div></div></body></html>`);
      return file;
    };
    const floor = async (css: string) => (await lintFile(page(css))).filter((x) => x.ruleId === "U-FONT-004").map((x) => x.detail);
    try {
      // the lint kit declares 16:9 viewports only: a 21:9 breakpoint never holds at them, a 16:9 one at every one
      expect(await floor("@media (min-aspect-ratio: 21/9) { .box p { font-size: 0.7em } }")).toEqual([]);
      // (it holds at the lint's own render too, so the computed size is judged as well)
      expect(await floor("@media (min-aspect-ratio: 16/9) { .box p { font-size: 0.7em } }")).toEqual([
        expect.stringMatching(/font-size: 0\.7em \(16\.8px\) \[style:0 .box p\] draws 8\.4 device px at 1280×720: below the readable-text floor/)]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
      expect(title.computed["font-size"]).toBe("18px");
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
        .screen{display:flex;flex-direction:column;width:2560px;height:1440px;overflow:hidden;font-family:"Inter UI";font-size:18px;line-height:22px;color:#ffffff;background-color:#0b1f26}
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

describe("text cut by its box: clipped line boxes (U-CSS-047) and words wider than their box (W-TEXT-001)", () => {
  /** The repository's own design kit: caption 20/28 and label 20/24, the six default viewports. */
  const designKit = readKit(path.join(here, "..", "..", "..", "design-kit"));
  const page = (body: string, css: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-clip-"));
    const p = path.join(dir, "s.html");
    fs.writeFileSync(p, `<!doctype html><html><head><meta charset="utf-8"><style>:root{-webkit-font-smoothing:antialiased}body{margin:0} *,*::before,*::after{box-sizing:border-box}
      .screen{display:flex;flex-direction:column;width:2560px;height:1440px;position:relative;font-family:"Inter UI";font-size:20px;line-height:24px;color:#ffffff;background-color:#0b1f26}
      p{margin:0}${css}</style></head><body><div class="screen" data-u-screen="s">${body}</div></body></html>`);
    return { p, done: () => fs.rmSync(dir, { recursive: true }) };
  };
  const ids = async (body: string, css: string, rule: string, k: KitConfig = designKit) => {
    const { p, done } = page(body, css);
    try { return (await lintFile(p, k)).filter((f) => f.ruleId === rule); } finally { done(); }
  };
  const text = (cls: string, en = "Today", tr = "Bugün") => `<p class="${cls}" data-l10n="s.${cls}" data-en="${en}">${tr}</p>`;

  it("U-CSS-047: the kit's 20/24 label in a 20 px box with overflow hidden is an error with the fix; a 24 px box, or one without overflow hidden, is not", async () => {
    const box = `display:flex;flex-direction:row;align-items:center;flex-shrink:0;align-self:flex-start;padding:0 8px;margin-bottom:16px`;
    const f = await ids(
      `<div class="short">${text("a")}</div><div class="fits">${text("b")}</div><div class="open">${text("c")}</div>`,
      `.short{${box};height:20px;overflow:hidden} .fits{${box};height:24px;overflow:hidden} .open{${box};height:20px}`, "U-CSS-047");
    expect(f.map((x) => x.path)).toEqual(["[data-u-screen=s] > div:0 > p:0"]);
    expect(f[0].severity).toBe("error");
    expect(f[0].detail).toMatch(/24 px line box/);
    expect(f[0].detail).toMatch(/20 px tall/);
    expect(f[0].detail).toMatch(/div:0/);
    expect(f[0].fix).toMatch(/make the box at least the line height/i);
    expect(f[0].fix).toMatch(/24 px/);
  });

  it("U-CSS-047: an ellipsis text box of a fixed height below its line height is an error; at its line height it is not", async () => {
    const cut = `flex-shrink:0;align-self:flex-start;width:120px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin-bottom:16px`;
    const f = await ids(`${text("low", "A long name of a player", "Uzun bir oyuncu adı")}${text("ok", "A long name of a player", "Uzun bir oyuncu adı")}`,
      `.low{${cut};height:20px} .ok{${cut};height:24px}`, "U-CSS-047");
    expect(f.map((x) => x.path)).toEqual(["[data-u-screen=s] > p:0"]);
  });

  it("U-CSS-047: a second line half cut by a fixed-height box is an error; a box that ends between lines, a list cut by a tall box and a scroll area are not", async () => {
    const two = `<p class="two" data-l10n="s.two" data-en="Ticket prices stay the same for the rest of the season">Bilet fiyatları sezonun geri kalanında aynı kalıyor ve değişmiyor</p>`;
    const rows = Array.from({ length: 80 }, (_, i) => `<div class="row">${text(`r${i}`)}</div>`).join("");
    const f = await ids(
      `<div class="half">${two}</div><div class="whole">${two}</div><div class="list">${rows}</div>` +
      `<div class="scroll" data-u-id="scroll">${Array.from({ length: 30 }, (_, i) => `<div class="row">${text(`s${i}`)}</div>`).join("")}</div>`,
      `.half,.whole{flex-shrink:0;align-self:flex-start;width:240px;overflow:hidden;margin-bottom:16px} .half{height:36px} .whole{height:24px}
       .two{flex-shrink:0} .list{display:flex;flex-direction:column;flex-shrink:0;height:400px;overflow:hidden} .row{display:flex;flex-shrink:0;height:30px}
       .scroll{display:flex;flex-direction:column;flex-shrink:0;height:100px;overflow-y:auto}`, "U-CSS-047");
    expect(f.map((x) => x.path)).toEqual(["[data-u-screen=s] > div:0 > p:0"]);
    expect(f[0].detail).toMatch(/36 px tall/);
  });
  it("U-CSS-047: a box inside a scaled container is judged in the same space as its text: a box of its line height passes", async () => {
    const box = `display:flex;flex-direction:row;align-items:center;flex-shrink:0;align-self:flex-start;padding:0 8px;height:24px;overflow:hidden`;
    const f = await ids(`<div class="scaled"><div class="fits">${text("a")}</div></div><div class="scaled"><div class="short">${text("b")}</div></div>`,
      `.scaled{display:flex;flex-direction:column;flex-shrink:0;align-self:flex-start;margin-bottom:16px;transform:scale(0.9);transform-origin:0 0}
       .fits{${box}} .short{${box};height:20px}`, "U-CSS-047");
    expect(f.map((x) => x.path)).toEqual(["[data-u-screen=s] > div:1 > div:0 > p:0"]);
  });

  it("U-CSS-047: a text offset in a box exactly its line height (a top padding) is cut at the box's edge: an error", async () => {
    const f = await ids(`<div class="offset">${text("a", "Going", "Gyç")}</div><div class="even">${text("b", "Going", "Gyç")}</div>`,
      `.offset,.even{display:flex;flex-direction:row;align-items:center;flex-shrink:0;align-self:flex-start;height:24px;overflow:hidden;margin-bottom:16px}
       .offset{padding-top:4px} .even{padding:0 8px}`, "U-CSS-047");
    expect(f.map((x) => x.path)).toEqual(["[data-u-screen=s] > div:0 > p:0"]);
    expect(f[0].detail).toMatch(/2 px at the bottom/);
  });

  it("W-TEXT-001: a word wider than its wrapping box is a warning naming the quotation mark the advanced generator breaks after; a box that fits it and a nowrap text are not", async () => {
    const box = `flex-shrink:0;align-self:flex-start;margin-bottom:16px`;
    const f = await ids(
      `${text("narrow", "Today’s matches", "AUJOURD’HUI")}${text("quoted", "Matches", "«AUJOURD»HUI")}${text("wide", "Today’s matches", "AUJOURD’HUI")}${text("cut", "Today’s matches", "AUJOURD’HUI")}`,
      `.narrow{${box};width:96px} .quoted{${box};width:96px} .wide{${box};width:240px} .cut{${box};width:96px;height:24px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}`,
      "W-TEXT-001");
    expect(f.map((x) => x.path)).toEqual(["[data-u-screen=s] > p:0", "[data-u-screen=s] > p:1"]);
    expect(f[0].severity).toBe("warning");
    expect(f[0].detail).toMatch(/AUJOURD’HUI/);
    expect(f[0].detail).toMatch(/96 px/);
    expect(f[0].detail).not.toMatch(/after “/);
    expect(f[1].detail).toMatch(/after “«”, “»”/);
    expect(f[0].fix).toMatch(/nowrap/);
  });
});
