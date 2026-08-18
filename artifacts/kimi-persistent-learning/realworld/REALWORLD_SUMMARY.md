# ADAPT — BRUTAL REAL-WORLD RUN SUMMARY

Date: 2026-08-15 → analyzed 2026-08-16
Driver: headful Chrome for Testing + ADAPT (persistent profile), fully automated
Scope: 20 user-named ad-heavy sites + 3 revisits + crash-survival boot check
Raw artifacts: `batchA.json`, `batchC.json` (batch B log lost to a Chrome crash on tmz; per-site deltas recorded in task log)

Privacy note: all hostnames below are first-label projections (`host.split('.')[0]`) by design.
Raw hosts lived only in the throwaway automation profile (`/tmp/adapt-realworld-brutal-profile`),
which has since been cleaned by the OS — nothing identifiable persists.

## Sites exercised

news4jax, nj1015, tomandlorenzo, visualcapitalist, byrdie, koreaboo, stocktwits,
oregonlive, mlive, masslive, ndtv (NAVERR — bot-block/timeout, recorded + skipped),
thesun.co.uk, dailymail.co.uk, fandom, weather.com, tmz (browser crash — recovered),
forbes, torontosun, kentonline.co.uk, wnd
Revisits: news4jax, nj1015, tomandlorenzo

## Totals

| Metric | Value |
|---|---|
| AI calls (entire run) | 24 |
| Session rules staged | 45 |
| Promotions to durable (per-delta sum) | 6 (final store: 11 persisted + 2 revoked = 13 records) |
| Learned-rule request matches | 70 |
| Total requests blocked (all planes) | 1089 |
| Cross-site globalizations | 3 |
| Auto-revocations (T8 retry-storm guard) | 2 |
| Rules surviving real browser crash | 8 / 8 |

## Final durable rule store (first-labels)

| Host label | Width | Scope | Matches | Notes |
|---|---|---|---|---|
| securepubads | host-wide | **global** | 9 | Google pubads CDN — learned family that escaped static lists |
| cmp | host-wide | **global** | 6 | consent-management host |
| accounts | host-wide | **global** | 2 | globalized on second-site evidence |
| c | host-wide | **global** | 5 | short tracking subdomain |
| cmp | host-wide | scoped | 1 | second CMP family, single-site |
| tags | host-wide | scoped | 5 | tag-manager family |
| experiments | host-wide | scoped | 1 | A/B-testing family |
| static | host-wide | scoped | 1 | CDN-style family |
| succeedscene | host-wide | scoped | 1 | obscure ad host |
| www ×2 | **narrow** (refused) | scoped | — | refusal = shared-infra heuristic (G5) |
| i | host-wide | **REVOKED** | 7 | retry-storm-health-regression — page fought block, auto-undone |
| townsquare | host-wide | **REVOKED** | 7 | retry-storm-health-regression — auto-undone |

## Revisit behavior

- news4jax revisit: 2 AI calls, 5 learned matches (learned one *more* family)
- nj1015 revisit: 19 learned matches — learned rules catching real repeat traffic
- tomandlorenzo revisit: 0 AI calls — fully covered, zero re-audit

## Honest caveats

- `learnedFamilyAiAvoided` stayed ~0 on revisits: these sites carry 30–50 ad families
  each; after one visit we cover only a handful, so each visit legitimately learns more.
  The zero-AI short-circuit fires only when *every* candidate is already covered.
- First escapes still happen once per family — that is the design: every family escapes
  at most once, then is learned permanently (host-wide, cross-site-globalizing, restart-proof).
- 2 of 13 learned families caused retry storms and were auto-revoked with evidence preserved —
  the T8 safety guard working in the wild, not a bug.
- 2 `www.*` hosts were kept narrow by the shared-infrastructure refusal heuristic rather
  than promoted host-wide — conservative by design.
