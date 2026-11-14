# unity-ui-mcp

Turns Claude Design HTML screens into Unity UI Toolkit screens, one to one, and measures the result against the
design. Any MCP-capable AI client (Claude Code, Codex, Cursor, Claude Desktop) drives the loop: lint the design,
import it into the open Unity Editor, verify it, read the report.

**Status:** in development. The design spec is in `docs/specs/`. The exporter lints, exports and compares; the Unity
package compiles an export into UI Toolkit (UXML, USS, a generated view class and font twins), captures compiled screens
for verification and syncs the kit's fonts from the project. In the MCP server, rules, list, lint and status are live;
import, verify and kit sync are live when their Unity route works (the open Editor's bridge answers, or a command
template is configured; captures for verify always run as a command). Animations compile but are not verified yet:
until the animation player lands, their samples are reported as not captured, so a screen with animations does not
pass verification yet.

- `tools/design-export` - Node/TypeScript CLI (`lint`, `export`, `compare`, `kit build`, `kit claude`)
- `tools/design-ui-mcp` - MCP server (stdio) for any MCP client
- `packages/com.unity.design-ui` - Unity UPM package (Unity 6000.3 or later)
- `samples/FidelityProject` - Unity 6000.3.6f1 test project
- `design-kit` - the design kit: rules, tokens, base stylesheet, text styles, components and fidelity fixtures

## Install with an AI

Paste one line into your AI client (Claude Code, Codex, Cursor, …) and answer its questions:

> Install unity-ui-mcp from https://github.com/ErtugrulGaziAKCAN/unity-ui-mcp for my Unity project by following INSTALL.md in that repository.

Türkçe:

> https://github.com/ErtugrulGaziAKCAN/unity-ui-mcp deposundaki unity-ui-mcp'yi Unity projeme kur; depodaki INSTALL.md adımlarını izle.

The agent clones the repository, asks for your Unity project and design folder, shows a dry run of
`scripts/setup.sh` and runs it after you agree. [INSTALL.md](INSTALL.md) is the agent's guide.

## MCP server

`tools/design-ui-mcp` is a standalone MCP server (stdio), started by the AI client, one per Unity project. It is not
on npm; build it from a clone (Node 20 or later):

```sh
npm ci
npm run build -w design-ui-mcp
npx playwright install chromium   # once per machine: the browser lint and export use
```

Start command for every client:

```sh
node <clone>/tools/design-ui-mcp/dist/server.js --project <UnityProjectDir>
```

`scripts/setup.sh --project <UnityProjectDir>` does all of this, adds the Unity package and `design-ui.config.json`
when they are missing, and registers the server for the client you pick with `--client claude-code|codex|cursor|all` (default `claude-code`;
Codex: one `[mcp_servers.design-ui]` table in `~/.codex/config.toml`; Cursor: `.cursor/mcp.json` in `--client-dir`, else
`~/.cursor/mcp.json`). It also links the skill (below). `--dry-run` shows every change first. By hand:

- **Claude Code**, in the folder you start it from:
  `claude mcp add --scope local design-ui -- node <clone>/tools/design-ui-mcp/dist/server.js --project <UnityProjectDir>`
- **Cursor**, `.cursor/mcp.json` (project) or `~/.cursor/mcp.json`; **Claude Desktop**, `claude_desktop_config.json`
  (Settings → Developer → Edit Config):
  ```json
  { "mcpServers": { "design-ui": { "command": "node", "args": ["<clone>/tools/design-ui-mcp/dist/server.js", "--project", "<UnityProjectDir>"] } } }
  ```
- **Codex**, `~/.codex/config.toml`:
  ```toml
  [mcp_servers.design-ui]
  command = "node"
  args = ["<clone>/tools/design-ui-mcp/dist/server.js", "--project", "<UnityProjectDir>"]
  ```

GUI clients may start servers with a minimal `PATH`; use the absolute path of `node` (`which node`) if `node` is not
found. The server reads `<UnityProjectDir>/design-ui.config.json`:

```json
{
  "designRoot": "Designs",
  "kitDir": "<clone>/design-kit",
  "profileAsset": "Assets/DesignUi/DesignUiProfile.asset",
  "unityRunner": { "prefer": "editor", "captureVia": "command", "command": { "import": [], "capture": [], "kitSync": [] } }
}
```

