#!/usr/bin/env bash
# Fidelity suite: every fixture through the whole pipeline, then one summary table.
#
#   scripts/fidelity.sh [--out <dir>] [--kit <dir>] [fixture.html | design folder ...]
#
# Default fixtures: design-kit/fixtures/fidelity/*.html and design-kit/components/*.html.
# Steps (Unity always on an isolated copy of samples/FidelityProject through scripts/unity-check.sh, never an open Editor):
#   1. kit       copy the kit into <out>/kit; Unity: FidelityProject.FidelitySetup.SetupFromEnv makes the sample's fonts and
#                profile and syncs the fonts into that kit (the exporter and the compiler use the same fonts)
#   2. export    design-export export <fixture> --kit <out>/kit --out <out>/<name>/export   (Chromium goldens, IR); every
#                fixture's earlier export, captures, verdict and report are deleted first, and screen ids must be unique
#   3. import    one Unity run: DesignUiOpsTests.ImportFromEnv with every exported folder (DesignUiBatch.ImportEach), each
#                folder's result in <out>/logs/import-results.tsv
#   4. capture   one Unity run: DesignCaptureTests.CaptureFromEnv, each imported export into <out>/<name>/unity, with this
#                run's id (DESIGN_UI_RUN_ID): only a capture-done.json carrying it counts as captured
#   5. compare   design-export compare <out>/<name>/export --unity <out>/<name>/unity --report <out>/<name>/report.html
#   6. summary   one row per fixture x viewport x job (PASS, FAIL with the first issue, not captured with the reason) and
#                the timings, printed and written to <out>/summary.md
# Exit: 0 every static job passes (animation samples may stay not captured), 1 a job fails, a static job or a fixture is
# not captured, or a step fails; 2 usage.
#
# Environment: DESIGN_UI_FIDELITY_ROOT (Assets/... folder in the project copy; default below, a folder the copy keeps
# between runs), the setup's measurement knobs (see samples/FidelityProject/Assets/Fidelity/Editor/FidelitySetup.cs) and
# FIDELITY_UNITY_CHECK (the Unity runner, default scripts/unity-check.sh; scripts/fidelity-test.sh passes a stub).
# If the project copy stops compiling (a generated view that does not compile), fix the cause and reset the copy with
# scripts/unity-check.sh --stop warm.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"
CLI="$ROOT/tools/design-export/src/cli.ts"
CHECK="${FIDELITY_UNITY_CHECK:-$ROOT/scripts/unity-check.sh}"
UNITY_ROOT="${DESIGN_UI_FIDELITY_ROOT:-Assets/UnityCloneTest/DesignUiFidelity}"
PROFILE="$UNITY_ROOT/DesignUiProfile.asset"
RUN_ID="fidelity-$(date +%Y%m%d%H%M%S)-$$"

usage() { sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
now() { python3 -c 'import time; print(int(time.time() * 1000))'; }

OUT="" KIT="$ROOT/design-kit"
FIXTURES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || usage; OUT="$2"; shift 2 ;;
    --kit) [ $# -ge 2 ] || usage; KIT="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "fidelity: unknown option $1" >&2; usage ;;
    *) FIXTURES+=("$1"); shift ;;
  esac
