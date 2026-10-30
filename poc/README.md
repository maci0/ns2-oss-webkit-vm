# v19 proof-of-concepts — a runnable 19.0.0-equivalent WebKit

Three page-level PoCs for the memory-safety items in
[`../../docs/V19-FIX-DELTA.md`](../../docs/V19-FIX-DELTA.md) that 23.0.1 fixes
and 19.0.0 does not: **#5** (heap overflow write in `FEConvolveMatrix`),
**#15** (use-after-free in `HTMLCanvasElement::getContext`) and **#2/#3/#4**
(the SMIL-validated-attribute bypass that feeds an out-of-range channel selector
to `FEDisplacementMap`). Plus the build recipe for an engine that actually runs
them, one calibration probe (`getcontext-probe.html`) and the mechanical
negative result for **#6** (`transform-gate.html`).

The rig runs 23.0.1, where all of them are fixed, so none can be demonstrated on
the console. The only way to run them is an engine that matches 19.0.0 at the
audited sites.

## Why webkitgtk 2.40.5 is the v19 stand-in

Both Switch 2 drops are based on upstream **613.3.9**, which is older than
2.40.5 (Aug 2023) in some places and newer in others — but at the audited sites
the comparison was done file by file against the 19.0.0 drop:

| item | 19.0.0 | WebKitGTK 2.40.5 | matches? |
|---|---|---|---|
| #2 displacement-map channel index | unguarded `xChannelIndex()`, `CHANNEL_UNKNOWN = 0` | identical, and *still identical upstream in 2.54.2* | **yes, vulnerable form** |
| #3/#4 enumeration SMIL validation | `SVGAnimationDiscreteFunction` stores whatever `fromString()` returns | identical, and *still identical upstream in 2.54.2* | **yes, vulnerable form** |
| #6 `translate()` fast path | 9-char minimum, reads `pos[9..11]` | identical | **yes, vulnerable form** |
| #5 `feConvolveMatrix` target offset | checks only at build time | carries upstream fix `3cfb6575ec08` | **no — reverted by `apply-v19-reverts.py`** |
| #5 guard at the write site | `ASSERT_WITH_SECURITY_IMPLICATION` (compiled out) | `RELEASE_ASSERT_WITH_SECURITY_IMPLICATION` (always live) | **no — modelled by a patch, see "Two trees"** |

`apply-v19-reverts.py` removes that one fix from 2.40.5 (the two validators, the
`svgAttributeChanged` guards, the constructor `ASSERT`s) and restores the 19.0.0
inline integer comparisons, reproducing the 19.0.0 form at the site byte for
byte. A separate **modelling patch** downgrades `PixelBuffer::item/set` to the
guard strength 19.0.0 actually uses, because the guard difference decides whether
the trigger corrupts memory or traps. The script also adds a missing `<cstdint>`
include to ANGLE so the 2023 source builds against a 2026 libstdc++.

## Building

```sh
mkdir -p ~/ns2-wk/src && cd ~/ns2-wk/src
curl -LO https://webkitgtk.org/releases/webkitgtk-2.40.5.tar.xz
tar xf webkitgtk-2.40.5.tar.xz
cd webkitgtk-2.40.5
python3 <this dir>/apply-v19-reverts.py
```

Then configure **twice**, one tree per assertion policy — see "Two trees" below:

```sh
common="-G Ninja -S . -DPORT=GTK -DCMAKE_BUILD_TYPE=Release \
  -DENABLE_SANITIZERS=address -DUSE_SYSTEM_MALLOC=ON -DENABLE_MINIBROWSER=ON \
  -DENABLE_DOCUMENTATION=OFF -DENABLE_INTROSPECTION=OFF \
  -DENABLE_VIDEO=OFF -DENABLE_WEB_AUDIO=OFF -DENABLE_GAMEPAD=OFF \
  -DENABLE_SPELLCHECK=OFF -DENABLE_GEOLOCATION=OFF -DENABLE_WEB_RTC=OFF \
  -DENABLE_MEDIA_RECORDER=OFF -DENABLE_WAYLAND_TARGET=OFF -DUSE_GBM=OFF \
  -DENABLE_BUBBLEWRAP_SANDBOX=OFF -DENABLE_JOURNALD_LOG=OFF \
  -DUSE_AVIF=OFF -DUSE_JPEGXL=OFF"

cmake $common -B ~/ns2-wk/build                     # probe tree: patched assert live
cmake $common -B ~/ns2-wk/build-noassert \
      -DCMAKE_CXX_FLAGS=-DENABLE_SECURITY_ASSERTIONS=0   # console config: real ASAN reports

ninja -C ~/ns2-wk/build -j32 MiniBrowser
ninja -C ~/ns2-wk/build-noassert -j32 MiniBrowser
```

### Two trees, and why

`apply-v19-reverts.py` includes a **modelling patch**, not just the #5 revert.
19.0.0's applier writes through `JSC::Uint8ClampedArray::set/item`, guarded by
`ASSERT_WITH_SECURITY_IMPLICATION`; 2.40.5 routes the same index through
`PixelBuffer::set/item`, guarded by `RELEASE_ASSERT_WITH_SECURITY_IMPLICATION`.
The latter is unconditional in a release build — `Assertions.h` maps it to
`RELEASE_ASSERT` under `#if !ASSERT_ENABLED` — so it cannot be switched off by
`ENABLE_SECURITY_ASSERTIONS`, and the #5 trigger would trap with no stderr text
at all instead of producing a report. The patch downgrades both `PixelBuffer`
guards to `ASSERT_WITH_SECURITY_IMPLICATION`, matching the console, and then the
build flag decides whether that guard is live:

| tree | `ENABLE_SECURITY_ASSERTIONS` | what it shows |
|---|---|---|
| `build/` | 1 (forced by ASAN) | whether the trigger fires at all — the patched assert is live, so a silent "web process terminated" right after the page's last log line |
| `build-noassert/` | 0 (forced via `CMAKE_CXX_FLAGS`) | the console's configuration: the assert is compiled out, so ASAN sees the access and emits `heap-buffer-overflow` / `heap-use-after-free` with frames |

Release + ASAN also means `ASSERT_ENABLED == 0`, so the plain `ASSERT`s in the
filter appliers are compiled out even in the probe tree. `USE_SYSTEM_MALLOC=ON`
sets `GIGACAGE_ENABLED 0`, so pixel buffers are ordinary ASAN-tracked
allocations with redzones — an overflow is only reported if it lands in one
(hence `targetY=45`, not 60, as the default).

### Toolchain gaps that fail *silently*

| need | why |
|---|---|
| CMake **3.31.6** | the distro's 4.4 breaks WebKit's `_WEBKIT_TRY_*` macros |
| Ruby 3.4 + `gem install --user-install getoptlong erb ostruct logger benchmark` | `Tools/Scripts` generators |
| `unifdef`, `gperf`, `bison`, `flex` on `PATH` | normal build deps |
| `gdbus-codegen`, `glib-mkenums`, `glib-genmarshal` on `PATH` | glib2 2.90 ships none of them; wrappers into the Flatpak `org.gnome.Sdk` 50 (`/var/lib/flatpak/runtime/org.gnome.Sdk/x86_64/50/active/files/bin`) work |

The glib ones are the dangerous ones. `glib-mkenums` is invoked through a
pipeline into `>`:

```
glib-mkenums --template ... ${HEADERS} | sed ... > .../webkit/WebKitEnumTypes.h
```

so a missing binary does not fail the build — it writes a **0-byte header**.
Two pairs are generated this way (`WebKitEnumTypes.*` for the UI-process enums,
`WebKitWebProcessEnumTypes.*` for the injected-bundle ones, which owns
`WEBKIT_TYPE_FORM_SUBMISSION_STEP`). Put the wrappers on `PATH` and delete
**both** pairs so ninja regenerates them; deleting only the first is not enough,
because the second pair already exists and ninja considers it up to date.

