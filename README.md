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
| `packages/com.ertugrulgaziakcan.design-ui` | Unity package (Unity 6000.3): compiler, generated views, runtime helpers, Editor bridge, verifier |
| `tools/design-ui-mcp` | MCP server (stdio) for any MCP client, one per Unity project |
| `tools/design-export` | Node CLI behind the server: `lint`, `export`, `compare`, `kit build`, `kit claude` |
| `skills/unity-ui-mcp` | The `/unity-ui-mcp` chat skill for Claude Code, Codex and Cursor |
| `design-kit` | The design contract (`RULES.md`), tokens, text styles, base stylesheet, components, fidelity fixtures |
| `samples/FidelityProject` | Unity 6000.3 project the package tests and the fidelity suite run in |

Guides: [usage guide](docs/guide/usage.md) · [Türkçe kullanım rehberi](docs/guide/kullanim-rehberi.md) ·
[install guide for AI agents](INSTALL.md) · [design rules](design-kit/RULES.md) ·
[spec](docs/spec/2026-11-12-design-to-uitoolkit-design.md) · [measurements](docs/findings/) · [decisions](docs/decisions.md) ·
[changes and known limitations](CHANGELOG.md)

## Requirements

- **Unity 6000.3** (Unity 6.3 LTS); everything was measured on 6000.3.6f1 in the Editor (players and later Unity
  versions are not verified: [known limitations](#known-limitations)). The package pulls in `com.unity.ugui` and
  Newtonsoft JSON.
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
   kit sync (step 1 of the loop below). Designs are written in the profile's **Reference Locale**, English by default:
   to design in another language, set it in the profile before that kit sync (the usage guide says how).

[INSTALL.md](INSTALL.md) is the agent's guide, with every setup option and the manual route.

**Upgrading.** Pull the clone and run setup again (it rebuilds the server), and move the Unity package to the same
version (setup keeps an existing package entry: [INSTALL.md](INSTALL.md#updating) says how). Setup keeps a project's
existing kit too. After you pull a newer clone, bring the project's kit to the clone's
version with `npx design-export kit upgrade <kitDir> --dry-run` (in the clone; it prints what it would replace, keep and
back up), then without `--dry-run`. It takes the clone's base stylesheet, rules, components, text styles and
configuration keys and keeps the project's fonts, the tokens it changed or added (a value an earlier clone shipped takes
the new one), its own components and list entries (a list it narrowed stays narrowed; `.kit-base.json` records the clone
configuration it came from), its locales, own keys, own text styles and files, and any viewport it
declared besides the clone's; it builds the merged kit before it writes anything, backs up the files it replaces into
`<kitDir>/.backup/<UTC time>/files/` (with `kit-upgrade.json` listing what it replaced and added; the newest three are
kept), prints the command that restores the kit and runs `kit build` and `kit build --check`. Then run a kit sync. A
profile saved before the six default viewports keeps its own list: kit sync refuses to drop the kit's other viewports,
or an entry it cannot read, and says so; `Window > Design UI > Add Default Viewports to Profile` adds the defaults to a
profile with the 2560×1440 reference.

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

Append `#<tag>` (a release, such as `#v0.1.0`) or `#<commit>` to pin a version; without one Unity takes the default
branch. `scripts/setup.sh` always pins: to the tag the clone's HEAD is at, else to its full commit, never to a branch
name (a branch moves, and a project that resolved one breaks when it is deleted or rewound). Unity records the commit in
`packages-lock.json`; to update, add the URL again or remove the `com.ertugrulgaziakcan.design-ui` entry from
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
   component). It ships the font faces the kit's text styles and font tokens reach (`--all-faces`: every face of the
   kit's fonts) and leaves out any file over the Design System's 15 MiB file cap; it prints what it left out, and the
   README lists it. Ask `/unity-ui-mcp` to publish it, or publish that folder yourself; every canvas then attaches it.
3. **Design.** In Claude Design, one artboard per screen, 2560×1440, with the design system attached. Start from
   the screen's inventory, taken from the game: the values it shows and their sources, its actions and the code that
   runs them, its states, lists and existing texts (for a redesign, everything the current screen does). The design
   holds exactly that plus what you ask for: no button, text or value the game cannot back, and sample data that looks
   like the game's. Visible text is written in the reference locale with an English key, controls get ids and actions,
   repeated rows are written out as samples (the [usage guide](docs/guide/usage.md) has a prompt). When the inventory
   is kept as a [screen contract](#screen-contract), the brief from `design_ui_brief` is the prompt.
4. **Apply it.** In your AI client: `/unity-ui-mcp`, then give it the canvas link (or a folder under `designRoot`) and
   name the screen. It fetches the artboard, then runs:
   - **lint** (`design_ui_lint`): any finding is a design-side fix (rule id, element, fix); fix it in Claude Design.
   - **import** (`design_ui_import`): exports the design in Chromium and compiles it into the open Editor through the
     bridge. The screen appears without a manual refresh; Unity recompiles scripts only when the view class changed.
   - **verify** (`design_ui_verify`): renders the compiled screen in Unity on a copy of the project, compares every
     capture with the design and returns `pass`, `fail` or `incomplete` with `<screen>/report.html`.
5. **Wire it and prove it in the game.** The import is the visual half. A presenter, your game's own code, feeds the
   generated view from the sources and runs the commands the inventory lists (below); for a redesign it replaces the
   old screen behind a switch. The screen is done when every inventory item works in Play mode at every viewport and
   after a locale switch, with no new console errors. `/unity-ui-mcp` writes and checks the presenter from your
   project's real services and reports each item; it never invents data, providers or commands, and the import itself
   never edits your code.

Changing the design later is the same loop: re-import regenerates only generated files and refuses to overwrite a
generated file someone edited by hand.

## Screen contract

The inventory can be kept as `screen.contract.json` beside the design, written by your AI from the project (the tools
check it; they never read your game code). It lists the values (with real `samples`), actions (with the handlers that
run them), states, lists, texts (`en`, and `ref` for a non-English reference locale) and the items the user decided to
drop (`removed`); the skill gives the format with an example. Lint then fails a design that adds or lacks an item
(`U-CON-001`…`U-CON-006`), `design_ui_brief` (`design-export contract brief <designDir> --kit <kitDir>`) turns the
contract into the brief for the design tool before anything is designed, and the import result carries the wiring
checklist the presenter is written from. A ZIP design reads its contract from inside the ZIP, beside its page. The kit
setting `screenContract` in `kit.config.json` is `optional` (default: a screen without a contract gets the info finding
`I-CON-001`) or `required` (a missing contract blocks import); `kit upgrade` keeps it.

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
  characters the import pre-adds; what text adds to them in Play mode is taken back when Play stops, and an import or kit
  sync gives a loaded twin that holds glyphs runtime text added (a twin first loaded during Play, a panel drawn in Edit
  mode) its file's glyphs back before it saves, so twins do not change in version control after a Play session. Twins stay small: one atlas per face, sized to its glyphs, with the
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

- **Text styles only.** UI Toolkit has no `line-height`, so every text uses one of the kit text styles (caption 20/28
  to display 64/80 px, 400 or 700). Their sizes and line heights are multiples of 4 px, whole device pixels at every
  exact viewport, and the font twins carry each style's CSS line box: a text block is exactly lines × line height on
  both sides. A text that does not wrap (`white-space: nowrap`, its lines its `<br>`s, kept by every translation) gets
  exactly that height, so it adds no text-height drift to the labels stacked below it; a bound text or one with
  arguments keeps its measured height. Translations of such a text must keep its line count.
- **No text cut by its box.** A box with `overflow: hidden` (the text's own, as an ellipsis label, or an ancestor's) must
  be at least the text's line height, a whole number of line heights for several lines: lint U-CSS-047 rejects a line box
  it cuts, because both renderers clip the accents and descenders alike and verify does not notice.
- **A word must fit its wrapping box.** The browser lets a word with no break opportunity (`AUJOURD’HUI`) overflow its
  line; UI Toolkit breaks it inside the word (the advanced text generator after a quotation mark). Lint W-TEXT-001
  (warning) names such a word; give the box room for the longest word, also in translations, or make the text one line
  with an ellipsis ([docs/findings/line-breaks.md](docs/findings/line-breaks.md)).
- **A readable minimum.** No text draws below 9 device px at any declared viewport, exact or scaled (the game-industry
  practice of a minimum readable size, instead of looser checks for tiny text): with the default viewports design text
  is at least 18 px (9 device px at 1280×720, 9.6 at 1366×768), and the kit's smallest styles are 20 px. Lint U-FONT-004
  rejects a text below it (with the scale its transforms keep it at); kit build rejects a text style below it.
- **Grayscale font smoothing** on the root (the base stylesheet sets it): browsers on macOS otherwise draw thicker
  stems than UI Toolkit.
- **Borders and lines on the device grid.** A border, hard shadow edge or line under 8 px must stay whole at every
  exact viewport (U-CSS-040).
- **Paddings, margins and gaps on the device grid.** UI Toolkit lays them out as whole device pixels (10 px is 8 device px
  at 1920×1080 where the browser lays out 7.5), so they must be whole at every exact viewport: multiples of 4 px with the
  default kit (U-CSS-046, which names the nearest valid lengths). Position offsets and translations are laid out as
  given.
- **Opacity** below 1 only on one-part elements (U-CSS-039); use the kit's disabled colours.
- **Animations** only of transforms, opacity, colours and border radii; a size or position change is a `translate`
  or `scale` (U-CSS-013, U-CSS-042).
- Flex layout only (no grid, `calc()`, viewport units, floats); `box-shadow` and gradients are baked into images; fonts
  come only from the kit; no network resources.
- **Raster pictures**: one file per image across the viewports' 3× range, exported for the largest (W-IMG-001 warns when
  it is smaller); UI Toolkit samples it without mipmaps, so fine raster detail does not survive the smallest viewports the
  way it does in the browser. Draw such detail as a vector, or keep it coarse.

## Viewports: exact and scaled

`kit.config.json` declares the resolutions a game ships (the profile's **Viewports** and **Scaled Viewports** mirror
it; kit sync writes the profile's). A new profile starts with the defaults below; a profile saved before this release
keeps its own list and declares no scaled viewport until one is added. Each has a class:

- **exact** (`[w, h]`): the panel scale keeps the kit's 4 px grid whole, so every text size, line height, border and thin
  line is a whole number of device pixels there; kit build, kit sync and lint hold the design to it. With the
  2560×1440 reference that is 3840×2160 (scale 1.5), 2560×1440, 1920×1080 (0.75) and 1280×720 (0.5).
- **scaled** (`{ "size": [w, h], "class": "scaled" }`): a resolution players use where no design value can be whole
  (1600×900 is scale 0.625, so a 4 px border is 2.5 device px; 1366×768 is 0.5335, so nothing is). The screen is laid
  out and verified there with the same limits (boxes, baselines and line extents within ±1 device px), but the
  whole-pixel rules do not apply to it. UI Toolkit puts font sizes, paddings, margins and borders on whole device pixels
  before layout, so at such a scale the screen's panel lays out at the next exact scale up (1600×900 and 1366×768 at 0.75)
  and the screen root draws scaled to the actual one, at most 1, so layout's rounding stays within half a device pixel:
  every edge and every line of text lands where the design puts it, and the design's own transforms and animations of the
  root compose with it. For a designer nothing changes: design at 2560×1440 with the kit.

Declare every resolution the game offers, in the class it belongs to. A resolution that is not declared lays out the same
way (at the next exact scale up, drawn scaled) but is not verified; above the largest exact viewport the screen draws
larger than it lays out, and boxes can be off by more than a device pixel there (declare an exact viewport at that scale).
While a screen is on a panel in Play mode or a player its PanelSettings hold the exact scale's factor, every document
on that PanelSettings lays out at that scale (20 % larger at 1600×900, 41 % at 1366×768), and panel coordinates outside
the screen root are the exact scale's: give design screens their own PanelSettings and put a screen at its container's
top-left corner (usage guide, "At a scaled or undeclared resolution"). In the Editor outside Play mode a factor is held
only on PanelSettings no save writes (runtime copies, such as the capture's); a screen on an asset or a scene's own
settings lays out at the actual scale there, unscaled. The screen root's inline transform is the design's composed with
the root scale: game code's own inline `translate`, `rotate`, `scale` or `transform-origin` on a screen root is
overwritten (move or animate a container instead). `design_ui_status`, `design_ui_verify` (captures per
class) and `Window > Design UI > Status` show each viewport's class.

A line that does not wrap and ends in an ellipsis is cut by UI Toolkit's own elision, which matched Chromium's cut at
every exact viewport (the fidelity suite's lines and a real game screen's titles). At a scaled viewport it decides under
the root scale and can keep one grapheme more or fewer when the box lies within about an advance of the threshold; verify
allows exactly that there ([D-146](docs/decisions.md), `ellipsisGraphemes`): the line must start where the design's does
and differ by at most one grapheme. The line must end in the design's ellipsis glyph ([D-147](docs/decisions.md)): from
16 device px its profile is compared with the design's; below that, three dots at the design's pitch and height
([D-148](docs/decisions.md)), and a line whose design dots do not resolve into three is not judged (counted in the
verdict as `ellipsisNotJudged`). The package never changes a label's text.

Text-sized elements (a button or label whose width is its text's) lay out at the golden's width for their text: the
golden ceils Chromium's text width to whole device pixels at the viewport's scale, UI Toolkit ceils on the grid of the
scale it lays out at, with no tolerance; the compiler writes such elements as `DesignButton` / `DesignLabel`, which keep
the golden's width (a text within 0.012 device px above a whole pixel is that pixel on both sides, measured), so a row
of them does not drift, and measure it again whenever its text, font or style changes (its font size and spacings
included), however the text is written (a binding, a language switched while the screen is open) and whether or not UI
Toolkit sends the element a style event. A text the design wraps keeps wrapping where its line has no room. Text the
advanced generator lays out (a script locale such as Arabic) keeps UI Toolkit's own width: its width against Chromium's
is not measured.

## Fidelity and speed

Thresholds (`tools/design-export/fidelity-thresholds.json`):

| Check | Limit |
|---|---|
| Element boxes | ±1 device px at every viewport, exact and scaled |
| Text | same line count and breaks, baseline ±1 px, ink colour and amount per line, and where each line's first and last glyphs sit (and the width between them) ±1 px; the same for the text of a repeat's later items. A hairline line (text of at most 12 device px at opacity 1, all in its own recorded colour, with no element, repeat copy (in its own item's state) or shadow over it that both renderers paint after it, and fewer than 3 fully covered pixels in the design: an em dash, a "1" whose one stroke lies between two device pixels) is judged by its ink's colour direction from the background (0.66°, measured) and an ink amount of 0.5–2× the design's instead of its ink colour and amount: on such a line a lightness-only error within that amount is not caught. At a scaled viewport the size bound is under 13 device px, with the same text judged and passing at every exact viewport, and a line only Unity's render shows as a hairline needs at least 0.84 of the design's summed ink ([D-152, D-158](docs/decisions.md)). A line the design's opaque covers hide entirely must show the cover in Unity: text Unity draws there fails in 4 pixels or more that no design colour within 2 device px explains; fewer pixels, a stroke near a cover edge of a similar colour, or one inside another text's line box is not caught |
| Colours at sampled points | ΔE2000 ≤ 1 (the ring of a round element without text, at the middle of each border side of 2 device px or more: ≤ 3.1, measured; not where an animation sample moves the element, by an animation of its geometry; a ring thinner than 2 device px has no colour sample, and the sample, the best of ±1 px offsets, judges a ring's colour, not its width) |
| Ring width | a round element without text: its ring's drawn width across the middle of each side and each round corner within 0.5 device px of the design's, unless an animation sample moves it. The check decides reliably from 0.75 device px: a ring 1 CSS px thinner at 1280×720 (0.5 device px) can pass |
| Structure (SSIM, non-text) | ≥ 0.99 for the capture and for each element (small elements ≥ 0.984, pictures ≥ 0.985, rotated animation samples ≥ 0.975) |
| Animation samples | at the delay and every quarter of each animation, the same limits |
| Anti-aliasing, every viewport | a round element without text, and in an animation sample an element moved to a fractional device offset, may meet 0.974 when its SSIM with the 1 device px edge band masked (its curves; for the moved element also its straight edges where both renderers put them) meets 0.99 and its other checks pass, with evidence at the level of pixels: outside the band every 8 px SSIM block meets 0.99 and every 3×3 window is within ΔE2000 1 of Unity's (best of ±1 px), and every border in the band keeps the design's width (±0.5 device px) and, unless an animation sample moves it, its centre colour (ΔE2000 3.1) |
| Scaled viewports only | the same, except the anti-aliasing the root scale draws at the layout scale's pixel, each only with the same band evidence: any element with round shapes may meet 0.974 for its curves' band, a rounded-corner sample of an element that carries text, whose window reaches that band and whose window pixels outside it (at least 3, at one offset) match, may differ by ΔE2000 5.5; an element whose straight edges (box and border's inner edges, also of a repeat's later items) fall between device pixels may meet 0.97 for their band, a vector picture 0.975 for its drawn edges' band, a corner sample reaching straight edges between pixels ΔE2000 5.3; a raster picture drawn at another size than its own 0.95, its colour samples ΔE2000 5.89 (resampling, measured); text under 13 device px (the root scale draws 10.67, 12.5 and 12.8 px) takes the small-text ink limits, its colour ΔE2000 5.89 (measured, at most 6.5) |

The fidelity suite (`scripts/fidelity.sh`: 24 fidelity fixtures and the 9 kit components at the kit's six viewports,
4740 captures, about 14 minutes) passes every capture at all six viewports, exact and scaled (an unchecked radio's ring and
a transition sample at 1280×720 pass through the anti-aliasing edge band, and two one-glyph texts of a repeat's later items,
an em dash and a "1" whose stroke lies between two device pixels, through the hairline rule;
[docs/findings/viewport-classes.md](docs/findings/viewport-classes.md)). The measured scaled-class limits are the
anti-aliasing the root scale draws at the layout scale's pixel (round shapes, straight edges between device pixels, vector
pictures' edges and corners next to such edges), each applied per capture only with evidence at the level of pixels, the
resampling of raster pictures drawn at another size, and the small-text ink limits for text under 13 device px.

**Linear colour space.** UI Toolkit blends an ordinary on-screen panel of a Linear project in linear light; the design's
browser blends in sRGB. Captured that way, 2248 of the 2355 captures the suite had then fail (text ink 0.63–1.42× the design's,
translucent colours up to ΔE2000 37). Add `DesignUiGammaComposite` (Add Component > Design UI > Gamma Composite) with
the design PanelSettings once to the game: the panel then renders into a screen-sized UNorm texture with
`forceGammaRendering` and is composited over the screen, with the colours verify captures and pointer input mapped
to the texture (cost: 29.5 MB of textures and one full-screen pass, 0.14 ms at 2560×1440 on an M4 Pro). It is drawn
where UI Toolkit would draw the panel: over Screen Space - Overlay canvases of a lower or the same sort order, under
those of a higher one, among other panels by sort order, as pointer input goes
([docs/findings/composite-order.md](docs/findings/composite-order.md); the order was measured in the Editor on the
Built-in pipeline and URP 17.3). Colours were measured in EditMode and a batchmode Play check on the Built-in render
pipeline; player builds are not verified yet. The
profile's `colorPath` is Gamma Composite by default; Linear Panel makes verify capture an ordinary on-screen panel
instead, and its answer warns. Verify, the Design UI window and a `DesignUiPanelRegion` at runtime warn when no
composite renders the panel. A Gamma project needs neither. Details: [docs/findings/colour-space.md](docs/findings/colour-space.md).

Measured on the sample project (macOS, Apple silicon, warm browser):

| Step | Time |
|---|---|
| Lint and export of one screen | 1.3–1.8 s for a static screen at the six default viewports; 2–21 s with states, pseudo-states and animation samples (70 s for the transitions fixture's 210 captures) |
| Import through the Editor bridge, view class unchanged | 0.2 s Unity request; 4.5 s for the whole tool call with its export |
| Import that changes the view class | 1.8–3.3 s Unity step (script compile and domain reload); longer in a large project |
| Unity capture | about 33 ms per capture job after one mount per viewport |
| Fidelity suite Unity steps (33 screens, six viewports) | import 33 s, capture 200 s |

## MCP tools

| Tool | Does |
|---|---|
| `design_ui_rules` | The design contract (`RULES.md` with a section index; one `section`, or `json`); also the resource `design-ui://rules` |
| `design_ui_list` | Screens under `designRoot` with their state (new, design changed, imported, verified, failed, incomplete) and the Unity bridge state |
| `design_ui_lint` | Lints a design folder, `.html`, `.dc.html` (a Claude Design artboard) or `.zip` in Chromium with the kit fonts |
| `design_ui_import` | Exports a screen and compiles it into the Unity project (open Editor bridge, or a command) |
| `design_ui_verify` | Captures in Unity, compares, returns the verdict, the report path and the top issues |
| `design_ui_status` | What this version supports and how each Unity step runs; or one screen's hashes, last import and verdict |
| `design_ui_kit_sync` | Syncs fonts and settings from the Unity project into the kit; `addProfileViewports` adds the viewports the kit declares and the profile lacks |
| `design_ui_clean` | Reports (`dryRun`) or runs the cleanup of the screens' bookkeeping that import and verify also run by themselves |

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
- `cacheBudgetMB` (default 2048): the budget of the screens' derived files; over it the cleanup removes kept captures,
  then the exports of the screens least recently imported or verified (records, report pictures and each screen's newest
  three failed runs stay, so the bookkeeping can stay above it when they alone are larger). Cleanup is automatic (see the
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
  environment variables. The command's `PATH` starts with the folder of the node that runs the server, and
  `DESIGN_UI_NODE` names that node (a client may start the server with a `PATH` without node). They run as programs with
  your rights: only use a config you trust.
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
| Verify says "its export was made by another version of the exporter" | The export is from another tool version (after an update): run `design_ui_import` again (it exports the screen with this version), then verify. |
| Import says "the export is IR version 1, made by an earlier design-export" | The screen's export predates IR version 2: run `design_ui_import` again, which exports it with this version by itself. "Reads IR version …, the exporter writes IR version …" before an import: the clone and the Unity package are different builds; update both together ([INSTALL.md](INSTALL.md#updating)). |
| Verify gives no verdict | Read `<screen>/.design-ui/failed-<run>/` (the Unity log and what was captured). Check `unityRunner.command.capture` and `timeoutSec`. |
| Verify is `incomplete` | Some capture job shows an element no state, class or sample row shows; the import named it. Make it visible in some context, or remove it. |
| Arabic letters unshaped or reversed | Turn on Enable Advanced Text (and give players ICU data on their PanelSettings). |
| Text drawn with the advanced generator is empty | A font asset unloaded and loaded again is lost to TextCore's registry; the locale controller and scene loads repair the twins (`TextAssetRegistry`). Host code drawing twins outside a locale controller calls `TextAssetRegistry.Repair(font)`. |
| "Exit Play mode first" from an import or kit sync | Stop Play: what an import adds to the font twins in Play would be taken back when Play stops. |
| Empty localized labels, "Uxml object has an invalid child element" | A screen was imported before the package defined an element it uses. The package imports generated screens again after a package update (asset by asset); a screen still broken is fixed by importing its folder again. |
| Disk use | `design_ui_status` shows the screens' bookkeeping; cleanup runs after every import and verify, within `cacheBudgetMB`, and `design_ui_clean` runs it now. A verify's output is bounded (thumbnails of the first 24 failing captures with different issues, one crop per element, check and viewport up to a limit the report names when it skips any, a compact `verdict.json` with one capture per line) and replaces the previous verify's. A capture command of your own must remove its project copy afterwards, as `scripts/capture-on-copy.sh` does. |
| "kit viewports missing from the profile" from kit sync | The profile was saved before the six default viewports. `Window > Design UI > Add Default Viewports to Profile` (2560×1440 reference; Undo restores the open profile, save the project to write that), or `design_ui_kit_sync { addProfileViewports: true }`; if the game does not ship a resolution, remove it from kit.config.json. "a viewport kit sync cannot read": write it as `[w, h]` or `{ "size": [w, h], "class": "exact" \| "scaled" }` in whole pixels. |
| `kit claude` left a font out | It ships the faces the text styles and font tokens reach, upright and italic (`--all-faces` for every one), and never a file over 15 MiB; the note and the README say which. |
| An old project kit (text styles, viewports) after a pull | `npx design-export kit upgrade <kitDir> --dry-run`, then without `--dry-run` (README, Upgrading). |
| "kitDir is the unity-ui-mcp clone's own design-kit" | A config from an earlier setup: copy `design-kit` into `<designRoot>/design-kit` (without `fixtures/`) and point `kitDir` there. |
| `could not start Chromium` | `npx playwright install chromium` in the clone. |

## Development

```sh
npm ci
npx playwright install chromium
npm test -w design-export && npm test -w design-ui-mcp
npx tsc --noEmit -p tools/design-export && npx tsc --noEmit -p tools/design-ui-mcp
npx design-export kit build design-kit --check      # RULES.md, base.css and the kit pages are current
npx design-export kit upgrade <kitDir> --dry-run    # a project kit against this clone's (prints only)
```

Versions: the Unity package and the Node tools share one version number (`package.json` of each). A change of the IR
format (`tools/design-export/src/ir/schema.json`) after a release raises `irVersion` on both sides (the package's IR
reader refuses another one, and the server stops an import when the bridge reports another one); any other change raises
the version. 0.1.0 is IR version 2.

Run these before a pull request. GitHub Actions (`.github/workflows/node.yml`) runs the same Node suites and type
checks on Linux with Node 20 and 22 on every push and pull request. The Unity package tests
(EditMode, in `samples/FidelityProject`) and the fidelity suite (`scripts/fidelity.sh`) need Unity and run locally:
`samples/FidelityProject` references the package by a relative path, and `scripts/unity-check.sh` is the maintainer's
wrapper for running them on an isolated copy (it calls a clone tool that is not part of this repository).

**Your own Unity runner** (`FIDELITY_UNITY_CHECK=<executable> scripts/fidelity.sh`). The suite calls the runner once per
Unity step (setup and kit sync, import, capture, cleanup) as `<runner> --warm --wait --editmode "<regex>"`, with the
step's `DESIGN_UI_*` variables in its environment. The runner must:

- run the EditMode tests whose full names match the regex (Unity's `-testFilter`) in batchmode on a copy of
  `samples/FidelityProject` whose manifest points the package's relative `file:` path at this clone, never in an open
  Editor;
- keep that copy between the calls of one run (setup writes the profile and fonts the import and capture use), and
  pass the environment on to Unity;
- exit 0 when the tests passed and non-zero otherwise; a line with `detay=<text> png=` in its output gives the summary
  its detail (optional).

A plain batchmode runner:

```sh
#!/usr/bin/env bash
# fidelity-runner.sh: one persistent copy of samples/FidelityProject
set -euo pipefail
CLONE="$(cd "$(dirname "$0")/.." && pwd)" COPY="${FIDELITY_COPY:-$HOME/fidelity-copy}"
filter=""; while [ $# -gt 0 ]; do [ "$1" = --editmode ] && filter="$2"; shift; done
if [ ! -d "$COPY" ]; then
  cp -R "$CLONE/samples/FidelityProject" "$COPY"
  sed -i.bak "s#file:../../../packages/#file:$CLONE/packages/#" "$COPY/Packages/manifest.json"
fi
"$UNITY_BIN" -batchmode -projectPath "$COPY" -runTests -testPlatform EditMode -testFilter "$filter" \
  -testResults "$COPY/results.xml" -logFile -
```

## Known limitations

Measured on macOS (Apple silicon) with Unity 6000.3.6f1 in the Editor; player builds, later Unity versions and Windows
are not verified, URP only in the Editor, and Windows has no default capture route (use WSL or a capture command of your
own). The [changelog](CHANGELOG.md#known-limitations) lists every known limitation, including what the comparison does
not catch.

## License

The code is licensed under the [MIT License](LICENSE). The bundled Inter font (`design-kit/fonts/`,
`samples/FidelityProject/Assets/Fonts/Inter/` and the exporter's test kits) stays under the SIL Open Font License
(`OFL.txt` next to the font files).
