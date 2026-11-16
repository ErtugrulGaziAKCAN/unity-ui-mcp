#!/usr/bin/env bash
# unity-ui-mcp setup: builds the design-ui MCP server from this clone and connects it to one Unity project.
#
#   scripts/setup.sh --project <UnityProjectDir> [--client claude-code|codex|cursor|claude-desktop|all|none]
#                    [--client-dir <dir>] [--design-root <dir>] [--package git|local] [--dry-run] [--no-build]
#
# Idempotent: a second run changes nothing. --dry-run prints every change without making it.
# It also links the /unity-ui-mcp skill (scripts/install-skill.sh) and edits the chosen clients' MCP config.
# In the Unity project it only adds the com.ertugrulgaziakcan.design-ui entry to Packages/manifest.json (when absent;
# an entry under the package's id before 0.1.0 is replaced by it; it never adds "testables" and removes the old id from
# them: captures list the package's tests in their temporary project copy only), and writes
# design-ui.config.json with a copy of the design kit in <designRoot>/design-kit (both when absent). It never commits or
# pushes anything. Bash only (macOS, Linux; on Windows use WSL or Git Bash, or the manual steps in
# INSTALL.md).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/setup.sh --project <UnityProjectDir> [options]

  --project <dir>       Unity project folder (holds Assets/ and Packages/manifest.json). Required.
  --client <name>       MCP client to connect: claude-code (default), codex, cursor, all (these three),
                        claude-desktop (prints the snippet), none. claude-code runs `claude mcp add --scope local`;
                        codex adds one [mcp_servers.design-ui] table to ~/.codex/config.toml; cursor merges
                        design-ui into <--client-dir>/.cursor/mcp.json (or ~/.cursor/mcp.json without --client-dir).
                        The skill is linked into those of ~/.claude/skills, ~/.codex/skills, ~/.cursor/skills that exist.
  --client-dir <dir>    Folder you start the client from (Claude Code local scope belongs to that folder; Cursor project
                        config). Default: --project for Claude Code, ~/.cursor for Cursor.
  --design-root <dir>   Where design screens live (one folder per screen), relative to the project or absolute.
                        Used only when design-ui.config.json is created. Default: Designs
  --package git|local   Unity package reference: git URL of this repository at its tag or commit (default), or a
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
CLIENT_DIR_GIVEN=""
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
    --client-dir) need_value "$@"; CLIENT_DIR="$2"; CLIENT_DIR_GIVEN=1; shift 2 ;;
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
case "$CLIENT" in claude-code|codex|cursor|claude-desktop|all|none) ;; *) die "unknown --client $CLIENT" ;; esac
case "$PACKAGE" in git|local) ;; *) die "--package must be git or local" ;; esac
CLIENT_DIR="${CLIENT_DIR:-$PROJECT}"
[ -d "$CLIENT_DIR" ] || die "--client-dir not found: $CLIENT_DIR"
CLIENT_DIR="$(cd "$CLIENT_DIR" && pwd)"

case "$CLIENT" in
  all) CLIENTS=(claude-code codex cursor) ;;
  *) CLIENTS=("$CLIENT") ;;
esac

[ "$DRY" = 1 ] && echo "Dry run: nothing is changed."
echo "unity-ui-mcp clone: $REPO"
echo "Unity project:      $PROJECT"

# 1. Node -------------------------------------------------------------------------------------------------------------
echo "[1/7] Node.js"
command -v node >/dev/null 2>&1 || die "Node.js 20 or later is required (https://nodejs.org)"
NODE="$(command -v node)"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20 or later is required (found $("$NODE" --version))"
info "node $("$NODE" --version) at $NODE"

# 2. MCP server -------------------------------------------------------------------------------------------------------
echo "[2/7] MCP server (tools/design-ui-mcp)"
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

