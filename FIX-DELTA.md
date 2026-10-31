# WebKit fork delta: fixes shipped in Switch 2 23.0.1 but not in 19.0.0

A source-level audit of the `NetFrontBrowserNX` drops for the two Switch 2
firmwares on this rig. It answers one question: **what did Nintendo fix between
system 19.0.0 and 23.0.1 that a web page can still reach on 19.0.0?**

Compiled 30 October 2026. Companion documents: [`V19-BRANCH.md`](V19-BRANCH.md)
(the branch report), [`../oss/ns2-19/BRANCH.md`](../oss/ns2-19/BRANCH.md)
(provenance and tooling).

> **Status, 31 October 2026.** The rig's console runs system **23.0.1**
> (`V19-BRANCH.md` §1.1, read off Settings → System). No entry in this list has
> been tested on a 19.0.0 machine, and none of them is a bug that console still
> has: the three entries a page can reach were measured *present* on 23.0.1,
> which is the expected result, since 23.0.1 is where they were fixed. Read
> every row as a hypothesis for a 19.0.0 box, to be confirmed on one, not as a
> target list for this rig.

## 1. Summary

Both drops are built on **upstream WebKit 613.3.9** (`WebKit-7613.3.9`,
`WKC_WEBKIT_VERSION "613.0"`). 23.0.1 is not a plain fork of that tag: it carries
selected upstream fixes pulled forward over 2024–2026, which 19.0.0 — the first
Switch 2 release, October 2024 — does not have.

| | |
|---|---|
| files differing between the two `webkit_x.y.z` trees | 533 |
| mechanical (WKC namespace/version churn) | 206 |
| semantic (needs a human read) | 321 |
| only in 23.0.1 | 6 (all Largest Contentful Paint) |
| only in 19.0.0 | 0 |
| **fixes found in 23.0.1 and absent from 19.0.0** | **29** |

Six of the 29 are memory-safety bugs reachable from ordinary page content, and
five of those six are one coherent SVG-filter series: a SMIL animation can
install an out-of-range filter parameter, and 19.0.0 then indexes past the end of
a pixel buffer. The rest are origin/CSP/sandbox checks, lifetime and crash fixes,
and hardening.

## 2. Method

Reproducible from the two extracted source trees; no console, no build.

```sh
# 1. classify every differing file, WKC churn normalised out
oss/ns2-19/compare-forks.py \
  oss/ns2-19/NS2_19.0.0/webkit_3.6.8 \
  oss/ns2-23/NS2_23.0.0/webkit_3.12.11 \
  --json oss/ns2-19/fork-delta.json

# 2. pull fix-shaped added lines out of the 321 semantic files
cd oss/ns2-19 && python3 fix-candidates.py
```

Step 1 normalises `WKCStd::`→`std::`, `WKCWTF::`→`WTF::`, fork revision numbers
in prose and copyright-year ranges, then compares. Step 2 keeps only **added**
lines matching bounds checks, `RELEASE_ASSERT`, `Checked<>`, overflow/OOM guards,
`rdar://`/bug-id comments and exception throws: 40 files, 123 lines. Every one of
those hunks was then read in full, and a second sweep over the remaining 281
semantic files looked for runtime guards (`if (… >= …)`) inside changed code.

## 3. The list

Ordered by relevance to an attacker holding a web page.

### 3.1 Memory safety, reachable from a plain page

