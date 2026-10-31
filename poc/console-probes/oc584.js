// oc584: does OffscreenCanvas::getContext() have the same reentrancy window as
// HTMLCanvasElement::getContext(), and does the shipped engine guard it?
//
// In the 19.0.0 drop both functions have the shape
//
//     if (m_context) return m_context;          // entry check
//     settings = convert<...>(arguments[0]);    // page getters run here
//     m_context = create(...);                  // releases the old context
//
// so a getter that calls back into getContext() can install a context that the
// outer call then drops while the page still holds a wrapper for it. On the
// document canvas the console answers "no": uaf584-attrs returned the inner
// context and ignored the outer settings (desynchronized:false although the
// getter returned true), i.e. the shipped binary re-checks m_context after the
// conversion even though the published source does not.
//
// OffscreenCanvas is a separate function in a separate file, so the same
// question is worth one run. The getter returns desynchronized:true, which
// makes one report answer both questions:
//
//   outer attributes true  -> the outer call built a new context (window open)
//   outer attributes false -> the outer call returned the inner one (guarded)
//
// A lineWidth written to the inner context before the outer call returns is
// reported too: a context whose destructor ran reads back its default 1.
//
// Queue with:
//   sudo node tools/experiment.mjs enqueue oc584 --label oc584-1
(function () {
  'use strict';
  if (typeof Ns2Webkit === 'undefined' || !Ns2Webkit.registerExperiment)
    throw new Error('oc584: Ns2Webkit.registerExperiment is missing');

  Ns2Webkit.registerExperiment({
    name: 'oc584',
    description: 'OffscreenCanvas getContext reentrancy: re-check, or UAF?',
    run: function (params) {
      var report = {
        hasCtor: typeof OffscreenCanvas === 'function',
        reentered: false,
        stale: false,
        outerSame: null,
        cachedSame: null,
        desyncAsked: true,
        outerAttrs: null,
        staleAttrs: null,
        lwAfter: null,
        innerSize: null,
        out: 'not-run'
      };

      if (!report.hasCtor) {
        report.out = 'no OffscreenCanvas constructor';
        return report;
      }

      var offscreen;
      try {
        offscreen = new OffscreenCanvas(64, 64);
      } catch (error) {
        report.out = 'constructor threw ' + error;
        return report;
      }

      var stale = null;
      var outer = null;
      var reentered = false;

      function reenter() {
        if (reentered) return;
        reentered = true;
        try {
          stale = offscreen.getContext('2d');
        } catch (error) {
          report.out = 'inner getContext threw ' + error;
          return;
        }
        if (stale) {
          // Written before the outer call returns. A destructor resets the
          // context state, so this reads back 1 if the inner context died.
          stale.lineWidth = 7.25;
          report.innerSize = 'lw=' + stale.lineWidth;
        }
      }

      try {
        outer = offscreen.getContext('2d', {
          get desynchronized() { reenter(); return true; },
          get willReadFrequently() { reenter(); return false; },
          get alpha() { reenter(); return true; },
          get colorSpace() { reenter(); return 'srgb'; }
        });
      } catch (error) {
        report.out = 'outer getContext threw ' + error;
      }

      report.reentered = reentered;
      report.stale = !!stale;
      report.outerSame = (outer === stale);

      if (stale) {
        try {
          report.cachedSame = (offscreen.getContext('2d') === stale);
        } catch (error) {
          report.cachedSame = 'threw ' + error;
        }
      }
      try {
        report.outerAttrs = outer ? JSON.stringify(outer.getContextAttributes()) : 'null';
      } catch (error) {
        report.outerAttrs = 'threw ' + error;
      }
      try {
        report.staleAttrs = stale ? JSON.stringify(stale.getContextAttributes()) : 'null';
      } catch (error) {
        report.staleAttrs = 'threw ' + error;
      }
      if (stale) {
        try {
          report.lwAfter = stale.lineWidth;
        } catch (error) {
          report.lwAfter = 'threw ' + error;
        }
      }

      report.out = 'outer=' + report.outerAttrs + ' stale=' + report.staleAttrs
        + ' same=' + report.outerSame + ' cached=' + report.cachedSame
        + ' lwAfter=' + report.lwAfter;
      return report;
    }
  });
})();
