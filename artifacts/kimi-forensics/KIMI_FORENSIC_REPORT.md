# ADAPT External Adaptive Loop Forensic Report

Date: 2026-08-16. Branch: `feat/phase31b-page-plane` @ `0f433a8` (plus dev-only forensic
instrumentation; no product behavior change). Companion files:
`CURRENT_TOP_HYPOTHESES.md`, `RUN_PROTOCOL.md`, `SANITY_CHECK.json`.

**Status: static reconstruction complete and verified by a controlled harness; the
external-test runtime trace is pending the user protocol in `RUN_PROTOCOL.md`.**

## 1. Executive finding

The first broken arrow is **NOTICE → AI**: in the installed extension the AI plane is
inert because no AI planner is ever configured. The only code in the entire repository
that writes the `adapt_ai_config` storage key is the Node lab harness
(`scripts/final-intelligence/run-survivor-lab.ts:266`); the shipped extension contains
no options UI, no popup control, no install-time default, and no other writer. With the
key absent, `loadConfiguredPlanner` returns `undefined` and both production planner
gates silently no-op (`orchestrator.ts` `if (!this.adaptivePlanner) return;`,
`engine.ts` `... && this.adaptivePlanner && ...`). Zero AI calls → zero experiments →
zero learned protections → Runs 1/2/3 identical. Two further downstream defects are
code-confirmed and would cap improvement even after the planner is wired: ADAPT's own
startup reconcile deletes all learned session rules after any service-worker restart,
and the learned rule identity (exact host + first two path segments) cannot match
re-runs that randomize either.

## 2. Root-cause confidence

**HIGH CONFIDENCE** for NOTICE → AI (code-confirmed; awaits the one-bit runtime
confirmation `aiConfigured=false` / `aiSkip.AI_PROVIDER_UNCONFIGURED` from the real
trace — the user's profile could theoretically contain a manually written config, but
no product surface creates one and none was reported).

**CONFIRMED (code)** for the reconcile wipe and the rule-width defects; their runtime
firing is pending trace.

## 3. Real production pipeline

Static reconstruction, verified where marked "(sanity)" by `SANITY_CHECK.json` inside
the real service worker. External Run 1/2/3 columns await the user trace.

| Stage | Run 1 | Run 2 | Run 3 | Evidence |
|---|---|---|---|---|
| requests observed | works (sanity: 4) | — | — | webRequest → `orchestrator.onRequest` instrumented; sanity artifact counters |
| candidate eligible | works (sanity: 2) | — | — | `candidateEligibleRequests` counter; eligibility = third-party + ref + type in {script, sub_frame, xhr, fetch, beacon, image}, top 8 |
| survivors | works when visible DOM surfaces exist | — | — | `src/page/survivor-discovery.ts`; network-only pages take the novel-network path instead |
| network audits | gated | — | — | requires ≥2 eligible candidates, once per origin per worker lifetime (`auditedOrigins`, in-memory) |
| AI calls | **0 — planner undefined** | — | — | `orchestrator.ts:703` gate; only lab writes `adapt_ai_config` |
| AI successes | n/a | — | — | — |
| experiments | 0 | — | — | — |
| policy approvals | 0 | — | — | — |
| DNR session installs | 0 | — | — | — |
| DNR rules retained | n/a — nothing learned | — | — | startup reconcile removes learned rules on worker restart (code-confirmed) |
| learned-rule later matches | 0 | — | — | `testMatchOutcome` probe armed when rules exist |
| rollbacks | 0 | — | — | — |
| recipe/protection replay | recipes replay DOM actions only; `persistLearnedRules` is never called anywhere | — | — | `background.ts:413-428`; git grep: zero call sites |

## 4. Browser-runtime AI proof

From the controlled sanity run (`SANITY_CHECK.json`), which drives the **real built
extension service worker** through generic self-hosted fixtures:

- node lab calls: N/A in this audit (the survivor lab itself drives the real worker
  via storage config; it is not a separate Node-side planner path).
