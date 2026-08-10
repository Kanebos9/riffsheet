#!/bin/bash
# Run the vitest suite WITHOUT Node.js.
#
# Where Node is not installed, `vitest run` cannot start. This script bundles the same
# test/*.test.ts files with esbuild (a native binary) and runs them under JavaScriptCore
# (`jsc`, which ships with macOS), aliasing the `vitest` import to scripts/jsc-shim.ts.
#
# The test files are identical either way. On a machine with Node, `npm test` is the normal
# path and this script is unnecessary.
#
# Usage:  scripts/run-tests.sh [name-filter]

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
OUT="${TMPDIR:-/tmp}/riffsheet-pipeline-tests"

if [ ! -x "${ESBUILD:-}" ]; then echo "esbuild not found (install dependencies or set ESBUILD=)" >&2; exit 127; fi
if [ ! -x "${JSC:-}" ]; then echo "jsc not found (set JSC=)" >&2; exit 127; fi

mkdir -p "$OUT"
FILTER="${1:-}"

ENTRY="$OUT/entry.ts"
{
  echo "import { runAll } from '${ROOT}/scripts/jsc-shim.ts';"
  for f in test/*.test.ts; do
    [ -e "$f" ] || continue
    if [ -n "$FILTER" ] && [[ "$f" != *"$FILTER"* ]]; then continue; fi
    echo "import '${ROOT}/$f';"
  done
  # Top-level await makes a rejected async test fail JSC and this shell process. Calling the
  # promise without awaiting it produced false-green runs whenever an async assertion failed.
  echo "await runAll();"
} > "$ENTRY"

"$ESBUILD" "$ENTRY" \
  --bundle \
  --format=esm \
  --target=es2022 \
  --platform=neutral \
  --alias:vitest="${ROOT}/scripts/jsc-shim.ts" \
  --outfile="$OUT/bundle.js" \
  --log-level=warning

"$JSC" --module-file="$OUT/bundle.js"
