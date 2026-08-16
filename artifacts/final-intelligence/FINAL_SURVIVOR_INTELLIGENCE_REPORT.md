BEFORE

- External benchmark: 24 / 37
- Ad Networks: 7 / 17
- AI calls helping: 0

AFTER INTERNAL PASS

- Live provider: **true**; mock planner: **false**; model class: `buzz-gpt-5-4-mini`
- Real AI calls: **5** in Run 1
- Novel-network discovery calls: **1**
- Ambiguous-survivor calls: **4**
- Causal top-1 AI: **NOT MEASURED**
- Causal top-1 deterministic: **NOT MEASURED**
- First experiment success AI: **5 / 5** in Run 1
- First experiment success deterministic: **NOT MEASURED**
- Run-1 survivor count: **3**
- Run-2 repeat survivor count: **0**
- Run-2 improvement: **100% of Run-1 survivors**
- Run-3 repeat survivor count: **0**
- Run-3 improvement: **100% of Run-1 survivors**
- Protected flows: **4 per run**
- Protected-flow false positives: **0**
- Learned session protections: **5** in Run 1; **0** persistent promotions
- Rollbacks: **0** in Run 1 and fresh-profile control
- AI latency: **2,619 ms median**, **4,822 ms p95** in Run 1
- AI timeout/schema failures: **0 observed**
- Privacy comparison: **STRICT live lab observed; DOMAIN_HINTS A/B not run**

STATIC RULESET STATE

- Packaged Phase 3.1 rules: **178,254** across 13 enabled rulesets on fresh load
- Fresh load after reconciliation: **178,254** enabled rules
- Same-profile Chromium relaunch: **30,000** enabled rules
- Available static count after reload reported **448,260**, yet every optional re-enable attempt failed with `The set of enabled rulesets exceeds the rule count limit.`
- Exact defect: programmatically enabled optional static rulesets do not restore after extension reload in this Chromium harness. The runtime reports capacity but rejects optional re-enablement. Manifest-time enablement of all shards passes the focused probe, but that temporary variant is not the product build.

ARCHITECTURE

- Successful request completion now produces bounded survivor causal candidates instead of requiring a request error.
- The AI receives supplied opaque request/element candidates and supplied safe experiment IDs only.
- Policy validation remains authoritative; executor code resolves trusted local request references into session DNR experiments.
- Run 1 installed session protections and Run 2/Run 3 converged without user answers.
- Trace output excludes raw URLs, page HTML, headers, cookies, request bodies, and secrets.

REGRESSIONS

- Typecheck: **PASS**
- Unit suite: **181 / 181 PASS**
- Page unit suite: **10 / 10 PASS**
- Popup broker and survivor intelligence unit coverage: **PASS**
- Bundle/security tests: **5 / 5 PASS**
- Phase 3.1B deterministic adversarial corpus: **34 / 34 PASS** before the final full E2E stage
- Phase 3.1B integrity: **PASS** after canonical local evidence recovery
- Recipe lifecycle Chromium test: **PASS**
- Worker restart/stale-detector invalidation: **FAIL**; expected `RECIPE_SAFE` state was absent
- Full Chromium E2E / autonomy wrappers: **BLOCKED/HUNG** during full-ruleset startup on the same static-loader path

EXTERNAL / BLIND TESTS

- External 37-test manual retest: **PENDING USER**
- Reserved streaming blind holdout: **UNTOUCHED**
- No benchmark hostname, test name, selector, expected cause, or holdout data was added.

WORKTREE / PR

- Branch: `feat/phase31b-page-plane`
- Working tree: **DIRTY with pre-existing and current uncommitted work; no reset or clean performed**
- PR #2: **DRAFT and UNMERGED**
- Exact changed paths are listed below; generated evidence remains in the local working tree.

Exact changed paths

```text
scripts/build.ts
scripts/final-intelligence/run-survivor-lab.ts
scripts/final-intelligence/verify-ruleset-reload.ts
scripts/final-pass/blocking-attribution.ts
scripts/final-pass/verify-product.ts
src/background/ai/remote-planner.ts
src/background/autonomy/executor-registry.ts
src/background/autonomy/hypothesis-lattice.ts
src/background/autonomy/saei.ts
src/background/causal/event-normalizer.ts
src/background/causal/orchestrator.ts
src/background/phase31/static-rulesets.ts
src/core/adaptation/engine.ts
src/core/dnr/controller.ts
src/core/navigation/registry.ts
src/core/network/observer.ts
src/core/network/request-graph.ts
src/entrypoints/background.ts
src/entrypoints/early-popup-broker.ts
src/manifest.json
src/page/filtering/early-runtime.js
src/page/opaque-targets.ts
src/page/popup-broker-policy.ts
src/page/sensor.ts
src/page/survivor-discovery.ts
src/shared/ai/schemas.ts
src/shared/ai/types.ts
src/shared/ai/validator.ts
src/shared/causal/events.ts
src/shared/resource-identity.ts
src/shared/types.ts
tests/unit/navigation-registry.test.ts
tests/unit/popup-broker-policy.test.ts
tests/unit/survivor-intelligence.test.ts
```

FINAL VERDICT

**SURVIVOR INTELLIGENCE FAIL — STOP DEVELOPMENT**

The survivor loop and same-profile self-improvement are real, but the mandatory static ruleset reload proof fails and the required deterministic/domain-hints A/B comparison is incomplete. Do not claim readiness for the external blind retest until those blockers are fixed and rerun.
