# Installing unity-ui-mcp (instructions for AI agents)

You are an AI agent asked to install this repository for a user's Unity project. Follow these steps in order. Do not
improvise other install routes, do not edit files in the user's Unity project by hand, and never commit or push
anything (in this repository or in the user's project).

What gets installed:

- **MCP server `design-ui`** (`tools/design-ui-mcp`): a local stdio server that any MCP client starts. It is built
  from this clone; it is not published on npm.
- **Unity package `com.ertugrulgaziakcan.design-ui`**: one entry in the project's `Packages/manifest.json`. It adds an
  Editor bridge (loopback only, token in `Library/DesignUi/bridge.json`) that the server talks to, and the
  `Window > Design UI > Status` window.
- **`design-ui.config.json`** in the Unity project: where designs live (`designRoot`), the design kit (`kitDir`), the
  profile asset path (`profileAsset`), the server path for the window's client snippets (`mcpServer`) and the Unity
  runner (`unityRunner`).
- **The `/unity-ui-mcp` skill**, linked into the skill folders of Claude Code, Codex and Cursor that exist.

Platforms: `scripts/setup.sh` is a bash script (macOS, Linux). On Windows run it from WSL or Git Bash, or follow
"Manual setup" below.

## 1. Ask the user

Ask these questions in one message and wait for the answers:

1. The **Unity project folder** (the folder that contains `Assets/` and `Packages/`). Unity 6000.3 or later.
2. The **design folder** (`designRoot`): where design screens will live, one folder per screen. Relative to the Unity
   project or absolute. Suggest `Designs` (outside `Assets/`, so Unity does not import the HTML), or a folder outside
   the project if the user keeps designs out of the game's repository.
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

Options (`scripts/setup.sh --help` prints them):

| Option | Meaning |
|---|---|
| `--project <dir>` | The Unity project (holds `Assets/` and `Packages/manifest.json`). Required. |
| `--client <name>` | `claude-code` (default: `claude mcp add --scope local`), `codex` (one `[mcp_servers.design-ui]` table in `~/.codex/config.toml`), `cursor` (merged into `<--client-dir>/.cursor/mcp.json`, or `~/.cursor/mcp.json` without `--client-dir`), `all` (those three; Codex and Cursor are skipped when their config folder does not exist), `claude-desktop` (prints the snippet to add), `none`. |
| `--client-dir <dir>` | The folder the client starts from (Claude Code's local scope, Cursor's project config). Default: `--project`. |
| `--design-root <dir>` | `designRoot` for a new `design-ui.config.json`, relative to the project or absolute. Default `Designs`. |
| `--package git\|local` | The Unity package reference: this repository's git URL at the clone's current branch (default), or a `file:` path to this clone (for unpushed changes; it works only on this machine). |
| `--dry-run` | Print every change; change nothing. |
| `--no-build` | Skip `npm ci`, the server build, the Chromium check and the final server check. |
| `CLAUDE_BIN=<path>` | Environment variable: the `claude` CLI to use when it is not on `PATH`. |

Client config files keep everything else: only `command` and `args` of the `design-ui` entry are set (other keys you
added stay), a copy of the file is kept once as `<file>.design-ui.bak`, and when the file already has a `design-ui`
entry for another project this project gets `design-ui-<project folder>`. Setup also links the skill
(`scripts/install-skill.sh [--dry-run]` does only that; it replaces only its own link).

Show the user the complete dry-run output. It lists every change (`would …` lines): `npm ci` and the server build
inside the clone, the Chromium download for Playwright (once per machine), the one line added to
`Packages/manifest.json` (only if the package is not there yet), `design-ui.config.json` (only if absent) and the MCP
registration for the chosen clients, and the skill links, with the exact, shell-quoted commands. Ask for a clear yes
before continuing.

Tell the user two things with the dry run:

- `design-ui.config.json` contains paths of this machine (the clone's server and capture script, and the design
  folder). Setup also copies the clone's `design-kit` into `<designRoot>/design-kit`, the project's own kit (kit sync
  writes the project's fonts into it, never into the clone). Whether to commit them to their project's repository is
  their decision; you never commit or push them.
- The config's `unityRunner.command` templates run as programs on this machine when import, verify or kit sync use
  the command route. Only use Unity projects whose `design-ui.config.json` they trust.

The config setup writes:

```json
{
  "designRoot": "<design folder>",
  "kitDir": "<design folder>/design-kit",
  "profileAsset": "Assets/DesignUi/DesignUiProfile.asset",
  "mcpServer": "<clone folder>/tools/design-ui-mcp/dist/server.js",
  "unityRunner": { "prefer": "editor", "captureVia": "command",
                   "command": { "import": [], "capture": ["<clone folder>/scripts/capture-on-copy.sh", "{projectDir}"], "kitSync": [] } }
}
```

An existing project kit is kept as it is too; setup prints the command that brings it to the clone's kit version
(`npx design-export kit upgrade <kitDir> --dry-run`, then without `--dry-run`: the clone's base, rules, components, text
styles and config keys; the project's fonts, own and changed tokens, locales, own keys and extra viewports stay; the
changed files are backed up into `<kitDir>/.backup/`). Show the dry run to the user and run it after a clear yes.
An existing `design-ui.config.json` is kept as it is; when it has no `mcpServer`, setup prints the line to add (the
Design UI window's client snippets need it), and when its `kitDir` is the clone's `design-kit`, setup prints how to copy
the kit into the project and what to set (kit sync refuses to write into the clone). Setup never adds `"testables"` to
the project's manifest: only the temporary copy a capture runs on lists the package's tests. A `"testables"` entry of the
package's id before 0.1.0 (`com.unity.design-ui`) is removed, not renamed; `--dry-run` shows the same plan.

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

Then tell the user what is left on the Unity side. These are their steps in the Unity Editor; do not do them for them:

1. **Open (or focus) the project in Unity.** Unity resolves the package and the bridge starts by itself.
   `Window > Design UI > Status` shows the bridge, the project setup and copy-ready client snippets.
2. **Create the profile:** in that window press **Create Profile**. It creates the `DesignUiProfile` at the config's
   `profileAsset` (`Assets/DesignUi/DesignUiProfile.asset`) with the config's folders. Imports and kit syncs fail with
   "No DesignUiProfile at …" until it exists. The profile holds every project setting: output folders and the generated
   namespace, viewports, locales, fonts, localization, right-to-left rules, text sizes and how screens sit in a uGUI
   shell.
3. **Fonts:** by default each locale renders with TMP Settings' default font and its fallbacks. A project with its own
   per-locale font mapping fills the profile's **Locale Fonts**, or (better, one source of truth) writes a small
   `DesignUiFontResolver` subclass in one of its Editor assemblies that asks its own font system, creates an asset of
   it and sets it as the profile's **Font Resolver**.
4. **The kit:** kit sync writes the project's fonts and font tokens into `kitDir`, the project's own copy of the kit
   in `<designRoot>/design-kit` (the clone stays clean, so `git pull` keeps working). Run a kit sync: ask for
   `design_ui_kit_sync` in the new chat, or `Window > Design UI > Kit Sync`.
5. **Right-to-left or complex-script locales** (Arabic and others) need **Project Settings > UI Toolkit > Enable
   Advanced Text**, switched on before Play, and ICU data on every PanelSettings a player uses
   (`docs/findings/advanced-text.md`). Without it those locales render left to right and unshaped, and the package says so.
6. **Localized screens** need Unity Localization 1.5 or later; the profile's localization settings name each screen's
   String Table collection. Creating a collection needs Addressables settings and a project without unsaved changes.
7. **Verification** renders on a temporary copy of the project, never in the open Editor: setup's capture command
   (`scripts/capture-on-copy.sh`) takes one capture slot per machine (`--slots`), checks the free disk (`--min-free-gb`),
   copies the project without the open Editor's process and lock files, captures there with the Unity Hub install of the
   project's version (or `UNITY_BIN`) and removes the copy (see "Verification captures" in `docs/guide/usage.md`). Disk use stays bounded
   by itself (`cacheBudgetMB`, `design_ui_clean`); nobody deletes the tools' files by hand.
8. **Start a new chat** of the MCP client in the client folder (Claude Code: a new session there; Cursor, Codex or
   Claude Desktop: restart after adding the snippet). The server is named `design-ui`. Typing `/unity-ui-mcp` (or
   describing the job, in English or Turkish) starts the skill's guided flow; `design_ui_list` should report
   `unity.bridge: "connected"`, and `design_ui_status` lists what is ready.

## What works in this version

| Tool | State |
|---|---|
| `design_ui_rules` | live: the design contract for any AI that writes the HTML (the kit's `RULES.md`: attributes, text styles, tokens, allowed CSS and every lint rule with its fix, with a section index; `section` returns one part, `json` the same as compact JSON) |
| `design_ui_list` | live: screens under `designRoot` with their state, and the Unity bridge state |
| `design_ui_lint` | live: lint in a headless Chromium with the kit fonts; folder, `.html`, `.dc.html` or `.zip` |
| `design_ui_status` | live: what this version supports and how each Unity step runs; per-screen hashes and history |
| `design_ui_import` | live when its Unity route works: export (lint, IR, goldens, assets, sample data), then the compile in the open Editor (its bridge must answer) or through `unityRunner.command.import` |
| `design_ui_verify` | live when `unityRunner.command.capture` is configured: Unity capture of every static job and animation sample on a project copy, comparison and report |
| `design_ui_kit_sync` | live when its Unity route works, like import: copies the project's fonts into the kit, writes the font tokens and checks the text styles; refuses to drop a viewport the kit declares and the profile lacks (`addProfileViewports: true` adds them, after the user agrees) |
| `design_ui_clean` | live: reports (`dryRun`) or runs the cleanup of the screens' bookkeeping that import and verify also run by themselves |

A tool whose route is not set up returns an error with the reason. Do not work around it (for example by writing UXML
or USS by hand). Tell the user.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `unity.bridge: "not-found"` | The project is not open in Unity, the package is not resolved yet, or the bridge is switched off in `Window > Design UI > Status`. |
| `unity.bridge: "not-responding"` | Unity is closed, crashed, or reloading scripts; wait and call `design_ui_list` again. |
| `unity.bridge: "unauthorized"` | Press Restart in `Window > Design UI > Status`, then retry. |
| `No DesignUiProfile at …` | Create the profile (`Window > Design UI > Status`, Create Profile). |
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
The README lists the snippets for Cursor, Codex and Claude Desktop. The Unity package is the git URL
`https://github.com/ErtugrulGaziAKCAN/unity-ui-mcp.git?path=/packages/com.ertugrulgaziakcan.design-ui`
(Package Manager → **+** → *Install package from git URL…*). `design-ui.config.json` needs `designRoot`, `kitDir`
(the kit folder) and `profileAsset` (`Assets/DesignUi/DesignUiProfile.asset`); add `mcpServer` (the server's
`dist/server.js`) for the window's snippets. The user writes these files; you show them.

## Updating

`git -C <clone folder> pull --ff-only`, then run `scripts/setup.sh` again with the same arguments (it rebuilds the
server when sources changed); new client sessions use the new server. Unity keeps the package commit it resolved in
`packages-lock.json`: to update the package, remove its entry there (or add the git URL again). A project set up before
0.1.0 lists the package under its old id (see CHANGELOG): setup replaces that entry with
`com.ertugrulgaziakcan.design-ui` and its new git URL path (the dry run shows the replacement first).
