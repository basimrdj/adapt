/**
 * show_ads.js — neutered stand-in for the legacy Google AdSense show_ads.js.
 * Anti-detector shim (ADAPT stealth plane): defines the documented global
 * surface the legacy script provided so bait checks (`typeof google_show_ads`,
 * onload handlers) settle as "loaded" while rendering nothing.
 */
(function () {
  'use strict';
  var noop = function () { return ''; };
  window.google_show_ads = window.google_show_ads || noop;
  window.google_ad_url = window.google_ad_url || '';
  window.google_num_ads = window.google_num_ads || 0;
})();
