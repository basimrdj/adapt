# FINAL PERSISTENT LEARNING REPORT

**Date:** 2026-08-16 · **Branch:** feat/phase31b-page-plane · **Build:** `npm run build` (dist, real production bundle with gitignored dev-default AI)

---

## i. Mission and constraint compliance

Goal: ADAPT must get better from normal everyday browsing on arbitrary websites —
learned protections must survive restarts, generalize safely to host level, act
proactively without burning AI calls, and roll back automatically on breakage.

Honored constraints: no git-destructive commands; no commits; no benchmark/tester
source inspection; reserved streaming holdout never touched; STRICT privacy mode
preserved (opaque refs only leave the browser); no benchmark-specific code; no
production dependency on dev-only DNR APIs; AI budget ≤ 2 calls per navigation;
credential never hardcoded into tracked files, never logged, never written to any
artifact (machine-checked in every proof file).

## ii. Root causes confirmed (and corrected) from the pre-pass diagnosis

1. CONFIRMED — learned rules were session-only; `persistLearnedRules` had no
   production caller. Fixed by the Phase A promotion path.
2. CONFIRMED — startup reconcile deleted every learned session rule after any
   worker restart (empty in-memory allocator ⇒ everything looked unknown).
   Fixed by ownership persistence + restart-safe allocator adoption.
3. CONFIRMED — the once-per-origin-per-worker-lifetime audit latch both starved
   re-discovery and (after restarts) wasted AI on already-known families. Fixed
   by navigation-epoch scoping + the known-family short-circuit.
4. CORRECTED — the pre-pass hunch that promotion could be URL-string based was
   rejected during Phase B design: `requestDomains` (Chrome 101+) is the
   DNR-native, non-fragile host match and is what promoted host-wide rules use.

## iii. Chrome platform semantics verified against current official docs

- Dynamic rules persist across browser sessions and extension updates; session
  rules are in-memory and die with the browser. Ownership metadata was therefore
  split: `chrome.storage.session` mirrors session rules, `chrome.storage.local`
  mirrors dynamic rules (reusing the existing `adapt_dnr_dynamic_v1` key).
- Quotas: 30,000 safe dynamic rules (Chrome 121+), 5,000 session; learned
  promotions use the DYNAMIC_SAFE band only.
- `requestDomains` / `initiatorDomains` require Chrome 101+ (subdomains
  matched); `topDomains` (Chrome 145+) was deliberately avoided — the manifest
  declares no `minimum_chrome_version`.
- `updateDynamicRules` is atomic; promotion uses allocate → persist ownership
  (PROMOTING) → real `persistLearnedRules` → verify via `getDynamicRules` →
  mark PERSISTED_DYNAMIC → only then remove the redundant session rule.
- `testMatchOutcome` / `onRuleMatchedDebug` remain dev-only and are NOT used by
  production; learned-match detection uses webRequest initiation +
  `net::ERR_BLOCKED_BY_CLIENT` with requestId dedupe.

## iv. Phase A design — persistence + promotion foundation

- `OwnershipStore` with two areas (session/durable); in-memory authoritative
  cache; debounced flushes; full lifecycle: STAGED_SESSION → HEALTHY_SESSION →
  PROMOTION_ELIGIBLE → PROMOTING → PERSISTED_DYNAMIC (+ DEMOTED / REVOKED).
- Restart-safe allocator: `adopt()` re-registers recovered ids; empty in-memory
  map no longer means unowned.
- Reconcile classification: KNOWN+PRESENT keep/restore, KNOWN+MISSING clean
  metadata (except PROMOTING), UNKNOWN in-band kept for two grace reconciles
  then removed as proven orphan, out-of-band never touched.
- Promotion policy is deterministic: outcome-verifier healthy + host-family
  recurrence + third-party + no durable duplicate. AI confidence is metadata,
  never a promotion trigger.
- Forensics recorder restart deadlock found and fixed (restore chained onto its
  own write chain), which had silently swallowed post-restart events.

## v. Phase A verification (PERSISTENCE_PROOF / WORKER_RESTART_PROOF / PROMOTION_PROOF / BROWSER_RESTART_PROOF)

