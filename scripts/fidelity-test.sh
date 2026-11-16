#!/usr/bin/env bash
# Tests scripts/fidelity.sh's failure paths without Unity: a stub stands in for scripts/unity-check.sh (FIDELITY_UNITY_CHECK),
# the export is real (Chromium, the repository kit). Each case reuses one --out folder that holds a passing earlier run, so a
# stale capture-done.json, verdict or report would show up as a PASS.
#
#   scripts/fidelity-test.sh        exit 0 when every case holds
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/fidelity-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT
FIXTURE="$ROOT/design-kit/fixtures/fidelity/text-row.html" # a fixture of the repository kit, which the run copies
NAME="text-row"
OUT="$T/out"
fails=0

# the stub: setup passes (the kit copy already has the repository kit's fonts) and, as the real setup's kit sync does, writes
# the sample project's reference locale (tr, the fixtures' language) into the kit copy; import reports the case's code per folder;
# capture does what $STUB_CAPTURE says; the cleanup notes its root in $STUB_CLEANED and does what $STUB_CLEANUP says
cat > "$T/unity-stub.sh" <<'STUB'
#!/usr/bin/env bash
filter=""
while [ $# -gt 0 ]; do [ "$1" = "--editmode" ] && filter="$2"; shift; done
case "$filter" in
  *SetupFromEnv*) [ "$STUB_SETUP" = die ] && { echo "klon-test=editmode sonuç=FAIL detay=setup broke png=yok"; exit 1; }
    "${DESIGN_UI_NODE:-node}" -e 'const fs = require("fs"), f = process.argv[1]; fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), locales: ["tr"] }))' "$DESIGN_UI_KIT_DIR/kit.config.json"
    echo "klon-test=editmode sonuç=PASS detay=total:1 pass:1 png=yok"; exit 0 ;;
  *CleanupFromEnv*)
    echo "$DESIGN_UI_FIDELITY_ROOT" >> "$STUB_CLEANED"
    [ "$STUB_CLEANUP" = die ] && { echo "klon-test=editmode sonuç=FAIL detay=cleanup broke png=yok"; exit 1; }
    echo "klon-test=editmode sonuç=PASS detay=total:1 pass:1 png=yok"; exit 0 ;;
  *ImportFromEnv*)
    IFS=":" read -r -a dirs <<< "$DESIGN_UI_EXPORT_DIR"
    for d in "${dirs[@]}"; do printf '%s\t%s\t%s\n' "${STUB_IMPORT_CODE:-0}" "$d" "${STUB_IMPORT_LINE:-Imported the screen}" >> "$DESIGN_UI_IMPORT_REPORT"; done
    exit 0 ;;
  *CaptureFromEnv*)
    IFS=":" read -r -a outs <<< "$DESIGN_UI_OUT"
    case "$STUB_CAPTURE" in
      die) echo "klon-test=editmode sonuç=FAIL detay=Unity crashed png=yok"; exit 1 ;;
      foreign) for o in "${outs[@]}"; do mkdir -p "$o"; echo '{ "runId": "an-earlier-run", "jobs": 3, "captured": 3, "notCaptured": 0 }' > "$o/capture-done.json"; done; exit 0 ;;
    esac ;;
esac
echo "stub: unexpected filter $filter" >&2; exit 3
STUB
chmod +x "$T/unity-stub.sh"

# a passing earlier run in the same --out: its marker, verdict and report must not count for a later run
stale() {
  local d="$OUT/$NAME"
  mkdir -p "$d/unity"
  echo '{ "runId": "an-earlier-run", "jobs": 3, "captured": 3, "notCaptured": 0 }' > "$d/unity/capture-done.json"
  echo '{ "screen": "squad", "pass": true, "captures": [], "notRun": [], "notRunReasons": {} }' > "$d/verdict.json"
  echo "<html>old report</html>" > "$d/report.html"
}

check() { # check <case> <condition text> <test command…>
  local what="$1" cond="$2"; shift 2
  if "$@"; then echo "ok   $what: $cond"; else echo "FAIL $what: $cond"; fails=$((fails + 1)); fi
}

run_case() { # run_case <case> <env assignments…>; sets rc and the summary in $T/<case>.log
  local name="$1"; shift
  stale
  rc=0
  : > "$T/cleaned"
  env FIDELITY_UNITY_CHECK="$T/unity-stub.sh" STUB_CLEANED="$T/cleaned" "$@" "$ROOT/scripts/fidelity.sh" --out "$OUT" "$FIXTURE" > "$T/$name.log" 2>&1 || rc=$?
}
cleaned_once() { [ "$(cat "$T/cleaned")" = "Assets/UnityCloneTest/DesignUiFidelity" ]; }

row() { grep -E "^\| $NAME \|" "$OUT/summary.md" || true; }

run_case died STUB_CAPTURE=die
check died "exit 1" test "$rc" -eq 1
check died "the fixture is not captured, with the capture run's failure" grep -q "not captured | capture failed: no capture-done.json; capture run exit 1: Unity crashed" "$OUT/summary.md"
check died "no PASS row" sh -c "! grep -q '| PASS |' '$OUT/summary.md'"
check died "the earlier verdict and report are gone" sh -c "[ ! -e '$OUT/$NAME/verdict.json' ] && [ ! -e '$OUT/$NAME/report.html' ]"
check died "the earlier marker is gone" test ! -e "$OUT/$NAME/unity/capture-done.json"
check died "the run's root in the project copy is cleaned up once" cleaned_once

run_case foreign STUB_CAPTURE=foreign
check foreign "exit 1" test "$rc" -eq 1
check foreign "a marker of another run does not count" grep -q "capture-done.json is from another run (an-earlier-run)" "$OUT/summary.md"

run_case import STUB_IMPORT_CODE=1 STUB_IMPORT_LINE="Import failed; nothing was written for the screen." STUB_CAPTURE=die
check import "exit 1" test "$rc" -eq 1
check import "the import's own failure is the reason" grep -q "import failed: Import failed; nothing was written" "$OUT/summary.md"
check import "nothing is captured for a screen that was not imported" sh -c "! grep -q 'capturing' '$T/import.log'"
check import "the run's root in the project copy is cleaned up once" cleaned_once

run_case setup STUB_SETUP=die
check setup "exit 1" test "$rc" -eq 1
check setup "a failed setup is cleaned up too" cleaned_once

run_case cleanup STUB_CAPTURE=die STUB_CLEANUP=die
check cleanup "exit 1" test "$rc" -eq 1
check cleanup "a failed cleanup is named in the summary" grep -q "The cleanup of the project copy failed: cleanup broke" "$OUT/summary.md"

if [ $fails -gt 0 ]; then
  echo "fidelity-test: $fails check(s) failed; logs:"; for f in "$T"/*.log; do echo "== $f"; tail -20 "$f"; done
  exit 1
fi
echo "fidelity-test: all checks pass"
