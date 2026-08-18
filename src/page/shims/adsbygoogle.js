/**
 * adsbygoogle.js — neutered stand-in for Google's adsbygoogle entry script.
 *
 * Anti-detector shim (ADAPT stealth plane): detectors probe whether the real
 * pagead2.googlesyndication.com/pagead/js/adsbygoogle.js loaded by checking
 * window.adsbygoogle and the `loaded` flag, or by observing onerror on the
 * script tag. A hard block trips both. Redirecting here satisfies the probes
 * while every ad push is silently absorbed — no ad ever renders.
 *
 * Behaviors reproduced (documented public API surface only):
 *   - window.adsbygoogle exists as an array-like (pages push configs onto it)
 *   - .push() accepts any config and no-ops (optionally creating an empty
 *     placeholder child so layouts that measure the ins element stay calm)
 *   - .loaded === true
 *   - window.adsbygoogle.pauseAdRequests / enablePageLevelAds / setRequestNonPersonalizedAds
 *     exist as no-ops for pages that configure before pushing
 */
(function () {
  'use strict';
  if (window.adsbygoogle && window.adsbygoogle.loaded) { return; }

  var queue = Array.isArray(window.adsbygoogle) ? window.adsbygoogle : [];
  var noop = function () { return undefined; };
  // Processed-slot tracking lives in a WeakSet — a `data-adapt-*` DOM attribute
  // would be a zero-effort blocker fingerprint. `data-ad-status="filled"` is
  // exactly what the real Google loader sets, so it stays.
  var shimmedSlots = new WeakSet();

  var push = function (config) {
    try {
      // Pages usually do: (adsbygoogle = window.adsbygoogle || []).push({})
      // after an <ins class="adsbygoogle">. The real script injects an iframe;
      // we inject nothing but mark the element as processed so MutationObservers
      // watching for the fill settle down.
      var slots = document.querySelectorAll('ins.adsbygoogle');
      for (var i = 0; i < slots.length; i++) {
        var ins = slots[i];
        if (shimmedSlots.has(ins)) continue;
        shimmedSlots.add(ins);
        ins.setAttribute('data-ad-status', 'filled');
        break;
      }
    } catch (e) { /* never throw into the page */ }
    return undefined;
  };

  try {
    queue.loaded = true;
    queue.push = push;
    queue.pauseAdRequests = noop;
    queue.enablePageLevelAds = noop;
    queue.setRequestNonPersonalizedAds = noop;
    Object.defineProperty(window, 'adsbygoogle', {
      configurable: true,
      enumerable: true,
      get: function () { return queue; },
      set: function (value) {
        if (Array.isArray(value)) {
          value.loaded = true;
          value.push = push;
          queue = value;
        }
      },
    });
  } catch (e) {
    window.adsbygoogle = queue;
  }
})();
