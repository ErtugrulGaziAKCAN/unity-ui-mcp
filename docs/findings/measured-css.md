# Measured CSS: every value lint accepts has a fixture

| | |
|---|---|
| Date | 2026-11-14 |
| Question | Lint accepted CSS no fixture had rendered (word-spacing, text-overflow, italic, visibility, min/max sizes, background geometry, several hints). Letter-spacing, accepted the same way, had been wrong by a factor of six. Which accepted values match the design in Unity, and which must lint reject? |
| Unity | 6000.3.6f1, the fidelity suite on `samples/FidelityProject` (standard text generator) |
| Chromium | Chrome Headless Shell 158 (Playwright 1.65.0) |
| Fixtures | `design-kit/fixtures/fidelity/text-spacing.html`, `sizing-visibility.html`, `background-images.html`, at 2560×1440, 1920×1080 and 1280×720 |

## Method

The three fixtures put every property and keyword that no fixture's IR carried on real elements, next to boxes that show
how the layout moves. A coverage sweep compared every property and keyword `css-support.json` accepts with the
values the exported IRs of all fixtures and kit components carry. Keywords that never reach the IR (`auto`, `none`,
`normal`, `visible` defaults; `white-space`, `font-weight: bold` and `transform-origin` keywords, which the exporter
resolves) are covered by the values they resolve to. Each failure was either fixed in the compiler or rejected by
lint with a fix; the fixtures then keep only accepted values, and all three pass at every viewport.

## Results

| Property / value | First result | Outcome |
|---|---|---|
| `word-spacing` (4, 8, 16, −4 px; boxed left, centred, right; wrapped) | Unconverted, as written before: a 4 px label 10 device px narrow at 2560, a 16 px body 24 px narrow | TextCore applies USS `word-spacing` in hundredths of an em, as `letter-spacing`: the compiler writes `px × 100 / font-size` (`StyleMapper.WordSpacing`). No trailing compensation is needed (CSS adds none after a line's last word). Pass |
| `text-overflow: ellipsis` / `clip` with `white-space: nowrap` and `overflow: hidden` (left and right aligned; a text that fits) | Pass | Accepted |
| `font-style: italic` with a real italic face | Pass (the sample project now has Inter Italic as the 400 italic face; without one lint already rejects italic, U-FONT-001) | Accepted |
| `white-space: pre`, `pre-wrap` | Pass | Accepted |
| `overflow-wrap: break-word` (a word longer than its 200 px box) | Pass at 2560; at 1920 and 1280 the second line has 0.45× and 0.48× the design's ink: UI Toolkit breaks the word at another letter | Rejected (U-CSS-023): only `normal` |
| `text-rendering: optimizeLegibility`, `text-size-adjust`, `-webkit-text-size-adjust` | Pass | Accepted; `text-rendering` only `auto` or `optimizeLegibility` |
| `min-width`, `max-width`, `min-height`, `max-height` in px and % on flex items | Pass | Accepted |
| `max-width` on a chip of wrapping text | 4 logical px narrow at every viewport (Δw −4, −3, −2 device px): UI Toolkit measures the box with the max-width as the most it may take and sizes it to its longest wrapped line; Chromium clamps the max-content width at the max-width | New rule U-CSS-045 (lint-only, it needs the rendered layout): such a box needs a width of its own. A max-width the box does not reach passes, and so does a block-level box of wrapping text in a block parent (a stretched column after lowering: 300 px, three lines, at every viewport) |
| `visibility: hidden` (a box keeps its place; a visible child of a hidden parent shows; text; a state switching both ways) | Pass | Accepted |
| `box-sizing: content-box` on a padded box without a size | Pass | Accepted; U-CSS-036 and the compiler now also reject content-box with padding or border on a box that a min or max size or `flex-basis` sizes, as for width and height |
| `align-self` `flex-end` / `center` / `stretch`, `align-content` `center` / `flex-end`, auto margins | Pass | Accepted |
| `flex-wrap: wrap-reverse` (wrapped items with an 8 px bottom margin) | Every item 8 logical px lower (element SSIM 0.88 / 0.46 / 0.68) | Rejected (U-CSS-023): `nowrap` or `wrap` |
| `cursor`, `user-select`, `-webkit-tap-highlight-color`, `justify-self`, `justify-items`, `will-change` `auto` / `transform` / `opacity` | Pass | Accepted (other `will-change` values are rejected: not measured) |
| `background-size` `auto` / `cover` / `contain` / px / % / one length; `background-position` keywords, px, %, edge offsets; `background-repeat` `repeat` / `no-repeat` / `repeat-x` / `repeat-y` / two values | Geometry right everywhere. Differences came from resampling: a hard-edged 40×24 tile drawn 2× SSIM 0.868 at 2560 (Chromium filters upscaled rasters more smoothly), the photo drawn at 0.375 of its size ΔE 8.9 (thin lines alias in UI Toolkit, which samples without mipmaps), a centred photo at a half-pixel offset SSIM 0.979, a contained photo with a fractional height SSIM 0.958 at 1920 (Chromium snaps background tiles to whole pixels), a repeat moved by 10 px (7.5 device px at 1920) SSIM 0.927 | Accepted. RULES.md: show rasters at their natural size or larger at 2560 (half or more at every viewport), and put scaled or repeated background images on whole pixels (multiples of 4 px). The comparison treats a url() background image drawn at another size than its own like a scaled `<img>` (`ssimPicture`). Pass |
| `background-repeat: space`, `round` | SSIM 0.966 to 0.72 (round scales every tile; space places them off the pixel grid) | Rejected (U-CSS-023) |

## Kept in mind

- The word-spacing conversion follows the element's own font size, as letter-spacing does; a container without a font
  size leaves the spacing to its texts. CSS also spaces after a no-break space (U+00A0); whether UI Toolkit does is
  not measured (no fixture uses one with word spacing).
- The advanced text generator was not part of these runs (the suite's default is the standard generator).
- U-CSS-045 judges the reference locale's text: a translation that wraps where the reference does not can still meet
  the case at runtime.
