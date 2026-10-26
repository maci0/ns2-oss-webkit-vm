# ns2-oss-webkit-vm

Runbooks for running two aarch64 JavaScriptCore builds on an x86_64 host, in
Docker, under `qemu-user`, with JIT disabled:

1. **Upstream** `WebKit-7613.3.9` (pristine WebKit 613.3.9), `PORT=JSCOnly` —
   the test VM used for the heap-grooming, arbitrary-read and gdb work around
   `JSC::ErrorInstance::computeErrorInfo` (upstream `ade92866440`, WebKit bug
   267785).
2. **Vendor** `webkit_3.12.11` — the JavaScriptCore ACCESS ships in the Switch 2
   `SystemUpdate 23.0.0` open-source release, grafted onto the upstream 613.3.9
   build system so it can be compiled and run outside the console.

| document | what it covers |
|---|---|
| [VM-SETUP.md](VM-SETUP.md) | upstream VM: build, qemu-user run path, test families, gdb, pitfalls, smoke test |
| [NINTENDO-BUILD.md](NINTENDO-BUILD.md) | vendor build: what the drop contains, the graft, the 11-file build patch, build and tests |

## Layout

```
vm/           Dockerfiles (release, DeferGC control, debug) + repro/gdb scripts
nintendo/     Dockerfile, graft.sh, patches/0001-build-shims.patch,
              upstream/ (613.3.9 cmake/bmalloc/gtest scaffolding), smoke tests
```

The vendor modules (`webkit_3.12.11/{JavaScriptCore,WTF}`) are **not** in this
repository; see NINTENDO-BUILD.md §2. Neither are the research harnesses
(`oss/vm/`, `ns2jb-webkit/`, the scratch scripts in `/tmp/opencode/`); the
documents give their contents where needed.

## Quick start — upstream

```sh
cd vm
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

## Quick start — vendor JSC 3.12.11

```sh
mkdir -p nintendo/vendor
cp -a <drop>/webkit_3.12.11/{JavaScriptCore,WTF} nintendo/vendor/
docker build --platform linux/arm64 -f nintendo/Dockerfile -t ns2jsc-fork nintendo
docker run --rm ns2jsc-fork
```

Expected: the four `test-smoke.js` lines, ending in `error.stack=`.

## Scope

Documentation of a local test environment for public WebKit sources and an
open-source vendor drop: no payloads, no target binaries, no keys.