| # | file | what 23.0.1 adds |
|---|---|---|
| 1 | `JavaScriptCore/runtime/StringPrototype.cpp` | `normalize()` rejects input ≥ 2³⁰ UTF-16 units before calling ICU — `rdar://160634825`, ICU buffer-length overflow |
| 2 | `WebCore/platform/graphics/filters/software/FEDisplacementMapSoftwareApplier.cpp` | `xChannelSelector`/`yChannelSelector` range-checked against `CHANNEL_R..CHANNEL_A` in `apply()`; without it an unparsable selector leaves `CHANNEL_UNKNOWN` (0), `xChannelIndex()` returns −1 and `item((size_t)-1)` reads **one byte before** the displacement buffer. The byte only feeds the same loop's bounds-checked `srcX`/`srcY`, so the defect is a single-byte underread with no write — see §4 |
| 3 | `WebCore/svg/properties/SVGAnimationDiscreteFunctionImpl.h` | `setFromAndToValues()` keeps the previous value when `SVGPropertyTraits<EnumType>::fromString()` fails, so a SMIL `<set to="foo">` can no longer install an unknown enum — the validation bypass that enables 2 and 4 |
| 4 | `WebCore/svg/properties/SVGAnimationDiscreteFunction.h` | `m_from`/`m_to` value-initialised, so a rejected value leaves 0 instead of an indeterminate enum |
| 5 | `WebCore/svg/SVGFEConvolveMatrixElement.cpp` | new `isValidTargetXOffset()`/`isValidTargetYOffset()`, applied on attribute change *and* at filter build; the old check only ran at build, so an effect built with a valid offset could be mutated to an out-of-range one through SMIL — out-of-bounds write (44,024 bytes in the modelling build, `V19-BRANCH.md` §9.4) |
| 6 | `WebCore/css/parser/CSSParserFastPaths.cpp` | the `translate()` fast path requires 12 characters (`"translate(0)"`) before reading `pos[8..11]`; previously only 9 were guaranteed — out-of-bounds read |
| 7 | `WebCore/css/CSSGradientValue.cpp` | a repeating gradient whose range is below 2⁻¹⁶ skips stop replication instead of materialising an enormous stop vector — memory denial of service |
| 8 | `WebCore/Modules/indexeddb/IDBKey.cpp` | `createBinary()` returns an invalid key for a detached `JSArrayBuffer`/`JSArrayBufferView` instead of reading `data()`/`byteLength()` |

### 3.2 Origin, CSP and sandbox

| # | file | what 23.0.1 adds |
|---|---|---|
| 9 | `WebCore/css/CSSStyleSheet.cpp` | `insertRule()`/`deleteRule()` return `SecurityError` on a cross-origin sheet; `canAccessRules()` returns false when the owner document is gone |
| 10 | `WebCore/page/csp/ContentSecurityPolicySource.cpp` | CSP3 path matching: split both paths into segments, then percent-decode per segment — closes a `%2F` bypass; `/` matches the empty path |
| 11 | `WebCore/loader/PingLoader.cpp` | pings honour `connect-src` via `allowConnectToSource()` |
| 12 | `WebCore/loader/FrameLoader.cpp`, `NavigationRequester.h` | `sandboxFlags` and `documentIdentifier` are serialised with the navigation requester, and a pending `javascript:` URL load is refused when the requester is `SandboxScripts` |
| 13 | `WebCore/loader/MediaResourceLoader.cpp` | cross-origin media loaded into a main-resource document is tagged `LoadedFromOpaqueSource` |
| 14 | `WebCore/loader/FrameLoader.cpp` | same-site info is taken from the initiator and dropped when the origin is inherited from the owner |

### 3.3 Lifetime, re-entrancy and crash

| # | file | what 23.0.1 adds |
|---|---|---|
| 15 | `WebCore/html/HTMLCanvasElement.cpp` | `getContext()` re-checks `m_context` after IDL dictionary conversion (which can run script and re-enter); the "no context yet" asserts became `ASSERT_WITH_SECURITY_IMPLICATION` |
| 16 | `WebCore/rendering/RenderDeprecatedFlexibleBox.cpp` | line-clamp condition — **withdrawn, see §3.5** |
| 17 | `WebCore/platform/audio/HRTFDatabaseLoader.cpp` | the loader map holds `ThreadSafeWeakPtr`, and the destructor only unregisters when the mapped loader is itself — user-after-free race |
| 18 | `JavaScriptCore/runtime/JSModuleRecord.cpp` | `rdar://107531050` mitigation: an unresolved import that decodes as `jsUndefined` becomes a `SyntaxError` instead of being dereferenced |
| 19 | `WebCore/rendering/svg/SVGRenderSupport.cpp` | `mapLocalToContainer()` returns early when asked to map onto itself — recursion guard |
| 20 | `WebCore/platform/graphics/WidthIterator.cpp` | U+2028/U+2029 normalised to LF to avoid layout corruption |
| 21 | `WTF/wtf/HashTable.h` | rehash sizes are `Checked<unsigned>`, so `bestTableSize`/`oldSize` arithmetic is overflow-checked |
| 22 | `WTF/wtf/WeakHashMap.h`, `WeakHashCountedSet.h` | `isEmptyIgnoringNullReferences()` no longer reports empty for a map that holds only dead keys; `removeAll()` added |

### 3.4 Hardening, policy and non-page surfaces

