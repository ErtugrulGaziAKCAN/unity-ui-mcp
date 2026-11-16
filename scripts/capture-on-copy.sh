#!/usr/bin/env bash
# capture-on-copy.sh <UnityProjectDir> [<Unity binary>] [--slots N] [--min-free-gb N] [--lock-dir DIR]
#
# The verification capture of design_ui_verify, on a temporary copy of a Unity project (Unity cannot open a project
# twice, and the capture never runs in your open Editor). It
#   1. takes a capture slot: at most --slots capture-on-copy Unity runs at a time on this machine (default 1), the
#      others wait for theirs (the wait counts against the caller's time limit, unityRunner.timeoutSec); a slot counts
#      while its script or its Unity still runs, and is taken over once both are gone;
#   2. checks the free disk where the copy goes (the temporary folder, TMPDIR): at least --min-free-gb (default 10; with
#      rsync also the project's size, as far as du can read it), else it stops before copying anything, and says why;
#   3. copies the project into a new temporary folder (an APFS clone on macOS, so the Library comes along at no cost;
#      rsync elsewhere), without Temp/, Logs/ and UserSettings/, and deletes the open Editor's process and lock files from
#      the copy before Unity starts (Library/ilpp.pid and every other *.pid, Library/EditorInstance.json, the asset
#      databases' -lock files, search index locks, packages' .lock and *.lock files, UnityLockfile): a copy that keeps
#      them makes its Unity treat the open Editor's helpers as its own (it stops the open Editor's IL post-processing runner);
#   4. in the COPY's Packages/manifest.json only, lists the design-ui package's tests ("testables"), turns relative
#      file: package paths into absolute ones (the copy lives elsewhere) and, when the project has no Unity Test Framework
#      (com.unity.test-framework, in its manifest or packages-lock.json), adds the version built into the Unity it runs;
#   5. runs DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv there in batchmode; the MCP server passes the export
#      and output folders in DESIGN_UI_EXPORT_DIR and DESIGN_UI_OUT_DIR (outside the copy);
#   6. removes the copy and gives the slot back when Unity exits, whether the capture succeeded or failed, and exits with
#      Unity's code (2: it did not run Unity: usage, no Unity, not enough disk). Stopped itself (SIGTERM, as the MCP server
#      does at its time limit, SIGINT, SIGHUP) or failing, it first stops its Unity and everything Unity started (their
#      process group) and waits for them, then gives the slot back; the copy is removed in the background then, so a
#      SIGKILL right after cannot leave it half deleted.
# Your project is never changed: no manifest entry, scene, asset or helper file is added to it.
#
# Options (or the environment variables; the MCP server passes no DESIGN_UI_* variable of its own environment on):
#   --slots N          CAPTURE_COPY_SLOTS        capture runs at a time on this machine (default 1)
#   --min-free-gb N    CAPTURE_COPY_MIN_FREE_GB  free disk the copy needs, in GB (default 10)
#   --lock-dir DIR     CAPTURE_COPY_LOCK_DIR     where the slots are kept (default <TMPDIR>/design-ui-capture-slots, or
#                                                /tmp/design-ui-capture-slots-<uid> without TMPDIR); every capture that
#                                                shares the folder shares the slots
#                      CAPTURE_COPY_MODE         auto (default), clone (APFS clone only) or rsync
#                      CAPTURE_COPY_POLL_SEC     seconds between looks at the slots while waiting (default 5)
#
# Unity: the second argument, else UNITY_BIN, else the Unity Hub install of the project's version
# (ProjectSettings/ProjectVersion.txt). node (step 4): DESIGN_UI_NODE, which the MCP server sets to its own node (a client
# may start the server with a PATH without node), else node on PATH. design-ui.config.json:
#   "unityRunner": { "captureVia": "command", "command": { "capture": ["<clone>/scripts/capture-on-copy.sh", "{projectDir}"] } }
# A project with a runner of its own (one that already limits heavy Unity jobs) puts that runner's command there instead.
set -euo pipefail

