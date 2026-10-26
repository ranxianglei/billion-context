#!/usr/bin/env bash
set -euo pipefail

BRANCH="${1:-}"
BASE="${2:-master}"

if [ -z "$BRANCH" ]; then
  echo "Usage: check-pr.sh <branch-name> [base-branch]"
  exit 1
fi

echo "Checking branch: $BRANCH (base: $BASE)"

# Branch name must match YYYY-MM-DD_short-title
if ! echo "$BRANCH" | grep -qP '^\d{4}-\d{2}-\d{2}_[a-z0-9.-]+$'; then
  echo "::error::Branch name must match YYYY-MM-DD_short-title (got: $BRANCH)"
  exit 1
fi
echo ":: Branch name OK"

# Version must not change on non-release branches
if ! echo "$BRANCH" | grep -qP '_release-v'; then
  if [ -f package.json ]; then
    VERSION_CHANGE=$(git diff "origin/$BASE...HEAD" -- package.json | grep -E '^[+-]\s*"version"' || true)
    if [ -n "$VERSION_CHANGE" ]; then
      echo "::error::Version must not change on non-release branches (got: $VERSION_CHANGE)"
      exit 1
    fi
  fi
fi
echo ":: Version check OK"

echo "All checks passed."
