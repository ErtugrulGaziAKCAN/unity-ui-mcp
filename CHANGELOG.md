# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org); the
Unity package (`com.ertugrulgaziakcan.design-ui`) and the Node tools share the version number.

## Unreleased

### Added

- Disk use stays bounded by itself. After a verify writes its report the run's Unity captures and difference images
  are deleted (the report keeps thumbnails and issue crops of its failing captures, in `<screen>/.design-ui/report/`);
  after every import and verify each screen keeps only its records, its latest export, its report's pictures and its
  newest three failed runs, and over `cacheBudgetMB` (design-ui.config.json, default 2048) the exports of the screens
  least recently imported or verified go first (the next import or verify exports them again). Never touched: records,
  design files, a screen whose import or verify is running. New tool `design_ui_clean { screen?, dryRun? }` reports or
  runs the cleanup; `design_ui_status` shows the bookkeeping per screen and in total. The skill tells AI clients that
  cleanup is automatic and never to delete these files by hand.
- `scripts/capture-on-copy.sh`: the verification capture on a temporary copy of the project (an APFS clone on macOS),
  removed afterwards, success or failure. Setup writes it into a new config.

### Changed

- Setup copies the design kit into the project (`<designRoot>/design-kit`) and points `kitDir` there; kit sync never
  writes into the clone's tracked `design-kit` (it refuses, and status warns, for a config of an earlier setup, with the
  copy to make).
