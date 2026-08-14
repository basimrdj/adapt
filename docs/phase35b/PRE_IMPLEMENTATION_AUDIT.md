# ADAPT Phase 3.5B Pre-Implementation Audit

## Audit scope

- Repository: `basimrdj/adapt`
- Branch: `feat/phase31b-page-plane`
- Base: `main` at `609c5d88c8f18917afd474b4ea6f2736505cf66e`
- Audited head: `d2bdf36356d44e38fe185a0f8487f23ac9c90fe0`
- Pull request: `#2`, open, draft, and unmerged
- Working-tree state before implementation: the prior report metadata edit was
  unstaged; `.commandcode/` and `artifacts/phase31b/release-validation.md`
  were pre-existing untracked leftovers and are not part of this phase.
- Remote verification: local `HEAD` matched
  `origin/feat/phase31b-page-plane`; the PR was 14 commits ahead of `main`,
  with no commits behind.

The previously discussed real-world streaming holdout was not inspected,
searched, or added to implementation data during this audit.

## Independent re-audit at implementation handoff

The live implementation was re-audited from the working tree after the
initial changes rather than accepting the earlier report as proof. The
following conclusions are the current architectural truth:

| Claim | Current verdict | Evidence / consequence |
|---|---|---|
| A. Every descriptive capability is executable | **Disproved** | `PrimitiveExecutorRegistry` separates trusted executors from the browser-tested matrix. The matrix contains explicit `CAPABILITY_GAP` rows for 14 of 16 primitives. |
| B. Every live primitive has rollback | **Partially proved** | Session-DNR rules are removed; DOM actions snapshot and restore styles; closed navigation targets have a reopen path. Scriptlets, quarantine, and untested browser paths remain gaps. |
| C. Every SAEI experiment reaches a browser executor | **Proved for selected executable primitives** | `CausalOrchestrator.stageAutonomousExperiment()` calls `PrimitiveExecutorRegistry.stage()`. Unavailable executors are recorded as capability gaps instead of succeeding synthetically. |
| D. Real browser outcomes feed `recordOutcome()` | **Proved** | `HEALTH_SNAPSHOT` enters `onHealthSnapshot()`, is evaluated by `verifyHealthOutcome()`, and the result is passed to `finishAutonomous()` and `recordOutcome()`. |
| E. Success enters the real recipe store | **Partially proved** | Successful autonomous DOM actions use `CausalRecipeStore` / `PromotionGate`; promotion remains lifecycle-gated. The live corpus did not produce an eligible draft on the final run. |
| F. Second-visit replay uses the real recipe | **Implemented, not accepted** | `maybeReplay()` loads stored causal recipes and applies remapped DOM actions. The final live corpus recorded no replay success, so this is not a verified gate. |
| G. Worker restart restores exploration | **Browser-tested** | The restart probe persisted autonomy state, terminated the extension worker through CDP, and observed recovery at 100% in the deterministic one-trial probe. |
| H. Capability gaps are genuine | **Proved** | Gaps carry concrete codes such as `UNSUPPORTED_SCRIPTLET`, `NO_EXECUTOR`, and `UNRESOLVED_OPAQUE_TARGET`; they are persisted in the autonomy session. |
| I. `aiCalls` measures real planner calls | **Partially proved** | The counter is persisted and reported, but no safe production Phase 2 planner is wired into SAEI; final live usage is therefore genuinely zero. |
| J. CI tests Phase 3.5 | **Implemented, not green** | Explicit `autonomy-fast` and `autonomy-live` jobs now run the requested commands. Existing Phase 3.1B Chromium regressions still prevent a green acceptance run. |

The current conclusion is **PHASE 3.5B NOT VERIFIED**. The real browser
holdout showed 100% anomaly detection and 50% autonomous resolution on the
final recorded run, with zero false positives and 100% worker restart
recovery, but popup closure, recipe replay, full primitive coverage, and the
hard verification thresholds remain open.

## Architecture traced

### Phase 1 adaptation engine

`src/core/adaptation/engine.ts` is a real transactional executor for the
existing Phase 1 action language. It stages tab-scoped DNR session rules through
`DnrController`, sends allowlisted DOM actions to the content script, persists
active transactions, requests health, and rolls back failed transactions through
`AdaptationRollbackHandler`. Its action space is the older `StrategyAction`
union, not the Phase 3.5 primitive registry.

The background entrypoint constructs this engine with
`chromeStorageBackend`, so active Phase 1 transactions are persisted in
`chrome.storage.local`, while the causal session uses `chrome.storage.session`.
That split is relevant to worker-restart reconciliation.

### Phase 2 planner/oracle

