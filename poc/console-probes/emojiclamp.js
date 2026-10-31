// emojiclamp: does the closed emoji peer respect the length it is given?
//
// Only one site in the 23.0.1 font layer can write while walking emoji
// clusters, ComplexTextControllerWKC.cpp:100-150:
//
//     advances.reserveInitialCapacity(len);
//     stringIndices.reserveInitialCapacity(len);
//     ...
//     size_t emojilen = wkcDrawContextIsEmojiSequencePeer(&glyphs[r], len - r);
//     if (emojilen) {
//         for (size_t i = 1; i < emojilen; i++) {
//             stringIndices.uncheckedAppend(r + i);
//             advances.uncheckedAppend({0, 0});
//         }
//         r += emojilen;
//     }
//
// Each outer iteration appends exactly emojilen entries, so the totals fit the
// reserved capacity iff emojilen <= len - r on every call. The peer is deleted
// source: WKC_3.12.11/include/wkc/wkcgpeer.h:1093 declares it
//
//     int wkcDrawContextIsEmojiSequencePeer(const U16Char* in_str, int in_len);
//
// with no comment on its contract, and the other three call sites rely on the
// same clamp. So the contract has to be measured.
//
// Strategy: end a complex-path run in a *truncated* emoji sequence, where the
// remaining length is smaller than any complete sequence. A peer that clamps
// returns 0 or the truncated length; one that scans ahead returns more than
// remains, the loop appends past the end of two Vectors that were reserved at
// exactly len, and the process dies (or the run draws with an advance count that
// no longer matches its glyph count).
//
//   ctl        base only                    -> baseline width
//   hi         base + lone high surrogate   -> len-r = 1
//   lo         base + lone low surrogate    -> len-r = 1
//   ri1        base + one regional indicator (2 units, needs 4)
//   ri_zwj     base + RI + ZWJ
//   hi_zwj     base + high surrogate + ZWJ
//   zwj        base + bare ZWJ
//   vs16       base + VS16
//   keycap     base + '1' + U+20E3 (missing the VS16 the cluster wants)
//   pretext    base with trailing ZWJ and a *space* after it
//   emoji_c    base + U+1F600 (complete, positive control: the emoji path exists)
//   flag_c     base + two RIs      (complete flag, positive control)
//
// Every string carries U+0301 just after the base text, so
// characterRangeCodePath() returns Complex for the whole run and the cluster
// loop is the one that runs (FontCascade.cpp:553, ComplexTextControllerWKC.cpp:83).
//
// What a result means:
//   * a crash on a truncated case -> the peer over-reports, the uncheckedAppend
//     writes past the vector, and the lead is a real overflow. The label of the
//     case that killed the page names the input.
//   * survival on every case, with each width roughly the sum of its parts ->
//     the peer clamps. That is evidence, not proof: it covers these inputs.
//
// This probe deliberately does not claim a width difference between an emoji and
// a missing-glyph box, because there is none on this console: fontpath measured
// w(U+1F600) = w(U+E000) = 32 px at 32px. Widths are reported so a later run
// can compare, not to decide the verdict.
//
// Queue with:
//   sudo node tools/experiment.mjs enqueue emojiclamp --label emojiclamp-1
(function () {
  'use strict';
  if (typeof Ns2Webkit === 'undefined' || !Ns2Webkit.registerExperiment)
    throw new Error('emojiclamp: Ns2Webkit.registerExperiment is missing');

  var HOLD_DEFAULT = 6000;
  var FONT = '32px sans-serif';
  var ACUTE = String.fromCharCode(0x0301);
  var ZWJ = String.fromCharCode(0x200D);
  var VS16 = String.fromCharCode(0xFE0F);
  var KEYCAP = String.fromCharCode(0x20E3);
  var HI = String.fromCharCode(0xD83D);
  var LO = String.fromCharCode(0xDE00);
  var RI = String.fromCharCode(0xD83C, 0xDDE6);
  var EMOJI = String.fromCharCode(0xD83D, 0xDE00);

  var BASE = 'MMMMOOOO';

  var CASES = [
    {id: 'ctl', tail: ''},
    {id: 'hi', tail: HI},
    {id: 'lo', tail: LO},
    {id: 'ri1', tail: RI},
    {id: 'ri_zwj', tail: RI + ZWJ},
    {id: 'hi_zwj', tail: HI + ZWJ},
    {id: 'zwj', tail: ZWJ},
    {id: 'vs16', tail: VS16},
    {id: 'keycap', tail: '1' + KEYCAP},
    {id: 'emoji_c', tail: EMOJI},
    {id: 'flag_c', tail: RI + RI}
  ];

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

  function round(value) { return Math.round(value * 100) / 100; }

  Ns2Webkit.registerExperiment({
    name: 'emojiclamp',
    description: 'Truncated emoji sequences at the end of a complex run: does the closed peer clamp its length, or overrun two Vectors?',
    run: function (params) {
      var args = (params && params.experimentArgs) || {};
      var hold = Number(args.hold);
      if (!isFinite(hold) || hold < 0) hold = HOLD_DEFAULT;
      var repeat = Number(args.repeat);
      if (!isFinite(repeat) || repeat < 1) repeat = 3;

      // The base is laid out on the complex path by the combining mark.
      var complexBase = BASE + ACUTE;
      var report = {
        hold: hold,
        repeat: repeat,
        baseComplex: round(widthOf(complexBase)),
        baseSimple: round(widthOf(BASE)),
        wA: round(widthOf('A')),
        cases: []
      };

      // A positive control first: if a complete emoji sequence does not change
      // the width at all, the emoji machinery is not engaged for this family and
      // the truncated cases below prove nothing.
      report.emojiDelta = round(widthOf(complexBase + EMOJI) - report.baseComplex);
      report.emojiEngaged = Math.abs(report.emojiDelta) > 0.5;

      for (var c = 0; c < CASES.length; c++) {
        var item = CASES[c];
        var text = complexBase + item.tail;
        var widths = [];
        for (var n = 0; n < repeat; n++)
          widths.push(round(widthOf(text)));

        var first = widths[0];
        var stable = true;
        for (var k = 1; k < widths.length; k++)
          if (Math.abs(widths[k] - first) > 0.01) stable = false;

        // Width with one more character after the truncated tail. A peer that
        // scans past the end of the run changes what it finds when the buffer
        // behind the run changes, so the delta is informative even though the
        // widths themselves cannot separate emoji from missing glyphs.
        var withA = round(widthOf(text + 'A'));
        var deltaA = round(withA - first - report.wA);

        report.cases.push({
          id: item.id,
          tailUnits: item.tail.length,
          width: first,
          delta: round(first - report.baseComplex),
          stable: stable,
          deltaA: deltaA,
          // A tail that measures wider than the whole base is the shape a
          // scan-ahead overrun takes: it consumes buffer content that is not
          // part of the run.
          wide: first > report.baseComplex + 64
        });
      }

      var wide = [];
      var unstable = [];
      for (var r = 0; r < report.cases.length; r++) {
        if (report.cases[r].wide) wide.push(report.cases[r].id);
        if (!report.cases[r].stable) unstable.push(report.cases[r].id);
      }
      report.wide = wide;
      report.unstable = unstable;
      report.verdict = wide.length ? 'suspicious: tail measured far wider than the run'
        : (unstable.length ? 'unstable: widths disagree between repeats'
        : 'no overrun observed');

      var out = document.createElement('div');
      out.setAttribute('id', 'emojiclamp-out');
      out.style.cssText = 'position:fixed;left:16px;top:16px;z-index:9999;' +
        'background:#000;color:#0f0;font:14px monospace;padding:8px 12px;' +
        'white-space:pre;line-height:1.3';
      var lines = ['emojiclamp: ' + report.verdict,
        'base ' + report.baseComplex + '  emoji delta ' + report.emojiDelta];
      for (var q = 0; q < report.cases.length; q++) {
        var row = report.cases[q];
        lines.push((row.id + '        ').slice(0, 9) + String(row.width).padStart(6) +
          '  d ' + String(row.delta).padStart(5) + (row.stable ? '' : ' UNSTABLE'));
      }
      out.textContent = lines.join('\n');
      document.body.appendChild(out);

      return new Promise(function (resolve) {
        setTimeout(function () { resolve(report); }, hold);
      });
    }
  });
})();