9/9 checks pass: production AI stages with ownership; worker restart keeps the
session rule and restores ownership with zero orphans; allocator issues fresh
non-colliding ids after restart; recurrence promotes through the REAL
`persistLearnedRules` path and the session rule is removed only after the
dynamic rule is verified present; second worker restart and a full browser
restart preserve the dynamic rule; after the browser restart the known family
is pre-blocked with **zero AI calls** while first-party control loads.

## vi. Phase B design — safe host-level generalization

- EXPERIMENT width stays narrow (exact scheme + authority + coarse path);
  LEARNED width goes host-level via `requestDomains` when policy allows.
- G5 collateral guard (deterministic, never model opinion): refuse widening for
  first-party families and shared-infra-looking hosts (cloudflare/fastly/
  akamai/cloudfront/gstatic/googleapis/jsdelivr/unpkg/cdnjs/amazonaws/azureedge/
  cloudinary/jquery/bootstrapcdn substring heuristic); refusals are recorded on
  the durable record (`widthRefusalReason`) and the narrow rule is kept.
- New promotions are site-scoped (`initiatorDomains` = learning site). A
  sighting of the same family from a second distinct site is multi-site
  evidence that globalizes the rule atomically (single remove+add, same id).
- Session-stage recurrence matches at host granularity (the family is the host)
  while the experiment rule itself stays narrow — this is what lets randomized
  paths promote one family.
- G3 same-run consequential blocking falls out of immediate promotion: once
  installed, the durable rule blocks later same-session requests pre-request.

## vii. Phase B verification (HOST_GENERALIZATION_PROOF)

15/15 checks pass: randomized-path family promoted to a host-wide
`requestDomains` rule with no `urlFilter`; site-scoped to the learning site;
a brand-new random path injected into the SAME page session blocked
pre-request (G3); randomized revisit blocked with zero new AI calls and the
blocked attempts never reached the fixture server; after a full browser
restart the same holds; the same host on a different site initially loads
(first attempt `loaded`), the cross-site sighting globalizes the rule, and the
second site is then protected; the shared-infra host promotes NARROW ONLY
(`widthRefusalReason=shared-infra`) and a different path on that host keeps
loading; first-party and never-learned sibling controls load throughout;
exactly two durable learned rules exist at the end (no rule explosion).

## viii. Phase C design — proactive learned behavior + navigation-epoch discovery

- Known-family short-circuit in `maybeRunSurvivorAi`: when every observable
  third-party candidate family is already covered by a durable personal rule
  for that site, the planner is skipped entirely (counter
  `learnedFamilyAiAvoided`, skip reason `AI_SKIP_KNOWN_FAMILY_COVERED`).
- The discovery latch is now navigation-epoch scoped
  (`originHash:navigationEpoch:documentId`): a fresh navigation may re-audit,
  so genuinely new families are discovered on repeat visits, while the
  short-circuit makes covered revisits free. Budget stays ≤ 2 per navigation.
- T8 breakage guard: six blocked retries of one durable-learned family within
  one tab over 45s (a page fighting the block = deterministic health
  regression) automatically revoke the rule; evidence is preserved as a
  REVOKED record with `revokedReason=retry-storm-health-regression` plus
  `rollbackOnRegression` / `rulesRevoked` counters.

## ix. Phase C verification (EVERYDAY_LEARNING_CURVE / NAVIGATION_AUDIT_PROOF / BREAKAGE_ROLLBACK_PROOF)

11/11 checks pass. Learning curve measured: visit1 = 1 AI call (discovery),
visit2 = 0 (covered, same worker), visit3 = 0 (covered, after FULL browser
restart), visit4 = 1 (new uncovered family, bounded). Navigation scoping proof
under an always-abstain relay: two navigations of the same origin produced
exactly one bounded audit each (2 total). T8: storm sequence
`[blocked ×6, loaded]` — the 6th blocked retry revoked the durable rule,
Chrome's dynamic ruleset dropped it, and the page healed on the next attempt.

## x. Forensic metrics (from the proof artifacts)

- `dynamicRulesPromoted`: 1–2 per scenario run; `rulesGlobalized`: 1 (Phase B
  second-site evidence); `learnedFamilyAiAvoided`: ≥ 1 per covered navigation
  (visit2 and the post-restart visit3); `rollbackOnRegression`: 1 and
  `rulesRevoked`: 1 (T8); `crossSiteFamilyRecurrence`: ≥ 1 (globalization
  trigger); reconcile counters `sessionRestoredAfterWorkerRestart` /
  `dynamicRulesRestoredAfterBrowserRestart` ≥ 1 on every restart test;
  orphan removals: 0 in all keep-scenarios.
