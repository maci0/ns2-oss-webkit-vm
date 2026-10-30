# WebKit fork delta: fixes shipped in Switch 2 23.0.1 but not in 19.0.0

A source-level audit of the `NetFrontBrowserNX` open-source drops for two Switch 2
firmwares. It answers one question: **what did Nintendo fix between system 19.0.0
and 23.0.1 that a web page can still reach on 19.0.0?**

The two vendor JavaScriptCore trees are the same ones this repository already
builds: `webkit_3.6.8` (19.0.0) and `webkit_3.12.11` (23.0.1), both grafted onto
upstream WebKit 613.3.9. Companion documents:
[`NINTENDO-BUILD.md`](NINTENDO-BUILD.md) (the vendor graft and build),
[`VM-SETUP.md`](VM-SETUP.md) (the upstream 613.3.9 JSC VM), and
[`delta/`](delta) (the two analysis tools plus their recorded output).

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

Reproducible from the two extracted source trees; no console, no build. The
tools and their output are in [`delta/`](delta).

```sh
cd delta

# 1. classify every differing file, WKC churn normalised out
python3 compare-forks.py \
  NS2_19.0.0/webkit_3.6.8 \
  NS2_23.0.0/webkit_3.12.11 \
  --json fork-delta.json

# 2. pull fix-shaped added lines out of the 321 semantic files
python3 fix-candidates.py --json
```

Step 1 normalises `WKCStd::`→`std::`, `WKCWTF::`→`WTF::`, fork revision numbers
in prose and copyright-year ranges, then compares. Step 2 keeps only **added**
lines matching bounds checks, `RELEASE_ASSERT`, `Checked<>`, overflow/OOM guards,
`rdar://`/bug-id comments and exception throws: 40 files, 123 lines. Every one of
those hunks was then read in full, and a second sweep over the remaining 281
semantic files looked for runtime guards (`if (… >= …)`) inside changed code.

To re-run it, extract both drops so the trees sit at `delta/NS2_19.0.0/` and
`delta/NS2_23.0.0/` (the defaults above), or pass other paths. The committed
`delta/fork-delta.json` and `delta/fix-candidates.json` are the output of the two
commands, so the result can be read without downloading 340 MB of source.

## 3. The list

Ordered by relevance to an attacker holding a web page.

### 3.1 Memory safety, reachable from a plain page

| # | file | what 23.0.1 adds |
|---|---|---|
| 1 | `JavaScriptCore/runtime/StringPrototype.cpp` | `normalize()` rejects input ≥ 2³⁰ UTF-16 units before calling ICU — `rdar://160634825`, ICU buffer-length overflow |
| 2 | `WebCore/platform/graphics/filters/software/FEDisplacementMapSoftwareApplier.cpp` | `xChannelSelector`/`yChannelSelector` bounds-checked against `CHANNEL_R..CHANNEL_A` before indexing the displacement pixel buffer — out-of-bounds read |
| 3 | `WebCore/svg/properties/SVGAnimationDiscreteFunctionImpl.h` | `setFromAndToValues()` ignores values `SVGPropertyTraits<EnumType>::fromString()` failed to parse, so `<set to="foo">` can no longer install an unknown enum — validation bypass that enables 2 and 4 |
| 4 | `WebCore/svg/properties/SVGAnimationDiscreteFunction.h` | `m_from`/`m_to` value-initialised, so a rejected value leaves 0 instead of an indeterminate enum |
| 5 | `WebCore/svg/SVGFEConvolveMatrixElement.cpp` | new `isValidTargetXOffset()`/`isValidTargetYOffset()`, applied on attribute change *and* at filter build; the old check only ran when `targetX`/`targetY` was written explicitly — out-of-bounds read |
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
| 16 | `WebCore/rendering/RenderDeprecatedFlexibleBox.cpp` | line-clamp teardown also fires when the *new* style sets one (the WKC branch fixes an `&&`/`\|\|` precedence bug), so a stale clamp renderer is not reused |
| 17 | `WebCore/platform/audio/HRTFDatabaseLoader.cpp` | the loader map holds `ThreadSafeWeakPtr`, and the destructor only unregisters when the mapped loader is itself — use-after-free race |
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

## 4. What it means for a 19.0.0 device

- **#2–#5 are a series, not four bugs.** 19.0.0 lets a SMIL animation set an
  out-of-range filter parameter *and* has no bounds check where that parameter is
  used. Either half is enough protection in 23.0.1. SVG filters are reachable
  from any page and SMIL is enabled in the applet.
- **#6 is the cheapest entry**: one CSS declaration, a length check, an
  out-of-range read past the end of a string buffer.
- **Most of the list produces reads.** They enlarge the address-leak toolkit
  rather than handing over a write primitive.
- **#1 is theoretical on this hardware.** It wants a >1 GiB string; the browser
  runs out of page memory long before that.
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

## 7. Provenance

| | |
|---|---|
| 19.0.0 drop | `NintendoSwitch2_OpenSources19.0.0.zip`, 145,843,601 B, sha256 `b070fcf022c4c76cfaf90cd45cfde15243f360bec9461758eb3e6b8ecedb9d4f` |
| 23.0.1 drop | `NintendoSwitch2_OpenSources23.0.1.zip`, 197,123,071 B, sha256 `a2bcdfb7ec695d1ac5c790317a1239ccdb40e0ba8e052891c2ebba1314200f90` |
| source | <https://support.nintendo.com/jp/oss/index.html> (serves the index only with a browser User-Agent) |
| artifacts | [`delta/fork-delta.json`](delta/fork-delta.json) (per-file classification), [`delta/fix-candidates.json`](delta/fix-candidates.json) (candidate lines) |
