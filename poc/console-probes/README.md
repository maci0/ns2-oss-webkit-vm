# Console probes

The probes behind RESULTS.md §9.8–§9.10, exactly as they ran on the console.
They are not standalone pages: each one is an experiment module for the rig's
page harness (`ns2jb-webkit/`), registered with
`Ns2Webkit.registerExperiment({name, description, run})`. The harness supplies
`params` (including `experimentArgs`) and returns `run()`'s value as the
attempt's recorded result; the page also mirrors its log into
`report.jsonl`.

To run one, drop the file into `ns2jb-webkit/www/experiments/` and enqueue an
entry that names it:

```sh
node tools/experiment.mjs enqueue feconv --args '{"targetY":45,"bias":144}'
```

`tools/experiment.mjs list` prints the registered names and their descriptions.

| file | question | result |
|---|---|---|
| `protoattr-check.js` | can the 23.0.1 GetterSetter addrof install a `prototype` accessor on a real function? | nine shapes, eight `TypeError`, one control (`arrow-plain`) | §9.8 |
| `uaf584.js` | does a re-entrant `getContext('2d')` free the inner context (canvas #15)? | the object is never released; `outerSame:true`, `fired:0` | §9.9 |
| `oc584.js` | is there an `OffscreenCanvas` branch to try instead? | no constructor in this engine | §9.9 |
| `gl584.js` | is there a WebGL branch? | `webgl unavailable` | §9.9 |
| `feconv.js` | does an out-of-range `targetY` set after the build reach the applier (write overflow, #5)? | survived, `hits:0` over 24 × 256 KiB of page memory | §9.10 |
| `feconv-look.js` | same trigger, read off the screen instead of the heap | armed square stops painting; valid control keeps painting | §9.10 |

`feconv-look.js` is the pattern for a visual oracle: two identical filtered
squares side by side, the reference left untouched, `armDelay` between the
first paint and the state change so a capture can see the pre-arm frame, then
`hold` keeps the page still while `preview.jpg` is sampled. Two of its captures
are in [`../media/`](../media/).
