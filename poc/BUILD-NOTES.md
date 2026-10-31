# Building the 19.0.0-equivalent WebKitGTK (2.40.5 + reverts)

Notes from the actual build on this host (2026-10-30). Nothing here modifies an
audited site except the #5 revert and the `PixelBuffer` modelling patch;
`poc/apply-v19-reverts.py` holds all of it.

The result is not the console engine. It is a released 2023 WebKitGTK that
matches 19.0.0 at the audited sites, wrapped in ASAN so the accesses 19.0.0
performs silently become visible. The modelling patch exists because 2.40.5's
`PixelBuffer` plumbing is stricter than 19.0.0's typed-array plumbing; see
[`RESULTS.md`](../RESULTS.md) §9.4.

## Environment

| need | why |
|---|---|
| `~/ns2-wk/bin/` on `PATH` | wrappers for `gdbus-codegen`, `glib-mkenums` and `glib-genmarshal`, all into the Flatpak GNOME SDK 50; the host glib2 2.90.1 ships none of the three |
| CMake 3.31.6 | `~/ns2-wk/src/cmake-3.31.6-linux-x86_64/bin/cmake`; distro CMake 4.4 breaks `_WEBKIT_TRY_*` |
| GCC 16 | distro default |
| Ruby 3.4 + user gems `getoptlong erb ostruct logger benchmark` | `Tools/Scripts` generator steps |
| `unifdef`, `gperf`, `bison`, `flex` | normal build deps |

## The two silent-failure traps

`glib-mkenums` is invoked through a **pipeline into `>`**, so a missing tool
yields an *empty* generated header instead of a build error:

```
glib-mkenums --template ... ${HEADERS} | sed ... > .../webkit/WebKitEnumTypes.h
```

Both generators can fail this way:

- `WebKitEnumTypes.{h,cpp}` — UIProcess API enums
  (`WEBKIT_TYPE_INPUT_PURPOSE`, `..._FIND_OPTIONS`, `..._NAVIGATION_TYPE`, …)
- `WebKitWebProcessEnumTypes.{h,cpp}` — injected-bundle enums
  (`WEBKIT_TYPE_FORM_SUBMISSION_STEP`, …)

Fix: put `glib-mkenums` on `PATH`, then **delete both pairs** of generated
files so the custom commands re-run:

```
rm -f build/WebKitGTK/DerivedSources/webkit/WebKitEnumTypes.{h,cpp} \
      build/WebKitGTK/DerivedSources/webkit/WebKitWebProcessEnumTypes.{h,cpp}
```

Deleting only the first pair is not enough: the second pair's outputs already
existed, so ninja saw them as up to date and reused the empty files.

## The WKC-profile build (`build-console`)

`build/` and `build-noassert/` differ from the console in ways that matter for
any claim about reachability: one has the asserts compiled *in* and the other has
ASAN's redzones and quarantine in the heap. Neither can say "this works on the
console". The third tree, `build-console/`, is the console-like one:

| knob | value | why |
|---|---|---|
| `CMAKE_BUILD_TYPE` | `Release` | `NDEBUG`, like the console |
| `CMAKE_CXX_FLAGS` | `-DENABLE_SECURITY_ASSERTIONS=0` | Release + no ASAN already leaves it undefined (i.e. 0), the flag makes it explicit |
| ASAN / LTO | off | ASAN's redzones change every allocation's size and the heap geometry |
| `ENABLE_JIT`, `ENABLE_DFG_JIT`, `ENABLE_FTL_JIT`, `ENABLE_ASSEMBLER`, `ENABLE_WEBASSEMBLY` | off | `ENABLE_C_LOOP 1`, the console has no JIT |
| `ENABLE_WEBGL`, `ENABLE_LAYER_BASED_SVG_ENGINE`, `ENABLE_SAMPLING_PROFILER`, `ENABLE_ACCESSIBILITY`, `ENABLE_MATHML`, `ENABLE_XSLT`, `ENABLE_SERVICE_WORKER`, `ENABLE_MEDIA_STREAM`, `ENABLE_FILTERS_LEVEL_2` | off | console feature set |
| `ENABLE_VIDEO`, `ENABLE_MEDIA_SOURCE`, `ENABLE_WEB_AUDIO`, `ENABLE_GAMEPAD`, `ENABLE_DARK_MODE_CSS`, `ENABLE_CSS_CONIC_GRADIENTS`, `ENABLE_3D_TRANSFORMS`, `ENABLE_CHANNEL_MESSAGING`, `ENABLE_TOUCH_EVENTS`, `ENABLE_REMOTE_INSPECTOR`, `ENABLE_RESOURCE_USAGE` | on | console feature set |

The full list is 178 settings and is saved as `~/ns2-wk/console-profile.cmake`
(generated from `CMakeCache.txt`, not typed by hand).

Four settings had to be overridden to **on** because "-off" breaks the GTK
wrapper rather than the engine feature:

| forced on | what "-off" breaks |
|---|---|
| `ENABLE_PUBLIC_SUFFIX_LIST` | a GTK-only API shim |
| `ENABLE_CONTEXT_MENUS` | `WebContextMenuItemGlib.h:39` |
| `ENABLE_POINTER_LOCK` | GTK pointer-lock API |
| `ENABLE_MHTML` | GTK MHTML API |
| `ENABLE_ASYNC_SCROLLING` | link error, see below |

None of them touch the canvas, DOM or JSC heap paths these runs study.

`ENABLE_ASYNC_SCROLLING=OFF` is worth spelling out because it fails at *link*
time, after everything compiles:

