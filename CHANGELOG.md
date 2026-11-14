# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org); the
Unity package (`com.ertugrulgaziakcan.design-ui`) and the Node tools share the version number.

## Unreleased

### Added

- Lint **U-CSS-046**: a padding, margin or gap (the compiler writes a gap as margins) that is not a whole number of device
  pixels at an exact viewport. UI Toolkit lays these lengths out as whole device pixels, halves up (measured: position
  offsets and translations are not snapped, `docs/findings/viewport-classes.md`), so a 10 px padding is 8 device px at
  1920×1080 where the design has 7.5 and the text inside moves about a pixel. The finding names the element, the property,
  the viewports and the nearest valid lengths (multiples of 4 px with the default kit). New fidelity fixture
  `half-pixel-frame` (frames centred at a fraction of a device pixel, grid paddings inside).
- Capture slots and a disk check for `scripts/capture-on-copy.sh`: one capture-on-copy Unity runs at a time on the
  machine by default (`--slots N` or `CAPTURE_COPY_SLOTS`; the others wait and say so; a slot counts while its script
  or its Unity runs and is taken over once both are gone), and the copy needs `--min-free-gb` (default 10; rsync adds
  the project's size as far as `du` can read it) free where it goes, else the script stops before copying with how
  much is free (exit 2). Stopped by the server's time limit (SIGTERM, then SIGKILL), SIGINT or SIGHUP, the script stops
  its Unity and everything Unity started and waits for them before it gives the slot back, and removes the copy in the
  background. Setup notes a `"testables"` entry of the package's id in the project's manifest. The usage guide says how a project with its
  own heavy-job runner points `command.capture` at it instead.
- Viewport classes. `kit.config.json` `viewports` entries are `[w, h]` (exact) or `{ "size": [w, h], "class": "exact" |
  "scaled" }`; the profile has **Viewports** (exact) and **Scaled Viewports**, kit sync writes both, the IR carries
  `scaledViewports`. Exact viewports keep every kit value whole device pixels (kit build, kit sync and lint judge only
  them); scaled viewports are laid out and verified with the same ±1 device px geometry but exempt from those rules.
  Default kit and new profiles: exact 2560×1440, 1920×1080, 1280×720 and 3840×2160, scaled 1600×900 and 1366×768 (a
  profile saved before keeps its list and gets no scaled viewport). Verdicts,
  reports, `design_ui_verify` and the fidelity summary count captures per class; `design_ui_status`, `design_ui_rules`
  and the Design UI window list each viewport's class. `fidelity-thresholds.json` may hold measured scaled-class limits
  under `scaled` (never boxes or baselines). The fidelity suite runs all six viewports (comparisons four fixtures at a
  time); 2560×1440 and 1920×1080 pass, 1280×720 fails one capture, 3840×2160 and the scaled class do not pass yet
  (UI Toolkit lays paddings, margins and borders out as whole device pixels: docs/findings/viewport-classes.md).
- Text at scaled viewports keeps the design's size: Unity sets text at whole device pixels (a 12 px style at 1600×900
  rendered 6.7 % wide), so kit sync and the compiler make twin variants with `faceInfo.scale = exact / rounded` for each
  scaled viewport, and `DesignScreen` takes the class of the scale its panel renders at (`viewport-scales`), under which
  `DesignFonts.uss` selects them.