- Chrome service-worker calls: **proven possible and functional** —
  `AI_RUNTIME_CALL_BEGIN {runtime:"chrome-extension-service-worker",
  plannerClass:"remote", endpointClass:"loopback", triggerReason:"NOVEL_NETWORK_DISCOVERY",
  candidateCount:2}` → `AI_RUNTIME_CALL_END {ok:true, latencyMs:16}` → policy valid →
  `EXECUTOR_STAGE ok:true TARGETED_SESSION_DNR` → session rule `3000000` confirmed
  present via `chrome.declarativeNetRequest.getSessionRules()` →
  `learnedSessionProtections: 1`.
- planner class / mock: `remote` / `false` (fields added to planners for exactly this).
- provider configured: in sanity, via the same `adapt_ai_config` mechanism the lab
  uses; **in the user's external-test profile: pending trace — expected `false`**.
- trigger reasons: `NOVEL_NETWORK_DISCOVERY` (no survivors + ≥2 eligible third-party
  completes, unaudited origin) and `SURVIVOR_ATTRIBUTION` (survivor + ≥1 candidate).

## 5. Candidate funnel

Instrumented counters (per external run, pending): `totalRequestsObserved`,
`successfulRequests`, `failedRequests` (+ `REQ_ERROR` Chrome error class),
`firstPartyRequests`, `thirdPartyRequests`, `candidateEligibleRequests`,
`candidateExcludedRequests` with reasons `EXCLUDE_FIRST_PARTY`, `EXCLUDE_NO_REF`,
`EXCLUDE_RESOURCE_TYPE`, `EXCLUDE_TOP_K`, `EXCLUDE_PROTECTED_CONTEXT`; per-request
bounded `REQ_COMPLETE` records carry salted host / host+path hashes only.

Sanity-run funnel (generic fixture): 4 observed → 2 third-party → 2 eligible →
network audit → AI call. The funnel machinery works in the real worker.

## 6. Learned-rule lifecycle

Code-established lifecycle of a survivor-AI network protection:

- **installed**: `PrimitiveExecutorRegistry.stage` → `DnrController.addSessionExperimentRules`
  with `tabId = undefined` → **session-scoped, not tab-scoped** (tab scope is not the
  defect). `urlFilter = |{protocol}//{host}/{first-2-path-segments}*`.
- **committed**: never — `finishSurvivorAi` does not call `executors.commit()`; the
  executor record stays staged in memory.
- **retained**: Chrome keeps session rules across worker termination (verified against
  current Chrome docs), **but ADAPT removes them itself**: on every worker start,
  `dnrController.reconcile()` (`background.ts:497+` → `reconcile.ts:39-51`) deletes
  every session rule lacking a current-worker allocation whose owner is an active
  `adaptEngine` transaction. The `DnrIdAllocator` is never persisted (constructor
  seeding unused; `adapt_dnr_dynamic_v1` key defined but never written), and
  `survivor_ai_*` owners are not `adaptEngine` transactions. **First worker restart ⇒
  all learned protections deleted.**
- **removed**: instrumented call sites — `startup-reconcile`, `executor-rollback`,
  `engine-staging-failure`, `adaptation-rollback`, `tab-close-cleanup`.
- **later matched**: measured live via `testMatchOutcome` probe (unpacked-only; no
  manifest change; raw URLs never leave the browser).

## 7. Cross-run identity analysis

Pending trace. Instrumentation records salted `hostFamilies` (registrable-domain |
resource-type) and `hostPathFamilies` (host | coarse path | resource-type) for every
third-party completion, plus `LEARNED_RULE_MATCH` events. This will distinguish
"nothing similar recurred" from "same family recurred but the exact-host/2-segment
rule was too narrow". Note the lab corpus reuses identical fixture URLs across runs
(`run-survivor-lab.ts:359-376` builds fixtures once), so the internal test never
exercised generalization at all.

## 8. Service-worker lifecycle