```
undefined reference to `WebKit::EventDispatcher::addScrollingTreeForPage(WebKit::WebPage&)`
```

`EventDispatcher.cpp` defines the pair under `ENABLE(ASYNC_SCROLLING) &&
ENABLE(SCROLLING_THREAD)`, `DrawingAreaCoordinatedGraphics.cpp` calls it under
`ENABLE(SCROLLING_THREAD)` alone, and GTK gets `SCROLLING_THREAD=1` from
`USE(NICOSIA)` (set unconditionally with `USE_COORDINATED_GRAPHICS` in
`OptionsGTK.cmake`). So the console's own combination — no async scrolling, one
threaded scrolling implementation — cannot be expressed in the GTK port without
patching, and turning async scrolling on is the smaller lie.

The harness for this tree is built without sanitizer flags by
`poc/build-harness-console.sh` (same staging and rpath logic as
`build-harness.sh`, minus `-fsanitize=address`). What it has shown so far —
#15's read, write and live-canvas write, and #5's allocator abort — is in
`RESULTS.md` §9.7.

## Attaching a debugger to a scripted run

The page frees and reuses its object during load, which is faster than
`sudo gdb -p` can attach. `uaf-spray.html` therefore takes `?delay=<ms>`, which
defers the whole trigger/spray/use sequence — still inside one task — so a
breakpoint can be set first:

```sh
cd ~/ns2-wk/poc && setarch $(uname -m) -R ./thief-run.sh \
    "$PWD/uaf-spray.html?…&delay=6000" 20000 60000 "$PWD/gdb-lw-info.txt"
```

`thief-run.sh` needs an **absolute** page path; it `cd`s to `$WK/poc` and realpath
is done by `run.sh`, not by it. With `delay=6000` the write demo below is 3/3.

Two more knobs were added for the console-profile runs:

* `HARNESS_BIN=` selects the harness binary (default
  `./harness-v19-noassert`). Point it at a wrapper for `harness-v19-console`
  when the run needs `setarch $(uname -m) -R` in front of the harness:
  `exec setarch "$(uname -m)" -R …/harness-v19-console "$@"`.
* the web process is now chosen by `/proc/<pid>/maps` containing the *staged*
  `libwebkit2gtk-4.1.so.0`, not by "newest WebKitWebProcess": a GTK app or a
  leftover web process from another build will otherwise get the breakpoints.

`gdb-live-info.txt` is the variant that supplies a real `CanvasBase`. It breaks
on `CanvasRenderingContext2DBase::setLineWidth(double)`, stores `*(void**)
($rdi+24)` from the *first* hit (the page sets `lineWidth` on a live context
before touching the stale one) and writes it into field 24 of the stale object
on the second hit, before the body reads it:

```sh
cd ~/ns2-wk/poc && HARNESS_BIN=/tmp/run-console.sh \
    WK_BUILD=$HOME/ns2-wk/build-console ./thief-run.sh \
    "$PWD/uaf-spray.html?size=584&n=64&fill=zero&sbuf=0x7ffff7f19f38&op=lineWidthLiveRW&delay=18000" \
    15000 60000 "$PWD/gdb-live-info.txt"
```

`console-maps.sh` prints the load base and the file-backed writable segment of
the harness web process (filtered on the staged library), which is what the
`sbuf` addresses below come from. It only makes sense under `setarch -R`.

The staging directory is shared, so `ninja -C build-console install` replaces
the library that the ASAN harness resolves; re-run
`DESTDIR=$HOME/ns2-wk/stage ninja -C build-noassert install` before any
`harness-v19-noassert` run.



| file | error | fix |
|---|---|---|
| `Source/ThirdParty/ANGLE/src/image_util/AstcDecompressor.h` | `uint32_t` not declared | add `<cstdint>` |
| `Source/WebCore/loader/MixedContentChecker.cpp` | incomplete `FrameLoader` / `FrameLoaderClient` | include `FrameLoader.h` + `FrameLoaderClient.h` |
| `Source/WebCore/xml/XSLTProcessor.h`, `XSLTProcessorLibxslt.cpp` | `xmlStructuredErrorFunc` now takes `const xmlError*` (libxml2 2.12+) | constify `parseErrorFunc` |

Re-apply with `python3 apply-v19-reverts.py --build-fixes-only` inside
`src/webkitgtk-2.40.5` (idempotent; each fix accepts several starting states).
The same flag also applies the `PixelBuffer` modelling patch.

## Runtime paths

2.40.5 built without `ENABLE_DEVELOPER_MODE` compiles in

- `PKGLIBEXECDIR` = `/usr/local/libexec/webkit2gtk-4.1` (web process binary)
- `PKGLIBDIR/injected-bundle` = `/usr/local/lib/webkit2gtk-4.1/injected-bundle`

and the `WEBKIT_EXEC_PATH` / `WEBKIT_INJECTED_BUNDLE_PATH` overrides are
compiled out. `poc/build-harness.sh` stages an install and symlinks both
absolute paths into the staging tree. Both build trees share that staging
directory (`~/ns2-wk/stage`), so building a harness re-stages whichever tree was
named and the symlinks stay valid.

## Rebuild loop

```sh
export PATH=$HOME/ns2-wk/bin:$PATH
cd ~/ns2-wk/build-noassert && ninja -j32 MiniBrowser   # ~7 s for the 15 targets
cd ~/ns2-wk/poc && ./build-harness.sh ~/ns2-wk/build-noassert ./harness-v19-noassert
```

`build-harness.sh` must run after every rebuild, because it re-stages the
install; linking the harness alone keeps pointing at the previous copy.
