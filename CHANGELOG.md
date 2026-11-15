# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org); the
Unity package (`com.ertugrulgaziakcan.design-ui`) and the Node tools share the version number.

## Unreleased

### Added

- `design-export kit upgrade <kitDir> [--from <cloneKit>] [--dry-run]`: brings a project's own kit to the clone's kit
  version (setup keeps an existing kit, so a pilot merged one by hand). It takes the clone's base stylesheet, RULES.md,
  components, text styles and configuration keys, and keeps the project's fonts folder (fonts CSS and JSON included), its
  `locales`, `referenceLocale`, `reference`, `screenMatch`, `textSizes` and paths, its own keys, text styles and files, and
  the viewports it declared besides the clone's six. `tokens.css` is merged token by token in the clone's file: a project
  value that equals one an earlier clone had (read from the clone's git history) takes the clone's new value and is named,
  a value the project changed is kept and named, and the project's own tokens follow the clone's (one line each, comments
  kept). `components.json` keeps the project's own components after the clone's, and a list key the clone ships
  (`allowedScriptOrigins`) keeps the project's entries too. The merge is built on a staging copy first (`kit build`, then
  `kit build --check`): a merge that does not build writes nothing. The files it replaces are backed up into
  `<kitDir>/.backup/<UTC time>/files/`, with `kit-upgrade.json` listing the files it replaced and added (the newest three
  backups are kept, older ones removed and named); it prints what it kept, replaced, added and backed up and the command
  that restores the kit (copy the backup's files back, remove the added ones); `--dry-run` prints only. A Node command rather than a setup flag: it runs wherever the
  tools run (Windows without bash too) and reuses kit build. Setup prints the command when it keeps a project's kit.
- Lint **U-CSS-047** (error): a text whose line box a box with `overflow: hidden` or `clip` (its own, as an ellipsis label,
  or an ancestor's) cuts at its top or bottom edge, the box being shorter than the text's lines. Both renderers clip the
  accents and descenders alike, so verify passed and nobody noticed. The finding names the box, its height, the line box
  and how much is cut; the fix: make the box at least the line height. It judges at the scale the transforms draw
  the box at (a scaled container scales the box, its padding and the line box alike) and from where the text starts (a
  padding or border above it moves its lines down). A box that ends between two lines, content that runs off a taller box
  and content inside a scroll area are not judged. The lint snapshot records each text element's
  own lines.
- Lint **W-TEXT-001** (warning): a word wider than its wrapping text box. The browser keeps a word without a break
  opportunity on its line and lets it overflow; UI Toolkit breaks it inside the word (the standard text generator after
  the last character that fits, the advanced one after a quotation mark or other punctuation), so the lines differ. The
  finding names the word, its width, the box's width and the marks the advanced generator breaks after.
- `kit claude` ships the font faces the kit's text styles and font tokens reach (each family a `--font-*` token names, at
  400, 700 and every weight a text style names, upright and italic, matched as the browser matches faces: the rules let
  any text be italic with `font-style`, `<i>` or `<em>`), with `--all-faces` for every face, and leaves out any file over the Design System's 15 MiB file cap. What it leaves
  out is printed as a `note:` and listed in the README; `tokens.json` lists exactly the files it ships. A pilot's export
  was 35 MB (18 Inter weights, four Noto fonts) and a 17.8 MB font broke its publish.
- Kit sync refuses to drop a viewport kit.config.json declares and the DesignUiProfile lacks (a profile saved before the
  six default viewports keeps its three, and kit sync wrote three back): the error, before anything is written, names
  them with their class and says how to add them. `Window > Design UI > Add Default Viewports to Profile`
  (`DesignUiProfileViewports.AddDefaults`) adds the default viewports a profile lacks; kit sync with
  `addProfileViewports` (`design_ui_kit_sync`, the bridge's `/kit-sync`, batchmode `-designUiAddProfileViewports`,
  `DESIGN_UI_ADD_PROFILE_VIEWPORTS=true` for a command runner) adds the kit's. Both are one Undo step and save the profile
  asset only; Edit > Undo takes them out of the open profile, and saving the project writes that to disk. A
  kit.config.json viewport kit sync cannot read (not `[w, h]` or `{ "size": [w, h], "class": "exact" | "scaled" }` in
  whole positive numbers) is refused the same way, named as written; `[1366.0, 768]` reads as 1366×768, as the exporter
  reads it. A viewport the kit and the profile declare in different classes takes the profile's class with a warning that
  names both. Add Default Viewports refuses a profile whose reference resolution is not 2560×1440 (the defaults' classes
  hold for that reference only) and says so.

- A readable-text floor: no text may draw below 9 device px at any declared viewport, exact or scaled (the game-industry
  practice of a minimum readable size, instead of looser checks for tiny text; measured at 1280×720: 135 texts at 9
  device px meet the exact-class ink limits, max ΔE2000 4.29 against 4.5). Lint **U-FONT-004** (error) names each text
  below it (its font size times the scale its transforms keep it at, now or in a state), with its text style, the
  viewports, the drawn size and the minimum design size, 18 px with the default viewports. `kit build` and
  `kit build --check` (and the Claude export) refuse a kit text style below it. The default kit's caption and label are
  20 px (caption 20/28, label 20/24; 12/16 and 16/20 before), the smallest size that is whole device px at every exact
  viewport; RULES.md and the published Design System state the minimum. The kit's readability warning (kit build and
  kit sync) is gone. The fidelity fixtures' small text rose with the kit, and the 8 px case at 1280×720 is gone; the
  verify thresholds are unchanged. U-FONT-004 judges a text only in the states that draw it (a pop-in's hidden
  `scale(0)` with opacity 0 is not judged), multiplies a state's `scale` and `transform`, and judges a state's or
  breakpoint's `font-size` in px, em, % or rem (one it cannot resolve is named). A runtime text-size step that draws a
  kit style below the floor is a `kit build` warning (the player's choice): kit sync writes the profile's steps to
  kit.config.json (`textSizes`).
- `DesignOverflowLabel`: a text that does not wrap and is aligned right, centred or at the end is left-aligned while its
  line is wider than its box, as the browser start-aligns an overflowing line before it clips it or puts the ellipsis
  (a right-aligned ellipsized label was drawn 3.3 CSS px off at every viewport).
- A ring colour check for round elements without text (`deltaE2000Ring`, every viewport): the middle of each border side
  of 2 device px or more; a ring of another hue at the same lightness fails. In the scaled class text under 13 device px
  takes the small-text ink limits (`scaled.textInkSmallPx` 12.99): the fractional 12.5 and 12.8 px the root scale draws
  scatter like small text, where the whole 13 and 14 px stay within the full limit.
- Scaled viewports lay out at an exact scale. UI Toolkit puts font sizes, paddings, margins and border widths on whole
  device pixels before layout, so a design only lays out as designed at an exact viewport's scale. The compiler writes the
  exact viewports' panel scales on the screen root (`DesignScreen`, `exact-scales`); on a runtime panel whose scale is none
  of them (1600×900, 1366×768, or any resolution the profile does not declare) the root sets its PanelSettings' `scale`
  factor so the panel lays out at the next exact scale up (0.75 for both: drawn at most 1, a box's edges stay within half a
  device pixel; laid out at 0.5, 1366×768 drew layout's rounding 1.067 times larger) and draws itself scaled to the actual
  one from its top-left corner, composed with the design's own transform of the root (the animation player's translate,
  rotate and scale of the root go through it; the compiler writes the root's transform declarations again as
  `--dui-root-*` custom properties it reads in every state). The factor is the settings' own times exact / actual while a
  screen is on the panel and is given back when the last one leaves (a factor the game writes meanwhile is kept as its
  own, also one equal to an earlier held factor: only the last factor written counts as the package's; a region's
  sort-order copy starts with the asset's own). In the Editor outside Play mode a factor is held only on PanelSettings no
  save writes (runtime copies); on an asset or a scene's own settings the screen lays out at the actual scale there,
  unscaled. In Play mode a save guard gives a held PanelSettings asset its own factor for every save that writes it and
  holds it again after, a build guard gives every held factor back before a player build (with a warning), and an Undo
  of a snapshot taken while held restores the snapshot's own factor, also after a script reload, only on the settings
  the Undo touched and never for a value the game or the user set. Not guarded in Play mode: an SBP or Addressables
  content build (Unity's `BuildPipeline.BuildAssetBundles` refuses to run in Play mode), and a preset or asset copy made
  while held. Game code's own inline
  transform on a screen root is overwritten (the root's transform is the design's composed with the root scale). A screen inside a screen with exact scales is scaled
  with it, never twice; screens with different exact viewports on one PanelSettings are reported. The root follows the panel's scale through `CustomStyleResolvedEvent`
  (UI Toolkit resolves every style again when a panel's scale changes, also between two 16:9 resolutions), so the
  100 ms watch is gone. Picking, pointer events, breakpoints, the gamma composite and `DesignUiPanelRegion` frames follow
  the scaled root (`RootScaleTests`; measurements: `docs/findings/viewport-classes.md`).
- Text-sized elements keep the golden's width. The golden lays a text-sized box out with Chromium's text width ceiled to
  whole device pixels at the viewport's scale and its borders on whole device pixels (a 4 px border is 3 device px at
  1600×900); UI Toolkit ceils on the grid of the scale it lays out at and with no tolerance (a text of 86 px measures
  86.0100 in Unity and took 87, so every button after it in a row moved a pixel). A text or button whose width is its
  content's compiles to `DesignLabel` / `DesignButton` (`DesignTextFit`), which lay out at the generator's unrounded width
  ceiled on the design's device grid (0.012 device px forgiven, as the golden's pageTextCeil forgives it: measured on
  the suite's 984 text-sized texts, 2 left a pixel off; a test ties the two constants) plus padding and borders as the golden lays them out (letter-spaced text: its last spacing, which
  UI Toolkit leaves out and the compiler wrote as right padding, counted once, the box rounded to whole device pixels),
  with `white-space: nowrap`. A text the design wraps keeps wrapping: in a row the width comes off where the row has no
  room and comes back only once the row grows past its width then or the text needs less (a tight row of bordered tabs
  at 1600×900 no longer flips its widths on every layout); in a column and for an absolute text a longer line gets the width of its room with the design's white-space (the
  browser's fit-content box). A row of ten text-sized buttons starts within 0.35 device px of the golden's positions (built
  from Chromium's text widths, `Data/chromium-row-buttons.json`) at every default viewport (1 to 8.7 without). New fidelity
  fixture `text-row`.
- Lint **W-IMG-001** (warning): a raster image drawn larger than its pixels at a declared viewport, with the image, its
  pixels, its drawn size and the size to export (its drawn size at the largest declared viewport). The browser and Unity
  resample an enlarged picture differently (element SSIM 0.948–0.962 at 3840×2160). The fidelity fixtures' pictures have the
  pixels 3840×2160 draws; RULES.md and the guides say to export rasters for the largest declared viewport and size them in
  CSS.

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

- Anti-aliasing at every viewport (ruling R119): `ssimRoundEdge` (0.974) applies at exact viewports too, to a round element
  without text (its curves' 1 device px band, the ring's colour within `deltaE2000Ring` as evidence) and, in an animation
  sample, to an element moved to a fractional device offset (its curves and its moved straight edges, each the pixels
  within 1 device px of the edge in the design and in Unity, so an edge a pixel off still fails). The 1280×720 radio
  (0.98088) and transition sample (0.98296) pass; nothing else at an exact viewport changes.
- The scaled class's measured residual keys (ruling R121), each only with band evidence: `ssimFractionalEdge` 0.97 (an
  element whose straight edges fall between device pixels), `ssimVectorEdge` 0.975 (a vector picture's drawn edges) and
  `deltaE2000FractionalEdge` 5.3 (a corner sample reaching such straight edges); `fidelity-thresholds.json` `scaled`,
  off at exact viewports (`docs/findings/viewport-classes.md`, "Scaled-class residuals").
- Edge-band evidence at the level of pixels (rulings R129, R130): every edge-band relaxation (`ssimRoundEdge`,
  `ssimFractionalEdge`, `ssimVectorEdge` and the corner limits) needs, outside its band, every 8 px SSIM block at 0.99 or
  more and every 3×3 window within ΔE2000 1 of Unity's closest within 1 px, not only the region's mean; and every border
  the band masks (rectangular too, also a descendant's or a repeat item's) keeps the design's drawn width within 0.5
  device px and, in static captures, its centre colour within `deltaE2000Ring` 3.1 (the scaled class's 5.5 for a ring is
  gone). A ring 1.5 device px too thin on a 160 px avatar, a dent beside the band and a wrong-colour 2.13 device px border
  that passed before now fail; the suite's relaxations keep passing (`docs/findings/viewport-classes.md`, "Edge-band
  evidence").
- A ring width check (ruling R127): a round element without text fails in a static capture when its ring is drawn more
  than 0.5 device px wider or thinner than the design's, across the middle of each side and each round corner (the
  suite's largest difference is 0.44).
- The captures record the boxes of a repeat's later items (boxes `items`, both sides), and the band of straight edges
  between device pixels takes their edges (ruling R124).
- The text of a repeat's later items is checked (ruling R133): both captures record each later item's copy of a text with
  its own line boxes (boxes `items`: `text` and `lines`, as for elements; schema and shared contract sample), the golden
  rounds a copy's text-sized width as the item template's `DesignLabel` lays it out, and the comparison masks the copies'
  text lines (whole-capture and element SSIM, edge-band evidence, colour samples; only the lines, so what a copy paints, a
  chip's background or a pill's border, stays in the whole capture's and its containers' SSIM) and gives each copy the same
  text checks: present and visible as in the design, line count, baselines, ink colour, ink amount (in the
  capture's medians) and where each line's glyphs sit, reported under the copy's name (`row#3`). Before, a later row's
  text was neither masked nor checked: a wrong colour passed, and the dividers' band evidence failed on its glyphs.
- Two scaled-only measured keys: a raster picture drawn at another size than its own may meet SSIM 0.95 and its colour
  samples ΔE2000 5.89 (`ssimResampledPicture`, `deltaE2000ResampledPicture`; ruling R125: resampling, measured lowest
  0.95284 and highest 5.49), and text under 13 device px takes the ink colour limit 5.89 (`scaled.textInkDeltaEFirstSmall`,
  at most 6.5; ruling R126: measured highest 5.49 over 10746 element samples).

### Changed

- An element counts as moving in an animation sample only when an animation of its geometry runs on it or an ancestor
  (ruling R132: the IR's animated properties, the transform and its parts, position, size and box-model lengths; not a
  colour, an opacity, a filter or a shadow). Every other element of a sample gets the static checks, its ring's colour and
  width and an edge-band relaxation's border centre colour among them (a colour-only animation let a wrong 2.13 device px
  border pass in a sample).
- A hairline text line is judged by its ink's colour direction (rulings R138, R141, fix round 3): text of at most 12
  device px, drawn at opacity 1 in the colour the capture recorded for it (boxes `color` and `opacity`, design side
  only; a repeat copy's own), all of the line in it (a line with a rich span of another colour or opacity is marked
  `mixed` and keeps the usual checks), with no element, written-out repeat copy or outer shadow over it that both
  renderers paint after it, whose design has fewer than 3 fully covered pixels (at least 0.85 of that colour's distance
  from the background; an em dash or a "1" whose one stroke lies between two device pixels), has an ink colour and
  amount that measure coverage, which the renderers lay differently. Such a line is judged by the angle between the
  design's and Unity's ink directions from the background in sRGB (`textInkDirection` 0.66°: the suite's highest 0.26°
  plus 0.4) and by an ink amount within 0.5–2 times the design's (both measured against the text colour). On such a line
  a lightness-only error within that amount is not caught; a dash in another hue fails (36° and 38° for the warning and
  accent colours), and so does a faded, veiled or muted larger text drawn lighter or missing glyphs, a small one under a
  later card's shadow or another item's layer, or in a span of another colour. The 120 `repeat-items` captures this
  concerned pass.
- What lies over a line is judged as both renderers paint it (fix round 4). The comparison's paint order is the
  compiler's: each element's children in the order `lint/paint-order.ts` gives them (`unityPaintOrder`, the rule the
  compiler and lint share), so an absolute scrim written before the caption it covers paints after it there, as in CSS
  and UI Toolkit (N-9; the colour samples' cover follows the same order). A later repeat copy covers with what it paints in
  its own item's state, which a job's hover or class on that item can change: the golden records for every element and
  copy whether it paints something of its own and how far its outer box and text shadows reach (boxes `paints` and
  `shadow`, design side only), and a later text's text shadow counts too (N-8). A small line under such a layer keeps the
  usual ink checks: Unity drawing it lighter or missing glyphs fails.
- An edge-band relaxation that fails names every condition that does not hold (a block, a window, a border's colour
  evidence, its centre, its width), not only the first.
- The ring width check keeps its limit (more than 0.5 device px fails) and decides reliably from 0.75 device px (ruling
  R135): a ring 1 CSS px thinner at 1280×720 (0.5 device px) can pass; README and the findings say so.
- The scaled viewports' font twins (`<face> UITK <box>x<scale>.asset`, `DesignFonts.uss` `.vs-<scale>` blocks, the screen
  root's `viewport-scales` and its 100 ms watch) are removed: under the root scale text is set at the exact scale's whole
  size and drawn scaled. Kit sync and pruning remove such twins an earlier version made.

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

- The ellipsis point at the scaled viewports (task 36, ruling R144): a card title kept one more character in Unity than in
  the design at 1600×900 and 1366×768 (ink edge +9.79 device px). Measured: the browser keeps a prefix when its width plus
  the ellipsis's own advance fits (no kerning across the cut); UI Toolkit's own elision measured the kerned string and,
  under the root scale, decided differently. Fixed under Fixed below (`docs/findings/viewport-classes.md`, "Ellipsis
  point").

- Task 35's fix round 4 fidelity run (4728 captures, 14 min 26 s): **every capture passes** at all six viewports; the
  same 180 hairline lines take the colour-direction path (at most 0.26°). The previous comparison run on the same captures
  gives an identical verdict: the copies' own paint and the compiler's paint order change no result of the suite.
- Task 35's fidelity run after fix round 3 (4728 captures, 14 min 9 s): **every capture passes** at all six
  viewports; the same 180 hairline lines of `repeat-items` pass through rulings R138 and R141 (colour direction at most 0.26°
  against 0.66°; ink amount 0.86–1.01 against 0.5–2 in fix round 2's run). Fix rounds 1 and 2's runs (14 min 12 s, 15 min
  10 s) passed every capture as well.
- Task 35's earlier fidelity runs (4728 captures, 14 min 3 s, four full runs with the same result): every capture passes at
  3840×2160, 2560×1440, 1920×1080 and 1600×900; 728 of 788 at 1280×720 and at 1366×768. The 18 divider captures of round 5
  and the letter-spaced label pass in every run. The 120 left are new checks finding what they look for: the text of two
  repeat items' copies in `repeat-items`, one glyph of one stroke on a baseline between device pixels (an em dash at 10
  device px, ink colour ΔE2000 6.06 against 4.5; a "1" at 10.67, 6.65 against 5.89), which Chromium and UI Toolkit cover
  differently; measured, no limit changed, and judged by their colour direction since ruling R138 (above)
  (`docs/findings/viewport-classes.md`, "Repeat items' text, the face that draws, what moves").
- Round 5 of the fidelity suite (4728 captures, 13 min 33 s): every capture passes at the four exact viewports; 787 of 788
  at 1600×900 and 770 at 1366×768. The 19 left: 17 `controls` and 1 `scroll-area` captures whose dividers' band the repeat
  items' boxes now place, failing on the glyphs of the later rows' text outside it (12.8 and 12.5 device px), and the
  letter-spacing fixture's caps label, whose text fit did not measure in that run (its font reported a character missing in
  a face of its weight table; seen in 2 of 3 full runs, never alone) (`docs/findings/viewport-classes.md`, "Edge-band
  evidence").
- Round 4 of the fidelity suite (4728 captures, 13 min 4 s): every capture passes at the four exact viewports; 786 of 788
  at 1600×900 and 769 at 1366×768. The remaining 21 are repeated table rows' dividers (no box for a repeat's later items,
  so their edges' band cannot be placed), a picture drawn at 0.42 and 0.36 of its pixels (below the SSIM floor) and one
  10.67 px line (ink colour ΔE2000 5.49 against 4.5) (`docs/findings/viewport-classes.md`, "Scaled-class residuals").
- Text at 8 device px (the 16 px label at 1280×720) measured over the suite: Unity draws about 5 % less ink there than at
  other sizes, and the ink colour is off in both directions (more so where the design puts a line at a half device
  pixel). No generic weight or sharpness adjustment fits both, and UI Toolkit 6000.3 gives runtime panels no SDF
  sharpness; the limits stay, and the readable-text floor (above) puts text at 9 device px or more instead of the kit's
  readability warning (`docs/findings/text-ink.md` section 9).
- The fidelity suite (22 fixtures, 9 components, 4728 captures at six viewports, 12 min 53 s) passes every capture at
  3840×2160, 2560×1440 and 1920×1080, and 771 of 788 at 1280×720 (16 captures of an unchecked 20 device px radio, whose
  2 px ring Chromium anti-aliases 0.1–0.28 px inside the circle, SSIM 0.979 against 0.984, and one transition sample a
  border 0.774 device px down a translate: measured, pending a decision); at the scaled viewports 779 (1600×900) and 755
  (1366×768) of 788 pass (before the root scale: 431 and 17). No box fails at any viewport. What fails there: SSIM
  outside the round-edge band (pictures drawn scaled, a baked gradient, 12.8 px table rows and 1 px dividers, a vector
  icon, transition samples Chromium draws from a resampled layer), two focus-ring corners (the corner evidence rule) and
  one 10.67 px line (ink colour ΔE2000 5.49 against 4.5) (`docs/findings/viewport-classes.md`).

### Fixed

- An ellipsized line is cut by the package, by the browser's rule (ruling R144): the compiler writes every text that does
  not wrap and ends in an ellipsis as a `DesignOverflowLabel`, which displays the longest prefix of whole grapheme clusters
  whose width plus the ellipsis's own width fits its content box, measured as the text fit measures at the layout scale.
  UI Toolkit's own elision measured the kerned string ("Weekly preview" in 84 px: "Weekly…" against the browser's
  "Weekl…") and depended on the root scale at the scaled viewports. The label keeps the whole text (`FullText`; the view's
  setters write it, `DesignView.GetText` reads it, a text written to the label becomes it), the layout measures the whole
  text, and it cuts again only when the text, font, size, spacing, width or scale changes. Right-to-left and
  advanced-generator text keep UI Toolkit's own ellipsis; the import pre-adds the ellipsis glyph.
- A keyed inline text matched its kit text style on size and weight only, so with caption 20/28 and label 20/24 a 20/24
  label (an inline text beside an icon, or one a state shows) was exported as caption and drawn with the 28 px line box:
  1.6–4 px lower or taller, and the rows below it 4 px down (every verify failure of a pilot's screen at 2560×1440 and
  3840×2160). Such a text now takes the style of its size, weight and computed line height, exactly; one whose line height
  no style has gets no style, and lint U-CSS-016 names it. The extraction revision is part of the export hash, so an
  export of the older extractor is made again; the compiler also gives a text of an older export the style of its own
  line height and refuses one whose line height no style of its size and weight has.
- An import or kit sync saved glyphs runtime text had added to a loaded font twin outside the Play guard (a twin first
  loaded during Play and never marked dirty, or drawn by a panel in Edit mode): binary churn and "Importer generated
  inconsistent result". Before they touch the twins they now give every loaded plain twin whose glyphs differ from its
  file its file's state back, so they save the file's glyphs and what the screens pre-add only.
- A verify's output is bounded: the report keeps thumbnails of the first failing capture of each set of issues (at most
  24; a later capture with the same issues points at them) and one crop per element, check and viewport (at most 200, six
  per capture), and `verdict.json` is compact and lists per capture the element rows that did not pass, without the
  masked regions (the report lists the same rows). One failing verify of a 942-capture screen left 533 MB (report.html
  152 MB, verdict.json 186 MB, 5910 pictures 195 MB); the same verdict and goldens now give 13.8 MB.

- A rebuilt font twin kept looking up the characters its rebuild dropped (ruling R139): the generator copies a fresh
  asset's fields over a twin it rebuilds, which replaces the character table but not TextCore's lookup, so
  `DesignText.Prepare` added nothing to it afterwards. The rebuild reads the font asset definition again.
- An empty text-sized label with a font asked the Editor for another update on every repaint (the font it compares was
  recorded only for non-empty text); and a label measured while its face's new glyphs still waited for their kerning pairs
  in TextCore's queue (another label's layout added them that frame) kept the unkerned width (262.23 against 248.54 panel
  px). The fit records text, font and style together, gives the face all its glyphs' kerning pairs before it measures while
  TextCore's queue holds some (nothing polls), and keys its cache on the face's pair count.
- The fit's kerning completion took out every pair of a glyph the face does not hold; a line-box variant shares its twin's
  feature table, so a measure on one removed the pairs of glyphs the other added at runtime, and kerning depended on which
  label measured first (fix round 3, N-7). It now only adds the missing pairs (`DesignText.AddFeatures`); an import still
  prunes a twin's file.
- A text-sized label switched to a script locale kept the previous text's width (fix round 3, found in the game: a calendar
  switched from Turkish to Arabic kept 18 to 21 of its 32 labels at their Turkish widths). UI Toolkit keeps the advanced
  generator's measure in another member of the text handle than the standard width the fit read. Text the advanced
  generator lays out now keeps UI Toolkit's own width, as a label built that way did; the standard width is used only when it
  is the one just measured, and a repaint whose generator changed measures again.
- A text-sized label or button kept its earlier text's width when its text was written without a change event (a data
  binding, a list rebinding an item, `SetValueWithoutNotify`): a language switched while a screen was open left labels at
  their earlier text's widths (ruling R136). The fit now also measures again when a repaint shows a text, font or style other
  than the one it last measured; a repaint of the same text measures nothing.
