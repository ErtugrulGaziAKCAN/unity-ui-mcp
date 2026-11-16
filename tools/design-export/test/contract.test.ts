import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CONTRACT_FILE, parseScreenContract, readContractFile, readScreenContract } from "../src/contract.js";

const tmpDirs: string[] = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "contract-"))); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const EXAMPLE = {
  contract: 1, screen: "club.overview", kind: "update",
  replaces: "The current club overview screen (its route, view and presenter as the project names them)",
  values: [
    { name: "club-name", source: "the club service's current club name", samples: ["Eastmoor FC", "Real Club Deportivo de la Costa"], origin: "existing" },
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
const clone = () => JSON.parse(JSON.stringify(EXAMPLE));
const problemsOf = (j: unknown) => { const r = parseScreenContract(j); return "problems" in r ? r.problems : []; };

describe("screen contract loader", () => {
  it("loads the spec's example contract", () => {
    const r = parseScreenContract(EXAMPLE);
    if (!("contract" in r)) throw new Error(r.problems.join("\n"));
    const c = r.contract;
    expect(c.items).toHaveLength(9);
    expect(c.items.filter((i) => i.kind === "value")).toHaveLength(3);
    expect(c.items.filter((i) => i.kind === "action")).toHaveLength(3);
    expect(c.items.filter((i) => i.kind === "state")).toHaveLength(1);
    expect(c.items.filter((i) => i.kind === "repeat")).toHaveLength(1);
    expect(c.items.filter((i) => i.kind === "text")).toHaveLength(1);
    expect(c.removed).toEqual([{ kind: "action", name: "refresh", repeat: null, note: "user, 2026-11-16: the screen refreshes by itself" }]);
    expect(c.items.find((i) => i.name === "player-name")!.repeat).toBe("player");
    expect(c.items.find((i) => i.name === "club-name")!.repeat).toBeNull();
    const compare = c.items.find((i) => i.name === "compare-players")!;
    expect(compare.source).toBeNull();
    expect(compare.origin).toBe("requested");
    expect(c.items.find((i) => i.name === "open-inbox")!.source).toBe("shell route command: open inbox");
    expect(c.items.find((i) => i.name === "loading")!.source).toBe("first read of the club data has not finished");
    expect(c.items.find((i) => i.kind === "repeat")).toMatchObject({ repeat: null, count: [0, 40] });
    expect(c.items.find((i) => i.kind === "text")).toMatchObject({ name: "club.overview.title", en: "Club overview", source: null });
  });

  const cases: [string, (j: any) => void, string][] = [
    ["a wrong version", (j) => { j.contract = 2; }, "contract must be 1"],
    ["a missing version", (j) => { delete j.contract; }, "contract must be 1"],
    ["a missing screen", (j) => { delete j.screen; }, "screen is missing"],
    ["a bad kind", (j) => { j.kind = "redo"; }, 'kind must be "update" or "new"'],
    ["update without replaces", (j) => { delete j.replaces; }, 'needs "replaces"'],
    ["update with an empty replaces", (j) => { j.replaces = "  "; }, 'needs "replaces"'],
    ["new with removed", (j) => { j.kind = "new"; }, 'cannot have removed items'],
    ["an unknown top-level key", (j) => { j.extra = 1; }, 'unknown key "extra"'],
    ["a bad value name", (j) => { j.values[0].name = "Club Name"; }, 'value "Club Name" does not match'],
    ["a bad text key", (j) => { j.texts[0].key = "club overview"; }, 'text "club overview" does not match'],
    ["an upper-case id in a repeat scope", (j) => { j.values[1].repeat = "Player"; }, 'value "player-name": repeat "Player" does not match'],
    ["a duplicate value", (j) => { j.values.push({ ...j.values[0] }); }, 'duplicate value "club-name" in the screen'],
    ["a duplicate in a list scope", (j) => { j.actions.push({ ...j.actions[1] }); }, 'duplicate action "open-player" in repeat "player"'],
    ["an existing action without a handler", (j) => { j.actions[0].handler = ""; }, 'existing action "open-inbox" has no handler'],
    ["an existing value without a source", (j) => { delete j.values[0].source; }, 'existing value "club-name" has no source'],
    ["an existing repeat without a source", (j) => { j.repeats[0].source = null; }, 'existing repeat "player" has no source'],
    ["an existing state without when", (j) => { delete j.states[0].when; }, 'existing state "loading" has no when'],
    ["a requested value without a note", (j) => { j.values.push({ name: "x", source: null, origin: "requested" }); }, 'requested value "x" has no note (who asked, when, what)'],
    ["an existing value without samples", (j) => { delete j.values[2].samples; }, 'existing value "budget" has no samples'],
    ["empty samples", (j) => { j.values[2].samples = []; }, 'value "budget" has empty samples'],
    ["a count out of order", (j) => { j.repeats[0].count = [5, 2]; }, 'repeat "player": count must be [min, max]'],
    ["a fractional count", (j) => { j.repeats[0].count = [0, 1.5]; }, 'repeat "player": count must be [min, max]'],
    ["a text without en", (j) => { delete j.texts[0].en; }, 'text "club.overview.title" has no en'],
    ["a removed entry with a bad kind", (j) => { j.removed[0].kind = "button"; }, "removed[0]: kind must be one of"],
    ["a removed entry with a bad name", (j) => { j.removed[0].name = "Refresh!"; }, 'removed action "Refresh!" has a bad name'],
    ["a removed entry without a note", (j) => { delete j.removed[0].note; }, 'removed action "refresh" has no note'],
    ["a removed state with a repeat", (j) => { j.removed.push({ kind: "state", name: "error", repeat: "player", note: "n" }); }, 'removed state "error" cannot have a repeat'],
    ["a removed text with a parent", (j) => { j.removed.push({ kind: "text", name: "club.overview.subtitle", parent: "player", note: "n" }); }, 'removed text "club.overview.subtitle" cannot have a repeat'],
    ["an item both listed and removed", (j) => { j.removed.push({ kind: "value", name: "club-name", note: "n" }); }, 'value "club-name" is both listed and removed'],
    ["an unknown key in a value", (j) => { j.values[1].parent = "player"; }, 'value "player-name": unknown key "parent"'],
    ["an unknown key in an action", (j) => { j.actions[0].source = "inbox route"; }, 'action "open-inbox": unknown key "source"'],
    ["an unknown key in a state", (j) => { j.states[0].repeat = "player"; }, 'state "loading": unknown key "repeat"'],
    ["an unknown key in a repeat", (j) => { j.repeats[0].repeat = "team"; }, 'repeat "player": unknown key "repeat"'],
    ["an unknown key in a text", (j) => { j.texts[0].tr = "Kulüp"; }, 'text "club.overview.title": unknown key "tr"'],
    ["an unknown key in a nameless item", (j) => { j.values.push({ title: "x", origin: "existing" }); }, 'value at values[3]: unknown key "title"'],
    ["an unknown key in a removed entry", (j) => { j.removed[0].reason = "auto refresh"; }, 'removed action "refresh": unknown key "reason"'],
    ["a non-boolean image", (j) => { j.values.push({ name: "crest", source: "club crest sprite", image: "yes", origin: "existing" }); }, 'value "crest": image must be true or false'],
    ["a non-string ref", (j) => { j.texts[0].ref = 42; }, 'text "club.overview.title": ref must be a string'],
  ];
  it.each(cases)("names each problem: %s", (_n, mutate, message) => {
    const j = clone();
    mutate(j);
    expect(problemsOf(j).join("\n")).toContain(message);
  });

  it("knows every documented key of each kind", () => {
    const j = clone();
    j.values.push({ name: "crest", repeat: "player", source: "row crest sprite", image: true, origin: "existing", note: "the row's club" });
    j.values.push({ name: "flag", source: "nation flag", image: false, samples: ["TR"], origin: "existing" });
    j.actions[0].note = "the inbox button"; j.states[0].note = "a spinner";
    j.repeats.push({ name: "season", parent: "player", source: "career reader", count: [1, 20], origin: "existing", note: "per player" });
    j.texts[0].ref = "Kulüp özeti"; j.texts[0].note = "the header";
    j.removed.push({ kind: "repeat", name: "trophy", parent: "player", note: "user, 2026-11-16: no trophies" });
    j.removed.push({ kind: "value", name: "age", repeat: "player", note: "user, 2026-11-16: no ages" });
    expect(problemsOf(j)).toEqual([]);
  });

  it("allows an image value without samples and a requested value with no source", () => {
    const j = clone();
    j.values.push({ name: "crest", source: "club crest sprite", image: true, origin: "existing" });
    j.values.push({ name: "form", source: null, origin: "requested", note: "user, 2026-11-16: show form" });
    expect(problemsOf(j)).toEqual([]);
  });

  it("requires samples for a requested value that has a source", () => {
    const j = clone();
    j.values.push({ name: "form", source: "form reader", origin: "requested", note: "user, 2026-11-16: show form" });
    expect(problemsOf(j).join("\n")).toContain('requested value "form" has no samples');
    j.values[3].samples = ["WWDLW"];
    expect(problemsOf(j)).toEqual([]);
  });

  it("allows the same name in the screen and in a list", () => {
    const j = clone();
    j.values.push({ name: "club-name", repeat: "player", source: "row club", samples: ["A"], origin: "existing" });
    expect(problemsOf(j)).toEqual([]);
  });

  it("reports every problem at once", () => {
    const j = clone();
    j.contract = 2; delete j.screen; j.kind = "x";
    expect(problemsOf(j).length).toBeGreaterThanOrEqual(3);
  });

  it("reads files", () => {
    const dir = tmp();
    const f = path.join(dir, CONTRACT_FILE);
    expect(readContractFile(f)).toEqual({ state: "absent", file: f });
    fs.writeFileSync(f, "{");
    const bad = readContractFile(f);
    expect(bad.state).toBe("invalid");
    if (bad.state === "invalid") {
      expect(bad.problems[0]).toMatch(/^screen\.contract\.json is not valid JSON: .+/);
      expect(bad.sha).toMatch(/^[0-9a-f]{64}$/);
    }
    fs.writeFileSync(f, JSON.stringify(EXAMPLE));
    const ok = readContractFile(f);
    expect(ok.state).toBe("valid");
    if (ok.state === "valid") {
      expect(ok.sha).toMatch(/^[0-9a-f]{64}$/);
      expect(ok.contract.screen).toBe("club.overview");
    }
    fs.writeFileSync(f, JSON.stringify({ ...EXAMPLE, contract: 2 }));
    const wrong = readContractFile(f);
    expect(wrong).toMatchObject({ state: "invalid", problems: ["contract must be 1"] });
  });

  it("readScreenContract looks beside the design", () => {
    const dir = tmp();
    expect(readScreenContract(dir)).toEqual({ state: "absent", file: path.join(dir, CONTRACT_FILE) });
    fs.writeFileSync(path.join(dir, CONTRACT_FILE), JSON.stringify(EXAMPLE));
    expect(readScreenContract(dir).state).toBe("valid");
  });
});
