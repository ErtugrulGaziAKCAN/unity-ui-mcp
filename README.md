# unity-ui-mcp

Turns Claude Design HTML screens into Unity UI Toolkit screens, one to one, and measures the result against the
design. Any MCP-capable AI client (Claude Code, Codex, Cursor, Claude Desktop) drives the loop: lint the design,
import it into the open Unity Editor, verify it, read the report.

**Status:** in development. The design spec is in `docs/specs/`. The Unity package currently contains the Editor
bridge and the `Window → Design UI → Status` window. The MCP server is available as an early version: rules, list,
lint and status work, and import runs the export; the Unity compile step, verify and kit sync answer "not available yet"
until the compiler and verifier land.

- `tools/design-export` - Node/TypeScript CLI (`lint`, `export`, `compare`)
- `tools/design-ui-mcp` - MCP server (stdio) for any MCP client
- `packages/com.unity.design-ui` - Unity UPM package (Unity 6000.3 or later)
- `samples/FidelityProject` - Unity 6000.3.6f1 test project
- `design-kit` - design kit config, tokens and rules

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
when they are missing, and registers the server for Claude Code (`--dry-run` shows the changes first). By hand:

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
its bookkeeping in `<screen>/.design-ui/`. `unityRunner.prefer: "editor"` sends import and kit sync to the open
Editor's bridge and fails if it does not answer (no silent fallback); `"command"` runs the argv templates instead
(placeholders `{projectDir}` `{profile}` `{exportDir}` `{outDir}` `{kitDir}`, also passed as `DESIGN_UI_*`
environment variables; relative paths start from the Unity project folder). Captures for verification use the
command route unless `captureVia` is `"editor"`. Command templates run as programs with your user's rights: only
use the command runner with projects whose `design-ui.config.json` you trust.

| Tool | Does | This version |
|---|---|---|
| `design_ui_rules` | Design contract: kit rules, attributes, text styles, fonts, allowed CSS, lint rules (also resource `design-ui://rules`) | live |
| `design_ui_list` | Screens under `designRoot` with their state, and the Unity bridge state | live |
| `design_ui_lint` | Lints a design folder, `.html`, `.dc.html` or `.zip` in Chromium with the kit fonts | live |
| `design_ui_status` | Server capabilities, or one screen's hashes, last import and verdict | live |
| `design_ui_import` | Exports a screen and compiles it into the Unity project | export live; Unity compile not available yet |
| `design_ui_verify` | Captures in Unity, compares, returns verdict and report | not available yet |
| `design_ui_kit_sync` | Syncs fonts and settings from Unity into the kit | forwarded; Unity answers "not available yet" |

Every result has a short text summary, the same data as JSON (with per-step `timings`), and `isError` with the
reason when a step fails or is not available. `node tools/design-ui-mcp/scripts/smoke.mjs --project <dir>` checks the
built server without a client (stdio: initialize, tools/list, design_ui_list; `--call <tool>` for others).

`scripts/setup.sh` is bash (macOS, Linux; on Windows use WSL or Git Bash, or the manual steps above).

## Install the Unity package

Package Manager → **+** → *Install package from git URL…*:

```
https://github.com/ErtugrulGaziAKCAN/unity-ui-mcp.git?path=/packages/com.unity.design-ui#m0-m1
```

`m0-m1` is the development branch. Unity pins the commit in `packages-lock.json`; to update, add the URL again or
delete the `com.unity.design-ui` entry from `packages-lock.json`.

## Running Unity checks (maintainers)

Unity verification runs on an isolated copy of the sample project made by the maintainer's local clone tool
(`~/unity-clone-test`, not part of this repository). Because the copy lives outside this repo, use the wrapper,
which temporarily makes the package reference in `samples/FidelityProject/Packages/manifest.json` absolute and
restores it on exit: `scripts/unity-check.sh --warm --editmode "" --assembly DesignUi.Editor.Tests`. When the task
is finished run `scripts/unity-check.sh --done`. Never edit the manifest entry by hand; the wrapper refuses to start
(exit 2) if it is not the relative value.

## Fonts

`samples/FidelityProject/Assets/Fonts/Inter/` contains Inter, licensed under the SIL Open Font License (`OFL.txt`).