# client_file codex|cursor: the config file setup edits for that client
client_file() {
  case "$1" in
    codex) echo "$HOME/.codex/config.toml" ;;
    cursor) if [ -n "$CLIENT_DIR_GIVEN" ]; then echo "$CLIENT_DIR/.cursor/mcp.json"; else echo "$HOME/.cursor/mcp.json"; fi ;;
  esac
}
# client_skipped <client>: with --client all, a client whose config folder does not exist is skipped (not installed)
client_skipped() {
  [ "$CLIENT" = all ] || return 1
  case "$1" in
    codex|cursor) [ -d "$(dirname "$(client_file "$1")")" ] || return 0 ;;
  esac
  return 1
}
# Pre-pass: check the client config files before anything is written, so a bad file cannot leave a half-applied setup
for c in "${CLIENTS[@]}"; do
  case "$c" in codex|cursor) ;; *) continue ;; esac
  client_skipped "$c" && continue
  CHECK="$("$NODE" "$REPO/scripts/client-config.cjs" "$([ "$c" = codex ] && echo toml || echo json)" "$(client_file "$c")" "$NODE" "$SERVER_JS" "$PROJECT" 1)"
  case "$CHECK" in
    FAIL*) printf 'setup: %s\nsetup: no Unity project file and no client config was changed.\n' "${CHECK#FAIL }" >&2; exit 2 ;;
  esac
done

# 3. Unity package ----------------------------------------------------------------------------------------------------
PKG_NAME="com.ertugrulgaziakcan.design-ui"
# the package's id before 0.1.0: an existing project's entry under it is replaced (the git URL path changed with it)
PKG_OLD_NAME="com.unity.design-ui"
echo "[3/7] Unity package $PKG_NAME"
REV="" REV_KIND=""
if [ "$PACKAGE" = git ]; then
  ORIGIN="$(git -C "$REPO" remote get-url origin 2>/dev/null || true)"
  [ -n "$ORIGIN" ] || die "this clone has no origin remote; use --package local"
  # a clone of a local clone: Unity resolves only a remote git URL, so a local origin means this clone itself
  case "$ORIGIN" in
    file://*) LOCAL_ORIGIN=1 ;;
    *://*|*@*:*) LOCAL_ORIGIN=0 ;;
    *) LOCAL_ORIGIN=1 ;;
  esac
  if [ "$LOCAL_ORIGIN" = 1 ]; then
    info "origin is a local path ($ORIGIN), which Unity cannot resolve as a git URL: referencing this clone instead (as --package local)"
    PACKAGE=local
  fi
fi
if [ "$PACKAGE" = local ]; then
  PKG_VALUE="file:$REPO/packages/$PKG_NAME"
else
  case "$ORIGIN" in
    git@*:*) HOST="${ORIGIN#git@}"; ORIGIN="https://${HOST%%:*}/${HOST#*:}" ;;
    ssh://git@*) ORIGIN="https://${ORIGIN#ssh://git@}" ;;
  esac
  case "$ORIGIN" in *.git) ;; *) ORIGIN="$ORIGIN.git" ;; esac
  # pinned: the release tag HEAD is at, else HEAD's full commit; never a branch name (a branch moves, and a project that
  # resolved one fails once the branch is deleted or rewound)
  if REV="$(git -C "$REPO" describe --tags --exact-match HEAD 2>/dev/null)" && [ -n "$REV" ]; then REV_KIND=tag
  else REV="$(git -C "$REPO" rev-parse HEAD)"; REV_KIND=commit; fi
  PKG_VALUE="$ORIGIN?path=/packages/$PKG_NAME#$REV"
