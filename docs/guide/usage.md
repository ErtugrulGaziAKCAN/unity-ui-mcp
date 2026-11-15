# Using unity-ui-mcp

For designers who draw game screens in Claude Design and for Unity developers who put those screens into the game.
It walks through the whole loop in plain language. Installation is in the [README](../../README.md) and
[INSTALL.md](../../INSTALL.md); the exact design rules are in [RULES.md](../../design-kit/RULES.md). Türkçesi:
[kullanim-rehberi.md](kullanim-rehberi.md).

## The loop

```
Unity project ── kit sync: fonts, font tokens, text styles ──► design kit
design kit ── design-export kit claude ──► Design System in Claude Design
Claude Design: design → variants → pick → revise (one artboard per screen, 2560×1440)
AI client: /unity-ui-mcp + canvas link ── MCP ──► lint → import into the open Unity Editor → verify → report
Unity: the compiled screen + its generated view class ──► presenter written in the game's code
```

The system never interprets a design. It measures the design in a real browser, compiles exactly that into UI Toolkit,
and measures Unity's rendering against the browser's. A design outside the rules stops at lint, with a rule id and a
fix; a difference after import is reported, never smoothed over.

## Once per project

1. **Install** (README, three steps). Unity shows `Window > Design UI > Status` with the bridge state.
2. **Create the profile** in that window (**Create Profile**). The `DesignUiProfile` holds every project setting:
   where generated screens go (`outputFolder`, default `Assets/UI/Generated`) and their namespace, viewports, locales,
   fonts, localization, right-to-left rules, text sizes, and how screens sit in a uGUI shell.
3. **Fonts.** Each locale renders with the TMP font the project already uses. By default that is TMP Settings' default
   font for every locale. A project with a per-locale mapping fills the profile's **Locale Fonts**, or writes a
   `DesignUiFontResolver` subclass in an Editor assembly that asks its own font system, and sets that asset as the
   profile's **Font Resolver** (one source of truth).
4. **The kit.** Setup copies `design-kit` from the clone into `<designRoot>/design-kit`, the project's own kit, and points
   `kitDir` at it (kit sync never writes into the clone). Setup keeps a kit that is already there; after pulling a newer
   clone, run `npx design-export kit upgrade <kitDir> --dry-run` in the clone to see what changes, then without
   `--dry-run`: the clone's base stylesheet, rules, components, text styles and configuration keys replace the old ones,
   and the project's fonts, its own and changed tokens (a value an earlier clone shipped takes the new one), own
   components and list entries (a list it narrowed stays narrowed, told by `.kit-base.json`, the clone configuration the
   kit came from; a components.json that does not parse stops it),
   locales, own keys, own text styles and files and extra viewports stay. The merged kit is
   built (`kit build`, then `--check`) before anything is written; the files it replaces are backed up into
   `<kitDir>/.backup/<UTC time>/files/` with `kit-upgrade.json` listing what it replaced and added (the newest three are
   kept), and it prints the command that restores the kit. Then run a **kit sync** (ask the AI for
   `design_ui_kit_sync`, or `Window > Design UI > Kit Sync`): the project's font files go into the kit, the `--font-*`
   tokens get the fonts' real family names, and the text styles are checked against the fonts' real faces.
5. **Publish the kit to Claude Design.** Ask `/unity-ui-mcp` to publish the kit, or run
   `npx design-export kit claude <kitDir> <outDir>` in the clone and publish `<outDir>/project/` as a Design System.
   It ships the font faces the kit's text styles and font tokens reach (400, 700 and every weight a style names, of the
   families the `--font-*` tokens name); `--all-faces` ships every face. A file over the Design System's 15 MiB file cap
   (a large CJK font) is left out with a printed note and a README line, and `tokens.json` lists exactly the files
   shipped. Repeat after every kit sync that changed something.
6. **Right-to-left and complex scripts** (Arabic and others): turn on **Project Settings > UI Toolkit > Enable Advanced
   Text** before entering Play, and give every PanelSettings a player uses its ICU data
   ([details](../findings/advanced-text.md)).
7. **Localization** (optional): Unity Localization 1.5 or later. In the profile's localization settings, name each
   screen's String Table collection (or a default pattern) and the argument format your tables use (`{name}` Smart
   Strings, or `{0}` indexed).
