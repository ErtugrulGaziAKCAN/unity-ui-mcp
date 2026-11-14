# Viewport classes: exact and scaled resolutions

| | |
|---|---|
| Date | 2026-11-14 |
| Question | A game offers 1280×720, 1366×768, 1600×900, 1920×1080, 2560×1440 and 3840×2160. Which of them can hold the kit's whole-device-pixel rules, and what does Unity do with the design at the others? |
| Unity | 6000.3.6f1, standard text generator, real panels (`ViewportScaleTextTests`, `FixedLineTextHeightTests`) and the fidelity suite |
| Chromium | Chrome Headless Shell 158 (Playwright 1.65.0) |

## Classes

With the 2560×1440 reference and match 0.5 (Unity's linear blend), the panel scales are 1.5, 1, 0.75, 0.625, 0.53346
and 0.5. The kit's values are multiples of 4 px, so they are whole device pixels at 1.5, 1, 0.75 and 0.5 (a 0.25 step):
those are **exact** viewports, held to the kit build, kit sync and lint rules as before (`kit build --check` passes
with 3840×2160 added). At 0.625 a 4 px border is 2.5 device px and a 12 px font 7.5; at 0.53346 no kit value is whole.
Those are **scaled** viewports: exempt from the whole-pixel rules, verified with the same limits.

## Text sizes at a scaled viewport

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

The explicit heights remove the text part of the drift. What is left comes from the box model, measured next.

## Box-model lengths are whole device pixels too

A column of ten rows, each a 20 px child with 4 px on both sides (a panel at each scale, device px; pinned by
`ViewportScaleTextTests.BoxModelLengths_AreWholeDevicePixelsAtAScaledViewport_ExplicitHeightsAreNot`):

| Scale | padding 4/4 | margin 4/4 | border 4/4 | height 28 | padding 3/5 | CSS |
|---|---|---|---|---|---|---|
| 0.625 | 185 (each side 3) | 185 | 185 | 175 | 175 (2 + 3) | 175 |
| 0.53346 | 147 (each side 2) | 147 | 147 | 149 | 157 | 149.37 |

UI Toolkit 6000.3 snaps every padding, margin and border width to whole device pixels (halves up) before layout, while
Chromium lays the exact fractions out. At a scaled viewport each such edge is up to half a device pixel off, and a stack
of padded, bordered or spaced elements adds the errors up (the key/value rows: 4 px padding is 2.5 → 3 device px at 0.625,
+1 per row; 2.134 → 2 at 0.53346, −0.27 per row). Explicit heights and widths are not snapped. No compiled length can
give a fractional edge, and a class-wide rule cannot spread the rounding over the rows that share it, so this is not
fixed here: it is the main reason the scaled class fails (below). Text measuring adds the same kind of error to widths:
UI Toolkit ceils a text's measured width to whole device pixels, so a row of text-sized buttons moves right by up to a
pixel per button (3840×2160: +1.02 at the fourth).

## Suite at six viewports

`scripts/fidelity.sh`, 20 fixtures and 9 components (4716 captures: 2316 static, 2400 animation samples), 13 min 38 s
(setup 17 s, exports 198 s, import 28 s, capture 194 s, comparisons 378 s with four fixtures at a time; the transitions
fixture's 2130 captures take 330 s of it):

| Viewport | Class | PASS | FAIL |
|---|---|---|---|
| 3840×2160 | exact | 697 | 89 |
| 2560×1440 | exact | 786 | 0 |
| 1920×1080 | exact | 786 | 0 |
| 1280×720 | exact | 785 | 1 |
| 1600×900 | scaled | 431 | 355 |
| 1366×768 | scaled | 17 | 769 |

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
