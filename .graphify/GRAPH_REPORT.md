# Graph Report - .  (2026-08-13)

## Corpus Check
- 165 files · ~93,084 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 786 nodes · 1920 edges · 43 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output
- Edge kinds: imports: 556 · contains: 471 · imports_from: 302 · calls: 217 · method: 192 · MODIFIES: 153 · ON_BRANCH: 8 · implements: 7 · PARENT_OF: 7 · inherits: 6 · re_exports: 1


## Input Scope
- Requested: committed
- Resolved: committed (source: cli)
- Included files: 165 · Candidates: 190
- Excluded: 278 untracked · 8393 ignored · 0 sensitive · 0 missing committed
- Recommendation: Use --scope all or graphify.yaml inputs.corpus for a knowledge-base folder.

## Graph Freshness
- Built from Git commit: `47e10ea`
- Compare this hash to `git rev-parse HEAD` before trusting freshness-sensitive graph output.
## God Nodes (most connected - your core abstractions)
1. `NavigationRegistry` - 23 edges
2. `PromotionGate` - 21 edges
3. `AdaptationTransactionEngine` - 18 edges
4. `DnrController` - 18 edges
5. `HealthVector` - 18 edges
6. `BeliefUpdater` - 17 edges
7. `CausalEngine` - 16 edges
8. `EventGraphStore` - 15 edges
9. `CausalOrchestrator` - 15 edges
10. `RecipeStore` - 15 edges

## Surprising Connections (you probably didn't know these)
- `1f0c938 feat(adapt): Complete Phase 1 implementation and full test laboratory matrix` --ON_BRANCH--> `main`  [EXTRACTED]
  git → git  _Bridges community 3 → community 0_
- `1f0c938 feat(adapt): Complete Phase 1 implementation and full test laboratory matrix` --PARENT_OF--> `fdb38c3 fix(adapt): Resolve Critical & High audit findings and expand hostile E2E matrix`  [EXTRACTED]
  git → git  _Bridges community 3 → community 23_
- `47e10ea feat: wire Phase 3 causal intelligence runtime` --ON_BRANCH--> `main`  [EXTRACTED]
  git → git  _Bridges community 22 → community 0_
- `df964e1 test(adapt): Add comprehensive Phase 1.5 release-gate verification matrix (54 tests)` --ON_BRANCH--> `main`  [EXTRACTED]
  git → git  _Bridges community 13 → community 0_
- `fdb38c3 fix(adapt): Resolve Critical & High audit findings and expand hostile E2E matrix` --ON_BRANCH--> `main`  [EXTRACTED]
  git → git  _Bridges community 23 → community 0_

## Communities

### Community 0 - "Transaction Health and Rollback"
Cohesion: 0.08
Nodes (35): BenchmarkRunResult, EvaluationCase, createCase(), generateCorpus(), corpus, outputPath, PromptInjectionCase, corpus (+27 more)

### Community 42 - "Extension Build Pipeline"
Cohesion: 0.67
Nodes (1): __dirname

### Community 41 - "Graph Description Helper"
Cohesion: 0.50
Nodes (2): dir, files

### Community 11 - "Causal Policy Validation"
Cohesion: 0.13
Nodes (22): EXPERIMENT_KEYS, ABSTAIN_KEYS, PROMOTE_KEYS, FORBIDDEN_KEY_SET, fail(), isPlainObject(), hasActionExpansion(), extraKeys() (+14 more)

### Community 2 - "Background Service Worker Lifecycle"
Cohesion: 0.08
Nodes (27): BeliefUpdater, CausalSessionSnapshot, BetaBelief, EffectEstimate, WelfordAccumulator, BeliefDecision, SequentialBounds, UNIFORM_PRIOR (+19 more)

### Community 9 - "DOM Mutation Governor Pipeline"
Cohesion: 0.12
Nodes (21): Phase1StrategyClass, MECHANISM_STRATEGY_ALLOWLIST, MechanismClass, HypothesisOutcome, CandidateRule, numberFeature(), healthDelta(), hasHealthDrop() (+13 more)

### Community 4 - "End-to-End Test and Verification Suite"
Cohesion: 0.11
Nodes (27): CandidateGenerator, RawNavigationEvent, RawRequestEvent, timestampFromChrome(), navigationKind(), requestKind(), stablePositiveIntFromRequestId(), requestRef() (+19 more)

### Community 1 - "AI Planning and Oracle Server"
Cohesion: 0.06
Nodes (31): CausalRunContext, CausalExperimentState, CausalExperimentResult, CausalEngineDeps, toCompact(), liveEpoch(), primaryFrameId(), isForbiddenIntervention() (+23 more)

### Community 27 - "Epoch Session Recovery"
Cohesion: 0.22
Nodes (3): RouteDecision, EpochRouter, CausalSessionStateRepository

