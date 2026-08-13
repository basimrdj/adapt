# Phase 3.1B Real-World Validation

This procedure is intentionally a release gate, not a marketing checklist.
Run each comparison on a fresh Chromium profile with cache, cookies, account
state, and extensions reset between runs. Record the browser version, OS,
profile identifier, timestamp, URL, and console/network errors for every row.

## Procedure

1. Build ADAPT from the candidate commit and install only that unpacked build.
2. Repeat the same navigation sequence with uBO Lite, AdGuard MV3, and no blocker.
3. For each category, capture one clean load, one reload, one back/forward cycle,
   and one SPA route transition where the site supports it.
4. Record blocked requests, visible ad occurrences, content survival, playback
   controls, console errors, and CPU/memory symptoms without changing page state.
5. Mark a row **PASS** only when the observation is reproducible twice; use
   **NOT OBSERVED** when no genuine ad occurrence was seen, never convert that
   state into a success claim.

Use the following per-category checks:

- YouTube: pre-roll, mid-roll, sponsored cards, playback, seeking, volume,
  captions, comments, playlists, Shorts, SPA navigation, and JavaScript errors.
- News publisher: display, sticky, in-article, consent, paywall, login, and
  article navigation breakage.
- Social/forum: feed loading, infinite scroll, media playback, compose/reply,
  login state, and false positives on ordinary “advertisement” text.
- Search: result integrity, sponsored result handling, pagination, and query
  navigation.
- Ecommerce: product grid, cart, checkout, reviews, recommendations, and
  third-party payment frames.
- Streaming SPA: startup, ad break behavior, seeking, captions, route changes,
  and player controls.
- Anti-adblock demo/ad-heavy page: detector trigger, overlay, scroll lock,
  pointer behavior, reinsertion, and page content survival.

The synthetic 30/30 corpus and local Chromium suites are necessary but do not
replace this live comparison. A real YouTube result requires a genuine ad
occurrence observed during the run.

## Matrix

| Category | ADAPT | uBO Lite | AdGuard MV3 | No blocker | Status |
|---|---|---|---|---|---|
| Large video site / YouTube | NOT OBSERVED | Pending | Pending | Pending | No live ad occurrence claimed. |
| News publisher | Pending | Pending | Pending | Pending | Not yet measured. |
| Forum/social feed | Pending | Pending | Pending | Pending | Not yet measured. |
| Search engine | Pending | Pending | Pending | Pending | Not yet measured. |
| Ecommerce | Pending | Pending | Pending | Pending | Not yet measured. |
| Documentation/static | Pending | Pending | Pending | Pending | Not yet measured. |
| Streaming-style SPA | Pending | Pending | Pending | Pending | Synthetic SPA coverage exists. |
| Anti-adblock demonstration | Synthetic only | Pending | Pending | Pending | Real-site behavior not claimed. |
| Ad-heavy test page | Synthetic only | Pending | Pending | Pending | Comparison benchmark not yet complete. |

## YouTube acceptance

The compiler preserves the maintained YouTube exception and `set-constant`
descriptor when present in the selected filter source. This is not proof that
pre-roll, mid-roll, sponsored cards, or every SPA route is blocked. No manual
live ad occurrence was observed during this run, so the real-world YouTube
rows remain pending and must not be presented as passing.

The required evidence is a clean-profile run recording whether a genuine
YouTube pre-roll or mid-roll appears and whether playback, seeking, volume,
captions, comments, playlists, live streams, and Shorts navigation remain
healthy. Until that evidence exists, YouTube remains **NOT OBSERVED**, not PASS.
