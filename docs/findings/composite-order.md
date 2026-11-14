# Where the gamma composite draws: sort order among overlay canvases and panels

| | |
|---|---|
| Date | 2026-11-15 |
| Question | `DesignUiGammaComposite` drew its panel texture at the end of the frame, over everything: a Screen Space - Overlay canvas with a higher sort order (a settings menu) showed under the composited panel while its buttons still took the clicks. Where does Unity draw a runtime panel among overlay canvases and other panels, and can the composite draw exactly there? |
| Unity | 6000.3.6f1, Metal, Linear colour space, Built-in render pipeline; a GUI Editor's Game view at 2560×1440 (the overlay pass does not run in batchmode) |

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
full-screen quad into the bound target, the same shader as before) and moves the walk past it. The rest is UI Toolkit's
again. A frame in which no overlay pass reached the wrappers (no overlay pass, or the hooks were replaced by other code)
falls back to the end-of-frame composite. The members it needs are internal (the sorted list, the walk's position, the
walk, one panel's draw and the three hooks); when one is missing (another Unity version) the composite draws at the end
of the frame as before and logs that once. Another wrapper put around the hooks later is left alone (wrapping it again
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

## Cost

CPU time of the overlay hooks per frame (240 frames, the scene above):

| Route | Per frame |
|---|---|
| Before: UI Toolkit's hooks 0.0147 ms, then the end-of-frame composite (one `Graphics.Blit`) 0.0059 ms | 0.021 ms |
| Now: the hooks with the composite drawing inside them | 0.041 ms |

About 0.02 ms more on the CPU (the walk reads UI Toolkit's internals by reflection). The GPU work is the same full-screen
pass with the same shader, now inside the overlay pass instead of after it; textures are unchanged.

## Not covered

- URP and HDRP: their overlay UI pass calls the same native canvas rendering (and so the same hooks); not measured here
  (the sample project uses the Built-in pipeline). A pipeline whose frame has no overlay pass gets the end-of-frame
  composite.
- Canvas sorting layers: the hook receives only the canvas's sort order, as UI Toolkit does; the composite follows UI
  Toolkit there too.
- A player build: the same code path; managed code stripping keeps the members UI Toolkit itself uses. If stripping
  removes one, the composite falls back to the end of the frame and says so.
