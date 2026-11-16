import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "../src/commands.js";
import { contractBrief, namedDependencies } from "../src/contract-brief.js";
import { parseScreenContract, type ScreenContract } from "../src/contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.join(here, "fixtures", "extract", "kit");
const tmpDirs: string[] = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "brief-"))); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const EXAMPLE = {
  contract: 1, screen: "club.overview", kind: "update",
  replaces: "The current club overview screen (its route, view and presenter as the project names them)",
  values: [
    { name: "club-name", source: "the club service's current club name", samples: ["Northbridge FC", "Real Club Deportivo de la Costa"], origin: "existing" },
    { name: "player-name", repeat: "player", source: "squad reader, player display name", samples: ["A. Novak", "Jean-Baptiste Okonkwo-Lindqvist"], origin: "existing" },
    { name: "budget", source: "finance reader, formatted in the display currency", samples: ["€12.4M", "€0"], origin: "existing" },
  ],
  actions: [
    { name: "open-inbox", handler: "shell route command: open inbox", origin: "existing" },
    { name: "open-player", repeat: "player", handler: "player profile route with the row's player id", origin: "existing" },
    { name: "compare-players", handler: null, origin: "requested", note: "user, 2026-11-16: add a compare button" },
  ],
  states: [{ name: "loading", when: "first read of the club data has not finished", origin: "existing" }],
  repeats: [{ name: "player", source: "squad reader, first-team players", count: [0, 40], origin: "existing" }],
  texts: [{ key: "club.overview.title", en: "Club overview", origin: "existing" }],
  removed: [{ kind: "action", name: "refresh", note: "user, 2026-11-16: the screen refreshes by itself" }],
};
const parse = (j: unknown): ScreenContract => {
  const r = parseScreenContract(j);
  if (!("contract" in r)) throw new Error(r.problems.join("\n"));
  return r.contract;
};
const kit = { locales: ["tr"], referenceLocale: undefined };

describe("contract brief", () => {
  it("renders the spec example", () => {
    expect(contractBrief(parse(EXAMPLE), kit)).toMatchInlineSnapshot(`
      "# Design brief: club.overview

      Draw exactly this inventory: nothing more, nothing less. Lint compares the design with screen.contract.json.

      Replaces: The current club overview screen (its route, view and presenter as the project names them)

      ## Values

      | Name | In | Source | Real samples |
      |---|---|---|---|
      | club-name | screen | the club service's current club name | Northbridge FC · Real Club Deportivo de la Costa |
      | player-name | repeat player | squad reader, player display name | A. Novak · Jean-Baptiste Okonkwo-Lindqvist |
      | budget | screen | finance reader, formatted in the display currency | €12.4M · €0 |

      ## Actions

      | Name | In | Handler |
      |---|---|---|
      | open-inbox | screen | shell route command: open inbox |
      | open-player | repeat player | player profile route with the row's player id |
      | compare-players | screen | — |

      ## States

      | Name | When |
      |---|---|
      | loading | first read of the club data has not finished |

      ## Lists

      | Name | Inside | Source | Count |
      |---|---|---|---|
      | player | screen | squad reader, first-team players | 0–40 |

      ## Texts

      | Key | English |
      |---|---|
      | club.overview.title | Club overview |

      ## Removed

      | Kind | Name | Note |
      |---|---|---|
      | action | refresh | user, 2026-11-16: the screen refreshes by itself |

      ## Named dependencies

      - action compare-players: user, 2026-11-16: add a compare button
      "
    `);
  });

  it("omits empty sections and escapes pipes", () => {
    const c = parse({
      contract: 1, screen: "tiny", kind: "new",
      values: [{ name: "cover", image: true, source: "art | cache", origin: "existing" }, { name: "label", source: "a|b", samples: ["x | y", "z"], origin: "existing" }],
      texts: [{ key: "tiny.title", en: "A | B", ref: "A | B (tr)", origin: "existing" }],
    });
    const brief = contractBrief(c, { locales: ["tr", "en"], referenceLocale: "tr" });
    expect(brief).toContain("| cover | screen | art \\| cache | image |");
    expect(brief).toContain("| label | screen | a\\|b | x \\| y · z |");
    expect(brief).toContain("| Key | English | tr |");
    expect(brief).toContain("| tiny.title | A \\| B | A \\| B (tr) |");
    for (const s of ["Replaces:", "## Actions", "## States", "## Lists", "## Removed", "## Named dependencies"]) expect(brief).not.toContain(s);
  });

  it("lists requested items without a source as named dependencies", () => {
    expect(namedDependencies(parse(EXAMPLE))).toEqual(["action compare-players: user, 2026-11-16: add a compare button"]);
  });
});

describe("requested texts", () => {
  it("are not named dependencies", () => {
    const c = parse({ ...EXAMPLE, texts: [...EXAMPLE.texts, { key: "club.overview.hint", en: "Hint", origin: "requested", note: "user, 2026-11-16: add a hint" }] });
    expect(namedDependencies(c)).toEqual(["action compare-players: user, 2026-11-16: add a compare button"]);
    const brief = contractBrief(c, kit);
    expect(brief).toContain("| club.overview.hint | Hint |");
    expect(brief.split("## Named dependencies")[1]).not.toContain("hint");
  });
});

describe("design-export contract brief", () => {
  const run = async (argv: string[]) => {
    let out = "";
    const code = await runCli(argv, { out: (s) => { out += s; }, err: (s) => { out += s; } });
    return { code, out };
  };

  it("prints the brief for a valid contract and exits 0", async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "screen.contract.json"), JSON.stringify(EXAMPLE));
    const r = await run(["contract", "brief", d, "--kit", KIT]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(contractBrief(parse(EXAMPLE), { locales: ["tr"] }));
  });

  it("prints the problems of an invalid contract and exits 1", async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "screen.contract.json"), JSON.stringify({ contract: 2 }));
    const r = await run(["contract", "brief", d, "--kit", KIT]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^screen\.contract\.json: contract must be 1$/m);
  });

  it("reports an absent contract and exits 1", async () => {
    const d = tmp();
    const r = await run(["contract", "brief", d, "--kit", KIT]);
    expect(r.code).toBe(1);
    expect(r.out).toBe(`no screen.contract.json in ${d}\n`);
  });

  it("takes a design page like lint and export: the contract beside it", async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "screen.contract.json"), JSON.stringify(EXAMPLE));
    for (const n of ["month.dc.html", "empty-day.dc.html"]) fs.writeFileSync(path.join(d, n), "<p>artboard</p>");
    const r = await run(["contract", "brief", path.join(d, "month.dc.html"), "--kit", KIT]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(contractBrief(parse(EXAMPLE), { locales: ["tr"] }));
    // the folder of several artboards works too: no page is needed
    expect((await run(["contract", "brief", d, "--kit", KIT])).code).toBe(0);
    // a path that does not exist, or is no folder or page, is a usage error
    expect(await run(["contract", "brief", path.join(d, "nope"), "--kit", KIT])).toEqual({ code: 2, out: `design-export: design not found: ${path.join(d, "nope")}\n` });
    fs.writeFileSync(path.join(d, "notes.txt"), "x");
    const txt = await run(["contract", "brief", path.join(d, "notes.txt"), "--kit", KIT]);
    expect(txt.code).toBe(2);
    expect(txt.out).toContain("is not a screen folder or a design page");
  });
});