`apply-v19-reverts.py --build-fixes-only` re-applies the four compile fixes the
2023 source needs against a 2026 toolchain: `<cstdint>` in ANGLE,
`FrameLoader.h` + `FrameLoaderClient.h` in `MixedContentChecker.cpp`, and the
`const xmlError*` signature for `XSLTProcessor::parseErrorFunc` (libxml2 2.12+).
None of them touch an audited site.

### Runtime paths

A 2.40.5 build without `ENABLE_DEVELOPER_MODE` compiles in
`/usr/local/libexec/webkit2gtk-4.1` (web process) and
`/usr/local/lib/webkit2gtk-4.1` (injected bundle), and compiles *out* the
`WEBKIT_EXEC_PATH` / `WEBKIT_INJECTED_BUNDLE_PATH` overrides. `build-harness.sh`
stages `DESTDIR=~/ns2-wk/stage` and symlinks both absolute paths at the staged
tree:

```sh
cd <this dir> && ./build-harness.sh            # builds ./harness-v19
./build-harness.sh ~/ns2-wk/build-noassert ./harness-v19-noassert
./run-all.sh v19-noassert ./harness-v19-noassert 8000
```

This needs `sudo` once, to `mkdir -p /usr/local/libexec` and create the two
symlinks. To use a single tree at a time, point the symlinks at it (they are
`~/ns2-wk/build/../stage/usr/local/...`, so re-staging rewrites them).

## Running

`harness.c` is a WebKitGTK page runner: it loads a file, forwards page console
output (through a user-content message handler — the
`console-message-received` signal no longer exists in 2.54), prints title
changes, and quits on a timeout or on web-process termination. `run.sh` wraps it
in `xvfb-run` and filters the interesting lines.

```sh
cd <this dir>
./build-harness.sh ~/ns2-wk/build-noassert ./harness-v19-noassert
export LD_LIBRARY_PATH=$HOME/ns2-wk/stage/usr/local/lib:$HOME/ns2-wk/build-noassert/lib
HARNESS_OUT=$HOME/ns2-wk/out/v19-uaf ./run.sh ./harness-v19-noassert uaf-canvas.html 4000
```

`build-harness.sh <build-dir> <output>` stages that tree's install into
`~/ns2-wk/stage` and links against it; the two trees share the stage directory,
so building a harness re-stages whichever tree you name and existing symlinks
stay valid. Use `~/ns2-wk/build/` for the probe tree and
`~/ns2-wk/build-noassert/` for the ASAN-report tree.

`build-harness.sh` compiles with `-fsanitize=address` deliberately, so the ASAN
runtime comes first in the link order even against a non-ASAN system WebKit.
`run.sh` needs an **absolute** page path, sets
`ASAN_OPTIONS=detect_leaks=0:abort_on_error=0:disable_coredump=1`, and does not
set `LD_LIBRARY_PATH` — export it as above. Its stdout summary truncates the
sanitizer block at 40 lines; the full report is `$HARNESS_OUT/run.log`.

Build the same harness against the *fixed* system WebKitGTK (2.54.2) for the
negative control; the source compiles unchanged against both. `run-all.sh` runs
every page in the directory sequentially, each in its own Xvfb server and its
own output directory.

## #15 — `uaf-canvas.html`

`HTMLCanvasElement::getContext()` in 19.0.0 checks `m_context` at the top, then
converts the settings dictionary, and only afterwards calls `createContext2d()`.
Dictionary conversion runs JS getters, so the page re-enters `getContext()` from
a getter and installs `m_context`. The outer call then executes

```cpp
m_context = CanvasRenderingContext2D::create(*this, WTFMove(settings), ...);
```

which overwrites the `std::unique_ptr`, destroying the inner context while its
JS wrapper is still reachable. `CanvasRenderingContext::ref()`/`deref()` forward
to the `CanvasBase`, so the wrapper's ref never kept the context alive — the
first call through the stale wrapper (`fillRect`, `save`) is the UAF.