PACKAGE="com.ertugrulgaziakcan.design-ui"
usage() { sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
die() { echo "capture-on-copy: $*" >&2; exit 2; }

SLOTS="${CAPTURE_COPY_SLOTS:-1}"
MIN_FREE_GB="${CAPTURE_COPY_MIN_FREE_GB:-10}"
if [ -n "${TMPDIR:-}" ]; then LOCK_DEFAULT="${TMPDIR%/}/design-ui-capture-slots"; else LOCK_DEFAULT="/tmp/design-ui-capture-slots-$(id -u)"; fi
LOCK_DIR="${CAPTURE_COPY_LOCK_DIR:-$LOCK_DEFAULT}"
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
# node: the MCP server's own (DESIGN_UI_NODE; a GUI client may start the server with a PATH without node), else PATH's
NODE="${DESIGN_UI_NODE:-}"
[ -n "$NODE" ] && [ -x "$NODE" ] || NODE="$(command -v node 2>/dev/null || true)"
[ -n "$NODE" ] || die "node is required (on PATH, or DESIGN_UI_NODE naming it)"

COPY=""
SLOT=""
UNITY_PID=""
MUTEX_HELD=0
SIGNALLED=0

# Stops this run's Unity and everything it started (Unity runs in a process group of its own), then waits for it: a
# second capture must never start next to it.
stop_unity() {
  local pid="$UNITY_PID" i=0
  [ -n "$pid" ] || return 0
  UNITY_PID=""
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    # within the MCP server's two-second grace after its SIGTERM; Unity gets one second to quit by itself
    while kill -0 "$pid" 2>/dev/null && [ $i -lt 10 ]; do sleep 0.1; i=$((i + 1)); done
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}
cleanup() {
  stop_unity
  [ "$MUTEX_HELD" = 0 ] || rm -rf "$LOCK_DIR/.mutex"
  if [ -n "$COPY" ]; then
    # stopped by a signal, the caller may SIGKILL this script any moment now: the copy goes in the background
    if [ "$SIGNALLED" = 1 ]; then (remove_copy) </dev/null >/dev/null 2>&1 & else remove_copy; fi
  fi
  [ -z "$SLOT" ] || rm -f "$SLOT"
}
# a folder of the project that was unreadable is unreadable in the copy too: it is made readable when rm cannot remove it
remove_copy() { rm -rf "$COPY" 2>/dev/null || { chmod -R u+rwX "$COPY" 2>/dev/null; rm -rf "$COPY"; }; }
on_signal() { SIGNALLED=1; exit "$1"; }
trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP

# ---- 1. a capture slot -----------------------------------------------------------------------------------------------
# One file per holder, slot.<pid>: the script's pid, then (once it runs) its Unity's pid and copy. The files are made and
# counted under a short mkdir mutex that names its owner. A holder counts while its script runs (and is still a
# capture-on-copy run: a pid can be reused) or its Unity still runs on its copy; otherwise its file is removed.
PS_COMMAND=1
ps -p $$ -o command= >/dev/null 2>&1 || PS_COMMAND=0 # Git Bash and busybox: pids only, no command lines
runs() { # runs <pid> <text>: the process lives and its command line has the text (when ps can tell)
  kill -0 "$1" 2>/dev/null || return 1
  [ "$PS_COMMAND" = 1 ] || return 0
  ps -p "$1" -o command= 2>/dev/null | grep -qF -- "$2"
}
holder_alive() { # holder_alive <slot file>
  local script unity copy
  { read -r script; read -r unity copy || true; } < "$1" 2>/dev/null || return 1
  [ "$script" != "$$" ] || return 1 # our own pid in a file left by a run that died: stale, never us waiting for us
  { [ -n "$script" ] && runs "$script" capture-on-copy; } || { [ -n "${unity:-}" ] && [ -n "${copy:-}" ] && runs "$unity" "$copy"; }
}
take_mutex() {
  local tries=0 owner
  until mkdir "$LOCK_DIR/.mutex" 2>/dev/null; do
    owner="$(cat "$LOCK_DIR/.mutex/owner" 2>/dev/null || true)"
    # a mutex left by a killed run: its owner is gone (or it never wrote one and is a minute old)
    if { [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; } || { [ -z "$owner" ] && [ -n "$(find "$LOCK_DIR/.mutex" -maxdepth 0 -mmin +1 2>/dev/null)" ]; }; then
      [ "$(cat "$LOCK_DIR/.mutex/owner" 2>/dev/null || true)" != "$owner" ] || rm -rf "$LOCK_DIR/.mutex"
    fi
    tries=$((tries + 1))
    [ $tries -lt 600 ] || die "could not take the slot mutex $LOCK_DIR/.mutex for a minute (owner pid ${owner:-unknown}); remove it if no capture is running"
    sleep 0.1
  done
  MUTEX_HELD=1
  echo "$$" > "$LOCK_DIR/.mutex/owner"
}
release_mutex() { rm -rf "$LOCK_DIR/.mutex"; MUTEX_HELD=0; }
acquire_slot() {
  mkdir -p "$LOCK_DIR" 2>/dev/null && [ -w "$LOCK_DIR" ] || die "cannot use the slot folder $LOCK_DIR (another user's?); set --lock-dir or CAPTURE_COPY_LOCK_DIR"
  local waited=0 f held holders
  while :; do
    take_mutex
    held=0; holders=""
    for f in "$LOCK_DIR"/slot.*; do
      [ -f "$f" ] || continue
      if holder_alive "$f"; then held=$((held + 1)); holders="$holders ${f##*/slot.}"; else rm -f "$f"; fi
    done
    if [ "$held" -lt "$SLOTS" ]; then
      SLOT="$LOCK_DIR/slot.$$"
      echo "$$" > "$SLOT"
      release_mutex
      [ $waited = 0 ] || echo "capture-on-copy: got a capture slot"
      return 0
    fi
    release_mutex
    if [ $waited = 0 ]; then
      echo "capture-on-copy: waiting for a capture slot ($held of $SLOTS in use, pid$holders; --slots or CAPTURE_COPY_SLOTS allows more; the wait counts against unityRunner.timeoutSec)"
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
  local free_kb need_kb what project_kb errors
  free_kb="$( { df -Pk "$BASE" 2>/dev/null || true; } | awk 'NR == 2 { print $4 }')"
  case "$free_kb" in ''|*[!0-9]*) die "could not read the free space of the disk of $BASE (df); free space there or pass --min-free-gb 0 to skip the check. Nothing was copied." ;; esac
  need_kb=$((MIN_FREE_GB * 1024 * 1024))
  what="at least $MIN_FREE_GB GB (--min-free-gb)"
  if [ "$1" = rsync ]; then
    # rsync copies every byte: the project itself on top of the minimum. du counts what it can read: an open Editor
    # creates and deletes files under it all the time, and a folder may be unreadable
    errors="$(mktemp "${TMPDIR:-/tmp}/design-ui-capture-du.XXXXXX")"
    project_kb="$( { du -sk "$PROJECT" 2>"$errors" || true; } | awk 'END { print $1 }')"
    case "$project_kb" in ''|*[!0-9]*) project_kb=0 ;; esac
    if [ -s "$errors" ]; then
      echo "capture-on-copy: du could not read all of $PROJECT ($(wc -l < "$errors" | tr -d ' ') error(s), first: $(head -1 "$errors")); the size it read, $(( (project_kb + 1048575) / 1048576 )) GB, is the estimate"
    fi
    rm -f "$errors"
    need_kb=$((need_kb + project_kb))
    what="the project's $(( (project_kb + 1048575) / 1048576 )) GB plus $MIN_FREE_GB GB (--min-free-gb)"
  fi
  if [ "$free_kb" -lt "$need_kb" ]; then
    die "only $(( free_kb / 1048576 )) GB free on the disk of $BASE; the capture copy needs $what. Free space there, point TMPDIR at a disk with more room, or lower --min-free-gb. Nothing was copied."
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
  set +e
  rsync -a --exclude /Temp --exclude /Logs --exclude /UserSettings --exclude /UnityLockfile \
    --exclude /Library/EditorInstance.json --exclude '/Library/*-lock' --exclude '/Library/**index-lock' \
    --exclude '/Library/**.pid' "$PROJECT/" "$COPY/"
  rc=$?
  set -e
  # 23: some files could not be read, 24: some vanished while copying (an open Editor works in the project): the copy
  # goes on with what it has, and Unity reports anything it needs and lacks
  case "$rc" in
    0) ;;
    23|24) echo "capture-on-copy: rsync could not copy every file of $PROJECT (exit $rc: unreadable or vanished files, listed above); capturing on the rest" ;;
    *) die "rsync of $PROJECT into $COPY failed (exit $rc)" ;;
  esac
