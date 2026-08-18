# CURRENT TOP HYPOTHESES — interim note (pre-instrumentation)

Date: 2026-08-16. Branch: feat/phase31b-page-plane @ 0f433a8 (dirty tree: static-rulesets fix, unrelated).

Ranked hypotheses for why the real installed extension shows zero cross-run improvement
while the internal survivor lab reports Run1→Run2 convergence. Each entry: supporting code
evidence / evidence still needed / cheapest discriminating runtime test.

---

## H1 (P0) — Production extension never has an AI planner configured

**Supporting code evidence (CODE FACTS):**
- The only writer of the `adapt_ai_config` storage key in the entire repository is the
  Node lab harness: `scripts/final-intelligence/run-survivor-lab.ts:266`
  (`chrome.storage.local.set({ adapt_ai_config: { endpoint: 'http://127.0.0.1:<relay>/plan' } })`).
- `loadConfiguredPlanner` (`src/background/ai/remote-planner.ts:56-60`) returns `undefined`
  when the key is absent.
- Both production planner gates no-op on `undefined`:
  - `src/background/causal/orchestrator.ts:703` — `if (!this.adaptivePlanner) return;`
  - `src/core/adaptation/engine.ts:130` — `... && this.adaptivePlanner && ...` short-circuits.
- No options page, popup control, `onInstalled` seeding, or build-time default writes the key
  (git grep for `adapt_ai_config`: 3 hits — lab script, key constant, storage-change listener).
- Manifest (`src/manifest.json`) has no `options_ui`; popup (`src/entrypoints/popup/`) has no
  AI configuration surface.

If true: chromeRuntimeAiCalls = 0 on the external test → no experiments → no learned
protections → Runs 1/2/3 identical. Directly explains the contradiction.

**Evidence still needed:** runtime proof from the installed extension that the planner is
absent and that the funnel otherwise produced candidates (i.e., the skip reason is
specifically `AI_PROVIDER_UNCONFIGURED`, not an empty funnel).

**Cheapest discriminating test:** dev-only instrumentation recording the exact
`maybeRunSurvivorAi` gate outcome + candidate counts at the moment of the gate, per run.

## H2 — Learned session DNR rules are wiped by ADAPT's own startup reconcile on any service-worker restart

**Supporting code evidence (CODE FACTS):**
- `DnrIdAllocator` allocations are memory-only; constructor seeding exists but production
  passes none (`src/core/dnr/controller.ts:31-33`); the `adapt_dnr_dynamic_v1` storage key is
  defined (`src/shared/constants.ts:41`) but never used.
- Startup reconcile (`src/entrypoints/background.ts:497-506` → `src/core/dnr/reconcile.ts:39-51`)
  removes every session rule with no current-worker allocation or whose owner is not an active
  `adaptEngine` transaction. Survivor-AI rules are owned by `survivor_ai_*` executor records,
  which are never `adaptEngine` transactions and are held only in the in-memory
  `PrimitiveExecutorRegistry.staged` map (not in the persisted `AutonomySessionSnapshot`).
- Chrome platform fact (developer.chrome.com declarativeNetRequest reference): session rules
  survive service-worker termination; only browser shutdown / extension update clears them.
  So Chrome would keep the rules — ADAPT deletes them itself on the next worker start.

If true: even with H1 fixed, a >30s idle gap between Run 1 and Run 2 (MV3 idle termination,
per Chrome service-worker lifecycle docs) erases learned protections before Run 2.

**Evidence still needed:** a runtime `SESSION_RULES_REMOVE {source:'startup-reconcile'}`
record, or C4-checkpoint absence of rules that C2 showed present.

**Cheapest discriminating test:** instrumented rule-lifecycle log + `getSessionRules()`
snapshots at run boundaries; note service-worker restarts between runs.

## H3 — Learned rule identity is too narrow for re-run variance

**Supporting code evidence (CODE FACTS):**
- Learned `urlFilter` = `|{protocol}//{host}/{first-two-path-segments}*`
  (`src/background/causal/orchestrator.ts:92` via `normalizeUrlForTelemetry`,
  `src/core/network/normalize-url.ts:16-18`). Exact host; path-prefix to 2 segments.
- The lab corpus reuses identical fixture tokens/URLs across Runs 1-3
  (`run-survivor-lab.ts:359-376` build fixtures once), so cross-run generalization was never
  exercised by the internal test.
- A re-run that randomizes subdomains or leading path segments produces zero matches.

**Evidence still needed:** runtime match data — did any learned rule match a Run-2/3 request,
and did the same coarse host/path families recur?

**Cheapest discriminating test:** `chrome.declarativeNetRequest.testMatchOutcome` probe
(unpacked-only, no extra permission) filtered to learned rule IDs + salted host/path family
recurrence counters.

## H4 — Perception/eligibility blind spot on the real tester

**Supporting code evidence (CODE FACTS):**
- Network candidates require `thirdParty === true`, a `request:` ref, and resourceType in
  {script, sub_frame, xmlhttprequest, fetch, beacon, image}
  (`orchestrator.ts:878-887`); other types (e.g. `ping`, `media`, `font`) are excluded.
- Survivors require visible DOM surfaces (`src/page/survivor-discovery.ts:14-16, 198-202`);
  a network-only benchmark surface yields none — covered only by the novel-network-audit path,
  which additionally requires >= 2 eligible candidate nodes and fires once per origin per
  worker lifetime (`auditedOrigins`, in-memory, `orchestrator.ts:244, 712-717`).
- The AI path is only entered from observation batches / request completes
  (`orchestrator.ts:622-623, 414-427`); the sensor does emit batches on DOMContentLoaded and
  mutation activity (`src/page/sensor.ts:121-150`), so batch arrival is expected to work.

**Evidence still needed:** real funnel counters — observed/completed/third-party/eligible/
excluded-by-reason — on the actual tester.

**Cheapest discriminating test:** the same instrumentation; if eligible >= 2 and skips say
`AI_PROVIDER_UNCONFIGURED`, H4 is refuted and H1 confirmed.

## H5 — Opaque request-ref registry lost to service-worker restart mid-flight

**Supporting code evidence (CODE FACTS):**
- `CausalResourceRegistry.requests` is an in-memory `Map` only
  (`orchestrator.ts:80-106`); executor resolution fails with `UNRESOLVED_REQUEST`
  (`executor-registry.ts:253`) if the worker restarted between observation and staging.
- Median lab AI latency ~2.6s makes the window small; continuous webRequest/message activity
  also resets the 30s idle timer, lowering probability during an active test.

**Evidence still needed:** any `EXECUTOR_STAGE {gapCode:'UNRESOLVED_REQUEST'}` records.

**Cheapest discriminating test:** same instrumentation; also `SW_START` events timestamped
against AI call windows.

---

### Notes on scope
- H1 alone fully explains the reported contradiction. H2/H3 are real defects that would cap
  improvement even after H1 is fixed; H4/H5 are lower-probability. Instrumentation below is
  designed to discriminate all five in one 3-run protocol.
- No product behavior is modified by the instrumentation: pure reads, counters, salted hashes,
  and bounded `chrome.storage.session` persistence. The per-request match probe activates only
  when learned rules exist.