### Community 20 - "Experiment Candidate Generation"
Cohesion: 0.19
Nodes (13): SKIPPED_MECHANISMS, graphIsBenignOnly(), nodeById(), hypothesisTouchesBenign(), collectActionRefs(), scopeFromGraph(), pairedBaselineAvailable(), ExperimentGenerator (+5 more)

### Community 7 - "Content Script Page Sensor"
Cohesion: 0.09
Nodes (16): ExperimentSelector, selectExperiment(), STRATEGY_REF_ALLOWLIST, ExperimentCandidate, CurrentEpochState, ExperimentSelectionBudget, ExperimentBudget, CausalPlannerDecisionV1 (+8 more)

### Community 17 - "Event Graph Storage"
Cohesion: 0.12
Nodes (13): GraphAppendReason, GraphAppendResult, GraphSlot, CausalDocumentKey, causalKeyFromNode(), GraphRejectReason, serializeCausalKey(), addNode() (+5 more)

### Community 30 - "Document Graph Store"
Cohesion: 0.32
Nodes (1): EventGraphStore

### Community 18 - "Causal Runtime Orchestration"
Cohesion: 0.16
Nodes (5): compactScore(), nowNode(), CausalResourceRegistry, StrategyResolutionContext, CausalOrchestrator

### Community 6 - "DNR Rule Compiler and Priorities"
Cohesion: 0.12
Nodes (23): REVERSIBLE_ACTION_TYPES, PromotionEvaluateResult, PromotionReplayResult, StoredBundle, lastExperiment(), ExperimentRecord, CausalRecipe, CausalRecipeLifecycle (+15 more)

### Community 12 - "Promotion Test Fixtures"
Cohesion: 0.11
Nodes (20): PromotionEvaluateInput, PageFingerprint, createPageFingerprint(), defaultConstraints(), StrategyAction, FIXTURE_DIR, HEALTH, BASE_FP (+12 more)

### Community 36 - "Promotion Safety Filters"
Cohesion: 0.50
Nodes (4): isNoopInvalidAllow(), isPersistentTrackerAllow(), actionText(), hasForbiddenContext()

### Community 15 - "Recipe Promotion Gates"
Cohesion: 0.18
Nodes (5): experimentCount(), verifiedExperiments(), derivedStableReplays(), derivedPrivacyScore(), PromotionGate

### Community 28 - "Causal Recipe Storage"
Cohesion: 0.31
Nodes (1): CausalRecipeStore

### Community 10 - "Azure OpenAI Cloud Planner"
Cohesion: 0.14
Nodes (5): AuditStore, DnrController, StorageBackend, STORAGE_KEYS, PageSignalBatch

### Community 35 - "Chrome Storage Adapter"
Cohesion: 0.33
Nodes (2): ChromeStorageBackend, StorageBackend

### Community 16 - "Adaptation Transaction Health"
Cohesion: 0.19
Nodes (11): StrategyCandidateGenerator, NavigationFreshnessGuard, createAdaptationTransaction(), updateTransactionState(), AdaptationVerifier, verifyHealthOutcome(), HealthVector, StrategyCandidate (+3 more)

### Community 26 - "Adaptation Engine Lifecycle"
Cohesion: 0.38
Nodes (1): AdaptationTransactionEngine

### Community 24 - "DNR Action Compilation"
Cohesion: 0.29
Nodes (9): CompiledDnrRule, PriorityBand, getPriority(), PRIORITIES, BaseAction, NetBlockAction, NetAllowAction, NetRedirectAction (+1 more)

### Community 37 - "DNR Compiler"
Cohesion: 0.70
Nodes (1): DnrCompiler

### Community 3 - "Candidate Generation and Evidence Builder"
Cohesion: 0.09
Nodes (15): DnrBackend, IdBandType, RuleIdAllocation, DnrIdAllocator, DnrQuotaUsage, QuotaCheckResult, DnrQuotaTracker, ReconciliationResult (+7 more)

### Community 32 - "Health Vector Scoring"
Cohesion: 0.43
Nodes (3): HealthWeights, DEFAULT_HEALTH_WEIGHTS, calculateHealthVector()

### Community 22 - "Navigation Identity Runtime"
Cohesion: 0.29
Nodes (9): extractSiteKey(), createNavigationId(), createSyntheticDocumentId(), isSyntheticDocumentId(), resolveDocumentId(), createNavigationEpoch(), DocumentScopedRequest, NavigationEpoch (+1 more)

### Community 25 - "Navigation Epoch Registry"
Cohesion: 0.24
Nodes (1): NavigationRegistry

### Community 21 - "Network Request Telemetry"
Cohesion: 0.19
Nodes (5): NormalizedUrl, normalizeUrlForTelemetry(), RequestRecord, NavigationRequestGraph, RequestGraphManager

### Community 38 - "Request Observer"
Cohesion: 0.40
Nodes (1): RequestObserver

### Community 23 - "Promoção de Receitas"
Cohesion: 0.27
Nodes (6): RecipePromotionManager, createNewRecipe(), updateRecipeState(), RecipeState, SiteRecipe, fdb38c3 fix(adapt): Resolve Critical & High audit findings and expand hostile E2E matrix

