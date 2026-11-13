#!/bin/sh
# Test stand-in for a Unity command runner. Usage: stub-runner.sh --log <file> [--exit <code>] <args...>
# Appends one line per call to the log: the remaining arguments joined by "|", then the DESIGN_UI_EXPORT_DIR env value.
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
echo "stub-runner: called with $# arguments"
echo "stub-runner: done"
exit "$code"
