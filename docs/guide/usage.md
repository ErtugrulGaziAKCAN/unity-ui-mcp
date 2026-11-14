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
4. **The kit.** Copy `design-kit` from the clone to a folder of your own (for example next to your designs) and point
   `kitDir` in `design-ui.config.json` at it, so the clone stays clean. Then run a **kit sync** (ask the AI for
   `design_ui_kit_sync`, or `Window > Design UI > Kit Sync`): the project's font files go into the kit, the `--font-*`
   tokens get the fonts' real family names, and the text styles are checked against the fonts' real faces.
5. **Publish the kit to Claude Design.** Ask `/unity-ui-mcp` to publish the kit, or run
   `npx design-export kit claude <kitDir> <outDir>` in the clone and publish `<outDir>/project/` as a Design System.
   Repeat after every kit sync that changed something.
6. **Right-to-left and complex scripts** (Arabic and others): turn on **Project Settings > UI Toolkit > Enable Advanced
   Text** before entering Play, and give every PanelSettings a player uses its ICU data
   ([details](../findings/advanced-text.md)).
7. **Localization** (optional): Unity Localization 1.5 or later. In the profile's localization settings, name each
   screen's String Table collection (or a default pattern) and the argument format your tables use (`{name}` Smart
   Strings, or `{0}` indexed).
8. **Verification captures**: set up a capture command (below). Until then, lint and import work and verify says
   what is missing.

## Designing in Claude Design

Attach the kit's Design System to the canvas. Then:

- **One artboard per screen**, titled with the screen id (`club.overview`), with a fixed 2560×1440 root that carries
  `data-u-screen="club.overview"`. Screens are verified at 2560×1440, 1920×1080 and 1280×720.
- **Start the style with the kit's base stylesheet** (the design system includes it) and use the tokens:
  `var(--color-surface-700)`, `var(--space-4)`, `var(--radius-md)`.
- **Layout with flex only.** No grid, `calc()`, `vw`/`vh`, floats or `position: fixed`. `gap` only where items do not
  wrap. Give flex items an explicit size or `flex-shrink: 0` where their content must not shrink.
- **Text uses a kit text style class** (`.text-body`, `.text-title-bold`, …): sizes from 12 to 64 px, weights 400 and
  700. Text sits in its own element.
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
  follow the text colour) or with fixed colours. Images are uploads; nothing loads from the network.
- **Motion.** Transitions and `@keyframes` of transforms (`translate`, `rotate`, `scale`), `opacity`, colours and border
  radii, triggered by the screen opening, a state, a pseudo-state or an `is-*` class. A size or position change is a
  `translate` or `scale`, never `width` or `top`.
- **Parts the game already draws** (an existing top bar or side menu) are placeholders marked `data-u-external`: they
  keep their box, paint nothing in Unity and are masked in the comparison.

A prompt that works well:

> Use the attached design system and follow its README rules. Screen id `club.overview`, one 2560×1440 artboard.
> Write visible text in Turkish with a `data-l10n` English key and `data-en` English text on every text. Give every
> button `data-u-id` and `data-u-action`. Use only the kit's text style classes and tokens, flex layout only, no grid
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
   verdict is `pass`, `fail` or `incomplete`; the report is `<designRoot>/<screen-id>/report.html`.

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
`IsPointerOverPanel`, `EscapePressed`, `FocusEntered` and `FocusLeft`.

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
region a component that implements `IDesignTextSizeSource` (the game's setting) in its `TextSizes` field.

**Motion.** Animations play by themselves. For an accessibility setting, set
`if (DesignUiAnimationPlayer.For(view.Root) is { } motion) motion.ReducedMotion = true;` (a screen without animations
has no player): transitions jump to their end and animations show their still frame.

## Verification captures

`design_ui_verify` never renders in your open Editor. It runs `unityRunner.command.capture` from
`design-ui.config.json`, which must render on a **copy** of the project (Unity cannot open the same project twice) that
has the compiled screen and lists the package's tests in its `Packages/manifest.json`
(`"testables": ["com.unity.design-ui"]`). The command runs the EditMode test
`DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv` in batchmode; the server passes the export and output folders
in the environment (`DESIGN_UI_EXPORT_DIR`, `DESIGN_UI_OUT_DIR`, also as the `{exportDir}` and `{outDir}`
placeholders). An example to adapt, with a script of your own:

```json
"unityRunner": {
  "prefer": "editor",
  "captureVia": "command",
  "timeoutSec": 3600,
  "command": { "import": [], "kitSync": [], "capture": ["/path/to/capture-on-copy.sh", "{projectDir}"] }
}
```

```sh
#!/bin/sh
# capture-on-copy.sh <projectDir>: refresh a copy of the project, then capture there.
set -e
COPY="$HOME/UnityCopies/$(basename "$1")-capture"
mkdir -p "$COPY"
rsync -a --delete --exclude Temp --exclude Logs --exclude UserSettings "$1/" "$COPY/"
exec "/Applications/Unity/Hub/Editor/<version>/Unity.app/Contents/MacOS/Unity" -batchmode -projectPath "$COPY" \
  -runTests -testPlatform EditMode -testFilter "DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv" \
  -testResults "$COPY/capture-results.xml" -logFile -
```

The capture writes a PNG per job, `boxes.json`, `boxes.meta.json` and, last, `capture-done.json` into the output folder;
the server then compares and writes the report. A run that fails, times out or does not finish keeps its partial
captures, the meta file and the Unity log in `<designRoot>/<screen-id>/.design-ui/failed-<run>/`. Each copy carries its
own `Library` (often several GB): mind the disk. The command runs as a program with your rights; use only configs you
trust.

## Without an AI client

The same steps run from the command line and from Unity:

```sh
npx design-export lint <design folder or page> --kit <kitDir>
npx design-export export <design> --kit <kitDir> --out <exportDir>
npx design-export compare <exportDir> --unity <captureDir> --report report.html
npx design-export kit build <kitDir> --check
npx design-export kit claude <kitDir> <outDir>
```

In Unity: `Window > Design UI > Import Screen…` and `Window > Design UI > Kit Sync`, or in batchmode
`-executeMethod DesignUi.Editor.DesignUiBatch.Import -designUiProfile <asset> -designUiExport <exportDir>` and
`-executeMethod DesignUi.Editor.DesignUiBatch.KitSync -designUiProfile <asset> -designUiKit <kitDir>`.

## Common lint findings

| Rule | Means | Fix |
|---|---|---|
| U-CSS-001 | `display: grid` | nested flex rows and columns |
| U-CSS-005, U-CSS-006 | `calc()`, `vw`/`vh` | px or % |
| U-CSS-010 | a font that is not the kit's | `var(--font-ui)`; after a kit sync, the token's new family |
| U-CSS-011 | `gap` on a wrapping container | margins on the items |
| U-CSS-016 | a size, line height or weight that is not a kit text style | a `.text-<style>` class |
| U-CSS-019 | an item that shrinks below its content | `flex-shrink: 0` or an explicit size |
| U-CSS-038 | text without grayscale smoothing | keep the kit base stylesheet |
| U-CSS-039 | opacity below 1 on an element with overlapping parts | the kit's disabled colours |
| U-CSS-040 | a thin border or line off the device grid | the listed lengths |
| U-CSS-013, U-CSS-042 | an animation of a layout property | `translate` or `scale` |
| U-MRK-003 | a control, bound or action element without `data-u-id` | add one |
| U-MRK-004 | a visible text without `data-l10n` and `data-en` | add the key and English text |
| U-MRK-005 | an id or key outside the allowed characters (`İ`, `ı`, `ş`, a leading digit) | ASCII transliteration |
| U-MRK-013 | a sample row hidden by its own markup | leave the row out |
| U-FONT-001 | a weight or italic the font has no real face for | 400 or 700, or add the face in Unity and sync the kit |
| U-FONT-003 | a character the kit font lacks | characters the font covers, or a font that has them |

The full list with every fix is in [RULES.md](../../design-kit/RULES.md#lint-rules). For problems outside lint, see
the README's [troubleshooting](../../README.md#troubleshooting).