### Community 14 - "Background Runtime Wiring"
Cohesion: 0.09
Nodes (20): chromeStorageBackend, chromeSessionBackend, chromeDnrBackend, navRegistry, graphManager, requestObserver, dnrController, recipeStore (+12 more)

### Community 5 - "DNR Rule ID Allocation"
Cohesion: 0.12
Nodes (17): sensor, AppliedDomActionRecord, extractGeometrySignals(), extractInteractionSignals(), OpaqueTargetRegistry, extractSemanticSignals(), DETECTOR_KEYWORDS, ContentToBackgroundMessage (+9 more)

### Community 33 - "DOM Action Execution"
Cohesion: 0.43
Nodes (2): sanitizeCssSelector(), DomActionExecutor

### Community 34 - "Mutation Load Governance"
Cohesion: 0.29
Nodes (1): MutationPipeline

### Community 29 - "Page Sensor Messaging"
Cohesion: 0.47
Nodes (1): PageSensor

### Community 19 - "Temporal Graph Model"
Cohesion: 0.16
Nodes (13): EventEdge, timestampDeltaMs(), DEFAULT_LAG_WINDOWS, LagWindow, GraphMutationResult, BENIGN_CLASSES, createGraphId(), createEmptyGraph() (+5 more)

### Community 40 - "Causal Scope Guards"
Cohesion: 0.67
Nodes (2): scopesEqual(), isStaleScope()

### Community 8 - "Adaptation Engine Lifecycle and Recovery"
Cohesion: 0.09
Nodes (23): UTILITY_WEIGHTS, StrategyRefName, ALLOWED_INTERVENTION_VARIABLES, CAUSAL_REASON_CODES, CausalReasonCode, EXPECTED_OUTCOMES, ExpectedOutcome, InterventionTemplate (+15 more)

### Community 13 - "Chromium Verification Suites"
Cohesion: 0.20
Nodes (15): isObject(), isNumber(), isString(), isBoolean(), isHealthVector(), isPageSignalBatch(), isDomAction(), isStrategyCandidate() (+7 more)

### Community 39 - "Session Storage Test"
Cohesion: 0.40
Nodes (2): MemorySessionStorage, StorageBackend

### Community 31 - "Document Identity Spike"
Cohesion: 0.36
Nodes (7): __dirname, NavEvent, events, startLogger(), buildInstrumentedExtension(), findChrome(), main()

## Knowledge Gaps
- **119 isolated node(s):** `BenchmarkRunResult`, `__dirname`, `corpus`, `outputPath`, `corpus` (+114 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Extension Build Pipeline`** (1 nodes): `__dirname`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Graph Description Helper`** (2 nodes): `dir`, `files`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Document Graph Store`** (1 nodes): `EventGraphStore`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Causal Recipe Storage`** (1 nodes): `CausalRecipeStore`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Chrome Storage Adapter`** (2 nodes): `ChromeStorageBackend`, `StorageBackend`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Adaptation Engine Lifecycle`** (1 nodes): `AdaptationTransactionEngine`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `DNR Compiler`** (1 nodes): `DnrCompiler`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Navigation Epoch Registry`** (1 nodes): `NavigationRegistry`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Request Observer`** (1 nodes): `RequestObserver`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `DOM Action Execution`** (2 nodes): `sanitizeCssSelector()`, `DomActionExecutor`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Mutation Load Governance`** (1 nodes): `MutationPipeline`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Page Sensor Messaging`** (1 nodes): `PageSensor`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Causal Scope Guards`** (2 nodes): `scopesEqual()`, `isStaleScope()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Session Storage Test`** (2 nodes): `MemorySessionStorage`, `StorageBackend`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `PromotionGate` connect `Recipe Promotion Gates` to `End-to-End Test and Verification Suite`, `DNR Rule Compiler and Priorities`, `Promotion Safety Filters`, `Background Runtime Wiring`, `Promotion Test Fixtures`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **Why does `CausalOrchestrator` connect `Causal Runtime Orchestration` to `End-to-End Test and Verification Suite`, `Background Runtime Wiring`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `NavigationRegistry` connect `Navigation Epoch Registry` to `AI Planning and Oracle Server`, `Epoch Session Recovery`, `End-to-End Test and Verification Suite`, `Background Service Worker Lifecycle`, `Background Runtime Wiring`, `Navigation Identity Runtime`, `Causal Scope Guards`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **What connects `BenchmarkRunResult`, `__dirname`, `corpus` to the rest of the system?**
  _119 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Transaction Health and Rollback` be split into smaller, more focused modules?**
  _Cohesion score 0.07787698412698413 - nodes in this community are weakly interconnected._
- **Should `Causal Policy Validation` be split into smaller, more focused modules?**
  _Cohesion score 0.12648221343873517 - nodes in this community are weakly interconnected._
- **Should `Background Service Worker Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.07585568917668825 - nodes in this community are weakly interconnected._