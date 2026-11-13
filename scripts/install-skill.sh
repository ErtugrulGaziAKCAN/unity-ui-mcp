#!/usr/bin/env bash
# Links the /unity-ui-mcp skill into the skill folders that exist: Claude Code (~/.claude/skills), Codex
# (~/.codex/skills) and Cursor (~/.cursor/skills). Only the link named unity-ui-mcp is created or replaced; other
# skills are never touched. Idempotent. --dry-run prints what would change.
set -euo pipefail

DRY=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  -h|--help) echo "Usage: scripts/install-skill.sh [--dry-run]"; exit 0 ;;
  *) echo "install-skill: unknown argument $1" >&2; exit 2 ;;
esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL="$REPO/skills/unity-ui-mcp"
[ -f "$SKILL/SKILL.md" ] || { echo "install-skill: $SKILL/SKILL.md not found" >&2; exit 2; }
: "${HOME:?HOME is not set}"

FOUND=0
for dir in "$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.cursor/skills"; do
  if [ ! -d "$dir" ]; then echo "  skipped: $dir does not exist (that client is not installed, or has no skill folder yet)"; continue; fi
  FOUND=1
  link="$dir/unity-ui-mcp"
  if [ -L "$link" ]; then
    if [ "$(readlink "$link")" = "$SKILL" ]; then
      echo "  already in place: $link"
      continue
    fi
    if [ "$DRY" = 1 ]; then echo "  would replace the link $link (now $(readlink "$link")) with a link to $SKILL"; continue; fi
    ln -sfn "$SKILL" "$link"
    echo "  change: replaced the link $link with a link to $SKILL"
  elif [ -e "$link" ]; then
    echo "  left alone: $link exists and is not a link (remove it yourself to use this repository's skill)"
  else
    if [ "$DRY" = 1 ]; then echo "  would link $link -> $SKILL"; continue; fi
    ln -s "$SKILL" "$link"
    echo "  change: link $link -> $SKILL"
  fi
done
[ "$FOUND" = 1 ] || echo "  no skill folder found (~/.claude/skills, ~/.codex/skills, ~/.cursor/skills); create the one your client reads and run this again"
