# aarch64 JavaScriptCore from the Nintendo / ACCESS WebKit 3.12.11 drop

Builds `jsc` from the JavaScriptCore that ACCESS ships in the Switch 2
`SystemUpdate 23.0.0` open-source release (`webkit_3.12.11`), on
`linux/arm64`, `PORT=JSCOnly`, in Docker.

This is the console fork of the same code base as [VM-SETUP.md](VM-SETUP.md)
(upstream 613.3.9, `WebKit-7613.3.9`): identical file layout, identical source
file list, ACCESS modifications inline under `PLATFORM(WKC)` / `WKC_USE_ICU`.
The point of this document is that the fork can be compiled and executed on a
host, so the JSC-only findings from the upstream VM can be checked against the
vendor code instead of being assumed.

## 1. What the drop contains

`oss/ns2-23/NS2_23.0.0/` is the ACCESS NetFront Browser NX source release.
The header says it plainly:

```
OSS Copyright of NetFront Browser NX
Copyright (c) 2023-2026 ACCESS CO., LTD. All rights reserved.
Some files in this package were modified by ACCESS CO., LTD.
```

Relevant directories:

| directory | size | contents |
|---|---|---|
| `webkit_3.12.11/JavaScriptCore` | 83 MB | JSC, 1159 `.cpp` |
| `webkit_3.12.11/WTF` | 16 MB | WTF, 195 `.cpp` |
| `webkit_3.12.11/WebCore` | 236 MB | WebCore (not built here) |
| `webkit_3.12.11/WebKitLegacy` | 20 MB | WebKit1 API |
| `webkit_3.12.11/WebInspectorUI` | 24 MB | inspector front end |
| `webkit_3.12.11/WebDriver`, `WebGPU` | < 1 MB | |
| `WKC_3.12.11/include/wkc` | | 24 SDK headers, `wkcLoggingPeer()` etc. |
| `WKC_3.12.11/{system,WTF,JavaScriptCore}` | 5.1 MB | WKC glue sources |
| `WebKitLibraries_3.12.11` | 141 MB | cairo, freetype, harfbuzz, nghttp3, ngtcp2 |

Two properties matter for building:

**The WKC layer is an interface, not an implementation.** The headers in
`WKC_3.12.11/include/wkc/` declare peer functions (`wkcLoggingPeer`,
`wkcMallocPeer`, ...) with `WKC_PEER_API`; the definitions live in the console
system binaries, which are not part of the OSS drop. That is the whole design:
WebKit calls into the platform through these peers. So `PLATFORM(WKC)` code
paths cannot be linked here, and this build uses the same configuration WebKit
uses everywhere else, `PLATFORM(WKC)=0`.

**The tree is flattened.** There is no top-level `CMakeLists.txt`, no
`Source/`, no `Source/cmake` modules, no `Source/bmalloc`, no
`Source/ThirdParty/gtest`. The fork predates the current WebKit build layout and
is built by ACCESS with its own (non-published) makefiles and the WKC SDK
prefixed headers. Relative to upstream 613.3.9, the file sets under
`JavaScriptCore/` and `WTF/` are **identical** — zero files added, zero removed:

```sh
comm -3 <(cd vendor/JavaScriptCore && find . -name '*.[ch]pp' | sort) \
        <(cd upstream/Source/JavaScriptCore && find . -name '*.[ch]pp' | sort) | wc -l
# 0
```

The ACCESS changes are therefore all in-file, which is why a small patch can
make the vendor code build against stock WebKit plumbing.

## 2. Getting the vendor tree

The vendor sources are not redistributed in this repository. Take
`webkit_3.12.11` from your own copy of the SystemUpdate 23.0.0 OSS release and
put the two modules this build needs into the Docker context:

```sh
mkdir -p nintendo/vendor
cp -a /path/to/oss/ns2-23/NS2_23.0.0/webkit_3.12.11/JavaScriptCore \
      /path/to/oss/ns2-23/NS2_23.0.0/webkit_3.12.11/WTF \
      nintendo/vendor/
```

That is ~99 MB / 1354 `.cpp` files. `nintendo/vendor/` is git-ignored; nothing
ACCESS-derived is committed. `graft.sh` also accepts the modules under
`vendor/webkit_3.12.11/` if you keep the directory shape.

## 3. The graft

`graft.sh` produces the buildable tree from two inputs:

```
upstream/Source/{cmake,bmalloc,ThirdParty/gtest}   +  upstream/CMakeLists.txt
                        |
                        +  vendor/{JavaScriptCore,WTF}
                        |
                        v
                    /src  (what cmake sees)
```