| # | file | what 23.0.1 adds |
|---|---|---|
| 23 | `WebCore/css/CSSVariableReferenceValue.cpp` (3), `css/parser/CSSParser.cpp` (1), `CSSParserImpl.cpp` (3), `CSSSelectorParser.cpp` (4), `CSSVariableParser.cpp` (1), `style/StyleBuilder.cpp` (2) | `CRASH_IF_STACK_OVERFLOW` at 14 new sites — deep `var()`, selector and nesting recursion |
| 24 | `WTF/wtf/text/StringBuilder.cpp`, `.h` | WKC overflow path calls `CRASH_WITH_NO_MEMORY()` instead of `CRASH()`/`RELEASE_ASSERT`; `didOverflowWKC()` removed |
| 25 | `JavaScriptCore/heap/PreciseAllocation.cpp` | WKC: a null `MarkedSpace` gives `CRASH_WITH_NO_MEMORY()` instead of a dereference |
| 26 | `WebCore/platform/graphics/freetype/FontCacheFreeType.cpp` | `RELEASE_ASSERT` on the font pattern, face and last-resort pattern instead of using null |
| 27 | `JavaScriptCore/inspector/ScriptArguments.cpp` | bounds-checked `getArgumentAtIndexAsString(size_t)` replaces the hand-rolled count check |
| 28 | `WebDriver/Session.cpp`, `WebDriverService.cpp`, `CommandResult.cpp` | action-sequence parameters (`duration`, `origin`, `x`/`y`, `button`, `deltaX`/`deltaY`, `pointerType`, `id`, `actions`) are validated and rejected as `InvalidArgument`/`InvalidSelector` |
| 29 | `JavaScriptCore/runtime/ExceptionScope.h` et al. | `VMTraps::maybeNeedHandling(mask)` → `maybeNeedHandling()` (upstream 237503); item 18 calls the new form |

### 3.5 Rows withdrawn or closed by inspection

Numbering is kept so earlier references stay valid.

**#16 is withdrawn.** It was filed as "line-clamp teardown also fires when the
new style sets one". The two files do differ, but not in a way that adds a
check. 19.0.0 applies upstream's condition to every platform:

```c++
if (oldStyle && !oldStyle->lineClamp().isNone() && newStyle.lineClamp().isNone())
    clearLineClamp();
```

23.0.1 keeps that line behind `#if !PLATFORM(WKC)` and gives WKC its own
variant:

```c++
if (oldStyle && !oldStyle->lineClamp().isNone() || !newStyle.lineClamp().isNone())
    clearLineClamp();
```

So on a WKC build the clamp layout is now thrown away on *any* style change
that carries a clamp, not only when one is removed. That is a rendering
correctness workaround — it forces the clamp information to be rebuilt — and it
contains no bounds, lifetime or ownership check. An earlier draft of this
section claimed the WKC condition was byte-identical in both drops; the files
say otherwise, and only the non-WKC branch is identical. The row still does not
belong in a security delta, but for the weaker reason: nothing in the change
can prevent an out-of-bounds access.

**Not in the list, closed by inspection since publication.** Both were read on
the 23.0.1 tree, so the verdict applies to the engine the rig runs:

| site | finding |
|---|---|
| `WebCore/svg/SVGToOTFFontConversion.cpp` | `diff` between the drops is empty. Every write goes through `Vector::append`/`grow`/`overwrite16`/`overwrite32`; the only defect class is 16-bit truncation producing a *malformed* OTF whose declared fields are smaller than the real data, so a peer parser reading with those fields stays in bounds. The parser itself is in the closed part of the app. |
| `WKC/…/FontWKC.cpp`, `WKC/…/ComplexTextControllerWKC.cpp` | whole files behind `#if defined(WKC_PROP_USE_LIBFONT)` in 23.0.1 (50 occurrences of the flag, 0 in 19.0.0, where the files are unconditional). No header defines it and no makefile in either drop sets it, so the console was asked: `fontpath-1` measures U+FFFF equal to a space on the complex path and 32 px on the simple path, which is the flag being **defined** — the libfont layer is live code. Both leads it guards were then settled by measurement and by the allocator: the emoji-cluster peer never returns a length greater than the one it was given (§10.2, `emojiclamp`/`emojiclamp2`), and the `fixedU16Text` terminator write lands in allocator padding. `V19-BRANCH.md` §10.2 has both arguments. |

## 4. What it means for a 19.0.0 console

