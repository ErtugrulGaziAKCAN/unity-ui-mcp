# Where the gamma composite draws: sort order among overlay canvases and panels

| | |
|---|---|
| Date | 2026-11-15 |
| Question | `DesignUiGammaComposite` drew its panel texture at the end of the frame, over everything: a Screen Space - Overlay canvas with a higher sort order (a settings menu) showed under the composited panel while its buttons still took the clicks. Where does Unity draw a runtime panel among overlay canvases and other panels, and can the composite draw exactly there? |
| Unity | 6000.3.6f1, Metal, Linear colour space, the Built-in render pipeline and URP 17.3; a GUI Editor's Game view at 2560×1440 (the overlay pass does not run in batchmode) |

## How Unity orders them

UI Toolkit's screen panels are drawn by the same native pass that draws the overlay canvases. Read from
`UnityEngine.UIElementsModule` (IL of `UIElementsRuntimeUtility`) and measured by wrapping the hooks in a GUI Editor:

1. While it draws the overlay canvases of a display in sort order, Unity calls `Canvas.externBeginRenderOverlays(display)`,
   then `Canvas.externRenderOverlaysBefore(display, canvas.sortingOrder)` right before each canvas (an `int`; two
   canvases of sort order 10 give two calls with 10), and `Canvas.externEndRenderOverlays(display)` last. Measured per
   frame with canvases of sort order 5, 10, 10 and 15: `Begin(0) Before(0,5) Before(0,10) Before(0,10) Before(0,15)
   End(0)`, with the back buffer bound (`RenderTexture.active` null) and the scene's camera current.
2. UI Toolkit answers with `RenderOverlaysBeforePriority(display, max)`: it walks its screen panels sorted by
   `sortingOrder`, then by the order the panels were made (`m_RuntimePanelCreationIndex`), from where the previous call
   stopped, and draws each until it reaches one whose sort order is not below `max`. A panel that renders into a texture
   or is transient, or belongs to another display, is passed over. `End` draws the rest.
3. So a panel draws **over every overlay canvas of a lower or the same sort order and under every canvas of a higher
   one**, and among panels **by sort order, the same sort order in the order the panels were made**. Pointer input
   follows the same order.

A panel that renders into a texture (the composite's) is still in the sorted list, at its place; the walk only skips it.

## What the composite does

`DesignUiOverlayOrder` wraps the three hooks while a composite is attached. When UI Toolkit's walk would pass a composited
panel, it lets UI Toolkit draw everything before it (its own walk up to the panel's sort order, then the panels of that
sort order made before it, one by one with UI Toolkit's own step), draws the panel's texture with the composite pass (a
full-screen quad into the bound target, the same shader as before) and leaves the panel to UI Toolkit's walk, which passes
over a panel that renders into a texture. The rest is UI Toolkit's again. It follows the walk's position itself (each step
is decided by the sorted list alone) and writes it only when it drew panels of a composited panel's sort order made
before it. The members it needs are internal (the sorted list, the walk, one panel's draw, the walk's position, the three
hooks); they are bound once to typed delegates, so a frame allocates no managed memory
(`GammaCompositeTests.OverlayPass_WithACompositedPanel_AllocatesNoManagedMemory`). When one is missing (another Unity
version) the composite draws at the end of the frame as before and logs that once.

Each composite stamps every texture the pass drew with the frame; at the end of the frame it draws, over everything as
before, every texture the pass did not draw (no overlay pass in that frame, a panel on another display, hooks replaced by
other code). An unknown never hides the screen. Another wrapper put around the hooks later is left alone (wrapping it again
would make the hooks call themselves) and the composite keeps drawing inside it.

## Measured

Scene: overlay canvases of sort order 5 (red), 10 (green), 10 (dark green) and 15 (blue); panels of sort order 7.5
(white), 8 (yellow), 10 (cyan, composited) and 12 (magenta), overlapping. 13 sample points, the screen captured with the
composite on, then the same scene with it off (the panel an ordinary on-screen panel, drawn by UI Toolkit):

| Sample | Composited | Same panel on screen |
|---|---|---|
| panel 10 over canvas 10 (same sort order), both canvases | `#16C2D5` | `#16C2D5` |
| canvas 15 over panel 10 | `#0000FF` | `#0000FF` |
| panel 12 over panel 10 | `#FF00FF` | `#FF00FF` |
| panel 10 over panel 8 | `#16C2D5` | `#16C2D5` |
| canvas 10 over panel 8, panel 8 over canvas 5, panel 8 over panel 7.5, canvases among themselves | same | same |

13 of 13 sample points identical. Before this change the composite drew the texture after the frame's overlay pass, over
every canvas and panel (the defect report: a settings menu on a higher sort order showed under the screen).

`GammaCompositeTests.DrawOrder_FollowsSortOrder_…` runs the same order in EditMode (the overlay pass does not run in
batchmode, so the test calls the hooks in the measured sequence, with solid rectangles for the canvases, into an sRGB
texture): canvases of sort order 5, 10 and 15 and on-screen panels of sort order 8, 12 and 10 (made before and after the
region's copy), with the composite attached before and after the region made its copy, after a resize and inside
another code's wrapper of the hooks.

## URP

The same probe in a copy of the sample switched to URP 17.3 (a Universal Renderer asset made in the copy, the copy removed
afterwards): the same hook sequence per frame (`Begin(0) Before(0,5) Before(0,10) Before(0,10) Before(0,15) End(0)`, the
back buffer bound, no current camera), and **13 of 13 sample points identical** with the composite on and off. With the
ordered draw switched off (the end-of-frame composite of earlier versions) the composited panel covered canvas 15 and panel
12 there too: the defect reproduces on URP and the ordered draw removes it.

In the first Play session of a fresh project copy, on both pipelines, the on-screen panels showed in Unity's cyan
placeholder for shaders still compiling (asynchronous shader compilation in the Editor) in the first capture; a second
session of the same copy gave the results above. Not a composite effect: the composited panel itself was right in both.

## Cost

CPU time of the overlay hooks per frame (240 frames, the scene above, Built-in pipeline, second session):

| Route | Per frame |
|---|---|
| Before: UI Toolkit's hooks 0.0173 ms, then the end-of-frame composite (one `Graphics.Blit`) 0.0016 ms | 0.019 ms |
| Now: the hooks with the composite drawing inside them | 0.023 ms |

About 0.004 ms more on the CPU and no managed allocation (an earlier version that read UI Toolkit's internals by
reflection on every call took 0.041 ms and allocated every frame). The GPU work is the same full-screen pass with the same
shader, now inside the overlay pass instead of after it; textures are unchanged.

## Not covered

- HDRP, URP camera stacks and HDR output: not measured. A frame whose overlay pass does not draw a composited panel gets
  that panel at the end of the frame (over everything, as before), never a missing screen.
- Canvas sorting layers: the hook receives only the canvas's sort order, as UI Toolkit does; the composite follows UI
  Toolkit there too.
- A player build: the same code path; managed code stripping keeps the members UI Toolkit itself uses. If stripping
  removes one, the composite falls back to the end of the frame and says so.
