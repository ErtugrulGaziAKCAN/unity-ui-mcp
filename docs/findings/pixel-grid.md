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

## Second round

**Chromium paints boxes on whole CSS px.** Blink snaps a box to whole CSS px in layout space and applies the device
scale when rastering. At scale 0.75 a box laid out at 180.996 device px (241.33 CSS px, after a content-sized button)
paints from 241 CSS px, 180.75 device px: its first column is a quarter covered, while UI Toolkit (Yoga) puts the edge on
181. Measured on the kit buttons at 1920: the left border's pixels are `18,48,57` (a quarter of the border colour) and
`36,91,103` (three quarters) in the golden, full in Unity. Any element whose CSS edge is not a multiple of 4 px paints
such an anti-aliased row or column at 1920 or 1280. The comparison now uses Chromium's painted rect (`paintedRect`):

- a border's colour is sampled on the pixels both renderers cover fully (one pixel, or a 3×3 mean where three or more
  are; the third round below moves it to the centre of each painted band), and corner samples whose 3×3 mean straddles
  a border's inner edge are left out — the sample measures the border colour, the box check its position;
- the one-pixel row or column of a painted edge the design draws off the device grid is copied from the design before
  SSIM, like text (`offGridEdges` in the verdict); the box check measures where that edge is.

Before, 99 captures failed only on such samples at 1920 (button, dialog, tabs, pseudo-states); after, none.

**Baked shadows on the grid.** A baked outer shadow's image reached out from the box by its own extent (27 and 19 px for
`0 8px 24px`), so at 0.5 its texels started half a device pixel off the box and a hard ring (the kit card's selected
`0 0 0 4px` ring) came out a pixel thinner. The bake now pads the image with transparent margin to multiples of the step
that is whole at every declared viewport (4 px for 1, 0.75 and 0.5; `scaleStep`/`wholeBorderWidths`), so its texels
start on the device grid wherever the box does. Hard edges (a shadow without blur) whose offset or spread is not whole
device px at every viewport (a 6 px spread ring is 4.5 px at 1920) are U-CSS-040 errors like border widths.

**Stacking contexts in states.** A layer that gives a static element a transform (or opacity, or a position) makes CSS
paint it — with its shadow — after every in-flow element of the screen; UI Toolkit keeps hierarchy order. The exporter's
effects screen showed it: on `:hover` a card's `translateY(-4px)` and its larger shadow painted over the next card and the
panel below in the golden, under them in Unity (shadow band ΔE 1.72, panel colour ΔE 1.07 at every viewport). Lint
U-CSS-041 rejects a static element that becomes a stacking context in some layer while its box, translate or outer
shadow reaches a later in-flow element; the fix is room for the shadow (the effects screen now has 48 and 64 px gaps).

**Breakpoints in the Unity capture.** Nothing put the `bp-<name>` classes on the compiled screen root, so a breakpoint
layer never applied in the capture (the effects screen's `@media (max-width: 1600px)` hero was 43 px too tall). The capture
now adds the breakpoints that hold at the capture's viewport (`DesignCapture.ActiveBreakpoints`, the exporter's rule:
logical size under Scale With Screen Size, rounded, against min/max width and aspect). The runtime controller that
toggles them in a game is still to come (spec: `BreakpointController`).

**Coverage viewports on the scale step.** The viewport added for a breakpoint no declared viewport reaches was the width
nearest the declared one with a near-whole logical size: 853×1080 for `max-width: 1600px`, scale 0.5417, where a 16 px
font is 8.67 device px (UI Toolkit rounds it to 9) and every box drifts. It is now the nearest width whose scale is a
multiple of the declared scales' step (0.25): 640×1080 at 0.5, where the design's lengths are as whole as at 1280×720.
The near-whole fallback stays for steps that do not exist. Such a viewport has another aspect than the 2560×1440 screen
(640×1080 is 1280×2160 logical px): below the screen the golden shows the page's background and Unity the panel's clear
colour, so the comparison leaves the area outside the screen root out (`outsideScreen` in the verdict); every element of
the effects screen passes there.

**Disabled and focused.** Unions of `:disabled` with `:focus` or `:active` on the same element are not captured: no
browser and no UI Toolkit panel focuses or presses a disabled control (the capture said so for every such job).

## Third round: thin lines and border sides

The second round's edge mask reached too far. It went into the masks colour samples consult, and a sample there keeps
its whole 3×3 neighbourhood clear of them, so:

- the border sample sits on the first fully covered pixel next to an off-grid outer edge, and was refused on every
  off-grid side at 0.5 and on the top and left sides at 0.75: a bordered text element at 1280 could keep no border colour
  check at all;
- a line about 2 device px thick or less (1 CSS px at 0.75 is 97.5 to 98.25 device px) is all edge rows: the mask copied
  all of it, its colour points were refused, and a divider UI Toolkit rounds to 0 px (top 97.5 → 98, bottom 98.25 → 98)
  passed at 1920 and 1280.

Now:

- the off-grid rows are SSIM masks only; a colour sample is refused only when a pixel it averages is one of them (its
  neighbourhood stays clear of text alone);
- each border side is sampled across at the centre of the band each renderer paints, so every side is sampled (for a
  border of 2 device px or more that pixel is fully covered in Chromium); a 3×3 mean only where it stays on fully
  covered pixels;
- the mask never takes all of an element's rows or columns;
- a painted element thinner than 8 device px is a line: it is sampled one pixel at a time on each renderer's centre
  line; a line Unity rounds to 0 px is a box issue, and a line left without a sample that later elements do not cover
  fails.

Lint U-CSS-040 keeps such lines reproducible: a painted box thinner than 8 CSS px must be whole device px at every
declared viewport (4 px with 1, 0.75 and 0.5), because UI Toolkit rounds both of its edges to whole device px and a
thinner line can vanish.

**Stacking, positioned elements too.** U-CSS-041 skipped an element positioned in its base style, yet a `position:
relative` card paints with its shadow after every in-flow element of its stacking context, so its base or hover shadow
lay over a later static panel in Chromium and under it in UI Toolkit, and the rule's own fix applied halfway passed. It
now asks the shared paint-order module for both orders, for every element and layer (base included) against each later
painting element its box, translate (also from a `transform`) or outer shadow reaches: CSS's between the two elements'
participants in their closest common stacking context, UI Toolkit's as the compiler orders the siblings under their
closest common parent. Box overlaps in the base style that U-CSS-032 already reports are left to it. The layout fixture's
rotated and scaled square reached 2 px into the next panel and got the room.

## Open

Resolved in the second round: group opacity (U-CSS-039 and the kit's disabled colours, [opacity.md](opacity.md)),
fractional borders (U-CSS-040, [borders.md](borders.md)), small elements and pictures
([ssim-small-elements.md](ssim-small-elements.md)), later-line baselines ([text-baselines.md](text-baselines.md)).

Still open: single lines of text at 6 to 12 device px whose ink colour or amount misses the limits calibrated on one
30-character line per style (the suite's short labels: ΔE up to 3.67 at 8 px and 2.37 at 12 px, ink 0.84–0.90× at 6–8
px), and text shadows whose ink amount is 1.11–1.17× the design's.