fi
MANIFEST_RESULT="$("$NODE" - "$PROJECT/Packages/manifest.json" "$PKG_NAME" "$PKG_VALUE" "$DRY" "$PKG_OLD_NAME" <<'NODE'
const fs = require("fs");
const [file, name, value, dry, oldName] = process.argv.slice(2);
const fail = (msg) => { console.log(`FAIL ${msg}`); process.exit(0); };
const raw = fs.readFileSync(file, "utf8");
const bom = raw.startsWith("﻿") ? "﻿" : "";
const text = raw.slice(bom.length);
let json;
try { json = JSON.parse(text); } catch (e) { fail(`Packages/manifest.json is not valid JSON: ${e.message}`); }
if (!json || typeof json.dependencies !== "object" || json.dependencies === null || Array.isArray(json.dependencies)) {
  fail(`Packages/manifest.json has no top-level "dependencies" object`);
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const results = [];
// every edit keeps the rest of the file byte for byte, and is taken only when the file then parses to what it should
let edited = text;
let current = json;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const without = (m) => { // removals of a match with the comma (and space) after it, before it, or alone
  const end = m.index + m[0].length;
  const after = /^\s*,\s*/.exec(edited.slice(end)), before = /,\s*$/.exec(edited.slice(0, m.index));
  return [...(after ? [[m.index, end + after[0].length, ""]] : []), ...(before ? [[m.index - before[0].length, end, ""]] : []), [m.index, end, ""]];
};
function edit(pattern, candidates, want) {
  for (const m of edited.matchAll(pattern)) {
    for (const [from, to, by] of candidates(m)) {
      const candidate = edited.slice(0, from) + by + edited.slice(to);
      let parsed;
      try { parsed = JSON.parse(candidate); } catch { continue; }
      if (same(parsed, want)) { edited = candidate; current = parsed; return true; }
    }
  }
  return false;
}
const hadName = has(json.dependencies, name);
// 1. the package id before 0.1.0: its entry becomes this one in place (or goes, when this one is listed too)
if (has(json.dependencies, oldName)) {
  const old = JSON.stringify(json.dependencies[oldName]);
  const deps = {};
  for (const [k, v] of Object.entries(json.dependencies)) {
    if (k === oldName) { if (!hadName) deps[name] = value; } else deps[k] = v;
  }
  const pair = new RegExp(`"${esc(oldName)}"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`, "g");
  const replaced = edit(pair, (m) => hadName ? without(m) : [[m.index, m.index + m[0].length, `${JSON.stringify(name)}: ${JSON.stringify(value)}`]], { ...json, dependencies: deps });
  if (!replaced) fail(`could not replace the old package id "${oldName}" in Packages/manifest.json; replace that entry by hand with "${name}": ${JSON.stringify(value)}`);
  results.push(hadName
    ? `CHANGE remove the old package id "${oldName}": ${old} from Packages/manifest.json (it lists "${name}" too)`
    : `CHANGE replace the old package id "${oldName}": ${old} with "${name}": ${JSON.stringify(value)} in Packages/manifest.json`);
}
// 2. the old id in "testables": removed, never renamed. The project manifest does not list the package tests (they
// would compile into the game test assemblies); a capture lists them in its temporary copy of the project only.
for (let i = Array.isArray(current.testables) ? current.testables.indexOf(oldName) : -1; i >= 0; i = current.testables.indexOf(oldName)) {
  const testables = current.testables.filter((t, k) => k !== i);
  const token = new RegExp(`"${esc(oldName)}"`, "g");
  if (!edit(token, without, { ...current, testables })) {
    fail(`could not remove the old package id "${oldName}" from the "testables" of Packages/manifest.json; remove it by hand`);
  }
  results.push(`CHANGE remove "${oldName}" from the "testables" of Packages/manifest.json (the package tests are listed only in the temporary copy a capture makes)`);
}
// an earlier setup renamed the old id in "testables": left alone (it may be wanted), but said
if (Array.isArray(current.testables) && current.testables.includes(name)) {
  results.push(`NOTE Packages/manifest.json lists "${name}" in "testables": the package tests then run in this project and switch its settings; remove that entry unless you want them (captures list them in their temporary copy)`);
}
if (hadName) {
  results.push(`KEEP kept existing entry "${name}": ${JSON.stringify(json.dependencies[name])}`);
} else if (!has(current.dependencies, name)) {
  // insert one line right after the top-level `"dependencies": {`; a key of the same name nested earlier (e.g. inside
  // a registry entry) is skipped by the check below
  const eol = edited.includes("\r\n") ? "\r\n" : "\n";
  let out = null;
  for (const m of edited.matchAll(/"dependencies"\s*:\s*\{/g)) {
    const at = m.index + m[0].length;
    const rest = edited.slice(at);
    const indent = (/^\r?\n([ \t]+)\S/.exec(rest) || [null, "    "])[1];
    const empty = /^\s*\}/.test(rest);
    const line = `${eol}${indent}${JSON.stringify(name)}: ${JSON.stringify(value)}${empty ? "" : ","}`;
    const candidate = edited.slice(0, at) + line + (empty ? eol + rest.replace(/^\s*/, "") : rest);
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (parsed.dependencies && parsed.dependencies[name] === value) { out = candidate; break; }
  }
  if (out === null) fail(`could not add "${name}" to the top-level "dependencies" of Packages/manifest.json`);
  edited = out;
  results.push(`CHANGE add "${name}": ${JSON.stringify(value)} to Packages/manifest.json`);
}
if (dry !== "1" && edited !== text) fs.writeFileSync(file, bom + edited);
console.log(results.join("\n"));
NODE
)"
while IFS= read -r MANIFEST_LINE; do
  case "$MANIFEST_LINE" in
    CHANGE*) change "${MANIFEST_LINE#CHANGE }" ;;
    KEEP*) info "${MANIFEST_LINE#KEEP }" ;;
    NOTE*) info "note: ${MANIFEST_LINE#NOTE }" ;;
    FAIL*) die "${MANIFEST_LINE#FAIL }" ;;
    *) die "unexpected manifest result: $MANIFEST_RESULT" ;;
  esac
