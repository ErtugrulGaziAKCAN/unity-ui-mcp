# Screen contract: designs from the game, checked by lint

Status: proposed, 2026-11-16. Extends [2026-11-12-design-to-uitoolkit-design.md](2026-11-12-design-to-uitoolkit-design.md).

## 1. Problem

Players use the screens this pipeline produces. Two failures happened in practice:

- A design tool, asked for a redesign, first drew quick mock-ups. They had buttons, texts and statistics the game cannot
  back, and nobody had asked for them.
- An imported redesign passed `design_ui_verify` and stopped there. The generated view was not connected to anything,
  so the screen looked right and did nothing.

Since 0.1.0 the rules, skill and server instructions ask for an inventory first and in-game proof last (CHANGELOG,
"Unreleased"). Text alone does not stop either failure. This spec makes the inventory a file that lint checks against
the design, that the design tool receives as its brief, and that the import hands to the presenter work as its
checklist.

## 2. Goals and non-goals

Goals:

- One file per screen, the **screen contract**, says what the game has for that screen. It covers:
  - every value with its source and real sample values;
  - every action with the code that handles it;
  - every state and every list;
  - every static text;
  - and, for a redesign, everything the current screen does.
- Lint fails a design that adds anything the contract lacks, drops anything it has, or shows sample values the game
  does not produce.
- The same contract is the brief the design tool gets, and the wiring and Play-proof checklist after import.
- The check is opt-in per project. A project that sets it to required cannot import a screen without a contract.

Non-goals:

- The tools do not read game code or databases. The AI that has the project open writes the contract from the
  project, as the skill already says it must for the inventory. The tools check the contract's shape and compare it with
  the design.
- No generated presenters. The generator still never writes or edits presenter code.
- No automatic gameplay proof. Play-mode checks stay the AI's work under the project's own test rules. The contract only
  lists what must be proved.

## 3. The contract file

**Location.** `<designRoot>/<screen-folder>/screen.contract.json`, beside the design. A folder with several artboards
of one screen shares one contract. A folder that holds artboards of more than one screen is already refused, so the
folder–screen pair is unique.

**Format.** JSON, `"contract": 1`:

```json
{
  "contract": 1,
  "screen": "club.overview",
  "kind": "update",
  "replaces": "The current club overview screen (its route, view and presenter as the project names them)",
  "values": [
    { "name": "club-name", "source": "the club service's current club name",
      "samples": ["Eastmoor FC", "Real Club Deportivo de la Costa"], "origin": "existing" },
    { "name": "player-name", "repeat": "player", "source": "squad reader, player display name",
      "samples": ["A. Novak", "Jean-Baptiste Okonkwo-Lindqvist"], "origin": "existing" },
    { "name": "budget", "source": "finance reader, formatted in the display currency",
      "samples": ["€12.4M", "€0"], "origin": "existing" }
  ],
  "actions": [
    { "name": "open-inbox", "handler": "shell route command: open inbox", "origin": "existing" },
    { "name": "open-player", "repeat": "player", "handler": "player profile route with the row's player id", "origin": "existing" },
    { "name": "compare-players", "handler": null, "origin": "requested", "note": "user, 2026-11-16: add a compare button" }
  ],
  "states": [ { "name": "loading", "when": "first read of the club data has not finished", "origin": "existing" } ],
  "repeats": [ { "name": "player", "source": "squad reader, first-team players", "count": [0, 40], "origin": "existing" } ],
  "texts": [ { "key": "club.overview.title", "en": "Club overview", "origin": "existing" } ],
  "removed": [ { "kind": "action", "name": "refresh", "note": "user, 2026-11-16: the screen refreshes by itself" } ]
}
```

**Fields.**

| Field | Meaning |
|---|---|
| `contract` | Format version; `1`. |
| `screen` | Must equal the design's `data-u-screen`. |
| `kind` | `"update"` (redesign of a UI the game has) or `"new"`. |
| `replaces` | Required for `update`: what the current UI is, in the project's own names. |
| `values[]` | One entry per `data-u-bind` and `data-u-arg` name, image binds included. `repeat` names the list the value lives in (absent: the screen itself). `samples` are real values as the game shows them, formatted. They are required, except for image binds and for requested values with no source yet. |
| `image` | In a `values[]` entry: `true` marks an image bind (an `<img>` or an element that paints an image), which has no `samples`. |
| `actions[]` | One entry per `data-u-action`, with `repeat` as above and `handler` (what runs it in the game). |
| `states[]` | One entry per `data-u-state`, with `when`. |
| `repeats[]` | One entry per `data-u-repeat`, with `parent` (a nesting list, absent at top), `source` and `count` `[min, max]` as the game produces it. |
| `texts[]` | One entry per `data-l10n` and `data-l10n-<attr>` key, with the English text `en` (the String Table entry for an existing key) and optionally `ref`, the reference-locale text as the game has it (compared by U-CON-006 only when given, so a non-English reference locale is not invented by the design tool). |
| `removed[]` | Items of the current UI the user decided to drop: `kind` (`value`, `action`, `state`, `repeat`, `text`), `name`, `repeat` (its list, absent for the screen; a removed list may name it `parent`), `note`. |

Entries have no keys other than those this section names (`origin` and `note` below included); any other key, a
non-boolean `image` or a non-string `ref` is a format problem.

**Origins.**

- `origin: "existing"`: the game has the item now. `source`, `handler` or `when` must be non-empty.
- `origin: "requested"`: the user asked for the item. It needs a `note` saying who asked, when and what. Its
  `source`/`handler` may be `null`, which makes the item a **named dependency**. Lint allows it; the brief, the import
  and the final report list it as missing in the game.
