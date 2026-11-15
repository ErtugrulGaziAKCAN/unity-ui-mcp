# Viewport classes: exact and scaled resolutions

| | |
|---|---|
| Date | 2026-11-14; the root scale, text widths and pictures 2026-11-15; edge-band evidence 2026-11-15 (round 5) |
| Question | A game offers 1280×720, 1366×768, 1600×900, 1920×1080, 2560×1440 and 3840×2160. Which of them can hold the kit's whole-device-pixel rules, and what does Unity do with the design at the others? |
| Unity | 6000.3.6f1, standard text generator, real panels (`ViewportScaleTextTests`, `FixedLineTextHeightTests`, `RootScaleTests`, `TextFitTests`) and the fidelity suite |
| Chromium | Chrome Headless Shell 158 (Playwright 1.65.0) |

## Classes

With the 2560×1440 reference and match 0.5 (Unity's linear blend), the panel scales are 1.5, 1, 0.75, 0.625, 0.53346
and 0.5. The kit's values are multiples of 4 px, so they are whole device pixels at 1.5, 1, 0.75 and 0.5 (a 0.25 step):
those are **exact** viewports, held to the kit build, kit sync and lint rules as before (`kit build --check` passes
with 3840×2160 added). At 0.625 a 4 px border is 2.5 device px and a 12 px font 7.5; at 0.53346 no kit value is whole.
Those are **scaled** viewports: exempt from the whole-pixel rules, verified with the same limits. Both classes hold the
readable-text floor: no text draws below 9 device px at any declared viewport, 18 px design text with these viewports
(9 device px at 1280×720 and 9.6 at 1366×768; the kit's smallest styles are 20 px; `text-ink.md` section 9). Since 2026-11-15 a
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

**The held factor and the project's files.** In the Editor outside Play mode a factor is held only on PanelSettings no
save writes (`HideFlags.DontSaveInEditor`: runtime copies, such as the capture's and a region's sort-order copy). A
screen on a PanelSettings asset, or on settings a scene embeds, lays out at the actual scale there with no root scale:
no asset save, build, `.preset`, copy or scene can then see a held factor, and the Edit-mode Game view at a scaled
resolution shows the screen unscaled (not the game's layout; Play mode and verify show it).
`RootScaleTests.InEditMode_NoSavableSettingsHoldAFactor_…`: an asset and a scene-embedded copy keep their own factor in
memory, in the file and in a preset made while a screen is on them (red with the earlier hold: the asset held 1.2).

In Play mode (and in players) the factor is held on any PanelSettings, also on an asset in memory. Unity writes an
asset only through a save, and every save that writes it (an asset save, File > Save, the save after an Inspector edit,
the save when the Editor quits) asks `AssetModificationProcessor.OnWillSaveAssets` first with the paths: the package's
save guard gives a held asset its own factor for the write and holds the factor again from the next Editor update. A
player build writes loaded objects as they are in memory: an `IPreprocessBuildWithReport` gives every held factor back
before it and warns. Not covered: a Scriptable Build Pipeline or Addressables content build started in Play mode (Unity's
own `BuildPipeline.BuildAssetBundles` refuses to run in Play mode; those pipelines do not check), and a preset or asset copy
made while held. An Undo acts only on the PanelSettings it touched (whose scale is no longer the one this class last wrote
or saw) and only for a factor written since the settings' own last changed: a value the game or the user sets (seen every
Editor update, and at once for a recorded Inspector edit) drops the earlier pairs (`RootScaleTests.AUsersOwnFactor_…`,
`AGamesOwnFactor_SurvivesAnUndo_InPlayMode`; red before: both reset to 1). Each write keeps its (factor, own) pair, and a factor counts as the package's own write only while
it equals the last factor written: a game's factor equal to an older held one is the game's. An Undo snapshot taken while
held brings that snapshot's own factor back (held: the screens hold the factor of that own again; given back: the
snapshot's own), also after a script reload, through `SessionState` records of the assets. `RootScaleTests`:
`InPlayMode_AHeldAssetsSaves_WriteItsOwnFactor_AndABuildGivesItBack` (`m_Scale: 1` after `SaveAssets` and
`SaveAssetIfDirty`, the build guard gives 1 factor back), `AGamesOwnFactor_EqualToAFactorHeldEarlier_IsTheGames` (red
before: the game's 1.2 was taken for a held one) and `AnUndo_RestoresTheSnapshotsOwnFactor_AlsoAfterAScriptReload` (red
before: an Undo of the game's 1.3 left own 1.3).

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

**What it does not reproduce.** Chromium lays a page out in device pixels at a fractional scale: a text-sized button's
border takes whole device pixels in its width (halves up; a 4 px border is 3 device px at 1600×900, 2 at 1366×768, measured
on a row of buttons), while a box's border in a layout keeps its fraction (2.5 at 1600×900, measured on nested boxes), as
paddings and margins do. Under the root scale a border is drawn at its layout width times the root scale (a 4 px border 2.5 device px at
1600×900, 2.13 at 1366×768); text-sized elements take the golden's width anyway (next section). Nested bordered boxes
do not add a difference up, measured (round 3): the findings page `docs/findings/viewport-classes/nested-borders.html`
(one, two and three levels of 4 px borders on `div`s) through the fidelity suite passes every capture; at 1600×900 the
golden lays each border out at 2.5 device px, as UI Toolkit draws it (3 at the exact 0.75, drawn ×0.833:
`RootScaleTests.NestedBorders_…` measures 2.5 / 5 / 7.5; the golden's own layout of the page, 2.5 / 5 / 7.5 at 1600×900,
2.13 / 4.27 / 6.40 at 1366×768 and 3 / 6 / 9 at 1920×1080, is a contract in design-export's `viewport-classes.test.ts`), and
the label inside three levels is within 0.16 device px of the golden (0.28 at 1366×768, where the group's own position differs by as much, from the text widths before it). The
whole-device-pixel border of `DesignTextFit.SnapBorder` (3 device px at 1600×900) was measured on text-sized buttons and
holds for their widths; a box's border inside a layout is the fraction. An earlier note here predicted 1.5 device px at
three levels from that model; the measurement replaced it, and no lint warning is needed. UI Toolkit anti-aliases
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

Outside the scaled block `deltaE2000RoundEdge` is off (`deltaE2000`); `ssimRoundEdge` applies at exact viewports too since
ruling R119, to fewer elements (section "Edge bands at every viewport"). Crops of each kind
(design, Unity, difference): the circle's difference is a ring along its edge, the focus ring's lies along the curve and
the ring's own rows, the not-confined text field's and table's are glyphs.

**Ring colour (ruling R117).** A ring on a round element without text (a radio, an avatar ring) lies wholly in the edge
band at 2 device px or less, so neither SSIM nor a colour sample of the fill sees its colour. The middle of each border
side of 2 device px or more (the ring's centre pixel, fully covered on both renderers) is now compared at every viewport
(`deltaE2000Ring`). Measured over the suite (69 such elements, 12168 element samples of static captures): highest 2.67, a
hovered 2 px radio ring at 1280×720 (the unchecked radio 1.10; at 1920×1080 0.57, 2560×1440 0.50, 3840×2160 0.17, at the
scaled viewports 0.38 and 0.17). Limit 3.1, the highest plus 0.4. Animation samples are not judged: Chromium draws a
moving element from its resampled layer, and a translated cell's 2 px border reaches 14.2 there. A ring of another hue at
the same lightness keeps the element's SSIM at 0.99 or more and fails this check (`compare.test.ts`). A ring under 2 device
px has no such sample: it gives the scaled class's SSIM relaxation no evidence, and the element is held to `ssimElement`
there (a missing 1.25 px ring passed before). **What it admits** (ruling R123): a ring whose colour is within ΔE2000 3.1 of
the design's, judged only on rings of at least 2 device px; a ring thinner than that has no colour sample and is judged by
SSIM alone. The sample takes the best of Unity's offsets up to 1 device px, so it sees a wrong colour, not a ring a device
pixel thinner; the ring's drawn width is its own check since round 5 (ruling R127, section "Edge-band evidence").

## Scaled-class residuals (ruling R121)

The scaled class's failures of round 3 (1600×900: 9, 1366×768: 33), per group, measured on a run of the suite on round 3's
code (crops: design, Unity, difference). Each new key is scaled-only (off at exact viewports, where the file's own values
must be), applies only with evidence that the difference lies in a band of at most 1 device px of the element's edges, and
is the measured extreme plus the usual margin; every element it relaxed passes at every exact viewport.

- **A border thinner than a device pixel?** The first check: Chromium (the exporter's headless shell, at a device scale)
  does not draw such a border at 1 device px. Measured on `div`s with a 1 px border, with a 0 px height and a 1 px border,
  and 1 px high: at 1366×768 the line covers 0.54 of one pixel row (luma 135 of 255 on black, or 83 + 54 across two
  rows), at 1600×900 0.63, at 1280×720 0.5. The suite's dividers are 4 px borders (2.13 device px at 1366×768, 2.5 at
  1600×900), not thinner than a pixel, so no rendering rule applies to them.
- **Straight edges between device pixels** (`ssimFractionalEdge` 0.97): an element's box edges and its border's inner
  edges fall between two device pixels at a scaled viewport; Chromium covers such a pixel partly, UI Toolkit under the
  root scale draws the edge a fraction of a pixel away with its own ramp. The band: the pixels whose centre lies within 1
  device px of such an edge in the design (its painted rect) and in Unity, the element's own and its descendants', added
  to the round-edge band. Relaxed: `colors-gradients` root__1__11 at 1366×768, a box with a 4.27 device px border of four
  colours (3 captures, 0.9735, band-masked 0.99999), and `button` secondary-small focused at 1600×900 (0.9748, 1.0). Limit
  the lowest less 0.003. Test: the four-colour box's crop passes with the key, fails without it, fails with a dent inside
  it, and keeps 0.99 at an exact viewport.
- **A vector picture's edges** (`ssimVectorEdge` 0.975): `icons` star (a 30 device px filled vector) is 0.16 device px
  left of the design's (laid out on the 0.75 grid, drawn ×0.833) and drawn with the layout scale's ramp, so its outline
  differs (0.98096 at 1600×900, 0.97875 at 1366×768, 5 captures each, against the small-element 0.984). The band: every
  pixel of the design whose 3×3 window holds a colour change of more than 6 levels (within a device pixel of a drawn
  edge), if at least half the element's region stays compared. Band-masked SSIM 1.0. Limit the lowest less 0.003. Test:
  the star's crop passes with the key and fails without it, with an 8 px hole in it, and when the element is no vector.
- **Focus-ring corners** (`deltaE2000FractionalEdge` 5.3): `repeat-items` notes-toggle focused at 1366×768 (ΔE2000 4.90)
  and filter focused at 1600×900 (1.42): the ring lies 0.28 / 0.35 device px from the design's, so a corner sample (4 px
  in) reaches the ring's straight edges between pixels, where the round-edge rule found differing pixels outside its own
  band. A corner sample whose window reaches the straight-edge band and whose pixels outside both bands (at least 3, at one
  offset) meet ΔE2000 1 may meet it. Limit the highest plus 0.4. Test: the notes-toggle crop passes with the key, fails
  without it and with a ring of another colour.
- **Transitions at 1366×768** (5 samples, 0.97664–0.981): elements a running transition moves to a fractional offset,
  drawn by Chromium from its resampled layer (it spills about 8 % into the pixel past each edge); the moved-edge band of
  ruling R119 confines them (0.99884–0.99904), and they pass at the scaled class's `ssimRoundEdge`.

Left failing, with the cause:

- **Dividers of repeated items** (`controls` table, 17 captures at 1366×768, 0.98639; `scroll-area` inbox at 1600×900,
  0.98955): the difference lies on the rows' bottom borders (straight edges between pixels), but the captures recorded a
  box only for a repeat's first item, so the band could not be placed on the other items' edges: band-masked 0.98789 and
  0.98960. Round 5 records every item's box (ruling R124): the band confines them, and they kept failing on the glyphs of the
  later rows' text (section "Edge-band evidence") until ruling R133 gave that text the first item's treatment (section
  "Repeat items' text, the face that draws, what moves").
- **Pictures drawn scaled** (`background-images`, 1 capture at each scaled viewport): a picture exported for 3840×2160 is
  drawn at 0.42 and 0.36 of its pixels; Chromium filters, UI Toolkit samples level 0, so block edges differ: element SSIM
  0.95284–0.96867 at 1600×900 (below the absolute floor of 0.97 no measured limit may go under) and 0.97866–0.97986 at
  1366×768, and colour samples on resampled edges (ΔE2000 3.22 at 1600×900, 1.64 and 5.49 at 1366×768). The raster
  limitation of section "Raster pictures"; they pass since round 5 through the scaled-only key of ruling R125.
- **Text ink at 10.67 px** (`stacked-text` value-12 at 1366×768, ΔE2000 5.49 against the small-text 4.5): the fractional
  size's ink scatter (section "Text ink at fractional sizes"; the measured maximum there was 4.29). It passes since round 5
  through the scaled-only small-text key of ruling R126.
- **One letter-spaced box** (`letter-spacing` caps-label at 1366×768, Δw −1.30, and −0.996 at 1600×900): the box had UI
  Toolkit's own width there (150 px at 0.75, drawn ×0.711), not the text fit's. Seen in round 4's first run, again in round
  5's second and third full runs; what the trace found is in section "Edge-band evidence" ("Letter-spacing box"), the fix
  (ruling R134) in section "Repeat items' text, the face that draws, what moves".

## Text ink at 1366×768

The scaled class's text-ink failures are at 1366×768: body text (24 px) is 12.8 device px there, ink colour ΔE2000 2.1 to
3.5 against the limit 2 (text of more than 12 device px), and label text (16 px) 8.54 device px, up to 4.84 against 4.5 (the
small-text limit). The label case is gone with the readable-text floor (decision of 2026-11-15, `text-ink.md` section 9):
no text draws below 9 device px at a declared viewport, the kit's smallest styles are 20 px (10.67 device px here), and
the 12.8 px body text below stays reported as it is. Measured on five failing
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
up to 4.5). The scaled class's body text is 12.8 px, above that size. These lines kept failing then; no limit changed.

## Text ink at fractional sizes (ruling R115)

Measured on 7 fixtures and 5 components (`stacked-text`, `text-styles`, `text-row`, `text-spacing`, `letter-spacing`,
`half-pixel-frame`, `controls`, card, list-row, button, tabs, text-field), the kit as it is and a kit copy with caption
26/32 and label 28/36 (13 and 14 device px at 1280×720), per text element the largest ink colour ΔE2000 over its lines:

| Device px | Class | Elements | ΔE2000 median / p90 / max |
|---|---|---|---|
| 12 (body at 1280×720) | exact, whole | 125 | 0.00 / 1.19 / 2.28 (its limit: 4.5, text of at most 12 px) |
| 13 (26 px at 1280×720) | exact, whole | 25 | 0.50 / 1.62 / 1.98 |
| 14 (28 px at 1280×720) | exact, whole | 99 | 0.00 / 0.81 / 1.94 |
| 12.5 (caption, label at 1600×900) | scaled, fractional | 124 | 0.69 / 1.95 / 4.29 |
| 12.8 (body at 1366×768) | scaled, fractional | 125 | 0.00 / 1.97 / 3.80 (3.14 in the second kit) |

The whole sizes 13 and 14 stay within the full limit 2, and 12 within its small-text limit; only the fractional sizes the
root scale draws exceed 2, from the same stems shifting on the pixel grid. As ruled, in the scaled class only the small-text
ink limits apply below 13 device px (`fidelity-thresholds.json` `scaled.textInkSmallPx` 12.99: text of at most 12.99 device
px; the exact class keeps 12). Above 13 the scaled sizes stay on the full limit (13.87 and 14.94 px of the second kit:
max 2.36 and 2.90, one line each, kept failing). Test: `viewport-classes.test.ts`, "the scaled class holds text under 13
device px to the small-text ink limits".

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

## Exact-class captures after the kit's raised text (ruling R114)

Raising caption and label to 20 px moved the fixtures' layout by whole device pixels and showed three differences the
suite had passed by chance or not exercised; measured on the captures of round 3:

- **A right-aligned line wider than its box** (`text-spacing` ellipsis-right, label-bold 20 px, at every viewport): the
  browser start-aligns a line that does not fit (CSS Text) and then puts the ellipsis where it is cut, so the visible text
  starts at the box's left edge; UI Toolkit right-aligned the cut text, 3.3 CSS px further right (same cut, same width:
  Δwidth +0.05). **Fixed**: a text that does not wrap and is aligned right, centred or at the end compiles to a
  `DesignOverflowLabel`, left-aligned while its text overflows its box (`RootScaleTests.ARightAlignedLine_…`).
- **The unchecked radio at 1280×720** (`controls` radio-b, 20 device px, a 2 px ring; SSIM 0.979 against the small-element
  limit 0.984, every `controls` capture): the ring's anti-aliasing. Luma of the outermost ring pixels, design / Unity, with
  the geometric coverage of a circle of radius 10 about (426, 178): the left middle (416, 177) 78 / 85 (0.99), the top
  middle (425, 168) 79 / 85 (0.99), a diagonal pixel (420, 169) 32 / 50 (0.38; background 26, ring 85). UI Toolkit's
  coverage is the circle's; Chromium's outer edge lies 0.1 px inside it on the axes and about 0.28 px on the diagonals,
  and the inner edges agree within 3 luma. It is not a radius (a smaller circle cannot be 0.1 in on the axes and 0.28 on
  the diagonals) or a pixel alignment (the box is on whole device pixels on both sides); matching it means matching
  Skia's coverage, which UI Toolkit does not offer. Its SSIM also depends on where the 8 px block grid falls on the
  ring: over the 64 alignments 0.972–0.985, 57 of them below 0.984, so before the raise it passed by alignment. At 0.75
  (a 30 px circle) and 1 it passes (0.995, 0.998). Left failing, for a decision.
- **One `transitions` sample at 1280×720** (`active-ease`, sample 6, SSIM 0.98276 against 0.984): the element is 0.774
  device px down a running translate. Chromium draws it from its composited layer, resampled, so the bottom border's
  edge rows blend (row 199: 129, 126, 77, between the fill 150, 132, 69 and the border 43, 101, 115); UI Toolkit draws its
  straight edges unfiltered at the nearest pixel row (row 199: the fill). Its SSIM over the 64 block alignments: 0.983–
  0.999, 8 below 0.984; the other nine samples of the same transition pass. UI Toolkit has no filtering for a translated
  element's straight edges. Left failing, for a decision.

Both are anti-aliasing differences, which standard screenshot testing excludes; ruling R119 extends the edge-band rule to
every viewport for exactly these two kinds (next section), and both pass.

## Edge bands at every viewport (ruling R119)

`ssimRoundEdge` (0.974) applies at every viewport, to two kinds of element and only with the same evidence as at a scaled
viewport: its SSIM with the edge band masked meets `ssimElement` (0.99), its other checks pass, and its unmasked SSIM is at
least 0.974.

- **A round element without text** (a radio, an avatar ring, a dot): the band is the R109 one, every pixel within 1 device
  px of a corner's outer curve or its border's inner curve, its own and its descendants'. The ring's colour is the
  evidence: the middle of each border side of 2 device px or more within `deltaE2000Ring` (3.1) at an exact viewport (the
  round-edge limit 5.5 at a scaled one); a thinner ring gives no evidence and keeps `ssimElement`.
- **An element an animation sample moves to a fractional device offset** (the sample's running animations play on it or
  on an ancestor, and one of its golden box's edges lies between two device pixels): the band adds its moved straight
  edges, the box's four edges and its border's inner edges, each the pixels whose centre lies within 1 device px of that
  edge in the design **and** in Unity. An edge Unity draws a device pixel away from the design's is then outside the band.
  The ring's colour is not evidence in an animation sample (Chromium resamples the moving layer, so a border's centre pixel
  blends; R117 already left animation samples out of the ring check); the middle of a moved straight border stays compared.

Since round 5 every such relaxation also needs the pixel-level evidence of rulings R129 and R130, and the ring is judged at
3.1 at every viewport (section "Edge-band evidence").

Measured on the suite's captures (provisional limit 0.97 to see every value):

| Where | Elements below 0.99 in scope | Band-masked SSIM | Lowest unmasked (best offset) |
|---|---|---|---|
| exact viewports | 16 `controls` radio-b at 1280×720, 1 `transitions` sample at 1280×720 | 1.00000, 0.99999 | 0.98088 (radio), 0.98296 (sample) |
| scaled viewports, moved edges | 5 `transitions` samples at 1366×768 | 0.99884–0.99904 | 0.97664 |

No other element at an exact viewport is in scope below 0.99. The floor stays 0.974, as the ruling allows (the lowest exact
value less 0.003 would be 0.978); the 1366×768 samples need the scaled class's 0.974 anyway. Tests (`compare.test.ts`,
"ssimRoundEdge at every viewport", crops of the suite's own 1280×720 captures): the radio and the 0.774 px sample pass;
held at 0.99 without the band they fail; a ring 1 device px thinner fails (0.95207 unmasked: the band holds the whole 2 px
ring, and the ring's colour sample, the best of ±1 px offsets, does not see the width, so the floor is what catches it at
this size); the moving border a device pixel off, its box within the box limit, fails (0.99 not reached with the band
masked); the same element in a static capture gets no moved-edge band. A round element that carries text keeps
`ssimElement` at an exact viewport (it takes the band at a scaled one).

**What it admits.** At an exact viewport: a round element without text whose pixels differ only within 1 device px of its
curves, by at most SSIM 0.974 over its box, with its ring's colour within ΔE2000 3.1; an element in an animation sample whose
pixels differ only within 1 device px of its curves and of its edges where both renderers put them, by at most 0.974.

## Edge-band evidence (rulings R124 to R130)

Round 5 (2026-11-15). Every edge-band relaxation needs its evidence at the level of pixels, a round element's ring has its
width checked, a repeat's later items have boxes, and two residual kinds of the scaled class have their ruled keys.

**Evidence (rulings R129, R130).** `ssimRoundEdge`, `ssimFractionalEdge`, `ssimVectorEdge` and the corner limits
(`deltaE2000RoundEdge`, `deltaE2000FractionalEdge`) apply only when, besides their earlier conditions:

- outside the band, every 8 px SSIM block of the element's region (each at its best offset of up to 1 px) meets
  `ssimElement`, and every 3×3 window whose pixels all lie outside the band is within `deltaE2000` (1) of Unity's closest
  3×3 mean within 1 px: the element colour limit as the comparison defines it, at every pixel instead of the region's
  mean. A ΔE per pixel was measured first: Chromium's anti-aliasing of a curve reaches about 1.1 device px past it (a 3 %
  coverage step there), so 98 `keyframes` captures failed on ΔE2000 1.1–2.7 just past the 1 px band with nothing else
  differing; the windows that touch the band leave those pixels out;
- every border the band masks (the element's own, its descendants', a repeat's later items'): its drawn width within 0.5
  device px of the design's (R127's measure, below) and the centre pixel of each side of 2 device px or more within the
  file's own `deltaE2000Ring` (3.1; the scaled block cannot change it, where a round element's ring was judged at 5.5
  before); a side under 2 device px gives no evidence. Where an animation sample moves the border's element the centre
  colour is not sampled: Chromium draws the moving element from its resampled layer, where a 2.13 device px border's centre
  pixel blends (ΔE2000 3.42–14.17 on three `transitions` samples at 1366×768 whose evidence otherwise holds); the static
  captures judge that border's colour, and the width and the windows count in the sample too (resampling keeps a border's
  covered width). Since ruling R132 a sample moves only what an animation of geometry plays on (section "What moves in an
  animation sample"): every other element of a sample has its centre colour sampled as in a static capture;
- the band reaches as far as the region's SSIM blocks: a moving edge's spill past its box lies in the region's last row of
  blocks (cut at the box, it left five `transitions` samples at 1366×768 with a block of 0.98993 outside the band).

Measured on round 5's second run, compared with the final code: the 179 SSIM relaxations it admits have every block outside
the band at 0.99428 or more, every window within ΔE2000 0.854, every masked border's centre within 1.10 and its width within
0.26 device px; the 20 corner samples it admits at the scaled viewports are 1.02–5.10. Tests (`compare.test.ts`, "edge-band
evidence"): the re-review's avatars (below); a 3 px dent of another colour in a 160 px avatar's fill, between the colour
grid's points (band-masked mean 0.99 or more; a block fails); a ring 1.5 device px thinner in an animation sample (the
windows match within 1 px, the width fails); the re-review's N4-3 box, its 2.13 device px border another colour (no window
outside the band reaches it; its centre fails); a corner sample of an element whose border is under 2 device px (no
evidence: held to `deltaE2000`).