- The **upstream 613.3.9 build system** is the right donor: same version, same
  module boundaries, same `Source/WTF/CMakeLists.txt` variables
  (`WTF_PUBLIC_HEADERS`, `WTF_SOURCES`) that the vendor file list was written
  against.
- **bmalloc** comes from upstream with one fix already carried by the upstream
  recipe: `pas_lenient_compact_unsigned_ptr.c` and its three headers are added
  to `bmalloc_SOURCES` / `bmalloc_PUBLIC_HEADERS`. Without them the JSC link
  fails on `pas_lenient_compact_unsigned_ptr`-family symbols.
- `ThirdParty/gtest` is needed for the JSC API tests; `ENABLE_API_TESTS=OFF`
  does not remove the include, so the sources are bundled.
- The vendor `JavaScriptCore/` and `WTF/` replace the upstream ones wholesale;
  nothing from upstream JSC/WTF is mixed in except the two files listed below.

`graft.sh` then applies `patches/0001-build-shims.patch` (454 lines, 11 files).

## 4. What the patch changes, and the error it fixes

Worked out one compile failure at a time; each entry is what the compiler
actually said.

| file | change | failure without it |
|---|---|---|
| `WTF/wtf/wkcshim.h` (new) | `namespace WKCStd { using std::once_flag; using std::call_once; }` under `#ifdef __cplusplus` | `'WKCStd' has not been declared` in `Language.cpp`, `Logger.cpp`, `StackShotProfiler.h`, `WasmSignature.h`, `Assertions.cpp` — the fork uses `WKCStd::` unguarded, expecting the WKC prefix header |
| `WTF/config.h`, `JavaScriptCore/config.h` | `#include <wtf/wkcshim.h>`, and in the JSC header `#define ENABLE_WKC_INTL 1` (see below) | same; both modules use the type in code compiled for non-WKC platforms |
| `JavaScriptCore/runtime/ArgList.h` | `#include "JSCast.h"` | `'jsCast' was not declared in this scope` — the fork's `ArgList` calls `jsCast` where upstream 613.3.9 already included `JSCast.h` |
| `WTF/wtf/StdLibExtras.h` | `#include <iterator>`, `#include <utility>` | `std::iterator_traits` / `std::exchange` not declared; the fork relied on transitive includes that libstdc++ 12 no longer provides |
| `WTF/wtf/text/IntegerToStringConversion.h` | `#include <iterator>` | same family |
| `WTF/wtf/text/TextBreakIterator.cpp` | replaced with upstream 613.3.9 | the fork's version has an unguarded `WKCStd::once_flag`, and its `WKC_USE_ICU` branch calls `wordBreakIteratorWKC()` (peer, not in the drop) and `JSC::Options::useIntl()` from WTF |
| `WTF/wtf/unicode/icu/CollatorICU.cpp` | replaced with upstream 613.3.9 | same: unguarded `WKCStd::` + `wkcCollatorPeer*` calls behind `WKC_USE_ICU` |
| `WTF/wtf/CMakeLists.txt` | add `wkcshim.h` to `WTF_PUBLIC_HEADERS` | `wtf/wkcshim.h: No such file or directory` from `JavaScriptCore` (headers are copied per-module) |
| `JavaScriptCore/runtime/JSDateMath.cpp` | `#if ENABLE(WKC_INTL) && !HAVE(ICU_C_TIMEZONE_API)` on the non-Intl offset shortcut | with `ENABLE_WKC_INTL` on and ICU ≥ 69, `OpaqueICUTimeZone::mOffset` does not exist (the C-API variant stores a `UCalendar`); the shortcut is WKC-ICU-only |
| `JavaScriptCore/runtime/DatePrototype.cpp` | guarded `<langinfo.h>` include, and widen `using WTF::equivalentYearForDST` from `PLATFORM(WKC)` to `PLATFORM(WKC) \|\| HAVE(LANGINFO_H)` | `'nl_item' does not name a type`, then `'equivalentYearForDST' was not declared` — the fork formats dates through `nl_langinfo` and imported that symbol only on WKC; both came from the WKC prefix header |

Two switches decide what Intl code exists, and they are not the same switch:

- `PLATFORM(WKC)` and `WKC_USE_ICU` stay 0: the peer layer is not present, so
  the WKC branches in WTF's ICU wrappers cannot be linked. Replacing the two
  `WTF` files removes the only places where WTF reaches into that layer
  unconditionally. The ICU code that does run is stock ICU.
