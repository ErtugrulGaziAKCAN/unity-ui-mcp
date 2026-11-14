# Design-to-UI Toolkit pipeline (unity-ui-mcp) — design spec

| | |
|---|---|
| Date | 2026-11-12 |
| Status | Draft for review |
| First consumer | A Unity 6000.3 game project (URP, Linear color space, Unity Localization) |
| Target | Any Unity project on **Unity 6.3 LTS (6000.3) or later** |

## 1. Purpose and success criteria

AI agents currently build game UI by *interpreting* approved design images and HTML, then hand-assembling uGUI
prefabs. The result drifts from the design in size, spacing, typography and states. The team is not satisfied.

This project replaces interpretation with a **deterministic pipeline**: a design made in Claude Design under a
defined contract is exported from a real browser into a versioned intermediate representation (IR), compiled
into UI Toolkit assets and a typed C# view, and then **measured** against the browser rendering.

The pipeline is a success when:

1. A screen designed under the contract compiles into UI Toolkit without manual layout work.
2. The Unity rendering passes the fidelity thresholds in §15 at every declared viewport, state and interaction state.
3. Text is localizable end to end through Unity Localization, with per-language fonts, RTL and live language
   switching verified for every active locale.
4. Re-importing a changed design regenerates only generated files and never touches hand-written code.
5. The same package installs into any Unity 6.3+ project through a project profile, with no project
   specifics in the core.
6. Any MCP-capable AI client (Claude Code, Claude Desktop, Cursor, Codex and others) can drive the whole loop
   through one standalone MCP server: read the design rules, lint a design, import it into Unity, verify it and
   read the report. The intended workflow is: pick and revise designs in Claude Design (or any AI that produces
   HTML under the kit rules), export the chosen version, and let the AI client apply it to Unity through the MCP.

## 2. Decisions taken in brainstorming

| Topic | Decision | By |
|---|---|---|
| Runtime | Unity **UI Toolkit** (UXML + USS) | User |
| Design input | **Rule-bound** designs with a lint gate. Unsupported CSS fails at export; nothing is silently approximated | User |
| Transfer scope | Static appearance **plus** interaction states, transitions/animations, dynamic content and responsive rules | User |
| Text | Every visible text carries a **key + Turkish + English**. Design shows Turkish; English stays source/fallback | User |
| Extraction approach | **A — browser-measured compilation** (Playwright + Chrome DevTools Protocol) | User |
| Fonts | Fonts come **from the Unity project**, never from the design: TMP Settings default font plus the project's **per-language font mapping** | User |
| Minimum Unity version | 6.3 LTS: USS `filter`, core SVG → VectorImage import, `-unity-text-generator: advanced` | Proposed, accepted with section 1 |

## 3. Scope and non-goals

In scope: design kit and rules for Claude Design, lint, exporter, IR, compiler, runtime helpers, font twin
generation, localization writer and binding, generated view classes, verification and reports, UPM package,
the standalone MCP server with its Unity Editor bridge, the `/unity-ui-mcp` skill, the first consumer's profile and one pilot
screen.

Not in scope:

- Gameplay, data providers or commands. Presenters connect views to existing game services and are written per
  project; the pipeline never invents providers, values or success outcomes.
