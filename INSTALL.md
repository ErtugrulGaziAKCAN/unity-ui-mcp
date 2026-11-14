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

Platforms: `scripts/setup.sh` is a bash script (macOS, Linux). On Windows run it from WSL or Git Bash, or follow
"Manual setup" below.

## 1. Ask the user

Ask these questions in one message and wait for the answers:

1. The **Unity project folder** (the folder that contains `Assets/` and `Packages/`). Unity 6000.3 or later.
2. The **design folder** (`designRoot`): where design screens will live, one folder per screen. Relative to the Unity
   project or absolute. Suggest `Designs` (outside `Assets/`, so Unity does not import the HTML).
3. Which **MCP client** they use: Claude Code (default), Codex, Cursor, all three, or Claude Desktop.
4. For Claude Code: the **folder they start Claude Code from** for this work. The server is registered with local
   scope, which belongs to that folder. Suggest the Unity project folder.
5. Where to put this repository's clone, if they have no preference: `~/unity-ui-mcp`. Say that cloning (step 3)
   happens before the dry run: it only creates that folder. Their answer to this question is the consent for it.

## 2. Check the requirements

- `node --version` is 20 or later, and `npm` and `git` exist. If Node is missing or older, stop and ask the user to
  install Node.js 20+ (https://nodejs.org).

## 3. Clone

```sh
git clone https://github.com/ErtugrulGaziAKCAN/unity-ui-mcp.git <clone folder>
```

This creates only the clone folder; nothing else on the machine or in the Unity project changes before step 5.
If the clone already exists, tell the user it will be updated to the latest version of its branch, and with their
okay run `git -C <clone folder> pull --ff-only` (only if `git status` is clean; otherwise use it as it is and say so).

## 4. Dry run, then confirm

From the clone folder:

```sh
scripts/setup.sh --project "<Unity project>" --design-root "<design folder>" \
  --client claude-code --client-dir "<folder Claude Code runs from>" --dry-run
```

`--client` is `claude-code` (default), `codex`, `cursor`, `all` (those three), `claude-desktop` (prints the snippet to add)
or `none`. Codex gets one `[mcp_servers.design-ui]` table in `~/.codex/config.toml`; Cursor gets a merged
`.cursor/mcp.json` in the `--client-dir` folder (or `~/.cursor/mcp.json` when you pass none); the rest of both files stays
as it is: only `command` and `args` of the entry are set (other keys you added stay), a copy of the file is kept once as
`<file>.design-ui.bak`, and when the file already has a `design-ui` entry for another project this project gets
`design-ui-<project folder>`. With `--client all`, Codex and Cursor are skipped when their config folder does not exist.
Setup also links the `/unity-ui-mcp` skill into those of `~/.claude/skills`, `~/.codex/skills` and
`~/.cursor/skills` that exist (`scripts/install-skill.sh [--dry-run]` does only that; it replaces only its own link).

Show the user the complete dry-run output. It lists every change (`would …` lines): `npm ci` and the server build
inside the clone, the Chromium download for Playwright (once per machine), the one line added to
`Packages/manifest.json` (only if the package is not there yet), `design-ui.config.json` (only if absent) and the MCP
registration for the chosen clients, and the skill links, with the exact, shell-quoted commands. Ask for a clear yes before continuing.

Tell the user two things with the dry run:

- `design-ui.config.json` contains paths of this machine (the clone's `design-kit`, and later the design folder).
  Whether to commit it to their project's repository is their decision; you never commit or push it.
- The config's `unityRunner.command` templates run as programs on this machine when import, verify or kit sync use
  the command route. Only use Unity projects whose `design-ui.config.json` they trust.

## 5. Run it

The same command without `--dry-run`. It is idempotent: running it again changes nothing. It prints every change
and which `claude` CLI it uses. Its last step starts the built server once over stdio (initialize, tools/list,
design_ui_list) and fails if the server does not answer.

If `claude` is not on PATH, setup registers nothing and prints the exact, shell-quoted `cd … && claude mcp add …`
command; run it (or give it to the user). To let setup use a CLI that is not on PATH, rerun with
`CLAUDE_BIN=<path to claude>`; on macOS setup names the CLI inside the Claude desktop app if it finds one, but uses it
only when you pass it in `CLAUDE_BIN`.

## 6. Confirm, then hand over

A server registered now is **not** visible in the session you are running in: do not call `design_ui_*` tools here
and do not retry them. Check it out of band instead:

1. Claude Code: in the client folder, `claude mcp get design-ui` should show the server and a connected status.
2. Any client: `node <clone folder>/tools/design-ui-mcp/scripts/smoke.mjs --project "<Unity project>"` runs
   initialize, tools/list and design_ui_list over stdio and exits 0 when the server works (setup's last step already
   ran it; run it again after any manual registration).

Then tell the user:

1. Open (or focus) the Unity project in Unity. Unity resolves the new package and the bridge starts by itself
   (`Window > Design UI > Status` shows it).
2. Start a **new** session of the MCP client in the client folder (Claude Code: a new session there; Cursor, Codex or
   Claude Desktop: restart after adding the snippet). The server is named `design-ui`. Typing `/unity-ui-mcp` (or
   describing the job, in English or Turkish) starts the skill's guided flow: tools check, Unity bridge check, lint,
   import, verify.
3. In that session, ask for `design_ui_list`. With Unity open it reports `unity.bridge: "connected"`;
   `design_ui_status` lists what this version supports.

## What works in this version

| Tool | State |
|---|---|
| `design_ui_rules` | live: the design contract for any AI that writes the HTML (the kit's `RULES.md`: attributes, text styles, tokens, allowed CSS and every lint rule with its fix, with a section index; `section` returns one part, `json` the same as compact JSON) |
| `design_ui_list` | live: screens under `designRoot` and the Unity bridge state |
| `design_ui_lint` | live: real lint in a headless Chromium with the kit fonts; folder, `.html`, `.dc.html` or `.zip` |
| `design_ui_status` | live: what this version supports; per-screen hashes and history |
| `design_ui_import` | live when its Unity route works: export (lint, IR, goldens, assets, sample data), then the compile in the open Editor (its bridge must answer) or through `unityRunner.command.import` |
| `design_ui_verify` | live when `unityRunner.command.capture` is configured: Unity capture, comparison and report; animation samples are reported as not captured until the animation player lands, so screens with animations do not pass yet |
| `design_ui_kit_sync` | live when its Unity route works, like import: copies the project's fonts into the kit and checks the text styles |

Do not work around a tool that is not available yet (for example by writing UXML or USS by hand). Tell the user.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `unity.bridge: "not-found"` | The project is not open in Unity, the package is not resolved yet, or the bridge is switched off in `Window > Design UI > Status`. |
| `unity.bridge: "not-responding"` | Unity is closed, crashed, or reloading scripts; wait and call `design_ui_list` again. |
| `unity.bridge: "unauthorized"` | Press Restart in `Window > Design UI > Status`, then retry. |
| `could not start Chromium` | Run `npx playwright install chromium` in the clone folder. |
| `design-ui.config.json not found` | Run `scripts/setup.sh` for that project, or check `--project` in the client's registration. |
| `design_ui_*` tools missing in the session | The session started before the registration: start a new one in the client folder. |
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

The skill alone: `scripts/install-skill.sh`. Claude Code: `claude mcp add --scope local design-ui -- node <clone folder>/tools/design-ui-mcp/dist/server.js --project <Unity project>`
(quote paths that contain spaces). Check it with `node <clone folder>/tools/design-ui-mcp/scripts/smoke.mjs --project <Unity project>`.
The README lists the snippets for Cursor, Codex and Claude Desktop. `design-ui.config.json` needs `designRoot`,
`kitDir` (the clone's `design-kit` folder) and `profileAsset` (`Assets/DesignUi/DesignUiProfile.asset`).

## Updating

`git -C <clone folder> pull --ff-only`, then run `scripts/setup.sh` again with the same arguments (it rebuilds the
server when sources changed); new client sessions use the new server.
