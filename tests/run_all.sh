#!/bin/sh
# All rook-reflex tests. Exit non-zero on any failure.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
echo "--- node --test (router + hook harness)"
node --test "$HERE/test_router.mjs" "$HERE/test_hooks.mjs"
echo "--- python truth-table driver"
/usr/bin/python3 "$HERE/test_router.py"
