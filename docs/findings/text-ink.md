# Text ink at small sizes: cause and calibration

| | |
|---|---|
| Date | 2026-11-13 |
| Question | Why does Unity's text fail the per-line ink colour check at 1920×1080 and 1280×720 (ΔE2000 3.5–11, thin strokes lighter than Chromium's) while 2560×1440 passes? |
| Chromium | Chrome Headless Shell 158 (Playwright 1.65.0) on macOS, the exporter's page setup (`deviceScaleFactor` = viewport scale) |
| Unity | 6000.3.6f1, batchmode, Metal, Linear colour space, the verifier capture (`R8G8B8A8_UNorm` target, `forceGammaRendering` on) |
| Font | Inter 18pt Regular and Bold, the kit's line-box twins (SDFAA, sampling 72, padding 7, standard text generator) |
| Fixture | [`text-ink/ink.html`](text-ink/ink.html): every kit text style (7 sizes × 400/700) as one line in three columns: white on `#0b1f26`, `#0b1f26` on `#f2f4f5`, cyan `#16c2d5` on `#0b1f26`; 126 measured lines per run |

## Result

**Cause: the golden's macOS font smoothing, not Unity.** (Designs now render with the smoothing off; the thresholds of
section 4 are measured that way.) Chromium on macOS draws text with CoreText font smoothing
(the default `-webkit-font-smoothing`), which thickens stems. Unity's SDF text is drawn without it. With the smoothing
switched off in the golden (`-webkit-font-smoothing: antialiased`, layout unchanged), Unity's text matches Chromium's:
ink amount 0.92–1.05× and ink colour within ΔE2000 1.3 for every line of 9 device px or more. No Unity setting that was
measured (blending space, text generator, hinting, SDF atlas settings) moves Unity towards the smoothed golden, so none
is shipped; the comparison's text-ink limits are calibrated to the measured difference instead.

The check measures the ink colour as the median of the 10 % ink pixels that differ most from the background. Large text
has fully covered stem centres on both sides, so the colour is exact (ΔE 0 from 14 device px up). Small text has no
fully covered pixel: its "ink colour" is a partially covered stem, and the smoothed golden's stems are more covered.

## 1. Unity against the golden, by device font size

Largest ink colour ΔE2000 per device font size (CSS size × viewport scale) and column, and Unity's ink amount relative
to the golden's (standard generator, verifier capture). The same device size gives the same numbers whichever viewport
it comes from (12 px: caption at 2560, label at 1920, body at 1280).

| Device px | Golden as exported: ΔE white / dark / cyan | Golden without smoothing: ΔE white / dark / cyan | Ink amount (as exported) white / dark / cyan |
|---|---|---|---|
| 6 | 9.46 / 5.20 / 6.67 | 5.59 / 7.88 / 4.97 | 0.81–0.84 / 0.94–1.03 / 0.89–0.91 |
| 8 | 10.00 / 3.02 / 7.93 | 1.17 / 2.12 / 1.86 | 0.71–0.80 / 0.89–0.93 / 0.77–0.85 |
| 9 | 7.96 / 3.34 / 6.56 | 0.70 / 1.26 / 0.92 | 0.75–0.82 / 0.93–0.99 / 0.81–0.89 |
| 12 | 2.32 / 3.12 / 2.13 | 0.41 / 0.93 / 0.66 | 0.71–0.74 / 0.88 / 0.76–0.79 |
| 14–56 | 0 / 0 / 0 | ≤ 0.80 | 0.69–0.85 / 0.83–0.90 / 0.74–0.86 |

Other screens agree: a 16 px label (white on `#0b1f26`) at 1920 (12 device px) measured ΔE 3.28–3.90 and at 1280
(8 device px) 6.65–11.32; short words (2–4 characters) scatter more than the fixture's 30-character line.

## 2. What the smoothing does in Chromium

The same page rendered by the exporter with and without `-webkit-font-smoothing: antialiased` (Chromium against
itself). Smoothing off draws this much of the smoothed ink:

| Column | Ink amount, off ÷ on | Ink colour ΔE2000, off vs on (largest) |
|---|---|---|
| white on dark | 0.73–0.87 | 14.98 (6 px) |
| dark on light | 0.86–0.99 | 5.08 (8 px) |
| cyan on dark | 0.76–0.91 | 11.60 (6 px) |

The effect depends on the polarity: light text on a dark background gains up to 37 % more ink, dark text on a light
background up to 16 %. These are the same ratios Unity shows against the smoothed golden (section 1), and the same
lightening of thin stems at small sizes.

## 3. Unity-side candidates, one at a time

Each candidate changes one thing against the baseline (standard generator, SDFAA, sampling 72, padding 7, gamma-space
blending) and is measured on the whole fixture at the three viewports. ΔE: largest ink colour ΔE2000 over all lines;
ratio: Unity's ink amount relative to the golden's, all lines at 2560.

| Candidate | Against the golden as exported: ΔE 2560 / 1920 / 1280 | ratio 2560 | Against the golden without smoothing: ΔE 2560 / 1920 / 1280 |
|---|---|---|---|
| Baseline | 3.12 / 7.96 / 10.00 | 0.71–0.89 | 0.66 / 1.26 / 7.88 |
| Linear-space blending of the glyph coverage (derived, see below) | 12.92 / 21.57 / 22.60 (dark text); 1.20 / 3.32 / 4.20 (light text) | 0.64–0.96 | 10.60 / 17.62 / 19.82 |
| Advanced text generator (`-unity-text-generator: advanced`) | 3.12 / 7.73 / 9.72 | 0.71–0.89 | 0.67 / 1.44 / 7.17 |
| Hinted SDF (`SDFAA_HINTED`) | 4.37 / 7.73 / 9.21 | 0.73–0.92 | 1.87 / 1.87 / 8.60 |
| Upsampled SDF (`SDF16`) | 4.05 / 8.28 / 9.89 | 0.72–0.90 | 1.56 / 1.56 / 7.49 |
| Smaller SDF atlas (sampling 36, padding 4) | 5.36 / 9.34 / 10.12 | 0.68–0.87 | 2.86 / 2.86 / 7.10 |

