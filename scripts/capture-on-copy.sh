#!/usr/bin/env bash
# capture-on-copy.sh <UnityProjectDir> [<Unity binary>] [--slots N] [--min-free-gb N] [--lock-dir DIR]
#
# The verification capture of design_ui_verify, on a temporary copy of a Unity project (Unity cannot open a project
# twice, and the capture never runs in your open Editor). It
#   1. takes a capture slot: at most --slots capture-on-copy Unity runs at a time on this machine (default 1), the
#      others wait for theirs; a slot whose holder process is gone is taken over;
#   2. checks the free disk where the copy goes (the temporary folder, TMPDIR): at least --min-free-gb (default 10; with
#      rsync also the project's size), else it stops before copying anything;
#   3. copies the project into a new temporary folder (an APFS clone on macOS, so the Library comes along at no cost;
#      rsync elsewhere), without Temp/, Logs/ and UserSettings/, and deletes the open Editor's process and lock files from
#      the copy before Unity starts (Library/ilpp.pid and every other *.pid, Library/EditorInstance.json, the asset
#      databases' -lock files, search index locks, UnityLockfile): a copy that keeps them makes its Unity treat the open
#      Editor's helpers as its own (it stops the open Editor's IL post-processing runner);
#   4. in the COPY's Packages/manifest.json only, lists the design-ui package's tests ("testables") and turns relative
#      file: package paths into absolute ones (the copy lives elsewhere);
#   5. runs DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv there in batchmode; the MCP server passes the export
#      and output folders in DESIGN_UI_EXPORT_DIR and DESIGN_UI_OUT_DIR (outside the copy);
#   6. removes the copy and gives the slot back when Unity exits, whether the capture succeeded or failed, and exits with
#      Unity's code (2: it did not run Unity: usage, no Unity, not enough disk).
# Your project is never changed: no manifest entry, scene, asset or helper file is added to it.
#
# Options (or the environment variables; the MCP server passes no DESIGN_UI_* variable of its own environment on):
#   --slots N          CAPTURE_COPY_SLOTS        capture runs at a time on this machine (default 1)
#   --min-free-gb N    CAPTURE_COPY_MIN_FREE_GB  free disk the copy needs, in GB (default 10)
#   --lock-dir DIR     CAPTURE_COPY_LOCK_DIR     where the slots are kept (default <TMPDIR>/design-ui-capture-slots); every
#                                                capture that shares the folder shares the slots
#                      CAPTURE_COPY_MODE         auto (default), clone (APFS clone only) or rsync
#                      CAPTURE_COPY_POLL_SEC     seconds between looks at the slots while waiting (default 5)
#
# Unity: the second argument, else UNITY_BIN, else the Unity Hub install of the project's version
# (ProjectSettings/ProjectVersion.txt). design-ui.config.json:
#   "unityRunner": { "captureVia": "command", "command": { "capture": ["<clone>/scripts/capture-on-copy.sh", "{projectDir}"] } }
# A project with a runner of its own (one that already limits heavy Unity jobs) puts that runner's command there instead.
set -euo pipefail

PACKAGE="com.ertugrulgaziakcan.design-ui"
usage() { sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
die() { echo "capture-on-copy: $*" >&2; exit 2; }

SLOTS="${CAPTURE_COPY_SLOTS:-1}"
MIN_FREE_GB="${CAPTURE_COPY_MIN_FREE_GB:-10}"
LOCK_DIR="${CAPTURE_COPY_LOCK_DIR:-${TMPDIR:-/tmp}/design-ui-capture-slots}"
MODE="${CAPTURE_COPY_MODE:-auto}"
POLL="${CAPTURE_COPY_POLL_SEC:-5}"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --slots) [ $# -ge 2 ] || usage; SLOTS="$2"; shift 2 ;;
    --min-free-gb) [ $# -ge 2 ] || usage; MIN_FREE_GB="$2"; shift 2 ;;
    --lock-dir) [ $# -ge 2 ] || usage; LOCK_DIR="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
[ ${#ARGS[@]} -ge 1 ] && [ ${#ARGS[@]} -le 2 ] || usage
case "$SLOTS" in ''|*[!0-9]*|0) die "--slots must be a whole number of at least 1 (got '$SLOTS')" ;; esac
case "$MIN_FREE_GB" in ''|*[!0-9]*) die "--min-free-gb must be a whole number of GB (got '$MIN_FREE_GB')" ;; esac
case "$MODE" in auto|clone|rsync) ;; *) die "CAPTURE_COPY_MODE must be auto, clone or rsync (got '$MODE')" ;; esac

