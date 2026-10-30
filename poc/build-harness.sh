#!/bin/sh
# Build the page harness against the v19-equivalent WebKitGTK 2.40.5 tree.
#
#   build-harness.sh [build-dir] [out-binary]
#
# Requires that `ninja MiniBrowser` has already succeeded in <build-dir>.
# Headers, the .pc file, the injected bundle and the web process binary are
# staged under <build-dir>/../stage.
#
# Two things are needed at run time that WebKitGTK 2.40.5 compiles in as
# absolute paths (it is built without ENABLE_DEVELOPER_MODE, so the
# WEBKIT_EXEC_PATH / WEBKIT_INJECTED_BUNDLE_PATH overrides are compiled out):
#
#   /usr/local/libexec/webkit2gtk-4.1  -> <stage>/usr/local/libexec/webkit2gtk-4.1
#   /usr/local/lib/webkit2gtk-4.1      -> <stage>/usr/local/lib/webkit2gtk-4.1
#
# This script creates both symlinks if they are missing (needs sudo), then
# compiles the harness with ASAN and an rpath into the staged lib directory.
set -eu

WK=${WK_ROOT:-$HOME/ns2-wk}
BUILD=${1:-$WK/build}
OUT=${2:-$WK/poc/harness-v19}
STAGE=$BUILD/../stage
SRC=$WK/poc/harness.c

[ -f "$BUILD/lib/libwebkit2gtk-4.1.so" ] || {
    echo "no libwebkit2gtk-4.1.so in $BUILD/lib -- build first" >&2
    exit 1
}

# 1. stage install (headers, pc file, injected bundle, web process layout)
DESTDIR=$STAGE ninja -C "$BUILD" install >"$WK/logs/install.log" 2>&1 || {
    echo "install failed, see $WK/logs/install.log" >&2
    exit 1
}

# 2. absolute paths compiled into the library
for pair in \
    "/usr/local/libexec/webkit2gtk-4.1:$STAGE/usr/local/libexec/webkit2gtk-4.1" \
    "/usr/local/lib/webkit2gtk-4.1:$STAGE/usr/local/lib/webkit2gtk-4.1"
do
    link=${pair%%:*}
    target=${pair#*:}
    [ -e "$target" ] || { echo "missing staged dir $target" >&2; exit 1; }
    if [ ! -e "$link" ]; then
        sudo mkdir -p "$(dirname "$link")"
        sudo ln -s "$target" "$link"
        echo "linked $link -> $target"
    fi
done

# 3. compile the harness
PKG_CONFIG_PATH=$STAGE/usr/local/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}
export PKG_CONFIG_PATH
CFLAGS=$(pkg-config --define-prefix --cflags webkit2gtk-4.1)
LIBS=$(pkg-config --define-prefix --libs webkit2gtk-4.1)

# shellcheck disable=SC2086
cc -g -O0 -fsanitize=address -fno-omit-frame-pointer \
   -o "$OUT" "$SRC" $CFLAGS $LIBS \
   -Wl,-rpath,"$STAGE/usr/local/lib" -Wl,-rpath,"$BUILD/lib"

echo "built $OUT"
echo "run with: LD_LIBRARY_PATH=$STAGE/usr/local/lib:$BUILD/lib HARNESS_OUT=... $OUT page.html"