- Migrating existing uGUI screens. Which screens move to UI Toolkit, and when, is a separate decision.
- Arbitrary HTML import. Designs outside the contract fail lint.
- Player builds and packaged-Player verification (owned by the project's developers).
- World-space UI.

## 4. Architecture overview

```
Claude Design (HTML/CSS/JS, built with the design kit)
        │  local folder or ZIP (a Claude Design artifact is downloaded to a folder first)
        ▼
design-export (Node 20+, Playwright, pinned Chromium)
  1. load with kit fonts only → 2. lint → 3. capture matrix (viewport × state × pseudo-state)
  4. extract specified + computed styles → 5. bake shadows/gradients → 6. write IR, goldens, fixtures
        │  <screen>/screen.ir.json, goldens/, assets/, fixtures/, lint-report.json
        ▼
Unity package (Editor)
  compiler: IR → UXML, USS, VectorImage/sprites, String Table entries, <Screen>View.g.cs, manifest
  font twin: TMP font assets → UI Toolkit FontAssets
        ▼
Verification
  Unity render (RenderTexture, fixture data, simulated pointer states) → boxes + PNG
  design-export compare → HTML report (overlay, heatmap, box deltas, locale checks, perf)
```

Units and their single responsibility:

| Unit | Responsibility | Depends on |
|---|---|---|
| Design kit | Tokens, components, rules text and synced fonts that Claude Design builds with | Font sync output |
| `design-export lint` | Rejects designs outside the contract with actionable errors | Kit rules |
| `design-export export` | Produces IR, goldens, baked assets, fixtures | Pinned Chromium |
| IR schema | Versioned contract between browser and Unity | — |
| Compiler (Editor) | IR → Unity assets and view code, deterministic | IR schema, profile |
| Font twin generator (Editor) | Mirrors the project's TMP fonts as UI Toolkit FontAssets | Font resolver |
| Localization writer (Editor) | Writes key/EN/TR entries into String Tables safely | Localization adapter |
| Runtime helpers | Breakpoints, locale fonts/RTL/text size, keyframe playback | UI Toolkit |
| Unity verifier (Editor, EditMode test) | Renders a screen with fixtures and records boxes and pixels | Compiler output |
| `design-export compare` | Applies thresholds, writes the report | Goldens, Unity capture |
| Project profile | All project-specific settings and adapters | — |
| `design-ui-mcp` server | Client-agnostic MCP front door: rules, list, lint, import, verify, status, kit sync | Exporter, compare, Unity runner |
| Editor bridge | Loopback endpoint inside the open Editor; runs import and kit sync in place | Editor entry points |
| `/unity-ui-mcp` skill | Chat entry point: checks server, bridge, `designRoot` and kit, then drives the loop | MCP server |
| Menu / batch entry points | Thin wrappers over the same Editor API, used by the Unity runner | Above |

## 5. Design contract

### 5.1 Design kit

The kit is uploaded to Claude as a design system. It contains:

- `tokens.css`: colors, type scale, spacing, radii and shadows as CSS custom properties. This file is the single
  token source: the exporter records the tokens a design uses in the IR, and the compiler emits them as
  `DesignTokens.uss`.
- `fonts/`: font files and `@font-face` rules produced by font sync (§6). Designs may not declare other fonts.
- Component library: buttons, toggles, text fields, dropdowns, tabs, lists, scroll areas, cards and dialogs, each
  mapped to a Unity control (§10).
- `RULES.md`: the contract below, written for Claude Design, with allowed patterns and examples.

### 5.2 Markup attributes

| Attribute | Meaning | Required |
|---|---|---|
| `data-u-screen` | Screen id on the root, e.g. `club.overview` | Yes, once |
| `data-u-id` | Stable element name exposed to code | On every interactive or bound element |
| `data-l10n` | Localization key, meaningful English, e.g. `club.overview.title` | On every visible static text |
| `data-en` | English source text for that key | With `data-l10n` |
| `data-l10n-args` | Smart String argument names, e.g. `amount,currency` | When the text has variables |
| `data-u-bind` | Dynamic, non-translated value (player name, number) | For runtime values |
| `data-u-action` | Command raised on activation, e.g. `open-inbox` | On actionable elements |
| `data-u-repeat` | Repeated item template, e.g. `players` | On the first sample item |
| `data-u-repeat-mode` | `list` (virtualized, default inside scroll) or `inline` | Optional |
| `data-u-state` | Screen state variant, e.g. `loading`, `empty`, `error` | On state roots |
| `data-u-external` | Region drawn by the host (e.g. an existing uGUI shell); excluded from compilation and masked in comparison | Optional |

Visible Turkish text is the element's text content. Elements without `data-u-id` receive structural names
(e.g. `header__0__1`); code never references them, so renaming them breaks nothing.

### 5.3 CSS to UI Toolkit mapping

Checked against the Unity 6.3 USS property reference. The M0 measurements (`docs/findings/m0.md`) calibrated the
rows that cite them; items marked *unmeasured* are allowed by the reference but not yet checked against Chromium
(findings O-15).

| CSS | UI Toolkit | Rule |
|---|---|---|
| flex layout, `%`, `px`, `auto`, min/max sizes, margin, padding, `position: absolute`, top/right/bottom/left, overflow, border widths/colors, opacity; *unmeasured:* `rotate`/`scale`/`translate`/`transform-origin`, `aspect-ratio`, `text-shadow`, `letter-spacing`, `word-spacing`, `white-space` beyond line breaks, `text-overflow`, transitions (played by the animation player, §11) | Direct USS | Allowed. M0 parity was measured with UI Toolkit's initial values mirrored in the HTML (column flex, `position: relative`, `flex-shrink: 1`, `border-box`, `align-content: flex-start`); where a CSS initial value differs, the compiler must write it explicitly or lint must reject it (findings O-6) |
| `filter` | USS built-in filter functions | Only functions listed in `kit.config.json` `filterFunctions` (U-CSS-015); the list is empty until a function passes the fidelity suite |
| `border-radius` | Resolved at export to one px radius per corner against the element's box, with CSS's overlapping-curves scaling (`9999px` on a 300×80 box becomes 40px; UI Toolkit would clamp each axis and draw an ellipse) | Circular corners only: elliptical radii (`/` syntax, `%` on a non-square box) are U-CSS-020 |
| `border-style` | USS borders are always solid | Only `solid` or `none` (U-CSS-021) |
| `align-items` / `align-self` | Direct USS, except `baseline` (rejected by USS) | No `baseline` values (U-CSS-018) |
| `min-width` / `min-height: auto` on flex items | USS treats `auto` as 0 (no automatic minimum size; long words break) | A design whose layout depends on the automatic minimum size fails lint (U-CSS-019) |
| `:hover`, `:active`, `:focus`, `:disabled`, `:checked` | USS pseudo-classes | Allowed. UI Toolkit applies `:active` only to elements with a `Clickable`, so elements with an `:active` rule compile to `Button` or get a `Clickable` |
| Custom states (selected, active tab) | Class toggled by the view, e.g. `.is-selected` | Allowed via `is-*` classes |
| `gap`, `row-gap`, `column-gap` | Not in USS → lowered to child margins | Only on non-wrapping flex containers |
| `box-shadow` | Not in USS → baked by Chromium per style layer: the outer shadows into one 9-slice image behind the element, the `inset` shadows into one 9-slice image over the padding box (above the background, below the content); a layer whose shadow or box differs (a hover lift) gets its own image | Allowed; a transition of `box-shadow` is U-CSS-014 (transition opacity or transform instead) |
| `linear-gradient`, `radial-gradient` | Not in USS → SVG gradient → VectorImage background (`SVGType.VectorImage`; the importer bakes a 64-step ramp), one SVG per style layer box, several gradients in one SVG; the IR records the smallest stop spacing | Allowed; colour stops closer than 1/64 of the gradient line, hard stops included, are U-CSS-022 (the 1/64 boundary is derived from the ramp size and one measured hard stop); a transition of `background-image`, a url() image beside another image, a gradient that does not fill the element and colour spaces are U-CSS-014 |
| `text-shadow` | Direct USS (one shadow, written as x y blur colour) | Several shadows are U-CSS-023 |
| `object-fit` | `-unity-background-scale-mode` (fill → stretch-to-fill, contain → scale-to-fit, cover → scale-and-crop), on image nodes | `fill`, `contain`, `cover`; `object-position` only centred (U-CSS-023) |
| `@media` | Not in USS → breakpoint classes on the root | Only `min/max-width`, `min/max-aspect-ratio` |
| `@keyframes` / `animation` | Not in USS → generated keyframe data + runtime player | Only transform, opacity and color properties |
| Inline emphasis inside a paragraph | TextCore rich text tags | Only `b`, `i`, `color`, `size` |
| `rem` | Resolved to px at export | Allowed |
| Transitions and easing | Recorded in the IR and played by the animation player (§11), never emitted as USS transitions, so nothing animates twice | `linear`, `ease*`, `cubic-bezier()`, `steps()` once the player lands; until then the five keywords |
| `display: grid`, `::before`/`::after`, `:nth-child` and structural pseudo-classes, a `z-index` the sibling order cannot follow (U-CSS-004), `calc()`, `vw`/`vh`, `backdrop-filter`, `cubic-bezier()`, `inline`/`inline-block` text flow, `font-family` outside the kit, `box-sizing: content-box` on a sized element with padding or border (U-CSS-036), an absolute element in a static parent (U-CSS-035) | No equivalent | **Lint error** |
| `font-size`, `line-height`, `font-weight` | Font size and weight direct; `line-height` is not in USS and is dropped by the compiler | Only the kit text styles in `text-styles.json` (sizes and line heights in multiples of 4 px, whole device pixels at every declared viewport; U-CSS-016); see "Text styles" below. Weights need a real face in the reference locale's font (checked by kit sync; U-FONT-001 as backstop) |

`z-index` is compiled by reordering siblings, since UI Toolkit draws in hierarchy order. The compiler keeps in-flow
siblings in layout order and moves only absolute siblings, each into the gap that gives it its CSS stacking level
(negative z, in-flow, positioned auto/0, positive z; a flex item with a z-index stacks like a relative element). So
`z-index` is allowed in the base layer on absolute siblings, and on relative siblings and flex items where the markup
order already is the CSS paint order; an absolute sibling that has no such gap, with or without a z-index (an absolute
badge before a relative header that precedes a static body), is rejected too (U-CSS-004). Overlapping siblings whose paint order still differs (a relative
sibling before a static one, an absolute sibling before a faded or transformed one) are U-CSS-032, and pseudo-state
combinations a pointer or focus cannot produce in UI Toolkit (`:active` on an ancestor and on the element, two focused
elements) are U-CSS-033.

Design screens render on a dedicated PanelSettings with the package's minimal `DesignUiRuntimeTheme` (no Unity
default theme), in the verifier and in game alike, so no theme rule can change a compiled control; the inner parts of
controls are styled by the compiled kit components.

**Text styles.** UI Toolkit cannot set a line height: a text element is `ceil(n × P)` tall for n lines, with
`P = fontSize × faceInfo.lineHeight / faceInfo.pointSize` of the font twin, while Chromium makes it `n × line-height`.
Unity 6000.3 also rounds font sizes to whole device pixels and ceils each text element's height to whole device pixels.
The font twins therefore carry CSS's line box: `faceInfo.lineHeight = r × pointSize` with the half-leading folded into
ascent and descent, for two kit ratios, `r = 1.25` (label 16/20, subtitle 32/40, headline 48/60, display 64/80 px, font
size / line height) and `r = 4/3` (caption 12/16, body 24/32, title 36/48 px). Font sizes and line heights are
multiples of 4 px, so both stay whole device pixels at the 0.75 and 0.5 viewport scales too: `P = L`, a text block is
exactly `n × L` tall with baselines within 0.5 px, and texts stacked in a column add up without drift (a fractional line
height would be ceiled per text). The kit ships Inter Regular and Bold in these seven sizes; the table is generated from
the two ratios by `tools/design-export/src/kit/textStyles.ts`. `design-export kit build` and kit sync refuse a table
whose font size or line height is not a whole number of device pixels at the scale of any declared viewport, and kit
sync builds the twins with the same line box. Lint matches the numbers (U-CSS-016). Every listing of the table (RULES.md,
the base stylesheet's `.text-<style>` classes, the Claude Design System's type styles) is generated from
`text-styles.json`. The IR records the matched style name, and the USS writer formats numbers with the invariant
culture at round-trip precision.

**Font smoothing.** Chromium on macOS draws text with the platform's default font smoothing, which thickens glyph
stems; UI Toolkit's SDF text has no such dilation, so the same text looked bolder in the design than in Unity. The
design therefore renders without it: the kit base stylesheet sets `-webkit-font-smoothing: antialiased` and
`-moz-osx-font-smoothing: grayscale` on `:root`, lint requires the computed `-webkit-font-smoothing: antialiased` on
every text-bearing element (U-CSS-038), and the goldens are screenshots of that same page. What the designer sees in
Claude Design, the goldens and Unity then draw the same stem weight (`docs/findings/text-ink.md`).