**Ring width (ruling R127).** The drawn width of a border across the middle of each side of 2 device px or more and, on a
round corner whose radius holds it, across its curve at 45°: along the normal every sample between the colour outside and
the ring's counts as ring by its place on that segment, every sample between the ring's and the colour inside likewise (the
ring's colour is the design's centre pixel, for both renderers, so a thinner ring in Unity counts as thinner). Exact to 0.01
device px across a side's middle; across a diagonal it reads up to 0.16 device px more on a thinner ring. A round element
without text fails in a static capture when the design's and Unity's widths differ by more than 0.5 device px anywhere.
Measured over the suite (11126 static element samples): largest difference 0.44 device px (a menu panel at 1280×720),
nothing fails. The re-review's probe, an 80 and a 160 CSS px avatar whose ring Unity draws 3 CSS px wide instead of 4: both
fail at 1920×1080, 2560×1440 and 3840×2160 (0.75, 1 and 1.5 device px thinner; before, the 160 px one passed at all three
and the 80 px one at two). At 1280×720 the ring is 0.5 device px thinner, R127's own limit: the 160 px avatar passes there,
as it did before ruling R119, and the 80 px one fails on its SSIM.

**The width check's limit (ruling R135).** The check fails a ring whose drawn width differs by more than 0.5 device px
("> 0.5"), and it decides reliably from 0.75 device px. Below that the measure's own error decides: across a diagonal and at
sub-pixel positions it reads up to 0.16 device px more on a thinner ring (a ring truly 0.5 device px thinner reads 0.498 to
0.635 by where the grid falls on it, and a correct ring drawn with a harder ramp up to 0.506), so neither "> 0.5" nor
"≥ 0.5" separates them. **A ring 1 CSS px thinner at 1280×720 (0.5 device px) can pass**: the re-review's 160 px avatar does
at the grid position of the test (0.498). The red test of ruling R129 holds at every viewport where the thinning is 0.75
device px or more (1920×1080, 2560×1440, 3840×2160); its 1280×720 case is this documented limit, not part of it.

