#!/usr/bin/env bash
# unity-ui-mcp setup: builds the design-ui MCP server from this clone and connects it to one Unity project.
#
#   scripts/setup.sh --project <UnityProjectDir> [--client claude-code|codex|cursor|claude-desktop|none]
#                    [--client-dir <dir>] [--design-root <dir>] [--package git|local] [--dry-run] [--no-build]
#
# Idempotent: a second run changes nothing. --dry-run prints every change without making it.
# In the Unity project it only adds the com.unity.design-ui entry to Packages/manifest.json (when absent) and writes
# design-ui.config.json (when absent). It never commits or pushes anything. Bash only (macOS, Linux; on Windows use
# WSL or Git Bash, or the manual steps in INSTALL.md).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/setup.sh --project <UnityProjectDir> [options]

  --project <dir>       Unity project folder (holds Assets/ and Packages/manifest.json). Required.
  --client <name>       MCP client to connect: claude-code (default), codex, cursor, claude-desktop, none.
                        claude-code registers the server with `claude mcp add --scope local`; the others print the
                        configuration snippet to add.
  --client-dir <dir>    Folder you start Claude Code from (local scope belongs to that folder). Default: --project.
  --design-root <dir>   Where design screens live (one folder per screen), relative to the project or absolute.
                        Used only when design-ui.config.json is created. Default: Designs
  --package git|local   Unity package reference: git URL of this repository at its current branch (default), or a
                        file: path to this clone.
  --dry-run             Print what would change; change nothing.
  --no-build            Skip npm ci, the server build, the Chromium check and the final server check.
  -h, --help            Show this help.

Environment:
  CLAUDE_BIN            The claude CLI to use when `claude` is not on PATH (e.g. the CLI inside the Claude desktop app).
EOF
}

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_JS="$REPO/tools/design-ui-mcp/dist/server.js"
SMOKE_JS="$REPO/tools/design-ui-mcp/scripts/smoke.mjs"
PROJECT=""
CLIENT="claude-code"
CLIENT_DIR=""
DESIGN_ROOT="Designs"
PACKAGE="git"
DRY=0
BUILD=1

die() { echo "setup: $*" >&2; exit 2; }
need_value() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --project) need_value "$@"; PROJECT="$2"; shift 2 ;;
    --client) need_value "$@"; CLIENT="$2"; shift 2 ;;
    --client-dir) need_value "$@"; CLIENT_DIR="$2"; shift 2 ;;
    --design-root) need_value "$@"; DESIGN_ROOT="$2"; shift 2 ;;
    --package) need_value "$@"; PACKAGE="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "setup: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
done

CHANGES=()
change() { # change "<imperative description>": records and prints one change (or planned change)
  CHANGES+=("$1")
  if [ "$DRY" = 1 ]; then echo "  would $1"; else echo "  change: $1"; fi
}
info() { echo "  $*"; }
quoted() { # a command as one shell-quoted line that can be pasted into a shell
  local out="" a
  for a in "$@"; do out="$out$(printf '%q' "$a") "; done
  printf '%s' "${out% }"
}

[ -n "$PROJECT" ] || { usage >&2; die "--project is required"; }
[ -d "$PROJECT" ] || die "Unity project folder not found: $PROJECT"
PROJECT="$(cd "$PROJECT" && pwd)"
[ -d "$PROJECT/Assets" ] && [ -f "$PROJECT/Packages/manifest.json" ] || die "$PROJECT is not a Unity project (needs Assets/ and Packages/manifest.json)"
case "$CLIENT" in claude-code|codex|cursor|claude-desktop|none) ;; *) die "unknown --client $CLIENT" ;; esac
case "$PACKAGE" in git|local) ;; *) die "--package must be git or local" ;; esac
CLIENT_DIR="${CLIENT_DIR:-$PROJECT}"
[ -d "$CLIENT_DIR" ] || die "--client-dir not found: $CLIENT_DIR"
CLIENT_DIR="$(cd "$CLIENT_DIR" && pwd)"

[ "$DRY" = 1 ] && echo "Dry run: nothing is changed."
echo "unity-ui-mcp clone: $REPO"
echo "Unity project:      $PROJECT"

