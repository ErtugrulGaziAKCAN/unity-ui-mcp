# Installing unity-ui-mcp (instructions for AI agents)

You are an AI agent asked to install this repository for a user's Unity project. Follow these steps in order. Do not
improvise other install routes, do not edit files in the user's Unity project by hand, and never commit or push
anything (in this repository or in the user's project).

What gets installed:

- **MCP server `design-ui`** (`tools/design-ui-mcp`): a local stdio server that any MCP client starts. It is built
  from this clone; it is not published on npm.
- **Unity package `com.unity.design-ui`**: one entry in the project's `Packages/manifest.json`. It adds an Editor
  bridge (loopback only, token in `Library/DesignUi/bridge.json`) that the server talks to.
- **`design-ui.config.json`** in the Unity project: where designs live (`designRoot`), the design kit, the Unity runner.

## 1. Ask the user

Ask these questions in one message and wait for the answers:

1. The **Unity project folder** (the folder that contains `Assets/` and `Packages/`). Unity 6000.3 or later.
2. The **design folder** (`designRoot`): where design screens will live, one folder per screen. Relative to the Unity
   project or absolute. Suggest `Designs` (outside `Assets/`, so Unity does not import the HTML).
3. Which **MCP client** they use: Claude Code (default), Codex, Cursor or Claude Desktop.
4. For Claude Code: the **folder they start Claude Code from** for this work. The server is registered with local
   scope, which belongs to that folder. Suggest the Unity project folder.
5. Where to put this repository's clone, if they have no preference: `~/unity-ui-mcp`.

## 2. Check the requirements

- `node --version` is 20 or later, and `npm` and `git` exist. If Node is missing or older, stop and ask the user to
  install Node.js 20+ (https://nodejs.org).

## 3. Clone

```sh
git clone https://github.com/ErtugrulGaziAKCAN/unity-ui-mcp.git <clone folder>
```

If the clone already exists, run `git -C <clone folder> pull --ff-only` instead (only if its working tree is clean;
otherwise tell the user and use it as it is).

## 4. Dry run, then confirm

From the clone folder:

```sh
scripts/setup.sh --project "<Unity project>" --design-root "<design folder>" \
  --client claude-code --client-dir "<folder Claude Code runs from>" --dry-run
```

(`--client codex`, `--client cursor` or `--client claude-desktop` print the snippet to add instead of registering.)

Show the user the complete dry-run output. It lists every change: `npm ci` and the server build inside the clone,
the Chromium download for Playwright (once per machine), the one line added to `Packages/manifest.json` (only if
the package is not there yet), `design-ui.config.json` (only if absent) and the MCP registration. Ask for a clear
yes before continuing.

## 5. Run it

The same command without `--dry-run`. It is idempotent: running it again changes nothing. It prints every change.
If the `claude` command is not found, it prints the exact `claude mcp add …` command; run that command in the
folder Claude Code runs from (or give it to the user).

## 6. Connect and confirm

1. Ask the user to open (or focus) the Unity project in Unity. Unity resolves the new package; the bridge starts by
   itself (`Window > Design UI > Status` shows it).
2. Reload the client's MCP servers: in Claude Code start a new session in that folder (or use `/mcp`); in Cursor,
   Codex or Claude Desktop restart the client after adding the snippet. The server is named `design-ui`.
3. Call `design_ui_status`, then `design_ui_list`. Success is `unity.bridge: "connected"` in `design_ui_list`. Report
   the result to the user, including which tools this version supports (from `design_ui_status`).

## What works in this version

| Tool | State |
|---|---|
| `design_ui_rules` | live: the design contract for any AI that writes the HTML (the kit's `RULES.md` is still a stub; allowed CSS, attributes, text styles and lint rules are complete) |
| `design_ui_list` | live: screens under `designRoot` and the Unity bridge state |
| `design_ui_lint` | live: real lint in a headless Chromium with the kit fonts; folder, `.html`, `.dc.html` or `.zip` |
| `design_ui_status` | live: what this version supports; per-screen hashes and history |
| `design_ui_import` | not available yet (export and Unity import pipeline are being built); answers with an error that says so |
| `design_ui_verify` | not available yet (capture and comparison are being built) |
| `design_ui_kit_sync` | forwarded to Unity; the current package answers "Not available yet" |

Do not work around a tool that is not available yet (for example by writing UXML or USS by hand). Tell the user.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `unity.bridge: "not-found"` | The project is not open in Unity, the package is not resolved yet, or the bridge is switched off in `Window > Design UI > Status`. |
| `unity.bridge: "not-responding"` | Unity is closed, crashed, or reloading scripts; wait and call `design_ui_list` again. |
| `unity.bridge: "unauthorized"` | Press Restart in `Window > Design UI > Status`, then retry. |
| `could not start Chromium` | Run `npx playwright install chromium` in the clone folder. |
| `design-ui.config.json not found` | Run `scripts/setup.sh` for that project, or check `--project` in the client's registration. |
| Unity cannot resolve the git URL | The clone's branch must exist on GitHub; or rerun setup with `--package local` (a `file:` path to this clone). |

## Manual setup (only if `setup.sh` cannot run)

```sh
cd <clone folder>
npm ci
npm run build -w design-ui-mcp
npx playwright install chromium
# start command any MCP client uses:
node <clone folder>/tools/design-ui-mcp/dist/server.js --project <Unity project>
```

Claude Code: `claude mcp add --scope local design-ui -- node <clone folder>/tools/design-ui-mcp/dist/server.js --project <Unity project>`.
The README lists the snippets for Cursor, Codex and Claude Desktop. `design-ui.config.json` needs `designRoot`,
`kitDir` (the clone's `design-kit` folder) and `profileAsset` (`Assets/DesignUi/DesignUiProfile.asset`).

## Updating

`git -C <clone folder> pull --ff-only`, then run `scripts/setup.sh` again with the same arguments (it rebuilds the
server when sources changed), and reload the client's MCP servers.
