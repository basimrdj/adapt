/**
 * nofab.js — defuser for the FuckAdBlock v3/v4 detector family.
 * Anti-detector shim (ADAPT stealth plane). The real script instantiates
 * FuckAdBlock / fuckAdBlock and fires onDetected when its bait div collapses.
 * This stand-in implements the documented constructor + event surface and
 * reports "not detected" forever.
 */
(function () {
  'use strict';
  var FakeFab = function () {
    if (!(this instanceof FakeFab)) { return new FakeFab(); }
  };
  FakeFab.prototype.on = function (detected, cb) {
    if (detected === false) {
      try { setTimeout(function () { cb(false); }, 40); } catch (e) { /* noop */ }
    }
    return this;
  };
  FakeFab.prototype.onDetected = function () { return this; };
  FakeFab.prototype.onNotDetected = function (cb) {
    try { setTimeout(function () { cb(false); }, 40); } catch (e) { /* noop */ }
    return this;
  };
  FakeFab.prototype.check = function () { return Promise.resolve(false); };
  FakeFab.prototype.setOption = function () { return this; };
  FakeFab.prototype.clearEvent = function () { return this; };
  try {
    Object.defineProperty(window, 'FuckAdBlock', {
      configurable: true, enumerable: false,
      get: function () { return FakeFab; },
      set: function () { /* swallow the real detector's self-registration */ },
    });
    Object.defineProperty(window, 'fuckAdBlock', {
      configurable: true, enumerable: false,
      get: function () { return new FakeFab(); },
      set: function () { /* swallow */ },
    });
  } catch (e) { /* page already defined them read-only — fine */ }
})();
