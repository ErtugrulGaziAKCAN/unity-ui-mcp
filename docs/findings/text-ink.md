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
- The cost: a colour error of up to ΔE 4.5 on text of 12 device px or less passes (at 1280 wide that is any kit style up
  to 24 px). The same text at 2560 wide is 14 device px or more for the kit's larger styles and keeps the ΔE 2 limit there.

**Readability warning W-TXT-001.** Text this small is also hard to read, and no renderer measures it exactly, so lint
warns (a warning, never an error) for every kit text style a design uses that comes out under 10 device px at the
smallest viewport the kit declares: at 1280 wide, the 12 px caption (6 device px) and the 16 px label (8). It names the
style, how many elements use it and the device size, and its fix points to the smallest kit styles that stay readable.
The rule judges the kit's table, so it does not ask for another font size than the kit has; it is a prompt to choose
larger styles where the design allows it.

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
