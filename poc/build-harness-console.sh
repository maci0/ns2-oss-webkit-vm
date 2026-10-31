#!/bin/sh
# Build the page harness against a NON-ASAN build (e.g. build-console).
#   build-harness-console.sh [build-dir] [out-binary]
# The staged install must already be current (ninja install with DESTDIR=<build>/../stage).
set -eu
WK=${WK_ROOT:-$HOME/ns2-wk}
BUILD=${1:-$WK/build-console}
OUT=${2:-$WK/poc/harness-v19-console}
STAGE=$BUILD/../stage
SRC=$WK/poc/harness.c

PKG_CONFIG_PATH=$STAGE/usr/local/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}
export PKG_CONFIG_PATH
CFLAGS=$(pkg-config --define-prefix --cflags webkit2gtk-4.1)
LIBS=$(pkg-config --define-prefix --libs webkit2gtk-4.1)

# shellcheck disable=SC2086
cc -g -O0 -fno-omit-frame-pointer -o "$OUT" "$SRC" $CFLAGS $LIBS \
   -Wl,-rpath,"$STAGE/usr/local/lib" -Wl,-rpath,"$BUILD/lib"
echo "built $OUT"
