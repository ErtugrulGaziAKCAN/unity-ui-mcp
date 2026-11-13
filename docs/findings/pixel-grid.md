# Combined fidelity run: pixel grid, controls and what the verifier compares

| | |
|---|---|
| Date | 2026-11-13 |
| Run | `scripts/fidelity.sh` over the 9 kit components and the 13 fidelity fixtures, 2560×1440, 1920×1080 and 1280×720 |
| Unity | 6000.3.6f1, UI Toolkit runtime panel as in spec §15 |

The first combined run passed 122 static captures and failed 559; four fixtures did not import. Each failure class was
traced to its cause before anything changed. This page records the causes, the fixes and what is still open.

## UI Toolkit rules the golden reproduces

The golden is Chromium's rendering of the design. Where UI Toolkit follows a fixed pixel-grid rule that Chromium does
not, the capture applies UI Toolkit's rule to the golden page, so the comparison measures what the compiler controls.

**Text-sized boxes.** UI Toolkit rounds a text element's measured size up to the device-pixel grid
(`TextUtilities.PostProcessMeasuredSize`, `AlignmentUtils.CeilToPixelGrid`, 6000.3 reference source). Evidence: the kit
buttons' text widths agree to 0.01 px (80.891 / 80.888 px), but their boxes are 148.891 and 149 px, and the boxes after
them on the row move by the sum (the fourth button +2.03 px). Every content-sized button and tab failed the box check
for that sum alone. The golden now gives an IR text element whose content width is its one-line text width that width
rounded up to the device grid (`capture.ts`, `pageTextCeil`).

**Border widths.** UI Toolkit lays out and draws border widths as whole device pixels: a 2px border at scale 0.75
(1.5 device px) takes 2, a 3px border (2.25) takes 2. Chromium lays out 1.5 and paints one solid pixel plus an
anti-aliased one, and it floors `border-width` to whole CSS px, so the golden cannot be given a 2-device-px border at
0.75 by CSS. The text-sized width above includes the borders as Unity lays them out, which removes the box drift; the
painted band still differs at 1920 (open item 2).

**Fonts loaded late.** A state that shows text in a face nothing else used yet loads that face only when the text is
laid out; the width was measured with the fallback face, and the text then wrapped in the golden. The capture now
measures after the fonts are ready.

## Capture and comparison fixes

| Failure | Cause | Fix (owner) |
|---|---|---|
| A checked radio drawn unchecked in every golden | Radios grouped by `name`: checking one in a capture unchecked its group, the restore left the group empty | Radios are independent in the capture, as UI Toolkit toggles are; the page is given back (`capture.ts`) |
| Keyframe elements ±60 px off | The golden shows every animation frozen at its end frame (fill both); the Unity capture showed the base style | The golden records the animations in effect per static capture (`matrix.json` `frozen`); the Unity capture writes their end frame as inline styles (`FrozenFrames`) |
| A state's `translate: 24px 0` moved 24 px down too | CSS `translate` with one value moves along x; USS repeats a single value for y | The mapper writes the y (`StyleMapper`) |
| Icons stretched over their element | The importer sizes a VectorImage by its shapes' bounds; `PreserveViewport` does not apply to VectorImage | The exporter pins every svg's viewBox with a transparent rect (`pinViewBox`) |
| Edge and corner samples ΔE 1.1–5.5 on correct shapes | Samples sat on rounded corners' anti-aliased curves, where the two renderers' anti-aliasing differs | Ring and colour samples stay off the curves (the context knows each element's radii), and colour samples are taken where the design is flat |

Imports that failed, each fixed where the decision belongs:

- an input's `value` (the exporter's text for a field) is the TextField's value; a password field masks with U+2022 and a
  `textarea` is multi-line (IR `field`);
- the placeholder takes the `::placeholder` colour, and the field's parts are laid out as Chromium lays out an input
  (one line centred vertically, a text area's at the top);
- a list repeat's padding and margins of 0 are no box of its own;
- `overflow-wrap: break-word`, a textarea's browser default, is what UI Toolkit does anyway (dropped);
- a `data-u-id` that names a member every view class declares (`state`, `find`, …) is now lint U-MRK-011.

Ruled out: mipmaps for scaled-down pictures (UI Toolkit samples the top level; identical captures with and without).

## Open

1. **Group opacity.** CSS applies `opacity` to the composited element; UI Toolkit multiplies it into each part, so a
   translucent element's background shows through its border, text and children. A disabled button at 0.4: text ink
   ΔE 13.7–23.8, border ΔE 1.34; a nested swatch ΔE 6.89. Reproducing it needs a lint rule and kit disabled styles
   without opacity.
2. **Fractional borders at 1920.** 2px and 3px borders paint differently (above); element SSIM 0.93–0.97 on bordered
   tabs, buttons and fields at 1920.
3. **Anti-aliasing and resampling inside small or picture elements.** Element SSIM 0.984–0.989 on 72 px radios, round
   checks and pictures drawn scaled (identical shapes; the limit 0.99 comes from M0's flat fixtures).
4. **Small text.** Later lines of multi-line text sit at fractional baselines in Unity (+0.36 px at 12 px); ink colour
   ΔE up to 3.09 at 12 px, 6.13 at 8 px, coverage 0.86× at 8 px. The step-A measurement covered single lines.