# 1. Node -------------------------------------------------------------------------------------------------------------
echo "[1/6] Node.js"
command -v node >/dev/null 2>&1 || die "Node.js 20 or later is required (https://nodejs.org)"
NODE="$(command -v node)"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20 or later is required (found $("$NODE" --version))"
info "node $("$NODE" --version) at $NODE"

# 2. MCP server -------------------------------------------------------------------------------------------------------
echo "[2/6] MCP server (tools/design-ui-mcp)"
if [ "$BUILD" = 1 ]; then
  command -v npm >/dev/null 2>&1 || die "npm is required"
  if [ ! -d "$REPO/node_modules" ] || [ "$REPO/package-lock.json" -nt "$REPO/node_modules/.package-lock.json" ]; then
    change "run npm ci in $REPO (installs node_modules from package-lock.json)"
    [ "$DRY" = 1 ] || (cd "$REPO" && npm ci --no-audit --no-fund)
  else
    info "node_modules up to date"
  fi
  if [ ! -f "$SERVER_JS" ] || [ -n "$(find "$REPO/tools/design-ui-mcp/src" "$REPO/tools/design-export/src" "$REPO/tools/design-ui-mcp/scripts/build.mjs" -newer "$SERVER_JS" -type f 2>/dev/null | head -1)" ]; then
    change "build $SERVER_JS"
    [ "$DRY" = 1 ] || (cd "$REPO" && npm run build -w design-ui-mcp)
  else
    info "server build up to date: $SERVER_JS"
  fi
  if [ -d "$REPO/node_modules/playwright" ] && (cd "$REPO" && "$NODE" -e 'import("playwright").then(p => p.chromium.launch()).then(b => b.close()).catch(() => process.exit(1))') >/dev/null 2>&1; then
    info "Chromium for Playwright ready"
  else
    change "download Chromium for Playwright (npx playwright install chromium, into the Playwright browser cache)"
    [ "$DRY" = 1 ] || (cd "$REPO" && npx playwright install chromium)
  fi
else
  info "skipped (--no-build)"
  [ -f "$SERVER_JS" ] || info "note: $SERVER_JS does not exist yet; run without --no-build"
fi

# 3. Unity package ----------------------------------------------------------------------------------------------------
echo "[3/6] Unity package com.unity.design-ui"
if [ "$PACKAGE" = local ]; then
  PKG_VALUE="file:$REPO/packages/com.unity.design-ui"
else
  ORIGIN="$(git -C "$REPO" remote get-url origin 2>/dev/null || true)"
  [ -n "$ORIGIN" ] || die "this clone has no origin remote; use --package local"
  case "$ORIGIN" in
    git@*:*) HOST="${ORIGIN#git@}"; ORIGIN="https://${HOST%%:*}/${HOST#*:}" ;;
    ssh://git@*) ORIGIN="https://${ORIGIN#ssh://git@}" ;;
  esac
  case "$ORIGIN" in *.git) ;; *) ORIGIN="$ORIGIN.git" ;; esac
  REV="$(git -C "$REPO" symbolic-ref --quiet --short HEAD 2>/dev/null || git -C "$REPO" rev-parse HEAD)"
  PKG_VALUE="$ORIGIN?path=/packages/com.unity.design-ui#$REV"