### 5.4 Lint

Lint runs on the live DOM and CSSOM in Chromium. Each finding has a stable rule id (e.g. `U-CSS-012`), the element
path, the offending declaration or attribute, and a fix hint. Errors block export; warnings are reported (e.g. a
font weight with no real face in a non-reference locale's font, a layout property animated by a transition).

Lint is a whitelist. Which CSS properties, keywords, units and value functions the pipeline handles, and how
(direct, lowered, dropped or rejected with a rule id and fix), is recorded once in
`packages/com.unity.design-ui/Editor/Data/css-support.json`; the exporter's lint (`tools/design-export/src/lint/allowed-css.ts`
loads it) and the Unity style mapper both read it, so a property the mapper cannot reproduce can never pass lint.
Anything not listed is an error (U-CSS-023 for properties, U-CSS-024 for value functions). Missing assets (U-NET-002),
font faces not from the kit (U-FONT-002), glyphs rendered by a platform fallback font (U-FONT-003), text without grayscale
font smoothing (U-CSS-038) and markup outside
`<x-dc>` (U-DC-005) are errors too.

The file describes IR values for the mapper (per property `handling`, `keywords`, `types`, `functions`, `components`,
`list`, `mapValues`, `dropValues`, `loweredValues` valid only where the compiler lowers them, and `rule` + `fix` on
rejected properties) and adds what the lint needs, without changing those fields:

- `rejectedValues` (keyword → rule and fix, e.g. `display: grid` is U-CSS-001, `position: sticky` U-CSS-017),
  `valueRule` (a dedicated rule judges the values, e.g. U-CSS-016 for font sizes) and `valueFix` (the fix for any
  other rejected value), so every rejected property and value carries a rule id and a fix;
- `exportResolved`: authoring forms the exporter resolves before the IR (`rem`, `var()`, `hsl()`/`hsla()`, CSS-wide
  keywords), and per property `authoring` overrides for values it rewrites (`transform` split into
  translate/rotate/scale, `%` radii, background layer lists, border width keywords);
- `typeUnits`, `initialValues` (resets such as `outline: none`, `text-decoration: none`, `appearance: none` and the
  longhands shorthands write; the exporter leaves out initial values of properties the mapper rejects) and the lint's
  lists: pseudo-classes and -elements, at-rules, media features, elements and input types, keyframe properties, timing
  keywords and browser defaults.

`contracts/css-support-cases.json` is the shared verdict table: each case puts one declaration in a named context
(a flex item, a block child, a hover or state layer, siblings that overlap, …), and records the lint's rule ids, the
IR the exporter writes and whether the Unity compiler must compile or reject it. The exporter's test lints and exports
every case; the Unity test compiles every IR and must agree.

Lint also reports `info` findings (rule ids `I-…`) that need no fix, e.g. a `title` becomes a tooltip, which UI
Toolkit shows only in Editor panels (I-MRK-001).

