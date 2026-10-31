// emojiclamp2: follow-up to emojiclamp, which survived every truncated case but
// measured width 0 for the WHOLE span on exactly the three cases that contain an
// unpaired surrogate (hi, lo, hi_zwj).
//
// Zero for the whole span has two very different explanations, and they are
// separable by where the lone surrogate sits:
//
//   (A) the peer consumed the run from the surrogate to its end
//       -> ComplexTextControllerWKC.cpp:122 returned emojilen == len - r, the
//          loop appended exactly the reserved count of {0,0} advances and
//          r += emojilen ended the walk. No overflow is possible from a
//          truncated trailing sequence, and the peer demonstrably clamps to the
//          in_len it was given.
//       Prediction: base + ACUTE + HI measures base only (HI and anything
//       after it contributes nothing); HI + base + ACUTE measures 0.
//
//   (B) the string never reached layout (DOM or font layer dropped it)
//       Prediction: width 0 whatever the position, in the simple path too, and
//       either domLen != input units or the returned height is 0 (no line box).
//
// So this probe measures, for each string: width, height, number of client
// rects, the length the DOM hands back, and the length of the first text node.
// Each case is measured on the complex path (a U+0301 after the base) and on the
// simple path (no combining mark) so the two can be told apart.
//
// Queue with:
//   sudo node tools/experiment.mjs enqueue emojiclamp2 --label emojiclamp2-1
(function () {
  'use strict';
  if (typeof Ns2Webkit === 'undefined' || !Ns2Webkit.registerExperiment)
    throw new Error('emojiclamp2: Ns2Webkit.registerExperiment is missing');

  var HOLD_DEFAULT = 6000;
  var FONT = '32px sans-serif';
  var MONO = '32px monospace';
  var ACUTE = String.fromCharCode(0x0301);
  var ZWJ = String.fromCharCode(0x200D);
  var HI = String.fromCharCode(0xD83D);
  var LO = String.fromCharCode(0xDE00);
  var BASE = 'MMMMOOOO';

  function round(value) { return Math.round(value * 100) / 100; }

  function measure(text, font) {
    var span = document.createElement('span');
    span.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;' +
      'white-space:pre;display:inline-block;font:' + (font || FONT) + ';';
    span.textContent = text;
    document.body.appendChild(span);
    var rect = span.getBoundingClientRect();
    var rects = span.getClientRects ? span.getClientRects().length : -1;
    var back = span.textContent;
    var domLen = back === null || back === undefined ? -1 : back.length;
    var nodeLen = -1;
    if (span.childNodes.length) {
      var node = span.childNodes[0];
      if (node.nodeType === 3) nodeLen = node.length;
    }
    span.parentNode.removeChild(span);
    return {
      units: text.length,
      w: round(rect.width),
      h: round(rect.height),
      rects: rects,
      domLen: domLen,
      nodeLen: nodeLen
    };
  }

  // id, text, font. Every "c_" case carries U+0301 so the run goes complex.
  var CASES = [
    {id: 'p_base', text: BASE},
    {id: 'p_acc', text: BASE + ACUTE},
    {id: 'p_hi_lead', text: HI + BASE + ACUTE},
    {id: 'p_hi_mid', text: BASE + ACUTE + HI + 'MMMM'},
    {id: 'p_lo_mid', text: BASE + ACUTE + LO + 'MMMM'},
    {id: 'p_hi_end', text: BASE + ACUTE + HI},
    {id: 'p_hi_end_m', text: BASE + ACUTE + HI, font: MONO},
    {id: 's_hi_end', text: BASE + HI},
    {id: 's_hi_mid', text: BASE + HI + 'MMMM'},
    {id: 's_lo_end', text: BASE + LO},
    {id: 'p_hi_zwj_end', text: BASE + ACUTE + HI + ZWJ},
    {id: 'p_zwj_end', text: BASE + ACUTE + ZWJ},
    {id: 'p_hi2_end', text: BASE + ACUTE + HI + HI},
    {id: 'p_hi_lo_end', text: BASE + ACUTE + HI + LO}
  ];

  Ns2Webkit.registerExperiment({
    name: 'emojiclamp2',
    description: 'Where does a lone surrogate zero the run: whole string, tail only, or never (DOM drop)? Measures width, height, rect count and DOM text length per case.',
    run: function (params) {
      var args = (params && params.experimentArgs) || {};
      var hold = Number(args.hold);
      if (!isFinite(hold) || hold < 0) hold = HOLD_DEFAULT;

      var report = {hold: hold, cases: [], notes: []};

      for (var c = 0; c < CASES.length; c++) {
        var item = CASES[c];
        var m = measure(item.text, item.font);
        m.id = item.id;
        m.font = item.font ? 'mono' : 'sans';
        // did the DOM keep every UTF-16 unit?
        m.kept = m.domLen === m.units && m.nodeLen === m.units;
        // zero width with a live line box means "laid out, contributed nothing";
        // zero height means there is no line box at all.
        m.zeroed = m.w === 0;
        report.cases.push(m);
      }

      function byId(id) {
        for (var i = 0; i < report.cases.length; i++)
          if (report.cases[i].id === id) return report.cases[i];
        return null;
      }

      var baseAcc = byId('p_acc');
      var hiEnd = byId('p_hi_end');
      var hiMid = byId('p_hi_mid');
      var hiLead = byId('p_hi_lead');
      var sHiEnd = byId('s_hi_end');

      // (B) needs a DOM or line-box explanation. Any case that lost units, or
      // reports zero height, is dropped-text rather than zero-advance text.
      var lost = [];
      var noLineBox = [];
      for (var i = 0; i < report.cases.length; i++) {
        if (!report.cases[i].kept) lost.push(report.cases[i].id);
        if (report.cases[i].zeroed && report.cases[i].h === 0)
          noLineBox.push(report.cases[i].id);
      }
      report.lost = lost;
      report.noLineBox = noLineBox;

      // The position test: if the base before the surrogate still measures its
      // own width, the peer zeroed the run only from the surrogate onward -> (A).
      report.tailOnly = hiMid.w > 0 && Math.abs(hiMid.w - baseAcc.w) < 1.5;
      report.wholeRun = hiLead.w === 0 && hiEnd.w === 0 && hiMid.w === 0;
      report.simpleHit = sHiEnd.w === 0;

      report.verdict = lost.length ? 'text lost before layout: ' + lost.join(',')
        : noLineBox.length ? 'no line box for: ' + noLineBox.join(',')
        : report.tailOnly ? 'peer consumed the run from the surrogate to its end (clamp)'
        : report.wholeRun ? 'whole run zeroed wherever the surrogate sits'
        : 'partial: see per-case widths';

      var out = document.createElement('div');
      out.setAttribute('id', 'emojiclamp2-out');
      out.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;' +
        'background:#000;color:#0f0;font:11px monospace;padding:6px 8px;' +
        'white-space:pre;line-height:1.25';
      var lines = ['emojiclamp2: ' + report.verdict];
      for (var q = 0; q < report.cases.length; q++) {
        var row = report.cases[q];
        lines.push((row.id + '             ').slice(0, 14) +
          String(row.w).padStart(6) + ' h' + String(row.h).padStart(5) +
          ' r' + row.rects + ' u' + String(row.units).padStart(3) +
          '/' + row.domLen + '/' + row.nodeLen + (row.kept ? '' : ' LOST'));
      }
      out.textContent = lines.join('\n');
      document.body.appendChild(out);

      return new Promise(function (resolve) {
        setTimeout(function () { resolve(report); }, hold);
      });
    }
  });
})();