`src/shared/ai/planner-interface.ts`, `src/shared/ai/evidence-builder.ts`, and
`src/shared/ai/validator.ts` provide a bounded planner contract. The older
`AdaptationTransactionEngine` can optionally call an `AdaptivePlanner` after
deterministic candidate generation fails, then passes the result through the
existing policy validator.

The production background entrypoint passes no planner to
`AdaptationTransactionEngine`. `MockPlanner` is test/support code. No live
planner is connected to SAEI, and no production counter is incremented for
planner calls.

### Phase 3 causal engine

The causal path is wired in `src/entrypoints/background.ts`:

1. `CausalSessionStateRepository` restores navigation epochs, event graphs, and
   belief state from `chrome.storage.session`.
2. `CausalOrchestrator` normalizes navigation, request, intent, page, and
   health observations into the event graph.
3. `ExperimentGenerator` and `ExperimentSelector` create and hard-filter the
   established Phase 3 candidate language.
4. `CausalEngine.runCausalExperiment()` validates epoch freshness, resolves a
   candidate through `experimentToStrategy()`, stages a real Phase 1
   transaction, and persists the causal experiment state.
5. A real content-script health snapshot reaches
   `CausalEngine.verifyCausalExperiment()`, which computes health outcome and
   commits or rolls back through the transaction engine.
6. The orchestrator applies the result to beliefs and may select another
   bounded Phase 3 candidate after rollback.

This path is real for the existing Phase 3 `StrategyAction` subset.

### Phase 3 recipes and replay

`CausalRecipeStore` and `PromotionGate` in
`src/background/causal/promotion-gate.ts` implement the causal recipe
lifecycle and persistence in `chrome.storage.local`. Promotion requires
verified committed experiments, statistical support, privacy, fingerprint,
rollback, and at least two stable replay visits.

`CausalOrchestrator.maybeReplay()` performs a real content-script replay and
health check for stored causal recipes. However, the operational replay path
currently remaps and sends DOM actions only. Network and navigation primitives
are not represented as a general replay executor.

### Phase 3.1B page plane

`src/page/filtering/*`, `scripts/build-page-filtering.ts`, and the existing
Phase 3.1B workflow remain separate from the Phase 3.5 live loop. The current
stealth and detector-bait gates are preserved constraints for this phase. No
production page marker or hostname-specific data was introduced by this audit.

### Phase 3.5 autonomy layer

The autonomy files are:

- `src/background/autonomy/hypothesis-lattice.ts`
- `src/background/autonomy/intent-tracker.ts`
- `src/background/autonomy/popup-classifier.ts`
- `src/background/autonomy/primitive-registry.ts`
- `src/background/autonomy/saei.ts`
- `src/background/autonomy/session.ts`

`CausalOrchestrator` creates an in-memory `AutonomousExperimentLoop` when the
legacy Phase 3 candidate generator has no candidate. It asks SAEI for one
primitive, maps a small subset of primitives to the old Phase 3 variable/action
language, stages that old causal transaction, and later calls
`recordOutcome()` after the real health snapshot.

That integration is a compatibility bridge, not a complete live primitive
execution system.

## Assumption matrix

| Claim | Verdict | Evidence and consequence |
|---|---|---|
| A. Every `PrimitiveRegistry` capability executes in real Chromium | **DISPROVED** | The registry is descriptive only. `primitiveVariable()` maps only eight IDs, `experimentToStrategy()` supports five old intervention variables, and there is no `PrimitiveExecutorRegistry`. The remaining IDs return `null` before staging. |
| B. Every live primitive has an actual rollback | **DISPROVED** | The existing rollback handler covers staged Phase 1 DNR/DOM action IDs. There is no audited rollback executor for tab quarantine/close, redirect suppression, popup suppression, scriptlet activation/deactivation, player recovery, or the other new primitive IDs. |
| C. Every SAEI experiment reaches a browser executor | **DISPROVED** | `CausalOrchestrator.autonomousSelection()` returns `null` when a primitive has no old variable or strategy reference. SAEI still believes the primitive is proposal-capable, but no transaction or capability-gap record is created. |
| D. Real browser outcomes feed `recordOutcome()` | **PARTIAL / DISPROVED AS A GENERAL CLAIM** | Mapped experiments receive a real `HEALTH_SNAPSHOT` and are passed a committed-versus-rolled-back result. Unmapped, infeasible, stale, or failed executor cases never reach SAEI outcome accounting. The outcome also loses primitive-level executor and rollback details. |
| E. Autonomous success enters the real `CausalRecipeStore` and `PromotionGate` | **DISPROVED** | SAEI constructs an in-memory `AutonomousRecipe` directly after one successful `recordOutcome()`. It does not call the real promotion lifecycle. The orchestrator's later `maybeDraftOrPromote()` operates on legacy `StrategyAction` records, not the autonomous primitive sequence. |
| F. Second-visit replay uses the real stored autonomous recipe | **PARTIAL / DISPROVED AS A GENERAL CLAIM** | Real Phase 3 causal recipes can replay through `CausalRecipeStore`, but SAEI recipes are not stored there. The replay path is currently DOM-action oriented and does not replay the full autonomous primitive language. |
| G. Worker restart restores live SAEI exploration | **DISPROVED** | `AutonomySessionRepository` is only a standalone class with a unit test. The background entrypoint never constructs it, never persists `autonomyLoops`, `pendingAutonomy`, budgets, or transaction mappings, and never restores them on service-worker startup. |
| H. Capability gaps are genuinely recorded | **DISPROVED** | `capabilityGaps` exists in `AutonomyLoopState`, but the live orchestrator does not append gaps for missing executor, unresolved opaque reference, unsafe rollback, forbidden context, or budget/policy abstention. The synthetic evaluator therefore reports zero gaps by construction. |
| I. `aiCalls` measures real planner invocation | **DISPROVED** | SAEI initializes `aiCalls` to zero and never calls a planner. The production background passes `undefined` for the Phase 2 planner. The only zero-call proof is a synthetic unit path. |
| J. CI tests Phase 3.5 | **DISPROVED** | `.github/workflows/phase31b.yml` runs typecheck, page/unit tests, build integrity, benchmark, and security tests. It does not run `npm run verify:autonomy`, a browser autonomy holdout, a worker-kill test, or a live recipe replay gate. |

