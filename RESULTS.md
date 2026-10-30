# Running the 19.0.0-equivalent engine — results

Mirror of [`docs/V19-BRANCH.md`](https://github.com/maci0/ns2/blob/main/docs/V19-BRANCH.md)
§9 in the research tree. Same section numbers, so cross-references such as
"§9.4" resolve here too.

## 9. Running the 19.0.0-equivalent engine

### 9.1 Build

The only way to execute the audited sites before an actual 19.0.0 console is to
build an engine that carries the same code. WebKitGTK **2.40.5** is the closest
released tarball: it already matches 19.0.0 in the vulnerable form at #2/#3/#4
and #6, and differs only at #5, where it carries upstream fix
`3cfb6575ec08`. `~/ns2-wk/src/apply-v19-reverts.py` removes exactly that fix
(one-shot, `edit()`), plus four idempotent compiler fixes for the 2026
toolchain (`--build-fixes-only`), none of which touch an audited site.

One difference cannot be fixed by a revert: at #5, 19.0.0 writes through
`JSC::Uint8ClampedArray::set/item` (`ASSERT_WITH_SECURITY_IMPLICATION`, compiled
out in release) while 2.40.5 routes the same index through `PixelBuffer::set/item`
(`RELEASE_ASSERT_WITH_SECURITY_IMPLICATION`, unconditional). The script therefore
also carries a **modelling patch** that downgrades those two `PixelBuffer`
guards to `ASSERT_WITH_SECURITY_IMPLICATION`, reproducing the console's unchecked
access. §9.4 explains why `-DENABLE_SECURITY_ASSERTIONS=0` alone does not do it.

| | |
|---|---|
| config | `-DPORT=GTK -DCMAKE_BUILD_TYPE=Release -DENABLE_SANITIZERS=address -DUSE_SYSTEM_MALLOC=ON -DENABLE_MINIBROWSER=ON`; video/audio/gamepad/spellcheck/geolocation/WebRTC/wayland/GBM/bubblewrap/AVIF/JPEGXL off |
| sanitizers | `-DENABLE_SANITIZERS=address` forces `ENABLE_SECURITY_ASSERTIONS=1`. Both trees carry the `PixelBuffer` modelling patch of §9.4; `build/` leaves the patched assert live (a "did the trigger fire" probe), `build-noassert/` compiles it out with `-DCMAKE_CXX_FLAGS=-DENABLE_SECURITY_ASSERTIONS=0` to match the console's release configuration and get real ASAN reports |
| toolchain | CMake 3.31.6 (distro 4.4 breaks `_WEBKIT_TRY_*`), GCC 16, Ruby 3.4 + `getoptlong erb ostruct logger benchmark` |
| host gaps | glib2 2.90.1 ships neither `gdbus-codegen`, `glib-mkenums` nor `glib-genmarshal`; wrappers into the Flatpak GNOME SDK 50 live in `~/ns2-wk/bin`. A missing `glib-mkenums` fails **silently** (pipeline into `>` leaves a 0-byte `WebKitEnumTypes.h` / `WebKitWebProcessEnumTypes.h`) |
| runtime paths | 2.40.5 without `ENABLE_DEVELOPER_MODE` compiles in `/usr/local/libexec/webkit2gtk-4.1` and `/usr/local/lib/webkit2gtk-4.1`, and compiles *out* `WEBKIT_EXEC_PATH` / `WEBKIT_INJECTED_BUNDLE_PATH`; `poc/build-harness.sh` stages an install and symlinks both |

Build notes with the exact failure signatures: `~/ns2-wk/notes/build-notes.md`.

### 9.2 A/B results

Harness: `~/ns2-wk/poc/harness.c` (WebKitGTK 2.4x, ASAN, `-fsanitize=address` so
the runtime comes first), run under `xvfb-run` by `poc/run.sh`, one Xvfb server
per page. Control: the distribution **2.54.2** release build, which carries all
29 fixes.

| PoC | # | 2.54.2 (all fixes) | 2.40.5 + revert (secure tree) | 2.40.5 + revert + modelling patch |
|---|---|---|---|---|
| `uaf-canvas.html` | 15 | reentrancy works, `outer === inner` (`same=true`), stale wrapper is the live object, no sanitizer output | `same=false`; ASAN **heap-use-after-free**, `READ` in `jsCanvasRenderingContext2DPrototypeFunction_fillRectBody`, freed by `CanvasRenderingContext2D::~CanvasRenderingContext2D` under `HTMLCanvasElement::createContext2d` | identical: `same=false`, same ASAN use-after-free, same free stack |
| `feconvolve-target.html` | 5 | `targetY=45` accepted by the setter, filter dropped by the `svgAttributeChanged` revalidation, clean exit | web process dies **inside `m.targetY.baseVal = 45`**, before the next animation frame (release assertion in `PixelBuffer::set`) | ASAN **heap-buffer-overflow**, `WRITE of size 1`, `located 0 bytes after 262144-byte region`, in `PixelBuffer::set` ← `FEConvolveMatrixSoftwareApplier::setInteriorPixels` ← `ConcurrentWorkQueue::apply` |
| `fedisplacement-selector.html` | 2/#3/#4 | `animVal=0` (`CHANNEL_UNKNOWN`) reaches the primitive, no crash (release lib, no ASAN) | `animVal=0` reaches the primitive at t≈0.46 s, web process dies immediately after | `animVal=0` reaches it at t=0.45 s, then ASAN **heap-buffer-overflow READ** in `PixelBuffer::item` |
| `transform-gate.html` | 6 | — | 67 short `translate*` strings fed, no sanitizer output (confirms §9.3) | same |

The modelling tree is the one that says what 19.0.0 actually does. Its #5 report
is a real out-of-bounds **write** with page-chosen bytes: the geometric default
(`256×256`, order 3, `targetY=45`) puts the first write at byte `262144` — the
exact end of the `262144`-byte pixel buffer — and the applier then advances
`width*4 = 1024` bytes per row for 254 rows of 1016 bytes, so the last byte
written is `306167`: **44,024 bytes of contiguous overflow**, every one of them
`clamp(bias*255)`.

Byte value confirmed by a one-off instrumented run (since removed): with
`?bias=144` the report reads `index=262144 size=262144 value=144` (0x90), and
`V19DEST` shows `preserveAlpha=0 divisor=1 bias=144 totals=0,0,0,0
maxAlpha=144` — the page picks the byte, not the engine. The control run on the
distribution 2.54.2 stays alive through the repaint because the fixed engine
drops the filter on `svgAttributeChanged`; no sanitizer output.

Two calibration points came out of this and are worth keeping:

- **#15 needs the right dictionary member.** 19.0.0's
  `CanvasRenderingContext2DSettings` has only `desynchronized` and the
  setting-gated `colorSpace`; `willReadFrequently` and `alpha` do not exist in
  it and `CanvasColorSpaceEnabled` is off. Arming `alpha` — as one does against
  2.54.2 — silently produces no re-entry on 19.0.0. `desynchronized` is the
  member that fires, and the page now arms all four with `desynchronized` first.
- **`feConvolveMatrix` `bias` is a 0..1 number.** The applier multiplies it by
  255, so a page that wants byte `0x90` must set `bias="144/255"`. The first
  version sent `bias="144"`, which saturated to 255 and made every written byte
  `0xff`; the page now sends `String(BIAS / 255)`.
- **The secure tree's silence is a property of 2.40.5, not of 19.0.0.** See
  §9.4: the release assertion that kills it has no counterpart at the 19.0.0
  write site. Its only remaining value is as a "did the trigger fire at all"
  probe.

### 9.3 #6 — negative result: the guard is hardening, not a reachable fix

19.0.0's `parseSimpleTransformValue()` enters the `translate` branch with only
nine characters guaranteed (`kShortestValidTransformStringLength`,
`"rotate(0)"`), then reads `pos[9]`, `pos[10]` and (for `translate3d`)
`pos[11]`. 23.0.1 raises that gate to twelve before the branch. Reading
`pos[9..11]` out of bounds requires `end - pos` to be 9, 10 or 11.

But `parseSimpleTransformValue()` is only reached from
`parseSimpleTransformList()` after `transformCanLikelyUseFastPath()` accepted
the whole string, and that scan, for a component starting at `i`, does

```cpp
case 't':
    if (toASCIILower(chars[i + 8]) != 'e')
        return false;
    i += 9;
    break;
...
size_t argumentsEnd = find(chars, length, ')', i);
if (argumentsEnd == notFound)
    return false;
i = argumentsEnd + 1;
...
return i == length;      // the whole string must be consumed
```

Two consequences:

1. A `t` component is accepted only if some `)` lies at an index `>= i + 9`,
   so `end - pos >= 10`: the `end - pos == 9` case is unreachable.
2. Because the scan must finish with `i == length`, the `)` of the **last**
   component is the last character of the string. So for the last (only
   possible short) component, `pos[9]` is `)` when `end - pos == 10` — which
   fails every branch before `pos[10]` is read — and when `end - pos == 11`,
   `pos[10]` is `)` and in bounds, `pos[11]` being read only after
   `pos[10] == 'd'`.

Mechanical check: `~/ns2-wk/notes/check-6.py` transcribes both functions with
every character access bounds-checked, and enumerates 340,805 candidate
strings (keywords, short tails over the characters the branch conditions test,
real prefixes such as `rotate(0)`, optional trailing `)`). 114,050 pass the
fast-path gate; **zero** character reads land at or past the end of the string.
`transform-gate.html` exercises the same shapes in the real engine and is
clean.

So #6 is not reachable in 19.0.0 as shipped. It stays in the 29-fix list (the
code difference is real, and the twelve-character gate is the right hardening
for a parser that might later relax the pre-scan), but it is ranked as defence
in depth, not as an entrypoint.