8. **Resolutions.** Declare in the profile every resolution the game offers (a new profile starts with the kit's six; a
   profile saved before this release keeps its own list). **Viewports** (exact) are those whose panel
   scale keeps the kit's 4 px grid whole (with the 2560×1440 reference: 3840×2160, 2560×1440, 1920×1080, 1280×720):
   every text size, line height and border is whole device pixels there, and lint, kit build and kit sync hold the
   design to it. **Scaled Viewports** are the others players use (1600×900, 1366×768): no design value can be whole
   there, so they are exempt from those rules; verify still lays them out and checks them with the same ±1 device px
   geometry. At such a scale the screen's panel lays out at the next exact scale up (1600×900 and 1366×768 at 0.75)
   and the screen root draws scaled to the actual one, so every edge and line of text lands where the design puts it.
   Kit sync writes both lists into `kit.config.json`; a resolution in neither list lays out the same way but is not
   verified. Kit sync refuses to drop a viewport the kit declares and the profile lacks (a profile saved before the six
   defaults keeps its three): `Window > Design UI > Add Default Viewports to Profile` adds the defaults a profile lacks,
   and `design_ui_kit_sync { addProfileViewports: true }` (batchmode `-designUiAddProfileViewports`) adds the kit's; both
   are one Undo step and save the profile asset only (Edit > Undo takes them out of the open profile; save the project to
   write that to disk). The defaults are a 2560×1440 reference's; a profile with another reference is refused. Kit sync
   also refuses a kit.config.json viewport it cannot read, and warns when the kit and the profile give a viewport
   different classes (it writes the profile's). Remove a resolution the game does not ship from kit.config.json.
9. **Verification captures**: setup's capture command renders on a temporary copy of the project (below); it needs the
   Unity Hub install of the project's version, or `UNITY_BIN`.

## Designing in Claude Design

Attach the kit's Design System to the canvas. Then:

- **One artboard per screen**, titled with the screen id (`club.overview`), with a fixed 2560×1440 root that carries
  `data-u-screen="club.overview"`. Screens are verified at every viewport the kit declares: by default the exact
  3840×2160, 2560×1440, 1920×1080 and 1280×720 and the scaled 1600×900 and 1366×768 (below). Nothing changes in the
  design for a scaled viewport.
- **Start the style with the kit's base stylesheet** (the design system includes it) and use the tokens:
  `var(--color-surface-700)`, `var(--space-4)`, `var(--radius-md)`.
- **Layout with flex only.** No grid, `calc()`, `vw`/`vh`, floats or `position: fixed`. `gap` only where items do not
  wrap. Give flex items an explicit size or `flex-shrink: 0` where their content must not shrink.
- **Boxes hold their text.** A box with `overflow: hidden` is at least its text's line height (a whole number of line
  heights for several lines), or the clip cuts accents and descenders in both renderers (lint U-CSS-047). A word in a
  wrapping text fits its box, also in the translations: UI Toolkit breaks a word that does not fit inside the word, where
  the browser lets it overflow (lint W-TEXT-001 warns; [details](../findings/line-breaks.md)). A text that may be cut is
  one line with an ellipsis.
- **Text uses a kit text style class** (`.text-body`, `.text-title-bold`, …): sizes from 20 to 64 px, weights 400 and
  700. **No text below the readable minimum:** nothing may draw below 9 device px at any declared viewport, so with the
  default viewports design text is at least 18 px (9 device px at 1280×720, 9.6 at 1366×768), and the kit's smallest
  styles (caption 20/28, label 20/24) sit at that minimum on the kit's 4 px grid. Do not scale text below it with a
  transform either. Lint U-FONT-004 rejects such text. Text sits in its own element. A label that must stay on its lines uses `white-space: nowrap` (its lines are its
  `<br>`s); keep that line count in every translation, so it gets an exact height in Unity.