fi
# the same list on both paths (rsync excluded them already): Unity must never start on a copy that still has them
rm -rf "$COPY/Temp" "$COPY/Logs" "$COPY/UserSettings" "$COPY/UnityLockfile" "$COPY/Library/EditorInstance.json"
if [ -d "$COPY/Library" ] && ! find "$COPY/Library" -path "$COPY/Library/PackageCache" -prune -o -type f \
    \( -name '*.pid' -o -name '*-lock' -o -name '*index-lock' -o -name '*.lock' \) -exec rm -f {} +; then
  echo "capture-on-copy: could not look into every folder of the copy's Library (listed above); process files in them stay"
fi
[ ! -e "$COPY/Library/ilpp.pid" ] || die "the copy still has Library/ilpp.pid; Unity was not started"

# ---- 4. the copy's manifest ------------------------------------------------------------------------------------------
# The capture runs as an EditMode test, so the copy needs the Unity Test Framework. A project that has none (not in its
# manifest, nor pulled in by another package in packages-lock.json) gets the version built into this Unity, in the copy only.
UNITY_DIR="$(cd "$(dirname "$UNITY")" && pwd)"
TEST_FRAMEWORK_BUILTIN=("$UNITY_DIR/../Resources/PackageManager/BuiltInPackages/com.unity.test-framework/package.json"
                        "$UNITY_DIR/Data/Resources/PackageManager/BuiltInPackages/com.unity.test-framework/package.json")