### 9.4 The stand-in is stricter than the target, and the modelling patch

2.40.5 and 19.0.0 do not guard the #5 out-of-bounds access with the same macro,
and the difference decides whether the bug is silent memory corruption or a
trap:

| | 19.0.0 | WebKitGTK 2.40.5 |
|---|---|---|
| applier writes through | `JSC::Uint8ClampedArray::set/item` (`runtime/GenericTypedArrayView.h:75,81`) | `PixelBuffer::set/item` (`platform/graphics/PixelBuffer.cpp:96,102`) |
| guard | `ASSERT_WITH_SECURITY_IMPLICATION(index < length())` | `RELEASE_ASSERT_WITH_SECURITY_IMPLICATION(index < sizeInBytes())` |

`RELEASE_ASSERT_*` is unconditional in a release build. It is **not** gated by
`ENABLE_SECURITY_ASSERTIONS`; the name is misleading. `Assertions.h` splits on
`ASSERT_ENABLED` instead, and the `#if !ASSERT_ENABLED` branch — the one a
release build takes — still expands it:

```c
#if !ASSERT_ENABLED
#define RELEASE_ASSERT(assertion, ...) do { \
    if (UNLIKELY(!(assertion))) \
        CRASH_WITH_INFO(__VA_ARGS__); \
} while (0)
#define RELEASE_ASSERT_WITH_SECURITY_IMPLICATION(assertion) RELEASE_ASSERT(assertion)
```