- `ENABLE_WKC_INTL` must be 1. The fork renames Intl support to that macro
  (there is no `ENABLE_INTL` anywhere in the tree) and wraps the implementation
  files with it — `IntlObject.cpp` line 31 opens `#if ENABLE(WKC_INTL)` and line
  1943 closes it. With the macro off, all of `Intl*/` compiles empty, but
  `TemporalCalendar.cpp`, `TemporalPlainTime.cpp` and `TemporalCalendarPrototype.cpp`
  call `intlAvailableCalendars()` / `iso8601CalendarID()` unconditionally, so
  the link fails with

  ```
  undefined reference to 'JSC::intlAvailableCalendars()'
  undefined reference to 'JSC::iso8601CalendarIDSlow()'
  undefined reference to 'JSC::iso8601CalendarIDStorage'
  undefined reference to 'JSC::intlAvailableTimeZones()'
  ```

  ACCESS defines the macro in its own build; here it is a one-line
  `#define` in `JavaScriptCore/config.h`. With it on, `Intl` exists and every
  `PLATFORM(WKC)` branch inside it still compiles out, so the behavior is the
  same as any ICU-backed JSC of this vintage.

One consequence of enabling Intl is `JSDateMath.cpp`'s fast path for
`--useIntl=false`, which stores a `LocalTimeOffset` in
`OpaqueICUTimeZone::mOffset`. That member only exists in the WKC ICU variant;
with ICU 72 the C timezone API is used and the class holds a `UCalendar`
instead. The guard is narrowed to `!HAVE(ICU_C_TIMEZONE_API)`, which falls back
to the normal ICU path.

One non-patch note: the vendor `Assertions.cpp` still contains
`#if PLATFORM(WKC) ... wkcLoggingPeer(format, args); return; #endif`. That is
preprocessor-dead here and is left untouched, so the patch contains only
changes that are required to compile.

## 5. Build

```sh
cd nintendo
docker build --platform linux/arm64 -t ns2jsc-fork .
```

Numbers from the completed build's ninja log, on this host (32 cores, 128 GB,
otherwise busy — load average 12–34 during the run): 3,939 compilation edges
totalling 534 minutes of emulated CPU time. That is about 35 minutes wall at
`-j16` on an idle host, and the runs here took 45–70 minutes at the observed
load. The three most expensive single
objects are the DFG/FTL JITs — `DFGSpeculativeJIT.cpp` alone takes 22 minutes of
emulated compilation. Configure under qemu adds about 2 minutes.

The image ends with `jsc` installed as `/usr/local/bin/jsc`:
28,664,112 bytes (28.7 MB), not stripped, a PIE executable:

```
ELF 64-bit LSB pie executable, ARM aarch64, version 1 (GNU/Linux),
dynamically linked, interpreter /lib/ld-linux-aarch64.so.1,
for GNU/Linux 3.7.0
```

The dynamic dependencies are `libicui18n.so.72`, `libicuuc.so.72`,
`libstdc++.so.6`, `libm.so.6`, `libgcc_s.so.1`, `libc.so.6` — the same set the
upstream JSCOnly build has, with the ICU linkage now actually exercised because
`Intl` is compiled in.

Flags are the same set as the upstream recipe:

```
-DPORT=JSCOnly -DCMAKE_BUILD_TYPE=Release -DENABLE_STATIC_JSC=ON
-DENABLE_API_TESTS=OFF -DENABLE_TOOLS=OFF -DUSE_CAPSTONE=OFF
```

Consequences worth knowing:

- `PORT=JSCOnly` builds `jsc` + the static JavaScriptCore library only; no
  WebCore, no WebKit2, no `WebKitTestRunner`.
- `ENABLE_STATIC_JSC=ON` makes `jsc` link `libJavaScriptCore.a`, so
  `jsc --help`-style option handling and `useJIT` are as in upstream.
- `USE_CAPSTONE=OFF`: the disassembler falls back to Zydis, which only knows
  x86. On aarch64 `disassemble()` returns nothing useful; do not use it to
  read code.
- `PLATFORM(WKC)=0` and `ENABLE_WKC_INTL=1`, as above.
- ICU is Debian bookworm's ICU 72, not ACCESS's bundled build; string
  collation and break iteration come from stock ICU. `Intl` is compiled in
  (`ENABLE_INTL` default on JSCOnly), so `Intl.Collator` etc. work.

## 6. Tests

Smoke:

```sh
docker run --rm ns2jsc-fork
# or against the built binary directly:
qemu-aarch64 -L $ROOT $ROOT/usr/local/bin/jsc --useJIT=false nintendo/test-smoke.js
```

