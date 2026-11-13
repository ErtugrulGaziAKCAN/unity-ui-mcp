#!/bin/sh
# Test stand-in for a Unity command runner. Usage: stub-runner.sh --log <file> [--exit <code>] <args...>
# Appends one line per call to the log: the remaining arguments joined by "|", then the DESIGN_UI_EXPORT_DIR env value.
# A "capture" call that exits 0 writes capture-done.json into DESIGN_UI_OUT_DIR, as the Unity capture does.
log=""
code=0
while [ $# -gt 0 ]; do
  case "$1" in
    --log) log="$2"; shift 2 ;;
    --exit) code="$2"; shift 2 ;;
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
echo "stub-runner: called with $# arguments"
echo "stub-runner: done"
exit "$code"