`ASSERT_WITH_SECURITY_IMPLICATION`, by contrast, is `((void)0)` unless
`ENABLE_SECURITY_ASSERTIONS` is on, and 19.0.0's `PlatformEnable.h` turns that
on only for `ASAN_ENABLED` or non-`NDEBUG` builds:

```c
#if !defined(ENABLE_SECURITY_ASSERTIONS)
#if ASAN_ENABLED || !defined(NDEBUG)
#define ENABLE_SECURITY_ASSERTIONS 1
#endif
#endif
```

The console applet is a release build with neither, so on the actual target the
write has **no check at all** — the overflow just happens.

**`-DENABLE_SECURITY_ASSERTIONS=0` alone cannot model that.** In the earlier
`build-noassert/` the flag did disable the plain `ASSERT`s, but the #5 write
still died at the `PixelBuffer` site, because that site uses the release
assertion, which the flag does not touch. A silent "web process terminated" was
therefore still the tree's answer, not a report.

The faithful model is a **source-level modelling patch**, now shared by both
trees through `apply-v19-reverts.py` (`modelling_fix()`): `PixelBuffer::item/set`
are downgraded from `RELEASE_ASSERT_WITH_SECURITY_IMPLICATION` to
`ASSERT_WITH_SECURITY_IMPLICATION`, which is exactly the strength of 19.0.0's
`JSC::Uint8ClampedArray` guard. The patch changes the 2.40.5 stand-in, not
19.0.0. It is the reason the modelling column in §9.2 can produce an ASAN report
at byte `262144`.