- A text-sized label or button kept the width measured for its earlier letter-spacing, word-spacing or font size when one
  of them changed and nothing told the fit (fix round 4, N-10): UI Toolkit sends a style change only to an element with a
  custom property, and under an exact width and height no geometry changes (a label built in code, given a letter-spacing
  of 4: 252 panel px kept where its text then needs 273). The repaint check compares the resolved font size and spacings
  too, against the values last measured; a repaint of the same style measures nothing.
- A text-sized label or button could keep UI Toolkit's own width for good (ruling R134; the letter-spacing fixture's caps
  label in some full runs): the text fit measured only text whose every weight-table face held its characters, and a face
  that never draws the text (the bold face under a normal text, an italic face) never gets them. It now checks only the
  face UI Toolkit draws the resolved style with (`DesignText.DrawingFace`), and when that face lacks a character it
  measures once more after the next draw, which adds it, and once more after that for the kerning pairs TextCore's queue
  brings; a face whose glyph set stops changing is not polled.
- U-FONT-004 counted a scale that a later or more specific rule of no state overrides whenever a state rule set the same
  property (`.box{transform:scale(0.5)} .box.wide{transform:none} .box:hover{transform:scale(1.1)}`: an import-blocking
  error for a box never drawn at 0.5). Only the cascade's winner among the rules of no state counts, and only while a state
  rule that sets the property holds now (ruling R131).