Chrome facts (developer.chrome.com, verified 2026-08-16): worker terminates after ~30s
idle; all module-global state is lost; `chrome.storage.session` survives worker
restarts within the browser session; session DNR rules survive worker termination.

| state | current storage | must survive restart? | survives? | consequence if lost |
|---|---|---|---|---|
| `CausalResourceRegistry.requests` (request:rN → target) | memory Map | yes | **no** | AI-selected ref unresolvable → `UNRESOLVED_REQUEST` |
| `PrimitiveExecutorRegistry.staged` (txId → ruleIds) | memory Map | yes | **no** | orphan rules; reconcile deletes them |
| `pendingSurvivorAi` | memory Map | yes | **no** | outcome verify never completes |
| `survivorAiCalls` budget, `auditedOrigins` | memory | no | no | budget/audit reset (benign) |
| event graphs / nav epochs / beliefs | `storage.session` (throttled persist) | yes | yes | — |
| `DnrIdAllocator` allocations | memory | **yes (reconcile ownership)** | **no** | **reconcile wipes all session rules at startup** |
| `adaptEngine.activeTransactions` | `storage.local` (staged/observing only) | yes | yes | — |
| autonomy loops/pending | `storage.session` | yes | yes | — |

The last-row-but-one is the service-worker-lifecycle break: Chrome preserves the rules;
ADAPT's own reconcile removes them because their ownership metadata never persisted.

## 9. Lab-vs-production discrepancy

| Stage | Lab (`run-survivor-lab.ts`) | Production external test |
|---|---|---|
| planner construction | **same production path** — config written to `chrome.storage.local` (line 266), worker loads `RemotePlanner` | **never configured** — no writer exists in product code |
| provider transport | loopback relay → Azure (`<your-model-deployment>`), 5s timeout | n/a |
| trigger | same `maybeRunSurvivorAi` gates | gates reachable, but starved at planner gate |
| fixtures | 16 generic self-hosted families; **identical URLs across Runs 1-3**; survivors use ADAPT's own detection vocabulary (`data-ad-slot`, promo classes) | arbitrary; URLs/families may randomize per run |
| outcome metric | `sessionProtectionInstalled` = rule staged + health not regressed | tester counters unknown — deliberately uninspected |
| service worker | never idles long enough to terminate between runs | 30s idle kill possible between user runs |
| DNR persistence | rules survive (same session, no restart) | rules wiped by startup reconcile on restart |

Classification: the lab's planner wiring difference is **production-breaking**; the
static-URL corpus and no-restart profile are **test-only** conditions that hid H2/H3;
the evaluator-truth separation itself is clean (page-side counts are evaluator-side;
runtime sees opaque observations only).

## 10. Outcome-verifier assessment

The lab's "AI first experiment success = 5/5" means: `updateSessionRules` staged and
the post-experiment health vector did not regress. For `TARGETED_SESSION_DNR`,
`trace.survivorResolved` is forced `true` whenever the page stayed healthy
(`orchestrator.ts` `finishSurvivorAi`: `safe && (… || primitiveId ===
'TARGETED_SESSION_DNR')`). It does **not** verify that the target request was
subsequently blocked, that the survivor disappeared, or that the harmful behavior
failed to recur. This is definition A/B in task section AD — install success, not
causal resolution.

## 11. The broken arrow

**NOTICE → AI is broken** (code-confirmed; one-bit runtime confirmation pending):
the production extension ships no way to configure the planner, so the AI gate's first
check (`!this.adaptivePlanner`) returns on every candidate in every run.

