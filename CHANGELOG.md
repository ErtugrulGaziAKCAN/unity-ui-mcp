# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org); the
Unity package (`com.ertugrulgaziakcan.design-ui`) and the Node tools share the version number. Measurements behind the
numbers below are in [docs/findings/](docs/findings/); the decisions they cite (`D-nnn`) are in
[docs/decisions.md](docs/decisions.md).

## 0.1.0 - 2026-11-16

The first release: a screen designed in Claude Design (or any HTML that follows the design kit's rules) becomes a working
Unity UI Toolkit screen, and its Unity rendering is measured against the design at every resolution the game ships.
Licensed under the MIT License (`LICENSE`); the bundled Inter font stays under the SIL Open Font License (`OFL.txt`).

### What it does

**The design kit and its contract** (`design-kit/`)

- Tokens, fourteen text styles (caption 20/28 to display 64/80 px, 400 and 700) whose sizes and line heights are whole
  device pixels at every exact viewport, a generated base stylesheet, nine components (button, toggle, text field,
  dropdown, tabs, card, list row, scroll area, dialog) and 24 fidelity fixtures.
- `RULES.md`, generated from the kit and the lint's own data: markup attributes, text styles, fonts, tokens, allowed CSS,
  every lint rule with its fix, the Claude Design artboard rules and an example screen. The MCP tool `design_ui_rules`
  serves it to any AI that writes the HTML.
- `design-export kit build` regenerates the kit's generated files (`--check` reports stale ones); `kit claude` writes the
  kit as a Claude Design System folder (the font faces the text styles reach, files over the 15 MiB cap left out and
  named); `kit upgrade` brings a project's own kit to the clone's version, keeping the project's fonts, locales, own and
  changed tokens, components, list entries and extra viewports, with a backup and a restore command.

**Viewports.** A kit declares the resolutions a game ships, each **exact** (the 4 px grid stays whole: 3840×2160,
2560×1440, 1920×1080 and 1280×720 with the 2560×1440 reference) or **scaled** (1600×900, 1366×768). At a scaled
resolution the screen lays out at the next exact scale up and its root draws scaled to the actual one, so every edge and
line of text lands where the design puts it ([viewport classes](docs/findings/viewport-classes.md)). Kit sync keeps the
kit and the profile's lists in step.

**Lint and export** (`tools/design-export`)

- Lint in a pinned headless Chromium with the kit fonts only: a whitelist of CSS shared with the Unity compiler, markup
  and localization rules, glyph coverage from the kit fonts' tables, and rules for what UI Toolkit cannot reproduce
  (paint order, group opacity, borders, paddings and gaps off the device grid, text a box clips, a word wider than its
  box, text below a readable 9 device px, layout animations, oversized raster pictures, …). Every finding names the rule,
  the element and the fix.
- Claude Design artboards (`.dc.html`), plain HTML folders and ZIP files as input.
- Export to a versioned, deterministic IR (version 2: states, `is-*` classes, pseudo-states, breakpoints and their
  combinations), golden captures at every declared viewport, baked shadows and gradients, sample data for bound values
  and repeat items, and animation samples at the delay and every quarter of each animation.

**The Unity package** (`com.ertugrulgaziakcan.design-ui`, Unity 6000.3)

- Compiler: IR to UXML, USS, item templates, shared tokens and fonts, images and vector assets, incremental writes in one
  asset-editing batch, and a guard against overwriting generated files edited by hand.
- A generated view per screen: typed element properties, setters that skip unchanged values without allocating,
  `<Action>Requested` events, `SetState`, `SetSelected`, `SetClass`, `SetEnabled`, repeats as virtualized `ListView`s or
  pooled items with nested item views, and per-item visibility setters.
- Fonts from the project's TMP setup: UI Toolkit font twins carrying each text style's CSS line box, kerning prepared at
  import, small on disk (one atlas per face, sized to its glyphs; 25 MB for an 11-locale setup that took 3.5 GB), pruned
  when unused, never changed by Play mode. A pluggable font resolver (`DesignUiFontResolver`) or a per-locale mapping in
  the profile; kit sync copies the project's fonts and font tokens into the kit.
- Localization: String Table entries for every text (English and the reference locale; a different translation is never
  overwritten), asynchronous `LocalizedString` bindings with English fallback, Smart String or indexed arguments, fonts
  and right-to-left alignment per locale, shaped text through Unity's advanced text generator.
- Text-sized labels and buttons (`DesignLabel`, `DesignButton`) keep the golden's width at every viewport and measure
  again when their text, font or style changes; ellipsized lines are cut by UI Toolkit's own elision.
- An animation player for CSS transitions and keyframe animations of transforms, opacity, colours and border radii, with
  exact CSS timing, every trigger and a reduced-motion switch.
- `DesignUiPanelRegion` hosts a screen inside an existing uGUI shell (rect, sort order, pointer and focus queries, Escape,
  locale controller, `RootRebuilt`). `DesignUiGammaComposite` shows a Linear-colour-space project the colours the design
  has, drawn where UI Toolkit would draw the panel among the overlay canvases.
- An Editor bridge (loopback only, a token readable by its user) for import and kit sync in the open Editor, the
  `Window > Design UI > Status` window, menu items and batchmode entry points.

**Verification**

- The capture renders every job (viewport, state, class, pseudo-state, list sample, animation sample) on a temporary copy
  of the project, never in the open Editor (`scripts/capture-on-copy.sh`: one capture at a time per machine, a free-disk
  check, the open Editor's process and lock files left out of the copy). A focused text input draws no caret in a
  capture, as the design's capture shows none.
- The comparison checks element boxes and text baselines (±1 device px), line breaks, where each line's first and last
  glyphs sit, text ink colour and amount, colours at sampled points, ring colour and width, per-element and whole-capture
  SSIM, shadows, the ellipsis glyph, and what a later element covers (text Unity draws over an element that covers it in
  the design fails). Measured allowances apply only with evidence: anti-aliasing confined to a 1 device px edge band,
  hairline strokes judged by colour direction, fragments of covered or clipped lines by the measured noise of their
  width, scale-only effects at scaled viewports ([fidelity limits](README.md#fidelity-and-speed)).
- Verdicts `pass`, `fail` and `incomplete` (never a pass when something was not compared), an offline HTML report with
  bounded size, a compact `verdict.json`, and on request the run's captures kept for an offline comparison.

**MCP server, skill and setup**

- `tools/design-ui-mcp`: a stdio MCP server for any MCP client, with `design_ui_rules`, `design_ui_list`,
  `design_ui_lint`, `design_ui_import`, `design_ui_verify`, `design_ui_status`, `design_ui_kit_sync` and
  `design_ui_clean`: per-step timings, progress notifications during long Unity steps, one import or verify per screen
  folder at a time, evidence kept when a verification gives no verdict, and a bookkeeping folder per screen that cleans
  up after itself.
- The `/unity-ui-mcp` skill (Claude Code, Codex, Cursor) drives the loop: setup check, Claude Design canvas fetch, lint,
  import, verify, and publishing the kit as a Design System.
- `scripts/setup.sh` builds the server, adds the Unity package (pinned to the clone's tag, else its commit),
  `design-ui.config.json` and the project's own copy of the kit, registers the server with Claude Code, Codex or Cursor
  (or prints the Claude Desktop snippet) and links the skill; dry run first, idempotent. `INSTALL.md` lets an AI client
  install everything from one sentence.

### Requirements

- Unity 6000.3 (6.3 LTS); measured on 6000.3.6f1. The package pulls in `com.unity.ugui` and Newtonsoft JSON.
- Node.js 20 or later, `npm` and `git` to build the server from a clone; Playwright downloads its pinned Chromium.
- `scripts/setup.sh` and the capture script are bash (macOS, Linux; Windows through WSL).
- Optional: Unity Localization 1.5 or later for localized screens; Project Settings > UI Toolkit > Enable Advanced Text
  for right-to-left and complex scripts.

### Migrating from earlier development builds

- The package id was `com.unity.design-ui` before 0.1.0 (the `com.unity.` prefix belongs to Unity's own packages).
  `scripts/setup.sh` replaces the dependency key and the git URL path (`?path=/packages/com.ertugrulgaziakcan.design-ui`)
  in `Packages/manifest.json` and removes the old id from `testables`; `design_ui_status` and the Status window report the
  old id while a project lists it.
- Setup now pins the package to a tag or a commit. An install that names a branch (`#<branch>`) resolves only while that
  branch exists: replace the revision with a tag or commit (setup keeps an existing entry, so remove the entry before
  running it again).
- A new profile's reference locale (the language designs are written in) is English; a saved profile keeps the one it
  was saved with. The default kit's `locales` are `["en"]`; kit sync writes the profile's into the project's kit. With
  the reference locale `en` one String Table holds English and the reference text, and its entry is the visible text:
  `data-en` may be left out, and a `data-en` that is not the visible text is a lint error (U-MRK-014) the import
  refuses too.
- The IR is version 2: its text field is `ref` (version 1 wrote `tr`). An export of version 1 is exported again by
  itself at the next import (the exporter's tool hash covers the IR schema, and the export's own IR version is read
  too); the package refuses version 1 ("export the screen again"), a package that reads version 1 refuses version 2
  ("update the package"), and the MCP server stops an import before it exports while the bridge reports another IR
  version (`design_ui_status` names both). Verify refuses an export another exporter version made. Update the clone and
  the Unity package together.

### Verified

On macOS (Apple silicon), Unity 6000.3.6f1:

- The fidelity suite (`scripts/fidelity.sh`: 24 fidelity fixtures and the 9 kit components at the kit's six viewports,
  4740 captures, about 14 minutes) passes every capture, exact and scaled.
- The package's EditMode tests (1048), the exporter's tests (1086) and the MCP server's tests (221) pass; GitHub
  Actions runs the Node suites and type checks on Linux with Node 20 and 22.

### Known limitations

- **Unity versions.** Measured on Unity 6000.3.6f1 only. The runtime reaches 43 internal Unity members by reflection
  (text measurement, font twins, the overlay order, the gamma composite), each with a fallback that measures or draws
  differently; `Runtime/link.xml` keeps them through code stripping, and a later Unity can rename them.
- **Players are not verified.** Every measurement ran in the Editor (EditMode, batchmode Play). Player builds (IL2CPP
  stripping, the gamma composite's colours, ICU data for advanced text) are untested.
- **URP** is measured in the Editor only: the composite's draw order on the Built-in pipeline and URP 17.3, its colours
  on the Built-in pipeline ([composite order](docs/findings/composite-order.md),
  [colour space](docs/findings/colour-space.md)).
- **Windows** has no default capture route: `scripts/capture-on-copy.sh` needs bash and `rsync` (Git Bash lacks it). Use
  WSL, or put a capture command of your own into `unityRunner.command.capture` (the usage guide says what it must do).
- **Linux** has no copy-on-write clone here: every verify copies the whole project with `rsync`, so its time and free
  disk grow with the project's size (`--min-free-gb` counts it).
- **The fidelity suite** runs Unity through a runner of the maintainer's by default; `FIDELITY_UNITY_CHECK` takes any
  runner that follows the contract in the README (Development).
- **What the comparison does not catch**, by measured decision: a lightness-only error within 0.5–2× the ink on a
  hairline line (an em dash, a one-stroke digit); at a scaled viewport a 12–13 device px line Unity dims by up to 16 %
  when its hue is right; a lightness-only error on a covered or clipped fragment narrower than 4 em judged by colour
  direction; below 16 device px a wrong glyph drawn as three dots at the design's pitch in place of an ellipsis; one
  grapheme more or fewer before an ellipsis at a scaled viewport; a ring 0.5 device px thinner than the design's (1 CSS
  px at 1280×720); text Unity draws over the design's cover in fewer than 4 pixels, within 2 device px of a cover edge
  of a similar colour, or inside another text's line box, and the covered lines of a multi-line element only partly
  covered are judged by that rule alone (its box stays in the whole-capture SSIM's mask). The covered-line bounds (2
  device px, 8 levels, 4 pixels) are reasoned, not measured on a corpus. [docs/decisions.md](docs/decisions.md) says
  why.
- **Versions between releases.** The server and the package compare their versions and IR versions; two builds of the
  same version (between releases) cannot tell each other apart. Update the clone and the package together (INSTALL,
  Updating).
- **The built server reads the clone at run time.** `dist/server.js` keeps the clone's absolute paths and reads the
  exporter's data (schemas, the CSS whitelist, thresholds) from it: rebuild after every pull (`scripts/setup.sh` does)
  and do not move the clone without running setup again.
- **Sample content.** The fidelity fixtures carry Turkish sample text; the kit's components and the RULES.md example
  show English, the default reference locale.
- **Code size.** The comparison (`tools/design-export/src/compare/compare.ts`) is one module of about 2,400 lines.