fi
MANIFEST_RESULT="$("$NODE" - "$PROJECT/Packages/manifest.json" "com.unity.design-ui" "$PKG_VALUE" "$DRY" <<'NODE'
const fs = require("fs");
const [file, name, value, dry] = process.argv.slice(2);
const fail = (msg) => { console.log(`FAIL ${msg}`); process.exit(0); };
const raw = fs.readFileSync(file, "utf8");
const bom = raw.startsWith("﻿") ? "﻿" : "";
const text = raw.slice(bom.length);
let json;
try { json = JSON.parse(text); } catch (e) { fail(`Packages/manifest.json is not valid JSON: ${e.message}`); }
if (!json || typeof json.dependencies !== "object" || json.dependencies === null || Array.isArray(json.dependencies)) {
  fail(`Packages/manifest.json has no top-level "dependencies" object`);
}
if (Object.prototype.hasOwnProperty.call(json.dependencies, name)) {
  console.log(`KEEP kept existing entry "${name}": ${JSON.stringify(json.dependencies[name])}`);
  process.exit(0);
}
// insert one line right after the top-level `"dependencies": {`, keeping the rest of the file byte for byte; a key
// of the same name nested earlier (e.g. inside a registry entry) is skipped by the check below
const eol = text.includes("\r\n") ? "\r\n" : "\n";
let out = null;
for (const m of text.matchAll(/"dependencies"\s*:\s*\{/g)) {
  const at = m.index + m[0].length;
  const rest = text.slice(at);
  const indent = (/^\r?\n([ \t]+)\S/.exec(rest) || [null, "    "])[1];
  const empty = /^\s*\}/.test(rest);
  const line = `${eol}${indent}${JSON.stringify(name)}: ${JSON.stringify(value)}${empty ? "" : ","}`;
  const candidate = text.slice(0, at) + line + (empty ? eol + rest.replace(/^\s*/, "") : rest);
  let parsed;
  try { parsed = JSON.parse(candidate); } catch { continue; }
  if (parsed.dependencies && parsed.dependencies[name] === value) { out = candidate; break; }
}
if (out === null) fail(`could not add "${name}" to the top-level "dependencies" of Packages/manifest.json`);
if (dry !== "1") fs.writeFileSync(file, bom + out);
console.log(`CHANGE add "${name}": ${JSON.stringify(value)} to Packages/manifest.json`);
NODE
)"
case "$MANIFEST_RESULT" in
  CHANGE*) change "${MANIFEST_RESULT#CHANGE }" ;;
  KEEP*) info "${MANIFEST_RESULT#KEEP }" ;;
  FAIL*) die "${MANIFEST_RESULT#FAIL }" ;;
  *) die "unexpected manifest result: $MANIFEST_RESULT" ;;
esac
if [ "$PACKAGE" = git ] && [ "${DESIGN_UI_SETUP_OFFLINE:-0}" != 1 ] && ! git -C "$REPO" ls-remote --exit-code origin "$REV" >/dev/null 2>&1 && ! git -C "$REPO" ls-remote --exit-code origin "refs/heads/$REV" >/dev/null 2>&1; then
  info "warning: $REV was not found on origin; Unity can resolve the git URL only after it is pushed (or use --package local)"
fi

# 4. design-ui.config.json --------------------------------------------------------------------------------------------
echo "[4/6] design-ui.config.json"
CONFIG="$PROJECT/design-ui.config.json"
if [ -f "$CONFIG" ]; then
  info "kept existing $CONFIG"
else
  change "write $CONFIG (designRoot $DESIGN_ROOT, kitDir $REPO/design-kit, Unity runner: editor bridge)"
  if [ "$DRY" != 1 ]; then
    "$NODE" - "$CONFIG" "$DESIGN_ROOT" "$REPO/design-kit" <<'NODE'
const fs = require("fs");
const [file, designRoot, kitDir] = process.argv.slice(2);
const cfg = {
  designRoot,
  kitDir,
  profileAsset: "Assets/DesignUi/DesignUiProfile.asset",
  unityRunner: { prefer: "editor", captureVia: "command", command: { import: [], capture: [], kitSync: [] } },
};
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { flag: "wx" });
NODE
  fi
fi

