#!/bin/bash
# Regenerate the golden MusicXML fixtures.
#
#   scripts/update-golden.sh              regenerate all
#   scripts/update-golden.sh pickup       regenerate one
#
# A diff in test/golden/*.ts is a real behaviour change. Read it before committing.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [ -z "${ESBUILD:-}" ]; then
  for candidate in "$ROOT/node_modules/.bin/esbuild" "$ROOT/../webcore/node_modules/.bin/esbuild"; do
    if [ -x "$candidate" ]; then ESBUILD="$candidate"; break; fi
  done
  if [ -z "${ESBUILD:-}" ]; then ESBUILD="$(command -v esbuild || true)"; fi
fi
if [ -z "${JSC:-}" ]; then
  JSC="$(command -v jsc || true)"
  if [ -z "$JSC" ] && [ -x /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc ]; then
    JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
  fi
fi
if [ ! -x "${ESBUILD:-}" ]; then echo "esbuild not found (install dependencies or set ESBUILD=)" >&2; exit 127; fi
if [ ! -x "${JSC:-}" ]; then echo "jsc not found (set JSC=)" >&2; exit 127; fi
OUT="${TMPDIR:-/tmp}/riffsheet-golden"
mkdir -p "$OUT" test/golden

CASES=("straight-eighths" "external-grid" "pickup")
if [ $# -gt 0 ]; then CASES=("$@"); fi

for name in "${CASES[@]}"; do
  echo "import '${ROOT}/scripts/update-golden.ts';" > "$OUT/entry.ts"
  "$ESBUILD" "$OUT/entry.ts" --bundle --format=esm --target=es2022 --platform=neutral \
    --define:GOLDEN_CASE_NAME="\"${name}\"" \
    --outfile="$OUT/gen.js" --log-level=warning
  temp_fixture="$OUT/${name}.ts"
  "$JSC" --module-file="$OUT/gen.js" > "$temp_fixture"
  mv "$temp_fixture" "test/golden/${name}.ts"
  echo "wrote test/golden/${name}.ts ($(wc -l < "test/golden/${name}.ts") lines)"
done
