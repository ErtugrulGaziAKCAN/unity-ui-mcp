# Design-to-UI Toolkit pipeline (unity-ui-mcp) — design spec

| | |
|---|---|
| Date | 2026-11-12; updated 2026-11-14 to what version 0.1.0 ships |
| Status | Implemented in 0.1.0: M0, M1 and most of M2 and M3 (§20). Where something is designed but not built yet, the section says so |
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
  design-export compare → verdict and HTML report (design, Unity, overlay, difference, per-element issues)
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
| Runtime helpers | Screen root, generated-view support, repeat helpers, locale/RTL/text-size classes, animation player, uGUI host region | UI Toolkit |
| Unity verifier (Editor, EditMode test) | Renders a screen with fixtures and records boxes and pixels | Compiler output |
| `design-export compare` | Applies thresholds, writes the report | Goldens, Unity capture |
| Project profile | All project-specific settings and adapters | — |
| `design-ui-mcp` server | Client-agnostic MCP front door: rules, list, lint, import, verify, status, kit sync | Exporter, compare, Unity runner |
| Editor bridge | Loopback endpoint inside the open Editor; runs import and kit sync in place | Editor entry points |
| `/unity-ui-mcp` skill | Chat entry point: checks server, bridge, `designRoot` and kit, then drives the loop | MCP server |
| Menu / batch entry points | Thin wrappers over the same Editor API, used by the Unity runner | Above |

## 5. Design contract

### 5.1 Design kit

The kit is published to Claude as a Design System (§5.5). It contains:

- `tokens.css`: colors, spacing, radii, shadows and font families as CSS custom properties. This file is the single
  token source: the exporter records the tokens a design uses in the IR, and the compiler emits them as
  `DesignTokens.uss`.
- `text-styles.json`: the kit text styles (§5.3); `base.css`, the base stylesheet every screen starts with, is generated
  from it.
- `fonts/`: font files and `@font-face` rules produced by font sync (§6). Designs may not declare other fonts.
- `kit.config.json`: reference size, viewports with their class (exact or scaled, §12), screen match, locales, the
  enabled `filter` functions.
- Component library (`components/`): button, toggle, text field, dropdown, tabs, card, list row, scroll area and
  dialog, each a lint-clean screen with its guidelines, compiled to Unity controls (§10).
- `RULES.md`: the contract below, written for Claude Design, with allowed patterns, every lint rule with its fix and an
  example. It is generated by `design-export kit build` from the kit and the lint's own data.
- `fixtures/fidelity/`: one screen per feature group for the fidelity suite (§19).

### 5.2 Markup attributes

| Attribute | Meaning | Required |
|---|---|---|
| `data-u-screen` | Screen id on the root, e.g. `club.overview` | Yes, once |
| `data-u-id` | Stable element name exposed to code | On every interactive or bound element |
| `data-l10n` | Localization key, meaningful English, e.g. `club.overview.title` | On every visible static text |
| `data-en` | English source text for that key | With `data-l10n` |
| `data-u-arg` | On a `<span>` inside localized text: a Smart String argument with sample text; `data-en` writes it as `{name}` | When the text has variables |
| `data-l10n-args` | Smart String argument names, e.g. `amount,currency` | Optional |
| `data-l10n-<attr>`, `data-en-<attr>` | Key and English text of `placeholder`, `title`, `alt`, `aria-label` | When such an attribute has text |
| `data-u-bind` | Dynamic, non-translated value (player name, number) | For runtime values |
| `data-u-action` | Command raised on activation, e.g. `open-inbox` | On actionable elements |
| `data-u-repeat` | Repeated item template, e.g. `players` | On the first sample item |
| `data-u-repeat-mode` | `list` (virtualized, default inside scroll) or `inline` | Optional |
| `data-u-state` | Screen state variant, e.g. `loading`, `empty`, `error` | On state roots |
| `data-u-external` | Region drawn by the host (e.g. an existing uGUI shell); excluded from compilation and masked in comparison | Optional |

Visible reference-locale text (Turkish in the kit) is the element's text content. Ids, actions, binds, repeat and
state names are lowercase ASCII (`^[a-z0-9]+([._-][a-z0-9]+)*$`) and must give a C# member name (U-MRK-005, checked
against `contracts/member-names.json`); localization keys are ASCII in any letter case, spelled exactly as the String
Table key. Elements without `data-u-id` receive structural names (e.g. `header__0__1`); code never references them, so
renaming them breaks nothing.

### 5.3 CSS to UI Toolkit mapping

Checked against the Unity 6.3 USS property reference. The M0 measurements (`docs/findings/m0.md`) calibrated the
rows that cite them, and the fidelity suite (§19) checks every row against Chromium at three viewports. Items marked
*no fixture* are allowed by the reference and lint but no fidelity fixture exercises them yet (findings O-15).

| CSS | UI Toolkit | Rule |
|---|---|---|
| flex layout, `%`, `px`, `auto`, min/max sizes, margin, padding, `position: absolute`, top/right/bottom/left, overflow, border widths/colors, `rotate`/`scale`/`translate`/`transform-origin`, `aspect-ratio`, `text-shadow`, `white-space`, `text-overflow`, `visibility`, `font-style: italic` (with a real face), background geometry; `letter-spacing` and `word-spacing` converted to hundredths of an em | Direct USS | Allowed; every accepted value has a fidelity fixture (`docs/findings/measured-css.md`), and lint rejects what did not match (`flex-wrap: wrap-reverse`, `background-repeat: space/round`, `overflow-wrap: break-word/anywhere`, U-CSS-045). UI Toolkit lays paddings, margins (gaps compile into margins) and border widths out as whole device pixels, halves up, so lint holds paddings, margins and gaps to the device grid at every exact viewport (U-CSS-046; borders U-CSS-040); offsets, translations, widths and heights are laid out as given (`docs/findings/viewport-classes.md`). M0 parity was measured with UI Toolkit's initial values mirrored in the HTML (column flex, `position: relative`, `flex-shrink: 1`, `border-box`, `align-content: flex-start`); where a CSS initial value differs, the compiler must write it explicitly or lint must reject it (findings O-6) |
| `filter` | USS built-in filter functions | Only the functions `css-support.json` enables, each once its fidelity fixture passes in Unity (U-CSS-015; `kit.config.json` `filterFunctions` mirrors the list). 0.1.0 enables `invert` (`docs/findings/filters.md`) |
| `opacity` | Direct USS | Below 1, or faded, only on elements whose parts do not overlap (U-CSS-039): CSS fades the composited group, UI Toolkit each part (`docs/findings/opacity.md`); use the kit's `--color-disabled-*` colours instead |
| Border widths, hard shadow edges, painted lines under 8 px | Direct USS, baked shadows | On the device grid at every exact viewport (U-CSS-040): UI Toolkit rounds a fractional border differently from Chromium (`docs/findings/borders.md`); scaled viewports are exempt (§12) |
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
| `@keyframes` / `animation` | Not in USS → animation data as USS custom properties, played by the runtime animation player (§11) | Only transforms, `opacity`, colours and border radii (U-CSS-013); never a layout property: a size or position change is a `translate` or `scale` |
| Inline emphasis inside a paragraph | TextCore rich text tags | Only `b`, `i`, `color`, `size` |
| `rem` | Resolved to px at export | Allowed |
| Transitions and easing | Recorded in the IR and played by the animation player (§11), never emitted as USS transitions, so nothing animates twice | The timing keywords, `cubic-bezier()` (x within 0–1) and `steps()`; a `linear()` easing with points is U-CSS-008. The same properties as keyframes (U-CSS-042); one property of an element is animated by keyframes or by a transition, not both (U-CSS-043) |
| `display: grid`, `::before`/`::after`, `:nth-child` and structural pseudo-classes, a `z-index` the sibling order cannot follow (U-CSS-004), `calc()`, `vw`/`vh`, `backdrop-filter`, `linear()` easings with points, `inline`/`inline-block` text flow, `font-family` outside the kit, `box-sizing: content-box` on a sized element with padding or border (U-CSS-036), an absolute element in a static parent (U-CSS-035) | No equivalent | **Lint error** |
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
ascent and descent, for the kit's ratios, `r = 1.25` (subtitle 32/40, headline 48/60, display 64/80 px, font size / line
height), `r = 4/3` (body 24/32, title 36/48 px), and at the readable-text floor's smallest size `r = 1.2` (label 20/24) and
`r = 1.4` (caption 20/28), each the multiple of 4 nearest the role's own ratio. Font sizes and line heights are
multiples of 4 px, so both stay whole device pixels at the 0.75 and 0.5 viewport scales too: `P = L`, a text block is
exactly `n × L` tall with baselines within 0.5 px, and texts stacked in a column add up without drift (a fractional line
height would be ceiled per text). The kit ships Inter Regular and Bold in these six sizes (seven roles); the table is generated from
the ratios by `tools/design-export/src/kit/textStyles.ts`. No text may draw below 9 device px at a declared viewport
(the readable-text floor, `TEXT_FLOOR_PX`: 18 px design text with the default viewports): kit build refuses a text style
below it and lint U-FONT-004 names each text below it, with the scale its transforms keep it at. `design-export kit build` and kit sync refuse a table
whose font size or line height is not a whole number of device pixels at the scale of any exact viewport (scaled
viewports, §12, are exempt: the screen lays out at an exact scale there), and kit
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
font weight with no real face in a non-reference locale's font). `design-kit/RULES.md` lists every rule with its fix;
the MCP tool `design_ui_rules` serves it.

