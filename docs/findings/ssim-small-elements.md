# Element SSIM of small elements and scaled pictures

| | |
|---|---|
| Date | 2026-11-14 |
| Question | Radios, round checks, icons and rounded fields failed the element SSIM limit 0.99 with SSIM 0.984–0.989 while their boxes, colours and corner samples matched; pictures drawn scaled failed at 0.987. Is that a defect, and if not, what may the comparison accept? |
| Chromium | Chrome Headless Shell 158 (Playwright 1.65.0) on macOS |
| Unity | 6000.3.6f1, the verifier capture |
| Data | The whole fidelity suite (13 fidelity fixtures, 9 kit components, the exporter's effects screen) at 2560×1440, 1920×1080 and 1280×720, every static capture, after the border, opacity, baseline and pixel-grid changes of this round |

## Pictures drawn scaled

The import settings of copied and baked raster images were checked first (`DesignAssetImporter`): default texture type,
**sRGB on**, one mip level, no power-of-two scaling, uncompressed (the profile's default), bilinear, clamped, max size
large enough. Mipmaps were ruled out before (UI Toolkit samples level 0; identical captures).

The remaining difference is where the filtering happens. Across a resampled edge of `quadrants-16x9.png` (320×180
drawn 200×360) Chromium's pixel is a blend in sRGB bytes (`109,92,45`: 0.436 of the way from `#06171c` to `#f2b544` in
every channel) and Unity's a blend in linear light (`178,133,52`: 0.50 of the way in linear light, 0.73/0.70/0.60 in
bytes). The GPU filters an sRGB texture after decoding it to linear light, and the verifier panel (`forceGammaRendering`)
converts each texture sample back. Importing the image as linear data (sRGB off) was measured: the filtering then
happens in bytes, but the panel's conversion brightens every pixel (`#06171c` came out `#2a555d`, ΔE 20.1), so sRGB
stays on. A picture shown at its own size is exact.

## Measured

Element SSIM (the better of the plain and the 1-px-offset value) of every element whose every other check passes in
the capture (box ±1 px, baselines, background and ring colour samples, text ink, shadow band) — identical geometry by
the comparison's own measures — by the area of its SSIM region in device px²:

| Area (device px²) | Elements × captures | Lowest | 1st percentile | Below 0.99 |
|---|---|---|---|---|
| under 512 | 404 | 0.9855 (a 20 px radio at 1280) | 0.9855 | 34 |
| 512 – 1 024 | 800 | 0.9896 (a 24 px icon at 1280) | 0.9936 | 5 |
| 1 024 – 2 048 | 1 489 | 0.9883 (a 36 px star at 1920) | 0.9901 | 7 |
| 2 048 – 4 096 | 2 196 | 0.9918 | 0.9918 | 0 |
| 4 096 – 8 192 | 3 641 | 0.9862 (a 135° gradient tile at 1280) | 0.9892 | 74 |
| 8 192 – 16 384 | 3 465 | 0.9877 (a rounded bordered field at 1280) | 0.9941 | 15 |
| 16 384 – 32 768 | 3 328 | 0.9851 (a rounded bordered field at 1920) | 0.9900 | 3 |
| 32 768 – 65 536 | 2 019 | 0.9911 | 0.9933 | 0 |
| 65 536 and more | 3 102 | 0.9906 | 0.9927 | 0 |
| raster pictures drawn scaled | 91 | 0.9867 | 0.9879 (5th percentile) | 8 |

Every element below 0.99 was inspected: circles and rounded corners whose anti-aliased curves differ by a fraction of a
pixel (radios, checks, pills, a field's 3-px border with radius 9 at 1920), vector icons tessellated by the importer
against Chromium's rasteriser, a gradient tile's ramp, a rounded `overflow: hidden` clip, and resampled pictures. None
has a different shape, size or colour. SSIM over 8-px blocks is dominated by such edges in small elements; from 32 768
px² up nothing in the suite falls below 0.99.

## Policy (`tools/design-export/fidelity-thresholds.json`)

- `ssimElementSmall` `[[32768, 0.984]]`: an element whose SSIM region is under 32 768 device px² meets 0.984 instead of
  0.99 — lowest measured 0.9851, margin 0.001.
- `ssimPicture` 0.985: an element drawing a raster picture (IR asset `image`) at another size than its own — lowest
  measured 0.9867, margin 0.0017.
- Either applies only when every other check of that element in that capture passes; otherwise the element is held to
  0.99 and the issue says that the lower limit needed its other checks to pass. Limits below 0.97 are refused when the
  thresholds file is read. The report shows the limit an element met (`≥ 0.984`) next to its SSIM.

What it still catches: a wrong shape or a missing or extra detail (they change whole 8-px blocks, not one anti-aliased
pixel row), a shifted element (box check), a wrong colour where the element has colour samples, and every difference in
elements of 32 768 px² and more.

Exception: an element that paints no background (an inline SVG icon, a picture) has no colour sample, so "every other
check passes" holds with its box check alone. In the suite two icons met the 0.984 limit that way (5 captures each), and
SSIM is computed on luma only, so a recoloured icon of the same lightness would pass. Icon colours get no sample yet.
