# Border widths at fractional viewport scales

| | |
|---|---|
| Date | 2026-11-13 |
| Question | How do Chromium (the golden, rendered at the exporter's `deviceScaleFactor` 1, 0.75 and 0.5 for 2560×1440, 1920×1080 and 1280×720) and UI Toolkit (Yoga pixel rounding, the verifier panel) snap a border's width and the box it encloses? Is there a width the compiler could write per border so that Unity's rounding lands where Chromium's does at every scale? |
| Chromium | Chrome Headless Shell 158 (Playwright 1.65.0) on macOS |
| Unity | 6000.3.6f1, the verifier capture (Scale With Screen Size, `R8G8B8A8_UNorm`, `forceGammaRendering`) |
| Fixture | [`borders/borders.html`](borders/borders.html): 120×48 boxes on whole device pixels with a white border of 1, 2, 3, 4, 5, 6, 8 and 12 px around a red child that fills the content box, the same with `border-radius: 12px`, and 360 px bars with a bottom border followed by a line of text |

## Measured

Painted border width in device px (the sum of the white coverage across the left border at mid height) and where the
child (the content box) starts, Chromium / Unity. Rounded boxes give the same numbers.

| CSS width | scale 1 | scale 0.75 | scale 0.5 |
|---|---|---|---|
| 1px | 1 / 1, child at 1 / 1 | **0.56 / 1**, child at **0.75 / 1** | **0.25 / 1**, child at **0.5 / 1** |
| 2px | 2 / 2 | **1.25 / 2**, child at **1.5 / 2** | 1 / 1 |
| 3px | 3 / 3 | **2.06 / 2**, child at **2.25 / 2** | **1.25 / 2**, child at **1.5 / 2** |
| 4px | 4 / 4 | 3 / 3 | 2 / 2 |
| 5px | 5 / 5 | **3.56 / 4**, child at **3.75 / 4** | **2.25 / 3**, child at **2.5 / 3** |
| 6px | 6 / 6 | **4.25 / 5**, child at **4.5 / 5** | 3 / 3 |
| 8px | 8 / 8 | 6 / 6 | 4 / 4 |
| 12px | 12 / 12 | 9 / 9 | 6 / 6 |

- **Chromium** floors the computed `border-width` to whole CSS px (1.25px, 1.5px and 1.75px compute to 1px, 2.5px to
  2px; anything above 0 below 1 to 1px; measured on a separate page at all three scales) and then lays the border out
  and paints it at its exact device width: 2px at scale 0.75 is 1.5 device px, one solid pixel and one anti-aliased
  pixel, with the content 1.5 px in. Nothing snaps to the device grid. (The coverage sums are below the width where the
  anti-aliased pixel is shared with the red child: Chromium blends the two edges in one pixel.)
- **UI Toolkit** lays out and paints a border as whole device pixels: `round(width × scale)`, halves up, at least 1
  (0.5 → 1, 1.5 → 2, 2.25 → 2, 2.5 → 3, 3.75 → 4, 4.5 → 5), and the content box starts there.
- A bar's border-box height is the same on both sides (the border is inside `box-sizing: border-box`), so the text after
  it does not move; a content-sized element (a tab bar) grows by the rounded border, and what follows moves with it (the
  tabs panel was 1 px low at 1920×1080, which with the line-box baseline offset gave its baseline +1.55 px).

## Decision

No width the compiler could write makes UI Toolkit paint a fraction of a pixel, so a border matches Chromium at a scale
only when its CSS width times that scale is whole. A width that is whole at every viewport the kit declares compiles as
it is (UI Toolkit's rounding is then exact); any other width has no equivalent at some scale. For the kit's scales 1,
0.75 and 0.5 the widths that work are the multiples of 4 px.

- Lint **U-CSS-040** rejects a border width (declared in any rule, inline style or keyframe; `thin`, `medium`, `thick`
  as 1, 3 and 5 px; Chromium's floored value) that is not whole device px at every viewport of the kit, naming the
  viewport and the device width, with the fix listing the widths that work (computed from the kit's viewports: 4px,
  8px, 12px …). A width whose border style is `none` is not judged (`border: none` sets every width to `medium`).
- The kit and the fidelity fixtures use 4px borders where they had 1, 2 or 3px (and 8px, 12px, 16px, 20px for 6, 10 and
  18px); the tabs' overlap margin follows (−4px).
- Outlines are rejected anyway (U-CSS-023, UI Toolkit has none).

## Reproduction

```
scripts/fidelity.sh --out <out> docs/findings/borders/borders.html
# golden: <out>/borders/export/goldens/<capture>.png, Unity: <out>/borders/unity/<capture>.png, boxes in boxes.json
```

The scan reads one row through the middle of each box's left border in both PNGs and the child's box from the two
`boxes.json`.
