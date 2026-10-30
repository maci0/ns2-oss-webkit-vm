#!/bin/sh
# Run every page in this directory through one harness build, sequentially,
# each in its own Xvfb server and its own $HARNESS_OUT.
#
#   run-all.sh <built-tree-name> <harness binary> [timeout_ms]
#   e.g. run-all.sh v19-secure ./harness-v19 8000
set -u

TAG=$1
HARNESS=$2
TIMEOUT=${3:-8000}
HERE=$(cd "$(dirname "$0")" && pwd)

for page in uaf-canvas feconvolve-target fedisplacement-selector transform-gate; do
    out=$HOME/ns2-wk/out/$TAG-$page
    mkdir -p "$out"
    printf '\n########## %s -> %s\n' "$page" "$out"
    HARNESS_OUT=$out sh "$HERE/run.sh" "$HARNESS" "$HERE/$page.html" "$TIMEOUT"
done