- U-FONT-004 treats a rule whose animation keeps its end (fill forwards or both) and ends visible as showing the element at
  its last keyframe's scale, judges a closed scale under `:not(.is-open)` only where it can apply with a rule that shows the
  element, takes a reveal split over two rules of one state as one, and judges a rule of no state that a state rule
  replaces now (three false import-blocking errors and one miss of the re-review).
- An Undo of a scale edit made while a screen held a factor maps back to that snapshot's own factor also after the same
  factor was written again later (each written factor keeps the range of Undo groups it was held in).
- The fidelity run deletes the fonts, twins and screens it wrote into the project copy at its end (other test runs on the
  copy count every twin in the project).

- U-FONT-004 judges text the design keeps hidden where a rule or code shows it: a hidden element's own scale counts
  unless every rule that shows it sets that property (a pop-in), so a closed dialog's, menu's or toast's text under a
  scale is judged; a hover's `scale` and a press's `transform` multiply (the smallest of each); a breakpoint's
  `font-size` is judged only at the declared viewports where its @media holds.
- `DesignOverflowLabel` starts an overflowing line at the right edge in right-to-left text (the resolved language
  direction), so an overflowing Arabic label shows its beginning; it hears style-only changes (the compiler gives its type
  a custom property), keeps the design's alignment where its text wraps and after two text changes in one frame, and
  measures its text only when the text, its font, its width or the panel's scale changed.