- **Linear blending** moves light text towards the smoothed golden but dark text far away from it (ink amount
  0.61–0.87, ΔE up to 22.6): the smoothing is not a blending-space effect. Derived from the baseline capture: each
  text pixel of the gamma-space blend is `B + a (I − B)` in sRGB bytes; `a` is recovered by projection onto `I − B` and
  the pixel re-blended in linear light, as an sRGB target without `forceGammaRendering` stores it. The verifier keeps
  gamma-space blending, which colour and alpha need (findings m0 §10).
- **Advanced generator**: the same SDF rendering, so the same ink. It needs Project Settings → UI Toolkit → *Enable
  Advanced Text*; without it the property is ignored and Unity logs that the generator is disabled.
- **Hinting and the SDF atlas settings** change the ink by a few percent in either direction and match neither golden
  better. UI Toolkit's SDF sharpness is not available to runtime panels in 6000.3 (the text shader receives the
  sharpness value only for Editor panels).

## 4. Calibration (`tools/design-export/fidelity-thresholds.json`)

Since the measurement above, the kit's base stylesheet sets `-webkit-font-smoothing: antialiased` on `:root` and lint
U-CSS-038 requires it, so designs render in Chromium the way Unity draws text. The thresholds come from a second
measurement with that rule: [`text-ink/ink.html`](text-ink/ink.html) (regenerated from the current table, font sizes
and line heights in multiples of 4 px), every kit style in the three columns, 126 lines per viewport, 2560 / 1920 /
1280.

| Device px | Ink colour ΔE2000, largest (white / dark / cyan) | Ink amount, Unity ÷ design (white / dark / cyan) |
|---|---|---|
| 6 | 6.11 / 8.23 / 5.31 | 0.99–1.04 / 0.96–1.08 / 1.00–1.08 |
| 8 | 1.17 / 2.12 / 1.86 | 0.94–0.96 / 0.92–0.93 / 0.95–0.96 |
| 9 | 0.47 / 1.04 / 0.62 | 0.99–1.00 / 0.99 / 1.00 |
| 12 | 0.41 / 0.93 / 0.66 | 0.94–0.96 / 0.94–0.96 / 0.95–0.97 |
| 16–64 | 0 | 0.96–0.99 |

Per capture and polarity, a line's ink amount lies within −5 % and +11.7 % of the median (the extremes are 6 px
bold). The first, smoothing-off comparison of section 1 gave up to 1.26 at 9 px.

| Key | Value | Measured, margin |
|---|---|---|
| `textInkDeltaE`, `textInkFullPx` | 2 from 9 device px | 1.26 at most; +0.74 |
| `textInkDeltaESmall` | 8 px: 3; below: 10 | 2.12 at 8 px, 8.23 at 6 px; about +0.9 and +1.8 |
| `textInkRatio`, `textInkCoverage` | 1, ±10 %: 0.90–1.10× | 0.92–1.08×; 0.02 each side |
| `textInkMedianTolerance` | ±15 % of the median of the capture's text of the same polarity | −5 % to +11.7 %; +3.3 points |

- Size-dependent limits remain only below 9 device px, where no stem pixel is fully covered (the kit's smallest style,
  12 px, is 6 device px at 1280).
- The font size is the element's `font-size` in the capture (the IR's layer that holds) times the capture scale; an
  export without IR uses ¾ of the line box height (never more than the size for the kit's ratios 1.25 and 4/3).
- The polarity split of the median no longer changes anything measurable (light and dark medians are 0.97–0.98 and
  0.97–0.98); it stays because other fonts may differ by polarity.
- What it catches now: any colour error above ΔE 2 on text of 9 device px and more, above 3 at 8 px; a regular face
  drawn for bold (0.74× the ink) and a wrong size fall below the 0.90× band.
- Under the first calibration (macOS smoothing on) the limits were ΔE 3 from 14 px, 5 / 10 / 14 below, the ink band
  0.65–1.15× and the median ±20 %; they are superseded.

## 5. Other differences the fixture exposed

- **Kerning.** Unity's text was wider than Chromium's (up to +6 px on a 30-character line) because its first layout was
  not kerned; see section 6.
- **Stacked text at 1920×1080 and 1280×720.** Line boxes of 15, 30, 35, 54 and 63 px are not whole device pixels at
  scale 0.75 (11.25, 22.5, 26.25, 40.5, 47.25 px), nor 15, 35 and 63 px at 0.5. UI Toolkit rounds a text element's
  height up to whole device pixels (both generators), so each such element is up to 0.75 px taller than in Chromium and
  elements stacked below it drift: +12 px at the bottom of the fixture's 14-line column at 1920, +2 px at 1280. A single
  element is within the 1-px box limit (panel proof: height ≤ 0.75 px off, baselines ≤ 0.41 px for every kit style at
  1, 2, 5 and 10 lines and scales 1, 0.75 and 0.5); the sum is not. Only line boxes that are multiples of 4 px are whole
  at both scales. Kit sync now rejects a text-style table whose font sizes or line heights are not whole device pixels
  at every viewport the profile declares, naming the viewport and the nearest sizes that fit; the kit's table uses
  multiples of 4 px (ratios 1.25 and 4/3), and every size of the table gets its own line-box twin (one per size since
  the baselines follow Chromium's rounding, [text-baselines.md](text-baselines.md)).

## 6. Kerning on the first layout

**Cause.** The font twins are dynamic font assets. When a text needs a glyph the twin does not have yet, the twin adds
the glyph at once but its kerning pairs only in its update queue, after that text was laid out, and UI Toolkit keeps the
unkerned layout (Unity 6000.3, standard text generator). The same string laid out later, once its glyphs exist, is
kerned. Unkerned widths equal the ceiling of Chromium's widths with `font-kerning: none`.

**Measured on a real panel** (the verifier capture, fresh twins) with [`text-ink/lines.html`](text-ink/lines.html) and
[`lines-bold.html`](text-ink/lines-bold.html): every kit style, 400 and 700, at 1, 2 and 5 lines of the 33-character
line `AVATAR Toyota Wave, Yavuz Tepe To` (pairs AV, VA, AT, TA, To, Wa, av, Ya, Te), each element absolutely placed on
whole device pixels; 42 elements per viewport. Unity minus Chromium, device px:

| | Box height | Baseline (every line) | Element width | Line width |
|---|---|---|---|---|
| Standard generator, first layout (2560, the first capture) | 0 | −0.18 … +0.87 | **+7.02 … +45.97** (all 42 over 1 px) | −0.00 … +0.06 |
| Standard generator, glyphs already in the twin (1920, 1280) | 0 … +0.75 | −0.14 … +0.65 | +0.02 … +0.98 | 0.00 … +0.04 |
| Advanced generator (`-unity-text-generator: advanced`), all three viewports | 0 … +0.75 | −0.26 … +0.86 | +0.06 … **+1.13** (30 of 126 over 1 px) | −0.05 … +0.20 |
| Standard generator with the fix below, fresh twins, all three viewports | 0 … +0.75 | −0.18 … +0.87 | +0.02 … +0.98 | −0.00 … +0.06 |

The line width is the caret route's (measured after the capture's frames); the element width is the laid-out box, which
keeps the first layout. The advanced generator kerns from the first layout, but its lines come out up to 0.2 px wider
than Chromium's, so the element box (UI Toolkit rounds a text's size up to whole device pixels) misses the 1-px limit by
up to 0.13 px; it also needs Project Settings → UI Toolkit → *Enable Advanced Text* (which stores ICU data in every
PanelSettings). The standard generator with the twins prepared holds every limit, so it stays.

