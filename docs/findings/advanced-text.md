# Right-to-left and shaping text with the advanced text generator (Unity 6000.3)

Measured in `samples/FidelityProject` (Unity 6000.3.6f1, macOS, Metal, EditMode panels on a RenderTexture) with the
package's font twins of a TMP Arabic font (macOS `SFArabic.ttf`) and of Inter, plain and line-box variants, and a
font asset made directly from the TTF.

## What a project must set

1. **Project Settings > UI Toolkit > Enable Advanced Text** on. Without it UI Toolkit has only the standard text
   generator: no shaping (Arabic letters stay in their isolated forms) and no bidirectional algorithm.
2. **ICU data on every PanelSettings a player uses.** Switching the setting on makes Unity assign its ICU data asset
   (`icudt73l`) to every PanelSettings asset it can write and save them. In a player, `IsAdvancedTextEnabledForPanel`
   answers from the panel's PanelSettings, so a PanelSettings without ICU data renders unshaped. A PanelSettings inside a
   package installed from git or a registry is read-only and does not get it: set the DesignUiProfile's
   `panelSettings` (and the document's) to a PanelSettings asset in the project, or assign its ICU data by hand.
   Runtime copies (`DesignUiPanelRegion` makes one for another sort order) keep the ICU data of the asset they copy.
3. **Switch it in the Project Settings window, then restart Play** (or the Editor). Switching it while documents
   exist rewrites the PanelSettings assets, and Unity re-creates every open `UIDocument`'s root (measured: the root a
   screen had before the switch is detached, `panel == null`, and a new tree is cloned from the UXML). Anything built
   on the old root — a generated view, a `LocaleFontController`, style sheets added in code — keeps writing into a tree
   nobody shows. A host screen whose text all disappeared when the setting was switched on during Play matches this:
   its view still drove the old tree. `DesignUiPanelRegion` binds the new root (its locale controller
   follows) and raises `RootRebuilt`; without a listener it warns once. **A host recreates its view on the new root in
   that handler** and binds its data and events again, for example
   `region.RootRebuilt += root => { view = new PlannerView(root); presenter.Bind(view); };`. The package does not
   rebuild a host's view itself: only the host knows its data and handlers. In a player the setting never changes while
   the game runs, so this happens only when it is switched in the Editor during Play.

## Measurements (setting switched on before the panel exists)

| Font asset | Generator | Glyph quads, "سلام ٢٠٢٦ 2026 12:15" | Lit pixels |
|---|---|---|---|
| Arabic twin | standard | 17 | 1189 |
| Arabic twin | advanced | 19 | 1118 |
| Arabic twin, line-box variant | advanced | 19 | 1120 |
| Arabic font asset from the TTF | advanced | 19 | 1112 |
| Inter twin ("Takvim 2026 12:15") | standard / advanced | 15 / 17 | 1276 / 1276 |

The advanced generator shapes with the twins as with a font asset made from the TTF (lam + alef become one glyph:
"سلام" is 3 glyphs instead of 4); line-box variants (changed line metrics) and a PanelSettings copy made before the switch
render the same. The source font file reaches the advanced generator through the twin's `sourceFontFile`
(`FontAsset.CreateFontAsset(Font, …)` sets it). With the setting off, a requested advanced generator logs "Advanced Text
Generator is disabled but the API is still called" and renders like the standard one.

## Direction

The standard generator reverses a whole string under `LanguageDirection.RTL` (no bidirectional algorithm): letters,
digits and Latin alike ("6202" for 2026, "51:21" for 12:15). `LocaleFontController` therefore sets the RTL direction only
while Unity's check says the advanced generator is on; off or unknown, a right-to-left locale keeps the `rtl` class
(alignment rules) and left-to-right direction, and its issue says it needs Enable Advanced Text. With the generator on,
"2026" inside a right-to-left paragraph keeps its order (panel test
`LocaleFontControllerTests.ProjectSettingOn_ArabicTwinText_IsShaped_AndItsDigitsKeepTheirOrder`, which switches the
project setting the settings window's way before it makes its panel and restores every file it wrote).
