# CSS filters in UI Toolkit

| | |
|---|---|
| Date | 2026-11-13 |
| Unity | 6000.3.6f1, the verifier capture (`R8G8B8A8_UNorm` target, `forceGammaRendering` on), batchmode on Metal |
| Chromium | Chrome Headless Shell 158 (Playwright 1.65.0) on macOS |
| Fixture | `design-kit/fixtures/fidelity/filters.html`: each function on a solid tile with text (`#16c2d5`, dark text) and on a three-stop 135° gradient tile, a chain `grayscale(0.5) contrast(1.2) blur(2px)` and `grayscale(1)` on `:hover` |

## What UI Toolkit 6000.3 has

- USS property `filter` (`IStyle.filter`, `StyleList<FilterFunction>`), a space-separated list of functions or `none`.
- Built-in functions (`FilterFunctionType`, names from `FilterFunctionDefinitionUtils.GetBuiltinFilterName`): `tint`,
  `opacity`, `invert`, `grayscale`, `sepia`, `blur`, `contrast`, `hue-rotate`, plus custom functions defined by a
  `FilterFunctionDefinition` asset (`filter(<asset>, …)`).
- One parameter each. The USS reader converts `%` to a fraction, `deg`, `grad` and `turn` to radians and keeps other
  values as written (`StyleProperty.ConvertDimensionToFilterFloat`), so `blur(4px)` is a Gaussian with sigma 4 px (two
  passes, margins `3σ + 1`), as CSS's standard deviation.
- `tint` takes a colour; the others a number. The colour functions are one 4×4 matrix plus offset on premultiplied colour
  in the panel's colour space (gamma in the verifier): grayscale and sepia use CSS's matrices, contrast `c·x + (1 − c)/2`,
  hue-rotate CSS's rotation matrix, invert and opacity CSS's formulas.
- CSS functions without a counterpart: `brightness()`, `saturate()`, `drop-shadow()` and `url()`.

## Mapping

`StyleMapper.FilterValue` writes CSS `filter` to USS `filter` with the same function names: each function's argument is
checked (blur a px length, hue-rotate an angle written in deg, the others a number or %) and written explicitly (a
missing argument as CSS's default). Only the functions that `css-support.json` lists under `filter.functions` pass; any
other is rejected as U-CSS-015 with the property's fix. The lint reads the same list.

## Measured

Element SSIM (plain / with 1-px offsets) and largest colour ΔE2000 per tile, all three viewports, with every function
enabled for the measurement. The unfiltered gradient tile is the baseline: 0.984 / 0.992 at 2560, 0.988 / 0.992 at
1920 and 0.981 / **0.988** at 1280 (it failed 1280 without any filter: the baked gradient ignored the tile's rounded
corners, fixed since, see [gradients.md](gradients.md); the tile is now 0.997 at every viewport).

| Function | Solid tile with text | Gradient tile | Result |
|---|---|---|---|
| `invert(1)` | SSIM ≥ 0.9905, ΔE ≤ 0.22 | 0.985 / 0.992, 0.988 / 0.992, 0.985 / 0.990 | **passes at 2560, 1920 and 1280** |
| `blur(4px)` | SSIM ≥ 0.9992, ΔE 0.06; at 1280 the text's ink amount is 1.00× the design's against the capture's 0.83× median (+20 %, limit ±20 %) | ≥ 0.9955 (better than the baseline) | fails at 1280 (ink amount) |
| `grayscale(1)` | SSIM ≥ 0.9993, ΔE 0 | 0.981 / **0.9897** at 2560, 0.986 at 1280 | fails at 2560 and 1280 (worse than the baseline) |
| `hue-rotate(120deg)` | SSIM ≥ 0.9997, ΔE 0 | 0.9907, 0.9913, **0.9874** | fails at 1280 |
| `sepia(0.8)` | SSIM ≥ 0.9994, ΔE 0 | 0.9902, 0.9906, **0.9870** | fails at 1280 |
| `opacity(0.5)` | SSIM ≥ 0.9974; text ink ΔE **3.14** at 2560 and 1920 (limit 3) | ΔE **1.02** at 2560 (limit 1) | fails at 2560 and 1920 |
| `contrast(1.6)` | SSIM **0.966–0.982**; the dark text comes out `#340c09` against Chromium's `#000000` (ΔE 16–19) | 0.977–0.984 / 0.986–0.990 | fails everywhere |
| chain, `:hover` grayscale | SSIM ≥ 0.9993 | – | pass (but use disabled functions) |

**Opacity, re-measured** with the rounded-gradient fix and the smoothing-off ink thresholds (an `opacity(0.5)` text tile,
gradient tile and hover): the text comes out darker than Chromium's (`#06151c` against `#081b21`, ΔE 3.14, limit 2)
with 0.81–0.87× of its ink at 1920 and 1280 (band 0.90–1.10×), and the gradient tile's colour is ΔE 1.02 at 2560
(limit 1). It stays rejected.

**Decision.** `filter.functions` in `css-support.json` is `["invert"]`: the only function whose tiles pass at all three
viewports. A screen with just the invert tiles and an `invert(1)` hover passes 6/6 captures. The others stay rejected
with the U-CSS-015 fix. On solid colours grayscale, hue-rotate, sepia and blur already match; their failures are the
gradient ramp's banding, which the colour matrices move further from Chromium's smooth gradient, and the per-capture
ink-amount check on blurred text. Contrast clips dark text to a reddish dark instead of black; opacity is off by a hair
in text colour.

## Reproduction

```
cp -R design-kit <kit> ; set "filterFunctions" in <kit>/kit.config.json and filter.functions in
  packages/com.ertugrulgaziakcan.design-ui/Editor/Data/css-support.json to the functions to measure
scripts/fidelity.sh --kit <kit> --out <out> design-kit/fixtures/fidelity/filters.html
```

The per-tile numbers are the `ssim`, `ssimShifted` and `deltaE` columns of `<out>/filters/verdict.json`.
