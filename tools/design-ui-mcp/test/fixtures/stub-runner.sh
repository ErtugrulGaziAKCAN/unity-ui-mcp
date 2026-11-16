#!/bin/sh
# Test stand-in for a Unity command runner. Usage: stub-runner.sh --log <file> [--exit <code>] <args...>
# Appends one line per call to the log: the remaining arguments joined by "|", then the DESIGN_UI_EXPORT_DIR env value.
# A "capture" call that exits 0 writes capture-done.json into DESIGN_UI_OUT_DIR, as the Unity capture does; an "import"
# call that exits 0 writes DESIGN_UI_IMPORT_DONE with the export's IR SHA-256, as ImportFromEnv does
# (--import-done none: no marker; wrong: another IR's); a "kitSync" call that exits 0 writes DESIGN_UI_KIT_SYNC_DONE with
# the kit folder and its code, as KitSyncFromEnv does (--kit-sync-done none: no marker).
log=""
code=0
done_mode=ok
kit_done_mode=ok
while [ $# -gt 0 ]; do
  case "$1" in
    --log) log="$2"; shift 2 ;;
    --exit) code="$2"; shift 2 ;;
    --import-done) done_mode="$2"; shift 2 ;;
    --kit-sync-done) kit_done_mode="$2"; shift 2 ;;
    *) break ;;
  esac
done
line=""
for a in "$@"; do line="$line$a|"; done
printf '%s env=%s\n' "$line" "${DESIGN_UI_EXPORT_DIR:-}" >> "$log"
# a successful capture call finishes like the Unity capture: its done marker in the output folder, written last
if [ "${1:-}" = capture ] && [ "$code" = 0 ] && [ -n "${DESIGN_UI_OUT_DIR:-}" ]; then
  mkdir -p "$DESIGN_UI_OUT_DIR"
  echo '{"runId":"stub","jobs":0,"captured":0,"notCaptured":0}' > "$DESIGN_UI_OUT_DIR/capture-done.json"
fi
if [ "${1:-}" = import ] && [ "$code" = 0 ] && [ -n "${DESIGN_UI_IMPORT_DONE:-}" ] && [ "$done_mode" != none ]; then
  sha="$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$DESIGN_UI_EXPORT_DIR/screen.ir.json")"
  [ "$done_mode" = wrong ] && sha="0000000000000000000000000000000000000000000000000000000000000000"
  printf '{"imports":[{"exportDir":"%s","code":0,"irSha":"%s"}]}\n' "$DESIGN_UI_EXPORT_DIR" "$sha" > "$DESIGN_UI_IMPORT_DONE"
fi
if [ "${1:-}" = kitSync ] && [ "$code" = 0 ] && [ -n "${DESIGN_UI_KIT_SYNC_DONE:-}" ] && [ "$kit_done_mode" != none ]; then
  printf '{"kitSync":{"kitDir":"%s","code":0}}\n' "${DESIGN_UI_KIT_DIR:-}" > "$DESIGN_UI_KIT_SYNC_DONE"
fi
echo "stub-runner: called with $# arguments"
echo "stub-runner: done"
exit "$code"
