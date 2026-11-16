# Decisions

The comparison, the text fit and the font twins follow decisions taken while the fidelity suite and real screens were
measured. The code, the measurements in [findings](findings/) and the [changelog](../CHANGELOG.md) cite them as `D-nnn`.
The numbers are not consecutive (only decisions the code or the documents cite are listed); the spec's risk ids `R1` to
`R10` are a different list. Each line says what was decided and why; the numbers behind it are in the findings.

The findings and the tests also name the development rounds those measurements came from ("Task 35", "fix round 3", "a
re-review's probe", ids such as `N4-3` or `F2`): these are labels of internal reviews that are not published, kept so a
measurement can be traced to the run it came from. Nothing depends on them; the decisions below are the public record.

| Id | What was decided, and why |
|---|---|
| D-109 | At a scaled viewport an element may meet a lower SSIM only for the anti-aliasing ramp of its round shapes, and only with evidence that the difference lies within 1 device px of those edges; the limit is the measured value with a small margin. UI Toolkit draws that ramp at the layout scale's pixel under the root scale: a sub-pixel softness nobody sees in play. |
| D-114 | The exact viewports must pass without any threshold change: what fails there is fixed in rendering (a right-aligned ellipsized label was), not absorbed by a limit. |
| D-115 | Text at the fractional sizes the root scale draws (12.5 and 12.8 device px) takes the small-text ink limits at scaled viewports only, below 13 device px: measured, whole 13 and 14 px stay within the full limit, so the scatter is a scale effect, not a text defect. |
| D-117 | A round element without text gets a ring colour check: the middle of each border side of 2 device px or more must match the design's colour within a measured ΔE2000, so a ring of another hue at the same lightness fails where SSIM alone would let it pass. |
| D-119 | Anti-aliasing differences are excluded at every viewport, as standard screenshot testing does, for round elements without text and for animation samples of an element at a fractional device offset, but only with evidence that the difference lies in the 1 device px band of their edges; the floor 0.974 is measured. |
| D-121 | The scaled class's remaining differences are fixed in rendering where the cause is ours; otherwise each kind gets a narrow, measured, scaled-only key, and only with evidence that it is scale-only (the same element passes at every exact viewport) and confined to edges or resampling. |
| D-123 | The ring colour limit stays ΔE2000 3.1 (the measured hovered radio plus a margin), and the documents say that a ring thinner than 2 device px has no colour sample. |
| D-124 | The captures record the boxes of a repeat's later items, so the edge bands and the checks reach every row, not only the first. |
| D-125 | At a scaled viewport a raster picture drawn at another size than its own may meet SSIM 0.95 and colour ΔE2000 5.89, the measured difference between Chromium's and UI Toolkit's resampling, only when the same picture passes at every exact viewport. |
| D-126 | At a scaled viewport text under 13 device px takes the ink colour limit of its measured scatter plus 0.4 (5.89), never above 6.5, only when the same text passes at every exact viewport. |
| D-127 | A round element without text fails when its ring is drawn more than 0.5 device px wider or thinner than the design's: a missing or thin ring is a visible defect the colour check cannot see. |
| D-128 | The fidelity run removes the fonts, twins and screens it writes into the project copy, a test that passes without testing anything is replaced, and an intermittent failure is rerun until it reproduces or is documented with its numbers. |
| D-129 | An edge-band relaxation needs evidence at the level of pixels: outside the band every 8 px SSIM block and every 3×3 window must match, not only the region's mean, and every border in the band keeps the design's width. |
| D-130 | Every edge-band relaxation also requires each masked border's centre colour within the ring colour limit, rectangular borders included, so a wrong-colour border in the band fails. |
| D-131 | Lint U-FONT-004 counts only the scale that wins the cascade among the rules of no state, and a state rule's scale only while that state holds: anything else blocked imports of text that is never drawn that small. |
| D-132 | An element counts as moving in an animation sample only when an animation of its geometry runs on it or an ancestor; every other element of a sample gets the static checks (a colour-only animation must not hide a wrong border). |
| D-133 | The text of a repeat's later items gets the same checks as the first item's (line count, baselines, ink), and only their text lines are masked: a visual check does not leave content unchecked. |
| D-134 | The text fit measures with the face UI Toolkit draws the text with, and measures again when that face's glyph set changes, so a label never keeps UI Toolkit's own width because a face it does not draw with lacked a character. |
| D-135 | The ring width limit stays "more than 0.5 device px fails"; the check decides reliably from 0.75 device px, so a ring 1 CSS px thinner at 1280×720 can pass, and the documents say so. |
| D-136 | A text-sized label or button measures again when a repaint shows a text, font or style other than the one it last measured (a binding, a list rebind, a language switch), and measures nothing on a repaint of the same text. |
| D-138 | A text line with no fully covered pixel (a hairline: an em dash, a one-stroke "1") is judged by its ink's colour direction from the background, not by its ink colour and amount, which measure coverage there; anti-aliased pixels are not colour-judged in standard visual testing. |
| D-139 | A rebuilt font twin reads its font asset definition again, so it never keeps looking up characters its rebuild dropped. |
| D-141 | A line counts as a hairline only at 12 device px or less, drawn at opacity 1 in its own recorded colour, with nothing painted later over it; it keeps an ink amount band of 0.5 to 2 times the design's, so missing or added glyphs still fail. |
| D-144 | The package was to cut ellipsized text itself with the browser's rule. Replaced by D-146: rewriting a label's text at runtime risked shipped games (a binding writing the cut back). |
| D-146 | The engine elides: at a scaled viewport an ellipsized line may keep one grapheme more or fewer than the design's, its start, baseline, ink colour and ellipsis glyph still judged; the exact viewports allow none. UI Toolkit decides its cut under the root scale, and the package never changes a label's text. |
| D-147 | The ellipsis glyph is judged at every viewport: a line the design ends in an ellipsis must end in the design's glyph in Unity, because a wrong glyph is visible at any size. |
| D-148 | Below 16 device px the ellipsis is judged by its structure: three dots at the design's pitch and height. A line whose design dots do not resolve into three is not judged and is counted. Correct and wrong glyphs overlap on the profile measures at those sizes. |
| D-149 | A fragment of a text line (cut by a cover or a clip to less than 4 em) takes, for its width, the measured noise of the ink statistic on known-correct lines; whole lines keep every limit. Few stems scatter more than a line, and the key is measured, not guessed. |
| D-150 | A line's ink window never reaches into another text's line box: labels laid edge to edge put the neighbour's first stem in one renderer's window only. |
| D-151 | Where a fragment width's measured ΔE2000 noise exceeds 6.5, its colour is judged by colour direction with a measured limit instead; a width whose limit would let a wrong hue pass is not judged and is counted. |
| D-152 | At a scaled viewport text under 13 device px may be judged as a hairline when either render shows it as one, with scale-only evidence (the same text passes its ink checks at every exact viewport): the root scale's fractional boxes split strokes Chromium draws on whole pixels. |
| D-153 | A fragment below the measured domain (the design's ink there under 16 px) is judged on its presence, its colour direction and the 0.5 to 2 times amount band, and counted. |
| D-154 | Text with a text-shadow is outside the fragment measurement and keeps the ordinary checks: the shadow's paint lies in the window. |
| D-155 | When only Unity's render qualifies a scaled line as a hairline, Unity's summed ink must reach a floor of the design's (D-158): splitting a stroke keeps most of the ink, dimming removes it. |
| D-156 | A fragment is a line whose design-visible ink a cover or a clip other than its own text cut hides; a line's own cut (its box, its ellipsis) never makes it one. |
| D-157 | The ink window is the design's visible window: Unity's clip never shrinks it, and a part the design shows that Unity's clip hides is missing ink. |
| D-158 | D-155's floor is 0.84 of the design's summed ink: the lowest of the suite's 180 correct hairline lines on that measure (0.86) minus 0.02. |
| D-159 | A fragment's cut is measured on the design's ink: a cover over only the empty part of a line box cuts nothing. |
| D-160 | A line the design's opaque covers hide entirely must show the cover in Unity: it leaves the text masks, so the cover's SSIM and colour samples judge its pixels, and Unity's ink there that no colour the design shows within 2 device px explains (4 pixels or more) is an issue ("Unity draws text the design covers"); the cover's edge placed a pixel off, with its anti-aliasing, is explained, and another text's line box (the cover's own text) is left to that text's checks. Before, text drawn over a popup passed. |
| D-161 | The contract is a file beside the design, written by the AI from the project; the tools check it, they never read game code. |
| D-162 | Opt-in per kit, with the project-kept setting `screenContract` (`optional` by default, `required`). |
| D-163 | Samples must be real values, enforced by U-CON-005. |
| D-164 | Info findings are counted as notes, not warnings. |