The flag still has a job, but only *after* the patch. ASAN forces
`ENABLE_SECURITY_ASSERTIONS=1`, which would compile the downgraded assert back
in; the console build has it off, so `build-noassert/` passes
`-DCMAKE_CXX_FLAGS=-DENABLE_SECURITY_ASSERTIONS=0` to keep the patched guard
dead, exactly as on the target. So the division of labour is: the patch sets the
right macro, the flag reproduces the console's build configuration.

Three consequences:

- **#5 on 19.0.0 is silent corruption, not a crash.** Nothing stops it at the
  write site; what notices is whatever the corrupted memory belongs to. The
  modelling tree's `WRITE of size 1` is ASAN observing the access the console
  performs.
- **#2/#3/#4 lose their "oracle" reading.** The one-byte read below the
  displacement buffer was only observable in the secure tree because
  `PixelBuffer::item` traps on `SIZE_MAX` there. On 19.0.0, and on the modelling
  tree, the same access is a plain `data()[SIZE_MAX]`; the byte feeds a
  bounds-checked `srcX`/`srcY` and there is no channel back to the page — no
  crash, no leak, only a shifted sample. The modelling tree still reports it
  because ASAN sees the read; the console will not.
- **`build/` remains useful only as a "did the trigger fire" probe**, since its
  release assertion is a property of 2.40.5's `PixelBuffer` plumbing.

The honest ranking for 19.0.0 is therefore: **#15** (real UAF, page-controlled
lifetime) first, **#5** (real heap overflow write, attacker-valued bytes)
second, **#2/#3/#4** a silent one-byte read with no output channel, **#6**
unreachable.

### 9.5 Reclaiming #15's freed object

`uaf-canvas.html` proves the lifetime bug; it does not prove the page can *use*
the free. `uaf-canvas-reclaim.html` takes the next step. ASAN sizes the freed
region at **584 bytes** and attributes it to `WTF::fastMalloc` (`create`) and
`WTF::fastFree` (`~CanvasRenderingContext2D`), so it is an ordinary allocator
chunk. `createContext2d()` evaluates the replacement context and only then
assigns to `m_context`, so the free lands before JS regains control: the chunk is
on the free list, and the page's next allocation gets first refusal.

| `?mode=` | what the page allocates | result on the modelling tree |
|---|---|---|
| `string` (default) | 256 × 584-byte `StringImpl`s, `"A"`-filled | chunk reused by a *different* allocation; `fillRect` on the stale wrapper reports `heap-buffer-overflow` |
| `bytes` | 512 × `Uint8Array(584)` filled with `0x41` | same — typed-array backing stores do not win the chunk |
| `canvas` | one more 64×64 canvas, i.e. another 584-byte context | **reclaimed** |

```
modelling tree: same=false | canvas2 pixel after stale.fillRect = 255,0,0 | stale.canvas.width = 64 | survived
2.54.2 control: same=true  | canvas2 pixel after stale.fillRect = 0,0,0   | ...
```

The pixel is the proof. The page paints `stale` red, and the *second* canvas
reads back red, because the second context was allocated into the freed 584-byte
chunk and the stale wrapper now *is* that object: a use-after-free converted into
type confusion between two page-controlled objects. The control stays black
because the fixed engine has no stale wrapper at all. No ASAN report appears,
which is the point — the access is now inside a live allocation.

Two operational notes: ASAN's quarantine hides reuse, so pass
`ASAN_EXTRA="quarantine_size_mb=0:thread_local_quarantine_size_kb=0"` (what
`run.sh` appends), and never log between the free and the reclaim —
`document.title = …` allocates 528-byte CSS `RuleAndSelector` vectors and wins
the chunk first.

Arbitrary-byte control was **not** achieved with page data. What is demonstrated
is reuse by an object of the attacker's choosing from the page's own vocabulary,
which is the prerequisite for a corruption primitive, not the primitive itself.
