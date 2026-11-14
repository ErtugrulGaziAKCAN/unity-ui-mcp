# Group opacity

| | |
|---|---|
| Date | 2026-11-13 |
| Question | CSS `opacity < 1` fades an element and everything it paints as one composited group; UI Toolkit's `opacity` multiplies into each painted part. Does UI Toolkit's group-compositing `filter: opacity()` reproduce CSS on the cases that need it (disabled buttons, toggles and fields, dimmed tags)? |
| Chromium | Chrome Headless Shell 158 (Playwright 1.65.0) on macOS |
| Unity | 6000.3.6f1, the verifier capture (`R8G8B8A8_UNorm` target, `forceGammaRendering` on) |
| Fixtures | The kit's `button.html` and `toggle.html` and the fidelity `pseudo-states.html` and `colors-gradients.html` as they were, and copies with every `opacity: x` written as `filter: opacity(x)` (screen ids and keys renamed; `opacity` added to `filter.functions` in a temporary copy of css-support.json and of the kit for the measurement only) |

## Measured

The disabled (and `is-dimmed`) captures of every disabled element of the three screens: largest background-sample
ΔE2000, ring sample ΔE2000 (border, corners, background beside the text), text ink ΔE2000, and the lowest element SSIM.
Limits: ΔE 1 for samples, 2 for text ink of 9 device px and more, SSIM 0.99.

| | Viewport | Background ΔE | Ring ΔE | Text ink ΔE | Element SSIM |
|---|---|---|---|---|---|
| `opacity` (per part, as compiled) | 2560 | 15.68 | 1.34 | 23.82 | 0.764 |
| | 1920 | 15.68 | 2.57 | 23.82 | 0.736 |
| | 1280 | 15.68 | 1.80 | 23.82 | 0.812 |
| `filter: opacity()` (group) | 2560 | 2.10 | 1.13 | 2.10 | 0.982 |
| | 1920 | 1.77 | 2.32 | 2.10 | 0.978 |
| | 1280 | 1.47 | 1.13 | 2.88 | 0.956 |

- Per part, a primary button's dark text is faded on its own over the faded accent: `#0b434c` against Chromium's
  `#081b21` (ΔE 13.7); a checked checkbox's faded border over its faded fill gives SSIM 0.76; a switch's knob, a
  background image over the faded track colour, ΔE 15.7.
- The group filter composites correctly but darker: a disabled secondary button's surface comes out `#0a2831` against
  Chromium's `#0e2b33` (0.4 × `#123c47` over `#0b1f26`), its text `#07171c` against `#091c22`. Every faded colour is a few
  levels below the expected blend, about ΔE 1.1–2.1, above the sample and ink limits, as it was for the single
  `opacity(0.5)` tile in [filters.md](filters.md) (text ΔE 3.14).

## Decision

Neither UI Toolkit route is within the thresholds, so group opacity is a design rule, not a compiler mapping:

- Lint **U-CSS-039** rejects an `opacity` strictly between 0 and 1 — in a rule, an inline style or the keyframe of an
  animation an element runs — on an element whose subtree paints two parts that overlap: its background and border, its
  background and text, a background colour and a background image, an inset shadow, or any painted child over its own
  paint. The fix names the kit's disabled colour tokens. `opacity` stays allowed on an element that paints one part (a
  swatch, a text, an icon, a border ring) and has no painted children: per-part and group fading are then the same
  pixels (the kit's `c-opacity` swatch and its fading keyframe dots pass).
- The kit's disabled styles use colours instead: `--color-disabled-surface`, `-line`, `-text`, `-accent`, `-on-accent`
  and `-negative`, each the token's colour at 40 % over the screen background (`--color-surface-900`), which is what
  `opacity: 0.4` showed on the kit's screens. A text drawn in such a colour over such a background composites to the same
  pixel as the faded group (both are linear in sRGB bytes), so the design keeps its look. The fidelity fixtures' other
  faded cases (0.3 on checkboxes and transition cells, 0.4 on tags over `--color-surface-800`) use their literal blends.
- `filter: opacity()` stays outside `filter.functions` (U-CSS-015).
- **Fades too.** A fade through (0, 1) shows the mismatch in every frame between its ends, so U-CSS-039 also rejects, on
  the same elements, a keyframe animation whose frames give opacity two values (a frame without opacity holds the
  element's own; `from {opacity: 0} to {opacity: 1}` is one) and opacity that differs between the element's layers with
  a transition of it in either direction. An opacity that changes without a transition jumps from end to end and stays
  allowed. Panels and dialogs appear by a transform (`translate`, `scale`) or a colour change; the kit texts no longer
  suggest transitioning opacity on such elements.
- With the animation player (2026-11-14): not relaxed. Every in-between frame of a group fade is a fractional group
  opacity, the case measured above; see [animation.md](animation.md#group-fades-u-css-039).

## Reproduction

```
cp -R design-kit <kit>   # add "opacity" to filterFunctions in <kit>/kit.config.json and to filter.functions in
                         # packages/com.ertugrulgaziakcan.design-ui/Editor/Data/css-support.json (revert afterwards)
sed -E 's/opacity: ([0-9.]+);/filter: opacity(\1);/g; s/data-u-screen="([a-z.-]+)"/data-u-screen="m.fo-<name>"/' \
  design-kit/components/button.html > fo-button.html   # likewise toggle, pseudo-states, colors-gradients
scripts/fidelity.sh --kit <kit> --out <out> fo-button.html fo-toggle.html fo-pseudo-states.html fo-colors-gradients.html
```

The numbers are the `deltaE`, `edge`, `ink` and `ssim` columns of the disabled elements in each `verdict.json`.
