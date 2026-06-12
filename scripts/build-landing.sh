#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LANDING="$ROOT/landing-page"
EXT="$ROOT/screenClick"
CONFIG="$LANDING/site-config.json"
MANIFEST="$EXT/manifest.json"

if [[ ! -f "$MANIFEST" ]]; then
  echo "error: missing $MANIFEST" >&2
  exit 1
fi

VERSION="$(python3 - <<'PY' "$MANIFEST"
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])
PY
)"

python3 - <<'PY' "$CONFIG" "$VERSION"
import json, sys
path, version = sys.argv[1:3]
json.dump(
    {"downloadUrl": "screenclick.zip", "version": version},
    open(path, "w", encoding="utf-8"),
    indent=2,
)
print(f"updated {path}")
PY

python3 - <<'PY' "$LANDING/site-config.js" "$VERSION"
import sys
version = sys.argv[2]
js = f"""window.SCREENCLICK_SITE = Object.freeze({{
  downloadUrl: 'screenclick.zip',
  version: {version!r},
}});
"""
open(sys.argv[1], "w", encoding="utf-8").write(js)
print(f"generated {sys.argv[1]}")
PY

python3 - <<'PY' "$LANDING/index.html" "$VERSION"
import re, sys
path, version = sys.argv[1:3]
html = open(path, encoding="utf-8").read()
html = re.sub(r'(<span>)v[\d.]+(</span>)', rf'\1v{version}\2', html, count=1)
open(path, "w", encoding="utf-8").write(html)
print(f"patched {path}")
PY

rm -f "$LANDING/screenclick.zip"
(
  cd "$ROOT"
  zip -r "$LANDING/screenclick.zip" screenClick -x "*.DS_Store" -x "*/.DS_Store" >/dev/null
)
echo "built $LANDING/screenclick.zip (v${VERSION})"
echo "landing page ready"