**Repeated items (ruling R124).** Both captures record the boxes of a repeat's later items (`items`: the IR id and the item
suffix the Unity capture names the copy with, `row#3`, `day#0#1`), and the band of straight edges between device pixels
takes their edges. `controls` table at 1366×768: band-masked 0.98789 → 0.99432; `scroll-area` inbox at 1600×900: 0.98960
→ 0.99339; the band confines both. They still fail (17 + 1 captures) on R129's evidence: an SSIM block outside the band of
0.71900 (the table, block at 904, 312) and 0.51854 (the inbox, 576, 160), on the glyphs of a later row's text (12.8 and 12.5
device px): the comparison masked the IR elements' own text, not their copies in later items, and at those fractional sizes
the renderers' glyphs differ (section "Text ink at fractional sizes"; the crops show the same text). Ruling R133 gives the
copies' text the first item's treatment (section "Repeat items' text").

**Resampled pictures (ruling R125).** Scaled only: an element that draws a raster picture at another size than its own may
meet `ssimResampledPicture` 0.95 when its other checks pass (measured lowest 0.95284, rounded down to 0.01: its own floor,
below the general 0.97), and its colour samples `deltaE2000ResampledPicture` 5.89 (measured highest 5.49, plus 0.4). The
pictures pass at every exact viewport of the same run; no cross-viewport check is built (ruling R130's reasoning: a defect
that shows at an exact viewport fails there in the same run). Round 5 admits 6 picture elements in 2 captures (SSIM
0.95284–0.97986) and 3 colour samples (ΔE2000 1.64–5.49).