- **#5 is the strongest entry, and the only out-of-bounds write in the list.**
  19.0.0 builds the effect with a valid `targetOffset` and then lets
  `primitiveAttributeChanged()` mutate it with no range check, so a SMIL
  animation moves the convolution's paint region outside the destination
  buffer. The modelling build writes 44,024 bytes of `clamp(bias*255)` past a
  262,144-byte `PixelBuffer` (`V19-BRANCH.md` §9.4). The bytes are page-chosen
  through `bias`. SVG filters are reachable from any page and SMIL is enabled in
  the applet.
- **#2–#4 are the same series but a much weaker member.** The bypass is real —
  `<set to="foo">` leaves `CHANNEL_UNKNOWN`, `xChannelIndex()` returns −1 — but
  `item((size_t)-1)` reads one byte *before* the displacement buffer and the
  value only feeds the loop's bounds-checked `srcX`/`srcY`. There is no write,
  and the byte sits in allocator metadata at the left edge of the pixel buffer,
  so it is a crash oracle and a size-class nibble at best.
  `FEDisplacementMapSoftwareApplier::apply()` now returns false for it on WKC
  builds, and `SVGAnimationEnumerationFunction::setFromAndToValues()` refuses
  the value in the first place.
- **The console half of this is already measured, on 23.0.1.** #5 was rejected
  there (`V19-BRANCH.md` §9.10) because the guard is the engine's own
  behaviour. That says nothing about 19.0.0.
- **#6 is the cheapest entry**: one CSS declaration, a length check, an
  out-of-range read past the end of a string buffer.
- **Outside #5, the list produces reads.** They enlarge the address-leak
  toolkit, which is the current bottleneck on the main rig, rather than handing
  over a write primitive.
- **#1 is theoretical on this hardware.** It wants a >1 GiB string; the console's
  page heap crashes well before that (8–12 MB survives, ~14 MB fatal).
- **Not reachable from page content**: #27 (inspector), #28 (WebDriver service),
  #21/#22 (need hundreds of millions of entries).

## 5. What is *not* in this list

The remaining 281 semantic files were read as churn rather than fixes:

- `WKCStd`/`WKCWTF` namespace migration and the `WKC_INTL` option gates
  (`useIntl`, Intl/Temporal/Date/URL-IDNA fallbacks);
- WKC memory-pressure, thread and long-loop peers (`wkcMemoryCheckMemoryAllocatablePeer`,
  `CRASH_IF_LONG_LOOP_DETECTED`, `ThreadSafeWeakPtr` plumbing in `RunLoop`);
- the Largest Contentful Paint feature (6 new files plus plumbing through
  `Element`, `Document`, `Performance`);
- focus-visible, vibration and Nintendo focus-event APIs;
- large layout and animation backports: `RenderGrid` (auto-repeat track
  handling), `FocusController`, `KeyframeEffect` transform-prefix matching,
  `TransformOperations`/`TransformationMatrix` accumulate, the inline layout
  overflow-break rework.

Those backports are upstream *correctness* work from later WebKit branches. Some
of them fix fuzz-found layout crashes, but none adds a bounds, lifetime or origin
check, so they are not counted as a security delta.

## 6. Limitations

This is a semantic diff review, not a bisect against upstream. A backport that
changes behaviour without adding a guard-shaped line — a type widening, a changed
default, a reordered initialisation — would not be caught by the second sweep.
Treat the list as high-recall for guard-shaped fixes and as *unverified* for
anything structural.

The comparison covers `webkit_3.6.8` against `webkit_3.12.11` only. The bundled
WKC platform layer (`WKC_3.6.8` → `WKC_3.12.11`), `WebKitLibraries` and the
legacy 601.7.4 tree were not part of this pass.

Finally, and most importantly for how this list is used: every console
observation referenced in §4 was made on a **23.0.1** unit (`V19-BRANCH.md`
§1.1). Such an observation can confirm that 23.0.1 is not affected. It cannot be
evidence about 19.0.0 in either direction, and three of this list's entries have
already been misread that way once.

## 7. Provenance

| | |
|---|---|
| 19.0.0 drop | `NintendoSwitch2_OpenSources19.0.0.zip`, 145,843,601 B, sha256 `b070fcf022c4c76cfaf90cd45cfde15243f360bec9461758eb3e6b8ecedb9d4f` |
| 23.0.1 drop | `NintendoSwitch2_OpenSources23.0.1.zip`, 197,123,071 B |
| source | <https://support.nintendo.com/jp/oss/index.html> |
| artifacts | `oss/ns2-19/fork-delta.json` (per-file classification), `oss/ns2-19/fix-candidates.json` (candidate lines) |