Lint is a whitelist. Which CSS properties, keywords, units and value functions the pipeline handles, and how
(direct, lowered, dropped or rejected with a rule id and fix), is recorded once in
`packages/com.ertugrulgaziakcan.design-ui/Editor/Data/css-support.json`; the exporter's lint
(`tools/design-export/src/lint/allowed-css.ts` loads it) and the Unity style mapper both read it, so a property the mapper
cannot reproduce can never pass lint.
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
source file, matching sampling point size, padding and render mode, and reproducing the fallback order
and weight table. Its atlas pages are sized to the glyphs it holds (the smallest power-of-two page of at least 1024 px,
never larger than the TMP asset's atlas), and it keeps the kerning pairs and mark records of its own glyphs only. Twins are always **dynamic**, because the advanced text generator (needed for Arabic shaping and
bidirectional text) does not accept static font assets. Twins regenerate when TMP Settings or the per-locale mapping
change. The project keeps one font configuration: its TMP setup. Each twin has one variant per text-style size whose face
carries that style's CSS line box (`faceInfo.lineHeight = r × pointSize`, r 1.25 or 4/3, §5.3 text styles) with the
ascent line where Chromium lays out the baseline: `floor((L − round(a·s) − round(d·s)) / 2) + round(a·s)` CSS px below
the line top, the font's ascent and descent rounded at the font size (docs/findings/text-baselines.md). A variant's file
holds only that face and its settings: the loaded variant shares its twin's glyphs, font features, atlas pages and
material (`FontTwinLink`; the compiled font set links them when a screen loads), so a face has one atlas whatever the
number of text styles. Kit sync and every import delete the twins of faces, line boxes and fonts that no profile sharing
the twin folder uses any more (docs/findings/font-twin-footprint.md).

