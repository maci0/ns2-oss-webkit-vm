#!/bin/sh
# Run one page and attach gdb to the WebKitWebProcess before the trigger.
#   thief-run.sh <page-url> <delay-ms> <harness-timeout-ms> <gdb-script>
set -u
PAGE=$1
DELAY=${2:-20000}
HTO=${3:-90000}
GDBSCRIPT=${4:-/home/maci/ns2-wk/poc/gdb-main.txt}

WK=${WK_ROOT:-$HOME/ns2-wk}
BUILD=${WK_BUILD:-$WK/build-noassert}
OUT=${HARNESS_OUT:-$WK/out/thief}
mkdir -p "$OUT"

export LD_LIBRARY_PATH="$WK/stage/usr/local/lib:$BUILD/lib"
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export GDK_BACKEND=x11
export ASAN_OPTIONS="detect_leaks=0:abort_on_error=0:disable_coredump=1:handle_segv=0:quarantine_size_mb=0:thread_local_quarantine_size_kb=0${ASAN_EXTRA:+:$ASAN_EXTRA}"

HARNESS_BIN=${HARNESS_BIN:-./harness-v19-noassert}
cd "$WK/poc" || exit 1
xvfb-run -a --server-args="-screen 0 1280x1024x24" \
    "$HARNESS_BIN" "$PAGE" "$HTO" >"$OUT/harness.log" 2>&1 &
HARNESS=$!

# Wait for the web process child of the harness.  Other webkit apps may be
# running, so pick the one that has *this* build's libwebkit mapped.
WP=
i=0
while [ $i -lt 100 ]; do
    for p in $(pgrep -f '/usr/local/libexec/webkit2gtk-4.1/WebKitWebProcess' 2>/dev/null); do
        if grep -qF "$WK/stage/usr/local/lib/libwebkit2gtk-4.1.so.0" /proc/$p/maps 2>/dev/null; then
            WP=$p
            break
        fi
    done
    [ -n "$WP" ] && break
    sleep 0.2
    i=$((i + 1))
done
if [ -z "$WP" ]; then
    echo "no web process found" >&2
    pkill -f uaf-late-spray
    exit 1
fi
echo "harness=$HARNESS webprocess=$WP"

timeout 150 sudo -n gdb -q -batch -x "$GDBSCRIPT" -p "$WP" 2>&1 | grep -vE '^\[|warning:|Thread debugging|Using host libthread' | head -120

kill "$HARNESS" 2>/dev/null
pkill -f "$PAGE" 2>/dev/null
