/**
 * bait-replay.ts — content-side half of Phase D2a (learned bait replay).
 *
 * Two jobs:
 *   1. REPLAY (document_start, every visit): ask the background for this site's
 *      learned detector-bait marker ids and create the hidden inert divs before
 *      the page's inline checker runs, so the checker takes its "no blocker"
 *      branch. The background ALSO pushes a MAIN-world replay at navigation
 *      commit — both paths are idempotent on the same ids.
 *   2. LEARN (after DOMContentLoaded, first escapes): scan inline scripts for
 *      the checker shape — getElementById('<random id>') with a two-branch
 *      display swap — and report absent ids as candidates. The background only
 *      accepts them when a script was hard-blocked on this tab (the detector
 *      context), then returns the accepted ids so they can be replayed
 *      immediately (late checkers still pass on the learning visit).
 *
 * After any replay we watch briefly for an adblock-wall becoming visible; the
 * outcome feeds back so stale ids get dropped (detector kits rotate ids).
 */

const ID_PATTERN = /^[A-Za-z0-9]{10,40}$/;
const MAX_CANDIDATES = 6;
const WALL_TEXT = /you'?re blocking|ad ?block(er)? (detected|enabled|is on)|disable (your )?ad ?block|please (disable|turn off) (your )?ad ?block/i;

function createBaitDiv(id: string): boolean {
  try {
    if (!ID_PATTERN.test(id) || document.getElementById(id)) return false;
    const div = document.createElement('div');
    div.id = id;
    div.style.display = 'none';
    div.setAttribute('aria-hidden', 'true');
    (document.documentElement || document).appendChild(div);
    return true;
  } catch {
    return false;
  }
}

function replay(ids: string[]): number {
  let created = 0;
  for (const id of ids) {
    if (createBaitDiv(id)) created += 1;
  }
  return created;
}

/** Inline scripts with the detector-checker shape: getElementById + display swaps in both branches. */
function extractCandidates(): string[] {
  const candidates = new Set<string>();
  try {
    const scripts = document.querySelectorAll('script:not([src])');
    for (const script of Array.from(scripts).slice(0, 120)) {
      const text = script.textContent || '';
      if (!text.includes('getElementById') || !text.includes('.display')) continue;
      if (!/else\s*\{/.test(text)) continue;
      const matches = text.matchAll(/getElementById\(\s*['"]([A-Za-z0-9]{10,40})['"]\s*\)/g);
      for (const match of matches) {
        const id = match[1]!;
        if (!ID_PATTERN.test(id)) continue;
        if (document.getElementById(id)) continue; // side effect happened — nothing blocked
        candidates.add(id);
        if (candidates.size >= MAX_CANDIDATES) return [...candidates];
      }
    }
  } catch {
    /* DOM unavailable */
  }
  return [...candidates];
}

function watchForWall(windowMs: number): void {
  const deadline = Date.now() + windowMs;
  const check = (): void => {
    if (Date.now() > deadline) return;
    try {
      const body = document.body;
      if (body && WALL_TEXT.test(body.innerText.slice(0, 4000))) {
        void chrome.runtime.sendMessage({ v: 1, type: 'STEALTH_REPLAY_OUTCOME', wallSeen: true });
        return;
      }
    } catch {
      return;
    }
    window.setTimeout(check, 700);
  };
  window.setTimeout(check, 700);
  window.setTimeout(() => {
    try {
      const body = document.body;
      const wallSeen = Boolean(body && WALL_TEXT.test(body.innerText.slice(0, 4000)));
      void chrome.runtime.sendMessage({ v: 1, type: 'STEALTH_REPLAY_OUTCOME', wallSeen });
    } catch {
      /* noop */
    }
  }, windowMs);
}

export function initBaitReplay(): void {
  if (window.top !== window) return; // top frame only — checkers live there

  // REPLAY path: pull the site's profile as early as messaging allows.
  try {
    void chrome.runtime.sendMessage({ v: 1, type: 'STEALTH_PROFILE_GET' }).then((response) => {
      const profile = (response ?? {}) as { baitIds?: string[]; constants?: Array<{ path: string; value: string }> };
      const ids = profile.baitIds ?? [];
      if (ids.length > 0) {
        const created = replay(ids);
        if (created > 0) watchForWall(5000);
      }
      // AI-learned detector counter-constants (D2b) go through the audited
      // MAIN-world set-constant scriptlet path (validated there again).
      for (const constant of (profile.constants ?? []).slice(0, 8)) {
        if (!constant || typeof constant.path !== 'string' || typeof constant.value !== 'string') continue;
        void chrome.runtime.sendMessage({
          v: 1,
          type: 'PAGE_FILTER_MAIN_SCRIPTLET',
          ruleId: `stealth_const_${constant.path}`,
          name: 'set-constant',
          args: [constant.path, constant.value],
        }).catch(() => undefined);
      }
    }).catch(() => undefined);
  } catch {
    /* extension context gone */
  }

  // LEARN path: once parsed, look for checker scripts whose marker never appeared.
  const scan = (): void => {
    const candidates = extractCandidates();
    if (candidates.length === 0) return;
    try {
      void chrome.runtime.sendMessage({ v: 1, type: 'STEALTH_BAIT_CANDIDATES', candidates }).then((response) => {
        const accepted = (response as { accepted?: string[] } | undefined)?.accepted ?? [];
        if (accepted.length > 0) replay(accepted);
      }).catch(() => undefined);
    } catch {
      /* extension context gone */
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan, { once: true });
  } else {
    scan();
  }
  // Slow-worker backstop: if the first scan raced the blocked-script context
  // (cold service worker), a second early scan lets the settled learn replay
  // before delayed checkers fire. The 2500ms scan covers late-inserted checkers.
  window.setTimeout(scan, 900);
  window.setTimeout(scan, 2500);
}