done
PENDING=() PENDING_WHY=()
if [ ${#FIXTURES[@]} -eq 0 ]; then
  # design-kit/fixtures/fidelity/pending.json: fixture file name -> why it cannot run yet; the default suite lists it, skipped
  PENDING_FILE="$ROOT/design-kit/fixtures/fidelity/pending.json"
  for f in "$ROOT"/design-kit/fixtures/fidelity/*.html "$ROOT"/design-kit/components/*.html; do
    [ -f "$f" ] || continue
    why=""
    case "$f" in "$ROOT"/design-kit/fixtures/fidelity/*)
      [ -f "$PENDING_FILE" ] && why="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$PENDING_FILE" "$(basename "$f")")" ;;
    esac
    if [ -n "$why" ]; then PENDING+=("$(basename "${f%.html}")"); PENDING_WHY+=("$why"); else FIXTURES+=("$f"); fi
  done
fi
[ ${#FIXTURES[@]} -gt 0 ] || [ ${#PENDING[@]} -gt 0 ] || { echo "fidelity: no fixtures (none given, none in design-kit/fixtures/fidelity or design-kit/components)" >&2; exit 2; }
[ -d "$KIT" ] || { echo "fidelity: no kit folder $KIT" >&2; exit 2; }
for f in ${FIXTURES[@]+"${FIXTURES[@]}"}; do [ -e "$f" ] || { echo "fidelity: no such fixture: $f" >&2; exit 2; }; done
[ -x "$TSX" ] || { echo "fidelity: $TSX not found; run npm ci in the repository" >&2; exit 1; }

OUT="${OUT:-${TMPDIR:-/tmp}/design-ui-fidelity/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT/logs"
OUT="$(cd "$OUT" && pwd)"
echo "fidelity: ${#FIXTURES[@]} fixture(s) into $OUT (run $RUN_ID)"

# unique names: the file name without .html / .dc.html, prefixed with its folder when two fixtures share it
NAMES=()
for f in ${FIXTURES[@]+"${FIXTURES[@]}"}; do
  p="$f"; [ -d "$p" ] && p="$p/"
  base="$(basename "$p")"; base="${base%.html}"; base="${base%.dc}"
  [ -d "$f" ] && base="$(basename "$f")"
  for n in ${NAMES[@]+"${NAMES[@]}"}; do
    if [ "$n" = "$base" ]; then base="$(basename "$(dirname "$p")")-$base"; break; fi
  done
  NAMES+=("$base")
done

TIMES="$OUT/timings.tsv"; : > "$TIMES"
STATUS="$OUT/status.tsv"; : > "$STATUS"   # name <tab> step <tab> ok|failed <tab> detail
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$STATUS"; }
for i in ${PENDING[@]+"${!PENDING[@]}"}; do record "${PENDING[$i]}" pending skipped "${PENDING_WHY[$i]}"; done
timing() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$TIMES"; }

# the clone tool's summary detail ("detay=…") of a runner log, if it printed one
detail() { sed -n 's/.*detay=\(.*\) png=.*/\1/p' "$1" | tail -1; }

unity() { # unity <log> <regex> ; runs one EditMode filter on the project copy, env already exported
  local log="$1" filter="$2" rc=0
  "$CHECK" --warm --wait --editmode "$filter" > "$log" 2>&1 || rc=$?
  tail -4 "$log" | sed 's/^/  | /'
  return $rc
}

# ---- 1. kit -------------------------------------------------------------------------------------------------------
t0=$(now)
rm -rf "$OUT/kit"; mkdir -p "$OUT/kit"
( cd "$KIT" && tar cf - --exclude ./fixtures --exclude ./components . ) | ( cd "$OUT/kit" && tar xf - )
echo "fidelity: setup and kit sync on the project copy ($UNITY_ROOT)"
setup_rc=0
DESIGN_UI_FIDELITY_ROOT="$UNITY_ROOT" DESIGN_UI_KIT_DIR="$OUT/kit" unity "$OUT/logs/setup.log" "FidelityProject.FidelitySetup.SetupFromEnv" || setup_rc=$?
timing "*" setup $(( $(now) - t0 ))
if [ $setup_rc -ne 0 ] || [ ! -f "$OUT/kit/fonts/fonts.css" ]; then
  echo "fidelity: setup or kit sync failed (exit $setup_rc $(detail "$OUT/logs/setup.log")); see $OUT/logs/setup.log" >&2
  if grep -q "compile:error" "$OUT/logs/setup.log"; then
    echo "fidelity: the project copy does not compile (a generated view from an earlier run?); after fixing the cause, reset" \
      "the copy with: scripts/unity-check.sh --stop warm" >&2
  fi
  exit 1
fi

# ---- 2. export ----------------------------------------------------------------------------------------------------
EXPORTED=() SCREENS=()
for i in ${FIXTURES[@]+"${!FIXTURES[@]}"}; do
  name="${NAMES[$i]}"; dir="$OUT/$name"
  # nothing of an earlier run in this folder may count for this one
  rm -rf "$dir/export" "$dir/unity" "$dir/verdict.json" "$dir/report.html" "$dir/report-diff"
  mkdir -p "$dir"
  t0=$(now); rc=0
  "$TSX" "$CLI" export "${FIXTURES[$i]}" --kit "$OUT/kit" --out "$dir/export" --force > "$OUT/logs/export-$name.log" 2>&1 || rc=$?
  timing "$name" export $(( $(now) - t0 ))
  if [ $rc -ne 0 ]; then
    record "$name" export failed "$(grep -m1 -E '^(error|design-export:)' "$OUT/logs/export-$name.log" || tail -1 "$OUT/logs/export-$name.log")"
    echo "fidelity: export of $name failed (exit $rc); see $OUT/logs/export-$name.log" >&2
    continue
  fi
  screen="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["screen"])' "$dir/export/screen.ir.json" 2>/dev/null || true)"
  clash=""
  for j in ${EXPORTED[@]+"${!EXPORTED[@]}"}; do [ "${SCREENS[$j]}" = "$screen" ] && clash="${EXPORTED[$j]}"; done
  if [ -n "$clash" ]; then
    # one compiled folder per screen id: the later import would replace the earlier fixture's screen before its capture
    record "$name" export failed "screen id '$screen' is also the screen of $clash; give every fixture its own data-u-screen"
    continue
  fi
  record "$name" export ok ""
  EXPORTED+=("$name"); SCREENS+=("$screen")
  echo "fidelity: exported $name ($(sed -n 's/^exported to .* in \([0-9.]*\) ms.*/\1 ms/p' "$OUT/logs/export-$name.log"))"
done

join() { local IFS=":"; echo "$*"; }

if [ ${#EXPORTED[@]} -gt 0 ]; then
  # ---- 3. import --------------------------------------------------------------------------------------------------
  echo "fidelity: importing ${#EXPORTED[@]} export(s) on the project copy"
  EXPORT_DIRS=(); for name in "${EXPORTED[@]}"; do EXPORT_DIRS+=("$OUT/$name/export"); done
  REPORT="$OUT/logs/import-results.tsv"; rm -f "$REPORT"
  t0=$(now); import_rc=0
  DESIGN_UI_PROFILE="$PROFILE" DESIGN_UI_EXPORT_DIR="$(join "${EXPORT_DIRS[@]}")" DESIGN_UI_IMPORT_REPORT="$REPORT" \
    unity "$OUT/logs/import.log" "DesignUi.Editor.Tests.DesignUiOpsTests.ImportFromEnv" || import_rc=$?
  timing "*" import $(( $(now) - t0 ))
  IMPORTED=()
  for name in "${EXPORTED[@]}"; do
    line="$(awk -F'\t' -v d="$OUT/$name/export" '$2 == d' "$REPORT" 2>/dev/null | tail -1)"
    code="$(printf '%s' "$line" | cut -f1)"
    if [ "$code" = "0" ]; then record "$name" import ok ""; IMPORTED+=("$name")
    elif [ -n "$line" ]; then record "$name" import failed "$(printf '%s' "$line" | cut -f3)"
    else record "$name" import failed "no import result (import run exit $import_rc $(detail "$OUT/logs/import.log"))"; fi
  done

  if [ ${#IMPORTED[@]} -gt 0 ]; then
    # ---- 4. capture -----------------------------------------------------------------------------------------------
    echo "fidelity: capturing ${#IMPORTED[@]} screen(s) on the project copy"
    CAP_EXPORTS=() CAP_OUTS=()
    for name in "${IMPORTED[@]}"; do CAP_EXPORTS+=("$OUT/$name/export"); CAP_OUTS+=("$OUT/$name/unity"); done
    t0=$(now); capture_rc=0
    DESIGN_UI_PROFILE="$PROFILE" DESIGN_UI_EXPORT="$(join "${CAP_EXPORTS[@]}")" DESIGN_UI_OUT="$(join "${CAP_OUTS[@]}")" DESIGN_UI_RUN_ID="$RUN_ID" \
      unity "$OUT/logs/capture.log" "DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv" || capture_rc=$?
    timing "*" capture $(( $(now) - t0 ))
    [ $capture_rc -eq 0 ] || echo "fidelity: the capture run failed (exit $capture_rc); see $OUT/logs/capture.log" >&2

    # ---- 5. compare -----------------------------------------------------------------------------------------------
    for name in "${IMPORTED[@]}"; do
      dir="$OUT/$name"; marker="$dir/unity/capture-done.json"
      run="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("runId",""))' "$marker" 2>/dev/null || true)"
      if [ "$run" != "$RUN_ID" ]; then
        if [ -f "$marker" ]; then reason="capture-done.json is from another run ($run), not this one"
        elif [ -f "$dir/unity/boxes.meta.json" ]; then reason="capture stopped (status $(sed -n 's/.*"status": "\(.*\)".*/\1/p' "$dir/unity/boxes.meta.json" | head -1))"
        else reason="no capture-done.json"; fi
        [ $capture_rc -ne 0 ] && reason="$reason; capture run exit $capture_rc$( d="$(detail "$OUT/logs/capture.log")"; [ -n "$d" ] && echo ": $d")"
        record "$name" capture failed "$reason"
        continue
      fi
      record "$name" capture ok ""
      t0=$(now); rc=0
      "$TSX" "$CLI" compare "$dir/export" --unity "$dir/unity" --report "$dir/report.html" > "$OUT/logs/compare-$name.log" 2>&1 || rc=$?
      timing "$name" compare $(( $(now) - t0 ))
      if [ $rc -le 1 ] && [ -f "$dir/verdict.json" ]; then record "$name" compare ok ""
      else record "$name" compare failed "$(tail -1 "$OUT/logs/compare-$name.log")"; fi
    done
  fi
fi

# ---- 6. summary ---------------------------------------------------------------------------------------------------
node --input-type=module - "$OUT" ${NAMES[@]+"${NAMES[@]}"} ${PENDING[@]+"${PENDING[@]}"} <<'JS'
import fs from "node:fs";
import path from "node:path";
const [out, ...names] = process.argv.slice(2);
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const status = fs.readFileSync(path.join(out, "status.tsv"), "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
const times = fs.readFileSync(path.join(out, "timings.tsv"), "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
const rows = [], failures = [];
let pass = 0, fail = 0, notCaptured = 0, animNotCaptured = 0;
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const ANIM = /^animation sample/;
let pending = 0;
for (const name of names) {
  const skipped = status.find((s) => s[0] === name && s[2] === "skipped");
  if (skipped) { rows.push([name, "–", "–", "pending", skipped[3]]); pending++; continue; }
  const failed = status.find((s) => s[0] === name && s[2] === "failed");
  const verdict = failed ? null : read(path.join(out, name, "verdict.json"));
  if (failed || !verdict) {
    rows.push([name, "–", "–", "not captured", `${failed ? failed[1] + " failed" : "no verdict"}: ${failed?.[3] ?? ""}`]);
    failures.push(name); notCaptured++;
    continue;
  }
  const jobs = [];
  for (const c of verdict.captures) {
    const vp = c.info?.viewport ? c.info.viewport.join("×") : (c.capture.split("@")[1] ?? "").split(".")[0];
    const job = c.capture.replace(/@\d+x\d+/, "");
    const first = c.issues[0];
    const detail = c.pass ? "" : `${c.issues.length} issue(s); ${first ? `${first.id} ${first.kind}: ${first.detail}` : ""}`;
    jobs.push([name, vp, job, c.pass ? "PASS" : "FAIL", detail]);
    if (c.pass) pass++; else { fail++; failures.push(`${name} ${c.capture}`); }
  }
  for (const n of verdict.notRun) {
    const reason = verdict.notRunReasons?.[n] ?? "not captured";
    const vp = (n.split("@")[1] ?? "").split(".")[0].replace("x", "×");
    const anim = ANIM.test(reason); // by the capture's reason only: an element id may contain "anim"
    jobs.push([name, vp, n.replace(/@\d+x\d+/, ""), anim ? "not captured (animation)" : "not captured", reason]);
    if (anim) animNotCaptured++; else { notCaptured++; failures.push(`${name} ${n}`); }
  }
  // the comparison's own verdict counts too (e.g. a screen with no capture at all is not a pass)
  const onlyAnim = verdict.notRun.length > 0 && verdict.notRun.every((n) => ANIM.test(verdict.notRunReasons?.[n] ?? ""));
  if (!verdict.pass && !jobs.some((j) => j[3] === "FAIL" || j[3] === "not captured") && !(onlyAnim && verdict.captures.length > 0)) {
    jobs.push([name, "–", "–", "FAIL", `the comparison does not pass the screen (${verdict.captures.length} captures, ${verdict.notRun.length} not run)`]);
    fail++; failures.push(name);
  }
  jobs.sort((a, b) => (b[1].split("×")[0] - a[1].split("×")[0]) || a[2].localeCompare(b[2]));
  rows.push(...jobs);
}
// animation samples: one line per fixture x viewport instead of one per sample
const folded = [];
for (const r of rows) {
  if (r[3] === "not captured (animation)") {
    const prev = folded.find((x) => x[0] === r[0] && x[1] === r[1] && x[3] === r[3]);
    if (prev) { prev.count++; continue; }
    folded.push({ 0: r[0], 1: r[1], 2: "animation samples", 3: r[3], 4: r[4], count: 1, length: 5 });
  } else folded.push(r);
}
const table = ["| Fixture | Viewport | Job | Result | Detail |", "|---|---|---|---|---|",
  ...folded.map((r) => `| ${cell(r[0])} | ${cell(r[1])} | ${cell(r.count ? `${r[2]} (${r.count})` : r[2])} | ${cell(r[3])} | ${cell(String(r[4]).slice(0, 220))} |`)];
const step = (n, s) => times.filter((t) => t[0] === n && t[1] === s).reduce((a, t) => a + Number(t[2]), 0);
const timing = ["| Step | Time |", "|---|---|",
  `| setup and kit sync (Unity) | ${(step("*", "setup") / 1000).toFixed(1)} s |`,
  ...names.map((n) => `| export ${n} | ${step(n, "export")} ms |`),
  `| import, all fixtures (Unity) | ${(step("*", "import") / 1000).toFixed(1)} s |`,
  `| capture, all fixtures (Unity) | ${(step("*", "capture") / 1000).toFixed(1)} s |`,
  ...names.map((n) => {
    const meta = read(path.join(out, n, "unity", "boxes.meta.json"));
    return `| capture ${n} (its part of the capture run) | ${meta?.timings?.totalMs != null ? `${Math.round(meta.timings.totalMs)} ms` : "–"} |`;
  }),
  ...names.map((n) => `| compare ${n} | ${step(n, "compare")} ms |`)];
const head = `${pass} PASS, ${fail} FAIL, ${notCaptured} not captured` + (pending ? `, ${pending} fixture(s) pending (skipped, listed in pending.json)` : "") + (animNotCaptured ? `, ${animNotCaptured} animation samples not captured (not a failure until the animation player exists)` : "");
const md = `# Fidelity summary\n\n${head}\n\n${table.join("\n")}\n\n## Timings\n\n${timing.join("\n")}\n`;
fs.writeFileSync(path.join(out, "summary.md"), md);
process.stdout.write(md);
process.exitCode = failures.length ? 1 : 0;
JS
