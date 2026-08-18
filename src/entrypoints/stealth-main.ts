/**
 * stealth-main.ts — ADAPT stealth plane bootstrap (Phase D1).
 *
 * Registered as a MAIN-world content script at document_start on every frame
 * (see src/manifest.json). Runs before any page script and pre-seeds the
 * benign values that generic adblock detectors probe for, so the most common
 * detection class ("global flag says blocker present") never trips.
 *
 * Semantics mirror the audited set-constant scriptlet: a getter returns the
 * benign value and the setter swallows writes, so a detector script that tries
 * to flip the flag later cannot. Properties are configurable and non-enumerable
 * (indistinguishable from a page-defined global in casual inspection).
 *
 * Scope discipline: ONLY detector-specific flag names are touched. Nothing a
 * legitimate site would gate real behavior on is overridden (no ga, no
 * navigator, no DOM APIs). The adsbygoogle stub matches the shipped shim so
 * the global behaves identically whether the bait script was redirected to the
 * shim or never executed at all.
 *
 * Learned per-site anti-detector actions (Phase D2) are applied separately via
 * the isolated content script → background executeScript pathway; this file
 * stays fully deterministic and offline.
 */

type PageObject = Record<string, unknown>;

(function stealthMainBootstrap() {
  const root = globalThis as unknown as PageObject;

  const seed = (path: string, value: unknown): void => {
    try {
      const segments = path.split('.');
      if (segments.some((s) => s === '__proto__' || s === 'prototype' || s === 'constructor')) return;
      let parent: PageObject = root;
      for (const segment of segments.slice(0, -1)) {
        const next = parent[segment];
        if (next && typeof next === 'object') {
          parent = next as PageObject;
          continue;
        }
        const created: PageObject = Object.create(null);
        Object.defineProperty(parent, segment, {
          configurable: true,
          enumerable: false,
          writable: true,
          value: created,
        });
        parent = created;
      }
      const key = segments[segments.length - 1]!;
      Object.defineProperty(parent, key, {
        configurable: true,
        enumerable: false,
        get: () => value,
        set: () => undefined,
      });
    } catch {
      // Page pre-defined the global as non-configurable — leave it alone.
    }
  };

  // Detector flag surface (false = "no blocker here", true = "ads can run").
  const FALSE_FLAGS = [
    'adblock',
    'adBlock',
    'adblocker',
    'adBlocker',
    'adBlockEnabled',
    'adblockEnabled',
    'adBlockDetected',
    'adblockDetected',
    'isAdBlockActive',
    'isAdblockActive',
    'adsBlocked',
    'adBlocked',
    'abDetected',
    'abp',
    'blockerDetected',
    'isBlockerActive',
  ];
  const TRUE_FLAGS = [
    'canRunAds',
    'canShowAds',
    'adsEnabled',
    'adsAllowed',
    'adsbygoogleLoaded',
  ];

  for (const flag of FALSE_FLAGS) seed(flag, false);
  for (const flag of TRUE_FLAGS) seed(flag, true);

  // adsbygoogle stub — identical behavior to web-accessible-resources/shims/adsbygoogle.js
  // so detectors see a consistent world whether the network shim fired or not.
  // Processed-slot tracking uses a WeakSet, NOT a DOM attribute: a
  // `data-adapt-*` marker would be a zero-effort blocker fingerprint.
  // `data-ad-status="filled"` stays — the real Google loader sets exactly that.
  const shimmedSlots = new WeakSet<Element>();
  try {
    const existing = (root as { adsbygoogle?: unknown }).adsbygoogle;
    if (!existing || (typeof existing === 'object' && !(existing as { loaded?: boolean }).loaded)) {
      const queue = (Array.isArray(existing) ? existing : []) as unknown[] & Record<string, unknown>;
      const noop = () => undefined;
      queue.loaded = true;
      queue.push = function () {
        try {
          const slots = document.querySelectorAll('ins.adsbygoogle');
          for (const slot of slots) {
            if (shimmedSlots.has(slot)) continue;
            shimmedSlots.add(slot);
            slot.setAttribute('data-ad-status', 'filled');
            break;
          }
        } catch {
          /* never throw into the page */
        }
        return 0;
      };
      queue.pauseAdRequests = noop;
      queue.enablePageLevelAds = noop;
      queue.setRequestNonPersonalizedAds = noop;
      Object.defineProperty(root, 'adsbygoogle', {
        configurable: true,
        enumerable: true,
        get: () => queue,
        set: (value: unknown) => {
          if (Array.isArray(value)) {
            (value as unknown[] & Record<string, unknown>).loaded = true;
            (value as unknown[] & Record<string, unknown>).push = queue.push;
          }
        },
      });
    }
  } catch {
    /* non-configurable adsbygoogle — leave it */
  }

  // Some detectors probe for the DoubleClick/Google jobrunner object existing.
  seed('google_jobrunner', Object.freeze(Object.create(null)));

  // ---------------------------------------------------------------------------
  // Phantom-marker trap (deterministic, zero-escape for parse-time checkers).
  //
  // The detectadblock.com / Adblock-Analytics detector class works like this:
  // a vendor bait script creates a hidden marker div with a random id; an inline
  // parser-time checker then runs `getElementById('<random id>')` and swaps a
  // wall in when the marker is missing (i.e. when the bait script was blocked).
  //
  // Learning the id and replaying it (Phase D2a learning path) loses the race
  // against parser-time checkers — extension storage is async and the checker
  // runs during the initial parse. So instead we trap the CHECK itself:
  // getElementById calls made by an inline checker-shaped script (same script
  // block contains a two-branch `.display` swap) for a random-looking id that
  // does not exist get a real, hidden, inert div created on the spot — exactly
  // what the page would see with no blocker present.
  //
  // Safety rails: the trap only fires for (a) absent ids, (b) random-looking
  // names, (c) parser-executed INLINE scripts (document.currentScript set, no
  // src), (d) checker-shaped bodies. Normal page code paths never touch it, and
  // every fabricated marker is cached so repeated probes return the same node.
  // ---------------------------------------------------------------------------
  const fabricated = new Map<string, HTMLElement>();
  const RANDOMISH = /^[A-Za-z0-9]{10,40}$/;

  const looksRandom = (id: string): boolean => {
    if (!RANDOMISH.test(id)) return false;
    if (/^(.)\1+$/.test(id)) return false; // aaaaaaaa
    // Must mix letters and contain no long vowel run — random ids are consonant/noise
    // heavy; human-named ids (header, maincontent) read like words.
    if (!/[a-z]/i.test(id)) return false;
    if (/[aeiou]{3,}/i.test(id)) return false;
    return true;
  };

  const callerLooksLikeChecker = (): boolean => {
    try {
      const current = document.currentScript as HTMLScriptElement | null;
      if (!current || current.src) return false; // only parser-time inline scripts
      const text = current.textContent || '';
      if (!text.includes('.display') || !/else\s*\{/.test(text)) return false;
      return true;
    } catch {
      return false;
    }
  };

  try {
    const original = Document.prototype.getElementById;
    const trapped = function (this: Document, id: string): HTMLElement | null {
      const found = original.call(this, id);
      if (found || typeof id !== 'string' || !looksRandom(id)) return found;
      const cached = fabricated.get(id);
      if (cached) return cached;
      if (!callerLooksLikeChecker()) return found;
      try {
        const marker = document.createElement('div');
        marker.id = id;
        marker.style.display = 'none';
        marker.setAttribute('aria-hidden', 'true');
        (document.body || document.documentElement || document).appendChild(marker);
        fabricated.set(id, marker);
        return marker;
      } catch {
        return found;
      }
    };
    Object.defineProperty(Document.prototype, 'getElementById', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: trapped,
    });
  } catch {
    /* Document.prototype locked down — the learning path still covers us */
  }
})();
