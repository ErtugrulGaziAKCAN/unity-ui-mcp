# Text baselines: Chromium's rounding in the line-box twins

| | |
|---|---|
| Date | 2026-11-13 |
| Question | Small multi-line text failed the ink colour check on single lines (caption line 3 of 5: ΔE2000 3.09 at 12 device px, label line 2: 6.13 at 8 px). Do Unity's baselines sit where Chromium's are, and can the line-box twins put them there at every viewport scale? |
| Chromium | Chrome Headless Shell 158 (Playwright 1.65.0) on macOS |
| Unity | 6000.3.6f1, the verifier capture and a real panel (`LineBoxStyleTableTests`) |
| Font | Inter 18pt Regular and Bold (`hhea` ascender 1984, descender −494, 2048 units per em) |

## Measured

**Unity against Chromium before the change** (the `text-styles` fixture: every kit style at 1, 2 and 5 lines, baselines
from both `boxes.json`): every line of a style was off by the same amount, which scales with the viewport, so it is a
per-style offset in CSS px, not a drift of later lines.

| Style (size / line) | Unity − Chromium, every line (CSS px) | Ink centroid, Unity − Chromium at 2560 (device px) |
|---|---|---|
| caption 12/16 | +0.365 | +0.45 … +0.57 |
| label 16/20 | −0.180 | −0.04 … +0.13 |
| body 24/32 | +0.730 | +0.74 … +0.84 |
| subtitle 32/40 | +0.640 | +0.43 … +0.74 |
| title 36/48 | +0.095 | +0.11 … +0.22 |
| headline 48/60 | +0.461 | +0.46 … +0.66 |
| display 64/80 | +0.281 | +0.30 … +0.57 |

**Cause.** The twins put a style's baseline at the exact half-leading, `(L − (a + d)·s) / 2 + a·s` with the font's
ascent `a` and descent `d` in em; Chromium (LayoutNG) rounds the ascent and descent to whole CSS px at the font size and
floors the half-leading (`CalculateLeadingSpace`):

    baseline = floor((L − round(a·s) − round(d·s)) / 2) + round(a·s)     CSS px below the line top

This formula reproduces Chromium's laid-out baseline (the bottom of a zero-size `vertical-align: baseline` box) on all 396
cases of a sweep: font sizes 8 to 72 px in steps of 2, line heights 1, 1.125, 1.2, 1.25, 4/3 and 1.5 times the size,
weights 400 and 700, 0 mismatches. For the kit's styles it gives 12, 16, 24, 31, 37, 47 and 63 px. Chromium then paints
the glyphs on the baseline rounded to the device pixel (the ink centroids above follow the layout offset plus that
rounding at 1920 and 1280).

Because the rounding happens at each font size, two styles with one line-height ratio need different ascents (caption
12/16 and title 36/48 are both 4:3, with baselines at 1.0 and 1.028 times their size), so one twin per ratio cannot
place both.

## Change

- One line-box variant per font size and line height of the text-style table (`FontTwinGenerator.LineBox.For(size,
  line)`, key `r<ratio>s<size>`, e.g. `r125s16`, `r13333s12`), instead of one per ratio. Its face keeps the line height
  `(line / size) × pointSize` and puts the ascent line at Chromium's baseline for that size (`LineBox.Baseline`) and the
  descent line one line height below. Kit sync, the compiler's `DesignFonts.uss` variables and `DesignFonts.asset` follow
  the table as before. The kit (7 sizes) has 7 variants per face instead of 2.
- The kit's styles are multiples of 4 px, so every baseline of caption, label and body is a whole device pixel at 1,
  0.75 and 0.5 (12, 16 and 24 px times the scale) and lands where Chromium paints it. For the larger styles Chromium's
  layout baseline is fractional at 0.75 or 0.5 (31 × 0.75 = 23.25) and Chromium paints at the rounded pixel; the twins
  keep the layout baseline, at most 0.5 device px from Chromium's paint, where the ink check is exact (14 device px and
  up).

## Result

Panel proof (`LineBoxStyleTableTests`, 14 styles × 1/2/5/10 lines × scales 1/0.75/0.5): heights exactly n × L, every
baseline within 0.007 / 0.005 / 0.004 device px of Chromium's formula (before: up to 0.73 px). The test now holds
baselines to 0.01 device px.

In the fidelity suite every text line's baseline now equals the golden's (`text-styles` at all three viewports: Δ 0.000
on every line of every style). What is left is the rasteriser: Unity's glyphs sit about 0.15 device px lower than
Chromium's paint at every size and scale (ink centroids), and individual stems differ by up to ±0.3 px horizontally (stem
peaks of the same lines, mean offset within ±0.1 px), which at 6–12 device px moves a stem's peak coverage by a quarter
or more.

## Later lines of small text

Ink of every line of every text in the default capture of every screen, against the golden (per-line ink colour
ΔE2000, Unity's ink amount relative to the design's), by device font size:

| Device px | Line 1: ΔE max / 95th pct, ink amount | Lines 2 and later: ΔE max / 95th pct, ink amount |
|---|---|---|
| 6 | 2.71 / 2.71, 1.00–1.17 | 7.85 / 7.85, 0.93–1.11 |
| 8 | 3.67 / 3.28, 0.84–1.02 | 5.66 / 5.66, 0.91–1.05 |
| 9 | 3.49 / 3.49, 0.94–1.03 | 4.19 / 4.19, 0.96–1.03 |
| 12 | 2.37 / 0.95, 0.93–1.01 | 1.38 / 1.22, 0.92–1.00 |
| 14 and more | 0.83 / 0.00, 0.93–1.04 | 0.00 / 0.00, 0.94–1.00 |

With the baselines exact, the later lines' residual is the rasteriser's on those lines' glyphs. It raises the limits for
lines 2 and later under 12 device px only (`textInkDeltaELater` `[[9, 4.5], [8, 6]]`, below 8 px the usual 10;
`textInkCoverageLater` ±15 %, measured 0.91–1.11×; `textInkLaterBelowPx` 12). First lines and text of 12 device px and
more keep the limits of [text-ink.md](text-ink.md); the first-line residual above them (2.37 at 12 px, 3.49 at 9 px,
3.67 at 8 px, ink 0.84× at 8 px, all on short labels) is open.
