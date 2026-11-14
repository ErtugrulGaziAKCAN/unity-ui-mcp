# Font twins on disk: one atlas per face, variants without glyphs

| | |
|---|---|
| Date | 2026-11-14 |
| Question | A project with an Inter family and Noto Sans, Arabic, Japanese and Simplified Chinese fonts for 11 locales had 2.9 GB of font twins (176 assets). Where does the size come from, and how small can the twins be with the same rendering? |
| Unity | 6000.3.6f1 (TextCore FontAsset, standard and advanced text generators) |

## Measured

A twin file is YAML; its atlas pages are stored as hex text (two characters per byte of an Alpha8 page). In the project:

| Twin (one of 8: plain and 7 line-box variants) | Atlas page | Glyphs | Kerning pairs | File |
|---|---|---|---|---|
| Noto Sans Arabic | 4096 × 4096 | 105 | 38 (and 126,000 lines of mark records) | 37.4 MB |
| Inter Semibold | 2048 × 2048 | 138 | 39,262 (3,085 of them between two of its own glyphs) | 25.4 MB |
| Noto Sans JP | 2048 × 2048 | 206 | 0 | 8.5 MB |

Three causes, multiplied:

1. **Every line-box variant was a whole copy.** A variant differs from its twin only in its face metrics (line height,
   ascent, descent: [text-baselines.md](text-baselines.md)), but it carried its own atlas, glyph table, characters and
   font features: 8 copies of each face.
2. **Pages of the TMP asset's atlas size.** The twin took the TMP asset's atlas size for every page: one 4096 px page
   (33.5 MB of text) for 105 Arabic glyphs that need about a seventh of it.
3. **Every kerning pair of a glyph with any glyph of the font.** TextCore stores a new glyph's pairs with the new glyph
   *first* against every glyph of the font file (measured: `T` alone brings 1,004 pairs, and is never the second glyph of
   one), so a twin holding 138 Inter glyphs held 39,262 pairs. Mark records (Arabic) grow the same way.

Faces made before twins were limited to the faces in use (Inter Black, Thin, …) were never removed either: 18 Inter faces
× 8 = 144 of the 176 assets.

## Change

- **Variants share their twin's glyphs.** A variant's file holds its face metrics, settings, fallbacks and weight table,
  with empty glyph, character and feature tables and a 1×1 page (a few KB). The loaded variant is linked to its plain
  twin (`FontTwinLink`): the twin's glyph objects, font feature table, atlas pages and material by reference, and
  characters of its own (TextCore lays a line out with the face metrics of the font asset a character belongs to). It has
  no free atlas space, so a glyph it adds itself goes to a page of its own and never into the shared pages. The compiled
  font set lists every variant with its twin and links them when it is loaded; a compiled screen's UXML references its
  font set, so a screen's fonts are linked before its text is laid out. `DesignText` adds a variant's characters to its
  twin and links again. A variant that is never linked renders as an ordinary dynamic font asset.
- **Saves never write a linked variant.** The Editor leaves linked variants out of saves; the package saves a variant
  only after giving it its own empty state back (`TwinLinks.Unlink`), and the Play guard does the same before it reloads
  twins from their files.
- **Pages sized to the glyphs.** A plain twin's pages are the smallest power-of-two page of at least 1024 px (within the
  TMP asset's atlas) that holds its glyphs' padded rectangles with a quarter to spare; a larger page, or glyphs spread
  over pages a larger page would hold, are packed again at each import and kit sync (`TwinAtlas.Compact`). The 1024 px
  floor leaves room for runtime text: a full page makes TextCore add a page, and in the Editor it then reimports the twin,
  which destroys a page added in memory while text still draws from it (measured: a 256 px page spilled in the tests).
- **Font features of its own glyphs only.** After each batch the twin asks the font engine for the pair and mark records
  of all its glyphs and keeps those of two of them (`DesignText.CompleteFeatures`), so the pairs are complete in any
  order the glyphs came in and nothing else is stored.
- **Twins nothing uses leave.** Kit sync and every import delete the twins of faces, line boxes and fonts no profile
  that shares the twin folder uses any more (`TwinPrune`), one asset at a time, and report them. When a profile sharing
  the folder cannot be planned, nothing is deleted and the reason is a warning.

## Result

The project's setup rebuilt in a copy of the sample project (Inter with its 18 faces in the weight table, Noto Sans,
Noto Sans Arabic, JP and SC, 11 locales, the kit's 7 text styles, UI strings of every locale pre-added as an import
does), first with the package before the change, then the same folder after one kit sync and one import with it:

| | Twin assets | Size |
|---|---|---|
| Before (older twins left in place, as in the project) | 176 | 3,524 MB |
| After a kit sync and an import (the same folder) | 48 | 24.6 MB |
| After, from an empty folder | 48 | 24.6 MB |

Largest files after: Noto Sans SC and JP 8.1 MB each (2048 px pages for about 200 CJK glyphs), Inter 3.0 MB per face,
Noto Sans Arabic 2.1 MB; each of the 42 variants 10 KB.

Rendering is unchanged: a linked variant draws the same pixels as the variant with glyphs of its own
(`TwinFootprintTests.LinkedVariant_RendersTheSamePixels_AsTheVariantWithGlyphsOfItsOwn`), the line-box baselines hold
(`LineBoxStyleTableTests`, `FontTwinGeneratorTests`), and the fidelity suite passes.

## Limits

- The link sets TextCore fields by reflection (`FontTwinLink.Lookup` names them); a Unity version without them renders
  every variant as an ordinary dynamic font asset, with its own glyphs in memory.
- Glyphs a variant adds itself at runtime (text no `DesignText` call prepared) go to a page of its own: text that mixes
  them with shared glyphs draws from two pages.
- A host that renders a twin variant without loading a compiled screen or its font set gets an unlinked variant (correct
  glyphs, rasterized on first use, the first layout of the standard generator unkerned).