- **Every visible text has a key.** Write the text in the reference locale (Turkish in the kit) and add
  `data-l10n="club.overview.title"` (a meaningful English key) and `data-en="Overview"`. A value inside a sentence is
  `<span data-u-arg="count">3</span>`, written `{count}` in `data-en`. Values that come from the game and are not
  translated (a player's name, a number) use `data-u-bind="player-name"`; their text is sample data.
- **Controls get ids.** Every button, input or bound element has `data-u-id`; an element that does something has
  `data-u-action="open-inbox"`. One action per element.
- **States.** Interaction states are `:hover`, `:active`, `:focus`, `:disabled`, `:checked`. A selected tab or row is an
  `is-*` class (`.tab.is-selected`). Screen states (`loading`, `empty`, `error`) are roots with
  `data-u-state="loading"`, shown under `.state-loading` on the screen root.
- **Lists.** Write the rows out as samples and put `data-u-repeat="player"` on the first; the samples share its
  structure. Inside a scroll area (`overflow-y: auto`) the list becomes a virtualized `ListView`. A later row may leave a
  nested list empty (a day without events); the first row writes at least one. To show an element only in some rows
  (a badge), hide it in the others with the `hidden` attribute and give it a `data-u-id`; the game then shows or hides it
  per row. Never hide a whole row: leave it out.
- **Look.** Shadows (`box-shadow`, also `inset`) and gradients are allowed; they are baked into images. Borders and
  lines thinner than 8 px stay on whole device pixels. Opacity below 1 only on elements whose parts do not overlap;
  use the kit's disabled colours for disabled controls. Icons are inline `<svg>` painted with `currentColor` (they then
  follow the text colour) or with fixed colours. Images are uploads; nothing loads from the network. Export a raster
  image for the largest declared viewport (its CSS size × 1.5 with 3840×2160) and give it its CSS size (an `<img>`
  width and height, a `background-size`): a picture drawn larger than its pixels is resampled differently by the
  browser and Unity (lint W-IMG-001 warns). The same picture is drawn at a third of those pixels at 1280×720, and UI
  Toolkit samples a texture's full-size level without mipmaps, so fine raster detail (a hairline, small text in a
  photo) does not survive the 3× range of the default viewports the way it does in the browser: draw such detail as a
  vector (inline `<svg>`), or keep a raster picture's detail coarse enough for the smallest viewport. (Picture variants
  per viewport are a possible later feature; they do not exist now.)
- **Motion.** Transitions and `@keyframes` of transforms (`translate`, `rotate`, `scale`), `opacity`, colours and border
  radii, triggered by the screen opening, a state, a pseudo-state or an `is-*` class. A size or position change is a
  `translate` or `scale`, never `width` or `top`.
- **Parts the game already draws** (an existing top bar or side menu) are placeholders marked `data-u-external`: they
  keep their box, paint nothing in Unity and are masked in the comparison.

A prompt that works well:

> Use the attached design system and follow its README rules. Screen id `club.overview`, one 2560×1440 artboard.
> Write visible text in Turkish with a `data-l10n` English key and `data-en` English text on every text. Give every
> button `data-u-id` and `data-u-action`. Use only the kit's text style classes (none smaller than caption) and tokens, flex layout only, no grid
> or calc. Write the player list out as five sample rows with `data-u-repeat="player"` on the first. Mark the existing
> top bar `data-u-external`.

Any other AI that writes the HTML can read the same contract with the `design_ui_rules` tool.

## Bringing a screen into Unity

In your AI client, type `/unity-ui-mcp`, give it the canvas link and name the artboard (or point it at a folder under
`designRoot`). The skill checks the tools and the Unity bridge, reads the rules, saves the artboard and its images into
`<designRoot>/<screen-id>/`, and then:

1. **Lint** (`design_ui_lint`). Every finding names a rule, the element and the fix. Fix the design in Claude Design;
   never patch generated files.
2. **Import** (`design_ui_import`). The design is exported in Chromium (the IR, a golden image per capture job, baked
   images, sample data) into `<designRoot>/<screen-id>/.design-ui/export/`, then compiled into the open Editor through
   the bridge: `<outputFolder>/<Screen>/` gets `<Screen>.uxml`, `<Screen>.uss`, an item template per list,
   `<Screen>View.g.cs`, images and a manifest; `<outputFolder>/` gets the shared `DesignTokens.uss` and `DesignFonts.uss`.
   With localization on, the screen's texts are written to its String Table collection. The import reports pending
   translations, conflicts (an existing key with other text is never overwritten), characters a locale's font lacks,
   and capture jobs the design hides.
3. **Verify** (`design_ui_verify`). Unity renders the compiled screen on a copy of the project for every capture job
   (each viewport, state, class, pseudo-state, list sample and animation sample) and compares it with the design. The
   verdict is `pass`, `fail` or `incomplete`; the report is `<designRoot>/<screen-id>/report.html`. With
   `keepCaptures: true` the run's Unity captures stay in `<screen-id>/.design-ui/kept-captures/` once the verdict is
   written (the whole capture folder: PNGs, `boxes.json`, `boxes.meta.json`), so a failure can be compared again
   offline without another Unity run: `design-export compare <screen-id>/.design-ui/export --unity
   <screen-id>/.design-ui/kept-captures --report <file.html>`. They count toward `cacheBudgetMB`, and the next verify
   (when it gives a verdict) and `design_ui_clean` remove them.

