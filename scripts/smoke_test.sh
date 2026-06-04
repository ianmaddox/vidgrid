#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${1:-http://127.0.0.1:8088}"

curl -sf "$BASE/healthz" | grep -q ok
curl -sf "$BASE/data/video-pool.json" | python3 -c "import sys,json; d=json.load(sys.stdin); assert len(d['videoIds'])>0"
HTML="$(curl -sf "$BASE/")"
echo "$HTML" | grep -q 'VidGrid'
echo "$HTML" | grep -qv '<<<<<<<'
echo "smoke ok: $BASE"