**Which getter matters is engine-specific.** 19.0.0's
`CanvasRenderingContext2DSettings` (identical to 2.40.5's) contains only

```webidl
boolean desynchronized = false;
[EnabledBySetting=CanvasColorSpaceEnabled] PredefinedColorSpace colorSpace = "srgb";
```

— no `alpha`, no `willReadFrequently`, and `CanvasColorSpaceEnabled` is off, so
`colorSpace` is not read either. `desynchronized` is the only member whose
getter actually runs. Arming `alpha` (the natural choice when developing
against a current WebKitGTK, where the dictionary does have it) produces
`innerCtx === null` and no re-entry on 19.0.0 at all. The page arms all four
with `desynchronized` first; `getcontext-probe.html` is the one-page check that
prints which getter fires and in what order.

Fixed upstream by `040ef6e21ffa` (*Crash in CanvasRenderingContext::deref after
reentrant getContext()*, bug 313175), test
`LayoutTests/fast/canvas/canvas-getContext-reentrant.html`, shipped in 23.0.1.
On 2.54.2 the re-entrant call returns the *same* context (`outer === inner`), so
the "stale" wrapper is the live object.

On the modelling tree the page logs `same=false` and dies with
`heap-use-after-free`, `READ` in `jsCanvasRenderingContext2DPrototypeFunction_fillRectBody`,
freed by `~CanvasRenderingContext2D` under `HTMLCanvasElement::createContext2d`
(written up in [`../RESULTS.md`](../RESULTS.md) §9.2).

### Reclaiming the freed object — `uaf-canvas-reclaim.html`

The ASAN report sizes the freed region at **584 bytes** and shows it coming from
`WTF::fastMalloc` (`CanvasRenderingContext2D::create`) and going back to
`WTF::fastFree` (`~CanvasRenderingContext2D`), so it is an ordinary allocator
chunk, not an ISO-heap object. `createContext2d()` evaluates the new context
first and only then assigns to `m_context`, so the free happens *before* JS
regains control: the chunk is on the free list and the page's next allocation
gets first refusal.

The page has three reclaim modes (`?mode=`):

| mode | what it allocates | result |
|---|---|---|
| `string` (default) | 256 × 584-byte `StringImpl`s (`"A"`-filled) | chunk reused, but by a *different* allocation; `fillRect` on the stale wrapper reports `heap-buffer-overflow` |
| `bytes` | 512 × `Uint8Array(584)` filled with `0x41` | same: the chunk does not go to a typed-array backing store |
| `canvas` | one more 64×64 canvas, i.e. another 584-byte `CanvasRenderingContext2D` | **reclaimed** |

With `mode=canvas` and the quarantine disabled:

```
v19-equivalent:  same=false | canvas2 pixel after stale.fillRect = 255,0,0 | stale.canvas.width = 64 | survived
2.54.2 control:  same=true  | canvas2 pixel after stale.fillRect = 0,0,0   | ...
```

The pixel is the proof: the page paints `stale` red, and the *second* canvas
reads back red, because the second canvas's context was allocated into the freed
584-byte chunk and the stale wrapper now *is* that object — a use-after-free that
has become type confusion between two page-controlled objects. The control stays
black because on the fixed engine there is no stale wrapper at all.

Two practical notes from running it:

- ASAN's quarantine hides reuse; pass
  `ASAN_EXTRA="quarantine_size_mb=0:thread_local_quarantine_size_kb=0"` (that is
  what `run.sh` now appends). The console allocator has no such quarantine.
- Do not log between the free and the reclaim. `document.title = …`, which every
  `log()` in these pages does, allocates 528-byte CSS `RuleAndSelector` vectors
  and wins the chunk first — the first, verbose version of this page measured
  exactly that.

Arbitrary-byte control of the chunk was *not* achieved with page data: strings
and typed-array backing stores both lost the race to WebCore-side allocations.
What is demonstrated is reuse by an object of the attacker's choosing from the
page's own vocabulary (a canvas context), which is the prerequisite for a
corruption primitive, not the primitive itself.

## #5 — `feconvolve-target.html`

A 3×3 `feConvolveMatrix` on a 256×256 `userSpaceOnUse` filter region, with an
all-zero kernel, `divisor="1"` and `bias="65/255"` so every written byte is
`0x41`. (`bias` is a number in `[0,1]` that the applier scales by 255; sending
`bias="65"` saturates to 255 and every byte becomes `0xff`.) The offset has to
be *valid at build time* — 19.0.0's `createFilterEffect()` already returns
`nullptr` for a `targetX`/`targetY` attribute outside `[0, order)` — so the page
builds the filter with `targetX="0" targetY="1"` and only then sets
`targetY.baseVal = 45`.

The change does not rebuild the filter: it goes through
`SVGFilterPrimitiveStandardAttributes::primitiveAttributeChanged()` →
`SVGFEConvolveMatrixElement::setFilterEffectAttribute()` →
`FEConvolveMatrix::setTargetOffset()` and then repaints the *existing* effect.
`FEConvolveMatrixSoftwareApplier::setInteriorPixels()` starts its write cursor
at

```cpp
int pixel = (paintingData.targetOffset.y() * paintingData.width + paintingData.targetOffset.x()) * 4;
```

and advances exactly one row of pixels per row of output, so the first parallel
chunk (`yEnd = stride = clipBottom / (n²/10000) = 42` for `n` in 255…260) starts
writing at

```
(targetY + clipBottom - stride) * n * 4
```

`targetY = 45 = stride + kernelHeight - 1` (with `targetX = 0`) therefore puts
the very first write at byte `n*n*4`, exactly one byte past the end of the
`n*n*4`-byte destination buffer, and each row after it walks another `n*4` bytes
further out — a linear
heap overflow of 4 bytes per pixel, every byte `clamp(totals/divisor + bias)`,
i.e. bounded to 0…255. Larger offsets overrun proportionally further (`60` puts
the first write 15 KiB out and the last one ~58 KiB out), but ASAN only reports
what lands in a redzone, so the page defaults to `45`; `?targetY=60` overrides.

Fixed upstream by `3cfb6575ec08` (*Fix buffer overflow in
FEConvolveMatrixSoftwareApplier*, bug 253721), test
`LayoutTests/svg/filters/feconvolve-matrix-invalid-target-offset-crash.html`.
2.40.5 and 2.54.2 carry it unconditionally, 23.0.1 carries the
`svgAttributeChanged` revalidation only inside `#if PLATFORM(WKC)`, and 19.0.0
has only the build-time comparison — so unlike #2/#3/#4 this one *is* a plain
upstream n-day on 19.0.0.

On the modelling tree the page produces a real out-of-bounds **write**:
`heap-buffer-overflow`, `WRITE of size 1`, `located 0 bytes after 262144-byte
region`, in `PixelBuffer::set` ← `FEConvolveMatrixSoftwareApplier::setInteriorPixels`
← `ConcurrentWorkQueue::apply`. The applier advances `width*4 = 1024` bytes per
row for 254 rows of 1016 bytes, so the last byte written is `306167`: **44,024
bytes of contiguous overflow**. A one-off instrumented run confirmed the value
is page-chosen — with `?bias=144` it printed `index=262144 size=262144
value=144` (0x90) and `maxAlpha=144`. Control 2.54.2 stays alive because the
fixed engine drops the filter on `svgAttributeChanged`. Details in
[`../RESULTS.md`](../RESULTS.md) §9.2.

## #2/#3/#4 — `fedisplacement-selector.html`

`SVGFEDisplacementMapElement::parseAttribute()` rejects an invalid channel
selector (`if (propertyValue > 0)`), but SMIL does not go through
`parseAttribute()`. `SVGAnimationEnumerationFunction::setFromAndToValues()` in
`svg/properties/SVGAnimationDiscreteFunctionImpl.h` stores
`SVGPropertyTraits<ChannelSelectorType>::fromString(from/to)` verbatim, and
`fromString()` maps anything that is not `R`/`G`/`B`/`A` to `CHANNEL_UNKNOWN`
(0). An `<animate from="R" to="foo">` therefore installs 0 in the animated
property, the animator's `apply()` calls `svgAttributeChanged(xChannelSelectorAttr)`
→ `primitiveAttributeChanged()` → `FEDisplacementMap::setXChannelSelector(0)`,
and the *existing* effect is repainted with

```cpp
int FEDisplacementMapSoftwareApplier::xChannelIndex() const
{
    return m_effect.xChannelSelector() - 1;   // 0 - 1 == -1
}
```

`displacementPixelArray.item(destinationIndex + displacementChannelX)` is then
called with `destinationIndex == 0` on the first pixel, i.e. with `size_t(-1)`:
a one-byte read immediately below the displacement pixel buffer.

Scope: `PixelBuffer::item()` takes a `size_t`, so the index always folds to
`SIZE_MAX` and the read is exactly one byte before the allocation; the value
only feeds a bounds-checked `srcX`/`srcY`, so there is no data channel back to
the page. It is a crash/oracle primitive, not a leak and not a write. 23.0.1
adds two WKC-only guards (one in the applier, one in the enumeration function);
upstream WebKit still has neither as of 2.54.2, so this item is
Nintendo-authored hardening of an unfixed upstream bug — see
[`../RESULTS.md`](../RESULTS.md) §9.

On the modelling tree the page reaches the primitive at `t=0.45s`
(`CHANNEL_UNKNOWN reached the filter primitive (animVal=0 baseVal=1)`) and then
trips `heap-buffer-overflow`, `READ` in `PixelBuffer::item`. That report is
ASAN observing an access the 19.0.0 console makes silently; it is *not* a
page-visible oracle. See [`../RESULTS.md`](../RESULTS.md)
§9.2 and §9.4.

## #6 — `transform-gate.html` (negative result)

The fix delta lists a 9- versus 12-character gate in
`parseSimpleTransformValue()`'s `translate` branch, and 19.0.0 has the 9. The
branch reads `pos[9..11]`, which looks like an out-of-bounds read — but the
function is only reachable through `transformCanLikelyUseFastPath()`, and that
pre-scan requires a `)` at index `>= i + 9` and requires the whole string to be
consumed. So `end - pos == 9` cannot happen, and for `10`/`11` the character
that would be read is the `)` itself, in bounds.

`transform-gate.html` feeds 67 short `translate*` strings through the real,
v19-equivalent engine; nothing fires. The mechanical version of the same
argument (bounds-checked transcription of both functions over 340,805 candidate
strings, 114,050 accepted by the gate, **zero** out-of-bounds reads) is
`~/ns2-wk/notes/check-6.py`, written up in
[`../RESULTS.md`](../RESULTS.md) §9.3. It is hardening,
not an entrypoint.

## Status

| PoC | 2.54.2 control | modelling tree | verdict |
|---|---|---|---|
| `uaf-canvas.html` | `same=true`, no report | `same=false`, `heap-use-after-free` READ | real UAF |
| `uaf-canvas-reclaim.html?mode=canvas` | `same=true`, second canvas stays black | stale wrapper **is** the second context (red pixel readback) | UAF → page-controlled type confusion |
| `feconvolve-target.html` | filter dropped, no report | `heap-buffer-overflow` WRITE of `0x90` at byte 262144, 44,024 bytes deep | real overflow write |
| `fedisplacement-selector.html` | no report (release lib) | `heap-buffer-overflow` READ in `PixelBuffer::item` | silent one-byte read |
| `transform-gate.html` | — | clean | not reachable (§9.3) |

Full write-up, including the macro-level reason the stand-in needs a modelling
patch, is in [`../RESULTS.md`](../RESULTS.md) §9.