The compiler makes every CSS default that differs from UI Toolkit explicit before mapping: flex rows, block children
that do not shrink, gap only on flex containers, insets ignored on static elements, border-box sizing, and CSS paint
order (negative z-index, then in-flow siblings, then positioned siblings). Lint rejects what it cannot make explicit:
an absolute element whose parent is static (UI Toolkit anchors to the parent, CSS to the nearest positioned ancestor;
U-CSS-035), `content-box` on a sized element with padding or border (U-CSS-036), an inline element in a block container
that the exporter cannot write as a block (U-CSS-009; see below), a gap container whose earlier child shows or hides itself by its own
pseudo-state or `is-*` class (the first visible child takes no gap margin, and USS has no sibling combinator; U-CSS-034),
and baked effects that cannot share one element (U-CSS-037): an inset shadow (an overlay child above the background,
below the content) under the element's own text, on a form control or on a scroll area; a url() image beside a gradient
in another layer, or only in a layer (one background image with one geometry per element); a background image or an
inset shadow on a tintable icon (the icon is the element's own tinted background image).

UI Toolkit has no inline flow. An inline element in a block container is written as a block only when it is the
container's only design child (siblings hidden in the default state count, since the compiler keeps them), holds text,
and renders the same as a block: no background, border, shadow, radius, padding, margin or outline, no transform or
opacity change in any layer, and the parent's font family, size, weight, line height and letter spacing in every layer
(the CSS line box keeps the parent's strut). Otherwise lint reports U-CSS-009 with the fix "set display: block on the
child, or make the parent display: flex".

### 5.5 Claude Design canvases

Claude Design runs inside Claude as the Design artifact type. A canvas holds `project/canvas.json` (one entry per
artboard with its frame size) and one Design Component page per artboard, `project/<name>.dc.html`: markup inside
`<x-dc>`, page styles inside `<helmet><style>`, a `DCLogic` script block, the `./support.js` runtime, and images and
fonts as `/_blob/<id>` uploads. The design kit is published to Claude as a Design System artifact
(`project/README.md`, `project/tokens.json`, fonts, component previews), so every design attaches it.

- **Fetch.** An AI client with the Artifact tool reads `project/canvas.json`, the chosen artboard and every
  `/_blob/<id>` it uses, and saves them under `<designRoot>/<screen-id>/` together with `blobs.json` (blob id →
  local file). Clients without that tool use the canvas's own export into the same folder.
- **Load.** The exporter unwraps an artboard locally: `<helmet>` contents go to `<head>`, `<x-dc>` children to
  `<body>`, the DC script block and `support.js` are dropped, and `/_blob/<id>` URLs point at the local files. The
  result is a static page rendered in the pinned Chromium. Plain `.html` input keeps working.
- **Lint.** Dynamic Design Component features have no static meaning, so they fail lint with a fix: `{{…}}` holes
  (U-DC-001), `<sc-for>`, `<sc-if>`, `<dc-import>` and `x-import` (U-DC-002; repeated rows are written out with
  `data-u-repeat` on the first), UI built by script (U-DC-003), and `data-props` other than `$preview` (U-DC-004).
- **Artboard.** One artboard per screen, a fixed 2560×1440 root, titled with the screen id; states stay
  `data-u-state` roots inside it (§5.2). Inline styles are allowed; they compile like rules.
- **Design System export.** `design-export kit claude <kitDir> <outDir>` writes the kit as a Design System artifact
  folder (`README.md` rendered from the same sources as `RULES.md` plus the artboard rules, list-shaped `tokens.json`
  from `tokens.css` and `text-styles.json`, the font files kit sync copied from the Unity project, component previews
  and a cover, the index last); the `/unity-ui-mcp` skill publishes or updates that design system with the Artifact tool.

## 6. Fonts

**Source of truth is the Unity project.** A pluggable **font resolver** answers "which TMP font asset renders
locale X", including its fallback chain and weight table.

- Default resolver: TMP Settings default font asset (read through `TMP_Settings.instance`, not a file path) and
  its global fallbacks, for every locale.
- Project resolvers can add a per-locale mapping. For example, a project can map locales through its own localized-fonts asset (§17).
  The profile's `localeFonts` maps locales without code. A project with its own font system derives from the Editor
  base class `DesignUiFontResolver` (a `ScriptableObject`) in one of its Editor assemblies and sets the asset as the
  profile's `fontResolver`: kit sync, the compile and the Design UI window then ask it, a locale it gives no font for
  falls back to `localeFonts` over TMP Settings, TMP Settings' global fallbacks follow its fonts as with the default
  resolver (`IncludeGlobalFallbacks`, true by default, opts out), and a missing or throwing resolver is an error that
  names it. Runtime needs nothing: the compiled `DesignFontSet` carries the answer.

**Font sync** (`design_ui_kit_sync`) reads the resolved fonts' source font files (`m_SourceFontFile_EditorRef`)
and writes them with `@font-face` rules into the kit, keyed by locale. Claude Design and the exporter's Chromium
therefore render with the same files Unity uses. Lint rejects any other `font-family`. Sync warns when more than
one `TMP Settings` asset is reachable through `Resources`. Sync also writes each `--font-*` token of `tokens.css` from
the synced fonts' family names (the TMP face family can differ from the asset name), keeping the line and its comment,
and reports a token it cannot map; `design-export kit build` (and `--check`) fails when a `--font-*` token names a
family `fonts.css` does not declare.

**Font twins.** UI Toolkit text needs TextCore `FontAsset`; `TMP_FontAsset` derives from `TMP_Asset` and cannot be
referenced from USS. The twin generator creates one UI Toolkit FontAsset per resolved TMP font asset from the same
source file, matching sampling point size, padding, atlas size and render mode, and reproducing the fallback order
and weight table. Twins are always **dynamic**, because the advanced text generator (needed for Arabic shaping and
bidirectional text) does not accept static font assets. Twins regenerate when TMP Settings or the per-locale mapping
change. The project keeps one font configuration: its TMP setup. Each twin has one variant per text-style size whose face
carries that style's CSS line box (`faceInfo.lineHeight = r × pointSize`, r 1.25 or 4/3, §5.3 text styles) with the
ascent line where Chromium lays out the baseline: `floor((L − round(a·s) − round(d·s)) / 2) + round(a·s)` CSS px below
the line top, the font's ascent and descent rounded at the font size (docs/findings/text-baselines.md).

**Kerning.** A dynamic twin adds a glyph the moment text first needs it, but that glyph's kerning pairs only in its
update queue, after the text was laid out, and UI Toolkit keeps that unkerned first layout (up to 46 px wider on a
33-character line, standard text generator). Import therefore adds every character of the screen's strings, with their
font features (kerning pairs, mark positioning, ligatures), to each locale's twins (the plain twin and its line-box
variants, its weight faces and fallbacks) before anything is laid out. Text that import cannot know (bound values,
Smart String arguments, repeat items) is assigned with `DesignText.SetText`, or its characters are added first with
`DesignText.Prepare`; every generated text write goes through them. The twins keep their dynamic glyph data in player
builds, so a build starts with the imported characters and pairs. The advanced text generator kerns on its own but was
measured outside the 1-px width limit and needs a project-wide setting, so it is not used for this.

**Weights.** If the resolved font has no real face for a weight, both Chromium and Unity synthesize bold, and they
do it differently: UI Toolkit's standard text generator widens every advance by 14 %, Chromium keeps them (M0). For
the reference locale's font, whose pixels are compared, kit sync fails a text style whose weight has no real face,
and lint fails such a weight in a design (U-FONT-001, the backstop); for other locales lint warns (W-FONT-001). The
fix is adding the real face to the TMP weight table; the twin generator mirrors it into the twin's `fontWeightTable`.
It mirrors only the faces in use: regular (400) and bold (700), which UI Toolkit's normal and bold font styles pick,
every weight or style a kit text style names, and the faces every compiled screen of the profile renders with. A
screen's faces are those UI Toolkit picks: each text's `-unity-font-style` in each layer, with the layer's weight and
style merged over its basis as the compiler writes them (a weight-only layer over italic text is bold italic),
combined with the bold and italic tags of its rich text (`<b>` inside italic text is bold italic); its generated
manifest records them (`faces`). Importing one screen, or a kit sync, keeps every face another compiled screen
records. A face a screen needs that the reference locale's font has not is a compile error that names the element,
its layer and the face (UI Toolkit would synthesize it); for another locale it is a compile note. Other faces of a
family get no twin and no glyphs (18 faces of a family, plain and per line box, made each import take minutes). Kit
sync and the status window's Text section name the chosen faces and count the others.

## 7. Exporter and IR

`design-export` is a Node 20+ CLI using Playwright with a pinned Chromium build.

1. **Load.** Only kit fonts are available; wait for `document.fonts.ready`; freeze animations for static captures.
2. **Lint** (§5.4).
3. **Capture matrix.** For each declared viewport (reference 2560×1440 plus profile viewports) × each
   `data-u-state` × each pseudo-state used by the design (forced through CDP `CSS.forcePseudoState`), capture a
   golden PNG, every element's box, and every text node's line boxes (to compare line breaks).
4. **Styles.** Per element, record **specified** values from matched rules (`CSS.getMatchedStylesForNode`), which
   keep `%`, `auto` and flex intent and drive compilation, and **computed** values, which are used only for
   verification. Record pseudo-state, breakpoint and state deltas, transitions and keyframes.
5. **Bake.** Render each `box-shadow` alone in Chromium and cut it into a 9-slice PNG (outer and inset separately, per style
   layer whose shadow or box differs); convert gradients to SVG per layer box;
   name every asset by content hash.
6. **Fixtures.** Sample values inside `data-u-bind` and repeated items are written to `fixtures/sample-data.json`.
   They are used only by verification, never by game data or saves. Per written-out item they also record its `is-*`
   classes (`$classes`), its controls' disabled and checked states (`$states`) and the elements its own markup hides
   (`$hidden`). Markup hiding (the `hidden` attribute, an inline `display: none`) that differs between the items of a
   repeat is sample data, not style: the template element is extracted from its own rules as if it were shown (its
   display and everything derived from it, such as text alignment and its children's layout), its IR node carries
   `itemVisibility: true`, and every item whose markup hides it, the first included, records `$hidden: { <id>: true }`.
   An element hidden in every item keeps `display: none` as style; one hidden by a class or state keeps that layer.
   An item root is never sample-hidden: the repeat alone shows and hides its items from the count the host gives it,
   so a written-out item whose own root its markup hides is refused (lint U-MRK-013 and the exporter). A later
   written-out item may leave a nested repeat empty (no item of it written out; the template item needs one): its
   sample data records the repeat with no items (`"events": []`), and the capture shows none, as `SetItems(0)` does.

Output per screen:

```
<screen-id>/
  screen.ir.json
  goldens/<state>@<w>x<h>[.<pseudo>.<element-id>].png
  goldens/boxes.json
  assets/
  fixtures/sample-data.json
  lint-report.json
```

IR outline (`irVersion: 1`, validated with a JSON Schema shipped in the repo):

```json
{
  "irVersion": 1,
  "screen": "club.overview",
  "source": { "path": "club-overview.html", "sha256": "…" },
  "referenceViewport": [2560, 1440],
  "viewports": [[2560, 1440], [1920, 1080], [1280, 720]],
  "states": ["default", "loading", "empty", "error"],
  "breakpoints": [{ "name": "narrow", "maxWidth": 1600 }],
  "tokens": { "color.surface": "#0b1f26" },
  "fonts": [{ "locale": "tr", "family": "Inter", "file": "fonts/Inter-Regular.ttf", "sha256": "…" }],
  "root": {
    "id": "root", "kind": "container",
    "style": { "base": {}, "hover": {}, "active": {}, "focus": {}, "disabled": {}, "checked": {},
               "bp:narrow": {}, "state:loading": {} },
    "text": { "key": "club.overview.title", "tr": "Genel Bakış", "en": "Overview", "args": [], "rich": false },
    "bind": null, "action": null, "repeat": null, "anims": [], "children": []
  }
}
```

`kind` is one of `container`, `text`, `image`, `vector`, `button`, `toggle`, `input`, `dropdown`, `scroll`, `list`.
Export is deterministic: the same input and Chromium build produce a byte-identical IR (sorted keys, stable ids,
hashed assets). A determinism test enforces this.

## 8. Compiler output

Per screen, into the folder named by the profile:

| File | Content |
|---|---|
| `<Screen>.uxml` | Element tree; every element has a `name` (`data-u-id` or its structural name) so verification can compare every box; only `data-u-id` elements are exposed by the view; no inline styles |
| `<Screen>.uss` | Deduplicated style classes, pseudo-class, state and breakpoint rules |
| `DesignTokens.uss` (shared) | Tokens as USS custom properties |
| `assets/` | VectorImages (icons, gradients), 9-slice shadow sprites with `-unity-slice-*`, images with UI import settings |
| `<Screen>View.g.cs` | Generated view class (§9) |
| `<Screen>.anim.asset` | Keyframe data, when the design has keyframes |
| `.design-ui.json` | Source, IR and generator hashes plus output file hashes |

Selector policy: every element gets one content-hash class (`s-` + 8 hex of its declarations), and each style layer
key of the IR becomes one selector, its dimensions written from the outside in:

| Layer key | Selector |
|---|---|
| `base` | `.s-x` |
| own pseudo-state | `.s-x:hover` (`:active`, `:focus`, `:checked`, `:disabled`) |
| `class:is-selected` (view-toggled state) | `.s-x.is-selected` |
| `state:loading`, `bp:narrow` | `.state-loading .s-x`, `.bp-narrow .s-x`; both: `.bp-narrow.state-loading .s-x` (classes on the screen root) |
| on the screen root itself | `.s-root.state-loading` |
| `anc(card):hover`, `anc(row):class:is-selected` | `.s-card:hover .s-x`, `.s-row.is-selected .s-x` (an ancestor named this way keeps a class of its own) |
| compound, e.g. `state:loading+anc(card):hover+active` | `.state-loading .s-card:hover .s-x:active` |
| `class:__first` (first item of an inline repeat with gap) | `.s-x.__first` (the view toggles it; USS has no `:first-child`) |
| `class:dui-hover` … on a shadow host | `.s-host.dui-hover` (a PseudoStateMirror copies the element's pseudo-states to the host) |

A key with more dimensions always has the higher specificity, so a union layer wins over the layers it combines, as the
IR requires. Rules are ordered by the first element that uses their class, then base, single dimensions, pairs and so on.

The content layout of a scroll area (`flex-direction`, `flex-wrap`, `justify-content`, `align-items`, `align-content`,
`padding`), which CSS applies inside the scroll container, goes to the ScrollView's content container: its rules carry the
child-combinator chain `.s-x > .unity-scroll-view__content-and-vertical-scroll-container > .unity-scroll-view__content-viewport > .unity-scroll-view__content-container`
(the 6000.3 hierarchy; child combinators keep nested ScrollViews out of the match). A list repeat compiles to a
ListView, which scrolls by itself, so it must be a scroll area (`overflow-y: auto`) or the only child of one.
Wrappers with no visual or layout effect are removed.

## 9. Generated view and binding

```csharp
public sealed partial class ClubOverviewView
{
    public ClubOverviewView(VisualElement root);                          // queries elements once
    public void SetClubName(string value);                                // data-u-bind
    public void SetBudget(long amount);                                   // Smart String variable
    public event Action OpenInbox;                                        // data-u-action
    public void SetState(ClubOverviewState state);                        // root class swap
    public void SetPlayers(int count, Action<PlayerRowView, int> bind);   // repeat → ListView
    public void SetSelected(string elementId, bool selected);             // is-selected
}
```

- Setters skip unchanged values and allocate nothing in steady state. Text setters assign through
  `DesignText.SetText`, so new characters are kerned from their first layout (§6).
- An element whose hiding is sample data (`itemVisibility`, §7) gets `Set<Id>Visible(bool visible)` on its item view.
  The item is compiled shown; hiding writes an inline `display: none` through `DesignView.SetVisible` on the element
  that owns its visibility (itself, or its shadow host), showing removes it so the style layers decide again. The
  element needs a `data-u-id` (lint U-MRK-003); the manifest lists each such element with that owner (`visibility`).
  An item root never gets one (the repeat owns its display; the compiler refuses it). The capture fails, asking for a
  new import, when the sample data hides an element the manifest gives no owner or whose owner the item lacks.
- The project writes a presenter that calls the view with real game data. The generator never writes or edits
  presenters.
- Removing a `data-u-id` the presenter uses causes a C# compile error, so breakage is explicit.

## 10. Dynamic content, controls and interaction states

- `data-u-repeat`: the first sample item becomes a template (`PlayerRow.uxml` + `PlayerRowView`). Export checks
  that the other samples share its structure. Inside scroll areas it compiles to a virtualized `ListView`
  (fixed-height mode when items are uniform); `inline` mode uses a pooled repeat for small fixed lists.
- Kit components compile to Unity controls (`Button`, `Toggle`, `TextField` with placeholder, `DropdownField`,
  `ScrollView`, `ListView`), so focus, keyboard and gamepad navigation come from Unity.
- Pseudo-classes map one to one; custom states use `is-*` classes switched by the view.
- Text overflow follows the design (`ellipsis` or wrap); anything else counts as overflow in verification.

## 11. Animation

Animations follow the same rule as static styling: one-to-one, or rejected by lint with a fix.

- **Export.** Every transition (property, duration, delay, timing function) and every `@keyframes` use (offsets,
  values, per-segment timing function, iterations, direction, fill mode, delay) is recorded in the IR with its
  trigger: `show` (the screen opens), `state:<name>`, `pseudo:<hover|active|focus|checked|disabled>` or
  `class:<is-*>`.
- **Runtime.** `DesignUiAnimationPlayer` plays all of them with an injectable clock. It evaluates CSS timing functions
  exactly: the five keywords as their CSS `cubic-bezier()` definitions, any `cubic-bezier()`, and `steps()`. A
  pseudo-state or class transition animates from the current value to the target layer's value and then hands the
  value back to the USS rule. The player writes transform, opacity and colour properties without layout passes and
  allocates nothing per frame in steady state; a transition or keyframes of a layout property is a lint error
  (U-CSS-013, U-CSS-042: animate `translate` or `scale` instead).
- **Verification.** The exporter pauses animations through the CDP `Animation` domain and captures each animation at
  `delay` and at 0, ¼, ½, ¾ and 1 of its duration. The Unity verifier steps the player's clock to the same times.
  Every sample is compared with the static thresholds (§15).

## 12. Responsive behavior

- PanelSettings: Scale With Screen Size, reference 2560×1440, screen match mode from the profile. One design px
  equals one reference px.
- The exporter reproduces that scaling: for a viewport W×H it renders the page at the panel's logical size
  (W/scale × H/scale) with `deviceScaleFactor = scale`, using Unity's own formula
  (`PanelSettings.ResolveScale`, 6000.3: `scale = lerp(W/refW, H/refH, match)`, a linear blend, no rounding). It equals
  the UGUI CanvasScaler log formula `2^lerp(log2(W/refW), log2(H/refH), match)` only at the reference aspect (16:9);
  e.g. 2400×1440 at match 0.5 is 0.96875, not 0.96825. Boxes are compared in device pixels.
- `BreakpointController` listens to geometry changes on the root and toggles `.bp-*` classes only when the
  active set changes.
- Every declared viewport is compiled from the same IR and verified separately.

## 13. Localization

**At design time (lint).** Every visible static text has `data-l10n` and `data-en`; keys are meaningful English
and follow `<screen>.<element>[.<detail>]`; each screen maps to a String Table collection through the profile;
texts with variables are Smart Strings with declared `data-l10n-args`; runtime values use `data-u-bind` and carry
no key.

**At import (localization writer).**

- Writes only this screen's keys: English source and Turkish entry. Keys are exact and case-sensitive; an existing key
  with the same English is reused, and only a missing Turkish entry of it is added.
- Never overwrites an existing different value. Conflicts are reported and left for a human; nothing of a conflicting
  key is written.
- Saves only the touched table assets (asset-specific save; no project-wide save). Creating a collection can make
  Addressables save the whole project, so it is refused while any asset or open scene has unsaved changes.
- Other active locales fall back to English and are reported as "translation pending"; fallback is not counted as
  translated. Entries whose Smart flag differs from the profile's argument format are reported as warnings.
- New collections follow the profile's naming, Addressables labels and preload rules; their addresses stay Unity
  Localization's own (`<collection>_<locale>`), which it loads tables by.

**In Unity.**

- Text uses Unity Localization `LocalizedString` data binding in UXML, so language changes refresh text without
  reopening the screen. Smart String variables are set by the generated view.
- `LocaleFontController` sets the locale's font twin on the screen root (`-unity-font-definition` inherits) and
  sets `locale-*`, `rtl` and text-size classes.
- Arabic and bidirectional text use `-unity-text-generator: advanced`.
- RTL alignment follows the project rule supplied by the profile (for example: start-aligned text flips to the
  right; layout is not mirrored).
- Text-size options map to root classes whose scale values come from the project's existing setting.

**Verification per active locale.** No missing glyphs; no keys, enum names or debug text on screen; no overflow
beyond what the design allows; correct direction and alignment for RTL; live language switch with the screen
open updates text and font; every text-size option.

## 14. Performance rules

- All static styling in USS; no inline styles in generated UXML.
- Simple selectors (§8); state changes are class swaps; hidden states use `display: none` instead of destroying
  elements.
- Lists inside scroll areas are virtualized.
- Icons and gradients are vector; raster images use the UI Toolkit dynamic atlas settings from the profile.
- Keyframes never animate layout properties.
- The verification report records element count, time to first render, state-switch time and steady-state GC
  allocations per screen.

**Integration speed.** The loop from a revised design to the screen in the open Editor is part of the product:

- The compiler is incremental: it hashes every output and rewrites only files whose content changed; the view class
  is rewritten only when its text changes, so a style-only revision causes no script compilation or domain reload.
- Imports run in one asset-editing batch over the changed paths only, with no project-wide refresh or save.
- The MCP server keeps one warm Chromium and the parsed kit for its lifetime, skips export when the design and kit
  hashes are unchanged, and skips the Unity call when the IR hash is unchanged.
- Every tool result and report carries per-step timings. Budgets: lint and export of one screen at three viewports
  ≤ 15 s with a warm browser; an import through the Editor bridge without a view-class change ≤ 5 s.

## 15. Verification and acceptance

**Unity capture.** A verification entry point loads the compiled screen into a PanelSettings rendering to a
RenderTexture of the viewport size, fills it from `fixtures/sample-data.json` through the generated view, sets
each state, and produces hover/active/focus by dispatching real pointer and focus events, so the real
pseudo-class rules are exercised. It records the PNG, every element's `worldBound`, and text line information.
In a project whose Editor stays open it runs on an isolated copy of the project, never in the user's open Editor.

The route and setup measured in M0 (`docs/findings/m0.md`):

- **Entry.** An EditMode test (`UnityTest` driven by editor updates, public API only) in Unity batchmode; the
  request comes in environment variables. With the maintainer's clone tool:
  `scripts/unity-check.sh --warm --editmode "<capture test>" --wait` (a reused batch clone); elsewhere
  `-batchmode -runTests -testPlatform EditMode -testFilter <capture test>` on a copy of the project. Metal renders
  in batchmode; no window and no Play mode are needed.
- **Panel.** `UIDocument` with `PanelSettings`: the package's minimal `DesignUiRuntimeTheme` (functional defaults
  only, no Unity default theme), the same theme the game's design-screen PanelSettings uses, so verification and game
  share every inherited rule. Scale With Screen Size at the profile's
  reference resolution and match, `forceGammaRendering = true`, clear to a sentinel colour (pixels left in it mean
  "not covered"), `targetTexture` = an `R8G8B8A8_UNorm` RenderTexture with a `D24_UNorm_S8_UInt` depth-stencil. The
  document root is stretched to the panel (`position: absolute`, insets 0), which a theme would otherwise do.
- **Frames.** 10 editor updates after mounting, then the stretch and 10 more; 5 after each state change or pointer
  event. Transitions are disabled for static captures, as in the exporter.
- **Readback.** `ReadPixels` into a linear `RGBA32` texture or `AsyncGPUReadback`, written to the PNG unchanged; no
  colour conversion. Gamma-space blending on a UNorm target reproduces the browser's colours (ΔE2000 ≤ 0.72 with
  alpha); the default linear blending of a Linear project shifts alpha-blended colours by up to ΔE 22.
- **Pseudo-states.** One element per capture: `PointerMoveEvent` at the element centre (panel coordinates) sent to
  `panel.visualTree` gives `:hover`; a following `PointerDownEvent` gives `:active` (only on elements with a
  `Clickable`, see §5.3); `PointerUpEvent` and a move outside every element reset it.
- **Text lines.** `TextElement.selection.GetCursorPositionFromStringIndex(i)` for every index gives the lines, their
  break indices and widths; a line's baseline is its top plus `faceInfo.ascentLine × fontSize / faceInfo.pointSize`
  of the font twin. If that API is missing, the line count is `round(contentHeight / L)` (§5.3 text styles) and break
  positions are reported as not compared.

**Hidden elements.** A static job whose elements the design does not show in its own setup (a closed popup, a
collapsed row, a clipping drawer, a state's content) is captured in the context that shows them: a state or the
classes of the layers of its elements and their ancestors; an element only a later written-out repeat item shows (its
first item's markup hides it) is captured in that item (`item` on the job's applied items, `~<items>` in its name;
Unity applies it to the same written-out item of the sample data). The Unity capture applies each item's `$hidden`
through the visibility setter's path (`DesignView.SetVisible` on the owner the manifest names), so the items hide
what the golden's markup hides. A job no context shows has no golden: matrix.json
lists it under `hidden`, the export result and `design_ui_import` name it, and the comparison reports it, so the
verdict is **incomplete**, never a pass.

**Comparison.** `design-export compare` aligns Unity output with the goldens and writes one HTML report: side by
side, overlay slider, difference heatmap, per-element box deltas, locale checks and performance numbers. Its status is
`fail` when a capture fails or did not run, else `incomplete` when the design hides a job, else `pass`.

Thresholds (`tools/design-export/fidelity-thresholds.json`), calibrated in M0:

| Measure | Threshold | M0 evidence |
|---|---|---|
| Element boxes (`boxPx`) | ±1 px at every viewport | Layout ≤ 0.5 px (UI Toolkit snaps to whole pixels); text 0 px with kit text styles |
| Text (`baselinePx`) | Same line count and break positions; baseline ±1 px | Line counts equal; first-line baseline ≤ 0.5 px; later lines within half a pixel |
| Non-text color at sampled points (`deltaE2000`) | ΔE2000 ≤ 1 | ≤ 0.72 for opaque and alpha colours, ≤ 0.89 for gradients |
| SSIM, non-text, whole capture (`ssimNonText`) | ≥ 0.99 | Clean fixtures ≥ 0.99998; gradient banding lowers it to about 0.998 for a full-screen gradient. Too coarse for element-sized defects |
| SSIM, non-text, per element ≥ 16×16 px, over the element box joined with its baked-shadow rect (`ssimElement`) | ≥ 0.99 | Elements without defects ≥ 0.9956; a pill drawn as an ellipse 0.72, a missing glow 0.87, a missing hard shadow 0.955, a missing large soft shadow 0.985, a dashed border drawn solid 0.97 |
| Shadow band: mean colour of each baked shadow's band (shadow rect minus element box) | ΔE2000 ≤ 1 | Catches faint missing shadows that SSIM dilutes |
| Text ink colour per line (`textInkDeltaE`): median of the pixels that differ most from the line's background | ΔE2000 ≤ 3 | Initial value, to be calibrated by the fidelity suite |
| Text ink amount per line (`textInkRatio`, `textInkCoverage`): anti-aliasing-weighted ink pixels, Unity's relative to the design's | Between 0.76 × 0.85 and 1.15; with 3 or more lines in the capture also within ±15 % of the capture's median ratio | Initial values, to be calibrated by the fidelity suite. M0 captures (light Inter on dark, 12–48 px, standard generator): correct text 0.69–0.83 (UI Toolkit draws thinner stems), synthetic bold 1.18–1.23, regular instead of bold about 0.54. The median cancels the renderer, so a single wrong weight or size stands out |
| Animation samples (§11): every sample of every animation | Same thresholds as static captures | — |

Element SSIM and colour samples allow the ±1 px box tolerance: when an element's SSIM fails, each block may take its
best value with the Unity image offset by up to 1 px in x and y (a moved edge or a 1-px size change cannot fail it; a
missing shadow, another shape or a dashed border still does), and every colour sample is compared with the closest
Unity colour within 1 px. An element that carries its own text (a button, a badge) is measured with only its text lines
copied from the design, plus samples of its background, border and corner diagonals; elements that paint a background
but leave no sample point are reported as "not sampled".

SSIM is the mean over non-overlapping 8×8 blocks of BT.601 luma with `C1 = (0.01·255)²`, `C2 = (0.03·255)²`
(reference implementation: `spike/m0-metrics.ts`). For an element it is the mean over the blocks that overlap the
bounding box of its golden box and, when it has one, its baked-shadow rect from the IR's `shadow` field
(`x + offset.x`, `y + offset.y`, `w + offset.w`, `h + offset.h`: offset x/y is the shadow image's top-left relative to
the element's border box, offset w/h is the image size minus the element size). Glyph rasterization differences are
tolerated only inside text boxes: pixels inside text boxes (inflated by 2 px) are copied from the golden before the
SSIM is computed. Regions marked `data-u-external` are masked the same way. Limitation: SSIM is averaged over the
region, so small or faint defects are diluted; a missing 24 px soft shadow at 50 % black on a dark background still
scores 0.994, and a defect counts against the element that owns it rather than its larger ancestors.
A screen is **verified** only when every viewport × state × pseudo-state capture passes, and the locale checks
pass for every active locale. Pixel fidelity is measured in Turkish; other locales are checked structurally.

Verification is deterministic and can run as a regression test per screen. Where design sources and goldens are
stored is a profile setting (§21, D2).

## 16. Packaging, installation and tools

Repository `unity-ui-mcp` (public):

```
packages/com.unity.design-ui/        UPM package
  Runtime/   BreakpointController, LocaleFontController, KeyframePlayer, view helpers
  Editor/    compiler, font resolver + twin generator, localization writer, Unity verifier,
             DesignUiProfile asset, menu and batchmode entry points
  Tests/
tools/design-export/                 Node CLI: lint, export, compare, report
tools/design-ui-mcp/                 standalone MCP server (stdio; HTTP in M4) for any MCP client
design-kit/                          RULES.md, tokens template, components, font sync target
skills/unity-ui-mcp/                 /unity-ui-mcp skill for Claude Code, Codex and Cursor
samples/FidelityProject/             Unity 6.3 test project with the fidelity fixture screens
docs/
```

Install into a project:

1. Add the package by git URL in Package Manager.
2. Create a `DesignUiProfile` from the menu and fill project settings and adapters.
3. Run font sync; upload the generated kit to Claude as a design system.
4. Install the CLI (`npx design-export` or a global install); Playwright downloads its pinned Chromium once.

Shortcut: give any AI client the repository URL and ask it to add the repo as a skill for a Unity project. The
agent-facing `INSTALL.md` makes it clone the repo with git, ask for the Unity project path and
`designRoot`, show `scripts/setup.sh --dry-run`, and run `setup.sh` after the user agrees. `setup.sh` is idempotent
and does steps 1, 4 and the MCP and skill registration; it never commits or pushes.

**MCP server (`tools/design-ui-mcp`).** A standalone Node MCP server, independent of any Unity-side MCP
package, so every MCP client can use it. Transport: stdio (supported by Claude Code, Claude Desktop, Cursor and
Codex); streamable HTTP is added in M4. It is started per Unity project:
`npx design-ui-mcp --project <UnityProjectDir>` and reads `<UnityProjectDir>/design-ui.config.json`
(`designRoot`, `kitDir`, `profileAsset`, `unityRunner`).

| Tool | Does |
|---|---|
| `design_ui_rules` | Returns the kit's `RULES.md` (rendered from the kit's own files when the kit has none) with an index of its sections, so any AI producing HTML can follow the contract; an optional `section` returns one RULES.md section, or `json`: the same contract as one compact JSON (every rule with severity and fix, the allowed CSS in brief, text styles, fonts) (the Markdown is also exposed as an MCP resource) |
| `design_ui_list` | Lists screens under `designRoot` with status: new, design changed since import, imported, verified, failed; also reports the Unity connection (bridge found or not, project path) |
| `design_ui_lint` | Lints one design folder or ZIP; returns findings with rule id, element path and fix |
| `design_ui_import` | Exports the design (IR, goldens) and compiles it into the Unity project through the Unity runner |
| `design_ui_verify` | Captures in Unity, compares, returns verdict, report path and the top issues |
| `design_ui_status` | Detailed status of one screen: hashes, last import, last verdict, manual edits, pending translations |
| `design_ui_kit_sync` | Re-syncs fonts and settings from Unity into the kit and regenerates font twins |

**Unity runner.** The MCP server never embeds Unity logic; it calls the package's Editor entry points through a
configurable runner:

- `editor` (M1, default for import and kit sync): a small bridge in the package's Editor assembly. It listens on
  127.0.0.1 only, on a free port, and writes the port, a random token and the project path to
  `Library/DesignUi/bridge.json`; the server reads that file and sends the token with every request. The open
  Editor imports, compiles and refreshes in place, so the user sees the screen without a manual refresh. Work runs
  on the main thread, one request at a time. The bridge restarts after every domain reload, and the server waits
  until compilation finishes. When `editor` is preferred and no bridge answers for the configured project, the tool
  fails with that reason; it never falls back silently to another route.
- `command` (M1, used for capture and when no Editor is open, e.g. CI): command templates for import, capture and
  kit sync, e.g. Unity batchmode `-executeMethod DesignUi.Editor.DesignUiBatch.Import …` for import, the EditMode
  capture test of §15 for capture, or an isolated-clone tool. Verification captures always use this route, so the
  user's open Editor is never put into a capture or Play state.

Neither route needs a Unity-side MCP package.

The same operations stay available from the Editor menu and `-executeMethod` for CI and manual use.

**Design UI window (`Window/Design UI/Status`).** The bridge starts by itself when the Editor loads; no button is
needed to start it. The MCP server is started by the AI client, never from Unity, so the window has no "start
server" button. The window shows and controls the Unity side:

- Bridge: listening (127.0.0.1 and port), stopped, or restarting after a domain reload; an on/off switch stored per
  project in `UserSettings/DesignUi.json` (off = no listener and no `bridge.json`); a Restart button.
- Last request: time, operation (import, kit sync) and result.
- Project setup: profile asset (with Create Profile when missing), `design-ui.config.json` path, `designRoot`
  with an Open button, and the last report with an Open button.
- AI client setup: copy buttons for the Claude Code, Cursor, Codex and Claude Desktop snippets, filled with this
  project's path.
- Manual actions: Kit Sync and Import Screen…, the same operations the menu and the bridge run.

It is an Editor tool, not player-facing UI, so its labels are English and are not localized.

**Client setup** (documented in the README): Claude Code `claude mcp add design-ui -- npx design-ui-mcp --project
<dir>`; Cursor `.cursor/mcp.json`; Codex `~/.codex/config.toml` `[mcp_servers.design-ui]`; Claude Desktop
`claude_desktop_config.json`. Registration happens once per client and project; every later chat has the tools.

**Entry skill `/unity-ui-mcp`.** Installed once per machine into the Claude Code, Codex and Cursor skill folders
(one link per client skill folder). It is the chat entry point; it does not create the connection. When
invoked it checks that the MCP tools are present (otherwise it shows the setup for the current client), that the
bridge answers for the configured project, and that `designRoot` and the kit exist. It then reads
`design_ui_rules` and drives the loop: list → lint → import → verify → report. It never edits generated files and
sends design-side fixes back to the design tool.

**Project profile** holds: reference resolution and viewports, screen match mode, output folders, `designRoot`
(design sources, IR and goldens), font resolver, localization adapter (table per screen, naming, Addressables address/labels),
RTL alignment rule, text-size scales, uGUI coexistence (panel sort order, input priority), atlas settings.

## 17. Project profiles

Each consuming project keeps its own facts and choices outside this repository: its per-locale font mapping, String
Table layout and naming, RTL alignment rule, text-size scales, uGUI coexistence and repository rules. The core and
this spec stay free of project specifics; the profile asset (§16) carries the settings.

The first consumer is a Unity 6000.3 game project (URP, Linear color space, Unity Localization with 11 locales
including right-to-left and CJK languages). It sets the M2 localization scope and hosts the pilot screen.

## 18. Error handling

| Situation | Behavior |
|---|---|
| Lint error | Export stops; report lists rule id, element path, declaration and fix hint |
| Non-deterministic export (two runs differ) | Export fails; usually an unpinned font or animation not frozen |
| Font not resolvable for a locale | Font sync and import fail for that locale with the locale and font named |
| Missing glyph in a locale | Verification fails for that locale with the characters listed |
| Existing different translation | Not overwritten; listed as conflict; import completes with status "conflicts pending" |
| Generated file edited by hand | Import refuses to overwrite and lists files; `--discard-manual-edits` proceeds explicitly |
| `data-u-id` removed but used by presenter | Surfaces as a C# compile error after import |
| Unity capture unavailable (no GPU, Editor busy) | Verify reports "not run" with the reason; never reports a pass |
| Threshold exceeded | Verdict "fail" with the failing captures and elements; nothing is auto-adjusted |

## 19. Testing the pipeline itself

- Lint: fixture HTML per rule id, expected findings.
- Exporter: determinism test; IR JSON Schema validation; capture matrix completeness.
- Compiler: snapshot tests IR → UXML/USS/C#; generated C# compiles.
- Runtime helpers: EditMode tests for breakpoints, locale font/RTL/text-size classes, keyframe playback.
- Localization writer: tests on a temporary table collection, including conflict and no-overwrite cases.
- **Fidelity suite:** fixture screens in `samples/FidelityProject` exercising every allowed CSS feature, state,
  pseudo-state, repeat mode, animation and breakpoint; each must pass §15 thresholds. This is the regression net
  for every change to the pipeline.

## 20. Roadmap

| Milestone | Content | Done when |
|---|---|---|
| **M0 Spike** (throwaway code) | One representative screen; measure risks R1–R8 | Calibrated rules and thresholds written back into this spec |
| **M1 Static core** | Kit, lint, exporter, IR, compiler (states + pseudo-states), font twins, verifier, report, MCP server (stdio, `editor` bridge + `command` runner), `/unity-ui-mcp` skill | Installed in the first consumer project and connected; the user applies and verifies the pilot screen through `/unity-ui-mcp` |
| **M2 Localization and binding** | Localization writer, `LocalizedString` binding, locale fonts, RTL, text size, view generation, actions | All 11 locale checks pass on the pilot |
| **M3 Dynamic content and motion** | Repeat/ListView, transitions, keyframes | Lists and animated states pass §15 |
| **M4 Responsive and distribution** | Breakpoints, UPM release, MCP HTTP transport, client setup docs, first consumer pilot with a real presenter | Pilot works in game with real data, driven from at least two MCP clients |

The first implementation plan covers M0 and M1.

## 21. Open decisions and risks

Decisions (resolved by the user on 2026-11-12):

- **D1 Pilot screen:** Inbox.
- **D2 Design sources and goldens:** stored in a folder the user specifies, set as `designRoot` in the project
  profile (each screen under `<designRoot>/<screen-id>/`). Never inside the product repository by default.
- **D3 Package id:** `com.unity.design-ui`; C# root namespace `DesignUi`. Note: the `com.unity.` prefix is used by
  Unity's own packages; a future official package with the same id would conflict.
- **D4 GitHub repository:** `unity-ui-mcp` under the user's account; public since 2026-11-12, with project-specific
  notes kept outside the repository.

Risks measured in M0 (results and evidence in `docs/findings/m0.md`):

- **R1** Chromium flexbox vs UI Toolkit layout engine differences (flex-basis, min-size, percentages in auto
  parents, absolute children in flex). Differences become lint rules or compiler lowerings.
  **Resolved (see findings):** parity within 0.5 px; new lint rules U-CSS-018 (baseline alignment), U-CSS-019
  (automatic minimum size), U-CSS-020 (elliptical radii), U-CSS-021 (non-solid borders), U-CSS-022 (gradient stops
  closer than the 64-step ramp); radii resolved at export.
- **R2** No `line-height` in USS. Options: kit text styles pin line-height to the font twin's metrics, or the twin
  generator produces line-spacing variants. Choose by measurement.
  **Resolved (see findings):** the font twins carry CSS's line box (`lineHeight = r × pointSize`, r 1.25 or 4/3, font
  sizes and line heights in multiples of 4 px), so heights are exactly `n × L` and baselines within 0.5 px at every
  declared viewport (§5.3 text styles, `design-kit/text-styles.json`). The fractional-size and exact-pitch rulings were superseded (findings
  O-13).
- **R3** Synthetic bold differs between Chromium and TextCore. **Resolved (see findings):** real faces only,
  checked by kit sync, with U-FONT-001 as the lint backstop for the reference locale (§6).
- **R4** Font twin metric parity (ascent, descent, line gap, sampling) with Chromium; dynamic twins under the
  advanced text generator. **Resolved (see findings):** `FontAsset.CreateFontAsset` with the TMP asset's sampling,
  padding, render mode and atlas size, dynamic; metrics equal; weight table mirrored; advances within 0.09 px.
- **R5** Capture route: RenderTexture capture from a PlayMode test on an isolated clone, including GPU availability.
  **Resolved (see findings):** an EditMode test in batchmode renders on Metal; no Play mode or window (§15).
- **R6** Pointer and focus event simulation for pseudo-states. **Resolved (see findings)** for `:hover` and
  `:active` (§15); `:active` needs a `Clickable` (§5.3). `:focus`, `:disabled` and `:checked` are checked in the M1
  fidelity suite.
- **R7** Reading text line breaks from UI Toolkit for comparison. **Resolved (see findings):** public caret
  positions plus the twin's ascent (§15).
- **R8** Color parity in a Linear-color-space URP project, including SVG gradient interpolation vs CSS gradients.
  **Resolved for verification (see findings):** UNorm target with `forceGammaRendering`, ΔE2000 ≤ 0.72; SVG
  gradients as `SVGType.VectorImage` match within 0.83. In-game colour moves to R9.

Risks open after M0:

- **R9** In-game colour on screen in a URP, Linear project. M0 measured RenderTextures on the built-in pipeline only:
  gamma-space blending (`forceGammaRendering`) matches the design on a UNorm target and double-encodes on an sRGB
  target. Unity 6000.3 documents the flag as applicable only when a panel renders into a Render Texture with a
  compatible format such as `R8G8B8A8_UNORM`
  ([PanelSettings.forceGammaRendering](https://docs.unity.com/en-us/engine/6000.3/script-reference/unityengine/uielements/panelsettings/forcegammarendering)).
  Game panels without a UNorm target texture therefore keep it off, and their alpha-blended colours drift from the
  design (up to ΔE 22 on the closest measured setup). The pilot candidate is the documented route: the UI renders
  into a UNorm RenderTexture with the flag on and is composited over the camera's sRGB output by a custom shader.
  The pilot measures its colours and cost; texture sampling still interpolates in linear space there (9-slice
  shadows, gradient ramps).
- **R10** Viewports other than the reference. UI Toolkit rounds text sizes up to whole pixels; text styles with
  font sizes and line heights in multiples of 4 px keep both whole at scales 0.75 and 0.5 (kit build and kit sync refuse
  other tables), and rows of auto-width
  text accumulate the rounded-up widths (up to about 2 px per text at the reference). The M1 fidelity suite measures
  both at 1920×1080 and 1280×720.

## 22. Sources

- [Unity 6.3 USS properties reference](https://docs.unity.com/en-us/engine/6000.3/manual/uitoolkits/uielements/uie-uss/properties/reference)
- [Unity 6.3 built-in filters](https://docs.unity3d.com/Manual/ui-systems/built-in-filters.html)
- [Unity 6.3 UI Shader Graph](https://docs.unity3d.com/Manual/ui-systems/get-started-with-ui-shader-graph.html)
- [Unity 6.6 backdrop-filter](https://docs.unity3d.com/Manual/ui-systems/backdrop-filter.html)
- [Vector Graphics 3.0 (SVG in core since 6.3)](https://docs.unity3d.com/Packages/com.unity.vectorgraphics@3.0/manual/index.html)
- [UI Toolkit font asset](https://docs.unity3d.com/Manual/UIE-font-asset.html)
- [Unity 6.5 static font asset migration (advanced text generator)](https://docs.unity3d.com/6000.5/Documentation/Manual/ui-systems/migrate-static-font-assets.html)
