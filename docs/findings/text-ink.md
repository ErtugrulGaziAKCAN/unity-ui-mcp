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

**Cause: the golden's macOS font smoothing, not Unity.** Chromium on macOS draws text with CoreText font smoothing
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

| Key | Value | Measured |
|---|---|---|
| `textInkDeltaE` | 3, from `textInkFullPx` = 14 device px | 0 for every line of 14 px and more |
| `textInkDeltaESmall` | ≥ 12 px: 5; ≥ 9 px: 10; below: 14 | largest 3.90 at 12 px, 7.96 at 9 px, 11.32 at 8 px, 9.46 at 6 px |
| `textInkRatio`, `textInkCoverage` | 0.76, ±15 % (unchanged): 0.65–1.15× | 0.69–1.03× for correct text |
| `textInkMedianTolerance` | ±20 % of the median ratio of the capture's text of the same polarity | −12 % to +16 % around the light-text and the dark-text median (one capture-wide median: up to +26 %) |

- The font size is the element's `font-size` in the capture (the IR's layer that holds) times the capture scale; an
  export without IR uses the line box height ÷ 1.25.
- The median comparison groups lines by polarity (ink lighter or darker than its background), because the smoothing
  thickens light text more: one capture-wide median put correct dark text 26 % above it.
- What the calibration still catches: a wrong hue or a clearly wrong lightness at any size (yellow drawn for white is
  ΔE 29), any colour error on text of 14 device px and more, a regular face drawn where the design has bold (0.74× of
  the bold ink in Chromium; with the renderer's own ratio below the band's 0.65×) and a wrong size. What it gives up: a
  slightly lighter or darker text colour on text below 12 device px.
- Effect on the screens measured before: `squad` and `effects` pass at all three viewports (their only failures were
  small-text ink); `clock` still fails only in its `busy` state, whose keyframe animation is not played yet.

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
  multiples of 4 px (ratios 1.25 and 4/3), and every ratio of the table gets its own line-box twin.

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
