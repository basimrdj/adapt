/**
 * Cosmetic replay guard (Phase E, page side).
 *
 * Learned per-site hides are replayed as pre-paint CSS injected at navigation
 * commit. This module is the safety loop: if a replayed rule collapses the
 * page's content (markup drift turned a sponsored-widget selector into a main-
 * content match), it reports `broke` so the background un-hides immediately and
 * downgrades the rule. It also reports per-selector match/miss so stale rules
 * age out instead of accumulating forever.
 *
 * Zero work on sites with no learned hides (the GET comes back empty).
 */

const MIN_VISIBLE_TEXT = 80;
/**
 * A hide only counts as breakage when the hidden subtree carried substantial
 * content. Sparse pages (app shells, gated teasers, media pages) legitimately
 * show little text, and a gate overlay hides little more — treating that as
 * breakage strips a correct replay (removeCSS) and burns the rule's failure
 * budget on pages the hide was right for.
 */
const MIN_HIDDEN_TEXT_FOR_BROKE = 200;

/** Exported for tests: the breakage decision behind the `broke` report. */
export function cosmeticReplayLooksBroken(matchedCount: number, hiddenTextLength: number, visibleTextLength: number): boolean {
  return matchedCount > 0
    && hiddenTextLength >= MIN_HIDDEN_TEXT_FOR_BROKE
    && visibleTextLength < MIN_VISIBLE_TEXT;
}

function visibleTextLength(): number {
  try {
    return (document.body?.innerText ?? '').trim().length;
  } catch {
    return 0;
  }
}

export function initCosmeticReplayGuard(): void {
  if (window.top !== window) return;
  try {
    void chrome.runtime.sendMessage({ v: 1, type: 'COSMETIC_REPLAY_GET' }).then((response) => {
      const selectors = (response as { selectors?: string[] } | undefined)?.selectors ?? [];
      if (!Array.isArray(selectors) || selectors.length === 0) return;
      const wanted = selectors.filter((item) => typeof item === 'string').slice(0, 12);
      if (wanted.length === 0) return;

      let reported = false;
      const sample = (): { broke: boolean; matched: string[]; missed: string[] } => {
        const matched: string[] = [];
        const missed: string[] = [];
        let hiddenText = 0;
        for (const selector of wanted) {
          try {
            const element = document.querySelector(selector);
            if (element) {
              matched.push(selector);
              hiddenText += (element.textContent ?? '').trim().length;
            } else {
              missed.push(selector);
            }
          } catch {
            missed.push(selector);
          }
        }
        // Breakage = we hid a subtree carrying substantial content AND the
        // page's remaining visible text collapsed. (innerText excludes
        // display:none subtrees, so over-hiding shows up here; textContent
        // still counts what the replayed rule removed.)
        return { broke: cosmeticReplayLooksBroken(matched.length, hiddenText, visibleTextLength()), matched, missed };
      };
      const report = (a: ReturnType<typeof sample>, b: ReturnType<typeof sample>): void => {
        if (reported) return;
        reported = true;
        // Union of both samples: a selector counts as matched if seen at either
        // point (late inserters), missed only if never seen, broke if the page
        // was ever observed collapsed under the replay.
        const matched = [...new Set([...a.matched, ...b.matched])];
        const missed = wanted.filter((selector) => !matched.includes(selector));
        const broke = a.broke || b.broke;
        try {
          void chrome.runtime.sendMessage({
            v: 1,
            type: 'COSMETIC_REPLAY_OUTCOME',
            broke,
            matched,
            missed,
          }).catch(() => undefined);
        } catch {
          /* extension context gone */
        }
      };

      const run = (): void => {
        const first = sample();
        window.setTimeout(() => report(first, sample()), 900);
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => window.setTimeout(run, 600), { once: true });
      } else {
        window.setTimeout(run, 600);
      }
    }).catch(() => undefined);
  } catch {
    /* extension context gone */
  }
}