**Small text (ruling R126).** Scaled only: text of at most 12.99 device px takes the ink colour limit 5.89
(`scaled.textInkDeltaEFirstSmall`): measured over the suite's 10746 element samples of such text at the scaled viewports
(12.5 device px at 1600×900, 12.8 and 10.67 at 1366×768) the highest is 5.49 (`stacked-text` value-12 at 1366×768), then
4.29 and 3.80; under the ruling's 6.5 cap. Every such text passes at every exact viewport. Round 5 admits one line above the
earlier 4.5 (ΔE2000 5.49).

**Letter-spacing box (ruling R128).** Seen in round 4's first run and in two of round 5's three full runs (caps-label
Δw −1.30 at 1366×768 and −0.996 at 1600×900: UI Toolkit's own width, 200 design px, at both scaled viewports), in none of 7
runs of the fixture alone (5 on the warm copy, 2 on a fresh one), each with the fit's width (Δw +0.122 and −0.163). A
fourth full run traced every text-fit update of the label (a temporary trace, not committed) and failed the same way: all
34 updates of the screen's six captures found the label's font (`Inter UI UITK r12s20`, the label-bold line box) without a
character of "BÖLÜM BAŞLIĞI" in a face of its weight table (`DesignText.AllPresent` false: the fit measures only text every
face already holds, so a measure never adds glyphs outside a repaint), so the fit never applied and the label kept UI
Toolkit's own width at every viewport. At the exact viewports that width equals the golden's box once Yoga rounds it (201,
200, 202 and 200 design px; the golden's 201, 200.125, 202, 200.125); at the scaled ones it does not (200 against 201.594 and
202.438). Which face lacks which character, and why only in some full runs (the fixture alone never), is not found: the twins'
characters are added at runtime and the run deletes the fonts at its end, so the next step is a trace that names the missing
characters per face. A guard against a stale geometry report, written first for another explanation, did not change the
outcome in the following run and was reverted. Ruling R134 fixes the fit's side of it (next section).

## Repeat items' text, the face that draws, what moves (rulings R132 to R136)

Task 35 (2026-11-15) closes what round 5 left open. The width check's limit (ruling R135) is in section "Edge-band
evidence" ("The width check's limit").

**What moves in an animation sample (ruling R132).** An element counts as moving in an animation sample only when a running
animation on it or an ancestor changes geometry: the IR's animated properties include the transform or one of its parts
(`translate`, `rotate`, `scale`, `transform-origin`), a position (`left`, `top`, `right`, `bottom`, `inset`), a size (`width`,
`height` and their limits, `flex-basis`, `flex-grow`, `flex-shrink`) or a box-model length (margins, paddings, border widths,
gaps); a colour, an opacity, a filter or a shadow does not move it (an IR animation that lists no properties counts as
moving, as before). Only a moving element is drawn by Chromium from its resampled layer, which is what the moved-edge band and
the static-only ring and border-centre checks are for. Every other element of a sample gets the static checks: its ring's
colour and width and, for an edge-band relaxation, its borders' centre colour. Before, every element a running animation
played on counted as moving, so a colour-only animation gave it the moved-edge band and skipped the centre colour: the
re-review's 2.13 device px box at 1366×768 with its border ΔE2000 10 to 19 off passed in a sample. It now fails on its
centre there; with an animation of its geometry it keeps the centre colour to the static captures (`compare.test.ts`, R130
and R132; `captureContext` in "IR context").

**Repeat items' text (ruling R133).** A later repeat item's copy of a text is recorded, masked and checked as the IR
element's text:

- both captures write each copy's `text` and its own `lines` in boxes `items` (schema, `contracts/boxes-sample.json`): the
  golden through the same measure as the IR elements', leaving out the text of copies nested in it; Unity's `BoxesWriter`
  through the same caret lines (`BoxesWriterTests`, a copy's line a pitch below the first row's). The golden also rounds a
  copy's text-sized width as the item template's `DesignLabel` lays it out, as it does for the IR's own text (without it a
  copy's box had Chromium's 16.5625 device px where the IR element's has 17: `capture.test.ts`);
- the comparison masks the copies' text lines (the whole capture's and each element's SSIM, an edge-band relaxation's blocks
  and windows, the colour samples' neighbourhood). Only the lines: a copy has no element SSIM or colour samples of its own, so
  what it paints (a chip's background, a pill's border) stays in the whole capture's and its containers' SSIM (fix round 1,
  I-1: masked by its whole box at first, a later row's chip in another background colour passed; `compare.test.ts`, "I-1");
- each copy gets the IR element's text checks with the class's limits, named by the copy (`row#3`): present and visible as
  in the design, the same line count, baselines within ±1 device px, ink colour (the IR element's font size), ink amount
  (counted in the capture's medians) and where each line's glyphs sit; its box is not compared (the edge bands use it);
- an edge-band relaxation that fails names every condition that does not hold (a block, a window, a border's colour
  evidence, its centre, its width), not only the first.

Red tests (`compare.test.ts`, "R133"): the three-row table at 1366×768 of round 5 with a 10.67 device px text in each row,
whose glyphs the renderers draw differently, passes with its dividers confined and each row's text checked (`name`,
`name#1`, `name#2` with their ink); a later row's text in another colour fails its ink check (on 15fa093 nothing checked it:
the capture failed only on the table's SSIM, with the right colour too); a copy on two lines or missing in Unity fails as an IR
element would.

On the suite (Task 35's runs) the comparison checks 5154 copies' texts per viewport (`repeat-items` 28566 of the 30924
over all six, `controls` 1836, `list-row` 324, `scroll-area` 126, `states` 72). The 18 divider captures pass: with the later
rows' text masked the `controls` table's element SSIM at 1366×768 is 0.99195 and the `scroll-area` inbox's at 1600×900
0.99233, at `ssimElement` without any band (0.98639 and 0.98955 before: the difference was the glyphs). Where each copy's
glyphs sit is within 0.45 device px everywhere (`controls` count#6 at 1600×900), its ink amount 0.75 to 1.17 of the design's.

What the copies' checks found at first, 120 captures of `repeat-items`, each a text of one glyph whose only stroke is thinner
than two device pixels, on a baseline the design puts between two device pixels (ruling R138 judges them since, next section):

| Viewport | Copy (its text) | Captures | Ink colour ΔE2000 (limit) | Ink amount (band) |
|---|---|---|---|---|
| 1280×720 (exact) | `row-time#2`, the unavailable-value em dash, 10 device px, baseline 279.5 | 60 (every capture) | 6.06 (4.5): design #a0b9c1, Unity #b9d0d6 | 0.69× (0.80–1.25) |
| 1366×768 (scaled) | `day-number#1`, "1", 10.67 device px, baseline 110.43 | 60 (every capture) | 6.65 (5.89): design #eff0f1, Unity #cfd4d6 | 1.14× (in the band) |
| 1366×768 (scaled) | `row-time#2`, the em dash, the row expanded (baseline 351.55) | 6 of those | 8.99 (5.89): design #94afb6, Unity #b9d0d6 | 0.75× |

Crops (design, Unity, difference ×4: `viewport-classes/hairline-dash-1280.png`, `hairline-dash-1366.png`,
`hairline-one-1366.png`): Chromium draws the dash's 1.2 device px stroke over
two pixel rows (luma 178 and 116 on 49 at 1280×720, 168 and 118 at 1366×768), UI Toolkit most of it in one row (202 with 67
and 50 beside it; 78, 202 and 51), about 0.4 device px higher; the "1" is drawn about half a device pixel lower in Unity (a
row of ink below Chromium's last, one less at the top) with its 1.7 px stem split 200/217 against 211/198. The text, its
box, its line box and its baseline are the same on both sides (to 0.01 device px), and where its glyphs sit horizontally is
within 0.09 device px. The ink colour measure (the median of a line's most inked tenth) assumes some pixels
the stroke covers fully; a glyph whose only stroke covers none of them in one renderer measures its coverage instead, and
the renderers put a stroke between two device pixels differently (Chromium draws glyphs on its own vertical pixel grid, UI
Toolkit at the line's fractional position). It is the small-text scatter of `text-ink.md` section 7 (a short string has no
run in which the renderers' stem differences average out) at its extreme: one glyph of one stroke. The same copies pass at 3840×2160, 2560×1440 and 1920×1080 (ΔE2000 0, 0 and
at most 0.81 over every copy there) and at 1600×900 (at most 3.69); the IR elements' own lines of the same kind ("09:00",
"30") pass at every viewport (ink colour 0 to 0.40). Every other copy passes: the highest ink colour among them is 4.26 at 1280×720
(`day-number#6#1`, limit 4.5) and 4.96 at 1366×768 (limit 5.89). The exact class's small-text limit 4.5 was measured on the
IR elements' text, which has no such glyph; no limit was changed for them.

**Hairline lines (rulings R138, R141).** On a text line whose design has no fully covered pixels the ink's lightness and
amount measure how the stroke falls on the pixel grid, not the text's colour, and the renderers put a stroke between two
device pixels differently. Such a line is judged by its ink's colour direction from the background instead (pixelmatch and
Playwright do not colour-judge anti-aliased pixels either):

- **Which text can be one (ruling R141, fix round 3).** Text of at most 12 device px (`HAIRLINE_MAX_PX`; the suite's
  hairline lines are 10 and 10.67), drawn at opacity 1 (its own times its ancestors', an animation sample's running
  value included) in the colour the capture recorded for it, all of the line in it, and with nothing painted after it
  over its line (after it in the compiler's paint order, which both renderers follow: fix round 4). The golden records
  each text's computed colour and drawn opacity (boxes `color` and `opacity`, design side only), a repeat copy its own
  (a copy whose class mutes it is judged against its muted colour), and marks a line with a run of another colour or
  opacity, a rich inline span (line `mixed`; N-6). Painted after it: every IR element and every written-out repeat copy
  after the text in paint order that paints something, on either side, and the outer shadow each casts (N-5; a copy's
  placed by its own box). What a copy paints is what the golden recorded for it in its own item's state (boxes `paints`
  and `shadow`, design side only: a job's hover or class on a later item gives that copy its fill or its lift's shadow),
  and a later text's text shadow counts too (fix round 4, N-8). A later item of a repeat paints after an earlier one;
  inside an item the compiler's sibling order holds (lint/paint-order.ts, the rule the compiler and lint share: an
  absolute scrim written before the caption it covers paints after it, in CSS and in UI Toolkit; fix round 4, N-9).
  Without a paint order no line is a hairline line. R138's first rule took the colour from the IR's static style and had
  no size, opacity or cover bound: any text whose design ink sat on that colour's ray nearer the background counted, and
  the fix round 1 re-review's probes passed at 16 px with Unity wrong: a label sampled mid-fade (design at opacity 0.6,
  Unity 0.8 or missing glyphs), text under a 30 % veil (Unity at 0.7 or missing glyphs), a muted copy drawn lighter or
  missing glyphs. They fail now, and so do their 10 px versions (`compare.test.ts`, "R141"). The fix round 2 re-review
  found three more ways in: a later element's outer shadow (the kit's are black at up to 0.4, which dims a line along
  nearly its colour's ray from surfaces 900 and 800; R141 took later elements' boxes only), another repeat item's copy
  over the line (only the same item's copies counted), and a rich span (`<p class="secondary"><span class="muted">…`: on
  surface-700 the muted run lies 1.37° off the secondary ray at 0.72 of its contrast). With Unity at 0.7 or two middle
  glyphs missing, 40 of 54 kit shadow cases (surfaces 900, 800, 700; primary, secondary, muted text; shadow 0.15, 0.25,
  0.4), the copy and the span passed; all fail now (`compare.test.ts`, "fix round 3"). The fix round 3 re-review found
  two more: "later" was judged from what a copy's IR element paints in the IR's own state, so a later row that paints a
  30 % layer or casts its lift's shadow only through a hover or class the job gives that row was no cover (N-8), and
  "later" was the IR's DOM order, so an absolute scrim written before the caption it covers, which the compiler moves
  after the caption and CSS paints after it too, was no cover (N-9). With Unity at 0.7 or two middle glyphs missing the
  row's layer, 40 of the 54 shadow cases cast only in the row's own state, a later text's blurred text shadow and the
  scrim passed; all fail now (`compare.test.ts`, "fix round 4"). The suite's 180 hairline lines are the same (fix round
  4's run). U-FONT-004 keeps kit text at 18 CSS px or more, so only 1600×900, 1366×768 and 1280×720 draw text of 12
  device px or less: a defect that shows at every viewport is caught at the others.
- **Fully covered.** A pixel whose luma distance from the line's background is at least 0.85 (`HAIRLINE_FULL`) of the text
  colour's (the recorded one, over that background). A line is a hairline line when its design shows fewer than 3 such
  pixels (`HAIRLINE_PIXELS`, the fewest the ink colour takes its median of), its design ink points the text colour's way
  from the background within 2° (`HAIRLINE_SAME_COLOUR`: it is that colour at partial coverage, not another one) and its
  most covered pixel reaches half of the text colour (`HAIRLINE_PEAK`: a stroke, not text under a translucent layer, such as
  the `dialog` lines under their scrim at 0.26). Measured over the suite's 85974 lines (a probe of every line's pixels): the
  lines with fewer than 3 pixels at 0.85 are exactly the 180 one-glyph lines of one stroke (the em
  dash `row-time#2` at 1280×720 and 1366×768, the "1" `day-number#1` at 1366×768), their design at most 2 such pixels;
  every other line has 3 or more (at 0.90 the count would take in 272 ordinary short lines, at 3 of 10 % of the ink 3455).
  The sample a line's ink colour is the median of reaches only 0.85 of the text colour on ordinary 10 px text too (the
  white "Ay sonu raporu" at 1280×720 in both renderers): that scatter stays with the small-text limits.
