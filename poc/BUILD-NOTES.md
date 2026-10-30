# Building the 19.0.0-equivalent WebKitGTK (2.40.5 + reverts)

Notes from the actual build on this host (2026-10-30). Nothing here modifies an
audited site except the #5 revert and the `PixelBuffer` modelling patch;
`poc/apply-v19-reverts.py` holds all of it.

The result is not the console engine. It is a released 2023 WebKitGTK that
matches 19.0.0 at the audited sites, wrapped in ASAN so the accesses 19.0.0
performs silently become visible. The modelling patch exists because 2.40.5's
`PixelBuffer` plumbing is stricter than 19.0.0's typed-array plumbing; see
[`V19-BRANCH.md`](V19-BRANCH.md) §9.4.

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

## Compiler fixes (2026 toolchain vs 2.40.5)

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