**Fix.** Characters reach the twins with their font features before any text that uses them is laid out:

- at import, every character of every string of the screen (texts and attribute texts, every locale the IR carries) is
  added to each locale's primary twins, plain and line-box variants, their weight faces and, for characters a twin
  lacks, its fallbacks (`TryAddCharacters` with font features), and the twins that gained characters are saved;
- a text assigned at runtime goes through `DesignUi.DesignText.SetText(element, text[, fonts])`, which does the same
  before assigning it, in the twins of the element's locale from the compiler's `DesignFonts.asset` (a `DesignFontSet`
  next to `DesignFonts.uss`: per locale the primary twin and its line-box variants; the locale is the `locale-<code>`
  class of the compiled screen root above the element). It needs no resolved style, so a bind right after the screen is
  cloned or attached is kerned too (measured: 335 px unkerned without the set, the kerned width with it). The
  verifier's sample-data fill prepares bound texts and Smart String arguments the same way;
- twins keep their dynamic data in player builds (`clearDynamicDataOnBuild` off), so what the import added ships.

Panel proof (`LineBoxStyleTableTests`): with the line prepared as a bound text is, every kit style's first layout is
within 0.84 / 0.81 / 0.85 px of Chromium's width at scales 1 / 0.75 / 0.5 with the multiple-of-4 table (heights
exactly n × L, baselines within 0.32 px) (`Tests/Editor/Data/chromium-kerning-line.json`,
Chromium's widths per font size and weight of the kit's table, rebuilt by `Tests/Editor/Data/tools~/chromium-kerning-line.mts`
whenever the table changes).

## 7. Small text: measured limits and a readability warning

**Measured over the whole suite** (22 screens, every state, hover, breakpoint and viewport at 2560, 1920 and 1280; 953
static jobs), after the line boxes follow Chromium's baselines ([text-baselines.md](text-baselines.md)). The text that
failed the limits of section 4 is all of 6 to 12 device px, short labels, hints and values rather than the 30-character
calibration line. Largest values by device font size, first lines:

| Device px | Ink colour ΔE2000, largest | Limit before |
|---|---|---|
| 12 | 2.37 | 2 |
| 9 | 3.49 | 2 |
| 8 | 3.83 | 3 |
| 6 | under 10 (8.23 in section 4) | 10 |

The ink amount of Unity's text relative to the design's lay between **0.84 and 1.17** (limits 0.90–1.10). Its upper end
is text with a text shadow: the shadow's ink adds to the text's, and Unity's softer shadow edge puts a little more of it
inside the measured window.

**Cause.** The renderers differ by fractions of a pixel at these sizes: Unity's glyphs sit about 0.15 px lower, stems
differ by up to 0.3 px horizontally, and a short string has no long run in which the differences average out. At 8 to 12
device px a stem is one or two pixels wide, so 0.3 px is a third of its coverage and moves the ink colour (the median
of the most covered pixels) by a few ΔE. This is a rasterisation limit, not a layout difference: boxes, baselines and
line counts of the same texts pass at 1 px.

**Policy** (`textInkSmallPx`, `textInkDeltaEFirstSmall`, `textInkBandSmall` in `fidelity-thresholds.json`):

| Key | Value | Measured, margin |
|---|---|---|
| `textInkSmallPx` | 12 | the largest size with the scatter above |
| `textInkDeltaEFirstSmall` | 4.5 (text of at most 12 device px takes the larger of this and its size's limit) | 3.83 at most; +0.67 |
| `textInkBandSmall` | 0.80–1.25 (the wider of this and the usual band) | 0.84–1.17; −0.04 and +0.08 |
| `textInkMedianToleranceSmall` | ±25 % of the capture's median (the larger of this and `textInkMedianTolerance`) | up to +19 % (a bold caption of 6 device px with a text shadow, against the median of its capture's light text); +6 points |

- **Above 12 device px nothing changes**: the ink colour is exact there (ΔE 0 from 14 px, within 1.3 from 9 px in
  section 1), so a wrong colour on larger text still fails at ΔE 2.