**Kerning.** A dynamic twin adds a glyph the moment text first needs it, but that glyph's kerning pairs only in its
update queue, after the text was laid out, and UI Toolkit keeps that unkerned first layout (up to 46 px wider on a
33-character line, standard text generator). Import therefore adds every character of the screen's strings, with their
font features (kerning pairs, mark positioning, ligatures), to each locale's twins (the plain twin, which its line-box
variants share, its weight faces and fallbacks) before anything is laid out. Text that import cannot know (bound values,
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
   `data-u-state` × each `is-*` class layer × each pseudo-state used by the design (forced through CDP
   `CSS.forcePseudoState`), capture a golden PNG, every element's box, and every text node's line boxes (to compare
   line breaks), plus each animation's samples (§11). A job whose elements the design does not show in its own setup
   is captured in the context that shows them (§15, hidden elements).
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
<designRoot>/<screen-id>/.design-ui/export/
  screen.ir.json
  goldens/<capture>.png        e.g. default@1920x1080.is-open.menu.hover.option, default@1920x1080.hover.row-flag~2
  goldens/boxes.json           every element's box and text lines per capture
  goldens/matrix.json          the jobs: names, applied state/classes/items, context, hidden jobs, animation samples
  assets/                      baked shadows, gradients, images, icons (named by content hash)
  fixtures/sample-data.json    bound values, repeat items with their classes, states and hiding
  lint-report.json
  export-report.json           source, kit and tool hashes; an unchanged design is not exported again
```

IR outline (`irVersion: 1`, validated with a JSON Schema shipped in the repo):

```json
{
  "irVersion": 1,
  "screen": "club.overview",
  "source": { "path": "club-overview.html", "sha256": "…" },
  "referenceViewport": [2560, 1440],
  "viewports": [[2560, 1440], [1920, 1080], [1280, 720], [3840, 2160], [1600, 900], [1366, 768]],
  "scaledViewports": [[1600, 900], [1366, 768]],
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
| `<Screen>.uxml` | Element tree under the screen root `dui:DesignScreen` (`xmlns:dui="DesignUi"`, which references the shared font set and carries the reference locale's class); every element has a `name` (`data-u-id` or its structural name) so verification can compare every box; only `data-u-id` elements are exposed by the view; no inline styles; localized texts carry `LocalizedString` bindings instead of text (§13) |
| `<Repeat>Item.uxml` | The item template of each `data-u-repeat`, declared in the screen UXML |
| `<Screen>.uss` | Deduplicated style classes; pseudo-class, state, class and breakpoint rules; the RTL and text-size rules (§13); animation data as USS custom properties (`--dui-t-*`, `--dui-a`, `--dui-k-*`, §11) |
| `DesignTokens.uss` (shared) | Tokens as USS custom properties |
| `DesignFonts.uss`, `DesignFonts.asset` (shared) | The font variables per locale (`.locale-<code>`) and the font set: every locale's font twins, line-box variants and text-size steps (§6) |
| `assets/` | VectorImages (icons, gradients), 9-slice shadow sprites with `-unity-slice-*`, images with UI import settings |
| `<Screen>View.g.cs` | Generated view class (§9) |
| `.design-ui.json` | Source, IR and generator hashes, output file hashes, the font faces the screen uses, its repeat templates and visibility owners |

The font twins themselves go to the profile's `fontTwinFolder`. The generated view's assembly must reference
`DesignUi.Runtime`: in Assembly-CSharp this is automatic; under an assembly definition the compiler stops with an error
that names the asmdef to change.

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

`<Screen>View.g.cs` (namespace from the profile) is the only code a game touches. For a screen `club.overview` with a
bound name, a Smart String argument, an action, a state, a repeat and a per-item hidden badge it looks like this:

```csharp
public sealed partial class ClubOverviewView
{
    public enum State { Default, Loading }
    public ClubOverviewView(VisualElement root);            // finds every element once, wires actions and mirrors
    public VisualElement Root { get; }
    public Label ClubName { get; }                          // every data-u-id element, typed by its control
    public void SetClubName(string value);                  // data-u-bind="club-name"
    public void SetBudget(string value);                    // {budget} inside a localized text (data-u-arg)
    public void SetCrest(Background value);                 // a bound image
    public event Action OpenInboxRequested;                 // data-u-action="open-inbox"
    public void SetState(State state);                      // data-u-state roots, .state-<name> on the screen root
    public void SetSelected(VisualElement element, bool selected);         // .is-selected
    public void SetClass(VisualElement element, string className, bool on); // any is-* class of the design
    public void SetEnabled(VisualElement element, bool enabled);           // the design's :disabled layers
    public void SetPlayer(int count, Action<PlayerItemView, int> bind);    // data-u-repeat="player"

    public sealed partial class PlayerItemView : DesignUi.IDesignRepeatItem
    {
        public int Index { get; }
        public void SetPlayerName(string value);
        public void SetBadgeVisible(bool visible);          // hidden by markup in some sample items
        public event Action OpenPlayerRequested;            // events are cleared before each bind
    }
}
```

- **Values.** One `Set<Name>(string)` per value name: every `data-u-bind` of that name (a label's or button's text, a
  toggle's label, a text field's or dropdown's value, written without a change event) and every Smart String argument
  `{name}`. An image bind is `Set<Name>(Background)` on the element that paints it. Setters compare with the value they
  wrote (inputs with the value they show), return before any write when it is unchanged and allocate nothing in steady
  state. Text setters assign through `DesignText.SetText`, so new characters are kerned from their first layout (§6).
  Bound and argument texts never read their value as rich-text tags.
- **Actions.** `event Action <Action>Requested` per `data-u-action` (the suffix keeps an action from clashing with the
  element property of the same id, e.g. `play`/`play`). A `Button` raises it from `clicked`, any other element from a
  `ClickEvent`. A `data-u-action` inside another is a lint error (U-MRK-012).
- **States and classes.** `SetState` swaps the `.state-<name>` class on the screen root. `SetSelected`, `SetClass` and
  `SetEnabled` also update the shadow hosts that mirror an element's classes and pseudo-states (baked inset shadows).
- **Repeats.** `Set<Repeat>(int count, Action<<Repeat>ItemView, int> bind)`: a list repeat is a virtualized `ListView`
  (the bind runs for each item it shows, also while scrolling; dynamic height when items are not one fixed height), an
  inline repeat a pooled set of items cloned from `<Repeat>Item.uxml`. Item views are nested classes; their events are
  cleared before each bind, so the bind subscribes them. Repeats nest.
- **Per-item visibility.** An element whose hiding is sample data (`itemVisibility`, §7) gets
  `Set<Id>Visible(bool visible)` on its item view.
  The item is compiled shown; hiding writes an inline `display: none` through `DesignView.SetVisible` on the element
  that owns its visibility (itself, or its shadow host), showing removes it so the style layers decide again. The
  element needs a `data-u-id` (lint U-MRK-003); the manifest lists each such element with that owner (`visibility`).
  An item root never gets one (the repeat owns its display; the compiler refuses it). The capture fails, asking for a
  new import, when the sample data hides an element the manifest gives no owner or whose owner the item lacks.
- Names that would clash with a member the view already has (`state`, `set-state`, `find`, `screen-root`, …) fail lint (U-MRK-011)
  and the compiler. One view per cloned tree.
- The project writes a presenter that calls the view with real game data. The generator never writes or edits
  presenters.
- Removing a `data-u-id` the presenter uses causes a C# compile error, so breakage is explicit.

## 10. Dynamic content, controls and interaction states

- `data-u-repeat`: the first sample item becomes a template (`PlayerItem.uxml` + `PlayerItemView` for `player`). Export checks
  that the other samples share its structure. Inside scroll areas it compiles to a virtualized `ListView`
  (fixed-height mode when items are uniform); `inline` mode uses a pooled repeat for small fixed lists.
- Kit components compile to Unity controls (`Button`, `Toggle`, `TextField` with placeholder, `DropdownField`,
  `ScrollView`, `ListView`), so focus, keyboard and gamepad navigation come from Unity. Compiled `ListView`s have
  `selection-type="None"`: selection is the design's `is-selected` class, set by the view.
- A later written-out sample item may leave a nested repeat empty (a day without events); the first item writes at
  least one, so the template is known. A written-out item hidden by its own markup is a lint error (U-MRK-013): the
  repeat alone shows and hides its items from the count.
- Pseudo-classes map one to one; custom states use `is-*` classes switched by the view.
- Text overflow follows the design (`ellipsis` or wrap); anything else counts as overflow in verification.

## 11. Animation

Animations follow the same rule as static styling: one-to-one, or rejected by lint with a fix. The measurements behind
this section are in `docs/findings/animation.md`.

- **Export.** Every transition (property, duration, delay, timing function) and every `@keyframes` use (offsets,
  values, per-segment timing function, iterations, direction, fill mode, play state, delay) is recorded in the IR with
  its trigger: `show` (the screen opens), `state:<name>`, `pseudo:<hover|active|focus|checked|disabled>` or
  `class:<is-*>`; `animation: none` in a layer is recorded too.
- **Compile.** The compiler writes each animated element's data as USS custom properties in the rules that set the
  animated values: `--dui-t-<property>: "<value>|<transition>"` in base and in every layer that sets the property,
  `--dui-a` (the animation list) in base and in every layer that triggers animations, `--dui-k-<n>` (keyframes) in base.
  UI Toolkit's own cascade then hands the player the data of the rule that wins, so every trigger (a state, an `is-*`
  class, a pseudo-state, a mirrored shadow host, a breakpoint class) reaches it the same way, in the style pass of that
  frame (`CustomStyleResolvedEvent`). Nothing is written as a USS transition, so nothing animates twice.
- **Runtime.** `DesignUiAnimationPlayer` plays them with an injectable clock; a compiled screen root attaches it by
  itself. It evaluates CSS timing exactly: the timing keywords as their `cubic-bezier()` definitions, any
  `cubic-bezier()`, and `steps()`. Transitions follow CSS Transitions: the value the element showed is written inline at
  once, animated to the new rule's value and handed back to the USS rule at the end; an interrupted transition that
  returns to its start runs back in the share it had covered (reversing shortening); negative delays start inside the
  transition; no transition on an element's first style or while it is not displayed. Keyframes follow Web Animations:
  iterations, direction, fill modes, negative delays, play state (pausing holds the frame) and per-keyframe easing; an
  animation a trigger layer starts in the markup (`is-open` on the artboard) shows its end frame, as the design's
  static frame does. Repeat helpers end a slot's animations when it shows another item (`Snap`), so a list item never
  transitions from the item it showed before. `ReducedMotion` (a game's accessibility setting) jumps transitions to
  their value and shows each keyframe animation's static frame.
- **Limits.** The player writes transforms (`translate`, `rotate`, `scale`), `opacity`, colours (text, background,
  border sides, an icon's tint) and border radii as inline styles, which UI Toolkit applies without a layout pass, and
  allocates nothing per frame in steady state. A layout property never animates: keyframes of one are U-CSS-013, a
  transition of one (or of any other property the player does not play, e.g. `letter-spacing`, `filter`,
  `text-shadow`) is U-CSS-042; the fix is `translate` or `scale`. A transition of `box-shadow` or `background-image` is
  U-CSS-014. Keyframes and a transition of the same property on one element are U-CSS-043. A fade (`opacity` through
  0–1) is allowed only on one-part elements (U-CSS-039).
- **Verification.** The exporter pauses animations through the CDP `Animation` domain and captures each animation at
  `delay` and at 0, ¼, ½, ¾ and 1 of its duration. The Unity verifier steps the player's clock to the same times.
  Every sample is compared with the static thresholds (§15); an element a sample shows rotated off the axes has its own
  SSIM limit (`ssimRotated`, measured: Chromium draws a running transform from its composited layer, resampled).

## 12. Responsive behavior

- PanelSettings: Scale With Screen Size, reference 2560×1440, screen match mode from the profile. One design px
  equals one reference px.
- The exporter reproduces that scaling: for a viewport W×H it renders the page at the panel's logical size
  (W/scale × H/scale) with `deviceScaleFactor = scale`, using Unity's own formula
  (`PanelSettings.ResolveScale`, 6000.3: `scale = lerp(W/refW, H/refH, match)`, a linear blend, no rounding). It equals
  the UGUI CanvasScaler log formula `2^lerp(log2(W/refW), log2(H/refH), match)` only at the reference aspect (16:9);
  e.g. 2400×1440 at match 0.5 is 0.96875, not 0.96825. Boxes are compared in device pixels.
- `@media` rules (min/max width and aspect ratio only, U-CSS-012) become breakpoint layers, written as rules under
  `.bp-<name>` on the screen root. The compiler writes the breakpoints on the root (`DesignScreen`, UXML attribute
  `breakpoints`), and the root sets the `.bp-*` classes of those that hold at its panel's logical size (rounded to whole
  px, the exporter's rule, `DesignBreakpoints`) on attach and whenever the screen root or the panel's root changes
  geometry, so a resized window or a changed panel scale switches them in the game. The verifier's capture relies on
  that and checks the root applied the breakpoints the exporter recorded for the viewport.
- Every declared viewport is compiled from the same IR and verified separately.
- **Viewport classes.** `kit.config.json` `viewports` lists each declared viewport as `[w, h]` (class `exact`, the form
  older kits use) or `{ "size": [w, h], "class": "exact" | "scaled" }`; the profile mirrors it (Viewports: exact, Scaled
  Viewports: scaled) and kit sync writes the profile's. The IR carries `viewports` (both classes) and `scaledViewports`.
  - *exact*: every kit value (text sizes, line heights, borders, hard shadow edges, painted lines) is a whole number of
    device pixels there. Kit build, kit sync, lint (U-CSS-040, the text-style table check, coverage viewports on the
    exact scales' step) and the text-size step notes judge the exact viewports only. Default: 3840×2160 (1.5),
    2560×1440, 1920×1080 (0.75), 1280×720 (0.5).
  - *scaled*: supported, laid out and verified, but exempt from the whole-device-pixel rules, since no design value can
    be whole there (1366×768 is 0.53346). Default: 1600×900 (0.625), 1366×768. Verify holds them to the same thresholds:
    boxes, baselines and line extents within ±1 device px plus `GEOMETRY_EPS`; a measured scaled-class limit for colour,
    ink or SSIM may be recorded under `fidelity-thresholds.json` `scaled` (never the geometry limits). Recorded: the
    anti-aliasing the root scale draws at the layout scale's pixel, with per-capture evidence: `ssimRoundEdge` 0.974 for an element whose SSIM with
    the edge band of its round shapes masked (1 device px either side of a corner's outer curve and its border's inner
    curve, of its own round shapes and its descendants') meets `ssimElement` and whose other checks pass, and
    `deltaE2000RoundEdge` 5.5 for a corner sample of an element that carries text whose window reaches that band and whose
    pixels outside it (at least 3 at one offset) meet `deltaE2000` (both off at exact viewports, where the file's own values
    must be). Also scaled-only, with the same kind of
    evidence: `ssimFractionalEdge` 0.97 (an element whose straight edges, its box's and its border's inner edges, fall
    between device pixels: those edges' band, the pixels within 1 device px of the edge in the design and in Unity, added),
    `ssimVectorEdge` 0.975 (a vector picture: the band of its drawn edges in the design, at least half its region left
    compared) and `deltaE2000FractionalEdge` 5.3 (a corner sample reaching such straight edges, its pixels outside them and
    the round-edge band matching). At every viewport (decision D-119) `ssimRoundEdge` 0.974 also applies to a round element
    without text (evidence: the ring's colour within `deltaE2000Ring` at an exact viewport) and, in an animation sample, to
    an element moved to a fractional device offset (its moved straight edges' band added; the ring's colour is not
    evidence there). Every such relaxation needs evidence at the level of pixels (decisions D-129, D-130): outside its band
    every 8 px SSIM block meets `ssimElement` and every 3×3 window is within `deltaE2000` of Unity's closest within 1 px,
    and every border the band masks (the element's, a descendant's, a repeat's later item's, rectangular ones too) keeps
    the design's drawn width within 0.5 device px and, in static captures, its centre colour within `deltaE2000Ring` (the
    file's own; a side under 2 device px gives no evidence). A round element without text also fails a static capture
    whose ring is drawn more than 0.5 device px wider or thinner (decision D-127). The boxes' `items` (both sides) hold the
    boxes of a repeat's later items, whose straight edges the band takes (decision D-124). Scaled-only measured keys for
    resampling and small text: `ssimResampledPicture` 0.95 and `deltaE2000ResampledPicture` 5.89 for a raster picture
    drawn at another size than its own (decision D-125), and `textInkDeltaEFirstSmall` 5.89 for text under 13 device px
    (decision D-126, at most 6.5), and `ellipsisGraphemes` 1 (decision D-146): a line the design cuts with an ellipsis may keep
    one grapheme more or fewer in Unity, its end within that grapheme's advance plus `boxPx`, when it ends in the
    design's ellipsis glyph and starts within `boxPx`; that glyph is judged at every viewport (decision D-147: its column
    profile and ink amount against the design's). Verdicts, the
    report, `design_ui_verify` and the fidelity summary count captures per class.
  - *Root scale at any other panel scale.* UI Toolkit puts font sizes, paddings, margins and border widths on whole
    device pixels before layout and ceils text sizes, so a design lays out as designed only where its lengths are whole
    device pixels: at an exact viewport's scale. The compiler writes the exact viewports' panel scales on the screen root
    (`DesignScreen`, UXML attribute `exact-scales`) and a custom property on its type (`DesignScreen { --design-screen: 1 }`).
    On a runtime panel whose scale is none of them (a scaled viewport, or any resolution the profile does not declare),
    the root sets its PanelSettings' `scale` factor so the panel lays out at the next exact scale up
    (`DesignViewportScales.LayoutScale`, rule `Up`; 1600×900 and 1366×768 at 0.75, so the root scale is at most 1 and
    layout's rounding of each edge stays within half a device pixel) and draws itself scaled by actual / exact
    from its top-left corner (an inline transform and `flex-shrink: 0`). Every edge then lies where the
    design puts it at the actual scale (text is generated at the exact scale's whole size and drawn scaled; UI Toolkit
    does not set it again at the world scale). The root composes the root scale with the design's own transform of the
    root: the animation player's `translate`, `rotate` and `scale` of a `DesignScreen` go through it, and the compiler
    writes each of the root's transform declarations again as a custom property (`--dui-root-translate`, `-rotate`,
    `-scale`, `-origin`, the value as a string) that the root reads in every state and breakpoint; under a root scale `r`
    the inline transform is scale `r·S`, rotate `R`, translate `r·(t + c − R·S·c)` about the top-left corner (the design's
    translate `t`, rotate `R`, scale `S` about its origin `c`), unscaled only what the player plays. A screen inside a
    screen with exact scales is scaled with it, never again itself. The factor is the PanelSettings' own times exact / actual, kept per
    PanelSettings while a screen is on its panel and given back when the last one leaves; a factor the game writes
    meanwhile is kept as its own (only the last factor this wrote counts as its own: a game's factor equal to an earlier
    held one is the game's); a region's sort-order copy starts with the asset's own. In the Editor outside Play mode a
    factor is held only on PanelSettings no save writes (`HideFlags.DontSaveInEditor`, runtime copies such as the capture's
    and a region's); on an asset or a scene's own settings the screen lays out at the actual scale with no root scale
    (`DesignRootScalePanels.CanHold`), so no asset save, build, preset, copy or scene sees a held factor. In Play mode an
    `AssetModificationProcessor` gives a held PanelSettings asset its own factor for every save that writes it (an asset
    save, File > Save, the save after an Inspector edit, the save when the Editor quits) and holds it again from the next
    Editor update; an `IPreprocessBuildWithReport` gives every held factor back before a player build, with a warning (a
    Scriptable Build Pipeline or Addressables content build started in Play mode is not guarded; Unity's
    `BuildPipeline.BuildAssetBundles` refuses to run then; a preset or asset copy made while held carries the factor); each
    write keeps its (factor, own) pair, so an Undo or Redo of a snapshot taken while held restores that snapshot's own
    factor, also after a script reload (SessionState), only on the PanelSettings it touched (whose scale is no longer the
    one last written or seen) and only for a factor written since the settings' own last changed (a value the game or the
    user sets, seen every Editor update and at once for recorded Inspector edits, drops the earlier pairs); leaving Play, a script reload and quitting give every factor back. Game
    code's own inline transform on a screen root is overwritten. Screens with different exact scales on one PanelSettings lay out at the
    first's, with a warning. While a panel has no size for a moment the held root scale stays. The root re-evaluates on attach,
    on geometry changes of itself and the panel's root, and on `CustomStyleResolvedEvent` (UI Toolkit resolves every
    style again when a panel's scale changes, also from one 16:9 resolution to another), so no polling. Breakpoints hold
    at the design's size (the panel's target over the actual scale). Picking, pointer events (hover, active, clicks,
    wheel, drags in local coordinates), the gamma composite's texture and pointer mapping and `DesignUiPanelRegion`
    frames follow the transform (`RootScaleTests`). The capture is the game's path: its PanelSettings copy gets the same
    factor and `boxes.json` records the scale the panel lays out at. Measured: docs/findings/viewport-classes.md.
  - *Text widths.* The golden lays a text-sized box out with Chromium's text width ceiled to whole device pixels at the
    viewport's scale (the exporter's pageTextCeil; a 69.469 px text makes its button 70 px of content at 2560×1440, 105
    device px at 3840×2160); UI Toolkit ceils on the grid of the scale it lays out at and with no tolerance (a text of 86 px
    in the browser is 86.0100 in Unity and takes 87). A text or button node
    whose width is its content's (no width, min or max width, flex-basis in any layer; not grown in a row, not stretched
    in a column, not pinned by left and right; no animated size or text size) is written as `DesignLabel` or
    `DesignButton` (`dui:`), which set an inline width of the generator's unrounded width ceiled on the design's device
    grid less 0.012 device px (`DesignTextFit.Snap`; measured on the suite's 984 text-sized texts) plus horizontal padding
    and borders as the golden lays them out (with letter-spacing: the text without its last spacing ceiled, plus the
    spacing, the design's padding and the borders, rounded to whole device pixels), and `white-space: nowrap`
    (`pre` where the design keeps spaces). A text the design lets wrap keeps wrapping where its line has no room: in a
    row the width comes off when the row holds the element narrower than UI Toolkit's own width for the text (judged
    after a layout of it); in a column and for an absolute text (pinned by its left side; one pinned by its right side is
    fitted only when it cannot wrap), where layout never narrows an explicit width, a line longer than its room (the
    parent's content width less margins, or the padding box right of the text's left edge) gets that width with the
    design's white-space, the browser's fit-content box. A rule on their types (`--design-text-fit`) makes UI Toolkit tell
    them when their styles change, and they watch their parent's geometry; a measure is kept for the same text, font,
    size, spacing and scale (an inline colour sends a style event every frame and measures nothing).
- **Drift-free stacked text.** UI Toolkit ceils each text element's measured height to whole device pixels; where a line
  box is fractional (16/20 at 0.625: 12.5 px) a column of texts drifts by up to a pixel per text. The compiler gives a
  text whose line count the design fixes (no wrapping in any layer: `text-wrap-mode: nowrap`, `white-space: nowrap` or
  `pre`; its lines are its explicit breaks, the same count in the design's English and in every locale's translation the
  screen's String Table collection holds when it is compiled; not bound, no arguments) and whose height is its
  content's (no height, min or max height in any layer; not grown in a column, not stretched in a row, not pinned by top
  and bottom; no animated size, padding or border) an explicit `height` of `lines × line box + vertical padding and
  borders` in every layer that changes them, scaled by the text-size steps. The height is composed from several CSS
  properties, so two layers that hold together and set different parts get their union layer (as `CompleteUnions` does
  for the other composed properties), which writes the height of both. Wrapping text keeps its measured height (at most
  one device pixel over per element). A translation added later must keep the line count (or the screen is imported
  again).

## 13. Localization

**At design time (lint).** Every visible static text has `data-l10n` and `data-en` (U-MRK-004), attribute texts
`data-l10n-<attr>` and `data-en-<attr>` (U-MRK-007); keys are meaningful English, exact and case-sensitive, ASCII in any
letter case; each screen maps to a String Table collection through the profile; a variable inside a text is a
`<span data-u-arg="name">sample</span>` written `{name}` in `data-en` (U-MRK-008); runtime values use `data-u-bind`
and carry no key.

**At import (localization writer).**

- Writes only this screen's keys: the English source and the reference-locale entry (Turkish in the kit). Keys are
  exact and case-sensitive; an existing key with the same English is reused, and only a missing reference-locale entry
  of it is added.
- Never overwrites an existing different value. Conflicts are reported and left for a human; nothing of a conflicting
  key is written.
- Saves only the touched table assets (asset-specific save; no project-wide save). Creating a collection can make
  Addressables save the whole project, so it is refused while any asset or open scene has unsaved changes.
- Other active locales fall back to English and are reported as "translation pending"; fallback is not counted as
  translated. Entries whose Smart flag differs from the profile's argument format are reported as warnings.
- New collections follow the profile's naming, Addressables labels and preload rules; their addresses stay Unity
  Localization's own (`<collection>_<locale>`), which it loads tables by. Creating a collection needs Addressables
  settings in the project.
- The profile's argument format is `SmartString` (`{name}`) or `Indexed` (`{0}` in the view's argument order, for
  tables that use `string.Format`); the compiler converts the design's `{name}` accordingly.
- Localization is optional: with the profile's `localization.enabled` off (or without the Unity Localization package)
  screens keep the design's static text.

**In Unity.**

- Text binds through `DesignLocalizedString`, a `LocalizedString` subclass in the optional assembly
  `DesignUi.Runtime.Localization` (Unity Localization 1.5 or later), declared in the UXML's `<Bindings>`, so a language
  change refreshes text without reopening the screen. It follows the selected locale, loads entries asynchronously
  (`GetTableEntryAsync`, never a synchronous load), formats each entry by its own Smart flag and writes through
  `DesignText`, so new characters are kerned. A missing translation follows the project's fallback locale chain; an
  entry that fails to load or format falls back to the English entry, then to the design's English text. A key is never
  shown. Smart String variables are set by the generated view's value setters.
- `LocaleFontController` (run by the host region, §16) puts `locale-<code>`, `rtl` and `text-size-<key>` classes on its
  root and on every compiled screen root below it. Everything else is compiled USS: the font variables per locale
  (`DesignFonts.uss`), the RTL alignment rules and the text-size rules.
- Right-to-left and complex-script locales (Arabic and others, `localeRules` in the profile) use
  `-unity-text-generator: advanced` and `LanguageDirection.RTL` only while Unity's **Enable Advanced Text** setting is
  on; off or unknown, the locale keeps its `rtl` class with left-to-right direction and the controller reports that the
  locale needs the setting (the standard generator would reverse whole strings). Players also need ICU data on every
  PanelSettings they use (`docs/findings/advanced-text.md`).
- RTL alignment follows the profile's rule (`localeRules.rtlAlignment`: `StartToEnd` flips start-aligned text, `Mirror`
  mirrors left and right, `Keep`); the compiler writes it as `.rtl` twins of every text-align rule. Layout is never
  mirrored.
- Text sizes: the profile's `textSizes` (key and scale) become `.text-size-<key>` twins of every font-size rule with
  scaled line-box twins; a step that is not whole device pixels at a declared viewport is reported. The game gives its
  setting through `IDesignTextSizeSource`.

**Verification per active locale.** Pixel fidelity is measured in the reference locale: the capture shows the IR's
reference text with sample arguments, whatever the String Tables hold. The import reports per locale the characters a
locale's font lacks and the keys whose translation is pending. **Not in 0.1.0:** an automatic per-locale check (no keys,
enum names or debug text on screen, overflow, RTL direction and alignment, live language switch, every text-size
option); these are checked by the project for now.

## 14. Performance rules

- All static styling in USS; no inline styles in generated UXML.
- Simple selectors (§8); state changes are class swaps; hidden states use `display: none` instead of destroying
  elements.
- Lists inside scroll areas are virtualized.
- Icons and gradients are vector; raster images use the UI Toolkit dynamic atlas settings from the profile.
- Keyframes never animate layout properties.
- Generated setters, the locale controller's per-frame pass, the host region and the animation player allocate
  nothing in steady state (each has a test). **Not in 0.1.0:** element count, time to first render and state-switch
  time in the verification report; the report records the pipeline's step timings.

**Integration speed.** The loop from a revised design to the screen in the open Editor is part of the product:

- The compiler is incremental: it hashes every output and rewrites only files whose content changed; the view class
  is rewritten only when its text changes, so a style-only revision causes no script compilation or domain reload.
- Imports run in one asset-editing batch over the changed paths only, with no project-wide refresh or save.
- The MCP server keeps one warm Chromium and the parsed kit for its lifetime, skips export when the design and kit
  hashes are unchanged, and skips the Unity call when the IR, kit and profile hashes and the installed design-ui
  package (its locked git commit, registry version, or the hash of a local package's files) are unchanged.
- Every tool result and report carries per-step timings. Budgets: lint and export of one screen at three viewports
  ≤ 15 s with a warm browser; an import through the Editor bridge without a view-class change ≤ 5 s.

Measured on the sample project (macOS, Apple silicon, warm browser):

| Step | Measured |
|---|---|
| Lint of one screen | 133–304 ms (627 ms when the server starts its browser first) |
| Lint and export of one screen | 1.8 s (a kit component, three viewports); 3.9–4.3 s (a screen with a fourth, media-query viewport and animation samples) |
| Import through the bridge, no view-class change | 221 ms request (198 ms on the Editor's main thread); the whole `design_ui_import` with its export 4.5 s |
| Import through the bridge with a view-class change | 1.84–3.25 s Unity step (request plus script compile and domain reload) |
| Unity capture | 32.6 ms per job on average (471 jobs at three viewports in 15.4 s); the first job of a viewport mounts the screen (0.26 s) |
| Import with an 18-face font family | 1.7 s (glyphs only for the faces the text styles and the screen use) |

A large project's script reload takes longer than the sample project's.

## 15. Verification and acceptance

**Unity capture.** A verification entry point loads the compiled screen into a PanelSettings rendering to a
RenderTexture of the viewport size, fills it from `fixtures/sample-data.json` (each repeat item with its own classes,
disabled and checked states and hidden elements), sets each state and class, and produces hover/active/focus by
dispatching real pointer and focus events, so the real pseudo-class rules are exercised. It records the PNG, every
element's `worldBound`, and text line information. A localized screen is captured with the IR's reference text. In a
project whose Editor stays open it runs on an isolated copy of the project, never in the user's open Editor: the MCP
server runs it as a command (`unityRunner.captureVia: "command"`), and the package has no capture inside the open
Editor.

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
  event. Static captures hold every animation at the frame the design's static capture shows.
- **One mount per viewport.** A capture run mounts a viewport's screen once and moves it from job to job: state,
  classes, disabled and checked values, pointer, press, focus, picking modes and scroll offsets are given back after
  each job, and a job that leaves something behind (an overlay) makes the next job mount again (a fresh mount and a
  kept one give the same pixels, tested). PNGs are encoded off the main thread, at most 8 pending. `boxes.json` and
  `boxes.meta.json` are rewritten atomically every 25 jobs or 10 s, so a stopped run leaves what it captured;
  `capture-done.json`, written last, marks a finished run. The test's time limit is 120 s + 2 s per job.
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

**Comparison.** `design-export compare` aligns Unity output with the goldens and writes `verdict.json` and one
offline HTML report: per capture the design, the Unity capture, an overlay and a difference view with the elements that
have an issue outlined, and each issue; the timings, thresholds, captures that did not run, hidden jobs and animation
samples. Its status is `fail` when a capture fails or did not run, else `incomplete` when the design hides a job, else
`pass`.

Thresholds (`tools/design-export/fidelity-thresholds.json`; its `$comment` records where each value comes from):

| Measure | Threshold | Evidence |
|---|---|---|
| Element boxes (`boxPx`) | ±1 px at every viewport | M0: layout ≤ 0.5 px (UI Toolkit snaps to whole pixels); text 0 px with kit text styles |
| Text (`baselinePx`) | Same line count and break positions; baseline ±1 px | M0: line counts equal; first-line baseline ≤ 0.5 px; later lines within half a pixel |
| Non-text color at sampled points (`deltaE2000`) | ΔE2000 ≤ 1 | M0: ≤ 0.72 for opaque and alpha colours, ≤ 0.89 for gradients |
| SSIM, non-text, whole capture (`ssimNonText`) | ≥ 0.99 | M0: clean fixtures ≥ 0.99998; too coarse for element-sized defects |
| SSIM, non-text, per element ≥ 16×16 px, over the element box joined with its baked-shadow rect (`ssimElement`) | ≥ 0.99 | M0: elements without defects ≥ 0.9956; a pill drawn as an ellipse 0.72, a missing glow 0.87, a missing hard shadow 0.955, a dashed border drawn solid 0.97 |
| Element SSIM of elements under 32768 device px² (`ssimElementSmall`) and of scaled raster pictures (`ssimPicture`) | ≥ 0.984; ≥ 0.985 | Fidelity suite: elements whose other checks pass, lowest 0.9851 (bordered fields, radios, icons), pictures 0.9867 (`docs/findings/ssim-small-elements.md`) |
| Element SSIM of an animation sample rotated off the axes (`ssimRotated`) | ≥ 0.975 | Fidelity suite: 297 element samples, lowest 0.9779 (`docs/findings/animation.md`) |
| Shadow band: mean colour of each baked shadow's band (shadow rect minus element box) | ΔE2000 ≤ 1 | Catches faint missing shadows that SSIM dilutes |
| Text ink colour per line (`textInkDeltaE`, `textInkDeltaESmall`): median of the 10 % ink pixels most different from the line's background | ΔE2000 ≤ 2 from 9 device px font size, ≤ 3 from 8 px, ≤ 10 below | Fidelity suite, every kit text style in both polarities at three viewports: ≤ 1.26 from 9 px, 2.12 at 8 px, 8.23 at 6 px (`docs/findings/text-ink.md`) |
| Text ink amount per line (`textInkRatio`, `textInkCoverage`, `textInkMedianTolerance`): Unity's anti-aliasing-weighted ink relative to the design's | 0.9–1.1, and within ±15 % of the capture's median of the same polarity (3 or more lines) | Fidelity suite: 0.92–1.08, −5 % … +11.7 % of the median |
| Text of at most 12 device px, later lines of small text, text with a blurred shadow (`textInkSmallPx`, `textInkDeltaELater`, `textInkShadowHigh`, …) | Own limits, listed in the thresholds file | Fidelity suite (`docs/findings/text-ink.md` §7–8, `docs/findings/text-baselines.md`) |
| Text ink extent per line (`boxPx`): where the line's first and last glyphs sit and the width between them, from Unity's ink column profile near each end (an em) shifted to match the design's, each scaled to the design's amount | ±1 px (plus 0.001 px) whatever the text size | Fidelity suite: 26,202 measured text elements of 2343 captures, largest 0.79 px, 99 % ≤ 0.53 px; the outer ink edges alone differ by up to 2.03 px (bold 48 px strokes, a blurred text shadow), so they are not compared; a fixture moved 2 px fails |
| Animation samples (§11): every sample of every animation | Same thresholds as static captures (rotated elements: `ssimRotated`) | Fidelity suite: 1200 samples pass |

Element SSIM and colour samples allow the ±1 px box tolerance: when an element's SSIM fails, each block may take its
best value with the Unity image offset by up to 1 px in x and y (a moved edge or a 1-px size change cannot fail it; a
missing shadow, another shape or a dashed border still does), and every colour sample is compared with the closest
Unity colour within 1 px. An element that carries its own text (a button, a badge) is measured with only its text lines
copied from the design, plus samples of its background, border and corner diagonals; elements that paint a background
but leave no sample point are reported as "not sampled".

SSIM is the mean over non-overlapping 8×8 blocks of BT.601 luma with `C1 = (0.01·255)²`, `C2 = (0.03·255)²`
(implemented in `tools/design-export/src/compare/ssim.ts`, defined and calibrated in M0 findings §11). For an element it is the mean over the blocks that overlap the
bounding box of its golden box and, when it has one, its baked-shadow rect from the IR's `shadow` field
(`x + offset.x`, `y + offset.y`, `w + offset.w`, `h + offset.h`: offset x/y is the shadow image's top-left relative to
the element's border box, offset w/h is the image size minus the element size). Glyph rasterization differences are
tolerated only inside text boxes: pixels inside text boxes (inflated by 2 px) are copied from the golden before the
SSIM is computed. Regions marked `data-u-external` are masked the same way. Limitation: SSIM is averaged over the
region, so small or faint defects are diluted; a missing 24 px soft shadow at 50 % black on a dark background still
scores 0.994, and a defect counts against the element that owns it rather than its larger ancestors.
A screen is **verified** (verdict `pass`) only when every viewport × state × class × pseudo-state capture and every
animation sample passes and no job is hidden. Pixel fidelity is measured in the reference locale; the automatic locale
checks are not built yet (§13).

Verification is deterministic and can run as a regression test per screen. Where design sources and goldens are
stored is a profile setting (§21, D2).

## 16. Packaging, installation and tools

Repository `unity-ui-mcp` (public):

```
packages/com.ertugrulgaziakcan.design-ui/  UPM package
  Runtime/   DesignScreen, DesignView/DesignText, repeat helpers, LocaleFontController, animation player,
             DesignUiPanelRegion, optional Localization assembly (LocalizedString binding, locale source)
  Editor/    compiler, font resolver + twin generator, localization writer, Unity verifier, Editor bridge,
             DesignUiProfile asset, Design UI window, menu and batchmode entry points
  Tests/
tools/design-export/                 Node CLI: lint, export, compare, kit build, kit claude
tools/design-ui-mcp/                 standalone MCP server (stdio) for any MCP client
design-kit/                          RULES.md, tokens, text styles, base stylesheet, components, fidelity fixtures
contracts/                           shared verdict tables the Node and Unity tests both check
skills/unity-ui-mcp/                 /unity-ui-mcp skill for Claude Code, Codex and Cursor
scripts/                             setup, skill install, fidelity suite
samples/FidelityProject/             Unity 6000.3 test project the fidelity suite and the package tests run in
docs/spec/, docs/findings/, docs/guide/
```

Install into a project:

1. Build the MCP server from a clone (`npm ci`, `npm run build -w design-ui-mcp`; the tools are not on npm) and
   download Playwright's pinned Chromium once.
2. Add the package by git URL in Package Manager, write `design-ui.config.json` in the Unity project, and register the
   MCP server with the AI client.
3. Create the `DesignUiProfile` (`Window > Design UI > Status`, Create Profile) and fill the project settings: font
   resolver, localization, locale rules, text sizes, host settings.
4. Run kit sync; publish the kit to Claude as a Design System (`design-export kit claude`).

Shortcut: give any AI client the repository URL and ask it to install it for a Unity project. The agent-facing
`INSTALL.md` makes it clone the repo with git, ask for the Unity project path and `designRoot`, show
`scripts/setup.sh --dry-run`, and run `setup.sh` after the user agrees. `setup.sh` is idempotent and does steps 1 and 2
and the skill installation; it never commits or pushes.

**MCP server (`tools/design-ui-mcp`).** A standalone Node MCP server, independent of any Unity-side MCP
package, so every MCP client can use it. Transport: stdio (supported by Claude Code, Claude Desktop, Cursor and
Codex); streamable HTTP is planned for M4. It is started per Unity project:
`node <clone>/tools/design-ui-mcp/dist/server.js --project <UnityProjectDir>` and reads
`<UnityProjectDir>/design-ui.config.json` (`designRoot`, `kitDir`, `profileAsset`, `mcpServer`, `unityRunner` with
`prefer`, `captureVia`, `command` and `timeoutSec`). The server keeps one warm Chromium for its lifetime. A Unity step
waits up to `unityRunner.timeoutSec` (default 1800 s) and sends MCP progress notifications every 10 s to a client that
asks for them.

| Tool | Does |
|---|---|
| `design_ui_rules` | Returns the kit's `RULES.md` (rendered from the kit's own files when the kit has none) with an index of its sections, so any AI producing HTML can follow the contract; an optional `section` returns one RULES.md section, or `json`: the same contract as one compact JSON (every rule with severity and fix, the allowed CSS in brief, text styles, fonts) (the Markdown is also exposed as an MCP resource) |
| `design_ui_list` | Lists screens under `designRoot` with status: new, design changed since import, imported, verified, failed, incomplete; also reports the Unity connection (bridge found or not, project path) |
| `design_ui_lint` | Lints one design folder or ZIP; returns findings with rule id, element path and fix |
| `design_ui_import` | Exports the design (IR, goldens) and compiles it into the Unity project through the Unity runner; names hidden jobs and the compiler's notes; `discardManualEdits` overwrites hand edits explicitly |
| `design_ui_verify` | Captures in Unity, compares, returns the verdict (`pass`, `fail`, `incomplete`), report path and the top issues; a run without a verdict keeps its partial captures and logs in `<screen>/.design-ui/failed-<run>/` |
| `design_ui_status` | Without a screen: what this version supports and how each Unity step would run. With a screen: hashes, last import, last verdict |
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
- `command` (M1, used for capture and when no Editor is open, e.g. CI): command templates (argv, no shell) for
  import, capture and kit sync, with the placeholders `{projectDir}` `{profile}` `{exportDir}` `{outDir}` `{kitDir}`,
  also passed as `DESIGN_UI_*` environment variables; e.g. Unity batchmode
  `-executeMethod DesignUi.Editor.DesignUiBatch.Import …` for import, the EditMode capture test of §15 for capture, or
  an isolated-clone tool. Verification captures always use this route (`captureVia: "command"`; the package has no
  Editor capture), so the user's open Editor is never put into a capture or Play state.

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

**Client setup** (documented in the README): Claude Code `claude mcp add --scope local design-ui -- node
<clone>/tools/design-ui-mcp/dist/server.js --project <dir>`; Cursor `.cursor/mcp.json`; Codex `~/.codex/config.toml`
`[mcp_servers.design-ui]`; Claude Desktop `claude_desktop_config.json`. The Design UI window fills these snippets from
the config's `mcpServer`. Registration happens once per client and project; every later chat has the tools.

**Entry skill `/unity-ui-mcp`.** Installed once per machine into the Claude Code, Codex and Cursor skill folders
(one link per client skill folder). It is the chat entry point; it does not create the connection. When
invoked it checks that the MCP tools are present (otherwise it shows the setup for the current client), that the
bridge answers for the configured project, and that `designRoot` and the kit exist. It then reads
`design_ui_rules` and drives the loop: list → lint → import → verify → report. It fetches a Claude Design canvas when
the client has an Artifact tool, and on request publishes the kit as a Design System (`design-export kit claude`). It
never edits generated files and sends design-side fixes back to the design tool.

**Project profile** (`DesignUiProfile`) holds: `designRoot` and `kitDir`; output folders (`outputFolder`,
`fontTwinFolder`) and the generated namespace; reference resolution, viewports and screen match; reference locale and
locales; the font resolver (`fontResolver`, else `localeFonts` over TMP Settings, §6); texture compression; the
PanelSettings design screens render with; `host` (the panel's sort order and the screen's order on it);
`localeRules` (right-to-left and complex-script locales, RTL alignment); `textSizes`; `localization` (on or off,
English locale, argument format, collection per screen, rules for a new collection).

**Hosting in a uGUI game (`DesignUiPanelRegion`).** A component on a RectTransform of an existing uGUI shell: its
UIDocument's root takes the RectTransform's screen rect every frame (and after uGUI layout), the panel's sort order
and the screen's order on it come from the region's host settings (copied from the profile's `host` when the region is
added) through a shared runtime copy of the PanelSettings (the asset is never written), and it runs the locale
controller on its root. It reports `IsPointerOverPanel`, `EscapePressed`, focus
entered and left, and reads no input itself. When Unity re-creates the document's root (switching Enable Advanced Text
while documents exist), it binds the new root and raises `RootRebuilt`; the host recreates its view there. World-space
canvases are not supported.

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
| Font not resolvable for a locale | Font sync and import fail for that locale with the locale and font named; a throwing project resolver is named |
| Missing glyph | Lint fails characters the kit font lacks (U-FONT-003); the import lists, per locale, the characters a locale's font lacks |
| A font face a screen needs (weight, italic) is missing | Compile error naming the element, layer and face for the reference locale's font; a note for other locales |
| Existing different translation | Not overwritten; listed as conflict; nothing of that key is written |
| A new String Table collection while the project has unsaved changes | Refused with the unsaved assets and scenes named (creating it would save the whole project) |
| Generated file edited by hand | Import refuses to overwrite and lists files; `discardManualEdits` (MCP) or `-designUiDiscardManualEdits` (batch) proceeds explicitly |
| `data-u-id` removed but used by presenter | Surfaces as a C# compile error after import |
| Editor route preferred but the bridge does not answer | The tool fails with the reason (not found, not responding, unauthorized); no silent fallback to the command route |
| Unity capture failed, timed out or did not finish | Verify returns no verdict, with the reason; the partial captures, the capture's meta file and the Unity log stay in `<screen>/.design-ui/failed-<run>/` (newest three); never a pass |
| A job the design never shows | Listed as hidden by export, import and verify; the verdict is "incomplete", never a pass |
| Threshold exceeded | Verdict "fail" with the failing captures and elements; nothing is auto-adjusted |

## 19. Testing the pipeline itself

- Lint: fixture HTML per rule id, expected findings.
- Exporter: determinism test; IR JSON Schema validation; capture matrix completeness.
- Compiler: snapshot tests IR → UXML/USS/C#; generated C# compiles.
- Runtime helpers: EditMode tests for breakpoints, locale font/RTL/text-size classes, keyframe playback.
- Localization writer: tests on a temporary table collection, including conflict and no-overwrite cases.
- Determinism: the same input and Chromium build export a byte-identical IR (tested).
- **Fidelity suite** (`scripts/fidelity.sh`): the kit's fidelity fixtures (`design-kit/fixtures/fidelity/`: layout,
  text styles, colours and gradients, shadows, radii and borders, filters, states, pseudo-states, controls, text
  shadow, object fit, icons, transitions, keyframes, initial triggers, repeat items, letter spacing, text spacing and
  overflow, sizing and visibility, background images) and its nine components, exported in
  Chromium, compiled and captured in `samples/FidelityProject` and compared at 2560×1440, 1920×1080 and 1280×720; each
  must pass §15 thresholds. This is the regression net for every change to the pipeline. All 2355 captures pass
  (1155 static captures and 1200 animation samples; none failed, not captured or incomplete).
- Shared contracts (`contracts/`): CSS support cases, IR and boxes samples and the member-name rule, checked by both
  the Node and the Unity tests.

## 20. Roadmap

| Milestone | Content | Done when | State in 0.1.0 |
|---|---|---|---|
| **M0 Spike** (throwaway code) | One representative screen; measure risks R1–R8 | Calibrated rules and thresholds written back into this spec | Done (`docs/findings/m0.md`) |
| **M1 Static core** | Kit, lint, exporter, IR, compiler (states + pseudo-states), font twins, verifier, report, MCP server (stdio, `editor` bridge + `command` runner), `/unity-ui-mcp` skill | Installed in the first consumer project and connected; the user applies and verifies the pilot screen through `/unity-ui-mcp` | Done |
| **M2 Localization and binding** | Localization writer, `LocalizedString` binding, locale fonts, RTL, text size, view generation, actions | All 11 locale checks pass on the pilot | Built; the automatic locale checks are not (§13) |
| **M3 Dynamic content and motion** | Repeat/ListView, transitions, keyframes | Lists and animated states pass §15 | Done (fidelity suite) |
| **M4 Responsive and distribution** | Breakpoints, UPM release, MCP HTTP transport, client setup docs, first consumer pilot with a real presenter | Pilot works in game with real data, driven from at least two MCP clients | Open: a registry release and the HTTP transport. Runtime breakpoint classes, client setup docs and the in-game pilot with a presenter are done |

## 21. Open decisions and risks

Decisions (resolved by the user on 2026-11-12):

- **D1 Pilot screen:** one existing screen of the first consumer project, rebuilt through the pipeline and driven by
  a presenter in the game.
- **D2 Design sources and goldens:** stored in a folder the user specifies, set as `designRoot` in the project
  profile (each screen under `<designRoot>/<screen-id>/`). Never inside the product repository by default.
- **D3 Package id:** `com.ertugrulgaziakcan.design-ui`; C# root namespace `DesignUi`. Renamed by the user on
  2026-11-14, before 0.1.0: the first id used the `com.unity.` prefix, which is reserved for Unity's own packages.
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
  text accumulate the rounded-up widths (up to about 2 px per text at the reference). **Resolved by the fidelity
  suite:** every capture passes at 1920×1080 and 1280×720; fractional borders and lines became U-CSS-040
  (`docs/findings/borders.md`, `docs/findings/pixel-grid.md`).
- **Platform.** Goldens are platform-specific (findings O-14): every measurement so far is Chromium and Unity on macOS.
  Goldens record the platform and Chromium build, and compare goldens and captures from the same platform.

## 22. Sources

- [Unity 6.3 USS properties reference](https://docs.unity.com/en-us/engine/6000.3/manual/uitoolkits/uielements/uie-uss/properties/reference)
- [Unity 6.3 built-in filters](https://docs.unity3d.com/Manual/ui-systems/built-in-filters.html)
- [Unity 6.3 UI Shader Graph](https://docs.unity3d.com/Manual/ui-systems/get-started-with-ui-shader-graph.html)
- [Unity 6.6 backdrop-filter](https://docs.unity3d.com/Manual/ui-systems/backdrop-filter.html)
- [Vector Graphics 3.0 (SVG in core since 6.3)](https://docs.unity3d.com/Packages/com.unity.vectorgraphics@3.0/manual/index.html)
- [UI Toolkit font asset](https://docs.unity3d.com/Manual/UIE-font-asset.html)
- [Unity 6.5 static font asset migration (advanced text generator)](https://docs.unity3d.com/6000.5/Documentation/Manual/ui-systems/migrate-static-font-assets.html)
