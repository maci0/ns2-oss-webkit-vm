# ns2-oss-webkit-vm

Runbook for the aarch64 JavaScriptCore test VM used in this WebKit research:
pristine upstream **WebKit 613.3.9** (`WebKit-7613.3.9`), `PORT=JSCOnly`,
`linux/arm64`, built in Docker and run on an x86_64 host under `qemu-user`
with JIT disabled.

It reproduces the GC re-entrancy in `JSC::ErrorInstance::computeErrorInfo`
(upstream `ade92866440`, WebKit bug 267785) and documents how the
heap-grooming, arbitrary-read and gdb experiments around it were run.

**→ [VM-SETUP.md](VM-SETUP.md)**

## What is in here

Only the runbook. It covers:

1. prerequisites (host, docker, qemu-user 11.1.2, gdb, disk);
2. the exact `docker build` and what the Dockerfile does, with measured build
   times, plus the patched control (`DeferGC`) and the debug build;
3. the fast qemu-user path (`docker export` rootfs, `-L`, `--useJIT=false`,
   `ulimit -c 0`) and why JIT must be off;
4. running the repro and the page test families via `load()` +
   `Ns2Webkit.runFamily(...)`, and the `--useConcurrentGC=false` determinism
   flag;
5. host gdb over the qemu gdbstub, including what the captured backtraces show;
6. the sweep and grooming scripts and how results were recorded (including
   which result files were never preserved);
7. known pitfalls: the JIT startup crash, qemu SIMD artifacts, symbol-less
   Release builds, GC timing, and what did and did not transfer from this
   upstream build to the console fork;
8. a five-step smoke test.

The scripts and harnesses it references (`oss/vm/`, `ns2jb-webkit/`, and the
scratch harnesses in `/tmp/opencode/`) are part of the private research tree
and are not published here; the document gives their contents where they are
needed.

## Quick start

```sh
cd oss/vm
docker build --platform linux/arm64 -f Dockerfile -t ns2jsc .
```

```sh
ROOT=/tmp/opencode/jscroot
docker create --name jscroot_tmp ns2jsc
docker export jscroot_tmp | tar -C $ROOT -xf -
docker rm jscroot_tmp
ulimit -c 0
qemu-aarch64 -L $ROOT $ROOT/usr/local/bin/jsc --useJIT=false -e 'print(1+1)'
```

Expected: `2`.

## Scope

Documentation of a local test environment for upstream WebKit, not a
console exploit chain: no payloads, no target binaries, no keys. All upstream
commits referenced are public.