- Nothing adds `"testables"` to a project's manifest: only the temporary copy a capture runs on lists the package's
  tests (they switch project settings and are no business of a game's Test Runner).

### Fixed

- The comparison sees horizontal text errors: each text line's first and last glyphs (and the width between them) are
  held to the box limit, ±1 px, from Unity's ink column profile near each end matched to the design's (spacing, kerning
  or alignment inside a box of the right size had kept the same ink colour, amount, line count and baseline and passed).
  Reported per line ("text ink extent") in the verdict and the report.
- Font twins take a fraction of the disk they did (2.9 GB in an 11-locale project; 3.5 GB → 25 MB in the same setup
  rebuilt in the sample project): a line-box variant keeps no glyphs or atlas on disk and shares its twin's when loaded
  (`FontTwinLink`; the compiled font set links them when a screen loads); a twin's atlas pages are sized to its glyphs
  (1024 px or more, never larger than the TMP asset's); it keeps the kerning pairs and mark records of its own glyphs only;
  and kit sync and every import remove the twins of faces, line boxes and fonts nothing uses any more, one asset at a
  time, and report them. Existing twins are rebuilt once. docs/findings/font-twin-footprint.md.

- Font twins render with the advanced text generator again after they were unloaded and loaded (a later Editor
  session, a scene change in a player): TextCore kept the unloaded asset's entry in its font registry, so the generator
  dropped the twins' glyphs or failed converting the text mesh. `TextAssetRegistry` registers them again (locale
  controller, scene loads, capture, Editor reloads and Play changes). Twins leave out the fallback and weight entries
  that formed cycles ("Circular reference detected"), which had cost script fonts their Latin fallback.
- Play mode no longer writes into the font twins, whichever generator adds the glyphs: while Play runs every save
  leaves the twins out, and when it stops each twin Play changed (glyphs, pixels, pages, a page grown to the atlas size)
  is reloaded from its file (`TwinPlayGuard`); a twin that cannot be reloaded is an error naming it. Imports and kit
  syncs refuse to run in Play mode ("Exit Play mode first"), so the characters an import pre-adds are saved and ship.
- Generated screens imported while the package lacked an element they use (`DesignLocalizedString`) no longer stay
  broken after the package update: generated manifests record the package stamp, each screen folder's import is recorded
  with the stamp in the Library, and after a script reload the screens recorded under another package are imported
  again, asset by asset (also after an import logged "Uxml object has an invalid child element").
- CSS `letter-spacing` keeps its size in Unity: UI Toolkit applies USS letter-spacing in hundredths of an em of the
  font size (measured with both generators), so the compiler writes `px × 100 / font-size` and gives a text the spacing
  after its last character as right padding (the standard generator draws none there, Chromium does). New fidelity
  fixture `letter-spacing.html` (tracked caps labels, tight headings, wrapped tracked text). docs/findings/letter-spacing.md.
  Negative spacing needs at least as much right padding (new lint rule U-CSS-044): UI Toolkit lays out no negative padding.
- Letter-spaced words keep their spacing around kerned pairs: TextCore stored kerning pairs with lookup flags it never
  sets, and a stray `IgnoreSpacingAdjustments` bit dropped the spacing of both characters ("Transfer dönemi" at −0.72 px:
  277 px instead of 276; Chromium 275.2). Twins keep no pair flags (cleared after every glyph batch, at twin generation and
  at import); pairs are complete across glyph batches.
- Box and baseline limits are compared with a float tolerance of 0.001 px (Unity's float32 layout): a frame at a half
  CSS pixel at scale 0.75 that UI Toolkit snaps measured 1.000008 px against the ±1 px limit.
- A text line partly covered by a later element (an open popup over a card title) is judged on its visible pixels only;
  the popup's own pixels had moved the line's ink colour (ΔE 2.19 at 2560, 5.13 at 1920). Only an opaque fill hides text
  (alpha and opacity ≥ 0.99, within its rounded shape); text under a scrim, a border-only box or a shadow is still judged,
  and a line covered entirely is listed as not judged (covered) in the verdict and the report.
- `design_ui_import` no longer skips Unity for an unchanged export after the design-ui package, the profile or the kit
  changed: `last-import.json` records the package stamp (`git:<commit>`, `registry:<version>` or the hash of a local
  package's files) and the profile's hash, and the skip compares them with the IR and kit hashes.

## 0.1.0 - 2026-11-14

The first release: a Claude Design screen becomes a working Unity UI Toolkit screen, verified against the design.
Licensed under the MIT License (`LICENSE`); the bundled Inter font stays under the SIL Open Font License (`OFL.txt`).

### Design kit and contract

- `design-kit/`: tokens, fourteen text styles on whole device pixels at every viewport, a generated base stylesheet,
  nine components (button, toggle, text field, dropdown, tabs, card, list row, scroll area, dialog) with guidelines,
  and fifteen fidelity fixtures.
- `RULES.md`, generated from the kit and the lint's own data: markup attributes, text styles, fonts, tokens, allowed
  CSS, every lint rule with its fix, the Claude Design artboard rules and an example screen.
- `design-export kit build` regenerates the kit's generated files (`--check` reports stale ones);
  `design-export kit claude` writes the kit as a Claude Design System folder.

### Lint and export (`tools/design-export`)

- Lint in a pinned headless Chromium with the kit fonts only: a whitelist of CSS shared with the Unity compiler
  (`css-support.json`), markup and localization rules, glyph coverage from the kit fonts' own tables, and rules for
  what UI Toolkit cannot reproduce (paint order, group opacity, borders off the device grid, inline text flow, layout
  animations, …). Every finding names the rule, the element and the fix.
- Claude Design artboards (`.dc.html` with their uploads), plain HTML folders and ZIP files as input.
- Export to a versioned, deterministic IR with specified styles per layer (states, `is-*` classes, pseudo-states,
  breakpoints and their combinations), golden captures at 2560×1440, 1920×1080 and 1280×720, baked box shadows and
  gradients, sample data for bound values and repeat items, and animation samples. Jobs whose elements the design hides
  are captured in the state, class or sample item that shows them; jobs no context shows are reported.
- `design-export compare`: boxes, text lines and baselines, colours, whole-capture and per-element SSIM, shadow bands
  and text ink against calibrated thresholds; an offline HTML report and `verdict.json` with the verdicts `pass`,
  `fail` and `incomplete`.

### Unity package (`com.ertugrulgaziakcan.design-ui`, Unity 6000.3 or later)

- The package id changed before 0.1.0 from `com.unity.design-ui` (the `com.unity.` prefix is reserved for Unity's own
  packages). Existing installs replace the dependency key and the git URL path
  (`?path=/packages/com.ertugrulgaziakcan.design-ui`) in `Packages/manifest.json`: `scripts/setup.sh` does it, and
  `design_ui_status` and `Window > Design UI > Status` report the old id while a project lists it.
- Compiler: IR to UXML (screen root `dui:DesignScreen`), USS, item templates per repeat, shared tokens and font
  variables, images and vector assets, incremental writes in one asset-editing batch, and a guard against overwriting
  generated files that were edited by hand.
- Generated view per screen: typed element properties, value and image setters that skip unchanged values without
  allocating, `<Action>Requested` events, `SetState`, `SetSelected`, `SetClass`, `SetEnabled`, repeats as virtualized
  `ListView`s or pooled inline items with nested item views, and per-item visibility setters.
- Fonts from the project's TMP setup: UI Toolkit font twins with each text style's CSS line box, kerning prepared at
  import, only the faces in use, a pluggable project font resolver (`DesignUiFontResolver`) or a per-locale mapping in
  the profile, and kit sync of the font files and font tokens.
- Localization: a String Table writer that never overwrites a different translation and saves only what it touched,
  `LocalizedString` bindings with asynchronous loads and English fallback, Smart String or indexed arguments, locale
  classes and fonts per locale, compiled right-to-left alignment and text-size rules, and advanced text for
  right-to-left and complex scripts.
- Animation player: CSS transitions and keyframe animations of transforms, opacity, colours and border radii with
  exact CSS timing, every trigger (screen open, state, class, pseudo-state), reversing, negative delays, play state and
  a reduced-motion switch, without per-frame allocations.
- `DesignUiPanelRegion` hosts a design screen inside an existing uGUI shell: rect, sort order, pointer and focus
  queries, Escape, locale controller and a `RootRebuilt` event.
- Verifier: an EditMode capture test that renders every capture job and animation sample on a project copy, one mount
  per viewport, with real pointer and focus events.
- Editor bridge (loopback, token) for import and kit sync in the open Editor, the `Window > Design UI > Status` window,
  menu items and batchmode entry points.

### MCP server and skill

- `tools/design-ui-mcp`: a standalone stdio MCP server with `design_ui_rules`, `design_ui_list`, `design_ui_lint`,
  `design_ui_import`, `design_ui_verify`, `design_ui_status` and `design_ui_kit_sync`; per-step timings, progress
  notifications during long Unity steps, and evidence kept when a verification gives no verdict.
- The `/unity-ui-mcp` skill (Claude Code, Codex, Cursor): checks the setup, fetches Claude Design canvases, drives lint,
  import and verify, and publishes the kit as a Design System on request.
- `scripts/setup.sh`: builds the server, adds the Unity package and `design-ui.config.json`, registers the server with
  Claude Code, Codex or Cursor (or prints the Claude Desktop snippet) and links the skill; dry run first, idempotent.
- `INSTALL.md` lets an AI client install everything from one sentence.

### Verification

- The fidelity suite passes 2340 of 2340 captures at the three viewports (1140 static captures and 1200 animation
  samples).
