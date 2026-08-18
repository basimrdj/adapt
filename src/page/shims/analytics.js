/**
 * analytics.js — neutered stand-in for google-analytics analytics.js/ga.js.
 * Anti-detector shim (ADAPT stealth plane): some detectors use an analytics
 * beacon load as their tripwire. Provides the documented ga()/\_gaq surface as
 * no-ops; nothing is ever sent anywhere.
 */
(function () {
  'use strict';
  var noop = function () { return undefined; };
  if (!window.ga) {
    var ga = function () { return ga; };
    ga.create = function () { return ga; };
    ga.getByName = function () { return ga; };
    ga.getAll = function () { return []; };
    ga.send = noop;
    ga.require = noop;
    ga.provide = noop;
    ga.remove = noop;
    ga.loaded = true;
    window.ga = ga;
    window.GoogleAnalyticsObject = 'ga';
  }
  if (!window._gaq) {
    window._gaq = { push: noop };
  }
  if (!window.urchinTracker) {
    window.urchinTracker = noop;
  }
})();
