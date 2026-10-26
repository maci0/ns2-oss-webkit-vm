#!/usr/bin/env bash
# Sweep for the ErrorInstance::computeErrorInfo GC re-entrancy bug (ade92866440).
# Runs inside the ns2jsc aarch64 container. Every attempt is a separate jsc
# process, so a crash only terminates that attempt.
#
# Usage: OUT=/out/sweep-results.json JSC=jsc /opt/sweep.sh
set -u

JSC="${JSC:-jsc}"
OUT="${OUT:-/out/sweep-results.json}"
TIMEOUT_READSTACK="${TIMEOUT_READSTACK:-600}"
TIMEOUT_FINALIZER="${TIMEOUT_FINALIZER:-300}"
TMP="$(mktemp -d)"
RES="$TMP/results.tsv"
: > "$RES"

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

gen_readstack() {
    python3 - "$1" "${2:-100}" "${3:-1048576}" <<'PY'
import sys
path, depth, length = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
src = """const NUM_NESTED_FUNCTIONS = %d;
const NAME_LEN = %d;
function main() {
    const error = (new Function(`return (function () { arguments.callee.displayName = 'a'.repeat(NAME_LEN) + 'b'; `.repeat(NUM_NESTED_FUNCTIONS) + `return new Error();` + ` })();`.repeat(NUM_NESTED_FUNCTIONS)))();
    error.stack;
    print("completed");
}
main();
""" % (depth, length)
open(path, "w").write(src)
PY
}

gen_finalizer() {
    python3 - "$1" "${2:-8}" "${3:-4}" "${4:-65536}" <<'PY'
import sys
path, depth, nerrs, groom = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
src = """const DEPTH = %d;
const NUM_ERRORS = %d;
const GROOM = %d;

function makeNestedError() {
    let src = "";
    for (let i = 0; i < DEPTH; i++)
        src += "(function f" + i + "() { ";
    src += "return new Error('boom');";
    for (let i = 0; i < DEPTH; i++)
        src += " })()";
    return (new Function(src))();
}

let errors = [];
for (let i = 0; i < NUM_ERRORS; i++)
    errors.push(makeNestedError());
errors = null;

let groom = [];
for (let i = 0; i < GROOM; i++)
    groom.push({ i: i, s: "x" + i, a: [i, i + 1] });
gc();
for (let i = 0; i < GROOM; i++)
    groom.push({ i: i, s: "y" + i, a: [i + 2] });
gc();

print("completed");
""" % (depth, nerrs, groom)
open(path, "w").write(src)
PY
}

run_attempt() {
    local kind="$1" id="$2" depth="$3" param="$4" limit="$5" file="$6"
    local start end dur rc sig name err
    start=$(date +%s%N)
    timeout --signal=KILL "${limit}s" "$JSC" "$file" >"$TMP/stdout" 2>"$TMP/stderr"
    rc=$?
    end=$(date +%s%N)
    dur=$(( (end - start) / 1000000 ))
    sig=0
    name=""
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
        name="TIMEOUT"
    elif [ "$rc" -ge 128 ]; then
        sig=$((rc - 128))
        name=$(python3 -c 'import signal,sys; s=int(sys.argv[1]); print(signal.Signals(s).name if s in [x.value for x in signal.Signals] else "SIG%d" % s)' "$sig" 2>/dev/null || echo "SIG$sig")
    fi
    err=$(tr '\n\t' '  ' < "$TMP/stderr" | cut -c1-400)
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$kind" "$id" "$depth" "$param" "$rc" "$sig" "$name" "$limit" "$dur" "$err" >> "$RES"
    printf '%-16s id=%-2s depth=%-4s param=%-9s rc=%-4s %-9s %7sms\n' \
        "$kind" "$id" "$depth" "$param" "$rc" "${name:-ok}" "$dur"
}

echo "jsc: $(command -v "$JSC")"
"$JSC" --version 2>&1 | head -3 || true
echo "uname: $(uname -m)"

# Ladder 1: read-stack path. Depth 100, growing displayName.
id=0
for len in 16384 32768 49152 65536 98304 131072 262144 1048576; do
    file="$TMP/readstack_${len}.js"
    gen_readstack "$file" 100 "$len"
    id=$((id + 1))
    run_attempt read-stack "$id" 100 "$len" "$TIMEOUT_READSTACK" "$file"
done

# Upstream regression test (same parameters as read-stack max).
run_attempt upstream-test 1 100 1048576 "$TIMEOUT_READSTACK" /opt/error-instance.js

# Ladder 2: finalizer path. Depth 8, doubling error counts, large groom.
id=0
for n in 4 8 16 32 64 128 256 512 1024 2048 4096 8192; do
    file="$TMP/finalizer_${n}.js"
    gen_finalizer "$file" 8 "$n" 65536
    id=$((id + 1))
    run_attempt finalizer "$id" 8 "$n" "$TIMEOUT_FINALIZER" "$file"
done

python3 - "$RES" "$OUT" <<'PY'
import json, os, platform, signal, sys, time
res_path, out_path = sys.argv[1], sys.argv[2]
rows = []
with open(res_path) as f:
    for line in f:
        p = line.rstrip("\n").split("\t")
        if len(p) != 10:
            continue
        kind, aid, depth, param, rc, sig, name, limit, dur, err = p
        rows.append({
            "kind": kind,
            "id": int(aid),
            "depth": int(depth),
            "param": int(param),
            "exit_code": int(rc),
            "signal": int(sig),
            "signal_name": name,
            "timeout_s": int(limit),
            "duration_ms": int(dur),
            "stderr_tail": err,
            "crashed": int(rc) >= 128 and name != "TIMEOUT",
            "timed_out": name == "TIMEOUT",
        })
summary = {
    "attempts": len(rows),
    "crashes": sum(1 for r in rows if r["crashed"]),
    "timeouts": sum(1 for r in rows if r["timed_out"]),
    "clean_exits": sum(1 for r in rows if r["exit_code"] == 0 and not r["timed_out"]),
}
doc = {
    "bug": "ErrorInstance::computeErrorInfo GC re-entrancy (upstream ade92866440)",
    "source": "WebKit-7613.3.9 (613.3.9), JSCOnly aarch64, qemu binfmt",
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "host": platform.platform(),
    "summary": summary,
    "results": rows,
}
os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
with open(out_path, "w") as f:
    json.dump(doc, f, indent=2)
print("\nSummary:", json.dumps(summary))
print("Wrote", out_path)
PY