Downstream, two more breaks are code-confirmed and would surface immediately after a
planner fix: **LEARN → NEXT-RUN MATCH is broken** on any service-worker restart
(ADAPT's startup reconcile deletes learned session rules), and **MATCH is fragile**
because learned identity is exact-host + 2-segment path while re-runs may vary either.
Whether these fire in the real environment is precisely what the trace measures.

## 12. Minimal surgical fixes

**Not implemented** (diagnosis first). Maximum three:

1. **Wire a real planner-configuration surface into the product.** Root cause: planner
   undefined in production. Smallest change: an explicit, documented configuration
   path (e.g., an options control or deployment-seeded `adapt_ai_config`) using the
   existing `RemotePlanner`/`loadConfiguredPlanner` unchanged. Files:
   `src/background/ai/remote-planner.ts` (unchanged mechanics), new UI/seed point.
   Risk: bearer-token-in-`storage.local` is acceptable for a private deployment but is
   not a shippable multi-user credential strategy — flag for product decision.
   Verify externally: trace shows `AI_CONFIG configured:true`, `aiCallsStarted > 0` in
   Run 1.
2. **Persist rule ownership so learned protections survive worker restarts.** Root
   cause: allocator/ownership never persisted + reconcile assumes absence ⇒ orphan.
   Smallest change: persist `DnrIdAllocator` allocations (the unused
   `adapt_dnr_dynamic_v1` key exists for exactly this) and treat restorable learned
   owners as known-active in `reconcile`; or promote successful survivor DNR rules to
   dynamic rules via the existing (currently uncalled) `persistLearnedRules`. Files:
   `src/core/dnr/controller.ts`, `src/core/dnr/reconcile.ts`,
   `src/entrypoints/background.ts` startup. Verify externally: with the 60s idle gap,
   `RECONCILE_RESULT.orphanedSessionRemoved = 0` for learned rules and the pre-Run-3
   snapshot still shows them.
3. **Learn a stable request family, not an exact URL prefix.** Root cause:
   `urlFilter = |host/seg1/seg2*` defeated by randomized host/path. Smallest change:
   when committing a verified survivor protection, widen to registrable-domain +
   resource-type (optionally first path segment), keeping the experiment-stage rule
   narrow. Files: `src/background/causal/orchestrator.ts`
   (`CausalResourceRegistry.observe`) / commit path. Risk: over-blocking sibling
   properties on shared CDNs — mitigate by keeping `initiatorDomains` scoping to the
   learning origin. Verify externally: `LEARNED_RULE_MATCH` events in Runs 2/3 against
   recurring `hostFamilies` hashes.

## 13. What NOT to change

Evidence shows these work; do not rewrite them:

- Static ruleset plane: 178,254 rules packaged and reconciled (the uncommitted
  aggregate-enable fix in `static-rulesets.ts` is correct).
- The observation pipeline (webRequest → normalizer → graph) and the content-script
  sensor batching — funnel counters moved correctly inside the real worker.
- The survivor-AI executor path end-to-end (policy → stage → session rule present in
  Chrome → health-safe outcome) — proven live in the sanity run.
- The policy validator's opaque-ref discipline, and the bounded-AI authority model.
- The early popup plane (out of scope here; no contradicting evidence).
- The lab harness architecture itself (it drives the real worker; it is not a fake
  planner path — its blind spots were static URLs and no worker restarts).

## 14. Blind-test integrity

Confirmed: no external failed-test names inspected; no benchmark domains, selectors,
or source used anywhere (the sanity fixtures are self-hosted `*.test` loopback pages);
the streaming holdout was not sought or touched; no site-specific production change
was made; instrumentation persists only opaque refs, salted hashes (salt stored under
a separate, non-exported key), reason codes, and counts.

## 15. Final verdict

**ROOT CAUSE NOT PROVEN — DO NOT MODIFY PRODUCT YET.**

The code evidence deterministically isolates NOTICE → AI and two downstream breaks;
the sanity harness proves the instrumented loop works inside the real worker. What
remains is the real external-test trace (`RUN_PROTOCOL.md`) to confirm
`aiConfigured=false` / `aiSkip.AI_PROVIDER_UNCONFIGURED` in the user's profile and to
measure arrows 6-14 under real conditions. That artifact converts this report's
HIGH-CONFIDENCE code diagnosis into CONFIRMED runtime diagnosis and authorizes exactly
the three surgical fixes above — nothing else.
