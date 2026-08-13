# Phase 3.1B Real-World Validation

## Matrix

| Category | ADAPT | uBO Lite | AdGuard MV3 | No blocker | Status |
|---|---|---|---|---|---|
| Large video site / YouTube | Pending live occurrence | Pending | Pending | Pending | Requires clean-profile manual/live observation. |
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

The single manual observation needed for the next validation pass is: on a
clean Chromium profile with ADAPT enabled, report whether a genuine YouTube
pre-roll or mid-roll appears and whether playback, seeking, volume, captions,
comments, playlists, live streams, and Shorts navigation remain healthy.