PROJECT="$(cd "${ARGS[0]}" && pwd)"
[ -d "$PROJECT/Assets" ] && [ -f "$PROJECT/Packages/manifest.json" ] || die "$PROJECT is not a Unity project"

UNITY="${ARGS[1]:-${UNITY_BIN:-}}"
if [ -z "$UNITY" ]; then
  VERSION="$(sed -n 's/^m_EditorVersion: *//p' "$PROJECT/ProjectSettings/ProjectVersion.txt" 2>/dev/null | head -1)"
  for c in "/Applications/Unity/Hub/Editor/$VERSION/Unity.app/Contents/MacOS/Unity" "$HOME/Unity/Hub/Editor/$VERSION/Editor/Unity" \
           "/c/Program Files/Unity/Hub/Editor/$VERSION/Editor/Unity.exe"; do
    [ -n "$VERSION" ] && [ -x "$c" ] && { UNITY="$c"; break; }
  done
fi
[ -n "$UNITY" ] && [ -x "$UNITY" ] || die "no Unity binary (pass it as the second argument or set UNITY_BIN)"
command -v node >/dev/null 2>&1 || die "node is required"

COPY=""
SLOT=""
cleanup() {
  [ -z "$COPY" ] || rm -rf "$COPY"
  [ -z "$SLOT" ] || rm -f "$SLOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- 1. a capture slot -----------------------------------------------------------------------------------------------
# One file per holder, slot.<pid>, made and counted under a short mkdir mutex. A holder whose process is gone (or is no
# longer a capture-on-copy run: its pid was reused) does not count and its file is removed.
holder_alive() {
  kill -0 "$1" 2>/dev/null && ps -p "$1" -o command= 2>/dev/null | grep -q "capture-on-copy"
}
take_mutex() {
  local tries=0
  until mkdir "$LOCK_DIR/.mutex" 2>/dev/null; do
    # a mutex left by a killed run is stale after a minute (the section it guards takes milliseconds)
    if [ -n "$(find "$LOCK_DIR/.mutex" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rmdir "$LOCK_DIR/.mutex" 2>/dev/null || true; fi
    tries=$((tries + 1))
    [ $tries -lt 600 ] || die "could not take the slot mutex $LOCK_DIR/.mutex (remove it if no capture is running)"
    sleep 0.1
  done
}
acquire_slot() {
  mkdir -p "$LOCK_DIR" || die "cannot create the slot folder $LOCK_DIR"
  local waited=0 f pid held holders
  while :; do
    take_mutex
    held=0; holders=""
    for f in "$LOCK_DIR"/slot.*; do
      [ -f "$f" ] || continue
      pid="${f##*/slot.}"
      if holder_alive "$pid"; then held=$((held + 1)); holders="$holders $pid"; else rm -f "$f"; fi
    done
    if [ "$held" -lt "$SLOTS" ]; then
      SLOT="$LOCK_DIR/slot.$$"
      echo "$$" > "$SLOT"
      rmdir "$LOCK_DIR/.mutex"
      [ $waited = 0 ] || echo "capture-on-copy: got a capture slot"
      return 0
    fi
    rmdir "$LOCK_DIR/.mutex"
    if [ $waited = 0 ]; then
      echo "capture-on-copy: waiting for a capture slot ($held of $SLOTS in use, pid$holders; --slots or CAPTURE_COPY_SLOTS allows more)"
      waited=1
    fi
    sleep "$POLL"
  done
}
acquire_slot

# ---- 2. free disk where the copy goes --------------------------------------------------------------------------------
BASE="${TMPDIR:-/tmp}"
BASE="${BASE%/}"
check_disk() { # check_disk clone|rsync
  local free_kb need_kb what project_kb
  free_kb="$(df -Pk "$BASE" | awk 'NR == 2 { print $4 }')"
  need_kb=$((MIN_FREE_GB * 1024 * 1024))
  what="at least $MIN_FREE_GB GB (--min-free-gb)"
  if [ "$1" = rsync ]; then
    # rsync copies every byte: the project itself on top of the minimum
    project_kb="$(du -sk "$PROJECT" 2>/dev/null | awk '{ print $1 }')"
    need_kb=$((need_kb + ${project_kb:-0}))
    what="the project's $(( (${project_kb:-0} + 1048575) / 1048576 )) GB plus $MIN_FREE_GB GB (--min-free-gb)"
  fi
  if [ "${free_kb:-0}" -lt "$need_kb" ]; then
    die "only $(( ${free_kb:-0} / 1048576 )) GB free on the disk of $BASE; the capture copy needs $what. Free space there, point TMPDIR at a disk with more room, or lower --min-free-gb. Nothing was copied."
  fi
}
CLONE=0
if [ "$MODE" != rsync ] && [ "$(uname)" = Darwin ]; then CLONE=1; fi
[ "$MODE" != clone ] || [ $CLONE = 1 ] || die "CAPTURE_COPY_MODE=clone needs macOS (APFS clones)"
check_disk "$([ $CLONE = 1 ] && echo clone || echo rsync)"

# ---- 3. the copy, without the open Editor's process and lock files ---------------------------------------------------
COPY="$(mktemp -d "$BASE/design-ui-capture.XXXXXX")"
if [ $CLONE = 1 ] && cp -cR "$PROJECT/." "$COPY/" 2>/dev/null; then
  :
else
  [ "$MODE" != clone ] || die "the APFS clone of $PROJECT into $COPY failed (CAPTURE_COPY_MODE=clone)"
  rm -rf "$COPY" && mkdir -p "$COPY"
  [ $CLONE = 0 ] || check_disk rsync # the clone failed (another volume?): the full copy needs the project's size too
  rsync -a --exclude /Temp --exclude /Logs --exclude /UserSettings --exclude /UnityLockfile \
    --exclude /Library/EditorInstance.json --exclude '/Library/*-lock' --exclude '/Library/**index-lock' \
    --exclude '/Library/**.pid' "$PROJECT/" "$COPY/"
fi
# the same list on both paths (rsync excluded them already): Unity must never start on a copy that still has them
rm -rf "$COPY/Temp" "$COPY/Logs" "$COPY/UserSettings" "$COPY/UnityLockfile" "$COPY/Library/EditorInstance.json"
if [ -d "$COPY/Library" ]; then
  find "$COPY/Library" -path "$COPY/Library/PackageCache" -prune -o -type f \
    \( -name '*.pid' -o -name '*-lock' -o -name '*index-lock' \) -exec rm -f {} +
fi
[ ! -e "$COPY/Library/ilpp.pid" ] || die "the copy still has Library/ilpp.pid; Unity was not started"

# ---- 4. the copy's manifest ------------------------------------------------------------------------------------------
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

# ---- 5. the capture --------------------------------------------------------------------------------------------------
set +e
"$UNITY" -batchmode -projectPath "$COPY" -runTests -testPlatform EditMode \
  -testFilter "DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv" -testResults "$COPY/capture-results.xml" -logFile -
rc=$?
set -e
exit "$rc"
