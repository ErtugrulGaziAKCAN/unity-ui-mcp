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

## Font assets that were unloaded and loaded again

Measured in a project with Enable Advanced Text on (Unity 6000.3.6f1): every label drawn through a font twin with the
advanced generator rendered nothing (0 glyphs; with a fallback in the same text the job system logged
`ArgumentOutOfRangeException` in `ATGTextJobSystem.ConvertMeshInfoToUIRVertex`, and the text of the elements after it was
lost too), while the standard generator, a font asset made in memory from the same TTF and an `Object.Instantiate` copy of
the same twin rendered. The twins' tables, atlases and glyphs were not the cause (a twin without any fallback or weight
entry failed the same way).

**Cause.** TextCore registers each font asset by instance ID when it is enabled (`TextAsset.OnEnable`:
`kTextAssetByInstanceId.TryAdd`) and removes the entry only in `OnDestroy`. Unity unloads assets without calling it
(`Resources.UnloadUnusedAssets` after a scene change, `Resources.UnloadAsset`, the Editor's asset cleanup after a script
reload). The asset loaded again has the same instance ID, `TryAdd` keeps the old entry, and `TextAsset.GetTextAssetByID`
answers null (the old object is destroyed or collected). The advanced generator looks up the font asset of each text mesh
by that ID: it skips the meshes it cannot find, so their glyphs are dropped, and a skipped mesh before a found one shifts
its per-mesh lists (the exception). A font asset made in memory has a new instance ID, so the comparison passed. Measured
with the registry itself: after an unload and a load the entry for the twin's ID held the old, destroyed object.

**Workaround.** `TextAssetRegistry` (runtime) points the entry of a font asset, its fallbacks and its weight faces at the
loaded asset again. The locale controller repairs its locale's fonts whenever it applies the locale or its root is attached,
every scene load repairs the loaded font assets, the capture repairs them after it mounts a screen, and the Editor repairs
them after a script reload, when Play starts or stops and after font assets were imported. Host code that draws twins with
the advanced generator outside a locale controller calls `TextAssetRegistry.Repair(font)` once its fonts are loaded. On a
Unity version whose TextCore has no such registry it does nothing (`TextAssetRegistry.Lookup` says so, and a test fails so
it is checked again).

## Cycles among the twins

The advanced generator walks fallback lists and weight tables together and rejects every entry from which any cycle can
be reached ("Circular reference detected. Cannot add … to the fallbacks."): with a regular face listing itself at 400, or a
bold face falling back to the regular face whose table lists the bold face, a script font lost its Latin fallback and the
regular face its bold face (synthesized bold instead). TMP's own search has no such check, so TMP tables often have these
cycles. The twins leave out what neither generator uses: a face's own entry, the regular face at 400 (never looked up in a
weight table) and a fallback to a font whose weight table lists the face (a weight face's own fallbacks count only where it
is the font of the text, which compiled screens never make it). Any other entry that leads back to a twin being made is
left out as well and named in kit sync's warnings. The panel test `AdvancedTextTwinsTests` covers both with game-like TMP
tables, reloaded line-box twins and the setting on: Arabic shaped, "2026" and "12:15" in order, Latin and bold Latin drawn,
no cycle reported.