MANIFEST_NOTE="$("$NODE" - "$COPY/Packages/manifest.json" "$PROJECT/Packages" "$PACKAGE" "${TEST_FRAMEWORK_BUILTIN[@]}" <<'NODE'
const fs = require("fs"), path = require("path");
const [file, packagesDir, id, ...builtIn] = process.argv.slice(2);
const TEST_FRAMEWORK = "com.unity.test-framework";
const raw = fs.readFileSync(file, "utf8");
const bom = raw.startsWith("﻿") ? "﻿" : "";
const m = JSON.parse(raw.slice(bom.length));
m.dependencies = m.dependencies || {};
for (const [k, v] of Object.entries(m.dependencies)) {
  if (typeof v === "string" && v.startsWith("file:") && !path.isAbsolute(v.slice(5))) m.dependencies[k] = "file:" + path.resolve(packagesDir, v.slice(5));
}
m.testables = Array.from(new Set([...(Array.isArray(m.testables) ? m.testables : []), id]));
let lock = {};
try { lock = JSON.parse(fs.readFileSync(path.join(packagesDir, "packages-lock.json"), "utf8")).dependencies || {}; } catch {}
if (!(TEST_FRAMEWORK in m.dependencies) && !(TEST_FRAMEWORK in lock)) {
  const found = builtIn.find((f) => fs.existsSync(f));
  let version = null;
  try { version = found ? JSON.parse(fs.readFileSync(found, "utf8")).version : null; } catch {}
  if (typeof version !== "string" || !version) {
    console.log(`ERROR the project has no ${TEST_FRAMEWORK}, which the capture runs on (it is an EditMode test), and this Unity's built-in version could not be read: add Test Framework to the project in the Package Manager`);
    process.exit(3);
  }
  m.dependencies[TEST_FRAMEWORK] = version;
  console.log(`the project has no ${TEST_FRAMEWORK}: the copy adds ${version}, this Unity's built-in version (the capture runs as an EditMode test)`);
}
fs.writeFileSync(file, bom + JSON.stringify(m, null, 2) + "\n");
NODE
)" || die "${MANIFEST_NOTE#ERROR }"
[ -z "$MANIFEST_NOTE" ] || echo "capture-on-copy: $MANIFEST_NOTE"

# ---- 5. the capture --------------------------------------------------------------------------------------------------
# Unity runs in the background, in a process group of its own (job control), so a signal reaches this script at once
# (bash runs a trap only after a foreground child exits) and stop_unity can stop Unity with everything it started.
set -m
"$UNITY" -batchmode -projectPath "$COPY" -runTests -testPlatform EditMode \
  -testFilter "DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv" -testResults "$COPY/capture-results.xml" -logFile - &
UNITY_PID=$!
set +m
echo "$UNITY_PID $COPY" >> "$SLOT"
set +e
wait "$UNITY_PID"
rc=$?
set -e
UNITY_PID=""
exit "$rc"