- A new hold of a PanelSettings keeps the factors an earlier hold wrote, so an Undo of a scale edit made while held still
  maps the held factor back to its own after a resolution change; an Undo or Redo of a group recorded before a factor was
  first written never maps a value to it (the user's own earlier 120 % stays theirs).
- Kit sync writes only text-size steps with a positive finite scale to kit.config.json and names the others (a NaN was
  written as `NaN`, a 0 or negative scale stopped every exporter command, an infinite one threw).
- An Undo or Redo maps a PanelSettings' scale back to a held factor's own only on the settings it touched and only for a
  factor written since the settings' own last changed: a user's or a game's 120 % equal to a factor held earlier is no
  longer reset by an unrelated Undo, in Edit mode or in Play mode.
- A text a row released keeps no memory of that row after a resolution change, a re-attach or a new parent (a label bound
  into a row with room, or a tab after the resolution changed, kept UI Toolkit's own width at an exact viewport).
- A round element without text whose ring gives no evidence (a border under 2 device px) is held to `ssimElement` at a
  scaled viewport (a missing thin ring passed).
- Lint W-IMG-001 reads the background-size of the image's own layer (an image behind a gradient), counts the scale an
  element or its ancestors get now, in a state or in a keyframe animation, takes an `<img>`'s pixels from its file (a
  srcset density no longer halves them), and no longer aborts the lint on a file name with a bare `%`; a data URI is named
  by its type. The design snapshot waits at most 3 s for an image (a lazy image outside the viewport never loads).
- The comparison of the scaled class can tell the anti-aliasing ramp of round shapes from other differences: an element
  whose SSIM with the edge band of its round shapes masked meets the element limit (and whose other checks pass) may meet
  the measured `ssimRoundEdge`, a corner sample whose window reaches that band, with at least three window pixels
  outside it that match, the measured `deltaE2000RoundEdge` (`fidelity-thresholds.json` `scaled`; the file's own values
  must be off, as at exact viewports). The band holds the element's own and its descendants' round shapes, and a round element
  without text takes `ssimRoundEdge` only while the middle of each border side of 2 device px or more is within
  `deltaE2000RoundEdge` of the design's, so a missing or wrong-colour ring of 2 device px or more in the masked band is
  caught (a thinner ring has no sample and keeps the element limit; the sample, the best of ±1 px offsets, sees a ring's
  colour, not a width a pixel thinner). The golden's text-sized width forgives the same 0.012
  device px as `DesignTextFit` (a text that little over a whole pixel is that pixel on both sides).
- A radial gradient that ends transparent (the toggle switch's knob) is baked as the ellipse it paints, inside its box:
  Unity's VectorImage drew a speckled ring where the gradient's pad region starts, which failed the knob's SSIM at
  3840×2160 (0.967).

- `DesignUiGammaComposite` draws its panel where UI Toolkit would draw the panel on screen instead of at the end of the
  frame over everything: over Screen Space - Overlay canvases of a lower or the same sort order, under those of a higher
  one, and among other runtime panels by sort order (the same sort order: the panel made later on top), so drawing and
  pointer input agree (a menu canvas with a higher sort order showed under a composited screen while taking its clicks).
  It wraps the overlay pass's hooks (`docs/findings/composite-order.md`: measured in a GUI Editor on the Built-in
  pipeline and URP 17.3, 13 of 13 sample points identical to the same panel drawn on screen without the composite);
  about 0.004 ms more CPU per frame, no managed allocation per frame. A texture the overlay pass did not draw in a frame (no pass, another display, hooks
  replaced by other code, a Unity version without the members it needs: said once) is still drawn at the end of the
  frame, over everything, as before; each composite decides that per texture.
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
