#!/usr/bin/env bash
# Push this repo to a new GitHub repository using GitHub CLI.
#
# Security: do NOT paste tokens into Cursor chat. Prefer: gh auth login (browser).
# If you must use a PAT file, run this script only in Terminal.app / iTerm (not logged here).
#
# Usage:
#   export GH_TOKEN="$(cat /path/to/token.txt)"   # or: gh auth login
#   ./scripts/gh-push.sh [repo-name]
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REPO_NAME="${1:-pi-loop-recovery-extensions}"
GH_BIN="${GH_BIN:-/opt/homebrew/bin/gh}"

if ! command -v "$GH_BIN" >/dev/null 2>&1; then
  echo "Install GitHub CLI: brew install gh" >&2
  exit 1
fi

if ! "$GH_BIN" auth status >/dev/null 2>&1; then
  if [[ -z "${GH_TOKEN:-}" ]]; then
    echo "Not logged in. Run one of:" >&2
    echo "  $GH_BIN auth login" >&2
    echo "  export GH_TOKEN=... && printf '%s\\n' \"\$GH_TOKEN\" | $GH_BIN auth login --hostname github.com --with-token" >&2
    exit 1
  fi
  printf '%s\n' "$GH_TOKEN" | "$GH_BIN" auth login --hostname github.com --with-token
fi

LOGIN="$("$GH_BIN" api user -q .login)"
FULL="$LOGIN/$REPO_NAME"

if "$GH_BIN" repo view "$FULL" >/dev/null 2>&1; then
  echo "Remote repo exists: $FULL — pushing to origin"
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/$FULL.git"
  git push -u origin main
else
  echo "Creating $FULL and pushing..."
  "$GH_BIN" repo create "$FULL" --public --source=. --remote=origin --push
fi

echo "Done: https://github.com/$FULL"
