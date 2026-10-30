#!/bin/sh
# Run one PoC page through the harness under Xvfb.
#   run.sh <harness binary> <page.html> [timeout_ms]
# Full output -> $HARNESS_OUT/run.log; a filtered summary goes to stdout.
set -u

HARNESS=$1
PAGE=$2
TIMEOUT=${3:-6000}
OUT=${HARNESS_OUT:-$HOME/ns2-wk/out}
case "$PAGE" in /*) ;; *) PAGE=$(realpath "$PAGE");; esac
mkdir -p "$OUT"

export HARNESS_OUT="$OUT"
export ASAN_OPTIONS="detect_leaks=0:abort_on_error=0:disable_coredump=1:handle_segv=1:symbolize=1${ASAN_EXTRA:+:$ASAN_EXTRA}"
export UBSAN_OPTIONS="print_stacktrace=1"
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export GDK_BACKEND=x11

xvfb-run -a --server-args="-screen 0 1280x1024x24" \
    "$HARNESS" "$PAGE" "$TIMEOUT" >"$OUT/run.log" 2>&1
echo "exit=$?"
echo "=== page log ==="
grep -E "^(CONSOLE|TITLE|HARNESS):" "$OUT/run.log" | head -40
echo "=== sanitizer ==="
grep -E "AddressSanitizer|SUMMARY:|use-after-free|heap-buffer-overflow|SEGV on unknown|#[0-9]+ 0x" "$OUT/run.log" | head -40
echo "=== full log: $OUT/run.log ==="
