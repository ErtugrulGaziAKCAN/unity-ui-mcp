#!/usr/bin/env bash
# Runs unity-clone-test on samples/FidelityProject. The clone lives outside the repo, so the relative
# file: package reference is temporarily rewritten to an absolute path and restored afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/samples/FidelityProject/Packages/manifest.json"
REL='"com.ertugrulgaziakcan.design-ui": "file:../../../packages/com.ertugrulgaziakcan.design-ui"'
ABS="\"com.ertugrulgaziakcan.design-ui\": \"file:$ROOT/packages/com.ertugrulgaziakcan.design-ui\""

if ! grep -qF -- "$REL" "$MANIFEST"; then
  echo "unity-check: manifest entry is not the expected relative value:" >&2
  echo "  expected: $REL" >&2
  echo "  in:       $MANIFEST" >&2
  echo "  A previous run may have crashed; restore it with: git checkout -- samples/FidelityProject/Packages/manifest.json" >&2
  exit 2
fi

BACKUP="$(mktemp "${TMPDIR:-/tmp}/unity-check-manifest.XXXXXX")"
cp -p "$MANIFEST" "$BACKUP"
restore() {
  cp -p "$BACKUP" "$MANIFEST"
  rm -f "$BACKUP"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

python3 - "$MANIFEST" "$REL" "$ABS" <<'P'
import sys
path, rel, ab = sys.argv[1:4]
data = open(path, "rb").read().decode("utf-8")
open(path, "wb").write(data.replace(rel, ab, 1).encode("utf-8"))
P

# a test that switches Enable Advanced Text makes Unity rewrite every PanelSettings asset, the package's too; it restores
# them, and a run that leaves the package's asset changed says so
PS="packages/com.ertugrulgaziakcan.design-ui/Runtime/Themes/DesignUiPanelSettings.asset"
clean_before=0; git -C "$ROOT" diff --quiet -- "$PS" 2>/dev/null && clean_before=1
set +e
"$HOME/unity-clone-test/bin/unity-clone-test" --project "$ROOT/samples/FidelityProject" "$@"
rc=$?
set -e
if [ "$clean_before" = 1 ] && ! git -C "$ROOT" diff --quiet -- "$PS" 2>/dev/null; then
  echo "unity-check: warning: the run changed $PS (a test did not restore it); check it with git diff and restore it with git checkout" >&2
fi
exit "$rc"
