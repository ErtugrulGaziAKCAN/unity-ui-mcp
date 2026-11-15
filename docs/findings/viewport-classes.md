# Viewport classes: exact and scaled resolutions

| | |
|---|---|
| Date | 2026-11-14; the root scale, text widths and pictures 2026-11-15 |
| Question | A game offers 1280×720, 1366×768, 1600×900, 1920×1080, 2560×1440 and 3840×2160. Which of them can hold the kit's whole-device-pixel rules, and what does Unity do with the design at the others? |
| Unity | 6000.3.6f1, standard text generator, real panels (`ViewportScaleTextTests`, `FixedLineTextHeightTests`, `RootScaleTests`, `TextFitTests`) and the fidelity suite |
| Chromium | Chrome Headless Shell 158 (Playwright 1.65.0) |

## Classes

With the 2560×1440 reference and match 0.5 (Unity's linear blend), the panel scales are 1.5, 1, 0.75, 0.625, 0.53346
and 0.5. The kit's values are multiples of 4 px, so they are whole device pixels at 1.5, 1, 0.75 and 0.5 (a 0.25 step):
those are **exact** viewports, held to the kit build, kit sync and lint rules as before (`kit build --check` passes
with 3840×2160 added). At 0.625 a 4 px border is 2.5 device px and a 12 px font 7.5; at 0.53346 no kit value is whole.
Those are **scaled** viewports: exempt from the whole-pixel rules, verified with the same limits. Since 2026-11-15 a
screen lays out at an exact scale there and draws scaled (next section); the sections after it record what UI Toolkit does
when a panel lays a design out at such a scale itself.

## Root scale: lay out at an exact scale, draw scaled

**Mechanism.** The compiler writes the exact viewports' panel scales on the screen root (`DesignScreen`, `exact-scales`,
here 1.5, 1, 0.75, 0.5) and a custom property on its type. On a runtime panel whose scale (without the factor below) is
none of them, the root sets its PanelSettings' `scale` factor so the panel resolves an exact scale (`LayoutScale`, the
nearest in log scale: 1600×900 at 0.75, 1366×768 at 0.5) and gives itself an inline `scale` of actual / exact with
`transform-origin` at its top-left corner and `flex-shrink: 0` (the root is the reference size, 2560×1440, and its parent
is laid out in the exact scale's panel pixels). Every length is then whole device pixels where it is laid out, and
`layout × root scale × panel scale` is the design times the actual scale. The factor is kept per PanelSettings while a
screen is on its panel (the settings' own factor, or a factor the game writes meanwhile, stays the base) and given back
when the last screen leaves; a region's sort-order copy starts with the asset's own factor. The design's size for
breakpoints is the panel's target over the actual scale.

**When the scale changes.** UI Toolkit resolves every style again when a panel's scale changes (`BaseVisualElementPanel.scale`
increments the visual tree's StyleSheet version), also between two 16:9 resolutions where the panel keeps its size in panel
pixels, and sends `CustomStyleResolvedEvent` to elements with custom properties: the root re-evaluates there (no polling;
measured: one event per scale change, `RootScaleTests.FullScreenDocument_…` moves a document from 1920×1080 to 1600×900
without a call into the screen). A runtime panel applies a new factor when it updates: every frame in Play mode and in
players; in Edit mode only when something on it changed after its last update, so the root asks the Editor for one more
update (an `EditorApplication.update` callback that marks the panel dirty; `delayCall` did not run inside the test runner).

**Measured on panels** (`RootScaleTests`, `ViewportScaleTextTests`, `TextFitTests`, device px):

| What | Result |
|---|---|
| A box at (397, 101), 403×37 px, at every default viewport | the design × the actual scale within half a device pixel of the layout scale's grid (edges are rounded where laid out: at 1600×900 within 0.42) |
| Ten rows of a 20 px child with 4 px padding above and below | 175 at 0.625 (CSS 175; laid out natively 185), 149.37 at 0.53346 (natively 147) |
| Every kit style's kerned 33-character line (Chromium's width × the actual scale) | within 0.635 device px at 0.625 from 0.75, 0.674 from 0.5; within 0.575 at 0.53346 from 0.5, 0.542 from 0.75 (the scaled twins: 0.92) |
| Five lines of every kit style | exactly five line boxes from either exact scale |
| Ink extent of 30 H at 12 px | 164.533 through the root at 0.625, 262.855 × 0.625 = 164.284 expected; natively 175.51 (UI Toolkit sets the text at the exact scale's whole size and does not set it again at the world scale) |
| Pointer input at 1600×900 and 1366×768 (and 1920×1080, not scaled) | picks only where the scaled root draws an element; hover, active, a click, a toggle, a text field's focus, a wheel over a scroll view, a captured drag (positions in the element's own space are the design's) |
| Gamma composite and a region's sort-order copy | the copy's panel holds the exact scale, the asset keeps its own factor, the composite's texture is the screen's size, a screen point picks the element the design puts there, `IsPointerOverPanel` agrees |
| A game's own factor (0.9 at 1600×900) | kept as the base (0.5625 actual, laid out at 0.5), given back when the screen leaves |

**Which exact scale.** Measured on the panels above (text widths and line boxes are within a device pixel from
either neighbour) and on the fidelity suite: 15 fixtures (the text, round-shape, bordered and picture ones; 257 captures
per scaled viewport) with each rule (`DESIGN_UI_ROOT_SCALE_RULE`, a measurement knob of the capture):

| Viewport | Laid out at | PASS | FAIL | of which SSIM / edge and colour / text ink / boxes |
|---|---|---|---|---|
| 1600×900 (0.625) | 0.75 (nearest in log scale, also the next up) | 191 | 66 | 51 / 8 / 0 / 7 |
| 1600×900 | 0.5 (next down) | 104 | 153 | 114 / 37 / 0 / 2 |
| 1366×768 (0.53346) | 0.5 (nearest, also the next down) | 109 | 148 | 52 / 7 / 85 / 4 |
| 1366×768 | 0.75 (next up) | 106 | 151 | 57 / 8 / 84 / 2 |

The nearest exact scale in log scale measures best at both (a ratio closest to 1 keeps edges, anti-aliasing and pictures
closest to a native layout); the worst text ink colours at 1366×768 are the same from either base (ΔE2000 2.34, 2.52,
4.63), so the text-ink difference there does not come from the base. `DesignViewportScales.Rule` stays `Nearest`.

**Cost.** A sample of 300 rounded tiles with labels at 1600×900 in Edit mode: 2–3 draw calls and 20–22 µs of
`UIR.DrawChain` per frame with the root scale, 3 and 22–26 µs laid out at 0.625 natively (two runs each). The text is set at
the exact scale's size (larger at 1600×900, smaller at 1366×768), the same glyph count. A change of the root's scale
transforms the screen's vertices once.

**What it does not reproduce.** Chromium lays a page out in device pixels at a fractional scale: it puts border widths
on whole device pixels (halves up; a 4 px border is 3 device px at 1600×900, 2 at 1366×768) and ceils text widths to
them, and keeps paddings and margins fractional. Under the root scale a border is drawn at its exact width (2.5 device
px at 1600×900); text-sized elements take the browser's width anyway (next section). UI Toolkit anti-aliases rounded
shapes with a ramp of one device pixel of the scale it lays out at, so under the root scale the ramp is 0.83 device px at
1600×900 and 1.07 at 1366×768, and small round shapes compare below the SSIM limit there (a 30 px circle 0.972). Text drawn
through the root scale has the design's size and place, and its ink colour at 1366×768 differs more than at an exact
viewport (12.8 px text ΔE2000 up to 3.49 against the limit 2; 8.54 px up to 4.84 against 4.5).

## Text widths: the browser's rule

Measured on the kit's buttons and tabs at every default viewport (`button` and `tabs` goldens): Chromium's content box of
a text-sized element is the text's width ceiled to whole device pixels at the page's scale (a tab's text of 69.469 px makes
70 px of content at 2560×1440 and 105 device px at 3840×2160, 104.2 ceiled), and its borders are whole device pixels
(halves up, at least one). Unity's unrounded text widths are within 0.021 device px of Chromium's (largest of 40 texts).
UI Toolkit ceils on the grid of the scale it lays out at and without a tolerance: "Vazgeç" is exactly 86 px in Chromium
and 86.003 in Unity, which took 87, so every button after it in a row moved a pixel (the +1.02 at 3840×2160 of the
earlier suite). Under the root scale its grid is not the design's either.

`DesignTextFit` (on `DesignLabel` and `DesignButton`, which the compiler writes for a text or button whose width is its
content's) sets an inline width of the generator's unrounded width ceiled on the design's device grid less 0.025 device px
(`Snap`), plus padding and borders as the browser lays them out (`SnapBorder`), and `white-space: nowrap`. UI Toolkit
rounds a measured size to the device grid after the measure function, so a measure override could not carry the
fraction. A row of ten text-sized buttons (`TextFitTests`, body bold, 32 px padding, 4 px borders, 24 px apart):

| Viewport | Largest offset from the browser's positions, device px, with `DesignButton` | with `Button` |
|---|---|---|
| 2560×1440, 1920×1080, 1280×720, 3840×2160 | 0 | 1, 0, 1, 1 |
| 1600×900 | 0.333 | 8.667 |
| 1366×768 | 0.315 | 5.55 |

## Raster pictures

At 3840×2160 a picture shown at its natural size is drawn 1.5 times larger, and Chromium and UI Toolkit resample it
differently (the earlier suite: element SSIM 0.948–0.962 against the picture limit 0.985). Lint **W-IMG-001** warns when a
raster image has fewer pixels than it is drawn at the largest declared viewport (object-fit in the content box,
background-size in the padding box) and names the size to export. A picture exported for 3840×2160 is drawn at a third of
its pixels at 1280×720: UI Toolkit samples level 0 without mipmaps (mipmaps were ruled out before: `pixel-grid.md`), and the
fixture photo's 6 px separators failed there (SSIM 0.963–0.969 at 1280×720 and 1920×1080). So the fixtures' pictures have
the pixels 3840×2160 draws, with their size in CSS, and no detail finer than a block: a 60×36 tile drawn at 40×24 px and
four-block photos at 480×270, 640×360 and 960×540 px. Detail that must survive the whole range of viewports belongs in a
vector image.

## The toggle switch's knob

The knob is `radial-gradient(circle 12px at 16px 16px, #ffffff 10px, transparent 11px)` on a 64×32 rounded box, baked into
an SVG. Unity's VectorImage drew a speckled ring of light pixels at the gradient's radius, where its pad region starts, at
every viewport (largest at 3840×2160: element SSIM 0.967 against 0.984); Chromium draws nothing past the last stop. The bake
now draws a radial gradient that ends transparent as the ellipse it paints (inside the gradient's end) when that ellipse
lies inside the painted shape, so the gradient is never sampled at or past its end; the toggle passes at all six
viewports.

## Text sizes at a scaled viewport (before the root scale)

The scaled font twins this section measured (86722eb) are removed: under the root scale text is set at the exact scale's
whole size and drawn scaled.

Measured on a panel (each kit style, the kerned 33-character line of `Data/chromium-kerning-line.json`, Chromium's width
at scale 1 times the scale; Chromium lays text out at the exact size at any device scale factor):

| Scale | Style | Device size | Unity width / Chromium | One line, device px (CSS line box) | 14 labels stacked, drift |
|---|---|---|---|---|---|
| 0.625 | caption 12/16 | 7.5 | 1.0667 | 11 (10) | +14 |
| 0.625 | label 16/20 | 10 | 1.003 | 13 (12.5) | +7 |
| 0.625 | title 36/48 | 22.5 | 1.023 | 31 (30) | +14 |
| 0.53346 | caption 12/16 | 6.40 | 0.942 | 8 (8.54) | −7.5 |
| 0.53346 | label 16/20 | 8.54 | 1.060 | 12 (10.67) | +18.6 |
| 0.53346 | body 24/32 | 12.80 | 1.019 | 18 (17.07) | +13.0 |

UI Toolkit sets text at whole device pixels, halves up (7.5 → 8, 22.5 → 23, 6.40 → 6, 8.54 → 9), and the line box of a
twin follows the size it renders at. A long line at a scaled viewport is several pixels wider or narrower than the
design's, far outside the ±1 device px box and line-extent limits, so scaled viewports need the size itself fixed.

**Scaled font twins.** A twin's `faceInfo.scale` multiplies every metric the generator uses (glyph advances, ascent,
line height). For each scaled viewport's scale where a line box's font size is fractional, kit sync and the compiler
make a variant with `faceInfo.scale = exact / rounded` (`<face> UITK r13333s12x0p625.asset`); it links to its face's
glyphs and atlas like any line-box variant. `DesignFonts.uss` points the line-box variables at those variants under
`.locale-<code>.vs-<scale>`, and the compiled screen root carries `vs-<scale>` while its panel renders at that scale
(`DesignScreen.ViewportScales`). Measured on a panel with a run of 30 `H` (no kerning): the device width per exact px
is 22.13–22.18 with the variants at every size, 22.1 for a whole size, against 20.8–23.6 without them. Every kit style
at both scaled viewports: kerned line width within 0.92 device px of Chromium's, five lines within 0.97 device px of
five line boxes (`ViewportScaleTextTests.EveryKitStyle_AtEveryScaledViewport_IsTheDesignsWidthAndLineBox`).

## Stacked text

UI Toolkit ceils a text element's measured height to whole device pixels, so at a fractional line box each text is up to
a pixel taller than the design's and everything below drifts. The compiler now gives a text whose line count the design
fixes (it does not wrap in any layer; its lines are its explicit breaks) and whose height is its content's an explicit
height: lines × line box plus vertical padding and borders. Yoga lays the exact value out and rounds each edge to the
device grid, so nothing adds up. Wrapping text keeps its measured height (at most a pixel over per element).

Panel proof (`FixedLineTextHeightTests.FourteenSingleLineLabels_StackWithoutDrift_AtScaledPanels`), 14 labels 16/20:

| Scale | 14 line boxes | Single-line labels (explicit height) | Wrapping labels (measured height) |
|---|---|---|---|
| 0.625 | 175 device px | 0 | +7 |
| 0.53346 | 149.37 device px | −0.37 | +4.63 |

## Stacked-text fixture

`design-kit/fixtures/fidelity/stacked-text.html`: 16 single-line label rows with padding, 16 captions and 6 titles,
14 key/value rows (items centred), and three wrapping paragraphs followed by 6 rows. Unity minus design, device px, at the
column's end mark (the fidelity run's boxes; "before" is the same build without the explicit heights):

| Viewport | Single-line rows before → after | Captions and titles | Key/value rows | Paragraphs, then rows |
|---|---|---|---|---|
| 3840×2160, 2560×1440, 1920×1080, 1280×720 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| 1600×900 (scaled) | +24 → 0 | 0 → 0 | +21 → +14 | +9.5 → +0.5 |
| 1366×768 (scaled) | +0.94 → −0.06 | +9.73 → −0.27 | +0.81 → −4.19 | +4.41 → +4.41 |

The explicit heights remove the text part of the drift. What is left comes from the box model, measured next. Under the
root scale (2026-11-15) every column ends where the design's does at all six viewports: 0.00 device px for the
single-line rows, captions and titles, key/value rows and paragraphs alike.

## Box-model lengths are whole device pixels too

A column of ten rows, each a 20 px child with 4 px on both sides (a panel at each scale, device px; pinned by
`ViewportScaleTextTests.BoxModelLengths_AreWholeDevicePixelsAtAScaledViewport_ExplicitHeightsAreNot`):

| Scale | padding 4/4 | margin 4/4 | border 4/4 | height 28 | padding 3/5 | CSS |
|---|---|---|---|---|---|---|
| 0.625 | 185 (each side 3) | 185 | 185 | 175 | 175 (2 + 3) | 175 |
| 0.53346 | 147 (each side 2) | 147 | 147 | 149 | 157 | 149.37 |

UI Toolkit 6000.3 snaps every padding, margin and border width to whole device pixels (halves up) before layout, while
Chromium lays the exact fractions out.

The same holds at an exact viewport for lengths that are not multiples of 4 px. Ten nested elements, each moved 10 px from
its parent by one property, at scale 0.75 (1920×1080; CSS 75 device px, 80 when each 7.5 is laid out as 8;
`ViewportScaleTextTests.LengthsUiToolkitSnaps_…`):

| Property | Device px after ten moves |
|---|---|
| `padding-left`, `padding-top`, `margin-left` (a lowered `gap` is a margin), `border-left-width` | 80 (snapped) |
| `left` and `top` (relative or absolute), `right` (absolute), `translate` | 75 (laid out as given) |

So a design whose paddings, margins or gaps are not whole device pixels at an exact viewport moves everything inside or
after them by half a device pixel per edge in Unity, and text by about one: a real screen with a frame centred at 398 px
(298.5 device px at 1920×1080) and grid cells padded 10 px and 14 px (7.5 → 8 and 10.5 → 11) drew every text line 0.97 to
1.21 device px right of the design's. Lint **U-CSS-046** rejects such lengths at every exact viewport the kit declares,
naming the element, the property, the viewport and the nearest whole lengths (multiples of 4 px with the default kit);
U-CSS-040 keeps borders there. The fixture `design-kit/fixtures/fidelity/half-pixel-frame.html` centres two frames at
fractions of a device pixel (398 px: 298.5 at 1920×1080; 397 px: 297.75 at 1920×1080, 198.5 at 1280×720, 595.5 at
3840×2160) with 4 px grid paddings, margins and gaps inside. At a scaled viewport each such edge is up to half a device pixel off, and a stack
of padded, bordered or spaced elements adds the errors up (the key/value rows: 4 px padding is 2.5 → 3 device px at 0.625,
+1 per row; 2.134 → 2 at 0.53346, −0.27 per row). Explicit heights and widths are not snapped. No compiled length can
give a fractional edge, and a class-wide rule cannot spread the rounding over the rows that share it, so this is not
fixed here: it is the main reason the scaled class fails (below). Text measuring adds the same kind of error to widths:
UI Toolkit ceils a text's measured width to whole device pixels, so a row of text-sized buttons moves right by up to a
pixel per button (3840×2160: +1.02 at the fourth).

## Suite at six viewports

**With the root scale, exact text widths and the new pictures (2026-11-15).** `scripts/fidelity.sh`, 22 fixtures and 9
components (4728 captures, 2400 of them animation samples), 12 min 53 s (setup 17 s, exports 187 s, import 28 s, capture
198 s, comparisons 339 s):

| Viewport | Class | PASS | FAIL | What fails |
|---|---|---|---|---|
| 3840×2160 | exact | 788 | 0 | |
| 2560×1440 | exact | 788 | 0 | |
| 1920×1080 | exact | 788 | 0 | |
| 1280×720 | exact | 787 | 1 | `stacked-text` "41.200" at 8 device px, ink colour ΔE2000 4.65 against 4.5 (text-ink.md section 9, a pending decision) |
| 1600×900 | scaled | 712 | 76 | 61 SSIM only (46 `keyframes` and 9 `transitions` captures of small round shapes, 5 `icons`, 1 `scroll-area`), 8 corner edges of focus rings (ΔE2000 1.1–1.7 against 1), 7 boxes (Δw −1.16 to −1.49: a letter-spaced title, a bordered state box, a chip in `half-pixel-frame`) |
| 1366×768 | scaled | 633 | 155 | 85 text ink colour (60 `repeat-items` at 8.54 px, ΔE2000 4.63 against 4.5; 17 `controls`, 6 `card` and others at 12.8 px, 2.1–3.5 against 2), 58 SSIM only (52 `keyframes`), 8 corner edges, 4 boxes |

Every remaining scaled failure is a rendering difference the root scale leaves (section "Root scale", "What it does not
reproduce") or a box in 11 captures (Δw −1.06 to −1.78 device px), not drift: the stacked-text columns end within 0.00
device px everywhere. No limit was widened.

**Before (2026-11-14).** `scripts/fidelity.sh`, 20 fixtures and 9 components (4716 captures: 2316 static, 2400 animation
samples), 13 min 38 s (setup 17 s, exports 198 s, import 28 s, capture 194 s, comparisons 378 s with four fixtures at a
time; the transitions fixture's 2130 captures take 330 s of it):

| Viewport | Class | PASS | FAIL |
|---|---|---|---|
| 3840×2160 | exact | 697 | 89 |
| 2560×1440 | exact | 786 | 0 |
| 1920×1080 | exact | 786 | 0 |
| 1280×720 | exact | 785 | 1 |
| 1600×900 | scaled | 431 | 355 |
| 1366×768 | scaled | 17 | 769 |

With the `half-pixel-frame` fixture (frames centred at fractions of a device pixel, section "Box-model lengths") the
suite has 21 fixtures and 4722 captures: that fixture passes at the four exact viewports and fails at the two scaled
ones; every other count is the table's (3840×2160 698/89, 2560×1440 and 1920×1080 787/0, 1280×720 786/1, 1600×900
431/356, 1366×768 17/770).

- 3840×2160: 35 captures move text-sized buttons by 1.01–1.02 px (the width ceil above); 54 fail element SSIM only:
  raster pictures drawn 1.5× larger (0.948–0.962 against the picture limit 0.985) and the toggle fixture's effects tile
  (0.967).
- 1280×720: the new fixture's value "41.200" at 8 device px, ink colour ΔE2000 4.65 against the small-text limit 4.5
  (the renderers' small-text scatter, text-ink.md section 7).
- 1600×900: 132 captures with a box, baseline or line-extent issue (stacked padded rows, field labels that may wrap,
  bordered controls), 186 SSIM only and 35 edge only (fractional edges and baked images drawn at 0.625).
- 1366×768: every failing capture has a geometry issue (1.2–4 px typical; a wrapping row of tiles whose widths add up
  breaks onto a second line, +78 px).

No scaled-class limit was recorded in `fidelity-thresholds.json`: the colour and SSIM differences at 1600×900 come with
geometry failures that need a ruling first, and geometry limits stay ±1 device px.
