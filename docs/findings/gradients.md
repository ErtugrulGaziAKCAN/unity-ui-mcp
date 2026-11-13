# Gradients on rounded elements

| | |
|---|---|
| Date | 2026-11-13 |
| Symptom | A 280×200 px tile with `border-radius: 16px` and a three-stop 135° `linear-gradient` failed element SSIM at 1280×720 with no filter at all (0.981, 0.988 with 1-px offsets; limit 0.99), and passed only with offsets at 2560 and 1920 |

## Cause

The exporter bakes a gradient into an SVG that the importer turns into a VectorImage background. **UI Toolkit draws a
vector background image unclipped by the element's `border-radius`**: the gradient's square corners paint where CSS
clips the background to the rounded border box. In the 1280 capture the corner pixel (0, 0) of the tile is the gradient's
first colour `#f2b544` in Unity and the screen background `#0b1f26` in Chromium.

Ruled out, measured on the same tile: the ramp's resolution and sampling (inside the tile, away from the corners, every
pixel is within 2 levels of Chromium's, mean ΔE2000 0.20–0.23 at all three viewports), and sRGB vs linear interpolation
(the same agreement holds along the whole gradient line). The 64-step ramp is not visible at these sizes. A remaining
difference is a faint anti-aliasing fringe of the vector image one device pixel outside the box (about 6 % of the
gradient colour); it does not affect the element's SSIM.

Restoring Chromium's corner pixels in the Unity capture (a simulation) gives element SSIM 0.9974 / 0.9975 / 0.9976 at
2560 / 1920 / 1280; restoring only the fringe outside the box changes nothing (0.984 / 0.988 / 0.981). The share of
corner pixels grows as the tile shrinks, which is why 1280 failed first.

## Fix

The exporter now cuts each painted gradient shape to the rounded border box (`bake/gradient.ts`, `radii` from the
element's resolved corner radii in `extract/effects.ts`): a shape that covers a box corner becomes a path with that
corner's arc. An SVG `clipPath` does not work: the importer's anti-aliased tessellation (`AntialiasedArcEncodings`)
ignores clip paths (measured: identical captures with and without it). With the rounded shapes the tile's element
SSIM is 0.9968 / 0.9972 / 0.9965 at 2560 / 1920 / 1280, with no 1-px offsets needed. A repeated gradient tile that
reaches into a corner's radius square without covering it stays square (only tiles smaller than the radius do that).

No threshold changed.