- **Its direction.** A pixel of glyph coverage α blends the text colour c over the background b, `p − b = α·(c − b)`, so
  the direction of `p − b` does not depend on coverage in the space the blend happens in. Measured: the design's ink of
  the hairline lines points within 0.02–0.2° of the text colour's direction in sRGB values and 1.8–3.6° in linear light,
  so both renderers blend glyph coverage in sRGB (the gamma composite blends as the design) and the direction is taken
  there: the sum of `p − b` over the line's ink pixels on each side, and the angle between the two.
- **The limit** `textInkDirection` 0.66° (fidelity-thresholds.json): the suite's 180 hairline lines reach 0.26° (`row-time#2`
  at 1280×720), plus 0.4. A dash in the accent colour (#16c2d5) instead of the secondary text colour (#b9d0d6) is 38.0° off, in
  the warning colour (#f2b544) 35.6°; the correct dash drawn over other pixel rows 0.11° (`compare.test.ts`, "R138").
- **Its ink amount** (ruling R141): Unity's ink against the design's, both as each pixel's distance from the background
  summed over the line (so a stroke drawn faint everywhere is little ink), within 0.5 to 2 times (`HAIRLINE_INK_BAND`; the
  suite's 180 hairline lines measure 0.86 to 1.01 that way, 0.69 to 1.17 by the usual coverage ratio). A dash Unity draws
  at 12 % of one row (0.09 of the design's ink) fails.
- **What it does not judge.** On a hairline line the ink's lightness is not judged: **a lightness-only error of such a
  line (the text colour moved toward the background or away from it, the same direction) is not caught**, within the ink
  amount band. Its geometry (box, line count, baselines, where its glyphs sit) is judged as on any line. A line with fully
  covered pixels keeps the ink colour and amount checks, a lightness error there fails as before (the same test).
- **What the direction limit separates** (the fix round 1 re-review's probe: the dash in one kit text colour in the design,
  another in Unity, on each kit surface): any change of hue (36–38°), disabled text (3.3° or more) and grey swaps on surfaces
  900 to 700 fail; secondary against muted on surface-600 (0.29–0.33°) and primary against secondary on surface-500
  (0.81–0.89°, near the suite's 0.26° scatter) do not, or not reliably. The angle is that of the two colours seen from the
  background, so it depends on the surface's tint, not on how different the colours look.

Red tests (`compare.test.ts`, "R138"): the correct dash drawn by Unity over other pixel rows passes (it failed on ink colour
and a 0.70× ink amount before); a dash in the accent or the warning colour fails on its direction; a normal line of fully
covered stems in a lighter colour fails its ink colour; without the recorded colour nothing is recognised.

**The text fit's face (ruling R134).** The fit measures a text only when its characters are present, because a measure that
adds glyphs to a dynamic font queues its atlas update outside the panel's repaint and brings the new glyphs' kerning pairs
only later. It asked that of the font and every face of its weight table (`DesignText.AllPresent`), but UI Toolkit draws a
style with one face (`-unity-font-style` picks the 400 and 700 faces, upright and italic), and only that face gains a text's
characters when UI Toolkit lays it out or draws it: a face of the weight table that never draws the text (the bold face under
a normal label, an italic face) never gets them, and the label kept UI Toolkit's own width for good. That is the
letter-spacing flake: the caps label's font lacked a character of "BÖLÜM BAŞLIĞI" in a face of its weight table in every
update of the failing runs.

Of the two ways the ruling offers, the fit checks only the face the text resolves to. UI Toolkit's font asset API supports
that with public members only (`FontAsset.fontWeightTable`, `resolvedStyle.unityFontStyleAndWeight`;
`DesignText.DrawingFace` maps the style to the weight table's 700 face for bold, its italic face of 400 or 700 for italic,
else the font, as TextCore picks it, and the font itself when that entry is empty). Making the characters present in the
faces before measuring would add glyphs from a layout callback, the atlas work the fit avoids, to faces that may never draw,
and their kerning pairs only through the internal records `DesignText.CompleteFeatures` reaches by reflection; for a linked
line-box variant it re-links every variant of the twin (`FontTwinLink.Refresh`), the churn that drops characters a variant
added itself. When the drawing face lacks a character, the fit measures once more at the panel's next update, after the
draw that adds it (the element's scheduler, which runs before that update's layout), and once more after that: the glyphs a
dynamic face adds while UI Toolkit lays text out bring their kerning pairs through TextCore's queue. It measures again only
while the face's glyph set changes (a face that cannot add the character is not polled), and the measure's cache keys on
that face's character count, so after a re-link that changes the glyph set the fit's next update (a text, style or
geometry change) measures again instead of reusing the width.

Red test (`TextFitTests.AText_WhoseFaceLacksItsCharactersAtTheFirstMeasure_GetsTheBrowsersWidthAfterTheDraw`): a twin
whose normal face holds the text and whose bold face lacks it; a normal label keeps UI Toolkit's width with 15fa093's fit
(red: "a face of the weight table that does not draw the text does not hold it at UI Toolkit's width"), and gets the
browser's width now; a bold label whose face lacks the text at the first measure gets it after the draw, with the same text
width as the bold text on a twin whose faces got the characters and their kerning pairs before it was laid out (the
compiler's path). In a test order where the shared tab twin's glyphs arrive while UI Toolkit lays text out, 15fa093's fit
measured that text before its kerning pairs (Vazgeç 88.00 panel px; 86.01 kerned): the tight-row test passed there only
because the fit's widths were unkerned; it now uses a twin of its own.

**Text changes after the first layout (ruling R136).** An in-game pilot switched a screen's language from Turkish to Arabic
while it was open, and 20 to 23 of its 32 text-sized labels kept their Turkish widths for 15 s and more (a month title 250 px
for 169 px of Arabic text, a status chip 80 px for 106 px, its text spilling out). The fit measured again on a change event,
a style change (the locale's font) and a geometry change only. A text written without a change event (UI Toolkit's data
binding, a list rebinding an item, `SetValueWithoutNotify`) under the label's explicit width changes none of them: the label
keeps the earlier text's width. Measured (`TextFitTests.AText_ChangedAfterItsFirstLayout_IsMeasuredAgain_HoweverItIsWritten`,
with 15fa093's fit and with R134's): a `text` write follows to the new width (it sends a change event), a write without one
stays at the first text's 518 px for "Geri" (49 px). The fit now also looks at every repaint of the label (a text written in
any way repaints it, and so does a font change): when its text, font or style is not the one it last measured, it measures
again at the panel's next update. A repaint of the same text measures nothing (the test repaints it on ten frames), so there
is no per-frame measure. The second case, a locale switch through the String Table binding and the locale controller (the
title's text and font in one frame, Turkish to a German text three times as long and back:
`LocalizedScreenTests.ATextSizedTitle_FollowsALocaleSwitch_ToItsNewTextsWidth`), follows on 15fa093 already in the Editor
test: the binding there writes through `text`, which sends the event; it stays as a regression guard of that path, not R136's
red test. The pilot's write path is not reproduced in Edit mode;
whatever it is, the label repaints with the new text, which the repaint check covers.

**The advanced generator's text (fix round 3, R136-ar).** On 851cf10 the pilot switched an open calendar from Turkish to
Arabic again: 18 to 21 of its 32 text-sized labels kept their Turkish widths, while Latin switches (Turkish to German and
back, Arabic to Turkish) left none. The fit did measure again (its count rose by 2), but the width it applied was the text
handle's `MeasuredWidth`, still the Turkish one (249.75 and 79.2 panel px), where UI Toolkit's own measure gave the Arabic
widths (169.33 and 106.67). The locale controller lays a script locale's text out with the advanced generator, and UI
Toolkit keeps that generator's measure in another member of the handle (`ATGMeasuredWidth`, with its own rounded width;
`TextUtilities.PostProcessMeasuredSize` writes one or the other, by `IsAdvancedTextEnabledForElement`): the standard member
keeps whatever the standard generator measured last. On a label the advanced generator measured first that member is empty,
and the fit left UI Toolkit's own width: Arabic built fresh was right. Now text the advanced generator lays out (UI Toolkit's own test, by reflection; where it is missing,
the element's `-unity-text-generator`) keeps UI Toolkit's own width, as a label built that way did: its width against
Chromium's is not measured. The standard width is used only when it is the width of the text just measured (UI Toolkit's
rounded result is that width ceiled on the panel's pixel grid), and a repaint whose generator changed measures again (the
controller sets the generator on the screen's root). Red test
`TextFitTests.ATextLaidOutByTheAdvancedGenerator_NeverKeepsThePreviousTextsWidth` (Enable Advanced Text on, a label at
"Düzenle Paylaş", its screen switched to the advanced generator, then its text set to "Ekle"): on 933c558 it kept 176 panel
px, the previous text's, where UI Toolkit's own width is 49; now it has UI Toolkit's own width, and back on the standard
generator the browser's width for its text again. The pilot is to confirm it in the game.

**Fix rounds 1 to 3 on the fit (I-2, M-1, N-7).** The repaint check recorded the font and style it compares only for a
non-empty text, so an empty label with a font found its font changed on every repaint and asked the Editor for another
update forever in Edit mode (16 requests in ten repaints); text, font and style are now recorded together, and a font change
while the text stays empty asks at most once (none when a layout callback looked at the new font before the repaint:
`TextFitTests.AnEmptyLabel_RepaintsWithoutAskingForAnotherMeasure`). A label measured
while its face's new glyphs still waited for their kerning pairs in TextCore's update queue (another label's layout added
them that frame: 8 glyphs waiting when its text was set) kept that width, 262.23 panel px
(`TextFitTests.ALabelMeasuredBeforeItsFacesKerningPairsArrive_IsMeasuredAgainWithThem`). Fix round 1 measured again after the
next draw while the queue held the face's glyphs, at most four times; in one full Unity suite run the queue ran only after
those four (when another label's text was generated) and the R134 test's bold label kept 295 against 287 panel px. Since
fix round 2 the fit gives the face all its glyphs' kerning pairs itself before it measures whenever TextCore's newly added
list holds glyphs (`DesignText.CompleteFeatures` and `ClearPairFlags`, the compiler's path), so the measure is kerned at
once and nothing polls; the pairs are then the complete ones (248.54, where TextCore's queue alone gives a new glyph's pairs
as the first glyph only: 249.41), and UI Toolkit draws with them too. Its cache keys on the face's pair count as well.
Fix round 2's completion also took out every pair with a glyph the face does not hold (`DesignText.CompleteFeatures`, the
import's way of keeping a twin's file small). A line-box variant shares its twin's feature table (`FontTwinLink`), and the
twin and each variant can hold glyphs the other added at runtime: a measure on the variant removed the pairs of the twin's
runtime glyphs, one on the twin those of the variant's, so kerning depended on which label measured first (fix round 3,
N-7; `TextFitTests.AMeasureOnALinkedVariantOrItsTwin_KeepsThePairsTheOtherAddedAtRuntime`: 8 of 8 pairs lost in either
order). Since fix round 3 the fit only adds the missing records (`DesignText.AddFeatures`, as TextCore's own queue adds them,
against every glyph of the font file); an import still prunes a twin's file.

**Spacing and size changes (fix round 4, N-10).** The fit measured again on a style change only through
`CustomStyleResolvedEvent`, which UI Toolkit (6000.3) sends only to an element with a custom property: a label under a
compiled screen's style sheet has one (`--design-text-fit`, a rule on the type), a `DesignLabel` outside one does not.
Its repaint check compared the text, font, font style and generator, not the font size or the spacings. A letter-spacing
or word-spacing change, or a font size change under an explicit height, on a label whose width the fit set changes no
geometry, so the label kept the width measured for the old values until an unrelated callback: its text spilled, or kept
spacing it no longer had. Red test
(`TextFitTests.ALabelsSpacingOrSize_ChangedWithoutAnyEventTheFitHears_IsMeasuredAgain`, a label built in code,
letter-spacing then word-spacing then font size changed, four frames each): on c460e33's fit it kept 252 panel px after
a letter-spacing of 4, where its text then needs 273. The fit now records the resolved font size, letter-spacing and
word-spacing with the text and font it last measured, and the repaint compares them too: a repaint of the same style
compares cached values only, and the measure (already keyed on them) runs only after a change. No
CustomStyleResolvedEvent reached the label in the test.

**Rebuilt twins' lookup (ruling R139).** The generator rebuilds a twin in place (a line-box variant with glyphs of its own,
a twin whose source font or atlas settings changed) by copying a fresh asset's serialized fields over it. That replaces the
character table but not TextCore's lookup built from it, which no save writes: the rebuilt font still looked up the
characters it had lost, and `DesignText.Prepare`, which trusts the lookup, added none of them again. Measured
(`TwinFootprintTests.AVariantsReplacedTable_LeavesNoCharacterInItsLookup_SoAPrepareStillReachesIt`): a variant rebuilt with
0 characters looked up 203 entries, 5 of them the characters it had added ("Жизнь"; the other 198 are the control and space
characters TextCore synthesizes into every lookup), and a prepare after it added nothing. An unlink was already clean (it
reads the font asset definition again: 198 after it). The rebuild now does the same. Where the package's own flows reach
it: a rebuilt variant is linked again at the end of the generator's run, which reads the definition again before the compiler
prepares text, so only a rebuilt plain twin (its source or atlas settings changed) kept the stale lookup through that
import's prepare, and its screens' new characters reached it only when UI Toolkit drew them. The public
`FontTwinGenerator.GetOrCreateTwin` without a run's link (the tight-row test's shared twin: 0 characters, a lookup of 199 to
228) is the same state. It is not the letter-spacing flake's root: that label's font lacked a character in its lookup
(`AllPresent` false), where a stale lookup holds extra ones; ruling R134's fix is that one.

Suite: in each of five full runs (three with ruling R134's fit, one with R136's too, one with every change of the task) the
`letter-spacing` caps label has the fit's width at all six viewports (Δw 0, −0.094, 0 and −0.188 device px at 2560×1440, 1920×1080, 1280×720 and 3840×2160,
−0.163 at 1600×900 and +0.122 at 1366×768: the widths of round 5's passing run), where it had UI Toolkit's own in 2 of round
5's 3 runs.

## Suite at six viewports

**Task 35 fix round 4 (2026-11-15, latest).** `scripts/fidelity.sh` on the round's final code (the copies' own paint,
the compiler's paint order, the fit's spacing and size check): **4728 PASS, 0 FAIL**, nothing incomplete; animation
samples 2400 / 0; 788 / 0 at each of the six viewports (exact 3152 / 0, scaled 1576 / 0). 14 min 26 s (setup 16 s,
exports 202 s, import 32 s, capture 211 s, comparisons 384 s, cleanup 17 s). The hairline path takes the same 180 lines
(`row-time#2` 60 at 1280×720 and 60 at 1366×768, `day-number#1` 60 at 1366×768, one line each), colour direction at most
0.26°. The comparison of c460e33 run on this run's captures (its schema given the new optional fields) gives a verdict
identical to this round's in every capture, row and issue: neither change alters a result of the suite. The
letter-spaced caps label has the fit's width at all six viewports (Δw within 0.19 device px).

