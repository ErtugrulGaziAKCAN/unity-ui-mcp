# Animation player

| | |
|---|---|
| Date | 2026-11-14 |
| Question | Can UI Toolkit play the design's transitions and keyframe animations one to one (CSS timing, every trigger, no frame of the wrong value, nothing allocated per frame), and does every animation sample of the fidelity suite match Chromium's? |
| Chromium | Chrome Headless Shell 158 (Playwright 1.65.0) on macOS |
| Unity | 6000.3.6f1, the verifier capture (`R8G8B8A8_UNorm` target, `forceGammaRendering` on); UI Toolkit source read at UnityCsReference 6000.3 |

## How the player gets its triggers

The compiler writes each animated element's data as USS custom properties in the rules that set the animated values
(`DesignAnimationData`): `--dui-t-<property>: "<value>|<duration> <delay> <timing>"` in base and in every layer that
sets the property, `--dui-a` (the animation list) in base and in every layer that triggers animations, `--dui-k-<n>`
(keyframes) in base. UI Toolkit's own cascade then hands the player the data of the rule that wins, so every trigger
(a state, an `is-*` class, a pseudo-state, a mirrored shadow host, a breakpoint class) is the same event.

Measured on 6000.3.6f1 (probe test, deleted):

- `CustomStyleResolvedEvent` reaches an element that has custom properties on hover, focus, `SetEnabled(false)`, its own
  class and an ancestor's state class, during the style pass of that frame
  (`VisualTreeStyleUpdaterTraversal` sends it with `SendEventDirectlyToTarget` after the element's new style is set).
- An inline style written in that callback changes the computed style at once (`InlineStyleAccess.ApplyStyleValue`), so
  the frame is drawn with it: after a hover the RenderTexture showed the old colour in every frame while the callback
  held it (never one frame of the new rule's colour).
- Removing an inline style (`StyleKeyword.Null`) applies the rule's value at once (`RemoveInlineStyle` from the style
  cache), which is how a transition hands the property back.
- Custom properties are not seen by a child without its own (no event), so every animated element declares all of them
  in its base rule.
- Writing colour, opacity, translate, rotate, scale and border colours inline allocates 0 bytes.

Repeat items change identity without a style pass of their own: a ListView slot is bound to another index while it
scrolls, and a pooled inline item is hidden and shown again through an inline `display`, which raises only a styles
and layout version change (no `StyleSheet` change, so no `CustomStyleResolvedEvent`). The repeat helpers therefore call
`DesignUiAnimationPlayer.Snap(subtree)` when a slot is bound to another index and when a pooled item is shown or
hidden: the subtree's transitions and animations end and hand their properties back at once, and a class added and
removed on the subtree root (a `StyleSheet` change, which restyles the subtree) makes its next style a first style, in
the same style pass as the bind's own class changes. A shown item plays its show animations again and never transitions
from the item the slot showed before; a hidden item stops animating.

## What the player animates

Colours (text, background, border sides, an icon's tint), `opacity`, `translate`, `rotate`, `scale` and border radii.
For these `resolvedStyle` is the computed value (UnityCsReference 6000.3 `ResolvedStyleAccess`: radii are
`computedStyle.border*Radius.value`, colours and transforms likewise), which the player needs as the underlying value of
an implicit 0 %/100 % keyframe and as the own value of a transition that names no value. Box lengths are not: `width`,
`height`, insets, margins, paddings and border widths read the Yoga layout (`layoutNode.LayoutWidth`, …), NaN before the
first layout, 0 after `display: none`, px for `auto` and %. Layout properties therefore never animate: keyframes of them
fail U-CSS-013 and transitions of them U-CSS-042, both with the fix to animate `translate` or `scale` instead (a layout
pass per frame was also the cost W-CSS-001 warned about; that warning is retired).

U-CSS-042 also rejects a transition of any other property CSS interpolates and the player does not (`letter-spacing`,
`visibility`, `filter`, `text-shadow`, …), when `transition-property` names it or, with `all`, when a layer changes it
(a transition of a discrete property such as `display` switches in CSS as in the player and passes). U-CSS-043 rejects
keyframes and a transition of the same property on one element: while both run CSS shows the transition over the
animation, and the player plays one value per property.

## Timing

`DesignTimingFunction` and `DesignAnimationData.Progress`/`Evaluate` against Chromium (`getComputedTiming().progress`
of `el.animate()` and `getComputedStyle()` of paused CSS animations, `Tests/Editor/AnimationTimingTests.cs`): the five
keywords, `cubic-bezier(.68,-0.55,.27,1.55)` and `cubic-bezier(0.1, 0.7, 1, 0.1)` within 1e-6 at 15 inputs (Chromium
solves the curve to 1e-7, the player to 1e-12); `steps()` with every jump term, `step-start`/`step-end`, and the before
flag; iterations 1, 3, 1.5 and infinite, the four directions, the four fill modes with a delay, and per-keyframe easing
within 2e-3 px (Chromium serialises 6 digits).

One difference is not reproduced: a `steps(n, jump-start)` animation with a delay shows the before-flag value at
exactly its delay in Chromium (local time a hair below the delay), the player the first step (the specification's
active phase). The fidelity suite samples no `steps()` animation; a sample at a step edge would show it.

Measured in Chromium for this round (paused animations and transitions seeked with `currentTime`):

- **Negative delays.** `slide 800ms ease-in-out -200ms`: −44.5006 px at current time 0, −24.8675 px at 100 ms, 0 at
  200 ms, 60 px from 600 ms; the player gives the same (timing rows and a mounted screen). A transition of
  `background-color 400ms linear -100ms` from `rgb(0, 0, 0)` to `rgb(200, 100, 40)` shows `rgb(50, 25, 10)` at the
  change. CSS starts a transition only with a positive combined duration (duration + delay): exporter, compiler and
  player all skip `100ms` with `-200ms`.
- **Play state.** A layer that sets `animation-play-state: paused` on a running animation keeps it (same name) and holds
  its current time; leaving the layer resumes from it (the player keeps a held local time per animation). An animation
  paused from its start holds local time 0, which a negative delay puts inside its timeline.
- **Reversing transitions** (CSS Transitions §3.4). `rotate 400ms ease` to 8deg, reversed at 100 ms (3.26808deg): the
  reverse transition runs `400 × ease(0.25)` = 163.404 ms (Chromium's `getComputedTiming().duration`), 1.93304deg,
  0.645762deg and 0.129223deg at its quarters; a reversed transition with a negative delay scales the delay too
  (`-100ms` reversed half-way: 200 ms with `-50ms`, `rgb(75, 38, 15)` at once). The player matches within 1e-4 deg and
  half a colour step.
- **`animation: none` in a layer.** The exporter records it (an IR keyframes entry without a name); the compiler writes an
  empty `--dui-a` for that layer, so the element's animations stop while the layer wins and start over when it stops
  winning, as a CSS animation that leaves and re-enters `animation-name` does. Chromium expands the `animation: none`
  shorthand with `animation-duration: auto`, which css-support now accepts (CSS: 0 s).

## Fidelity

`scripts/fidelity.sh` (all fixtures and kit components, 2560×1440, 1920×1080, 1280×720): 2160 PASS, 0 FAIL, 0 not
captured; static captures 960 PASS, animation samples 1200 PASS (transitions 990, keyframes 165 and initial-trigger 45
samples), with the rows this round added: a hover transition with a negative delay (transitions), a keyframe animation
with a negative delay, a class that pauses a running animation and a class with `animation: none` (keyframes). Capture
of the whole suite 119 s (every sample of a series reuses one mounted screen; the run's boxes are written once). Before
the rotated-sample limit below the same run had 4 FAIL, the wobble samples.

Two exporter defects found by the suite and fixed: a trigger class the artboard starts in (`is-open` in the markup) was
never taken off for its off side (export failed for keyframes, transitions stood still), and every series from the
page's opening after the first showed animations without a forwards fill as not running (CDP drops an animation that
ended without a forwards fill; the fill-none and fill-backwards dots stood still in 38 golden samples while Unity, and
Chromium in a fresh page, moved them).

## Rotated animation samples

In the previous round four samples failed on one element, the keyframes fixture's `wobble` (a 48 px circle,
`transform: translate() rotate()`) at ±10°: element SSIM 0.978–0.981 against the area floor 0.984, with the box equal
to 1e-4 px and every colour sample passing. Cause: Chromium draws an element under a running transform animation from
its composited layer, resampled bilinearly, so the rotated circle's edge is soft (up to 41/255 per channel against Unity
in a one-pixel ring); UI Toolkit draws the rotated mesh with its own edge anti-aliasing, as sharp as an unrotated circle.
A renderer difference of animated frames, not a wrong value.

Policy (measured): the design side's boxes now carry each element's rotation on the screen (`rotation`, its own and its
ancestors' `rotate` and `transform`, in degrees; absent when 0), and the comparison gives an element an animation sample
shows rotated off the axes (not a multiple of 90°) the element SSIM limit `ssimRotated`, only when every other check of
the element (box, baselines, colour samples, ring, ink, shadow band) passes. Static captures keep their limits: without
a running animation Chromium rasterizes a rotated element directly, as UI Toolkit does.

Measured over the whole suite (this round's run, before the limit existed): 297 element samples of 9 elements an
animation sample shows rotated off the axes, every one with all other checks passing.

| Element | Samples | Rotations | Lowest SSIM | Median |
|---|---|---|---|---|
| keyframes `wobble` (48 px circle, `transform`) | 69 | −10° … 10° | 0.9779 (−10° at 1280) | 0.9912 |
| keyframes `on-held` dot (48 px circle, `rotate`) | 51 | −157.5° … 150° | 0.9916 | 0.9949 |
| keyframes `it-inf` (48 px circle, `rotate`) | 51 | −157.5° … 150° | 0.9916 | 0.9947 |
| keyframes `on-state` (48 px circle, `rotate`) | 6 | −46.5° … 46.5° | 0.9923 | 0.9931 |
| transitions `class-*` cells (200×96 px, 4 px border, radius 16) | 120 | 0.3° … 8° | 0.9923 | 0.9985 |

By viewport the lowest are 0.9779 (1280×720), 0.9807 (2560×1440) and 0.9868 (1920×1080). Below 0.984 are only the
four wobble samples that failed before. `ssimRotated` is 0.975: the lowest measured value minus 0.003, about three times
the run-to-run change of the same wobble samples (0.978–0.981 in the previous round's run), and above the floor 0.97
every measured policy keeps.

## Group fades (U-CSS-039)

Not relaxed. A fade of opacity through (0, 1) on an element whose painted parts overlap needs group compositing in every
frame between its ends, and each such frame is a fractional group opacity: the case [opacity.md](opacity.md) measured
for UI Toolkit's group filter `filter: opacity()` (the same compositing path the player would write per frame), with
faded colours ΔE2000 1.1–2.1 above the expected blend (sample limit 1), text ink ΔE 2.1–2.9 (limit 2) and element SSIM
0.956–0.982 (limit 0.99). Every in-between sample of such a fade would carry that error, so U-CSS-039 keeps rejecting
fades on overlapping parts (static fractional group opacity stays rejected too), and the player writes `opacity` only
for the one-part elements lint allows. No separate animated measurement was run in this round: the per-frame value
does not change how the group is composited.