done <<<"$MANIFEST_RESULT"
if [ -d "$PROJECT/Packages/$PKG_OLD_NAME" ]; then
  info "warning: Packages/$PKG_OLD_NAME is an embedded copy of the package under its id before 0.1.0; remove it (the package is $PKG_NAME now)"
fi
# the pinned revision must be on GitHub: a tag there, or a commit a pushed branch holds (as of the last fetch)
if [ "$PACKAGE" = git ] && [ "${DESIGN_UI_SETUP_OFFLINE:-0}" != 1 ]; then
  if [ "$REV_KIND" = tag ]; then git -C "$REPO" ls-remote --exit-code origin "refs/tags/$REV" >/dev/null 2>&1 && PUSHED=1 || PUSHED=0
  else git -C "$REPO" branch -r --contains "$REV" 2>/dev/null | grep -q '^ *origin/' && PUSHED=1 || PUSHED=0; fi
  [ "$PUSHED" = 1 ] || info "warning: $REV_KIND $REV was not found on origin; Unity can resolve the git URL only after it is pushed (or use --package local)"
fi
# the pinned revision is the package as committed, while the server is built from this working tree: uncommitted changes of
# their sources would make the two different builds of one version
if [ "$PACKAGE" = git ]; then
  DIRTY="$(git -C "$REPO" status --porcelain --untracked-files=no -- packages tools 2>/dev/null | grep -c . || true)"
  if [ "${DIRTY:-0}" -gt 0 ]; then
    info "warning: this clone has $DIRTY uncommitted change$([ "$DIRTY" = 1 ] || echo s) under packages/ or tools/: Unity resolves $REV_KIND $REV as committed, while the server is built from the working tree; commit them, or run setup with --package local"
  fi
fi

