/**
 * nobab.js — defuser for the BlockAdBlock (blockadblock.com) detector family.
 * Anti-detector shim (ADAPT stealth plane). The real BAB script creates a
 * window.blockAdBlock / window.BlockAdBlock whose onDetected callbacks fire
 * when its bait is blocked. This stand-in implements the documented class
 * surface and reports "not detected" forever: on()/onDetected() callbacks for
 * the detected event are never invoked; not-detected callbacks fire async
 * (matching the real script's async check loop cadence).
 */
(function () {
  'use strict';
  var makeBab = function () {
    var handlers = {};
    var api = {
      setOption: function () { return api; },
      on: function (event, cb) {
        handlers[event] = cb;
        if (event === false || event === 'onNotDetected' || event === 'notDetected') {
          try { setTimeout(function () { cb(false); }, 40); } catch (e) { /* noop */ }
        }
        return api;
      },
      onDetected: function (cb) { return api; },
      onNotDetected: function (cb) {
        try { setTimeout(function () { cb(false); }, 40); } catch (e) { /* noop */ }
        return api;
      },
      check: function () { return Promise.resolve(false); },
      clearEvent: function () { return api; },
    };
    return api;
  };
  try {
    Object.defineProperty(window, 'blockAdBlock', {
      configurable: true, enumerable: false,
      get: function () { return makeBab(); },
      set: function () { /* swallow the real detector's self-registration */ },
    });
    Object.defineProperty(window, 'BlockAdBlock', {
      configurable: true, enumerable: false,
      get: function () { return makeBab; },
      set: function () { /* swallow */ },
    });
  } catch (e) { /* page already defined them read-only — fine */ }
})();
