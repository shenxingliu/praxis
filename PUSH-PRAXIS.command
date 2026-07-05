#!/bin/bash
# Praxis push script — run from anywhere. Creates the GitHub repo remote if
# needed, clears sandbox lock files, commits everything, pushes.
set -e
cd "$(dirname "$0")"
find .git -name "*.lock" -delete 2>/dev/null || true
find .git -name "tmp_obj_*" -delete 2>/dev/null || true
git add -A
git commit -m "${1:-praxis: update}" || echo "(nothing to commit)"
if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin https://github.com/shenxingliu/praxis.git
fi
git branch -M main
git push -u origin main
echo "== DONE — pushed Praxis to GitHub =="
