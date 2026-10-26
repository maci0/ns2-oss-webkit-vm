#!/usr/bin/env bash
# Assemble a buildable WebKit tree from the ACCESS/NetFront (Nintendo) source
# drop plus the upstream 613.3.9 build scaffolding, then apply the build shims.
#
#   UPSTREAM=/upstream VENDOR=/vendor OUT=/src PATCHES=/patches /graft.sh
#
# UPSTREAM must contain CMakeLists.txt and Source/{CMakeLists.txt,cmake,bmalloc,
# ThirdParty/gtest}. VENDOR must contain webkit_3.12.11/{JavaScriptCore,WTF} or
# the two directories directly. Everything is copied; the inputs are untouched.
set -euo pipefail

UPSTREAM=${UPSTREAM:-/upstream}
VENDOR=${VENDOR:-/vendor}
OUT=${OUT:-/src}
PATCHES=${PATCHES:-/patches}

find_vendor() {
    local d
    for d in "$VENDOR/webkit_3.12.11" "$VENDOR"; do
        if [ -d "$d/JavaScriptCore" ] && [ -d "$d/WTF" ]; then
            printf '%s\n' "$d"
            return 0
        fi
    done
    echo "graft.sh: no JavaScriptCore/ and WTF/ under $VENDOR" >&2
    return 1
}

V=$(find_vendor)

echo "graft.sh: upstream = $UPSTREAM"
echo "graft.sh: vendor   = $V"
echo "graft.sh: output   = $OUT"

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$UPSTREAM/CMakeLists.txt" "$OUT/CMakeLists.txt"
cp -a "$UPSTREAM/Source" "$OUT/Source"

# The vendor drop is a flattened WebKit tree: JavaScriptCore/ and WTF/ live at
# its root, there is no Source/ and no bmalloc. Replace the upstream modules.
rm -rf "$OUT/Source/JavaScriptCore" "$OUT/Source/WTF"
cp -a "$V/JavaScriptCore" "$OUT/Source/JavaScriptCore"
cp -a "$V/WTF" "$OUT/Source/WTF"

chmod -R u+w "$OUT"

# Build shims: WKCStd namespace, WKC i18n fallbacks, two missing includes and
# one header-install entry. See NINTENDO-BUILD.md section 3.
patch -d "$OUT" -p1 --no-backup-if-mismatch -i "$PATCHES/0001-build-shims.patch"

echo "graft.sh: done"
find "$OUT/Source/JavaScriptCore" -name '*.cpp' | wc -l | xargs echo "graft.sh: JavaScriptCore .cpp files:"
find "$OUT/Source/WTF" -name '*.cpp' | wc -l | xargs echo "graft.sh: WTF .cpp files:"
