#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${1:-http://127.0.0.1:8088}"

curl -sf "$BASE/healthz" | grep -q ok
MANIFEST_PATH="$(
  curl -sf "$BASE/data/video-pool.json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('manifestDir'), 'missing manifestDir (run build or --split-existing)'
playlists = d.get('playlists') or []
assert playlists, 'no playlists in index'
pl = playlists[0]
m = pl.get('manifest')
assert m, 'playlist missing manifest'
path = m if m.startswith('data/') else 'data/' + m
print(path)
"
)"
curl -sf "$BASE/$MANIFEST_PATH" | python3 -c "
import sys, json
m = json.load(sys.stdin)
ids = m.get('videoIds') or []
assert len(ids) > 0, 'manifest has no videoIds'
"
HTML="$(curl -sf "$BASE/")"
echo "$HTML" | grep -q 'VidGrid'
echo "$HTML" | grep -qv '<<<<<<<'
echo "smoke ok: $BASE (manifest $MANIFEST_PATH)"