- All forensic events carry salted truncated hashes only; raw hosts/paths exist
  solely in local ownership storage, never in exported artifacts.

## xi. Performance measurements

- Request hot path: learned-match lookup is an in-memory Map index — zero
  storage reads per request (by construction; verified by the harnesses running
  full browsing sessions with hundreds of requests).
- Ownership metadata writes are debounced (400 ms) and only flush eagerly on
  lifecycle transitions; measured flush counts stayed in single digits per
  navigation in all scenarios.
- Promotion latency (recurrence → dynamic rule verified present): completed
  within the harness polling window on every run (observed ≈ 1–3 s including
  the atomic Chrome update + verification read).
- AI call budget: never exceeded 1 call per navigation in any scenario
  (limit is 2); covered navigations cost 0.
- Full unit suite: 184/184 passing in ~9 s; each browser harness completes in
  ≈ 2–4 minutes end to end including real browser restarts.

## xii. Quota and capacity safety

- Learned rules use the DYNAMIC_SAFE band (30,000 quota); session band stays
  within the 5,000 session quota. `enforceCapacity` evicts DEMOTED-first, then
  stalest zero-match rules, keeping 200 ids of headroom; `sweepDecay` demotes
  rules unmatched for 30 days. Rule counts in every proof: 1–2 learned rules —
  orders of magnitude under quota.

## xiii. Privacy posture

- STRICT mode preserved end to end: the remote planner receives opaque refs and
  redacted domains only; the harness relays assert the Bearer contract and never
  see raw page URLs beyond what the production planner already sends.
- Ownership stores raw hosts/paths locally (required for DNR reconstruction)
  and is never exported; forensic artifacts contain salted hashes and first
  DNS labels of fixture hosts only.
- Both mock tokens and the real credential were machine-checked absent from
  every artifact file.

## xiv. Collateral-damage controls

- Survivor gates exclude auth/payment/media/download contexts upstream.
- Widening refuses first-party and shared-infra hosts (recorded refusal).
- Site scoping by default; globalization only on repeated multi-site evidence.
- T8 retry-storm auto-revocation heals pages that fight a learned block, with
  the evidence trail preserved for audit.
- Protected controls in every fixture (first-party script, never-learned
  sibling host, infra-host alternate path) loaded in 100% of runs.

## xv. User control and inspectability

- Options page "Personal learned rules" section shows the durable rule count
  and a one-click clear (removes every durable learned rule, wipes metadata,
  emits `PERSONAL_RULES_CLEARED`). Count and clear go through the pinned
  `adapt-learning-admin` runtime channel.

## xvi. Limitations and residual risks

- The shared-infra heuristic is a conservative substring list; it can
  over-refuse widening for innocuous hosts (they stay narrow — safe direction)
  and under-refuse for infra hosts outside the list (site scoping + T8 bound
  the blast radius).
- The T8 storm guard keys on tab + host; a hostile page could in theory force
  revocation of a learned rule by retrying — that direction only *removes*
  protection, which is the safe failure mode.
- Cross-device sync of learned rules is intentionally out of scope.
- The pre-existing `phase3-restart-invalidation` e2e failure exists at the
  base commit (proven via a clean worktree at HEAD) and is unrelated to this
  pass; it was left untouched per scope constraints.

## xvii. Verdict readiness and external retest protocol

Every mandated gate passed in order: Phase A (9/9) → Phase B (15/15) → Phase C
(11/11) → full regression (unit 184/184, AI wiring 6/6, all three harnesses
re-run green on the final build). The system now learns durable, host-level,
site-scoped-then-globalized personal protections from ordinary browsing and
spends zero AI on families it already knows.

Suggested user retest (unchanged from the agreed protocol): Run 1 fresh profile
(baseline learning pass), Run 2 same profile (known families pre-blocked, zero
AI), Run 3 after full browser restart (durability), plus a fresh-profile
control. Compare blocked/reachable against the 354/128 static ceiling from the
original diagnosis run.
