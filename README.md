# unity-ui-mcp

Turns screens designed in [Claude Design](https://claude.ai) (or any HTML that follows the design kit's rules) into
Unity **UI Toolkit** screens, one to one, and measures the result against the design. You get working screens, not
mockups: UXML and USS, a typed C# view class with setters, events, states and lists, String Table entries for every
text, and per-locale fonts. Any MCP-capable AI client (Claude Code, Codex, Cursor, Claude Desktop) drives the loop: lint
the design, import it into the open Unity Editor, verify it, read the report.

The design is measured in a real browser (Chromium) and written to an intermediate representation (IR); Unity compiles
that IR; then the Unity rendering is captured and compared with the browser's, box by box and pixel by pixel, at every
viewport the kit declares (by default 3840×2160, 2560×1440, 1920×1080, 1600×900, 1366×768 and 1280×720), for every
state, interaction state and animation sample. A design outside the rules fails lint with a rule id and a fix; nothing
is silently approximated.

| Part | What it is |
|---|---|
| `packages/com.ertugrulgaziakcan.design-ui` | Unity package (Unity 6000.3 or later): compiler, generated views, runtime helpers, Editor bridge, verifier |
| `tools/design-ui-mcp` | MCP server (stdio) for any MCP client, one per Unity project |
| `tools/design-export` | Node CLI behind the server: `lint`, `export`, `compare`, `kit build`, `kit claude` |
| `skills/unity-ui-mcp` | The `/unity-ui-mcp` chat skill for Claude Code, Codex and Cursor |
| `design-kit` | The design contract (`RULES.md`), tokens, text styles, base stylesheet, components, fidelity fixtures |
| `samples/FidelityProject` | Unity 6000.3 project the package tests and the fidelity suite run in |

Guides: [usage guide](docs/guide/usage.md) · [Türkçe kullanım rehberi](docs/guide/kullanim-rehberi.md) ·
[install guide for AI agents](INSTALL.md) · [design rules](design-kit/RULES.md) ·
[spec](docs/spec/2026-11-12-design-to-uitoolkit-design.md) · [measurements](docs/findings/) · [changes](CHANGELOG.md)

## Requirements

- **Unity 6000.3** (Unity 6.3 LTS) or later. The package pulls in `com.unity.ugui` and Newtonsoft JSON.
- **Node.js 20** or later, `npm` and `git`, to build the MCP server from a clone. Playwright downloads its pinned
  Chromium once per machine.
- `scripts/setup.sh` is bash: macOS or Linux; on Windows use WSL or Git Bash, or the manual steps in
  [INSTALL.md](INSTALL.md). All measurements so far were made on macOS.
- Optional, for localized screens: **Unity Localization 1.5** or later, with Addressables settings in the project (the
  import creates String Table collections through them).
- A **Linear colour space** project shows design screens through the `DesignUiGammaComposite` component (see
  [Fidelity](#fidelity-and-speed)); a Gamma project needs nothing.
- Optional, for right-to-left and complex-script locales (Arabic and others): **Project Settings > UI Toolkit > Enable
  Advanced Text**, and ICU data on every PanelSettings a player uses
  ([details](docs/findings/advanced-text.md)).

## Install in three steps

1. **Paste one line** into your AI client (Claude Code, Codex, Cursor, …):

   > Install unity-ui-mcp from https://github.com/ErtugrulGaziAKCAN/unity-ui-mcp for my Unity project by following INSTALL.md in that repository.

   Türkçe:

   > https://github.com/ErtugrulGaziAKCAN/unity-ui-mcp deposundaki unity-ui-mcp'yi Unity projeme kur; depodaki INSTALL.md adımlarını izle.

2. **Answer its questions and approve the dry run.** The agent asks for your Unity project, the design folder and your
   MCP client, clones the repository, shows every change `scripts/setup.sh --dry-run` would make, and runs it after you
   say yes. Setup builds the server, adds the Unity package and `design-ui.config.json`, registers the server with your
   client and links the skill. It never commits or pushes.

3. **Open the project in Unity and start a new chat.** Unity resolves the package and the bridge starts by itself
   (`Window > Design UI > Status`). In a new session of your client, type `/unity-ui-mcp` (or ask for `design_ui_list`):
   `unity.bridge: "connected"` means you are ready. Create the profile in that window (**Create Profile**) and run a
   kit sync (step 1 of the loop below).

[INSTALL.md](INSTALL.md) is the agent's guide, with every setup option and the manual route.

### By hand

```sh
git clone https://github.com/ErtugrulGaziAKCAN/unity-ui-mcp.git
cd unity-ui-mcp
npm ci
npm run build -w design-ui-mcp
npx playwright install chromium        # once per machine
scripts/setup.sh --project <UnityProjectDir> --dry-run   # then without --dry-run
```

Unity package (Package Manager → **+** → *Install package from git URL…*):

```
https://github.com/ErtugrulGaziAKCAN/unity-ui-mcp.git?path=/packages/com.ertugrulgaziakcan.design-ui
```

Without a `#revision` Unity takes the default branch; append `#<tag>` or `#<commit>` to pin a version. Unity records the
commit in `packages-lock.json`; to update, add the URL again or remove the `com.ertugrulgaziakcan.design-ui` entry from
`packages-lock.json`.

MCP server, one per Unity project, the same command for every client:

```sh
node <clone>/tools/design-ui-mcp/dist/server.js --project <UnityProjectDir>
```

- **Claude Code**, in the folder you start it from:
  `claude mcp add --scope local design-ui -- node <clone>/tools/design-ui-mcp/dist/server.js --project <UnityProjectDir>`
- **Cursor** (`.cursor/mcp.json` in the project or `~/.cursor/mcp.json`) and **Claude Desktop**
  (`claude_desktop_config.json`, Settings → Developer → Edit Config):
  ```json
  { "mcpServers": { "design-ui": { "command": "node", "args": ["<clone>/tools/design-ui-mcp/dist/server.js", "--project", "<UnityProjectDir>"] } } }
  ```
- **Codex** (`~/.codex/config.toml`):
  ```toml
  [mcp_servers.design-ui]
  command = "node"
  args = ["<clone>/tools/design-ui-mcp/dist/server.js", "--project", "<UnityProjectDir>"]
  ```

GUI clients may start servers with a minimal `PATH`: use the absolute path of `node` (`which node`) if it is not found.
`Window > Design UI > Status` shows the same snippets filled in for the open project. A server registered during a
chat is visible only in chats started after it.

## From Claude Design to a working Unity screen

1. **Sync the kit from Unity.** Ask the AI for a kit sync (`design_ui_kit_sync`). The fonts always come from the Unity
   project: kit sync copies the font files your TMP setup renders each locale with into the kit, writes the `--font-*`
   tokens from their real family names, and checks the text styles. Kit sync writes into `kitDir`, the project's own
   copy of the kit that setup makes in `<designRoot>/design-kit`; it never writes into the clone.
2. **Publish the kit to Claude Design.** `npx design-export kit claude <kitDir> <outDir>` (in the clone) writes the
   kit as a Claude Design System folder (`<outDir>/project/`: README with the rules, tokens, fonts, a card per
   component). Ask `/unity-ui-mcp` to publish it, or publish that folder yourself; every canvas then attaches it.
3. **Design.** In Claude Design, one artboard per screen, 2560×1440, with the design system attached. Ask for
   variants, pick one, revise it. Visible text is written in the reference locale with an English key, controls get
   ids and actions, repeated rows are written out as samples (the [usage guide](docs/guide/usage.md) has a prompt).
4. **Apply it.** In your AI client: `/unity-ui-mcp`, then give it the canvas link (or a folder under `designRoot`) and
   name the screen. It fetches the artboard, then runs:
   - **lint** (`design_ui_lint`): any finding is a design-side fix (rule id, element, fix); fix it in Claude Design.
   - **import** (`design_ui_import`): exports the design in Chromium and compiles it into the open Editor through the
     bridge. The screen appears without a manual refresh; Unity recompiles scripts only when the view class changed.
   - **verify** (`design_ui_verify`): renders the compiled screen in Unity on a copy of the project, compares every
     capture with the design and returns `pass`, `fail` or `incomplete` with `<screen>/report.html`.
5. **Wire it in game code.** Write a presenter that feeds the generated view your game's data (below). The tools never
   write presenters, invent data or edit your code.

Changing the design later is the same loop: re-import regenerates only generated files and refuses to overwrite a
generated file someone edited by hand.

## What the generated view gives you

For each screen the compiler writes `<Screen>.uxml`, `<Screen>.uss`, an item template per repeat and
`<Screen>View.g.cs` (namespace from the profile):

```csharp
var view = new ClubOverviewView(document.rootVisualElement);   // finds every element once
view.SetClubName(club.Name);                                   // data-u-bind="club-name"
view.SetBudget(budgetText);                                    // {budget} inside a localized text
view.OpenInboxRequested += OpenInbox;                          // data-u-action="open-inbox"
view.SetState(ClubOverviewView.State.Loading);                 // data-u-state="loading"
view.SetPlayer(players.Count, (item, i) =>                     // data-u-repeat="player" (ListView or pooled items)
{
    item.SetPlayerName(players[i].Name);
    item.SetBadgeVisible(players[i].IsInjured);                // hidden by markup in some sample rows
    item.OpenPlayerRequested += () => OpenPlayer(players[i]);  // item events are cleared before each bind
});
view.SetSelected(view.TabSquad, true);                         // .is-selected; SetClass for any is-* class
view.SetEnabled(view.Save, false);                             // the design's :disabled look
```

- Every `data-u-id` element is a typed property (`Button`, `Label`, `Toggle`, `TextField`, `DropdownField`,
  `ListView`, …); removing an id the presenter uses is a compile error.
- Setters skip unchanged values and allocate nothing in steady state; inputs are written without change events.
- Texts are bound to Unity Localization String Table entries (the import writes English and the reference locale,
  never overwrites a different translation, and reports what is pending); a language switch updates text and font with
  the screen open.
- Fonts: each locale renders with the project's own TMP font (as a UI Toolkit twin), right-to-left locales get the
  `rtl` alignment rules, and the profile's text-size steps compile to `.text-size-<key>` rules. Twins keep the
  characters the import pre-adds; what text adds to them in Play mode is taken back when Play stops, so twins do not
  change in version control after a Play session. Twins stay small: one atlas per face, sized to its glyphs, with the
  kerning of its own glyphs only; a text style's line-box variant keeps no glyphs on disk and shares its twin's when
  loaded; kit sync and every import remove twins no text style, compiled screen or locale font uses. An Inter family with
  Noto Sans, Arabic, Japanese and Chinese for 11 locales takes 25 MB (48 files) instead of 3.5 GB
  ([docs/findings/font-twin-footprint.md](docs/findings/font-twin-footprint.md)).
- Transitions and `@keyframes` play through the package's animation player (CSS timing, every trigger, a
  reduced-motion switch).

**Inside a uGUI game**, add `DesignUiPanelRegion` to a RectTransform of your existing shell: the UI Toolkit screen
follows that rect, sorts with the shell's canvases, runs the locale controller and reports `IsPointerOverPanel`,
`EscapePressed` and focus. Recreate the view in its `RootRebuilt` event:
`region.RootRebuilt += root => { view = new ClubOverviewView(root); presenter.Bind(view); };`.
If the generated view lives under an assembly definition, add `DesignUi.Runtime` to its references.

## The rules that make it one to one

The kit's [RULES.md](design-kit/RULES.md) is the contract (`design_ui_rules` serves it to any AI). In brief:

- **Text styles only.** UI Toolkit has no `line-height`, so every text uses one of the kit text styles (caption 12/16
  to display 64/80 px, 400 or 700). Their sizes and line heights are multiples of 4 px, whole device pixels at every
  exact viewport, and the font twins carry each style's CSS line box: a text block is exactly lines × line height on
  both sides. A text that does not wrap (`white-space: nowrap`, its lines its `<br>`s) gets exactly that height, so
  stacked labels never drift.
- **Grayscale font smoothing** on the root (the base stylesheet sets it): browsers on macOS otherwise draw thicker
  stems than UI Toolkit.
- **Borders and lines on the device grid.** A border, hard shadow edge or line under 8 px must stay whole at every
  exact viewport (U-CSS-040).
- **Opacity** below 1 only on one-part elements (U-CSS-039); use the kit's disabled colours.
- **Animations** only of transforms, opacity, colours and border radii; a size or position change is a `translate`
  or `scale` (U-CSS-013, U-CSS-042).
- Flex layout only (no grid, `calc()`, viewport units, floats); `box-shadow` and gradients are baked into images; fonts
  come only from the kit; no network resources.

## Viewports: exact and scaled

`kit.config.json` declares the resolutions a game ships (the profile's **Viewports** and **Scaled Viewports** mirror
it; kit sync writes the profile's). Each has a class:

- **exact** (`[w, h]`): the panel scale keeps the kit's 4 px grid whole, so every text size, line height, border and thin
  line is a whole number of device pixels there; kit build, kit sync and lint hold the design to it. With the
  2560×1440 reference that is 3840×2160 (scale 1.5), 2560×1440, 1920×1080 (0.75) and 1280×720 (0.5).
- **scaled** (`{ "size": [w, h], "class": "scaled" }`): a resolution players use where no design value can be whole
  (1600×900 is scale 0.625, so a 4 px border is 2.5 device px; 1366×768 is 0.5335, so nothing is). The screen is laid
  out and verified there with the same limits (boxes, baselines and line extents within ±1 device px), but the
  whole-pixel rules do not apply to it. Today scaled viewports fail verify where padded, spaced or bordered elements
  stack (UI Toolkit lays those lengths out as whole device pixels; see Fidelity below). Unity sets text at whole device pixels: the compiler gives each scaled viewport
  font twins whose face is scaled by exact / rounded size, and the screen root switches to them at that panel scale,
  so text keeps the design's size and line box. For a designer nothing changes: design at 2560×1440 with the kit;
  borders and fractional edges are drawn where Unity's whole pixels put them, within a pixel.

Declare every resolution the game offers, in the class it belongs to; a resolution that is not declared still works
(UI Toolkit scales the panel) but is not verified, and its text renders at Unity's rounded sizes. `design_ui_status`,
`design_ui_verify` (captures per class) and `Window > Design UI > Status` show each viewport's class.

## Fidelity and speed

Thresholds (`tools/design-export/fidelity-thresholds.json`):

| Check | Limit |
|---|---|
| Element boxes | ±1 device px at every viewport, exact and scaled |
| Text | same line count and breaks, baseline ±1 px, ink colour and amount per line, and where each line's first and last glyphs sit (and the width between them) ±1 px |
| Colours at sampled points | ΔE2000 ≤ 1 |
| Structure (SSIM, non-text) | ≥ 0.99 for the capture and for each element (small elements ≥ 0.984, pictures ≥ 0.985, rotated animation samples ≥ 0.975) |
| Animation samples | at the delay and every quarter of each animation, the same limits |

The fidelity suite (`scripts/fidelity.sh`: 20 fidelity fixtures and the 9 kit components, at the kit's six
viewports, 4716 captures, 13.6 minutes) passes every capture at 2560×1440 and 1920×1080 and all but one at 1280×720 (a new fixture's
8 device px digits, ink colour ΔE2000 4.65 against 4.5). It does **not** pass yet at 3840×2160 (89 of 786 fail: a row of
text-sized buttons moves 1.02 px because UI Toolkit rounds each text's width up, and raster pictures drawn 1.5× larger)
or at the scaled viewports (1600×900: 355 of 786 fail, 1366×768: 769 of 786): UI Toolkit lays every padding, margin and
border out as whole device pixels, so stacked elements drift past the ±1 px limit there
([docs/findings/viewport-classes.md](docs/findings/viewport-classes.md)). Nothing is waived: those viewports report
FAIL until the layout is compensated or a different limit is decided.

**Linear colour space.** UI Toolkit blends an ordinary on-screen panel of a Linear project in linear light; the design's
browser blends in sRGB. Captured that way, 2248 of the suite's 2355 captures fail (text ink 0.63–1.42× the design's,
translucent colours up to ΔE2000 37). Add `DesignUiGammaComposite` (Add Component > Design UI > Gamma Composite) with
the design PanelSettings once to the game: the panel then renders into a screen-sized UNorm texture with
`forceGammaRendering` and is composited over the screen, with the colours verify captures and pointer input mapped
to the texture (cost: 29.5 MB of textures and one full-screen pass, 0.14 ms at 2560×1440 on an M4 Pro). It is drawn
where UI Toolkit would draw the panel: over Screen Space - Overlay canvases of a lower or the same sort order, under
those of a higher one, among other panels by sort order, as pointer input goes
([docs/findings/composite-order.md](docs/findings/composite-order.md)). Measured in
EditMode and a batchmode Play check on the Built-in render pipeline; URP and player builds are not verified yet. The
profile's `colorPath` is Gamma Composite by default; Linear Panel makes verify capture an ordinary on-screen panel
instead, and its answer warns. Verify, the Design UI window and a `DesignUiPanelRegion` at runtime warn when no
composite renders the panel. A Gamma project needs neither. Details: [docs/findings/colour-space.md](docs/findings/colour-space.md).

Measured on the sample project (macOS, Apple silicon, warm browser):

| Step | Time |
|---|---|
| Lint and export of one screen | 1.8 s (three viewports); 3.9–4.3 s with a fourth viewport and animation samples |
| Import through the Editor bridge, view class unchanged | 0.2 s Unity request; 4.5 s for the whole tool call with its export |
| Import that changes the view class | 1.8–3.3 s Unity step (script compile and domain reload); longer in a large project |
| Unity capture | about 33 ms per capture job after one mount per viewport |
| Fidelity suite Unity steps (29 screens, six viewports) | import 28 s, capture 206 s |

## MCP tools

| Tool | Does |
|---|---|
| `design_ui_rules` | The design contract (`RULES.md` with a section index; one `section`, or `json`); also the resource `design-ui://rules` |
| `design_ui_list` | Screens under `designRoot` with their state (new, design changed, imported, verified, failed, incomplete) and the Unity bridge state |
| `design_ui_lint` | Lints a design folder, `.html`, `.dc.html` (a Claude Design artboard) or `.zip` in Chromium with the kit fonts |
| `design_ui_import` | Exports a screen and compiles it into the Unity project (open Editor bridge, or a command) |
| `design_ui_verify` | Captures in Unity, compares, returns the verdict, the report path and the top issues |
| `design_ui_status` | What this version supports and how each Unity step runs; or one screen's hashes, last import and verdict |
| `design_ui_kit_sync` | Syncs fonts and settings from the Unity project into the kit |

Every result has a short text summary, the same data as JSON with per-step timings, and `isError` with the reason when
a step fails. Verdicts: `pass`; `fail` (a capture failed or did not run); `incomplete` (the design hides a job in every
context, so it has nothing to compare; never a pass). A verify without a verdict keeps its partial captures and the
Unity log in `<screen>/.design-ui/failed-<run>/`.

## Configuration

`<UnityProjectDir>/design-ui.config.json` (setup writes it):

```json
{
  "designRoot": "Designs",
  "kitDir": "Designs/design-kit",
  "profileAsset": "Assets/DesignUi/DesignUiProfile.asset",
  "mcpServer": "<clone>/tools/design-ui-mcp/dist/server.js",
  "cacheBudgetMB": 2048,
  "unityRunner": { "prefer": "editor", "captureVia": "command", "timeoutSec": 1800,
                   "command": { "import": [], "capture": ["<clone>/scripts/capture-on-copy.sh", "{projectDir}"], "kitSync": [] } }
}
```

- `designRoot`: one folder per screen (its `.html` or `.dc.html` pages, assets and `blobs.json`); the server keeps its
  bookkeeping in `<folder>/.design-ui/` and writes `<folder>/report.html`.
- `kitDir`: the project's design kit (setup copies the clone's `design-kit` there; kit sync writes the project's fonts
  into it, and refuses to write into a clone's own kit); `profileAsset`: the `DesignUiProfile`; `mcpServer`: the server
  path the Design UI window puts into its client snippets.
- `cacheBudgetMB` (default 2048): the most the screens' bookkeeping may take; cleanup is automatic (see the
  [usage guide](docs/guide/usage.md#disk-use)), and `design_ui_clean` runs it on request.
- `unityRunner.prefer: "editor"` runs import and kit sync in the open Editor's bridge and fails if it does not answer
  (no silent fallback); `"command"` runs the argv templates instead.
- `unityRunner.captureVia` must be `"command"`: verification never runs in your open Editor. `command.capture` runs the
  EditMode test `DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv` in batchmode **on a copy of the project**
  (Unity cannot open a project twice): `scripts/capture-on-copy.sh` waits for a capture slot (one at a time per machine by
  default, `--slots`), checks the free disk (`--min-free-gb`), makes a temporary copy without the open Editor's process
  and lock files, lists the package's tests in the copy's manifest only, and removes the copy afterwards; a project with
  its own heavy-job runner puts that runner's command there instead; see the
  [usage guide](docs/guide/usage.md#verification-captures).
- Templates take `{projectDir}` `{profile}` `{exportDir}` `{outDir}` `{kitDir}`, also passed as `DESIGN_UI_*`
  environment variables. They run as programs with your rights: only use a config you trust.
- `timeoutSec` limits one Unity step (the script compile after an import included); while it runs, the server sends
  MCP progress notifications every 10 s.
- The server reads the config when it starts: after editing it (or after setup configures a project), restart the MCP
  server, which in most clients means a new chat.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `unity.bridge: "not-found"` | The project is not open in Unity, the package is not resolved yet, or the bridge is off in `Window > Design UI > Status`. |
| `unity.bridge: "not-responding"` | Unity is busy, reloading scripts or closed; wait and call `design_ui_list` again. `"unauthorized"`: press Restart in the window. |
| "old package id" in `design_ui_status` or the Status window | The project lists the package under its id before 0.1.0 (see the changelog): run `scripts/setup.sh` again; it replaces the dependency key and the git URL path. |
| `design_ui_*` tools missing | The chat started before the registration: start a new one in the folder the server is registered for. |
| `No DesignUiProfile at …` | Create the profile: `Window > Design UI > Status`, **Create Profile**. |
| Compile errors after an import | The import returns Unity's compiler messages. Generated view under an assembly definition: add `DesignUi.Runtime` to its references. A presenter using a removed `data-u-id`: put the id back or update the presenter. |
| `U-CSS-010` on every text after a kit sync | The kit's `--font-ui` names a family the synced fonts do not have (a TMP asset's name can differ from its face family). Kit sync rewrites the token from the real family; run `kit build`, and use the same token in the design. |
| `U-FONT-001` / a missing face at import | The reference locale's font has no real face for that weight or italic: add the face to the TMP font's weight table and sync the kit, or use 400/700. Other locales get a warning or a note. |
| Verify fails with "import the screen again from a current export" | The export and the compiled screen are from different tool versions: run `design_ui_import` again. |
| Verify gives no verdict | Read `<screen>/.design-ui/failed-<run>/` (the Unity log and what was captured). Check `unityRunner.command.capture` and `timeoutSec`. |
| Verify is `incomplete` | Some capture job shows an element no state, class or sample row shows; the import named it. Make it visible in some context, or remove it. |
| Arabic letters unshaped or reversed | Turn on Enable Advanced Text (and give players ICU data on their PanelSettings). |
| Text drawn with the advanced generator is empty | A font asset unloaded and loaded again is lost to TextCore's registry; the locale controller and scene loads repair the twins (`TextAssetRegistry`). Host code drawing twins outside a locale controller calls `TextAssetRegistry.Repair(font)`. |
| "Exit Play mode first" from an import or kit sync | Stop Play: what an import adds to the font twins in Play would be taken back when Play stops. |
| Empty localized labels, "Uxml object has an invalid child element" | A screen was imported before the package defined an element it uses. The package imports generated screens again after a package update (asset by asset); a screen still broken is fixed by importing its folder again. |
| Disk use | `design_ui_status` shows the screens' bookkeeping; cleanup runs after every import and verify, within `cacheBudgetMB`, and `design_ui_clean` runs it now. A capture command of your own must remove its project copy afterwards, as `scripts/capture-on-copy.sh` does. |
| "kitDir is the unity-ui-mcp clone's own design-kit" | A config from an earlier setup: copy `design-kit` into `<designRoot>/design-kit` (without `fixtures/`) and point `kitDir` there. |
| `could not start Chromium` | `npx playwright install chromium` in the clone. |

## Development

```sh
npm ci
npx playwright install chromium
npm test -w design-export && npm test -w design-ui-mcp
npx tsc --noEmit -p tools/design-export && npx tsc --noEmit -p tools/design-ui-mcp
npx design-export kit build design-kit --check      # RULES.md, base.css and the kit pages are current
```

Run these before a pull request. GitHub Actions (`.github/workflows/node.yml`) runs the same Node suites and type
checks on Linux with Node 20 and 22 on every push and pull request. The Unity package tests
(EditMode, in `samples/FidelityProject`) and the fidelity suite (`scripts/fidelity.sh`) need Unity and run locally:
`samples/FidelityProject` references the package by a relative path, and `scripts/unity-check.sh` is the maintainer's
wrapper for running them on an isolated copy.

## License

The code is licensed under the [MIT License](LICENSE). The bundled Inter font (`design-kit/fonts/`,
`samples/FidelityProject/Assets/Fonts/Inter/` and the exporter's test kits) stays under the SIL Open Font License
(`OFL.txt` next to the font files).