- `kind: "new"` screens have no `removed`.

**Names.** Names follow the markup rules: lowercase ASCII ids, case-sensitive keys (U-MRK-005). A name is unique per
kind and scope, where the scope is the screen or a repeat.

## 4. Kit setting

`kit.config.json` gains `"screenContract": "optional" | "required"`. The clone's default is `"optional"`.

| Setting | No contract | Contract present |
|---|---|---|
| `optional` | An info finding, `I-CON-001`. | Fully checked. |
| `required` | An error (`U-CON-001`) that blocks export and import. | Fully checked. |

`kit upgrade` keeps the project's value. The key joins the project-owned keys (`locales`, `referenceLocale`, …).
`design_ui_status` shows the setting and, per screen, whether a contract is present and valid.

## 5. Lint rules

Contract checks run only where the design's folder is known: the CLI `lint` and `export` commands, `design_ui_lint`
and `design_ui_import`. Callers load and validate the contract once. It reaches the rules through `LintContext.contract`
(`null` when absent), so rules stay pure functions of their inputs.

All are errors unless marked:

| Id | Fails when | Fix the finding names |
|---|---|---|
| `I-CON-001` (info) | No contract and the setting is `optional`. | Write one to have the design checked against the game. |
| `U-CON-001` | The contract is missing under `required`, is not valid JSON, fails the format above (each problem listed), or names another screen. | Write or repair `screen.contract.json`. |
| `U-CON-002` | The design has a value, action, state, list or text key, in a scope, that the contract lacks. | Remove it from the design, or add it to the contract: with its game source, or as requested with the user's note. |
| `U-CON-003` | A contract item that is not in `removed` is missing from the design, in its scope. | Draw it, or record the user's decision in `removed`. |
| `U-CON-004` | An item listed in `removed` is still in the design. | Remove it from the design. |
| `U-CON-005` | A bound text's sample, in any sample row, is not one of the value's `samples`. Values that do not render (hidden, an inactive state) are checked too. Whitespace is collapsed; image binds are skipped; so are requested values with no source. | Use a real sample from the contract. If the game shows other values, add those real values to the contract. For an image the design binds to a value with samples: mark it `image: true`. |
| `U-CON-006` | A text key's English (its `data-en`, or the visible text when the reference locale is `en`, as U-MRK-014 reads it) differs from the contract's `en`. | Use the game's text, or change the contract only when the user changed the text. |

Scope comparison uses the element's nearest `data-u-repeat` ancestor, the same scope the generated view uses for item
views. A value bound in the screen and in a list are two different contract entries.

## 6. Brief for the design tool

`design-export contract brief <screen-folder>` (CLI) and `design_ui_brief { screen }` (MCP) turn a valid contract into
Markdown that a design tool can take as its prompt. The folder needs no design page (a page path names its folder; a ZIP
design reads the contract inside it). The brief contains:

- the screen id and the kit rule "draw exactly this";
- for an update, what it replaces;
- one table per kind: values with real samples, actions, states, lists with counts, texts in the reference locale with
  their English;
- the removed items;
- the named dependencies.

An invalid contract returns the U-CON-001 problems instead. The skill shows the brief to the user for Claude Design.
When the AI designs the HTML itself, the brief is its starting point.

## 7. Import and the wiring checklist

`design_ui_import` with a contract adds a `wiring` section to its result, grouped by kind:

- each value with its `source`;
- each action with its `handler`;
- each state with its `when`;
- each list with its `source` and `count`;
- the named dependencies.

This is the checklist the presenter is written from. The final Play-proof table reports one row per entry: passed,
failed or not run. Without a contract, the result says that none was given and the wiring list must come from the
inventory. The import still refuses on lint errors, so under `required` no screen reaches Unity without a contract.

## 8. Rules, skill and docs

- **Kit rules.** A generated "Screen contract" section in the kit rules and in the Claude Design System README. It says
  that the design follows the brief exactly and that lint compares the two.
- **Skill.** The §3 inventory becomes "write `screen.contract.json` from the project". The skill then validates it
  (`design_ui_lint` reports U-CON-001), shows the brief before anything is designed, takes the wiring checklist from the
  import result, and reports the Play-proof table per contract item.
- **Server instructions.** The same steps.
- **Docs.** README, usage guide and decisions (`D-nnn`) are updated, with a CHANGELOG entry.

## 9. Testing

**Contract loader.**
- Valid files load.
- Each format problem is named: missing source on an existing item, missing note on a requested item, duplicate name in
  a scope, unknown kind, `replaces` missing for an update, a screen mismatch.

**Lint rules.** Each U-CON rule gets a passing and a failing fixture design, covering:
- scope (the same name in the screen and in a list);
- sample checks across several sample rows;
- requested values with no source;
- image binds;
- `removed`;
- English text with reference locales `en` and other.

**Setting.**
- `optional` with no contract gives an info finding only.
- `required` with no contract gives an error, and the import refuses.
- `kit upgrade` keeps the project's `required`.

**Brief and wiring.**
- The brief's Markdown is snapshot-tested.
- The import result's `wiring` section is tested through the MCP import tool test double.

**Generated rules.** `kit build --check` stays current with the new section.

**Pilot.**
- In the consumer project, a contract is written from the project for its existing pilot screen. Lint passes with
  `required`, and the brief and wiring list match the presenter that already exists.
- A screen imported without a contract is refused once `required` is on.

## 10. Versioning

This is a feature: `0.2.0`. The IR does not change, and neither does the Unity package (no C# change is needed). The
Node tools and the docs change. Tagging and the release are the maintainer's decision.
