# Colour in Linear-colour-space projects: the gamma composite

| | |
|---|---|
| Date | 2026-11-14 |
| Question | The verifier captures a UNorm target with `forceGammaRendering` (gamma-space blending, as Chromium), but an ordinary on-screen panel of a Linear project blends in linear light, so a passing verdict did not hold in game for translucent colours. Can the game show the verifier's colours, and what does the ordinary panel cost in fidelity? |
| Unity | 6000.3.6f1, `samples/FidelityProject` (Linear colour space, built-in render pipeline), Metal on Apple M4 Pro |
| Chromium | Chrome Headless Shell 158 (Playwright 1.65.0) |

## The gamma composite

`DesignUiGammaComposite` (runtime component, one per PanelSettings asset) takes Unity's documented route for gamma UI in
a Linear project
([`PanelSettings.forceGammaRendering`](https://docs.unity.com/en-us/engine/6000.3/script-reference/unityengine/uielements/panelsettings/forcegammarendering)):
the panel renders into a screen-sized `R8G8B8A8_UNorm` RenderTexture with `forceGammaRendering` on, which is exactly the
verifier's setup, and at the end of every frame a full-screen pass (`Hidden/DesignUi/GammaComposite`, in the package's
Resources) composites it over the screen. The texture holds sRGB-encoded premultiplied colours; the pass decodes them to
linear light, so the screen's sRGB target stores the panel's bytes again.

Measured (`GammaCompositeTests`, composite into an `R8G8B8A8_SRGB` target that stands in for the screen):

| Pixel | Design (Chromium) | Gamma composite | Ordinary on-screen panel |
|---|---|---|---|
| opaque `#16c2d5` | `#16c2d5` | `#16c2d5` | `#16c2d5` |
| 25 % white over the panel's `#0b1f26` | `#48575c` | `#48575c` | `#8a8b8d` (ΔE2000 22.3) |
| 25 % white over the game's own (black) image | `#404040` | `#898989` | `#898989` |

Inside the panel every colour is the verifier's. Where the panel itself is translucent over the game's camera image, the
last blend is in linear light, as for any UI in a Linear project; a design has no camera image, so the verifier cannot
judge that part.

Cost: a colour and a depth-stencil texture of the screen's size (8 bytes per pixel: 29.5 MB at 2560×1440) and one
full-screen pass per frame, 0.14 ms at 2560×1440 on the measuring machine (200 composites, GPU-synchronised). Pointer
input maps one to one (the texture is the screen's size); the texture follows the screen size.

## The verifier follows the profile

`DesignUiProfile.colorPath` says what the game uses, and the capture renders through it:

- **Gamma Composite** (default): UNorm target with `forceGammaRendering`, as before. In a Linear project the verify
  answer says the verdict holds for panels rendered through `DesignUiGammaComposite`.
- **Linear Panel**: an `R8G8B8A8_SRGB` target without `forceGammaRendering`, the bytes an ordinary on-screen panel
  stores. The verdict then shows the game's real colours, and verify warns that translucent colours drift.

The capture records both in `boxes.meta.json` (`unity.colorSpace`, `unity.colorPath`), and the comparison reports them
(`colour` in the verdict). A Gamma project blends in gamma space on both paths.

## The ordinary panel against the design

The whole fidelity suite (19 fixtures and 9 kit components, 2355 captures at 2560, 1920 and 1280) captured through the
Linear Panel path (`DESIGN_UI_FIDELITY_COLOR_PATH=linear`), against the same goldens: **107 pass, 2248 fail**. The
Gamma Composite path passes every capture of the same suite.

| Check | Failures | Measured |
|---|---|---|
| Text ink amount per line | 6997 lines | 0.63× to 1.42× the design's ink (median 1.12×): anti-aliased glyph edges blended in linear light make light text on dark backgrounds heavier, dark text lighter |
| Text ink colour | 290 lines | ΔE2000 median 7.2, up to 26.1 |
| Colour at sampled points | 210 samples | ΔE2000 median 7.3, 90 % under 14.8, up to 37.1 (translucent fills, overlays, scrims) |
| Element SSIM | 732 elements | down to 0.59 (median of the failures 0.97): anti-aliased edges, shadows, gradients over translucent layers |

Only screens without text and without translucency pass on that path (opaque colours are stored identically). So
the default colour path is **Gamma Composite**, and a Linear project shows design screens through
`DesignUiGammaComposite`; the Linear Panel path is there to verify what a game that does not use the component shows.
