#!/usr/bin/env python3
"""Turn webkitgtk 2.40.5 into a 19.0.0-equivalent engine at the audited sites.

2.40.5 already matches the Switch 2 19.0.0 (webkit_3.6.8) drop in the
vulnerable form at audit sites #2, #3/#4 and #6.  The only site where it
differs is #5 (SVGFEConvolveMatrixElement target offset), where 2.40.5
carries the May-2023 upstream fix 3cfb6575ec08 "Fix buffer overflow in
FEConvolveMatrixSoftwareApplier" and 19.0.0 does not.  This script removes
that fix, restoring the 19.0.0 form, plus one -Werror-free include fix in
ANGLE needed to build against a 2026 libstdc++.

Run from the webkitgtk-2.40.5 source root:  apply-v19-reverts.py
Run it again with --build-fixes-only to re-apply just the compiler fixes
(idempotent) without touching the #5 revert.
"""
import sys, os

root = os.getcwd()
if not os.path.isdir(os.path.join(root, 'Source/WebCore')):
    sys.exit('run me from the webkitgtk-2.40.5 source root')

BUILD_FIXES_ONLY = '--build-fixes-only' in sys.argv

def edit(path, pairs):
    # Audit-site edits are one-shot: they rewrite vulnerable upstream code.
    if BUILD_FIXES_ONLY:
        return
    p = os.path.join(root, path)
    s = open(p).read()
    for old, new in pairs:
        if old not in s:
            sys.exit('%s: pattern not found:\n%s' % (path, old[:200]))
        s = s.replace(old, new, 1)
    open(p, 'w').write(s)
    print('patched %s' % path)

def build_fix(path, olds, new):
    # Compiler fixes are idempotent: the tree may be re-patched after a rebuild.
    # `olds` may list several accepted starting states.
    if isinstance(olds, str):
        olds = [olds]
    p = os.path.join(root, path)
    s = open(p).read()
    if new in s:
        print('already fixed %s' % path)
        return
    for old in olds:
        if old in s:
            open(p, 'w').write(s.replace(old, new, 1))
            print('build fix %s' % path)
            return
    sys.exit('%s: pattern not found:\n%s' % (path, olds[0][:200]))

# --- #5: undo upstream 3cfb6575ec08, restoring the 19.0.0 code -------------
edit('Source/WebCore/svg/SVGFEConvolveMatrixElement.cpp', [
    # (a) the two validators only exist in the fixed form
    ('''bool SVGFEConvolveMatrixElement::isValidTargetXOffset() const
{
    auto orderXValue = hasAttribute(SVGNames::orderAttr) ? orderX() : 3;
    auto targetXValue = hasAttribute(SVGNames::targetXAttr) ? targetX() : static_cast<int>(floorf(orderXValue / 2));
    return targetXValue >= 0 && targetXValue < orderXValue;
}

bool SVGFEConvolveMatrixElement::isValidTargetYOffset() const
{
    auto orderYValue = hasAttribute(SVGNames::orderAttr) ? orderY() : 3;
    auto targetYValue = hasAttribute(SVGNames::targetYAttr) ? targetY() : static_cast<int>(floorf(orderYValue / 2));
    return targetYValue >= 0 && targetYValue < orderYValue;
}

''', ''),
    # (b) svgAttributeChanged: no rebuild on an invalid target offset
    ('''    if ((attrName == SVGNames::targetXAttr || attrName == SVGNames::orderAttr) && !isValidTargetXOffset()) {
        InstanceInvalidationGuard guard(*this);
        markFilterEffectForRebuild();
        return;
    }

    if ((attrName == SVGNames::targetYAttr || attrName == SVGNames::orderAttr) && !isValidTargetYOffset()) {
        InstanceInvalidationGuard guard(*this);
        markFilterEffectForRebuild();
        return;
    }

''', ''),
    # (c) createFilterEffect: the 19.0.0 inline integer comparisons
    ('''    if (!isValidTargetXOffset())
        return nullptr;

    if (!isValidTargetYOffset())
        return nullptr;

    int targetXValue = targetX();
    // The spec says the default value is: targetX = floor ( orderX / 2 ))
    if (!hasAttribute(SVGNames::targetXAttr))
        targetXValue = static_cast<int>(floorf(orderXValue / 2));

    int targetYValue = targetY();
''', '''    int targetXValue = targetX();
    int targetYValue = targetY();
    if (hasAttribute(SVGNames::targetXAttr) && (targetXValue < 0 || targetXValue >= orderXValue))
        return nullptr;
    // The spec says the default value is: targetX = floor ( orderX / 2 ))
    if (!hasAttribute(SVGNames::targetXAttr))
        targetXValue = static_cast<int>(floorf(orderXValue / 2));
    if (hasAttribute(SVGNames::targetYAttr) && (targetYValue < 0 || targetYValue >= orderYValue))
        return nullptr;
    // The spec says the default value is: targetY = floor ( orderY / 2 ))
    if (!hasAttribute(SVGNames::targetYAttr))
        targetYValue = static_cast<int>(floorf(orderYValue / 2));
'''),
])

edit('Source/WebCore/svg/SVGFEConvolveMatrixElement.h', [
    ('    bool isValidTargetXOffset() const;\n    bool isValidTargetYOffset() const;\n', ''),
])

