#!/usr/bin/env bash
# Publish dist/ to the gh-pages branch as one fresh commit, replacing the
# branch so that old builds do not stay in its history.
#
#   tools/publish.sh "commit message"
#
# Refuses to publish an unlocked build while site.config.json says the site
# is locked.
set -euo pipefail
cd "$(dirname "$0")/.."
REMOTE=${PAGES_REMOTE:-https://github.com/Alekxos/mckeehan_family}
MSG=${1:-Publish built site}

locked=$(node -e "const c=require('./site.config.json');process.stdout.write(c.lock&&c.lock.enabled?'yes':'no')")
if [ "$locked" = yes ]; then
  [ -f dist/lock.json ] || { echo "dist/ is not locked. Build without --no-lock before publishing." >&2; exit 1; }
  plain=$(find dist \( -path dist/data -o -path dist/media -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' -o -iname '*.pdf' -o -name 'family.json' \) -print | head -5)
  [ -z "$plain" ] || { echo "Unencrypted family files in dist/, not publishing:" >&2; echo "$plain" >&2; exit 1; }
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -r dist/. "$tmp"/
rm -f "$tmp/preview.html"
cd "$tmp"
git init -q -b gh-pages
git add -A
git commit -q -m "$MSG"
for i in 1 2 3 4; do git push -f "$REMOTE" gh-pages && break; sleep $((i * 2)); done
git rev-parse --short HEAD