# 5. MCP client -------------------------------------------------------------------------------------------------------
echo "[5/6] MCP client: $CLIENT"
snippet() { # snippet json|toml: the client configuration, built by node so every value is escaped
  "$NODE" - "$1" "$NODE" "$SERVER_JS" "$PROJECT" <<'NODE'
const [kind, command, server, project] = process.argv.slice(2);
const args = [server, "--project", project];
if (kind === "toml") {
  // TOML basic strings use the same escapes as JSON strings
  console.log(`[mcp_servers.design-ui]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}`);
} else {
  console.log(JSON.stringify({ mcpServers: { "design-ui": { command, args } } }, null, 2));
}
NODE
}
ADD_CMD=(mcp add --scope local design-ui -- "$NODE" "$SERVER_JS" --project "$PROJECT")
case "$CLIENT" in
  none) info "skipped" ;;
  codex)
    info "add this to ~/.codex/config.toml (automatic registration for Codex arrives with the skill installer):"
    snippet toml
    ;;
  cursor)
    info "add this to $CLIENT_DIR/.cursor/mcp.json (or ~/.cursor/mcp.json):"
    snippet json
    ;;
  claude-desktop)
    info "add this to claude_desktop_config.json (Claude Desktop > Settings > Developer > Edit Config):"
    snippet json
    ;;
  claude-code)
    CLAUDE="${CLAUDE_BIN:-}"
    [ -n "$CLAUDE" ] || CLAUDE="$(command -v claude 2>/dev/null || true)"
    if [ -n "$CLAUDE" ] && [ ! -x "$CLAUDE" ]; then die "CLAUDE_BIN is not an executable file: $CLAUDE"; fi
    if [ -z "$CLAUDE" ]; then
      info "claude CLI: not found on PATH (set CLAUDE_BIN to use another one); nothing was registered."
      info "Run this in $CLIENT_DIR:"
      echo "    cd $(quoted "$CLIENT_DIR") && $(quoted claude "${ADD_CMD[@]}")"
      if [ "$(uname)" = Darwin ]; then
        BUNDLED="$(ls -t "$HOME"/Library/Application\ Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude 2>/dev/null | head -1 || true)"
        [ -z "$BUNDLED" ] || info "The Claude desktop app has a CLI at $BUNDLED; to let setup use it, rerun with CLAUDE_BIN=$(quoted "$BUNDLED")"
      fi
    else
      info "claude CLI: $CLAUDE"
      REGISTERED=0
      EXISTING="$(cd "$CLIENT_DIR" && "$CLAUDE" mcp get design-ui 2>&1)" && REGISTERED=1 || true
      if [ "$REGISTERED" = 1 ] && printf '%s' "$EXISTING" | grep -qF -- "$SERVER_JS" && printf '%s' "$EXISTING" | grep -qF -- "$PROJECT"; then
        info "already registered in $CLIENT_DIR"
      else
        if [ "$REGISTERED" = 1 ]; then
          change "replace the design-ui MCP server registered for $CLIENT_DIR (it points elsewhere): $(quoted "$CLAUDE" mcp remove --scope local design-ui)"
          [ "$DRY" = 1 ] || (cd "$CLIENT_DIR" && "$CLAUDE" mcp remove --scope local design-ui >/dev/null)
        fi
        change "register MCP server design-ui for Claude Code in $CLIENT_DIR: $(quoted "$CLAUDE" "${ADD_CMD[@]}")"
        if [ "$DRY" != 1 ]; then
          (cd "$CLIENT_DIR" && "$CLAUDE" "${ADD_CMD[@]}")
          STATUS="$(cd "$CLIENT_DIR" && "$CLAUDE" mcp get design-ui 2>&1 | grep -i 'status' | head -1 || true)"
          [ -z "$STATUS" ] || info "claude mcp get design-ui: $STATUS"
        fi
      fi
    fi
    ;;
esac

# 6. Server check -----------------------------------------------------------------------------------------------------
echo "[6/6] Server check (stdio: initialize, tools/list, design_ui_list)"
if [ "$DRY" = 1 ] || [ "$BUILD" = 0 ]; then
  info "skipped$([ "$DRY" = 1 ] && echo " (dry run)" || echo " (--no-build)"); run it later with:"
  echo "    $(quoted "$NODE" "$SMOKE_JS" --project "$PROJECT")"
elif "$NODE" "$SMOKE_JS" --project "$PROJECT" 2>&1 | sed 's/^/    /'; then
  info "server answers"
else
  die "the server check failed (output above)"
fi

echo
if [ "${#CHANGES[@]}" -eq 0 ]; then
  echo "Nothing to change: everything is already set up."
elif [ "$DRY" = 1 ]; then
  echo "${#CHANGES[@]} change(s) planned. Run again without --dry-run to apply them."
else
  echo "${#CHANGES[@]} change(s) made."
fi
echo "Next: open the project in Unity (the package's bridge starts by itself), start a NEW session of your MCP client"
echo "(the server is not visible in sessions that were already running), and call design_ui_list there:"
echo "unity.bridge should be \"connected\"."
