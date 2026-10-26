// Smoke test for the grafted ACCESS/NetFront JavaScriptCore build.
// Run: jsc --useJIT=false test-smoke.js
print('1+1=' + (1 + 1));
print('typeofError=' + typeof Error);
print('typeofWebAssembly=' + typeof WebAssembly);
print('error.stack=' + (new Error('smoke').stack.split('\n').length) + ' lines');
