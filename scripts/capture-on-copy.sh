#!/usr/bin/env bash
# capture-on-copy.sh <UnityProjectDir> [<Unity binary>]
#
# The verification capture of design_ui_verify, on a temporary copy of a Unity project (Unity cannot open a project
# twice, and the capture never runs in your open Editor). It
#   1. copies the project into a new temporary folder (an APFS clone on macOS, so the Library comes along at no cost;
#      rsync elsewhere), without Temp/, Logs/ and UserSettings/;
#   2. in the COPY's Packages/manifest.json only, lists the design-ui package's tests ("testables") and turns relative
#      file: package paths into absolute ones (the copy lives elsewhere);
#   3. runs DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv there in batchmode; the MCP server passes the export
#      and output folders in DESIGN_UI_EXPORT_DIR and DESIGN_UI_OUT_DIR (outside the copy);
#   4. removes the copy when Unity exits, whether the capture succeeded or failed, and exits with Unity's code.
# Your project is never changed: no manifest entry, scene, asset or helper file is added to it.
#
# Unity: the second argument, else UNITY_BIN, else the Unity Hub install of the project's version
# (ProjectSettings/ProjectVersion.txt). design-ui.config.json:
#   "unityRunner": { "captureVia": "command", "command": { "capture": ["<clone>/scripts/capture-on-copy.sh", "{projectDir}"] } }
set -euo pipefail

PACKAGE="com.ertugrulgaziakcan.design-ui"
[ $# -ge 1 ] || { sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
PROJECT="$(cd "$1" && pwd)"
[ -d "$PROJECT/Assets" ] && [ -f "$PROJECT/Packages/manifest.json" ] || { echo "capture-on-copy: $PROJECT is not a Unity project" >&2; exit 2; }

UNITY="${2:-${UNITY_BIN:-}}"
if [ -z "$UNITY" ]; then
  VERSION="$(sed -n 's/^m_EditorVersion: *//p' "$PROJECT/ProjectSettings/ProjectVersion.txt" 2>/dev/null | head -1)"
  for c in "/Applications/Unity/Hub/Editor/$VERSION/Unity.app/Contents/MacOS/Unity" "$HOME/Unity/Hub/Editor/$VERSION/Editor/Unity" \
           "/c/Program Files/Unity/Hub/Editor/$VERSION/Editor/Unity.exe"; do
    [ -n "$VERSION" ] && [ -x "$c" ] && { UNITY="$c"; break; }
  done
fi
[ -n "$UNITY" ] && [ -x "$UNITY" ] || { echo "capture-on-copy: no Unity binary (pass it as the second argument or set UNITY_BIN)" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "capture-on-copy: node is required" >&2; exit 2; }

COPY="$(mktemp -d "${TMPDIR:-/tmp}/design-ui-capture.XXXXXX")"
cleanup() { rm -rf "$COPY"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$(uname)" = Darwin ] && cp -cR "$PROJECT/." "$COPY/" 2>/dev/null; then
  rm -rf "$COPY/Temp" "$COPY/Logs" "$COPY/UserSettings"
else
  rm -rf "$COPY" && mkdir -p "$COPY"
  rsync -a --exclude /Temp --exclude /Logs --exclude /UserSettings "$PROJECT/" "$COPY/"
fi

node - "$COPY/Packages/manifest.json" "$PROJECT/Packages" "$PACKAGE" <<'NODE'
const fs = require("fs"), path = require("path");
const [file, packagesDir, id] = process.argv.slice(2);
const raw = fs.readFileSync(file, "utf8");
const bom = raw.startsWith("﻿") ? "﻿" : "";
const m = JSON.parse(raw.slice(bom.length));
for (const [k, v] of Object.entries(m.dependencies || {})) {
  if (typeof v === "string" && v.startsWith("file:") && !path.isAbsolute(v.slice(5))) m.dependencies[k] = "file:" + path.resolve(packagesDir, v.slice(5));
}
m.testables = Array.from(new Set([...(Array.isArray(m.testables) ? m.testables : []), id]));
fs.writeFileSync(file, bom + JSON.stringify(m, null, 2) + "\n");
NODE

set +e
"$UNITY" -batchmode -projectPath "$COPY" -runTests -testPlatform EditMode \
  -testFilter "DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv" -testResults "$COPY/capture-results.xml" -logFile -
rc=$?
set -e
exit "$rc"