- A wrong colour on small text still fails above 4.5 (a design colour a step off is ΔE 5 or more), and a regular face drawn
  for bold (0.74× the ink) or a size one style off stays below 0.80×.
- The median check of section 4 (±15 %) applies to text above 12 device px unchanged. For small text a line with a text
  shadow lay up to 19 % from the median of its capture, so it takes the wider tolerance above.
- What 12 device px covers in the kit's table, per viewport:

  | Viewport (scale) | Kit styles at 12 device px or less |
  |---|---|
  | 2560×1440 (1) | caption (12 px → 12) |
  | 1920×1080 (0.75) | caption (9), label (16 px → 12) |
  | 1280×720 (0.5) | caption (6), label (8), body (24 px → 12) |

  Subtitle (32 px) and larger stay above 12 device px everywhere, the label is 16 device px at 2560 and the body 18 at
  1920; those keep ΔE 2 and the usual band.
- The cost: on the styles in that table a colour error up to ΔE 4.5, an ink amount between 0.80 and 1.25 of the design's
  and a line up to ±25 % from its capture's median pass. For the caption that holds at all three viewports, so a caption
  colour error of up to ΔE 4.5 passes everywhere; a label error up to 4.5 passes at 1920 and 1280 and fails only at
  2560; a body error fails at 2560 and 1920. A one-step colour error (ΔE 5 or more) still fails on all of them.
- Two of these limits rest on text-shadow lines: the band's top (1.17, a hard-shadowed 6 device px caption) and the median
  tolerance (+19 %, the same caption against its capture's light text). They are kept as measured; without that line the
  suite's small text spans 0.84–1.11 of the design's ink.

**Readability warning.** Text this small is also hard to read, and no renderer measures it exactly. Kit build and kit
sync warn once about the kit's text styles under 10 device px at the smallest viewport the kit declares (at 1280 wide:
caption, 12 px → 6 device px, and label, 16 px → 8), naming each style, its device size and the smallest style that stays
readable, and RULES.md notes them under the text styles. It is a prompt to keep such styles for secondary text, never an
error. A first version warned per design (lint W-TXT-001): the kit's own label is under the line, so it fired on nearly
every screen and taught users to ignore warnings; it is no longer a lint rule. Replaced (section 9, decision): no text
may draw below 9 device px at a declared viewport; kit build refuses a style below it and lint U-FONT-004 names each text
below it, and the kit's smallest styles are 20 px.

## 8. Text with a blurred shadow

A text shadow with a blur puts a glow around the glyphs, and the part of it inside the line's window counts as ink: the
ink amount is the sum of every pixel on the ink side of the background, weighted by how far it is. Unity's glow edge is a
little softer than Chromium's, so it leaves a little more of the glow inside the window. Measured over the suite (the
text-shadow fixture is the only page with text shadows; every state, hover and viewport):