**Task 35 (2026-11-15).** `scripts/fidelity.sh`, 22 fixtures and 9 components (4728 captures, 2400 of them
animation samples), the final run on every change of Task 35 (rulings R131 to R141 and its fix rounds 1 to 3), 14 min 9 s
(setup 15 s, exports 198 s, import 32 s, capture 205 s, comparisons 381 s, cleanup 15 s; the comparisons take about 17 s
more than round 5's with the 30924 copies' texts checked; fix round 2's run took 15 min 10 s while the pilot's Unity window
ran on the same machine): **4728 PASS, 0 FAIL**, nothing incomplete; animation samples 2400 / 0.

| Viewport | Class | PASS | FAIL |
|---|---|---|---|
| 3840×2160 | exact | 788 | 0 |
| 2560×1440 | exact | 788 | 0 |
| 1920×1080 | exact | 788 | 0 |
| 1280×720 | exact | 788 | 0 |
| 1600×900 | scaled | 788 | 0 |
| 1366×768 | scaled | 788 | 0 |

Before ruling R138 four full runs gave 4608 / 120 each (the hairline copies of `repeat-items`, 60 at 1280×720 and 60 at
1366×768; section "Repeat items' text, the face that draws, what moves"); the 18 divider captures of round 5 and the
letter-spaced label passed in all of them and pass here. What the keys admit in this run (the same elements and values as
fix rounds 1 and 2's runs): the hairline path (rulings R138, R141, fix round 3) 180 lines (`row-time#2` at 1280×720 and 1366×768, `day-number#1`
at 1366×768: 10 and 10.67 device px, opacity 1, all in their recorded colour, nothing painted later over them), colour
direction at most 0.26° against 0.66°, ink amount 0.86–1.01 against 0.5–2 (fix round 2's run); `ssimRoundEdge` 17 elements at 1280×720 (lowest 0.98088) and 148 at the scaled viewports (lowest 0.97664);
`ssimFractionalEdge` 4 (lowest 0.9735); `ssimVectorEdge` 10 (lowest 0.97875); the corner limits 20 samples at the scaled
viewports (ΔE2000 1.02–5.10); `ssimResampledPicture` 6 picture elements (lowest 0.95284) and `deltaE2000ResampledPicture` 3
colour samples (highest 5.49); the scaled small-text ink limit one line above 4.5 (`stacked-text` value-12, 5.49);
`ssimRotated` 19 elements at exact viewports (lowest 0.97792) and 46 at scaled ones (lowest 0.98433); `ssimElementSmall` 212
and 894 (lowest 0.98509 and 0.98413), `ssimPicture` 2 (0.98866). Every admitted edge-band relaxation's evidence: lowest block
outside its band 0.99428, largest 3×3 window ΔE2000 0.854, largest border centre ΔE2000 1.10, largest border width difference
0.26 device px. Ruling R132's static checks in animation samples: 71940 element rows with a ring check of elements no
animation of geometry moves (ring colour ΔE2000 0 at most, ring width within 0.31 device px), 1320 of moving elements left
to the static captures; static captures' rings at most 2.67. No box, baseline or line-extent check fails; the copies'
glyphs sit within 0.45 device px of the design's; the letter-spaced label has the fit's width at all six viewports.

**Round 5 (2026-11-15).** `scripts/fidelity.sh`, 22 fixtures and 9 components (4728 captures, 2400 of them
animation samples), 13 min 33 s (setup 15 s, exports 191 s, import 30 s, capture 198 s, comparisons 364 s, cleanup of the
project copy 14 s): **4709 PASS, 19 FAIL**, nothing incomplete; animation samples 2400 / 0.

| Viewport | Class | PASS | FAIL | What fails |
|---|---|---|---|---|
| 3840×2160 | exact | 788 | 0 | |
| 2560×1440 | exact | 788 | 0 | |
| 1920×1080 | exact | 788 | 0 | |
| 1280×720 | exact | 788 | 0 | |
| 1600×900 | scaled | 787 | 1 | `scroll-area` (a later message's text glyphs outside the dividers' band) |
| 1366×768 | scaled | 770 | 18 | 17 `controls` (a later row's text glyphs outside the dividers' band), `letter-spacing` (the caps label's fit, section "Edge-band evidence") |

What the keys admitted in this run: `ssimRoundEdge` 17 elements at 1280×720 (lowest 0.98088) and 148 at the scaled viewports
(lowest 0.97664); `ssimFractionalEdge` 4 (lowest 0.9735); `ssimVectorEdge` 10 (lowest 0.97875); the corner limits 20 samples
at the scaled viewports (ΔE2000 1.02–5.10); `ssimResampledPicture` 6 picture elements (lowest 0.95284) and
`deltaE2000ResampledPicture` 3 colour samples (highest 5.49); the scaled small-text ink limit one line above 4.5 (5.49).
Every admitted SSIM relaxation's evidence: lowest block outside its band 0.99428, largest 3×3 window ΔE2000 0.854, largest
border centre ΔE2000 1.10, largest border width difference 0.26 device px. No box, baseline or line-extent check fails but
the letter-spaced box.

**Round 4 (2026-11-15).** `scripts/fidelity.sh`, 22 fixtures and 9 components (4728 captures, 2400 of them
animation samples), 13 min 4 s (setup 18 s, exports 186 s, import 27 s, capture 192 s, comparisons 358 s): **4707 PASS,
21 FAIL**, nothing incomplete; animation samples 2400 / 0.

| Viewport | Class | PASS | FAIL | What fails |
|---|---|---|---|---|
| 3840×2160 | exact | 788 | 0 | |
| 2560×1440 | exact | 788 | 0 | |
| 1920×1080 | exact | 788 | 0 | |
| 1280×720 | exact | 788 | 0 | (the radio and the transition sample pass through the edge band, ruling R119) |
| 1600×900 | scaled | 786 | 2 | `background-images` (a picture drawn scaled: SSIM below the floor, a resampled edge's colour), `scroll-area` (repeated items' dividers) |
| 1366×768 | scaled | 769 | 19 | 17 `controls` (repeated table rows' dividers), `background-images`, `stacked-text` (10.67 px ink, ΔE2000 5.49 against 4.5) |

What the edge-band keys relaxed in this run: `ssimRoundEdge` 16 radio captures and 1 transition sample at 1280×720 (lowest
0.98088), 143 keyframes and 5 transitions elements at the scaled viewports (lowest 0.97664); `ssimFractionalEdge` 4
elements (lowest 0.9735); `ssimVectorEdge` 10 (lowest 0.97875); `deltaE2000FractionalEdge` 2 focus-ring corners (4.90 and
1.42). Each remaining failure's cause is in section "Scaled-class residuals". No box, baseline or line-extent check fails.

**Round 3 (2026-11-15).** `scripts/fidelity.sh`, 22 fixtures and 9 components (4728 captures, 2400 of them
animation samples), 12 min 53 s (setup 15 s, exports 188 s, import 26 s, capture 192 s, comparisons 349 s): **4669 PASS,
59 FAIL**, nothing incomplete; animation samples 2394 / 6.

| Viewport | Class | PASS | FAIL | Of which |
|---|---|---|---|---|
| 3840×2160 | exact | 788 | 0 | |
| 2560×1440 | exact | 788 | 0 | (the right-aligned ellipsis fixed by `DesignOverflowLabel`) |
| 1920×1080 | exact | 788 | 0 | |
| 1280×720 | exact | 771 | 17 | 16 `controls` (the unchecked radio's ring anti-aliasing) and 1 `transitions` sample (a translated border Chromium resamples): measured, pending a decision (section "Exact-class captures after the kit's raised text") |
| 1600×900 | scaled | 779 | 9 | 5 `icons`, 1 `background-images` (a picture drawn scaled: SSIM and colour), 1 `button` (focus, SSIM 0.973 not confined), 1 `scroll-area` (1 px dividers), 1 `repeat-items` focus-ring corner (the corner evidence rule) |
| 1366×768 | scaled | 755 | 33 | 17 `controls` (12.8 px table rows and 1 px dividers: SSIM), 5 `icons`, 5 `transitions` samples, 3 `colors-gradients`, 1 `background-images`, 1 `repeat-items` focus-ring corner, 1 `stacked-text` line at 10.67 px (ΔE2000 5.49 against 4.5) |

The 12.5 and 12.8 px ink failures of round 2 pass under the scaled class's small-text bound (section "Text ink at
fractional sizes"); the ring colour check fails nothing (highest 2.67 against 3.1); every box, baseline and line extent
passes.

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

## Ellipsis point: one grapheme at the scaled viewports (ruling R146)

A pilot's verify at 1600×900 and 1366×768: ellipsized titles kept one grapheme more or fewer in Unity than in the design,
the line's ink end +2.5 to +10.6 device px from the design's, each one grapheme's advance; at the exact viewports they
matched. G8 is closed by R146 (it replaces R144, whose runtime cut was reverted: a TwoWay binding could write the cut back
to its source, a same-text rewrite lost it, shrinking titles were never cut, and it still differed from Chromium at the
cut).

- **Chromium's rule** (measured; Inter Regular 20 px, device scale 1, 0.75 and 0.5): it keeps the longest prefix of whole
  graphemes whose advance *inside the whole line* plus the ellipsis's own advance fits the content box. The prefix's
  advance includes the kerning with the first dropped grapheme ("Weekly Today" in a 101.5 px box: "Weekly T…", whose
  in-line end is 84.55 while "Weekly T" measured alone is 86.28); the ellipsis carries no letter-spacing while the prefix
  keeps its own ("Weekly preview" with 4 px spacing in 95.3 px: "Weekl…"); and the first grapheme always stays, clipped,
  in a box narrower than it and the ellipsis. Without kerning or spacing at the cut: "Weekly preview" in an 84 px box,
  "Weekly" 68.05 + "…" 16.39 = 84.44 > 84, so "Weekl…".
- **UI Toolkit's own elision** cut where Chromium does at every exact viewport (the fidelity suite's two ellipsized lines at
  four exact viewports, and the pilot's titles). Under the root scale of a scaled viewport it decides inside its text
  generator at the layout scale and draws scaled; within about an advance of the threshold it keeps one grapheme more or
  fewer. Its elision point is not readable from code (`elidedText` stays empty), so the comparison allows the measured
  difference instead.
- **R146, the comparison** (`ellipsisGraphemes`, scaled block 1, exact class 0; compare.ts `ELLIPSIS_SHAPE`,
  `ELLIPSIS_AMOUNT`): the golden capture records a cut line's `ellipsis` (the kept prefix's in-line end, the advances of
  the last kept and the first dropped grapheme, the ellipsis's width; capture.test.ts checks that the design's ink ends
  within the ellipsis's advance after it for the kerned, spaced and narrow cases). At a scaled viewport a line whose start
  is within ±boxPx, whose end is the design's ellipsis glyph (its column profile matched to the design's: shape error at
  most 0.45, ink amount 0.8–1.6 of the design's) and whose ellipsis lies within the advance of the design's first
  dropped grapheme (one more) or last kept grapheme (one fewer) plus boxPx passes its ink extent; its baseline and ink
  colour keep their limits, and its ink amount is taken over the prefix both draw plus the ellipsis. Measured on the
  suite's lines with the dots drawn right: shape 0.06–0.34, amount 1.08–1.31 (Unity's dots are a little heavier); a letter
  where the dots are: 0.65–1.30 and 3.5–4.1. Tests (compare.test.ts): one grapheme more or fewer passes at a scaled
  viewport and fails at an exact one; two graphemes, a wrong text (other glyphs, half the ink) and a missing ellipsis
  fail; a line the design does not cut gets no allowance.
- **The ellipsis glyph itself**: a twin without U+2026 added it while drawing, and the line-box variant drew another glyph
  (a curve) in place of the dots at every viewport of the suite's text-spacing capture; the ink extent check let it pass,
  and one 3840×2160 capture failed by 1.15 px. The import adds U+2026 to the twins of every screen with an ellipsized text
  (`ScreenCompilerTests.ScreenStrings_HoldTheEllipsis_WhenATextEndsInOne`); the dots then match the design's at all six
  viewports.
- **R147, the glyph at every viewport**: a wrong ellipsis glyph is a visible defect at any size, so the glyph check of
  R146 (shape error at most 0.45, ink amount 0.8–1.6) applies at the exact viewports too; a line that fails it is an `ink`
  issue ("does not end in the design's ellipsis"). Measured on crops of the text-spacing capture (`r147-*` in the
  compare fixtures, the ellipsis matched on its own columns since Task 37): the dots 0.06–0.32 and 1.08–1.26 at the exact
  viewports, 0.22–0.34 and 1.18–1.31 at the scaled ones (0.06–0.34 in all), so one band serves both classes; the curve
  0.95–1.67 at the exact viewports and 1.20–1.50 at the scaled ones. Tests: the dots pass at all six viewports, the
  curve fails at all six.
- **Fix round 3**:
  - *The record's scale* (N7) is exactly 1 unless an ancestor transforms; it was the drawn width over the rounded
    `offsetWidth`, which put a fractional box near the threshold one grapheme off (a 96.4 px box: 3 "W" recorded where
    Chromium draws 4; capture.test.ts sweeps such boxes, one with padding).
  - *The glyph's height* (N9): the column profile alone passed dots at another height, so the ellipsis's rows, counted from
    each side's baseline and matched within ±1 device px, must differ by at most 0.4 of its mass (`ELLIPSIS_ROWS`):
    measured 0.04–0.09 for the dots at the exact viewports, 0.07–0.29 at the scaled ones, 0.41–0.96 for the curve, 1.0 for
    dots 2 device px off; raised dots fail at every viewport (compare.test.ts).
  - *Every ellipsized element* gets U+2026 in its twins (N11), also one empty in the design and filled at runtime.
- **No record, so the strict check** (the extent within ±boxPx, no glyph check, no allowance): a line that does not end in
  an ellipsis (no `text-overflow: ellipsis`, `overflow-x: visible`, a line that wraps or fits), an element whose
  `direction` is right-to-left, text with a right-to-left character or a bidi control, graphemes whose x does not grow,
  a `font-stretch` other than 100 % (the canvas measures the normal face; lint allows only 100 % today), an element drawn
  rotated, and an element with a nested IR element.
- **The advanced generator** is chosen on the Unity side (by locale), so the design cannot leave its text out: a line
  that qualifies gets a record from Chromium's grapheme clusters whatever generator Unity uses. At an exact viewport it is
  judged strictly (extent ±boxPx and the glyph); at a scaled viewport the allowance is bounded by the design's own next or
  last grapheme advance plus boxPx, so it never admits a second grapheme wider than about a device pixel, and the glyph's
  window reaches a pixel before Unity's ellipsis and sees such ink.


## Ellipsized titles of a pilot screen (Task 37)

A pilot screen's calendar cards (a 20/24 regular title after a bold time, ellipsized in a 48 px card; a status chip),
verified at the six viewports with the captures kept (`design_ui_verify { keepCaptures: true }`) and compared again offline.

- **The goldens had no ellipsis record.** The screen's export came from an extractor before rulings R146 and R147 and was
  reused (the extraction revision had stayed at 2): no line had a record, so neither the glyph check nor the allowance ran.
  The extraction revision is 3 and the tool hash covers the boxes schema; the next import exported it again.
- **Rows at fractional baselines.** With the records, every ellipsized title failed the glyph check at every viewport
  (`rows` 1.00): Chromium's baseline 785.797 against Unity's 786 moved Unity's rows by 0.203, and the rows were then
  compared at fractional positions that hold no design ink. The dots lay on the same pixel rows (rows 783 to 786 on both
  sides). The rows compared are the whole ones around both now: 0.07 for that title.
- **The ellipsis matched with the prefix's last glyph.** Where Unity keeps a narrow grapheme more (a space, 3.4 device px
  at 1600×900), the alignment window reached 4 px into the prefix, whose last glyph Unity draws at the same place: the
  dots were placed 0.7 px off (shift 2.57 against their 3.3) and their shape failed (1.04). The ellipsis is matched on
  its own columns now (0.51 for that title).
- **R146's allowance takes exactly the one-grapheme cuts.** Over every scaled capture (5218 ellipsized lines), Unity kept
  one grapheme more in 1287 (a cut shift of +2.65 to +9.76 device px, each within the design's next grapheme's advance
  plus 1 px), never one fewer and never two (0 outside the bound).
- **The glyph check below 16 device px.** Correct dots (the twins hold U+2026; pixel dumps show the three dots on both
  sides, a fraction of a pixel apart and spread over one or two rows) measure, by viewport, with the ellipsis matched on its
  own columns:

  | Viewport (title size) | Lines | Shape | Rows | Amount | Over a limit |
  |---|---|---|---|---|---|
  | 3840×2160 (30 px) | 52 | 0.06–0.10 | 0.12–0.19 | 1.06–1.08 | 0 |
  | 2560×1440 (20 px) | 52 | 0.07–0.20 | 0.05–0.13 | 1.09–1.13 | 0 |
  | 1920×1080 (15 px) | 52 | 0.31–0.75 | 0.19–0.46 | 1.10–1.25 | shape or rows |
  | 1600×900 (12.5 px) | 52 | 0.07–0.85 | 0.08–0.44 | 1.12–1.30 | shape |
  | 1366×768 (10.67 px) | 52 | 0.14–1.08 | 0.16–0.73 | 1.13–1.55 | shape and rows |
  | 1280×720 (10 px) | 52 | 0.10–0.62 | 0.56–0.74 | 1.20–1.39 | rows on every line |

  The suite's wrong glyph (the curve, 12 to 36 px) measures shape 0.95–1.67, rows 0.50–0.95, amount 1.54–3.16: below
  16 device px the bands of the correct dots and of the wrong glyph overlap on every measure, so no limit separates them
  there, and R147's limits (0.45, 0.4) fail the correct dots. As R147 says, these fail and are reported: on the pilot
  screen they are most of the failures at 1920, 1600, 1366 and 1280 (2 of 3 ellipsized titles and status chips there),
  and at the scaled viewports they withhold R146's allowance from 1152 of its 1287 cuts (only lines whose glyph check
  passes get it). A wrong glyph at those sizes needs another measure (for example three separate ink blobs at the
  design's dot pitch); that is a decision for a ruling, not a limit change.