## Additional live-path findings

### Primitive-to-action impedance mismatch

`CausalOrchestrator.primitiveVariable()` collapses several distinct primitives
into the same legacy variable. For example, `REMOVE_REACTION_UI`,
`RESTORE_LAYOUT`, and `TOGGLE_COSMETIC_ACTION` all become
`remove_overlay_gate`; `RESTORE_SCROLL`, `RESTORE_POINTER_INTERACTION`, and
`PLAYER_HEALTH_RECOVERY` all become `restore_scroll`. This destroys the
primitive identity required for audited execution, evidence-specific rollback,
and recipe replay.

### Popup actions bypass the primitive policy path

`chrome.webNavigation.onCreatedNavigationTarget` correlates a target and then
directly calls `chrome.tabs.remove()` for a high-confidence classification.
That is not an executor-registry transaction, has no `Undo/reopen` state, and
does not observe target foreground state, redirect evolution, or whether the
intended navigation completed before the extra target appeared.

### Navigation intent is incomplete

`IntentTracker` is an in-memory recent-click list. It stores only a short
window, selects the newest source-frame intent, and classifies a URL at target
creation time. It does not maintain a durable intent-outcome record, correlate
redirect chains over time, compare declared destination with the eventual
target, or distinguish all required legitimate controls such as middle/meta
click, downloads, and explicit user-opened links.

### Real state is not one recoverable loop

The causal graph and Phase 3 experiment records survive through session/local
storage, but the autonomous loop, pending primitive transaction, executor
rollback state, target registry, and intent outcome state do not survive as one
reconcilable snapshot. A worker restart can therefore restore the graph while
losing the SAEI decision context that selected the staged transaction.

### Synthetic holdout is not a live browser evaluator

`src/shared/autonomy/holdout.ts` creates `EventNode` objects directly and calls
`runDeterministicAutonomyTrial()` with an evaluator-supplied effect callback.
The runtime receives `requiredPrimitive`, `benign`, and the generated scenario
truth indirectly through the synthetic callback. Resolution and replay are
algorithmic values, not browser-observed disappearance of a popup/reaction or
preservation of intended content behavior.

### Verification is unconditional

`scripts/verify-autonomy.ts` runs the older Phase 3.1B verifier and autonomy
unit tests, writes `artifacts/phase35/AUTONOMY_SCORE.json`, and prints
`AUTONOMY VERIFICATION: PASS` without asserting live-browser thresholds. Its
metrics are synthetic-only and are not separated from a real-browser score.

## Audit conclusion

The current branch has a useful causal foundation and a real legacy
transaction/health/recipe path, but it does **not** satisfy the Phase 3.5B live
autonomy contract. The critical implementation work is to create an actual
primitive executor registry, route SAEI through it, persist and reconcile the
live loop, unify autonomous promotion with `CausalRecipeStore` and
`PromotionGate`, add real intent/navigation outcome tracking, connect optional
bounded AI advisory ranking, and prove the resulting behavior in randomized
Chromium holdouts and worker-restart tests.

Until those gates pass, the correct verdict is:

**PHASE 3.5B NOT VERIFIED**