**Reading the report.** Each capture shows the design, Unity, an overlay and a difference view, with the elements that
have an issue outlined and the issue named: a box off by more than 1 px, a wrong line break or baseline, a colour, a
structure (SSIM) drop, text ink that is too light or too heavy. `incomplete` means some job shows an element that no
state, class or sample row of the design shows: there is nothing to compare it with. It is never a pass; make the
element visible in some context, or remove it.

**Changing the design later** is the same loop. Unchanged designs are not exported again; a style-only change rewrites
only USS and does not recompile scripts. The import refuses to overwrite a generated file that was edited by hand and
lists it; move the change into the design, or pass `discardManualEdits` on purpose.

## Wiring the screen in game code

The generated view is the only code the game touches. A presenter (yours) gives it data and handles its events.

**Showing the screen.** Put a `UIDocument` with the screen's `<Screen>.uxml` as its source and the profile's
PanelSettings (the package's `DesignUiPanelSettings` by default) under your UI. Inside a uGUI shell, add
`DesignUiPanelRegion` to the RectTransform the screen should fill: the screen follows that rect, sorts with the shell's
canvases (the profile's `host` settings), applies the locale's fonts and right-to-left rules, and tells you
`IsPointerOverPanel`, `EscapePressed`, `FocusEntered` and `FocusLeft`. In a Linear-colour-space project add
`DesignUiGammaComposite` with the same PanelSettings (for example on the screen's GameObject): the screen is then drawn
as UI Toolkit draws a panel, over Screen Space - Overlay canvases of a lower **or the same** sort order and under those
of a higher one (panels of the same sort order: the one made later on top), and pointer input follows that order. A
menu that must cover the screen needs a higher sort order than the region's. Without a composite the region warns once.

**At a scaled or undeclared resolution** (1600×900, 1366×768, or any the profile does not declare) a design screen lays
its panel out at the next exact scale up and draws its root scaled (README, Viewports). Three things follow for the game:

- While a screen is on a panel, its PanelSettings' `scale` reads the exact scale's factor (exact / actual × the game's
  own factor), and `Instantiate` of that PanelSettings copies it. Set the game's own factor as usual: a value you write
  becomes the base the root scale applies on top of (read it before a screen is shown, or keep your own copy); a value
  equal to one held earlier is yours too (only the last factor the screen wrote counts as its own).
- Where a factor is held. In players and in Play mode on any PanelSettings: in the Editor a save writes a held asset with
  its own factor, a player build gives every held factor back first (with a warning), an Undo restores the snapshot's
  own factor (also after a script reload; only on the settings it touched, and never a value the game or you set), and
  leaving Play, a script reload and quitting give every factor back. Not guarded in Play mode: a Scriptable Build
  Pipeline or Addressables content build (Unity's own `BuildPipeline.BuildAssetBundles` refuses to run in Play mode; the
  others would write a held asset's factor: build content outside Play), and a preset saved or an asset copied
  (`Instantiate` + `CreateAsset`) while a screen holds the factor carries it. In the
  Editor outside Play mode only on PanelSettings no save writes (`HideFlags.DontSaveInEditor`: runtime copies such as
  the capture's and a region's); a screen on a PanelSettings asset or a scene's own settings lays out at the actual
  scale there with no root scale, so the Edit-mode Game view at a scaled resolution is not the game's layout (enter Play,
  or verify).
- Every document on the same PanelSettings lays out at the exact scale, so UI that is not a design screen on it is drawn
  larger: 20 % at 1600×900 (0.75 / 0.625) and 41 % at 1366×768 (0.75 / 0.5335). Give design screens their own
  PanelSettings (the profile's).
- The screen root's inline `translate`, `rotate`, `scale` and `transform-origin` are the design's transform composed with
  the root scale (and the design's animations of the root): game code that writes them on a screen root is overwritten.
  Move, scale or animate a container of the screen instead.
- Positions in panel coordinates are in the exact scale's units outside the screen root: `RuntimePanelUtils.ScreenToPanel`,
  a container's padding and alignment around the screen. A container that centres the screen (`align-items: center`)
  centres its 2560 px layout box in a 2133 px panel at 1600×900, which moves the screen by −160 device px. Put the
  screen at its container's top-left corner, as the artboard is.

```csharp
using UnityEngine;
using UnityEngine.UIElements;
using DesignUi;
using DesignUi.Generated;            // the profile's generated namespace

public sealed class ClubOverviewHost : MonoBehaviour
{
    [SerializeField] DesignUiPanelRegion region;
    ClubOverviewView view;

    void OnEnable()
    {
        Bind(region.Document.rootVisualElement);
        region.RootRebuilt += Bind;          // Unity re-created the document's root: build the view again
    }

    void OnDisable() => region.RootRebuilt -= Bind;

    void Bind(VisualElement root)
    {
        view = new ClubOverviewView(root);
        view.OpenInboxRequested += OpenInbox;
        Render(ClubService.Current);         // your game's data, never sample data
    }

    void Render(Club club)
    {
        view.SetState(club.IsLoading ? ClubOverviewView.State.Loading : ClubOverviewView.State.Default);
        view.SetClubName(club.Name);
        view.SetPlayer(club.Players.Count, (item, i) =>
        {
            var p = club.Players[i];
            item.SetPlayerName(p.Name);
            item.SetBadgeVisible(p.IsInjured);
            item.OpenPlayerRequested += () => OpenPlayer(p);   // item events are cleared before each bind
        });
    }
}
```

What the view offers:

| Design | View |
|---|---|
| `data-u-id="save"` | a typed property: `view.Save` (`Button`, `Label`, `Toggle`, `TextField`, `DropdownField`, `ListView`, …) |
| `data-u-bind="club-name"` | `SetClubName(string)`; a bound image: `SetCrest(Background)` |
| `{count}` inside a localized text | `SetCount(string)` |
| `data-u-action="open-inbox"` | `event Action OpenInboxRequested` |
| `data-u-state="loading"` | `SetState(State.Loading)` |
| `.is-selected`, any `is-*` class | `SetSelected(element, bool)`, `SetClass(element, "is-open", bool)` |
| `:disabled` look | `SetEnabled(element, bool)` |
| `data-u-repeat="player"` | `SetPlayer(count, (item, index) => …)` with a `PlayerItemView` per item |
| element hidden in some sample rows | `item.Set<Id>Visible(bool)` |

Setters skip unchanged values and allocate nothing in steady state, so calling them every time the data changes is
fine. Inputs are written without raising their change events. If the generated file lives under an assembly
definition, add `DesignUi.Runtime` to its references.

**Languages.** The texts are bound to String Table entries; switching the selected locale updates text and font with
the screen open. The region follows Unity Localization's selected locale by default (`LocaleSource` replaces it).
Translations the import reported as pending fall back to English through the project's fallback locale. Right-to-left locales get the profile's alignment
rule (start-aligned text flips; the layout is not mirrored) and, with Enable Advanced Text on, shaped text in the right
direction.

**Text size.** List the game's text-size steps (key and scale) in the profile's `textSizes` and import again; give the
region a component that implements `IDesignTextSizeSource` (the game's setting) in its `TextSizes` field. A step below
×1 can draw text under the readable floor (9 device px); that is the player's choice, so kit sync writes the steps to
kit.config.json and `kit build` warns about such a step (with the default kit keep the steps at ×0.9 or more, 9 device px
at 1280×720). The package has no default steps.

**Motion.** Animations play by themselves. For an accessibility setting, set
`if (DesignUiAnimationPlayer.For(view.Root) is { } motion) motion.ReducedMotion = true;` (a screen without animations
has no player): transitions jump to their end and animations show their still frame.

## Verification captures

`design_ui_verify` never renders in your open Editor. It runs `unityRunner.command.capture` from
`design-ui.config.json`, which renders on a **copy** of the project (Unity cannot open the same project twice). The
repository's `scripts/capture-on-copy.sh` does it, and `scripts/setup.sh` puts it into a new config:

```json
"unityRunner": {
  "prefer": "editor",
  "captureVia": "command",
  "timeoutSec": 3600,
  "command": { "import": [], "kitSync": [], "capture": ["<clone>/scripts/capture-on-copy.sh", "{projectDir}"] }
}
```

It waits for a capture slot (one capture-on-copy Unity at a time on the machine by default), checks the free disk where
the copy goes, copies the project into a temporary folder (an APFS clone on macOS, so the `Library` comes along at no
cost; rsync elsewhere), deletes the open Editor's process and lock files from the copy (`Library/ilpp.pid` and every
other `*.pid` in the `Library`, `Library/EditorInstance.json`, the asset databases' `-lock` files, search index locks,
packages' `.lock` and `*.lock` files, `Temp/` with its `UnityLockfile`: a copy that keeps `ilpp.pid` makes its Unity
stop the **open** Editor's IL post-processing runner), lists the package's tests (`"testables"`) in the **copy's** `Packages/manifest.json` only, runs
the EditMode test `DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv` there in batchmode, and removes the copy and
gives the slot back when Unity exits, whether the capture succeeded or failed. When the server stops it at
`unityRunner.timeoutSec` (SIGTERM, then SIGKILL two seconds later), or on Ctrl-C, it first stops its Unity and everything
Unity started and waits for them, then gives the slot back and removes the copy in the background; no Unity of a stopped
capture keeps running next to the next one. Your project's manifest never lists the package's tests (that would put the
package's own test suite, which switches project settings, into your Test Runner), and no scene, asset or helper file is
ever added to your project. The server passes the export and output folders in the environment (`DESIGN_UI_EXPORT_DIR`,
`DESIGN_UI_OUT_DIR`, also as the `{exportDir}` and `{outDir}` placeholders); the Unity binary is the Unity Hub install of
the project's version, or `UNITY_BIN`. A script of your own works the same way, as long as it cleans up after itself.

Each capture is a heavy Unity job. The script's options go into the command template (the server passes none of its own
`DESIGN_UI_*` environment variables on; the `CAPTURE_COPY_*` variables of the same names work too):

| Option | Variable | Default | What it does |
|---|---|---|---|
| `--slots N` | `CAPTURE_COPY_SLOTS` | 1 | capture-on-copy Unity runs at a time on the machine; the others print that they wait and wait. The wait counts against `unityRunner.timeoutSec` (raise it when captures queue). A slot counts while its script or its Unity still runs (a script killed with SIGKILL leaves its Unity holding the slot until it ends) and is taken over once both are gone. |
| `--min-free-gb N` | `CAPTURE_COPY_MIN_FREE_GB` | 10 | free disk the copy needs where it goes (`TMPDIR`); with rsync also the project's size (what `du` can read; files an open Editor deletes meanwhile or unreadable folders are reported, not fatal). Below it the script stops before copying, says how much is free and exits 2. |
| `--lock-dir DIR` | `CAPTURE_COPY_LOCK_DIR` | `<TMPDIR>/design-ui-capture-slots` (`/tmp/design-ui-capture-slots-<uid>` without `TMPDIR`) | the slots' folder: captures that share it share the slots. Where `ps` shows no command lines (Git Bash, busybox) a slot cannot tell a reused process id from its holder and counts it. |

```json
"capture": ["<clone>/scripts/capture-on-copy.sh", "{projectDir}", "--slots", "1", "--min-free-gb", "20"]
```

A project that already has a runner for heavy Unity jobs (a machine-wide job limit, isolated clones) puts that runner's
command into `command.capture` instead: it gets the same `{projectDir}`, `{exportDir}` and `{outDir}` placeholders and
`DESIGN_UI_EXPORT_DIR` / `DESIGN_UI_OUT_DIR`, runs the EditMode test above on its copy (listing the package in that copy's
`testables`), writes into `DESIGN_UI_OUT_DIR` and removes its copy.

The capture writes a PNG per job, `boxes.json`, `boxes.meta.json` and, last, `capture-done.json` into the output folder;
the server then compares and writes the report. A run that fails, times out or does not finish keeps its partial
captures, the meta file and the Unity log in `<designRoot>/<screen-id>/.design-ui/failed-<run>/` (the newest three). The
command runs as a program with your rights; use only configs you trust.

## Disk use

The server keeps its own files small, by itself: after a verify writes its report it deletes the run's Unity captures
and difference images (the report keeps thumbnails of the first 24 failing captures with different issues, a later
capture with the same issues points at them, and one crop per element, check and viewport up to a limit, the report
saying how many it skipped; `verdict.json` is compact, one capture per line, and lists only the element rows that did not
pass), a new verify replaces the previous one's report pictures, verdict and
difference images, and after every import and
verify it keeps each screen's bookkeeping (`<designRoot>/<screen-id>/.design-ui/`: records, the latest export, the latest
report's pictures, the newest three failed runs, the captures a verify kept on request) within `cacheBudgetMB` of
`design-ui.config.json` (default 2048): over it, kept captures go first, then the exports of the screens least recently
imported or verified, and the next import or verify exports them again. Kept captures otherwise stay until the next
verify or `design_ui_clean`, which always removes them. Kit sync and every import remove font twins no text style, compiled screen or locale font uses.
`design_ui_status` shows the bookkeeping per screen and in total, and `design_ui_clean` (`dryRun` to only report) runs the
cleanup now. Do not delete these folders, generated files or font twins by hand.

## Without an AI client

The same steps run from the command line and from Unity:

```sh
npx design-export lint <design folder or page> --kit <kitDir>
npx design-export export <design> --kit <kitDir> --out <exportDir>
npx design-export compare <exportDir> --unity <captureDir> --report report.html
npx design-export kit build <kitDir> --check
npx design-export kit claude <kitDir> <outDir> [--all-faces]
npx design-export kit upgrade <kitDir> [--dry-run]
```

In Unity: `Window > Design UI > Import Screen…` and `Window > Design UI > Kit Sync`, or in batchmode
`-executeMethod DesignUi.Editor.DesignUiBatch.Import -designUiProfile <asset> -designUiExport <exportDir>` and
`-executeMethod DesignUi.Editor.DesignUiBatch.KitSync -designUiProfile <asset> -designUiKit <kitDir> [-designUiAddProfileViewports]`
(a command runner can set `DESIGN_UI_ADD_PROFILE_VIEWPORTS=true` instead). `Window > Design UI > Add Default Viewports to
Profile` gives an older profile the default viewports it lacks.

## Common lint findings

| Rule | Means | Fix |
|---|---|---|
| U-CSS-001 | `display: grid` | nested flex rows and columns |
| U-CSS-005, U-CSS-006 | `calc()`, `vw`/`vh` | px or % |
| U-CSS-010 | a font that is not the kit's | `var(--font-ui)`; after a kit sync, the token's new family |
| U-CSS-011 | `gap` on a wrapping container | margins on the items |
| U-CSS-016 | a size, line height or weight that is not a kit text style | a `.text-<style>` class |
| U-FONT-004 | text that draws below 9 device px at a declared viewport (with its transforms, in a state it is drawn in) | a text style of at least 18 px (the kit's caption or label), not scaled down |
| U-CSS-019 | an item that shrinks below its content | `flex-shrink: 0` or an explicit size |
| U-CSS-038 | text without grayscale smoothing | keep the kit base stylesheet |
| U-CSS-039 | opacity below 1 on an element with overlapping parts | the kit's disabled colours |
| U-CSS-040 | a thin border or line off the device grid | the listed lengths |
| U-CSS-047 | a box with `overflow: hidden` shorter than its text's line box (a 20/24 label in a 20 px box), judged at the drawn scale and from where the text starts | make the box at least the line height (24 px) plus any padding above the text, or a style that fits |
| W-TEXT-001 (warning) | a word wider than its wrapping box (the browser overflows it, UI Toolkit breaks it inside) | room for the longest word, also in translations, or `white-space: nowrap` with an ellipsis |
| U-CSS-046 | a padding, margin or gap off the device grid (10 px is 7.5 device px at 1920×1080) | the nearest lengths named, multiples of 4 px |
| W-IMG-001 (warning) | a raster image drawn larger than its pixels at a declared viewport | export it at the size named (its CSS size × the largest viewport's scale) and give it that CSS size |
| U-CSS-013, U-CSS-042 | an animation of a layout property | `translate` or `scale` |
| U-MRK-003 | a control, bound or action element without `data-u-id` | add one |
| U-MRK-004 | a visible text without `data-l10n` and `data-en` | add the key and English text |
| U-MRK-005 | an id or key outside the allowed characters (`İ`, `ı`, `ş`, a leading digit) | ASCII transliteration |
| U-MRK-013 | a sample row hidden by its own markup | leave the row out |
| U-FONT-001 | a weight or italic the font has no real face for | 400 or 700, or add the face in Unity and sync the kit |
| U-FONT-003 | a character the kit font lacks | characters the font covers, or a font that has them |

The full list with every fix is in [RULES.md](../../design-kit/RULES.md#lint-rules). For problems outside lint, see
the README's [troubleshooting](../../README.md#troubleshooting).