`designRoot` holds one folder per screen (its `.html` or Claude Design `.dc.html` page and assets); the server keeps
its bookkeeping in `<screen>/.design-ui/`. A canvas folder with several artboards works too: pass the artboard's path
(`<folder>/<artboard>.dc.html`) to lint, import, verify and status. The import takes exactly that page, its screen id
is the page's `data-u-screen`, and the folder keeps one import (verify checks the artboard that was imported last). `unityRunner.prefer: "editor"` sends import and kit sync to the open
Editor's bridge and fails if it does not answer (no silent fallback); `"command"` runs the argv templates instead
(placeholders `{projectDir}` `{profile}` `{exportDir}` `{outDir}` `{kitDir}`, also passed as `DESIGN_UI_*`
environment variables; relative paths start from the Unity project folder). Captures for verification use the
command route unless `captureVia` is `"editor"`. Command templates run as programs with your user's rights: only
use the command runner with projects whose `design-ui.config.json` you trust.

| Tool | Does | This version |
|---|---|---|
| `design_ui_rules` | Design contract: the kit's `RULES.md` with a section index; `section` returns one part, `json` the same rules, allowed CSS, text styles and fonts as compact JSON (also resource `design-ui://rules`) | live |
| `design_ui_list` | Screens under `designRoot` with their state, and the Unity bridge state | live |
| `design_ui_lint` | Lints a design folder, `.html`, `.dc.html` or `.zip` in Chromium with the kit fonts | live |
| `design_ui_status` | Server capabilities, or one screen's hashes, last import and verdict | live |
| `design_ui_import` | Exports a screen and compiles it into the Unity project | live when its route works: the Editor bridge answers (`prefer: "editor"`) or `command.import` is set |
| `design_ui_verify` | Captures in Unity, compares, returns verdict and report | live when `command.capture` is set; animation samples are not captured yet |
| `design_ui_kit_sync` | Syncs fonts and settings from Unity into the kit | live when its route works, like import |

Every result has a short text summary, the same data as JSON (with per-step `timings`), and `isError` with the
reason when a step fails or is not available. `node tools/design-ui-mcp/scripts/smoke.mjs --project <dir>` checks the
built server without a client (stdio: initialize, tools/list, design_ui_list; `--call <tool>` for others).

`scripts/setup.sh` is bash (macOS, Linux; on Windows use WSL or Git Bash, or the manual steps above).

## The `/unity-ui-mcp` skill

`skills/unity-ui-mcp` is the entry skill: type `/unity-ui-mcp` to start a chat that checks the tools and the Unity
bridge, reads the design rules, fetches a Claude Design canvas (with an Artifact tool; otherwise from an exported
folder), then lints, imports and verifies each screen and reports honestly what is not available yet. It also triggers
from plain requests such as "apply this Claude Design to Unity UI Toolkit" or "Claude Design'ı Unity arayüzüne uygula".
`scripts/install-skill.sh [--dry-run]` links it into `~/.claude/skills`, `~/.codex/skills` and `~/.cursor/skills`
(those that exist); setup runs it for you. It replaces only its own link and is safe to run again.

## Install the Unity package

Package Manager → **+** → *Install package from git URL…*:

```
https://github.com/ErtugrulGaziAKCAN/unity-ui-mcp.git?path=/packages/com.unity.design-ui#m0-m1
```

`m0-m1` is the development branch. Unity pins the commit in `packages-lock.json`; to update, add the URL again or
delete the `com.unity.design-ui` entry from `packages-lock.json`.

## Running Unity checks (maintainers)

Unity verification runs on an isolated copy of the sample project made by the maintainer's local clone tool (not
part of this repository). Because the copy lives outside this repo, use the wrapper,
which temporarily makes the package reference in `samples/FidelityProject/Packages/manifest.json` absolute and
restores it on exit: `scripts/unity-check.sh --warm --editmode "DesignUi"`. When the task
is finished run `scripts/unity-check.sh --done`. Never edit the manifest entry by hand; the wrapper refuses to start
(exit 2) if it is not the relative value.

## Capturing a compiled screen

The Unity capture renders a compiled screen the way the design's goldens show it (every job of the export's
`goldens/matrix.json`, filled with `fixtures/sample-data.json`) so that `design-export compare` can judge it. It is
an EditMode test of the package's test assembly, `DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv`:

