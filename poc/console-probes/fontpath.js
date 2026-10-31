// fontpath: which half of the 23.0.1 font layer is compiled into the console?
//
// In 23.0.1 both WKC font files are wrapped whole in
//
//     #if defined(WKC_PROP_USE_LIBFONT)
//
// (WKC_3.12.11/WebCore/platform/graphics/WKC/{FontWKC,ComplexTextControllerWKC}.cpp)
// and the cairo/freetype half of the tree is guarded by the negation. The flag
// is never defined in either drop: no header defines it, no makefile sets it,
// and every test is `defined(...)`, not a value test. So the only way to know
// which world the console lives in is to measure it. Two leads hang on it (the
// emoji-cluster uncheckedAppend and the fixedU16Text slack write, see
// docs/V19-BRANCH.md §10.2).
//
// The oracle is a substitution that only the libfont code performs. In
// FontWKC.cpp:383, fixedU16Text maps U+FFFF to an ordinary space:
//
//     if (FontCascade::treatAsSpace(c) || c == 0xffff)
//         buf[j++] = 0x20;
//
// It runs before shaping, on the complex-text path, and its output feeds the
// advance loop (ComplexTextControllerWKC.cpp:102), so a layout width reflects
// it. The cairo build has no such rewrite, so U+FFFF keeps whatever advance the
// missing-glyph box has.
//
// The comparison needs a falsification control, because for some fonts the
// missing-glyph advance equals the space advance and the test would be a false
// positive. U+E000 is a private-use code point no system font covers, so its
// advance is that same missing-glyph box. The verdict therefore requires both
//
//     |w(U+FFFF) - w(space)|  small      -> the substitution happened
//     |w(U+E000) - w(space)|  large      -> the equality is not a font accident
//
// Every string ends in U+0301, a combining mark: characterRangeCodePath()
// returns Complex for U+0300-U+036F before any platform guard, which is what
// puts the run through ComplexTextControllerWKC. U+FFFF alone would take the
// simple path (WidthIterator) and never reach fixedU16Text.
//
// A second, mechanism-independent signal is reported but not used for the
// verdict: InlineLineBoxBuilder.cpp:332 grows an inline box for fallback-font
// glyphs only when WKC_PROP_USE_LIBFONT is defined. If the console has an emoji
// fallback font, the libfont build reports a taller box for "A" + U+1F600 than
// for "A" alone; the cairo build reports equal heights.
//
// The Regional-Indicator rule at ComplexTextController.cpp:306 is *not* usable
// here: U+1F1E6-U+1F1FF are supplementary code points below U+10A00, so
// characterRangeCodePath() keeps them on the simple path and the WKC branch is
// never reached. That is why this probe does not use it.
//
// Queue with:
//   sudo node tools/experiment.mjs enqueue fontpath --label fontpath-1
(function () {
  'use strict';
  if (typeof Ns2Webkit === 'undefined' || !Ns2Webkit.registerExperiment)
    throw new Error('fontpath: Ns2Webkit.registerExperiment is missing');

  var HOLD_DEFAULT = 4000;
  var FONT = '32px sans-serif';
  var EPSILON = 0.5;

  var SPACE = ' ';
  var COMB = String.fromCharCode(0x0301);        // combining acute
  var FFFF = String.fromCharCode(0xFFFF);
  var PUA = String.fromCharCode(0xE000);         // missing glyph reference
  var EMOJI = String.fromCharCode(0xD83D, 0xDE00); // U+1F600
  var RI = String.fromCharCode(0xD83C, 0xDDE6);  // U+1F1E6, informational

  function widthOf(text) {
    var span = document.createElement('span');
    span.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;' +
      'white-space:pre;display:inline-block;font:' + FONT + ';';
    span.textContent = text;
    document.body.appendChild(span);
    var width = span.getBoundingClientRect().width;
    span.parentNode.removeChild(span);
    return width;
  }

  function heightOf(text, family) {
    var div = document.createElement('div');
    div.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;' +
      'white-space:pre;line-height:1;font:32px ' + family + ';';
    div.textContent = text;
    document.body.appendChild(div);
    var height = div.getBoundingClientRect().height;
    div.parentNode.removeChild(div);
    return height;
  }

  function round(value) { return Math.round(value * 100) / 100; }

  Ns2Webkit.registerExperiment({
    name: 'fontpath',
    description: 'Decide whether 23.0.1 uses the libfont or the cairo text path (U+FFFF becomes a space only on libfont)',
    run: function (params) {
      var args = (params && params.experimentArgs) || {};
      var hold = Number(args.hold);
      if (!isFinite(hold) || hold < 0) hold = HOLD_DEFAULT;

      var report = {
        hold: hold,
        epsilon: EPSILON
      };

      // Complex-path measurements (every string carries the combining mark).
      report.wSpaceComplex = round(widthOf(SPACE + COMB));
      report.wFFFFComplex = round(widthOf(FFFF + COMB));
      report.wMissingComplex = round(widthOf(PUA + COMB));
      report.wTextComplex = round(widthOf('A' + COMB));
      report.wMultiFFFFComplex = round(widthOf(FFFF + FFFF + FFFF + FFFF + COMB));
      report.wMultiSpaceComplex = round(widthOf(SPACE + SPACE + SPACE + SPACE + COMB));

      // Simple-path measurements, information only: U+FFFF on its own does not
      // force the complex controller, so these do not decide the verdict.
      report.wSpaceSimple = round(widthOf(SPACE));
      report.wFFFFSimple = round(widthOf(FFFF));
      report.wMissingSimple = round(widthOf(PUA));
      report.wTextSimple = round(widthOf('A'));

      report.deltaFFFF = round(Math.abs(report.wFFFFComplex - report.wSpaceComplex));
      report.deltaMissing = round(Math.abs(report.wMissingComplex - report.wSpaceComplex));
      report.deltaMulti = round(Math.abs(report.wMultiFFFFComplex - report.wMultiSpaceComplex));

      // Second mechanism: fallback-font inline box height (LIBFONT-only call).
      report.heightText = round(heightOf('A', 'sans-serif'));
      report.heightEmoji = round(heightOf('A' + EMOJI, 'sans-serif'));
      report.heightStretch = round(report.heightEmoji - report.heightText);

      // Informational: RI run, and the width of a plain emoji, so a later run
      // can compare without rebuilding the probe.
      report.wEmojiComplex = round(widthOf(EMOJI + COMB));
      report.wRIComplex = round(widthOf(RI + RI + RI + RI + COMB));

      var substituted = report.deltaFFFF <= EPSILON;
      var meaningful = report.deltaMissing > EPSILON;

      if (!meaningful) {
        // Missing-glyph advance happens to equal the space advance, so the
        // U+FFFF equality proves nothing on this font. Say so instead of
        // guessing.
        report.verdict = 'ambiguous';
        report.why = 'missing-glyph advance equals the space advance; the U+FFFF test cannot discriminate';
      } else if (substituted) {
        report.verdict = 'libfont';
        report.why = 'U+FFFF takes the space advance while the missing glyph does not: fixedU16Text ran';
      } else {
        report.verdict = 'cairo';
        report.why = 'U+FFFF keeps the missing-glyph advance: fixedU16Text did not run';
      }
      if (report.verdict !== 'ambiguous' && (report.deltaMulti > EPSILON) === substituted) {
        // The four-character version must agree with the one-character version.
        report.verdict = 'ambiguous';
        report.why = 'single and repeated U+FFFF disagree';
      }
      if (report.heightStretch > 0 && report.verdict !== 'ambiguous')
        report.verdictSecondary = report.verdict === 'libfont' ? 'agrees' : 'disagrees';

      var out = document.createElement('div');
      out.setAttribute('id', 'fontpath-out');
      out.style.cssText = 'position:fixed;left:16px;top:16px;z-index:9999;' +
        'background:#000;color:#0f0;font:16px monospace;padding:8px 12px;' +
        'white-space:pre;line-height:1.35';
      out.textContent =
        'fontpath: ' + report.verdict + '\n' +
        'FFFF  ' + report.wFFFFComplex + '  space ' + report.wSpaceComplex + '\n' +
        'miss  ' + report.wMissingComplex + '  text  ' + report.wTextComplex + '\n' +
        'x4FFFF ' + report.wMultiFFFFComplex + '  x4sp ' + report.wMultiSpaceComplex + '\n' +
        'box ' + report.heightText + ' -> ' + report.heightEmoji;
      document.body.appendChild(out);

      return new Promise(function (resolve) {
        setTimeout(function () { resolve(report); }, hold);
      });
    }
  });
})();
