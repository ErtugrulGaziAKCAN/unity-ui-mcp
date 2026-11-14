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

## Fidelity

`scripts/fidelity.sh` (all fixtures and kit components, 2560×1440, 1920×1080, 1280×720): 2117 PASS, 4 FAIL, 0 not
captured; static captures 957 PASS, animation samples 1160 PASS, 4 FAIL (transitions 966, keyframes 153 and
initial-trigger 45 samples). Capture of the whole suite 113 s (every sample of a series reuses one mounted screen; the
run's boxes are written once).

The four failures are one element, the keyframes fixture's `wobble` (a 48 px circle, `transform: translate() rotate()`)
at ±10° (`wobble.1` and `wobble.3` at 2560, `wobble.1` and `ease-steps.1` at 1280): element SSIM 0.978–0.981 against
the area floor 0.984, with the box equal to 1e-4 px and every colour sample passing. Measured cause: Chromium draws an
element under a running transform animation from its composited layer, resampled bilinearly, so the rotated circle's
edge is soft (up to 41/255 per channel against Unity in a one-pixel ring); UI Toolkit draws the rotated mesh with its own
edge anti-aliasing, as sharp as an unrotated circle. The same pattern on the `on-state` circle at 46.5° and 313° gives
SSIM 0.993 (passes); larger rotated boxes (the transitions fixture's 8° class cells) pass at every sample. It is a
renderer difference of animated frames, not a wrong value: no policy was added, the samples stay FAIL with this cause.

Two exporter defects found by the suite and fixed: a trigger class the artboard starts in (`is-open` in the markup) was
never taken off for its off side (export failed for keyframes, transitions stood still), and every series from the
page's opening after the first showed animations without a forwards fill as not running (CDP drops an animation that
ended without a forwards fill; the fill-none and fill-backwards dots stood still in 38 golden samples while Unity, and
Chromium in a fresh page, moved them).

## Group fades (U-CSS-039)

Not relaxed. A fade of opacity through (0, 1) on an element whose painted parts overlap needs group compositing in every
frame between its ends, and each such frame is a fractional group opacity: the case [opacity.md](opacity.md) measured
for UI Toolkit's group filter `filter: opacity()` (the same compositing path the player would write per frame), with
faded colours ΔE2000 1.1–2.1 above the expected blend (sample limit 1), text ink ΔE 2.1–2.9 (limit 2) and element SSIM
0.956–0.982 (limit 0.99). Every in-between sample of such a fade would carry that error, so U-CSS-039 keeps rejecting
fades on overlapping parts (static fractional group opacity stays rejected too), and the player writes `opacity` only
for the one-part elements lint allows. No separate animated measurement was run in this round: the per-frame value
does not change how the group is composited.