```
1+1=2
typeofError=function
typeofWebAssembly=undefined
error.stack=1 lines
```

Byte-for-byte the same output as the upstream 613.3.9 binary from VM-SETUP.md
run on the same script, including the two lines that look wrong:

- `typeofWebAssembly=undefined` is stock behavior, not a missing feature.
  `Options::initialize()` clears `useWebAssembly` whenever `useJIT` is false
  (`runtime/Options.cpp`), and under qemu-user JIT must be off, so the global
  is never installed. Both binaries do this.
- `error.stack=1 lines` — the same in both builds.

A broader probe of the fork build (Intl date/number/collation/plural/relative
time/segmentation, BigInt, typed arrays, generators, class fields with private
names, WeakRef/FinalizationRegistry, Promise) matches upstream 613.3.9 as well,
including `Temporal` being present only as `Calendar, Duration, Instant, Now,
PlainTime, TimeZone` under `--useTemporal=true` — that partial Temporal is a
property of this 613.3.9 snapshot, not of the fork.

The upstream repro, unchanged (`error-instance.js` from the VM document):

```sh
qemu-aarch64 -L $ROOT $ROOT/usr/local/bin/jsc --useJIT=false \
    nintendo/error-instance.js; echo "rc=$?"
```

```
qemu: uncaught target signal 11 (Segmentation fault) - core dumped
rc=139
```

Same signature as upstream pre-fix, as expected.

The build is pre-fix: `JSC::ErrorInstance::computeErrorInfo` in the vendor
`ErrorInstance.cpp` has no `DeferGC`, exactly like upstream 613.3.9 before
`ade92866440`. The expected signature is the same abort in the GC during
stack-stringification of a 1 MB `displayName`.

Aside from that, the fork is a normal 613.3.9 JSC:

- `--useJIT=false` must be kept. JIT is compiled in but the qemu-user JIT
  result is not trustworthy (see VM-SETUP.md §7.1); LLInt runs fine.
- `--useConcurrentGC=false` gives the deterministic GC timing used in the
  grooming experiments.

## 7. Why qemu, and how slow it is

Same reason as the upstream VM: the target is aarch64, the host is x86_64, and
the code under test is the ARM64 LLInt/GC, so natively compiled x86 JSC would
be a different program. Two options exist and both are documented here:

1. `docker build --platform linux/arm64` (used here): the whole toolchain runs
   under qemu-aarch64. Correct binaries, ~3-5x slower than native, and the
   build is memory-hungry (16 parallel `cc1plus` at ~1.5 GB each).
2. Native aarch64 hardware or a cross-compiler: not used; a cross build would
   need `-DCMAKE_CXX_COMPILER=aarch64-linux-gnu-g++` and produces the same
   thing, minus the qemu honesty check (the binary would then be run under
   qemu anyway).

With 16 jobs the JSC compile is dominated by the unified-source TUs
(`FTLLowerDFGToB3.cpp`, `DFGSpeculativeJIT64.cpp`, the `UnifiedSource-*`
files), several minutes each under qemu. Build on an idle machine: the duration
above was measured with the host load average around 30 from unrelated work.

## 8. What this build is not

- Not Nintendo's shipped JavaScriptCore: no WKC peer implementation, no
  ACCESS-specific build flags, no ARM64 EABI variants, no console
  `PLATFORM(WKC)` code paths.
- Not a full browser: `WebCore` and `WebKitLegacy` are in the drop and are
  not built. The leak/grooming work in the research tree needs page-family
  hooks (`Ns2Webkit.runFamily`) that live in the private harness, not here.
- Not a symbolised build: `Release` with `-O3`, `-fvisibility=hidden`, no `-g`.
  For gdb over the qemu gdbstub, follow VM-SETUP.md §5; the same
  `reentrancy.gdb` recipe applies, only the binary path differs.

## 9. Provenance — telling this binary from the upstream one

`jsc` in both builds prints no version string (`functionVersion` returns
`undefined`, as in upstream), so:

- this build comes from `nintendo/Dockerfile` + `graft.sh` + the patch, all in
  this repository, plus the vendor tree you supplied;
- the upstream build comes from `vm/Dockerfile`;
- compare `sha256sum` of the two `jsc` binaries to keep them apart in notes;
- the vendor modules' file list is identical to upstream 613.3.9 (§1), so
  `strings`/`nm` differences between the two binaries are ACCESS source
  changes, not file-list drift.

Verified facts in this document (build flags, error messages, test outcomes)
were reproduced on the machine described in VM-SETUP.md §1.1.