# 4. design-ui.config.json --------------------------------------------------------------------------------------------
# The design kit is the project's own copy, in <designRoot>/design-kit: kit sync writes the project's fonts and tokens
# into it, never into this clone (whose design-kit is tracked, so a sync would make `git pull` fail and put a project's
# fonts into a public checkout). Verification captures run scripts/capture-on-copy.sh: a temporary copy of the project,
# removed afterwards, the only place that lists the package's tests.
# upgrade_hint <kitDir>: setup keeps a project's existing kit; this says how to bring it to this clone's kit version
upgrade_hint() {
  info "the project's design kit $1 is kept as it is; to bring it to this clone's kit (text styles, rules, components,"
  info "viewports; the project's fonts, tokens, locales and own parts stay; changed files are backed up into its .backup/):"
  info "  $(quoted cd "$REPO") && $(quoted npx design-export kit upgrade "$1" --dry-run)   # then without --dry-run"
}
echo "[4/7] design-ui.config.json"
CONFIG="$PROJECT/design-ui.config.json"
CAPTURE="$REPO/scripts/capture-on-copy.sh"
case "$DESIGN_ROOT" in /*) DESIGN_ABS="$DESIGN_ROOT" ;; *) DESIGN_ABS="$PROJECT/$DESIGN_ROOT" ;; esac
KIT_ABS="$DESIGN_ABS/design-kit"
KIT_REL="${DESIGN_ROOT%/}/design-kit"
if [ -f "$CONFIG" ]; then
  info "kept existing $CONFIG"
  # mcpServer: the server path the Design UI window (Window > Design UI > Status) puts into its client snippets
  HAS_SERVER="$("$NODE" -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(typeof c.mcpServer === "string" ? "1" : "0") } catch { process.stdout.write("1") }' "$CONFIG")"
  [ "$HAS_SERVER" = 1 ] || info "$CONFIG has no \"mcpServer\" (the Design UI window's client snippets need it): add \"mcpServer\": $("$NODE" -p 'JSON.stringify(process.argv[1])' "$SERVER_JS")"
  # a config of an earlier setup points kitDir at this clone's kit: say how to move it (setup never edits an existing config)
  CFG_KIT="$("$NODE" -e 'try { const p = require("path"), c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const d = p.dirname(process.argv[1]); process.stdout.write(typeof c.kitDir === "string" ? p.resolve(d, c.kitDir) : "") } catch {}' "$CONFIG")"
  CFG_DESIGN="$("$NODE" -e 'try { const p = require("path"), c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(typeof c.designRoot === "string" ? p.resolve(p.dirname(process.argv[1]), c.designRoot) : "") } catch {}' "$CONFIG")"
  if [ -n "$CFG_KIT" ] && [ "$CFG_KIT" != "$REPO/design-kit" ] && [ -f "$CFG_KIT/kit.config.json" ]; then
    upgrade_hint "$CFG_KIT"
  fi
  if [ -n "$CFG_KIT" ] && [ "$CFG_KIT" = "$REPO/design-kit" ]; then
    MOVE_TO="${CFG_DESIGN:-$DESIGN_ABS}/design-kit"
    info "warning: kitDir is this clone's design-kit ($REPO/design-kit): kit sync would write the project's fonts into the clone. Copy it into the project and point kitDir there:"
    info "  $(quoted mkdir -p "$(dirname "$MOVE_TO")") && $(quoted cp -R "$REPO/design-kit" "$MOVE_TO") && $(quoted rm -rf "$MOVE_TO/fixtures")"
    info "  then set \"kitDir\": $("$NODE" -p 'JSON.stringify(process.argv[1])' "$MOVE_TO") in $CONFIG"
  fi
else
  if [ -e "$KIT_ABS" ]; then
    info "kept existing design kit $KIT_ABS"
    [ ! -f "$KIT_ABS/kit.config.json" ] || upgrade_hint "$KIT_ABS"
  else
    change "copy the design kit $REPO/design-kit into $KIT_ABS (the project's own kit: kit sync writes into it)"
    if [ "$DRY" != 1 ]; then
      mkdir -p "$(dirname "$KIT_ABS")"
      KIT_TMP="$(mktemp -d "$(dirname "$KIT_ABS")/.design-kit.XXXXXX")"
      (cd "$REPO/design-kit" && tar cf - --exclude ./fixtures .) | (cd "$KIT_TMP" && tar xf -)
      # the clone's configuration the kit was copied from: kit upgrade tells a list the project narrowed or grew by it
      cp "$REPO/design-kit/kit.config.json" "$KIT_TMP/.kit-base.json"
      mv "$KIT_TMP" "$KIT_ABS"
    fi
  fi
  case "$DESIGN_ROOT" in /*) KIT_VALUE="$KIT_ABS" ;; *) KIT_VALUE="$KIT_REL" ;; esac
  change "write $CONFIG (designRoot $DESIGN_ROOT, kitDir $KIT_VALUE, mcpServer $SERVER_JS, Unity runner: editor bridge, captures on a temporary project copy)"
  if [ "$DRY" != 1 ]; then
    "$NODE" - "$CONFIG" "$DESIGN_ROOT" "$KIT_VALUE" "$SERVER_JS" "$CAPTURE" <<'NODE'
const fs = require("fs");
const [file, designRoot, kitDir, mcpServer, capture] = process.argv.slice(2);
const cfg = {
  designRoot,
  kitDir,
  profileAsset: "Assets/DesignUi/DesignUiProfile.asset",
  mcpServer,
  unityRunner: { prefer: "editor", captureVia: "command", command: { import: [], capture: [capture, "{projectDir}"], kitSync: [] } },
};
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { flag: "wx" });
NODE
  fi
fi

# 5. MCP client(s) ---------------------------------------------------------------------------------------------------
echo "[5/7] MCP client: ${CLIENTS[*]}"
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
# edit_client_config toml|json <file>: adds or updates the design-ui entry (command and args only) in a client config file
edit_client_config() {
  local kind="$1" file="$2" result first rest
  result="$("$NODE" "$REPO/scripts/client-config.cjs" "$kind" "$file" "$NODE" "$SERVER_JS" "$PROJECT" "$DRY")"
  first="${result%%$'\n'*}"
  rest=""; [ "$first" = "$result" ] || rest="${result#*$'\n'}"
  case "$first" in
    KEEP*) info "MCP server ${first#KEEP } is already registered for $PROJECT in $file" ;;
    UNCHECKED) info "$file: not checked in a dry run before npm ci has installed the dependencies" ;;
    CHANGE*)
      local action name
      action="$(echo "$first" | cut -d' ' -f2)"; name="$(echo "$first" | cut -d' ' -f3)"
      if [ "$action" = create ]; then change "create $file with MCP server $name for project $PROJECT"
      else change "$action MCP server $name for project $PROJECT in $file (command and args only; other keys and the rest of the file stay; a copy is kept once as $file.design-ui.bak)"; fi
      [ "$DRY" != 1 ] || printf '%s\n' "$rest" | sed 's/^/    /' ;;
    FAIL*)
      echo "setup: ${first#FAIL }" >&2
      [ -z "$rest" ] || printf '%s\n' "$rest" >&2
      if [ "${#CHANGES[@]}" -gt 0 ]; then
        echo "setup: already changed before this failure:" >&2
        printf '  - %s\n' "${CHANGES[@]}" >&2
      else
        echo "setup: nothing was changed before this failure." >&2
      fi
      exit 2 ;;
    *) die "unexpected result for $file: $result" ;;
  esac
}
register_claude_code() {
  local ADD_CMD=(mcp add --scope local design-ui -- "$NODE" "$SERVER_JS" --project "$PROJECT")
  local CLAUDE="${CLAUDE_BIN:-}"
  [ -n "$CLAUDE" ] || CLAUDE="$(command -v claude 2>/dev/null || true)"
  if [ -n "$CLAUDE" ] && [ ! -x "$CLAUDE" ]; then die "CLAUDE_BIN is not an executable file: $CLAUDE"; fi
  if [ -z "$CLAUDE" ]; then
    info "claude CLI: not found on PATH (set CLAUDE_BIN to use another one); nothing was registered."
    info "Run this in $CLIENT_DIR:"
    echo "    cd $(quoted "$CLIENT_DIR") && $(quoted claude "${ADD_CMD[@]}")"
    if [ "$(uname)" = Darwin ]; then
      local BUNDLED
      BUNDLED="$(ls -t "$HOME"/Library/Application\ Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude 2>/dev/null | head -1 || true)"
      [ -z "$BUNDLED" ] || info "The Claude desktop app has a CLI at $BUNDLED; to let setup use it, rerun with CLAUDE_BIN=$(quoted "$BUNDLED")"
    fi
    return 0
  fi
  info "claude CLI: $CLAUDE"
  local REGISTERED=0 EXISTING STATUS
  EXISTING="$(cd "$CLIENT_DIR" && "$CLAUDE" mcp get design-ui 2>&1)" && REGISTERED=1 || true
  if [ "$REGISTERED" = 1 ] && printf '%s' "$EXISTING" | grep -qF -- "$SERVER_JS" && printf '%s' "$EXISTING" | grep -qF -- "$PROJECT"; then
    info "already registered in $CLIENT_DIR"
    return 0
  fi
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
}
for c in "${CLIENTS[@]}"; do
  case "$c" in
    none) info "skipped" ;;
    codex|cursor)
      if client_skipped "$c"; then info "skipped $c: $(dirname "$(client_file "$c")") does not exist (client not installed?); use --client $c to create it"
      else edit_client_config "$([ "$c" = codex ] && echo toml || echo json)" "$(client_file "$c")"; fi
      ;;
    claude-desktop)
      info "add this to claude_desktop_config.json (Claude Desktop > Settings > Developer > Edit Config):"
      snippet json
      ;;
    claude-code) register_claude_code ;;
  esac
done

# 6. Skill ------------------------------------------------------------------------------------------------------------
echo "[6/7] Skill /unity-ui-mcp (scripts/install-skill.sh)"
SKILL_ARGS=(); [ "$DRY" != 1 ] || SKILL_ARGS=(--dry-run)
SKILL_OUT="$("$REPO/scripts/install-skill.sh" ${SKILL_ARGS[@]+"${SKILL_ARGS[@]}"})" || die "install-skill.sh failed"
printf '%s\n' "$SKILL_OUT"
while IFS= read -r l; do
  case "$l" in "  would "*|"  change: "*) CHANGES+=("skill: ${l#  }") ;; esac
done <<<"$SKILL_OUT"

# 7. Server check -----------------------------------------------------------------------------------------------------
echo "[7/7] Server check (stdio: initialize, tools/list, design_ui_list)"
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
