# Viewport classes: exact and scaled resolutions

| | |
|---|---|
| Date | 2026-11-14; the root scale, text widths and pictures 2026-11-15 |
| Question | A game offers 1280×720, 1366×768, 1600×900, 1920×1080, 2560×1440 and 3840×2160. Which of them can hold the kit's whole-device-pixel rules, and what does Unity do with the design at the others? |
| Unity | 6000.3.6f1, standard text generator, real panels (`ViewportScaleTextTests`, `FixedLineTextHeightTests`, `RootScaleTests`, `TextFitTests`) and the fidelity suite |
| Chromium | Chrome Headless Shell 158 (Playwright 1.65.0) |

## Classes

With the 2560×1440 reference and match 0.5 (Unity's linear blend), the panel scales are 1.5, 1, 0.75, 0.625, 0.53346
and 0.5. The kit's values are multiples of 4 px, so they are whole device pixels at 1.5, 1, 0.75 and 0.5 (a 0.25 step):
those are **exact** viewports, held to the kit build, kit sync and lint rules as before (`kit build --check` passes
with 3840×2160 added). At 0.625 a 4 px border is 2.5 device px and a 12 px font 7.5; at 0.53346 no kit value is whole.
Those are **scaled** viewports: exempt from the whole-pixel rules, verified with the same limits. Since 2026-11-15 a
screen lays out at an exact scale there and draws scaled (next section); the sections after it record what UI Toolkit does
when a panel lays a design out at such a scale itself.

## Root scale: lay out at an exact scale, draw scaled

**Mechanism.** The compiler writes the exact viewports' panel scales on the screen root (`DesignScreen`, `exact-scales`,
here 1.5, 1, 0.75, 0.5) and a custom property on its type. On a runtime panel whose scale (without the factor below) is
none of them, the root sets its PanelSettings' `scale` factor so the panel resolves an exact scale (`LayoutScale`, the
next one up: 1600×900 and 1366×768 at 0.75; see "Which exact scale") and gives itself an inline transform of actual /
exact about its top-left corner and `flex-shrink: 0` (the root is the reference size, 2560×1440, and its parent is laid
out in the exact scale's panel pixels). The inline transform composes the root scale with the design's own transform of
the root (next section). Every length is then whole device pixels where it is laid out, and
`layout × root scale × panel scale` is the design times the actual scale. The factor is kept per PanelSettings while a
screen is on its panel (the settings' own factor, or a factor the game writes meanwhile, stays the base) and given back
when the last screen leaves; a region's sort-order copy starts with the asset's own factor. The design's size for
breakpoints is the panel's target over the actual scale.

**The design's own transform of the root.** A design may translate, rotate or scale its screen root in a state, a
pseudo-state or an animation (an open animation `scale: 0.96 → 1`). Both write the root's `scale` and `transform-origin`,
so the root scale composes them: the animation player's translate, rotate and scale of a `DesignScreen` go through the
root, and the compiler writes each of the root's own transform declarations again as a custom property
(`--dui-root-translate: "100px 50px"`, `-rotate`, `-scale`, `-origin`) in the same rules, which the root reads in every
state. Under a root scale `r` the root's inline transform is the design's translate `t`, rotate `R` and scale `S` about
its origin `c` followed by `r` about the top-left corner, as one transform about the corner: scale `r·S`, rotate `R`,
translate `r·(t + c − R·S·c)`; unscaled it holds only what the player plays. `RootScaleTests.AnAnimatedRoot_…`: a box under
the keyframes at 0, 100, 200 and 399 ms is where the design's scale about the centre puts it at the actual scale
(1600×900 and 1920×1080), the root scale and its corner origin are back after the animation, a state's translate moves the
root by design pixels at the actual scale. Before, the player's `scale` replaced the root scale while it played and its
end cleared it (the screen stayed 20 % too large until the next resolution change).

**The held factor and the project's files.** In Edit mode the factor is held on the project's PanelSettings asset in
memory. Unity writes an asset only through a save, and every save that writes it (an asset save, File > Save, the save
after an Inspector edit, the save when the Editor quits) asks `AssetModificationProcessor.OnWillSaveAssets` first with the
paths: the package's save guard gives a held asset its own factor for the write and holds the factor again from the next
Editor update. An Undo snapshot taken while the factor was held and undone after the screen left would bring the held
factor back: every factor written is remembered per PanelSettings and an Undo or Redo puts the right one back (held: the
current factor; given back: the asset's own). `RootScaleTests.AHeldFactor_NeverReachesThePanelSettingsFile_…`: after a
SerializedObject edit and `AssetDatabase.SaveAssets`, a `SaveAssetIfDirty` and an Undo after the screen left, the file has
`m_Scale: 1` with the edits; without the guard it had `m_Scale: 1.2`.

**When the scale changes.** UI Toolkit resolves every style again when a panel's scale changes (`BaseVisualElementPanel.scale`
increments the visual tree's StyleSheet version), also between two 16:9 resolutions where the panel keeps its size in panel
pixels, and sends `CustomStyleResolvedEvent` to elements with custom properties: the root re-evaluates there (no polling;
measured: one event per scale change, `RootScaleTests.FullScreenDocument_…` moves a document from 1920×1080 to 1600×900
without a call into the screen). A runtime panel applies a new factor when it updates: every frame in Play mode and in
players; in Edit mode only when something on it changed after its last update, so the root asks the Editor for one more
update (an `EditorApplication.update` callback that marks the panel dirty; `delayCall` did not run inside the test runner).

**Measured on panels** (`RootScaleTests`, `ViewportScaleTextTests`, `TextFitTests`, device px):

| What | Result |
|---|---|
| A box at (397, 101), 403×37 px, at every default viewport | the design × the actual scale within half a device pixel of the layout scale's grid (edges are rounded where laid out: at 1600×900 within 0.42) |
| Ten rows of a 20 px child with 4 px padding above and below | 175 at 0.625 (CSS 175; laid out natively 185), 149.37 at 0.53346 (natively 147) |
| Every kit style's kerned 33-character line (Chromium's width × the actual scale) | within 0.635 device px at 0.625 from 0.75, 0.674 from 0.5; within 0.575 at 0.53346 from 0.5, 0.542 from 0.75 (the scaled twins: 0.92) |
| Five lines of every kit style | exactly five line boxes from either exact scale |
| Ink extent of 30 H at 12 px | 164.533 through the root at 0.625, 262.855 × 0.625 = 164.284 expected; natively 175.51 (UI Toolkit sets the text at the exact scale's whole size and does not set it again at the world scale) |
| Pointer input at 1600×900 and 1366×768 (and 1920×1080, not scaled) | picks only where the scaled root draws an element; hover, active, a click, a toggle, a wheel over a scroll view, a captured drag (positions in the element's own space are the design's). A text field is focused directly, not by a press (a synthesized press does not pick a runtime TextField in Edit mode at any scale); typing is not tested (keys have no geometry) |
| Gamma composite and a region's sort-order copy | the copy's panel holds the exact scale, the asset keeps its own factor, the composite's texture is the screen's size, a screen point picks the element the design puts there, `IsPointerOverPanel` agrees |
| A game's own factor (0.9 at 1600×900) | kept as the base (0.5625 actual, laid out at 0.75, the next exact scale up), given back when the screen leaves |
| Width breakpoints (min 2400, max 2400, min 2000) | from the design's size (2560 at 16:9, 2114 at 1280×1024), not the panel's laid-out size (2133 at 1600×900, 1821 at 1366×768, 1707 at 1280×1024) |

**Which exact scale.** Measured on the panels above (text widths and line boxes are within a device pixel from
either neighbour) and on the fidelity suite: 15 fixtures (the text, round-shape, bordered and picture ones; 257 captures
per scaled viewport) with each rule (`DESIGN_UI_ROOT_SCALE_RULE`, a measurement knob of the capture):

| Viewport | Laid out at | PASS | FAIL | of which SSIM / edge and colour / text ink / boxes |
|---|---|---|---|---|
| 1600×900 (0.625) | 0.75 (nearest in log scale, also the next up) | 191 | 66 | 51 / 8 / 0 / 7 |
| 1600×900 | 0.5 (next down) | 104 | 153 | 114 / 37 / 0 / 2 |
| 1366×768 (0.53346) | 0.5 (nearest, also the next down) | 109 | 148 | 52 / 7 / 85 / 4 |
| 1366×768 | 0.75 (next up) | 106 | 151 | 57 / 8 / 84 / 2 |

The nearest exact scale in log scale measured best on that subset at both, by count. **It is no longer the rule:** the
geometry limit decides. Layout puts each edge on the device grid of the scale it lays out at, up to half a pixel there, and
the root scale multiplies that: drawn at r = actual / exact, an edge is up to 0.5·r device px off and a box's width up to r.
Laid out at 0.5 and drawn at 1366×768 (r = 1.067) a box can be 1.067 device px narrow or wide where its edges fall half a
pixel off the layout grid: the `half-pixel-frame` fixture's chips and digits, centred at fractions of a pixel, were 1.06 and
1.13 device px narrow there (the only geometry failures at 1366×768 that were not text widths). `DesignViewportScales.Rule`
is `Up`: the next exact scale up, so r ≤ 1 below the largest exact scale (1600×900 and 1366×768 both lay out at 0.75,
r = 0.833 and 0.711), and an edge stays within half a device pixel. Above the largest exact viewport r exceeds 1 again.
On the full suite the change moved 1366×768's failures from boxes (2 → 0 with the text-width changes below) to SSIM of round
shapes, which the scaled class's round-edge limit covers when its evidence holds (section "Round edges at scaled viewports");
the text ink at 1366×768 is the same from either base (section "Text ink at 1366×768").

**Cost.** A sample of 300 rounded tiles with labels at 1600×900 in Edit mode: 2–3 draw calls and 20–22 µs of
`UIR.DrawChain` per frame with the root scale, 3 and 22–26 µs laid out at 0.625 natively (two runs each). The text is set at
the exact scale's size (larger at 1600×900, smaller at 1366×768), the same glyph count. A change of the root's scale
transforms the screen's vertices once.

**What it does not reproduce.** Chromium lays a page out in device pixels at a fractional scale: it puts border widths
on whole device pixels (halves up; a 4 px border is 3 device px at 1600×900, 2 at 1366×768) and keeps paddings and margins
fractional. Under the root scale a border is drawn at its layout width times the root scale (a 4 px border 2.5 device px at
1600×900, 2.13 at 1366×768); text-sized elements take the golden's width anyway (next section). UI Toolkit anti-aliases
rounded shapes with a ramp of one device pixel of the scale it lays out at, so under the root scale the ramp is 0.83
device px at 1600×900 and 0.71 at 1366×768, and small round shapes compare below the SSIM limit there; the scaled class
has a measured limit for exactly that (section "Round edges at scaled viewports"). Text drawn through the root scale has
the design's size and place; its ink colour at 1366×768 (12.8 px text) differs more than at an exact viewport, which is not
the layout scale's ramp (section "Text ink at 1366×768").

## Text widths: the golden's rule

The golden lays a text-sized box out as UI Toolkit rounds it (the exporter's `pageTextCeil`, `docs/findings/pixel-grid.md`):
Chromium's text width ceiled to whole device pixels at the viewport's scale, plus its padding and its borders on whole
device pixels (a tab's text of 69.469 px makes 70 px of content at 2560×1440 and 105 device px at 3840×2160). Chromium
itself lays the text out at its LayoutUnit width (measured with `Data/tools~/chromium-row-buttons.mts`: a row of `<button>`s
puts the second at 240.8906 px, the golden at 241). UI Toolkit ceils on the grid of the scale it lays out at and with no
tolerance: "Vazgeç" is exactly 86 px in Chromium and 86.0100 in Unity at every exact scale, which took 87, so every
button after it in a row moved a pixel. Under the root scale its grid is not the design's either.

`DesignTextFit` (on `DesignLabel` and `DesignButton`, which the compiler writes for a text or button whose width is its
content's) sets an inline width of the generator's unrounded width ceiled on the design's device grid less a tolerance
(`Snap`), plus padding and borders as the golden lays them out (`SnapBorder`), and `white-space: nowrap`. UI Toolkit
rounds a measured size to the device grid after the measure function, so a measure override could not carry the fraction.

**The tolerance.** Measured over every text-sized text of the fidelity suite at all six viewports (984 lines, Unity's
`MeasuredWidth` against the golden's Chromium width; a probe in the suite's own project copy): Unity minus Chromium is
−0.0175 to +0.0453 device px, median +0.0037 (`MeasuredWidth` carries about 0.01 device px of the scale it lays out at more
than the laid-out text: "Vazgeç" +0.0100 at every exact scale, its caret span +0.0013 to +0.0039). With the golden ceiling
Chromium's width as before (1e-4 forgiven), ceiling Unity's width less `t` gives the golden's whole device pixels for all
but 16 lines with `t` = 0, 9 with 0.010, 4 with 0.011 to 0.015 and 8 with 0.025 (the earlier value). Two of those 4 are a
pair no single `t` takes both ways: Chromium 14.0034 and Unity 14.0052 at 1366×768 (the golden 15) against "Vazgeç",
Chromium 86 and Unity 86.0100 (the golden 86). The golden's rule models Unity's rounding, so it now forgives the same
`t` (`TEXT_CEIL_TOLERANCE` in the exporter, `DesignTextFit.Tolerance` in the package, 0.012 device px): a text within
0.012 device px above a whole pixel is that pixel on both sides. Then 2 of the 984 lines are a pixel apart (letter-spaced
display text, Unity +0.037 and +0.045, inside their box limits); 1e-4 on the golden's side with 0.012 on Unity's: 4. The
earlier 0.025 rounded "Basın" at 1600×900 (Unity 38.0167, Chromium 38.0176) down to 38 device px where the golden has 39:
one of the scaled class's box failures.

**Letter-spacing.** Chromium adds the spacing after the last character, UI Toolkit's standard generator does not, and the
compiler writes that spacing as extra right padding, which UI Toolkit puts on its device grid. The golden's box of such a
text is the text without its last spacing ceiled, plus the spacing, padding and borders, rounded to whole device pixels
(`pageTextCeil`). The fit now lays that out: the design's right padding is the resolved one less the spacing, on the grid
where it lays out. Before, it added the resolved (snapped) padding: "Transfer dönemi" (−0.72 px at 36 px) was 1.16 device px
narrow at 1600×900.

**Text the design wraps.** In a row the layout narrows an element whose text has no room (it holds it narrower than its
text) and the fit comes off there, judged against UI Toolkit's own width for the text and only after a layout of it. In a
column and for an absolute text, layout never narrows an explicit width, and UI Toolkit does not wrap an absolute Label at
its parent's width at all (a 1487 px line in a 300 px box): a line longer than its room (the parent's content width less
margins; the padding box right of an absolute text's left edge) gets that width with the design's white-space, the
browser's fit-content box (`TextFitTests.AWrappingText_…`: 300 px in a flex-start column, 290 px at left 10 px of a 300 px
box, wrapped; a Label is 297 px wide in the column and one line as an absolute child). The fit watches the parent's
geometry for that (its own does not change under an explicit width).

A row of ten text-sized buttons (`TextFitTests`, body bold, 32 px padding, 4 px borders, 24 px apart) against the golden's
row built from Chromium's text widths (`Data/chromium-row-buttons.json`):

| Viewport | Largest offset from the golden's positions, device px, with `DesignButton` | with `Button` |
|---|---|---|
| 2560×1440, 1920×1080, 1280×720, 3840×2160 | 0 | 1, 0, 1, 1 |
| 1600×900 | 0.333 | 8.667 |
| 1366×768 | 0.344 | 1.548 |

## Round edges at scaled viewports

Under the root scale UI Toolkit anti-aliases a round shape with a ramp of one device pixel of the scale it lays out at:
0.83 device px at 1600×900 and 0.71 at 1366×768 (laid out at 0.75), against Chromium's one device pixel. Small round shapes
(a 30 px dot, a toggle's knob, a radio) and the corners of focus rings then compare below the SSIM and edge limits although
nothing else differs. The scaled class has a limit for exactly that, and only with evidence per capture that the difference
lies in the edge band of round shapes (`compare.ts`, `fidelity-thresholds.json` `scaled`):

- **SSIM.** The edge band is every pixel whose centre lies within 1 device px (`ROUND_EDGE_BAND`) of a rounded corner's
  outer curve or of its border's inner curve (an element's corner radii, both the design's painted box and Unity's). An
  element below `ssimElement` whose SSIM with that band masked (copied from the design, as text is) meets `ssimElement` and
  whose other checks pass may meet `ssimRoundEdge`. Measured on the suite's scaled captures (provisional limit 0.90 to see
  every value): 197 elements below 0.99; 143 confined to the band with every other check passing, all of them keyframes
  animation samples of its 48 px dots (border-radius 24 px; 50 at 1600×900, 93 at 1366×768), lowest unmasked SSIM 0.9774,
  each with band-masked SSIM ≥ 0.99. The other 54 are not confined (their band-masked SSIM is the unmasked one within
  0.0001) and keep failing: background and object-fit pictures drawn scaled (`background-images`, the raster limitation
  above), a baked gradient (`colors-gradients`), the placeholder text and table rows of 12.8 px text (`text-field`,
  `controls`: the text-ink scatter of the next section) and a vector star icon (its edge has no corner radius, so it is not
  a round shape here). `ssimRoundEdge` = 0.974, the lowest less 0.003 (as `ssimRotated`), never below 0.97.
- **Corner samples.** A text-carrying element's corner samples sit on the corner diagonals, at least 2 px from the outer
  curve, and focus rings put a border's inner curve next to them. A corner sample whose 3×3 window reaches the band and
  whose window pixels outside the band meet `deltaE2000` (both sides, the best offset of up to 1 px) may meet
  `deltaE2000RoundEdge`. Measured: all 21 corner failures of the scaled class (focus rings of buttons, list rows, a notes toggle,
  a dialog's button; 7 at 1600×900, 14 at 1366×768) reach the band and their pixels outside it meet 1; the highest
  full-window ΔE2000 is 5.10 (a ghost button's focus ring at 1366×768: Chromium draws the 2 device px ring solid, UI Toolkit
  its 2.13 with a partly covered row along the curve). `deltaE2000RoundEdge` = 5.5, the highest plus 0.4.

Both keys are the exact-class values (`ssimElement`, `deltaE2000`: off) outside the scaled block. Crops of each kind
(design, Unity, difference): the circle's difference is a ring along its edge, the focus ring's lies along the curve and
the ring's own rows, the not-confined text field's and table's are glyphs.

## Text ink at 1366×768

The scaled class's text-ink failures are at 1366×768: body text (24 px) is 12.8 device px there, ink colour ΔE2000 2.1 to
3.5 against the limit 2 (text of more than 12 device px), and label text (16 px) 8.54 device px, up to 4.84 against 4.5 (the
small-text limit; pending a decision on text of about 8 device px, with the 1280×720 8 px case). Measured on five failing
lines of body text (`card`, `controls`, `half-pixel-frame`, `text-styles`, `text-row`), each at 1280×720 (12 px, exact),
1920×1080 (18 px, exact) and 1366×768, laid out at 0.5 (drawn ×1.067) and, after the base change, at 0.75 (drawn ×0.711);
ink colour as the comparison measures it (the median of a line's most inked tenth), edge ramp as the mean run of pixels
between 15 % and 85 % of the way from the background to the ink along each row:

| Line | Design 12 / 12.8 px ink | Unity 12 px (native) | Unity 12.8 px from 0.5 | from 0.75 | ΔE at 12 px | at 12.8 px |
|---|---|---|---|---|---|---|
| card | 242, 241 | 245 | 253 | 253 | 0.67 | 2.34 |
| controls | 252, 255 | 248 | 242 | 242 | 0.82 | 2.52 |
| half-pixel-frame | 182, 177 | 181 | 165 | 184 | 0.25 | 3.14 / 1.74 |
| text-styles body | 252, 235 | 249 | 218 | 218 | 0.67 | 3.49 |
| text-row chip | 252, 255 | 242 | 241 | 243 | 2.07 | 2.87 / 2.63 |

(first channel of the ink colour; ΔE with the ink colours of both sides). At 18 px both renderers agree (ΔE 0.00 on all
five). The Unity drawing at 12.8 px is the same whether the screen lays out at 0.5 and draws ×1.067 or lays out at 0.75 and
draws ×0.711 (three of five lines identical, the others within the scatter), and its edge ramp under the root scale is
its native width (1366×768 over 1280×720: 0.905 to 1.053, mean 0.996, where a ramp of the layout scale would be ×1.067):
UI Toolkit evaluates its SDF text in screen space. So it is not the layout scale's anti-aliasing: both renderers' ink of thin
stems shifts with a fractional text size and where the stems fall on the pixel grid (the design's by −17 to +3, Unity's by
−31 to +8 from 12 to 12.8 px), the scatter the exact class allows for text of at most 12 device px (`text-ink.md` section 7:
up to 4.5). The scaled class's body text is 12.8 px, above that size. These lines keep failing; no limit changes for them.

## Raster pictures

At 3840×2160 a picture shown at its natural size is drawn 1.5 times larger, and Chromium and UI Toolkit resample it
differently (the earlier suite: element SSIM 0.948–0.962 against the picture limit 0.985). Lint **W-IMG-001** warns when a
raster image has fewer pixels than it is drawn at the largest declared viewport (object-fit in the content box,
background-size in the padding box) and names the size to export. A picture exported for 3840×2160 is drawn at a third of
its pixels at 1280×720: UI Toolkit samples level 0 without mipmaps (mipmaps were ruled out before: `pixel-grid.md`), and the
fixture photo's 6 px separators failed there (SSIM 0.963–0.969 at 1280×720 and 1920×1080). So the fixtures' pictures have
the pixels 3840×2160 draws, with their size in CSS, and no detail finer than a block: a 60×36 tile drawn at 40×24 px and
four-block photos at 480×270, 640×360 and 960×540 px. Detail that must survive the whole range of viewports belongs in a
vector image.

**Limitation.** The default viewports span a factor of 3 (0.5 to 1.5), and one raster picture cannot be sampled the way
Chromium samples it at both ends: exported for the largest, it is drawn at a third of its pixels at the smallest, where UI
Toolkit's full-size sampling (no mipmaps, ruled out in `pixel-grid.md`: it samples level 0) drops fine detail differently
from Chromium's filtering. Designs use vector art for detail, or raster detail coarse enough for the smallest viewport (the
guides say so). Picture variants per viewport (one raster per exact scale, chosen by the root's scale) are a possible later
feature; they do not exist.

## The toggle switch's knob

The knob is `radial-gradient(circle 12px at 16px 16px, #ffffff 10px, transparent 11px)` on a 64×32 rounded box, baked into
an SVG. Unity's VectorImage drew a speckled ring of light pixels at the gradient's radius, where its pad region starts, at
every viewport (largest at 3840×2160: element SSIM 0.967 against 0.984); Chromium draws nothing past the last stop. The bake
now draws a radial gradient that ends transparent as the ellipse it paints (inside the gradient's end) when that ellipse
lies inside the painted shape, so the gradient is never sampled at or past its end; the toggle passes at all six
viewports.

## Text sizes at a scaled viewport (before the root scale)

The scaled font twins this section measured (86722eb) are removed: under the root scale text is set at the exact scale's
whole size and drawn scaled.

Measured on a panel (each kit style, the kerned 33-character line of `Data/chromium-kerning-line.json`, Chromium's width
at scale 1 times the scale; Chromium lays text out at the exact size at any device scale factor):

| Scale | Style | Device size | Unity width / Chromium | One line, device px (CSS line box) | 14 labels stacked, drift |
|---|---|---|---|---|---|
| 0.625 | caption 12/16 | 7.5 | 1.0667 | 11 (10) | +14 |
| 0.625 | label 16/20 | 10 | 1.003 | 13 (12.5) | +7 |
| 0.625 | title 36/48 | 22.5 | 1.023 | 31 (30) | +14 |
| 0.53346 | caption 12/16 | 6.40 | 0.942 | 8 (8.54) | −7.5 |
| 0.53346 | label 16/20 | 8.54 | 1.060 | 12 (10.67) | +18.6 |
| 0.53346 | body 24/32 | 12.80 | 1.019 | 18 (17.07) | +13.0 |

UI Toolkit sets text at whole device pixels, halves up (7.5 → 8, 22.5 → 23, 6.40 → 6, 8.54 → 9), and the line box of a
twin follows the size it renders at. A long line at a scaled viewport is several pixels wider or narrower than the
design's, far outside the ±1 device px box and line-extent limits, so scaled viewports need the size itself fixed.

**Scaled font twins.** A twin's `faceInfo.scale` multiplies every metric the generator uses (glyph advances, ascent,
line height). For each scaled viewport's scale where a line box's font size is fractional, kit sync and the compiler
make a variant with `faceInfo.scale = exact / rounded` (`<face> UITK r13333s12x0p625.asset`); it links to its face's
glyphs and atlas like any line-box variant. `DesignFonts.uss` points the line-box variables at those variants under
`.locale-<code>.vs-<scale>`, and the compiled screen root carries `vs-<scale>` while its panel renders at that scale
(`DesignScreen.ViewportScales`). Measured on a panel with a run of 30 `H` (no kerning): the device width per exact px
is 22.13–22.18 with the variants at every size, 22.1 for a whole size, against 20.8–23.6 without them. Every kit style
at both scaled viewports: kerned line width within 0.92 device px of Chromium's, five lines within 0.97 device px of
five line boxes (`ViewportScaleTextTests.EveryKitStyle_AtEveryScaledViewport_IsTheDesignsWidthAndLineBox`).

## Stacked text

UI Toolkit ceils a text element's measured height to whole device pixels, so at a fractional line box each text is up to
a pixel taller than the design's and everything below drifts. The compiler now gives a text whose line count the design
fixes (it does not wrap in any layer; its lines are its explicit breaks) and whose height is its content's an explicit
height: lines × line box plus vertical padding and borders. Yoga lays the exact value out and rounds each edge to the
device grid, so nothing adds up. Wrapping text keeps its measured height (at most a pixel over per element).

Panel proof (`FixedLineTextHeightTests.FourteenSingleLineLabels_StackWithoutDrift_AtScaledPanels`), 14 labels 16/20:

| Scale | 14 line boxes | Single-line labels (explicit height) | Wrapping labels (measured height) |
|---|---|---|---|
| 0.625 | 175 device px | 0 | +7 |
| 0.53346 | 149.37 device px | −0.37 | +4.63 |

## Stacked-text fixture

`design-kit/fixtures/fidelity/stacked-text.html`: 16 single-line label rows with padding, 16 captions and 6 titles,
14 key/value rows (items centred), and three wrapping paragraphs followed by 6 rows. Unity minus design, device px, at the
column's end mark (the fidelity run's boxes; "before" is the same build without the explicit heights):

| Viewport | Single-line rows before → after | Captions and titles | Key/value rows | Paragraphs, then rows |
|---|---|---|---|---|
| 3840×2160, 2560×1440, 1920×1080, 1280×720 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| 1600×900 (scaled) | +24 → 0 | 0 → 0 | +21 → +14 | +9.5 → +0.5 |
| 1366×768 (scaled) | +0.94 → −0.06 | +9.73 → −0.27 | +0.81 → −4.19 | +4.41 → +4.41 |

The explicit heights remove the text part of the drift. What is left comes from the box model, measured next. Under the
root scale (2026-11-15) every column ends where the design's does at all six viewports: 0.00 device px for the
single-line rows, captions and titles, key/value rows and paragraphs alike.

## Box-model lengths are whole device pixels too

A column of ten rows, each a 20 px child with 4 px on both sides (a panel at each scale, device px; pinned by
`ViewportScaleTextTests.BoxModelLengths_AreWholeDevicePixelsAtAScaledViewport_ExplicitHeightsAreNot`):

| Scale | padding 4/4 | margin 4/4 | border 4/4 | height 28 | padding 3/5 | CSS |
|---|---|---|---|---|---|---|
| 0.625 | 185 (each side 3) | 185 | 185 | 175 | 175 (2 + 3) | 175 |
| 0.53346 | 147 (each side 2) | 147 | 147 | 149 | 157 | 149.37 |

UI Toolkit 6000.3 snaps every padding, margin and border width to whole device pixels (halves up) before layout, while
Chromium lays the exact fractions out.

The same holds at an exact viewport for lengths that are not multiples of 4 px. Ten nested elements, each moved 10 px from
its parent by one property, at scale 0.75 (1920×1080; CSS 75 device px, 80 when each 7.5 is laid out as 8;
`ViewportScaleTextTests.LengthsUiToolkitSnaps_…`):

| Property | Device px after ten moves |
|---|---|
| `padding-left`, `padding-top`, `margin-left` (a lowered `gap` is a margin), `border-left-width` | 80 (snapped) |
| `left` and `top` (relative or absolute), `right` (absolute), `translate` | 75 (laid out as given) |

So a design whose paddings, margins or gaps are not whole device pixels at an exact viewport moves everything inside or
after them by half a device pixel per edge in Unity, and text by about one: a real screen with a frame centred at 398 px
(298.5 device px at 1920×1080) and grid cells padded 10 px and 14 px (7.5 → 8 and 10.5 → 11) drew every text line 0.97 to
1.21 device px right of the design's. Lint **U-CSS-046** rejects such lengths at every exact viewport the kit declares,
naming the element, the property, the viewport and the nearest whole lengths (multiples of 4 px with the default kit);
U-CSS-040 keeps borders there. The fixture `design-kit/fixtures/fidelity/half-pixel-frame.html` centres two frames at
fractions of a device pixel (398 px: 298.5 at 1920×1080; 397 px: 297.75 at 1920×1080, 198.5 at 1280×720, 595.5 at
3840×2160) with 4 px grid paddings, margins and gaps inside. At a scaled viewport each such edge is up to half a device pixel off, and a stack
of padded, bordered or spaced elements adds the errors up (the key/value rows: 4 px padding is 2.5 → 3 device px at 0.625,
+1 per row; 2.134 → 2 at 0.53346, −0.27 per row). Explicit heights and widths are not snapped. No compiled length can
give a fractional edge, and a class-wide rule cannot spread the rounding over the rows that share it, so this is not
fixed here: it is the main reason the scaled class fails (below). Text measuring adds the same kind of error to widths:
UI Toolkit ceils a text's measured width to whole device pixels, so a row of text-sized buttons moves right by up to a
pixel per button (3840×2160: +1.02 at the fourth).

## Suite at six viewports

**After the review's fixes (2026-11-15, later).** `scripts/fidelity.sh`, 22 fixtures and 9 components (4728 captures, 2400 of them
animation samples), 13 min 5 s (setup 18 s, exports 188 s, import 26 s, capture 195 s, comparisons 354 s); the screen lays
out at the next exact scale up, text widths forgive 0.012 device px on both sides, letter-spaced boxes follow the golden's
rule, and the scaled block holds the round-edge limits (143 elements pass through `ssimRoundEdge`, all keyframes dots; no
corner sample fails):

| Viewport | Class | PASS | FAIL | What fails |
|---|---|---|---|---|
| 3840×2160 | exact | 788 | 0 | |
| 2560×1440 | exact | 788 | 0 | |
| 1920×1080 | exact | 788 | 0 | |
| 1280×720 | exact | 787 | 1 | `stacked-text` "41.200" at 8 device px, ink colour ΔE2000 4.65 against 4.5 (pending decision) |
| 1600×900 | scaled | 772 | 16 | SSIM only: 9 `transitions` samples (an element under a running transform transition, which Chromium draws from its resampled layer: soft on every edge), 5 `icons` (a vector star's outline, no corner radius), 1 `background-images` (a picture drawn scaled, with an edge colour), 1 `scroll-area` (1 px row dividers drawn 0.83 device px, 0.98955 against 0.99) |
| 1366×768 | scaled | 678 | 110 | text ink: 62 at 8.54 or 6.4 px (60 `repeat-items`, 2 `text-styles`: pending decision), 26 at 12.8 px (17 `controls`, 6 `card`, `half-pixel-frame`, `text-row`, `text-styles`: section "Text ink at 1366×768"); SSIM outside the round-edge band: 17 `controls` table (12.8 px rows and 1 px dividers), 15 `text-field` (12.8 px placeholder), 5 `icons`, 3 `colors-gradients` (a baked gradient), 1 `background-images` (a capture can fail more than one check: the 17 `controls` captures fail ink and SSIM, `text-styles` has one capture with three sizes) |

No box, baseline or line-extent check fails at any viewport (before the fixes: 11 boxes at the scaled viewports), and
the stacked-text columns end within 0.00 device px everywhere.

**With the root scale, exact text widths and the new pictures (2026-11-15).** `scripts/fidelity.sh`, 22 fixtures and 9
components (4728 captures, 2400 of them animation samples), 12 min 53 s (setup 17 s, exports 187 s, import 28 s, capture
198 s, comparisons 339 s):

| Viewport | Class | PASS | FAIL | What fails |
|---|---|---|---|---|
| 3840×2160 | exact | 788 | 0 | |
| 2560×1440 | exact | 788 | 0 | |
| 1920×1080 | exact | 788 | 0 | |
| 1280×720 | exact | 787 | 1 | `stacked-text` "41.200" at 8 device px, ink colour ΔE2000 4.65 against 4.5 (text-ink.md section 9, a pending decision) |
| 1600×900 | scaled | 712 | 76 | 61 SSIM only (46 `keyframes` and 9 `transitions` captures of small round shapes, 5 `icons`, 1 `scroll-area`), 8 corner edges of focus rings (ΔE2000 1.1–1.7 against 1), 7 boxes (Δw −1.16 to −1.49: a letter-spaced title, a bordered state box, a chip in `half-pixel-frame`) |
| 1366×768 | scaled | 633 | 155 | 85 text ink colour (60 `repeat-items` at 8.54 px, ΔE2000 4.63 against 4.5; 17 `controls`, 6 `card` and others at 12.8 px, 2.1–3.5 against 2), 58 SSIM only (52 `keyframes`), 8 corner edges, 4 boxes |

Every remaining scaled failure is a rendering difference the root scale leaves (section "Root scale", "What it does not
reproduce") or a box in 11 captures (Δw −1.06 to −1.78 device px), not drift: the stacked-text columns end within 0.00
device px everywhere. No limit was widened.

**Before (2026-11-14).** `scripts/fidelity.sh`, 20 fixtures and 9 components (4716 captures: 2316 static, 2400 animation
samples), 13 min 38 s (setup 17 s, exports 198 s, import 28 s, capture 194 s, comparisons 378 s with four fixtures at a
time; the transitions fixture's 2130 captures take 330 s of it):

| Viewport | Class | PASS | FAIL |
|---|---|---|---|
| 3840×2160 | exact | 697 | 89 |
| 2560×1440 | exact | 786 | 0 |
| 1920×1080 | exact | 786 | 0 |
| 1280×720 | exact | 785 | 1 |
| 1600×900 | scaled | 431 | 355 |
| 1366×768 | scaled | 17 | 769 |

With the `half-pixel-frame` fixture (frames centred at fractions of a device pixel, section "Box-model lengths") the
suite has 21 fixtures and 4722 captures: that fixture passes at the four exact viewports and fails at the two scaled
ones; every other count is the table's (3840×2160 698/89, 2560×1440 and 1920×1080 787/0, 1280×720 786/1, 1600×900
431/356, 1366×768 17/770).

- 3840×2160: 35 captures move text-sized buttons by 1.01–1.02 px (the width ceil above); 54 fail element SSIM only:
  raster pictures drawn 1.5× larger (0.948–0.962 against the picture limit 0.985) and the toggle fixture's effects tile
  (0.967).
- 1280×720: the new fixture's value "41.200" at 8 device px, ink colour ΔE2000 4.65 against the small-text limit 4.5
  (the renderers' small-text scatter, text-ink.md section 7).
- 1600×900: 132 captures with a box, baseline or line-extent issue (stacked padded rows, field labels that may wrap,
  bordered controls), 186 SSIM only and 35 edge only (fractional edges and baked images drawn at 0.625).
- 1366×768: every failing capture has a geometry issue (1.2–4 px typical; a wrapping row of tiles whose widths add up
  breaks onto a second line, +78 px).

No scaled-class limit was recorded in `fidelity-thresholds.json`: the colour and SSIM differences at 1600×900 come with
geometry failures that need a ruling first, and geometry limits stay ±1 device px.
