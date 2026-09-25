#!/bin/bash
# Stages exactly the files GitHub Pages served (tracked + new, not ignored) into portal/.site,
# minus repo plumbing, the portal's own source, and iCloud "name 2" duplicates. The Worker's assets come only from here.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf portal/.site && mkdir -p portal/.site
git ls-files -co --exclude-standard -z \
  | grep -zvE '^(portal/|\.github/|\.gitignore$|\.assetsignore$|CNAME$)' \
  | grep -zvE ' 2(\.[A-Za-z0-9]+)?(/|$)' \
  | xargs -0 -I{} rsync -R "{}" portal/.site/
cp portal/_headers portal/.site/_headers
echo "staged $(find portal/.site -type f | wc -l | tr -d ' ') files"
