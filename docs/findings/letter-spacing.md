# Letter spacing: CSS px against UI Toolkit's USS value

| | |
|---|---|
| Date | 2026-11-14 |
| Question | The compiler wrote CSS `letter-spacing` (px) unchanged into USS, and tracked labels came out far too tight (a caps label's spacing about a sixth of the design's). What does UI Toolkit do with the USS value, with both text generators? |
| Unity | 6000.3.6f1, a real panel (`LetterSpacingTests`), panel scales 1, 0.75 and 0.5, Inter 18pt Regular |
| Chromium | Chrome Headless Shell 158 (Playwright 1.65.0) |

## Measured

Forty `H` per label, font sizes 12, 16, 24 and 40 px, USS values −2, −0.5, 0.5, 1, 2 and 10, the standard and the advanced
generator (Enable Advanced Text on). The spacing after each character is the glyph step minus the step without spacing,
read from the glyph quads (`PostProcessTextVertices`), so it is exact; the label's width says how many spacings it holds.

| Generator | Spacing after each character | Largest difference from `value × size / 100` | Spacings in a text-sized width |
|---|---|---|---|
| standard | `value × font-size / 100` points | 0.00002 pt at every scale | n − 1 (none after the last character) |
| advanced | the same, cut to 1/64 device px (toward zero) | 0.013 / 0.014 / 0.014 device px at scales 1 / 0.75 / 0.5 | n |

Examples (points): USS 1 on 16 px text is 0.16 (standard) and 0.15625 (advanced); USS 10 on 40 px text is 4.0 with both;
USS −2 on 40 px is −0.8 and −0.797.

So USS `letter-spacing` is hundredths of an em of the element's own font size, not px: CSS `letter-spacing: 1.6px` on 16 px
text drew 0.256 px. Chromium adds the CSS value after every character, including the last one of a line (its line and box
widths contain it). Like a CSS `em` value, a USS value follows the font size: an element that inherits a container's value
with another font size gets another spacing.

## Change

- The compiler writes `letter-spacing: <px × 100 / font-size>px` for every layer that changes the spacing or the font size
  (`StyleMapper.LetterSpacing`), with the node's own font size; the exporter already gives every text node the spacing it
  inherits. A container without a font size writes none (its texts carry their own).
- A text element with spacing gets that spacing as extra right padding: the standard generator leaves out the spacing after
  a line's last character, and the padding puts it back, so the box, the line breaks (the line has the same room) and
  centred or right-aligned text sit where Chromium puts them. A right padding in % with spacing is rejected (U-CSS-023).
- Negative spacing needs at least as much right padding (lint U-CSS-044, the compiler likewise). Measured on a panel
  (`LetterSpacingTests.NegativeRightPadding_IsLaidOutAsZero_AndANegativeMarginKeepsTheBox`): UI Toolkit resolves a negative
  padding to 0 and leaves the box as it is; a negative right margin moves the next box but keeps a text-sized box and widens
  a stretched one, so no other compensation gives Chromium's box. The fixture has right-aligned and centred tight headings
  with 4 px right padding.
- The golden's text-sized width (`capture.ts`) is the text without that last spacing rounded up to the device grid, plus
  the spacing, as UI Toolkit lays it out.
- `letter-spacing` in `em` stays rejected by lint (U-CSS-023, write px); the conversion would be `em × 100`.

Fixture `design-kit/fixtures/fidelity/letter-spacing.html`: tracked caps labels (12 and 16 px, text-sized, and left, centred
and right in fixed boxes), wide tracking on body text, tight headings (−0.02 em at 24, 36, 48 and 64 px) with a box after
each, and wrapped text with positive and negative spacing.

## Kerning pairs that dropped the spacing

"Transfer dönemi" (Inter Bold, 36 px, −0.72 px) laid out 1.44 px wider in Unity than in Chromium at every viewport,
although its kerning pairs were all in the twin, with the same pairs whether its glyphs came in one batch or in several
(import pre-adds, runtime text). The standard generator gives the letter-spacing of both characters of a pair to nothing
when the pair's record carries `FontFeatureLookupFlags.IgnoreSpacingAdjustments`, and TextCore copies pair records from
the font engine with lookup flags it never sets: values that change from run to run (480, 1137016832, 1104150528, 112, …
in one twin, `None` in another made the same way). "Tr" carried the bit, so T and r lost their −0.72 px each. OpenType
kerning has no such per-pair switch and Chromium spaces every character, so the twins keep no flags: `DesignText` clears
them after every glyph batch (import pre-adds and bound text), twin generation and the import's pre-add clear them in
existing twins. Measured (`KerningBatchTests`, glyphs in five batches): 277 px before, 276 px after, Chromium 275.158 px
without the last spacing (286 px plain against 285.234). Pairs that TextCore adds in its own queue for text no `DesignText`
call prepared keep their flags until the next batch of that twin.

## Limits

- The advanced generator cuts the spacing to 1/64 device px per character: up to 0.016 device px less per character (0.3 px
  over 20 characters). The standard generator, which the verification and the reference locale use, is exact.
- The advanced generator includes the last character's spacing in the width: with the compensation padding, a text-sized
  box in a locale that uses it (shaping and right-to-left scripts) is one spacing wider than the design, and centred or
  right-aligned text sits half a spacing or one spacing to the left of it.
- Text-size steps scale the font size and so the spacing (as an `em` value would); the padding does not follow them.