edit('Source/WebCore/platform/graphics/filters/software/FEConvolveMatrixSoftwareApplier.cpp', [
    ('''FEConvolveMatrixSoftwareApplier::FEConvolveMatrixSoftwareApplier(const FEConvolveMatrix& effect) \n    : Base(effect)
{
    ASSERT(IntRect(IntPoint::zero(), m_effect.kernelSize()).contains(m_effect.targetOffset()));
}

''', ''),
])

edit('Source/WebCore/platform/graphics/filters/software/FEConvolveMatrixSoftwareApplier.h', [
    ('    FEConvolveMatrixSoftwareApplier(const FEConvolveMatrix& effect);',
     '    using Base::Base;'),
])

edit('Source/WebCore/platform/graphics/filters/FEConvolveMatrix.cpp', [
    ('    ASSERT(IntRect(IntPoint::zero(), kernelSize).contains(targetOffset));\n', ''),
])

# --- modelling patch: 2.40.5 guards the applier with an unconditional
#     release assertion.  19.0.0's applier writes through a JSC typed array,
#     whose guard is ASSERT_WITH_SECURITY_IMPLICATION and is compiled out in a
#     release build (no ASAN, NDEBUG).  RELEASE_ASSERT_WITH_SECURITY_IMPLICATION
#     is NOT affected by ENABLE_SECURITY_ASSERTIONS -- it maps to RELEASE_ASSERT,
#     which CMake's `!ASSERT_ENABLED` branch keeps live -- so the only way to
#     reproduce the console behaviour at this site is to downgrade the guard.
#     This is not a revert; it changes the 2.40.5 stand-in, not 19.0.0.
PIXELBUFFER_OLD = '''uint8_t PixelBuffer::item(size_t index) const
{
    RELEASE_ASSERT_WITH_SECURITY_IMPLICATION(index < m_sizeInBytes);
    return m_bytes[index];
}

void PixelBuffer::set(size_t index, double value)
{
    RELEASE_ASSERT_WITH_SECURITY_IMPLICATION(index < m_sizeInBytes);
    m_bytes[index] = JSC::Uint8ClampedAdaptor::toNativeFromDouble(value);
}'''
PIXELBUFFER_NEW = '''uint8_t PixelBuffer::item(size_t index) const
{
    // v19 modelling: 19.0.0 indexes a JSC::Uint8ClampedArray here, guarded by
    // ASSERT_WITH_SECURITY_IMPLICATION, which a release build compiles out.
    // PixelBuffer's RELEASE_ASSERT_* is unconditional, so downgrade it to get
    // the same (unchecked) write the console performs.
    ASSERT_WITH_SECURITY_IMPLICATION(index < m_sizeInBytes);
    return m_bytes[index];
}

void PixelBuffer::set(size_t index, double value)
{
    ASSERT_WITH_SECURITY_IMPLICATION(index < m_sizeInBytes);
    m_bytes[index] = JSC::Uint8ClampedAdaptor::toNativeFromDouble(value);
}'''

def modelling_fix(path, old, new):
    p = os.path.join(root, path)
    s = open(p).read()
    if new in s:
        print('already modelled %s' % path)
        return
    if old not in s:
        sys.exit('%s: modelling pattern not found' % path)
    open(p, 'w').write(s.replace(old, new, 1))
    print('modelled %s' % path)

modelling_fix('Source/WebCore/platform/graphics/PixelBuffer.cpp',
              PIXELBUFFER_OLD, PIXELBUFFER_NEW)

# --- build fix: ANGLE uses uint32_t without including <cstdint> ------------
build_fix('Source/ThirdParty/ANGLE/src/image_util/AstcDecompressor.h',
          '#include <memory>\n#include <string>',
          '#include <cstdint>\n#include <memory>\n#include <string>')

# --- build fix: 2026 libstdc++ no longer transitively supplies the FrameLoader
#     types.  MixedContentChecker.cpp calls frame.loader().client(), but
#     page/Frame.h only forward-declares FrameLoader and FrameLoaderClient, so
#     the unified build fails with "invalid use of incomplete type".
build_fix('Source/WebCore/loader/MixedContentChecker.cpp', [
    '#include "Document.h"\n#include "Frame.h"\n#include "SecurityOrigin.h"',
    '#include "Document.h"\n#include "Frame.h"\n#include "FrameLoader.h"\n#include "SecurityOrigin.h"',
], '#include "Document.h"\n#include "Frame.h"\n#include "FrameLoader.h"\n#include "FrameLoaderClient.h"\n#include "SecurityOrigin.h"')

# --- build fix: libxml2 2.12+ made xmlStructuredErrorFunc take a const
#     xmlError*.  The callback only reads the error, so constify it.
build_fix('Source/WebCore/xml/XSLTProcessor.h',
          '    static void parseErrorFunc(void* userData, xmlError*);',
          '    static void parseErrorFunc(void* userData, const xmlError*);')

build_fix('Source/WebCore/xml/XSLTProcessorLibxslt.cpp',
          'void XSLTProcessor::parseErrorFunc(void* userData, xmlError* error)',
          'void XSLTProcessor::parseErrorFunc(void* userData, const xmlError* error)')

# --- sanity: the guards must be gone --------------------------------------
s = open(os.path.join(root, 'Source/WebCore/svg/SVGFEConvolveMatrixElement.cpp')).read()
assert 'isValidTarget' not in s, 'revert incomplete'
print('v19-equivalent at #5: %d bytes of SVGFEConvolveMatrixElement.cpp, no guards' % len(s))