- Drift-free stacked text: a text that does not wrap (in the design and in every translation the String Tables hold;
  not bound, no arguments) and whose height is its content's gets an explicit height of lines × line box plus its
  vertical padding and borders (text-size steps scale it; two layers that hold together get their union's height), so
  it adds no text-height drift where a line box is a fraction of a device pixel. New fidelity fixture `stacked-text`.

- Disk use stays bounded by itself. After a verify writes its report the run's Unity captures and difference images
  are deleted (the report keeps thumbnails and issue crops of its failing captures, in `<screen>/.design-ui/report/`);
  after every import and verify each screen keeps only its records, its latest export, its report's pictures and its
  newest three failed runs, and over `cacheBudgetMB` (design-ui.config.json, default 2048) the exports of the screens
  least recently imported or verified go first (the next import or verify exports them again). Never touched: records,
  design files, a screen whose import or verify is running. New tool `design_ui_clean { screen?, dryRun? }` reports or
  runs the cleanup; `design_ui_status` shows the bookkeeping per screen and in total. The skill tells AI clients that
  cleanup is automatic and never to delete these files by hand.
- Every CSS property and keyword lint accepts is measured by a fidelity fixture at 2560, 1920 and 1280 (new fixtures
  `text-spacing`, `sizing-visibility` and `background-images`; `docs/findings/measured-css.md`). The sample project
  has an italic face.
- `DesignUiGammaComposite`: in a Linear-colour-space project the design PanelSettings render into a screen-sized UNorm
  texture with `forceGammaRendering` and are composited over the screen, so the game shows the colours verify captures
  (an ordinary on-screen panel blends in linear light: 2248 of the suite's 2355 captures fail that way). The profile's
  `colorPath` (Gamma Composite by default, or Linear Panel) decides what verify captures; the capture records the colour
  space and path, and verify names them (a warning for Linear Panel). Pointer input maps screen pixels to the texture's,
  and the PanelSettings get their own screen-to-panel function back when the component is disabled or destroyed. Verify,
  the Design UI window and a `DesignUiPanelRegion` (once, at runtime) warn when no composite renders the panel of a
  Linear project.
- Lint rule U-CSS-045: a box whose width `max-width` sets while its text wraps needs a width of its own (UI Toolkit
  sizes it to its longest line).
- A design's `@media` breakpoints apply in the game: the compiled screen root sets the `bp-*` classes of the
  breakpoints that hold at its panel's logical size, and switches them when the panel is resized or rescaled, by the
  rule the verifier captures with.
- `scripts/capture-on-copy.sh`: the verification capture on a temporary copy of the project (an APFS clone on macOS),
  removed afterwards, success or failure. Setup writes it into a new config.

### Changed

- `word-spacing` is converted to UI Toolkit's unit (hundredths of an em, as `letter-spacing`); it was written as px and
  came out far too narrow.
- Lint and the compiler reject what does not match the design in Unity: `flex-wrap: wrap-reverse`,
  `background-repeat: space | round`, `overflow-wrap: break-word | anywhere`, `text-rendering` other than `auto` or
  `optimizeLegibility`, `will-change` other than `auto`, `transform` or `opacity`, and `box-sizing: content-box` with
  padding or border on a box that a min or max size or `flex-basis` sizes. RULES.md says how to show raster images so
  they match (natural size or larger at 2560, background images on whole pixels).
- The comparison treats a url() background image drawn at another size than its own like a scaled `<img>`.
- Imports compare the Unity package with the MCP server first: the bridge's `/status` reports the package version and
  the IR version it reads; another major version or IR version stops the import before Unity is called (isError, with
  what to update), another minor version is a warning, and `design_ui_status` shows it. The package's IR reader names
  an export of another IR version as such ("made by a newer design-export … update the package").
- Setup copies the design kit into the project (`<designRoot>/design-kit`) and points `kitDir` there; kit sync never
  writes into the clone's tracked `design-kit` (it refuses, and status warns, for a config of an earlier setup, with the
  copy to make).
- Nothing adds `"testables"` to a project's manifest: only the temporary copy a capture runs on lists the package's
  tests (they switch project settings and are no business of a game's Test Runner).

### Verification

- Text at 8 device px (the 16 px label at 1280×720) measured over the suite: Unity draws about 5 % less ink there than at
  other sizes, and the ink colour is off in both directions (more so where the design puts a line at a half device
  pixel). No generic weight or sharpness adjustment fits both, and UI Toolkit 6000.3 gives runtime panels no SDF
  sharpness; the limits and the kit's readability warning stay (`docs/findings/text-ink.md` section 9).
- The fidelity suite (21 fixtures, 9 components, 4722 captures at six viewports) passes every capture at 2560×1440 and
  1920×1080 and all but one at 1280×720; 3840×2160 and the scaled viewports fail as before (89, 356 and 770 of 787).
- The fidelity suite (19 fixtures, 9 components) passes 2355 of 2355 captures at the three viewports (1155 static
  captures and 1200 animation samples).

### Fixed

- `DesignUiGammaComposite` draws its panel where UI Toolkit would draw the panel on screen instead of at the end of the
  frame over everything: over Screen Space - Overlay canvases of a lower or the same sort order, under those of a higher
  one, and among other runtime panels by sort order (the same sort order: the panel made later on top), so drawing and
  pointer input agree (a menu canvas with a higher sort order showed under a composited screen while taking its clicks).
  It wraps the overlay pass's hooks (`docs/findings/composite-order.md`: measured in a GUI Editor, 13 of 13 sample
  points identical to the same panel drawn on screen without the composite); about 0.02 ms more CPU per frame. Where
  this Unity version lacks a member it needs, it draws at the end of the frame as before and says so once.
- `DesignUiPanelRegion` no longer warns that no composite renders its panel when a `DesignUiGammaComposite` on the same
  GameObject attaches after the region: the check runs on the region's first frame after it attaches, once every
  component enabled with it has run, and warns once per region (the check ran inside the region's OnEnable, before such
  a composite attached, and a process-wide latch then kept other regions from being checked).
- `scripts/capture-on-copy.sh` no longer copies the open Editor's process and lock files into the project copy: the
  copy's Unity read the copied `Library/ilpp.pid` as its own and stopped the open Editor's IL post-processing runner.
  `Library/ilpp.pid` and every other `*.pid` in the `Library`, `Library/EditorInstance.json`, the asset databases'
  `-lock` files, search index locks, `Temp/` and `UnityLockfile` are deleted from the copy (APFS clone and rsync alike)
  before Unity starts.
- `scripts/setup.sh` removes a `"testables"` entry of the package's id before 0.1.0 instead of renaming it to the new
  id (the project's manifest never lists the package's tests); `--dry-run` prints the same plan.
- `DesignUiGammaComposite` renders a `DesignUiPanelRegion`'s sort-order copy of its PanelSettings, whether the copy was
  made before or after the composite attached, in a texture of its own that follows screen resizes; the copy gets its
  own settings (or the asset's, when it was made from the driven asset) back on detach.
- Linux: headless Chromium starts each page with the pointer at (0, 0), so the top-left element was `:hover` in the
  base state and lint, extract and capture saw no hover change there. The exporter now moves the pointer off the page
  after it loads.
- Linux: Chromium hinted text to whole-pixel glyph advances, so goldens laid text out differently from UI Toolkit. The
  exporter launches Chromium with unhinted text (no effect on macOS).
- GitHub Actions (`.github/workflows/node.yml`) runs the Node suites and type checks on Linux with Node 20 and 22.
- Kit sync and imports through the Editor wait for the script compile as long as `unityRunner.timeoutSec` allows (it
  was a fixed 300 s); `design_ui_import` and `design_ui_kit_sync` are marked destructive and `design_ui_lint` as reaching
  the network (allowed CDN scripts).
- A verify whose comparison fails (an unreadable `boxes.json`) keeps its captures and log in `failed-<run>`.
- `kit claude --force` replaces only a folder it wrote.
- U-CSS-045 no longer flags a block-level box in a block parent, which stretches to its parent's width.
- Font twin pruning keeps the line boxes any compiled screen was made with (its manifest records them), runs only after
  the screen's files are written, and kit sync in Unity refuses a unity-ui-mcp clone's own `design-kit`. Kit sync and
  imports say when this Unity version cannot link line-box variants to their twins' atlases.
- A budget cleanup that removes a screen's export marks its report ("Export pruned; re-run verify for images"), and a
  removal is skipped when an import or verify of the screen started after the cleanup planned it.
- `scripts/install-skill.sh` creates Claude Code's skill folder when Claude Code has none yet.
- `DesignText.Fonts` is cleared at the start and end of Play, so a font set of Play never prepares glyphs in edit mode.
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