| Shadow | Unity's ink relative to the design's |
|---|---|
| `0 4px 12px` cyan, 0.9 (the title's hover glow, 36 px bold) | 1.108, 1.109, 1.111 at 2560, 1920, 1280 |
| `0 0 16px` green, 0.9 (the state glow) | 1.022–1.037 |
| `0 2px 4px`, `0 6px 8px`, `0 0 12px`, `-4px 0 2px`, `0 1px 2px` | 0.94–1.00 |

**Policy** (`textInkShadowHigh` in `fidelity-thresholds.json`): a line whose text has a blurred text-shadow in the
capture (the compare reads it from the IR's style layers) may draw up to **1.15×** the design's ink: the measured 1.111
plus 0.04. Everything else stays: the lower end of the band, the median check and the ink colour (the median of the most
covered pixels, the glyphs themselves) are unchanged, so a wrong text colour, a lighter weight or a missing glow
(0.94–1.00 is what the glyphs alone give) still fail; a bolder weight (+30 % ink or more) still fails above 1.15. A
shadow without blur (an offset copy) keeps the usual band.

## 9. Text at 8 device px: is there a generic adjustment?

A real screen's 16 px labels at 1280×720 (8 device px) failed the ink colour limit (ΔE2000 5.16 against 4.5) and its
status chips drew 0.66× the design's ink; the suite's `stacked-text` fixture fails once there (ΔE 4.65). The question was
whether a rendering adjustment for text drawn at 10 device px or less (an SDF weight or sharpness per rendered size)
brings it within the exact limits, which stay as they are.

**Measured over the suite** (21 fixtures and 9 components, static captures at the four exact viewports; per text
element the largest ink colour ΔE2000 and the worst line's ink amount, Unity ÷ design, from the verdicts; the size from
the IR's text style):

| Device px | Lines | Ink colour ΔE2000 median / p90 / max | Ink amount median | p10–p90 | min–max |
|---|---|---|---|---|---|
| 6 | 29 | 3.64 / 7.40 / 8.12 (limit 10) | 0.997 | 0.931–1.066 | 0.917–1.169 |
| 8 | 114 | 1.52 / 3.27 / 5.66 | 0.908 | 0.863–0.969 | 0.835–1.051 |
| 9 | 29 | 2.62 / 3.72 / 4.25 | 0.961 | 0.947–0.981 | 0.941–1.030 |
| 12 | 359 | 0.00 / 1.31 / 3.41 | 0.947 | 0.929–0.982 | 0.890–1.041 |
| 16 | 121 | 0.00 / 0.00 / 0.40 | 0.964 | 0.952–0.972 | 0.941–0.988 |

- At 8 device px Unity draws about 5 % less ink than at the other sizes (median 0.908 against 0.95–0.96), but the ink
  **colour** (the median of the most covered pixels) is off in both directions: `stacked-text`'s "41.200" is brighter in
  Unity than in the design (`#cdd3d5` against `#b9c1c3`: Unity's stems are more concentrated), while the half-pixel
  frame's digits below are dimmer (`#e1e6e8` against `#ffffff`) and the real screen's chips drew 0.66× the ink.
- **Where the line starts matters.** A first version of `half-pixel-frame` used 16 px bold digits (8 device px at
  1280×720) in two frames, one on whole device pixels and one at a half pixel. The frame on whole pixels: ink colour
  ΔE2000 median 1.56, none over 4.5 (two single digits at 0.58× and 0.64× the ink); the frame at a half pixel: median
  2.18, four of 21 digits over 4.5 (4.75–5.87), every one dimmer in Unity. UI Toolkit puts a text's box on whole device
  pixels, the browser keeps the half pixel, so a one-pixel stem falls on other pixel columns: the boxes pass (within
  ±1 px), the colour of the stem does not.

**Levers, and why none is generic:**

| Lever | What it would do here |
|---|---|
| A heavier weight per rendered size (SDF dilation, or an outline in the text's own colour) | more ink (towards the median), but brighter stems: worse for the lines Unity already draws brighter ("41.200"), better only for the dimmer ones; an outline also needs each element's colour in every state |
| A softer edge (SDF sharpness) | the one that matches a softer browser stem; UI Toolkit 6000.3 passes the sharpness only to Editor panels, not runtime panels (section 3) |
| Atlas sampling and padding, hinting, the advanced generator | measured in section 3: a few per cent either way, closer to neither golden |
| Keeping the browser's half pixel | UI Toolkit lays boxes on whole device pixels (the layout cannot carry the fraction into the text) |

**Result: no generic adjustment.** The kit's readability warning stays (kit build and kit sync name the styles under 10
device px at the smallest viewport), the limits stay, and the fidelity fixtures that measure layout use text of 12
device px or more (`half-pixel-frame`). What remains is a design decision: no text under 9 device px at an exact
viewport (the 16 px label is 8 at 1280×720: a larger style there), a measured 8 px colour limit (later lines already
take 6 at 8 px), or 1280×720 without a pixel verdict for such text.

**Decision (2026-11-15): a readable-text floor.** The game-industry practice: no text draws below a readable minimum,
instead of looser checks for tiny text. No text may draw below 9 device px at any declared viewport, exact or scaled.

- *Measured first, at 1280×720.* A kit copy with the caption and label styles at 18 px (9 device px there; 2560×1440 and
  1280×720 only, the 18 px size being whole device px at both), 8 fixtures and 6 components through the suite (362
  captures): 135 text elements drawn at 9 device px, ink colour ΔE2000 median 1.53, p90 2.91, max 4.29 against the
  exact-class limit 4.5 (first lines of text under 12 device px), ink amount 0.931–1.384 (median 0.977); the only ink
  issues were one pre-wrap line of `text-spacing` whose wrapping the 18/22 copy changed, failing at 2560×1440 as well. At
  12 device px (body) the max was 2.28. So 9 device px meets the existing limits and the floor stays at 9 (the limits
  stay as they are).
- *The floor in design pixels* is 9 over the smallest declared viewport's scale: 18 px with the default viewports (9
  device px at 1280×720, 9.6 at 1366×768). The kit's sizes are whole device px at every exact viewport (multiples of 4
  with 0.75), so the kit's smallest styles are 20 px: caption 20/28 and label 20/24, each with the multiple of 4 nearest
  its own line-height ratio (4:3 → 7:5, 5:4 → 6:5); every other style is unchanged.
- *Lint U-FONT-004* (error) names each text whose font size times the scale its transforms keep it at (now and in a
  state; not an animation's passing frames) times a declared viewport's scale is below 9 device px: the element, its
  text style, the viewports, the drawn size and the minimum design size. It replaces the kit's readability warning (kit
  build and kit sync no longer warn). *Kit build* (and `kit build --check`, and the Claude export) refuses a kit text
  style below the floor at any declared viewport; RULES.md and the published Design System state the minimum.
- The fidelity fixtures' text rose with the kit (the 8 px `stacked-text` case at 1280×720 and the 8.54 / 6.4 px label and
  caption text at 1366×768 are gone; the calendar cards of `repeat-items` grew to 56 px for their two lines). The ink
  scatter of 12.8 px body text at 1366×768 is a separate case and stays reported as it is
  (docs/findings/viewport-classes.md, "Text ink at 1366×768").

## 10. Lines without a fully covered pixel (rulings R138, R141, fix round 3)

The ink colour (the median of a line's most inked tenth) and the ink amount assume that the stroke covers some pixels
wholly. A text of one glyph of one stroke thinner than two device pixels, on a line the design puts between two device
pixels (an em dash, a "1" at 10 and 10.67 device px), may cover none: its measured ink colour and amount are its coverage,
which Chromium and UI Toolkit lay differently on the pixel grid (the dash: 0.84 and 0.44 of two rows against 1 and 0.12;
ink colour ΔE2000 6.06 to 8.99, ink amount 0.69 to 0.75). Such a line (text of at most 12 device px, drawn at opacity 1 in the
colour the capture recorded for it, all of the line in it, with no element, repeat copy (in its own item's state) or outer
box or text shadow over it that both renderers paint after it (the compiler's paint order), and fewer than 3 pixels at 0.85 of that colour's distance from the background, in its direction, its most covered pixel at half
of it or more) is judged by the angle between the two inks' directions from the background in sRGB instead, limit 0.66°
(the suite's highest 0.26°, plus 0.4), and its ink amount against the text colour within 0.5 to 2 times the design's (the
suite's 0.86 to 1.01). On such a line a lightness-only error within that band is not caught. Measurements and the exact rule: docs/findings/viewport-classes.md, "Hairline lines".

## 11. The ink window: what lies in it besides the line's own text (Task 37)

A pilot screen (a calendar in a URP, Linear-colour-space game with the gamma composite) failed text checks that the suite's
text of the same sizes passes. Its captures were kept (`design_ui_verify { keepCaptures: true }`) and compared again
offline. Each failure came from pixels in a line's window that are not the line's text.

**A later element's shadow (rule since Task 37: the background where it is).** With a month picker open, a card title
below the picker's `0 24px 64px` shadow "ended 4.48 device px early" at 2560×1440 and 10.17 at 3840×2160, though its
glyphs ended at the same column in both captures. The window holds the card under the shadow, 43 luma levels at its top
row and 47 at its bottom one in the design; against the window's median (45) the bottom rows lay more than 2 levels off
and counted as ink, 0.13 of a pixel in every card column, so the design's ink extent ran on to the card's edge (778.11
against 771.67 without the picker); Unity's shadow is a level weaker there and its extent ended at the text. `inkIn` now
fits a plane to the background where it varies across the window by a level or more (least squares on the pixels within
2 levels of it, refitted four times; kept only when it explains as many pixels as the median does) and measures each
pixel against it: 771.67 on both sides. A flat background keeps its median, so nothing else moves. Tests: a synthetic
card under a shadow passes and the same line one glyph shorter fails (compare.test.ts), and a heading at either end of a
gradient weighs the same (each ink pixel's weight and the ink's colour direction are measured against the plane too:
review finding 4). The suite's `shadowed-text` fixture (titles under a dialog's shadow that run on past their clipping
boxes) failed 4 of its 6 viewports before Task 37 and passes all six; its titles' own clips end their windows before the
shadowed tail, so it passes with the plane off as well, and the unit test is what holds the plane.

**Overflow clips (rule since Task 37: what the design's clip shows).** A line's window is its line rects grown by a pixel,
and nothing bounded it by what clips the text:

- rows of the day panel's scroll area below its bottom (y 1362–1392 at 2560×1440, the scroll area ending at 1292) lay
  across the frame's edge, where the design shows the host shell's placeholder (`#123c47`) and Unity the capture's
  backdrop (`#ff00ff`): ink ΔE2000 41.72 and 2.0–3.5× the ink, on every viewport;
- an ellipsized title's line rect runs on to the whole text's width (157 px for a 66 px box at 1920×1080) into a
  neighbouring cell, whose cyan bar entered the title's most inked tenth: ink ΔE2000 2.98 against the limit 2 there,
  0.00 for the title's own glyphs;
- a section label crossed the scroll area's bottom at y 807.5 (1600×900): Chromium drew the row the edge crosses, UI Toolkit
  did not, 0.73× (and 0.69× at 1366×768) the ink.

The context now lists, per text, the elements whose overflow clips it (its ancestors and itself, by axis, at their padding
boxes), each side's clip rounded inwards to whole device pixels. The design's clip decides what must show (review
finding 2): where both renders show some of the line, the window is the rows both show; where only the design shows it,
the design's window (Unity's missing ink fails); a line the design's clip hides that Unity draws is an issue ("Unity draws
text the design's overflow clips away"); a line both clips hide is not judged (`linesClipped` in the verdict, named in
the report). A later repeat item's copy the design's clip hides entirely is not missing when Unity did not make it (a
list in a scroll area makes only the items its viewport shows). Tests: compare.test.ts (a copy below a scroll area across
an external region, a line cut by the clip on whole rows, an ellipsized title's neighbour, a virtualized list, a line only
Unity's clip hides, a line Unity draws where the design clips it); the suite's `clipped-text` fixture failed all six
viewports before and passes all six.

**Copies in nested repeats (review finding 1).** A copy's clips were first looked up by a key that wrote every repeat
level's item; the capture's boxes leave out an outer level whose item is 0 (`title#1`, not `title#1#0`). The lookup
missed, the clip came out infinite and the window NaN, and the line counted as covered: on the pilot screen 18,360 text
lines in 918 of its 942 captures were not judged, lines the comparison before Task 37 did judge. The comparison and the
capture now build the key with one function, a window that is not finite stops the comparison with an error, and every
number in this section is measured with the fix.

**Another text's line box (ruling R150).** A line's window is grown by a device pixel for anti-aliasing; at 1920×1080
`.is-untimed` two section labels lie edge to edge at x 1387.5 and 1474.5, and the margin reached the next label's first
stem in Chromium only (ink extent −4.35 px). The margin now stops at every other text's line box (both renders'); a
line's own text keeps its whole window.

**The game's render path and font twins are not the cause.** The capture renders the panel into its own target whatever
the project's pipeline. The game's twins are the kit's (the same Inter 18pt files, byte for byte; sampling point size 72,
padding 7, SDFAA, 1024 atlases). On the pilot screen's captures, with the windows above, the ink colour of every text
line of the exact viewports' default, picker, related-file and untimed states (1965 lines; the 1688 first reported
missed the nested copies of finding 1):

| Device px | Lines | Ink colour ΔE2000 median / p90 / max | Its limit |
|---|---|---|---|
| 10 (1280×720) | 295 | 0.25 / 1.15 / 3.84 | 4.5 |
| 12 (1280×720) | 179 | 0.00 / 0.72 / 3.38 | 4.5 |
| 15 (1920×1080) | 306 | 0.00 / 0.00 / 2.84 | 2 (a fragment: section 12) |
| 18 (1920×1080, 1280×720) | 188 | 0.00 / 0.00 / 0.76 | 2 |
| 20 to 54 (1920×1080 to 3840×2160) | 997 | 0.00 / 0.00 / 0.84 | 2 |

So the URP game draws small text as the Built-in sample does; the one line over its usual limit is a fragment (below).
A URP copy of the sample was not run: the game's own captures settle it.

**What the fix rounds settled** (the kept captures compared again with the final comparison of fix round 2: every
viewport passes all 157 captures; after fix round 1 1280×720 passed 143 and 1600×900 22):

- *Half a device pixel* (section 9): at 1920×1080 the cards sit at x 304.5 (406 CSS px × 0.75); UI Toolkit puts a text's
  box on whole device pixels. A status chip that the open month picker covers but for its first four glyphs (39 px,
  2.6 em) measures ΔE2000 2.84 there (18 captures): too few stems to average the half-pixel shift out (the whole chip,
  uncovered, passes). It passes as a fragment within the measured noise of its width (section 12: 3.68 at 2.5 em). The
  same cause at 1920×1080 `.is-untimed` (two section labels edge to edge) passes with ruling R150 (above).
- *A fragment beside a menu*: a status chip the type menu covers but for its last few device px, 0.78× the ink against
  0.80 (1280×720, 14 captures). The design's ink in that window is 13.4 px, under the 16 px floor of the ink amount
  (`MIN_INK_PX`) and of section 12's measurement. Since ruling R153 such a fragment is judged on its presence, its colour
  direction (0.51° against R138's 0.66°) and R141's amount band, and counted (`fragmentsBelowDomain`: the 14 captures at
  1280×720 and the same 14 at 1366×768, where it passed before at 0.05°).
- *One-pixel strokes at the scaled root* (1600×900, 12.5 device px, whole lines): a status of two one-stroke digits around
  a dash, ΔE2000 8.07 against 5.89 (135 captures; a status copy in a nested repeat that review finding 1 had left
  unjudged), and a time cell's dash, 6.13 (5 of those captures). Chromium draws each stroke on whole device pixels (the
  digits' stems one column at 203 of the green channel, the dash one row at 203; the time's dash rows 124 and 208); UI
  Toolkit lays both text boxes 0.42 device px right and down of the design's (x 511.67 against 511.25) and splits each
  stroke over two (stems 140 + 140 and 128 + 151, the dash rows 92 + 168; the time's dash 185 + 144), so its most inked
  tenth is lighter. Since ruling R152 such a line, below 13 device px at a scaled viewport with Unity's render showing it
  as a hairline line and the same text passing at every exact viewport, is judged by its colour direction: 0.03° for both
  (`docs/findings/viewport-classes.md`, "Hairline lines"). The dash was called "20" in the first report, which the
  pixels do not show.
- *The ellipsis glyph below 16 device px*: judged by its dots since ruling R148; docs/findings/viewport-classes.md,
  "Ellipsized titles of a pilot screen".

## 12. Text ink on few stems: the fragment key (rulings R149, R151, R153; Task 37 fix rounds 1 and 2)

Where something covers or clips a line down to a few stems, the ink colour (the mean of its most inked tenth) and the ink
amount rest on a handful of pixels, and the half-pixel layout differences of section 9 no longer average out (the status
chip of section 11: ΔE2000 2.84 on four glyphs, 0.00 on the whole chip). The key for such fragments is measured, not taken
from the failures it concerns.

**Method.** The suite's 4740 captures with this round's windows (every capture passing; the 2340 static ones measured,
animation samples left out), each text line's window as the comparison takes it (after clips and covers; glowing lines
left out). On every line, windows 0.5, 1, 1.5, … 4 em wide
slide along it (a quarter em apart, at most 60 positions per width); each window is measured as the comparison measures a
line (`inkIn` on both renders, the design's ink at least `MIN_INK_PX`, 16 px, the ink amount's own floor) and bucketed by
its visible width (the columns nothing covers) in half em steps and by size class (small: at most `textInkSmallPx`, 12
device px; full: larger). A line another capture shows with the same pixels on both sides is measured once (4931 distinct
lines, 49,465 repeats, in the table below). The 6 captures of `clipped-text` were measured afterwards on their own (the
first pass left out the compiler's removed wrappers, so they failed there and were skipped): 258 lines, every bucket's
highest ΔE2000 and lowest amount inside the others' (full 0.5 em 11.39 / 0.832, small 0.5 em 14.52 / 0.749), so no row
of the key changes. Fix round 2 measured again on a new suite run with the removed wrappers passed (2340 static captures,
5190 distinct lines, `clipped-text` included) and found every row's highest ΔE2000 and lowest amount the same.

| Width (em) | Small: windows | ΔE2000 p99 / max | Amount p1 / min | Full: windows | ΔE2000 p99 / max | Amount p1 / min |
|---|---|---|---|---|---|---|
| 0.5 | 23,810 | 8.68 / 18.30 | 0.848 / 0.671 | 54,743 | 2.93 / 14.56 | 0.913 / 0.455 |
| 1 | 29,096 | 6.94 / 15.03 | 0.875 / 0.671 | 49,294 | 1.95 / 9.48 | 0.942 / 0.637 |
| 1.5 | 26,108 | 5.69 / 15.03 | 0.885 / 0.671 | 43,397 | 1.53 / 7.12 | 0.951 / 0.836 |
| 2 | 23,346 | 4.95 / 15.03 | 0.891 / 0.601 | 38,410 | 1.24 / 5.75 | 0.956 / 0.899 |
| 2.5 | 20,921 | 4.70 / 10.74 | 0.894 / 0.825 | 34,296 | 1.03 / 3.28 | 0.958 / 0.902 |
| 3 | 18,684 | 4.44 / 9.73 | 0.896 / 0.847 | 30,477 | 0.98 / 2.88 | 0.960 / 0.905 |
| 3.5 | 16,780 | 4.35 / 9.00 | 0.897 / 0.846 | 27,185 | 0.83 / 2.51 | 0.961 / 0.907 |
| 4 | 15,123 | 4.28 / 9.00 | 0.900 / 0.850 | 24,392 | 0.79 / 2.51 | 0.962 / 0.910 |

The highest values come from windows of a stem or two (in `text-spacing`, `toggle`, `letter-spacing`, `repeat-items`,
`shadowed-text` and `text-shadow`), where a column more or less of anti-aliasing is the whole statistic.

**The key** (`textInkFragment` in fidelity-thresholds.json), per size class and width below 4 em: the ink colour limit is
the measured highest ΔE2000 plus 0.4 (never below `textInkDeltaE`), the ink amount's lower bound the measured lowest minus
0.02; a window takes the row of the widest width it reaches.

| Width (em) | Small: ΔE2000 / lowest amount | Full: ΔE2000 / lowest amount |
|---|---|---|
| 0.5 | 18.71 / 0.65 | 14.96 / 0.43 |
| 1 | 15.43 / 0.65 | 9.88 / 0.61 |
| 1.5 | 15.43 / 0.65 | 7.53 / 0.81 |
| 2 | 15.43 / 0.58 | 6.15 / 0.87 |
| 2.5 | 11.15 / 0.80 | 3.68 / 0.88 |
| 3 | 10.13 / 0.82 | 3.29 / 0.88 |
| 3.5 | 9.40 / 0.82 | 2.92 / 0.88 |

The colour limit is the larger of the row's and the usual one, the amount's lower bound the smaller; the ink extent, the
median check and the upper bound are unchanged.

**Colour direction where ΔE2000 scatters (ruling R151, fix round 2).** A ΔE2000 key of 9 to 18.7 checks almost nothing: a
window of a stem or two cannot tell a colour from anti-aliasing by its lightness. Where a width's measured highest ΔE2000
exceeds R126's cap of 6.5 (every small row, full 0.5 to 1.5 em) the fragment's colour is judged by its ink's colour
direction from the background instead (R138's measure: the angle between the two inks' sums of `p − b` in sRGB, which
does not depend on coverage), within the highest direction measured on the same sliding windows plus R138's margin 0.4;
the width's amount floor stays, the other widths keep their ΔE2000 key. Measured on fix round 2's run:

| Width (em) | Small: direction p99 / max | Small: key | Full: direction p99 / max | Full: key |
|---|---|---|---|---|
| 0.5 | 0.90° / 20.07° | 20.48° | 0.52° / 9.49° | 9.90° |
| 1 | 0.73° / 15.30° | 15.71° | 0.51° / 9.59° | 10.00° |
| 1.5 | 0.71° / 14.14° | 14.55° | 0.52° / 4.84° | 5.25° |
| 2 | 0.69° / 14.57° | 14.97° | 0.52° / 5.62° | (ΔE2000 6.15) |
| 2.5 | 0.66° / 4.30° | 4.71° | 0.52° / 2.82° | (ΔE2000 3.68) |
| 3 | 0.66° / 4.90° | 5.31° | 0.53° / 2.85° | (ΔE2000 3.29) |
| 3.5 | 0.65° / 3.33° | 3.73° | 0.53° / 2.81° | (ΔE2000 2.92) |

Every highest direction comes from one line: `text-shadow`'s small text with a hard shadow, whose offset copy of the
glyphs in the shadow colour lies in the line's window (its glow is no blur, so it is not a glowing line); elsewhere the
directions stay under a degree. Where a width's key would let a wrong hue pass, its colour would not be judged and the
line would be counted (`fragmentColourNotJudged`): no key does today, all lie below the kit's hue swaps of ruling R138
(the accent and warning colours in place of the secondary: 31–38° from surfaces 900 to 700), and a test fails both hues
on a fragment of every width, small and full. What the direction does not see is a lightness-only error on such a
fragment (the ruling's cost).

**Below the measured domain (ruling R153, fix round 2).** A fragment whose design ink in what shows is under 16 px has no
measured noise: it is judged on its presence (Unity draws none of it: an issue), its colour direction within R138's
0.66° and R141's amount band 0.5–2× (both as each pixel's distance from the background, summed), and counted
(`fragmentsBelowDomain`, named in the report). A sliver of another hue fails, so does a sliver Unity does not draw; a
lightness-only error within the band passes.

**Its domain.** Only a fragment takes the key: a line something covers (a later opaque element, `hidden`) or clips into,
its visible columns more than two fewer than its line box's (both renders' boxes; a clip's inward rounding to whole device
pixels takes at most a column at each end, as with a status in its own box at x 511.25 against 511.67). A whole short line
keeps its limits (rulings R126, R133, R138 and R141 set them on whole lines; a test holds four stems that are the whole
line to the usual limit). A window whose design ink is under 16 px takes R153's checks (above), a glowing line its own.
On the pilot screen the key takes the month picker's chip (18 captures at 1920×1080: 2.84 at 2.6 em against 3.68),
and over the 942 captures 1343 fragment lines in all (989 judged by their colour direction under R151, the most at
1920×1080, 354 by their ΔE2000 key), every one passing; the type menu's chip (13.4 px of design ink) is below the
domain (R153), and the two whole lines at 1600×900 are no fragments (section 11).

## Reproduction

```
scripts/fidelity.sh --out <out> docs/findings/text-ink/ink.html             # Unity against the golden as exported
scripts/fidelity.sh --out <out-lines> docs/findings/text-ink/lines.html docs/findings/text-ink/lines-bold.html  # section 6
cp -R <out>/ink/export <out>/smoothing-off
npx tsx docs/findings/text-ink/smoothing-off-goldens.mts docs/findings/text-ink/ink.html <out>/kit <out>/smoothing-off
npx tsx tools/design-export/src/cli.ts compare <out>/smoothing-off --unity <out>/ink/unity --report <out>/smoothing-off.html
DESIGN_UI_FIDELITY_ROOT=Assets/UnityCloneTest/InkHinted DESIGN_UI_FIDELITY_RENDER_MODE=SDFAA_HINTED \
  scripts/fidelity.sh --out <out-hinted> docs/findings/text-ink/ink.html      # one candidate (see FidelitySetup.cs)
```

The candidates use the setup knobs of `samples/FidelityProject/Assets/Fidelity/Editor/FidelitySetup.cs`
(`DESIGN_UI_FIDELITY_RENDER_MODE`, `_POINT_SIZE`, `_PADDING`, `_TEXT_GENERATOR`), each in its own project root. The
advanced generator also needs *Enable Advanced Text* in the project copy's UI Toolkit settings. The ink numbers are the
`ink` and `inkRatio` columns of each `verdict.json`.