1. Make the package's tests visible in the consuming project: add `"testables": ["com.unity.design-ui"]` to
   `Packages/manifest.json` (the sample project has it). This exposes all of the package's tests, which create and
   delete assets of their own; always run with the `-testFilter` below.
2. Run it in batchmode on a copy of the project, never in the open Editor:

   ```
   DESIGN_UI_EXPORT=<export folder> DESIGN_UI_OUT=<capture folder> \
     <Unity> -batchmode -projectPath <project copy> -runTests -testPlatform EditMode \
     -testFilter DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv -testResults <results.xml>
   ```

   - `DESIGN_UI_EXPORT`: the export folder (`screen.ir.json`, `fixtures/sample-data.json`, `goldens/matrix.json`).
   - `DESIGN_UI_OUT`: where the captures go: `<capture>.png` and `boxes.json` named like the goldens, the compiled
     `.design-ui.json` (removed wrappers), `boxes.meta.json` (`status` `running` until the run completes, what was
     not captured and why, notes, timings) and, written last, `capture-done.json` (run id, job count, captured and
     not-captured counts). The files of an earlier run in this folder are deleted first. Runners and the comparison
     treat a folder without `capture-done.json` as not captured.
   - `DESIGN_UI_SCREEN` (optional): the compiled screen folder; default `<profile output folder>/<Screen>`.
   - `DESIGN_UI_PROFILE` (optional): the DesignUiProfile asset; default the project's only profile.
   - `DESIGN_UI_EXPORT_DIR` and `DESIGN_UI_OUT_DIR` are accepted as well. Without `DESIGN_UI_EXPORT` the test passes
     with "not configured; nothing captured" and writes nothing, so only `capture-done.json` says a capture ran.
3. `design-export compare <export folder> --unity <capture folder> --report report.html`.

Animation samples are listed in `boxes.meta.json` as not captured until the animation player exists, so a screen
with animations does not pass yet. Maintainers run the capture with `scripts/unity-check.sh --warm --wait --editmode
"CaptureFromEnv"` and the variables above.

## Generated view classes

The compiler writes `<Screen>View.g.cs` next to each screen. Its assembly must reference `DesignUi.Runtime`: in
Assembly-CSharp this is automatic; when the output folder is under an assembly definition, add `DesignUi.Runtime` to
its Assembly Definition References (the compiler stops with an error naming the asmdef otherwise).

## Design kit and Claude Design

`design-kit/` is what a design is checked against and what a design AI is given:

- `RULES.md`: the design contract (generated: markup attributes, text styles, tokens, allowed CSS, every lint rule with
  its fix, an example screen). `base.css`: the base stylesheet every screen starts with. `tokens.css` and
  `text-styles.json`: the tokens and the kit text styles. `kit.config.json`: reference size, viewports, locales.
- `components/`: button, toggle, text field, dropdown, tabs, card, list row, scroll area and dialog, each a lint-clean
  screen with its guidelines (`<name>.md`); `components.json` names and groups them.
- `fixtures/fidelity/`: one screen per feature group (layout, text styles, colours and gradients, shadows, radii and
  borders, filters, states, pseudo-states, controls, text shadow, object fit, icons, transitions, keyframes) for the
  fidelity suite. `pending.json` lists screens the suite skips for now, with the reason: the filters screen fails lint
  (U-CSS-015) until `css-support.json` enables the filter functions it uses.
- `fonts/` is written by kit sync from the Unity project; the kit has no fonts until a sync ran. Kit sync also writes
  the `--font-*` tokens in `tokens.css` from the synced fonts' family names, and `kit build --check` fails when a font
  token names a family `fonts/fonts.css` does not declare.

`design-export kit build design-kit` regenerates `base.css`, `RULES.md` and the base block of every kit page after a
change to the tokens, text styles, components or lint (`--check` only reports). `design-export kit claude design-kit
<outDir>` writes the kit as a Claude Design System folder (`<outDir>/project/`: `README.md`, list-shaped `tokens.json`,
the synced fonts, a card per component and a cover, `design-system.json` last), ready to be published as a Claude
design system with an AI client's Artifact tool so every Claude Design canvas can attach it. The skill does not publish
it on its own in this version.

## Fonts

`samples/FidelityProject/Assets/Fonts/Inter/` contains Inter, licensed under the SIL Open Font License (`OFL.txt`).
