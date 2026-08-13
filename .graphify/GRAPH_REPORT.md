# Graph Report - .  (2026-08-13)

## Corpus Check
- 180 files · ~99,860 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 841 nodes · 2007 edges · 46 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output
- Edge kinds: imports: 568 · contains: 509 · imports_from: 307 · calls: 233 · method: 197 · MODIFIES: 156 · ON_BRANCH: 12 · PARENT_OF: 11 · implements: 7 · inherits: 6 · re_exports: 1


## Input Scope
- Requested: all
- Resolved: all (source: cli)
- Included files: 180 · Candidates: recursive
- Excluded: 0 untracked · 0 ignored · 0 sensitive · 0 missing committed

## Graph Freshness
- Built from Git commit: `65e9333`
- Compare this hash to `git rev-parse HEAD` before trusting freshness-sensitive graph output.
## God Nodes (most connected - your core abstractions)
1. `NavigationRegistry` - 23 edges
2. `PromotionGate` - 21 edges
3. `AdaptationTransactionEngine` - 18 edges
4. `DnrController` - 18 edges
5. `HealthVector` - 18 edges
6. `BeliefUpdater` - 17 edges
7. `CausalEngine` - 16 edges
8. `CausalOrchestrator` - 16 edges
9. `EventGraphStore` - 15 edges
10. `RecipeStore` - 15 edges

## Surprising Connections (you probably didn't know these)
- `hashOrigin()` --calls--> `sha256HexUtf8()`  [EXTRACTED]
  src/shared/causal/events.ts → src/shared/causal/events.ts  _Bridges community 5 → community 3_
- `1f0c938 feat(adapt): Complete Phase 1 implementation and full test laboratory matrix` --ON_BRANCH--> `main`  [EXTRACTED]
  git → git  _Bridges community 6 → community 0_
- `1f0c938 feat(adapt): Complete Phase 1 implementation and full test laboratory matrix` --PARENT_OF--> `fdb38c3 fix(adapt): Resolve Critical & High audit findings and expand hostile E2E matrix`  [EXTRACTED]
  git → git  _Bridges community 6 → community 23_
- `47e10ea feat: wire Phase 3 causal intelligence runtime` --ON_BRANCH--> `main`  [EXTRACTED]
  git → git  _Bridges community 21 → community 0_
- `df964e1 test(adapt): Add comprehensive Phase 1.5 release-gate verification matrix (54 tests)` --ON_BRANCH--> `main`  [EXTRACTED]
  git → git  _Bridges community 1 → community 0_

## Communities

### Community 0 - "Transaction Health and Rollback"
Cohesion: 0.06
Nodes (40): createEvidencePacket(), AdaptivePlanner, MockPlanner, AdaptivePlanner, AzurePlanner, createOracleConfig(), OracleConfig, OracleServerInstance (+32 more)

### Community 1 - "AI Planning and Oracle Server"
Cohesion: 0.07
Nodes (29): df964e1 test(adapt): Add comprehensive Phase 1.5 release-gate verification matrix (54 tests), ExperimentState, sessionValue(), waitSessionMatch(), waitSessionValue(), StoredRecipe, chromeExecutable(), launch() (+21 more)

### Community 2 - "Background Service Worker Lifecycle"
Cohesion: 0.08
Nodes (26): BeliefDecision, BetaBelief, BinaryTrial, boundsForMechanism(), ciCovers(), classifyTrial(), DEFAULT_SEQUENTIAL_BOUNDS, EffectEstimate (+18 more)

### Community 3 - "Candidate Generation and Evidence Builder"
Cohesion: 0.08
Nodes (36): CausalDocumentKey, causalKeyFromNode(), ClockDomain, EdgeStatus, EventEdge, EventKind, EventNode, EventProvenance (+28 more)

### Community 4 - "End-to-End Test and Verification Suite"
Cohesion: 0.07
Nodes (30): ExperimentSelector, selectExperiment(), ALLOWED_INTERVENTION_VARIABLES, ALLOWED_VARIABLE_SET, CAUSAL_REASON_CODES, CausalReasonCode, clampUnit(), containsForbiddenToken() (+22 more)

### Community 5 - "DNR Rule ID Allocation"
Cohesion: 0.11
Nodes (23): coarseUrlFeatures(), EventNormalizer, navigationKind(), RawNavigationEvent, RawRequestEvent, requestKind(), requestRef(), stablePositiveIntFromRequestId() (+15 more)

### Community 6 - "DNR Rule Compiler and Priorities"
Cohesion: 0.11
Nodes (11): 1f0c938 feat(adapt): Complete Phase 1 implementation and full test laboratory matrix, DnrIdAllocator, IdBandType, RuleIdAllocation, DnrQuotaTracker, DnrQuotaUsage, QuotaCheckResult, DnrReconciler (+3 more)

### Community 7 - "Content Script Page Sensor"
Cohesion: 0.11
Nodes (20): sensor, AppliedDomActionRecord, extractGeometrySignals(), extractInteractionSignals(), OpaqueTargetRegistry, extractSemanticSignals(), ADAPT_THRESHOLDS, DETECTOR_KEYWORDS (+12 more)

### Community 8 - "Adaptation Engine Lifecycle and Recovery"
Cohesion: 0.10
Nodes (12): AdaptationRollbackHandler, CausalEngineDeps, CausalExperimentResult, CausalExperimentState, CausalRunContext, DnrBackend, DnrController, AdaptationTransaction (+4 more)

### Community 9 - "DOM Mutation Governor Pipeline"
Cohesion: 0.11
Nodes (23): CandidateGenerator, CandidateRule, collectDrafts(), Draft, hasHealthDrop(), healthDelta(), HypothesisOutcome, isControllable() (+15 more)

### Community 10 - "Azure OpenAI Cloud Planner"
Cohesion: 0.12
Nodes (23): ExperimentRecord, lastExperiment(), PromotionEvaluateResult, PromotionReplayResult, REVERSIBLE_ACTION_TYPES, StoredBundle, CAUSAL_RECIPE_VERSION, CausalRecipe (+15 more)

### Community 11 - "Causal Policy Validation"
Cohesion: 0.17
Nodes (10): StrategyCandidateGenerator, NavigationFreshnessGuard, createAdaptationTransaction(), updateTransactionState(), AuditStore, StorageBackend, STORAGE_KEYS, PageSignalBatch (+2 more)

### Community 12 - "Promotion Test Fixtures"
Cohesion: 0.12
Nodes (23): ABSTAIN_KEYS, EXPERIMENT_KEYS, extraKeys(), fail(), finiteRisks(), FORBIDDEN_KEY_SET, hasActionExpansion(), isPlainObject() (+15 more)

### Community 13 - "Chromium Verification Suites"
Cohesion: 0.09
Nodes (21): adaptEngine, auditStore, beliefUpdater, causalEngine, causalGraphs, causalHandledBatches, causalOrchestrator, causalQueues (+13 more)

### Community 14 - "Background Runtime Wiring"
Cohesion: 0.12
Nodes (19): PromotionEvaluateInput, createPageFingerprint(), defaultConstraints(), PageFingerprint, BASE_FP, baseInput(), committedTrio(), FIXTURE_DIR (+11 more)

### Community 15 - "Recipe Promotion Gates"
Cohesion: 0.15
Nodes (5): CausalOrchestrator, CausalResourceRegistry, compactScore(), nowNode(), StrategyResolutionContext

### Community 16 - "Adaptation Transaction Health"
Cohesion: 0.18
Nodes (5): derivedPrivacyScore(), derivedStableReplays(), experimentCount(), PromotionGate, verifiedExperiments()

### Community 17 - "Event Graph Storage"
Cohesion: 0.21
Nodes (7): CausalEngine, isForbiddenIntervention(), liveEpoch(), makeRecord(), primaryFrameId(), toAdaptationTx(), toCompact()

### Community 18 - "Causal Runtime Orchestration"
Cohesion: 0.13
Nodes (9): buildMinimalPacket(), EvidencePacketV3, STRATEGY_REF_ALLOWLIST, DEFAULT_EXPERIMENT_BUDGET, CausalFixture, FIXTURE_DIR, graphFromFixture(), loadFixture() (+1 more)

### Community 19 - "Temporal Graph Model"
Cohesion: 0.23
Nodes (9): CompiledDnrRule, DnrCompiler, getPriority(), PriorityBand, PRIORITIES, BaseAction, NetAllowAction, NetBlockAction (+1 more)

### Community 20 - "Experiment Candidate Generation"
Cohesion: 0.22
Nodes (7): AdaptationVerifier, verifyHealthOutcome(), DEFAULT_HEALTH_WEIGHTS, HealthWeights, calculateHealthVector(), HealthVector, VerificationResult

### Community 21 - "Network Request Telemetry"
Cohesion: 0.26
Nodes (9): RouteDecision, 47e10ea feat: wire Phase 3 causal intelligence runtime, createNavigationEpoch(), createNavigationId(), createSyntheticDocumentId(), extractSiteKey(), resolveDocumentId(), DocumentScopedRequest (+1 more)

### Community 22 - "Navigation Identity Runtime"
Cohesion: 0.19
Nodes (13): CausalHypothesis, collectActionRefs(), ExperimentGenerator, graphIsBenignOnly(), hypothesisTouchesBenign(), nodeById(), pairedBaselineAvailable(), scopeFromGraph() (+5 more)

### Community 23 - "Promoção de Receitas"
Cohesion: 0.20
Nodes (7): fdb38c3 fix(adapt): Resolve Critical & High audit findings and expand hostile E2E matrix, RecipePromotionManager, createNewRecipe(), updateRecipeState(), AuditEvent, RecipeState, SiteRecipe

### Community 24 - "DNR Action Compilation"
Cohesion: 0.24
Nodes (1): NavigationRegistry

### Community 25 - "Navigation Epoch Registry"
Cohesion: 0.38
Nodes (1): AdaptationTransactionEngine

### Community 26 - "Adaptation Engine Lifecycle"
Cohesion: 0.24
Nodes (10): ALLOWED, experimentToStrategy(), isAllowedVariable(), ResolvedNetworkTarget, riskFromHealth(), StrategyResolutionContext, unsafeText(), AllowedInterventionVariable (+2 more)

### Community 27 - "Epoch Session Recovery"
Cohesion: 0.35
Nodes (10): aggregate(), discover(), Family, learned_edges(), main(), metrics(), ratio(), simulate() (+2 more)

### Community 28 - "Causal Recipe Storage"
Cohesion: 0.31
Nodes (1): CausalRecipeStore

### Community 29 - "Page Sensor Messaging"
Cohesion: 0.47
Nodes (1): PageSensor

### Community 30 - "Document Graph Store"
Cohesion: 0.32
Nodes (1): EventGraphStore

### Community 31 - "Document Identity Spike"
Cohesion: 0.46
Nodes (1): RecipeStore

### Community 32 - "Health Vector Scoring"
Cohesion: 0.36
Nodes (7): buildInstrumentedExtension(), __dirname, events, findChrome(), main(), NavEvent, startLogger()

### Community 33 - "DOM Action Execution"
Cohesion: 0.25
Nodes (5): createHarness(), DnrBackend, MemoryDnrBackend, MemoryStorage, StorageBackend

### Community 34 - "Mutation Load Governance"
Cohesion: 0.38
Nodes (1): RequestGraphManager

### Community 35 - "Chrome Storage Adapter"
Cohesion: 0.43
Nodes (2): DomActionExecutor, sanitizeCssSelector()

### Community 36 - "Promotion Safety Filters"
Cohesion: 0.29
Nodes (1): MutationPipeline

### Community 37 - "DNR Compiler"
Cohesion: 0.33
Nodes (2): ChromeStorageBackend, StorageBackend

### Community 38 - "Request Observer"
Cohesion: 0.50
Nodes (4): actionText(), hasForbiddenContext(), isNoopInvalidAllow(), isPersistentTrackerAllow()

### Community 39 - "Session Storage Test"
Cohesion: 0.40
Nodes (1): RequestObserver

### Community 40 - "Causal Scope Guards"
Cohesion: 0.40
Nodes (2): MemorySessionStorage, StorageBackend

### Community 41 - "Graph Description Helper"
Cohesion: 0.67
Nodes (1): EpochRouter

### Community 42 - "Extension Build Pipeline"
Cohesion: 0.50
Nodes (1): CausalSessionStateRepository

### Community 43 - "Community 43"
Cohesion: 0.50
Nodes (2): dir, files

### Community 44 - "Community 44"
Cohesion: 1.00
Nodes (2): close(), main()

### Community 45 - "Community 45"
Cohesion: 0.67
Nodes (1): __dirname

## Knowledge Gaps
- **129 isolated node(s):** `BenchmarkRunResult`, `__dirname`, `corpus`, `outputPath`, `corpus` (+124 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `DNR Action Compilation`** (1 nodes): `NavigationRegistry`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Navigation Epoch Registry`** (1 nodes): `AdaptationTransactionEngine`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Causal Recipe Storage`** (1 nodes): `CausalRecipeStore`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Page Sensor Messaging`** (1 nodes): `PageSensor`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Document Graph Store`** (1 nodes): `EventGraphStore`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Document Identity Spike`** (1 nodes): `RecipeStore`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Mutation Load Governance`** (1 nodes): `RequestGraphManager`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Chrome Storage Adapter`** (2 nodes): `DomActionExecutor`, `sanitizeCssSelector()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Promotion Safety Filters`** (1 nodes): `MutationPipeline`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `DNR Compiler`** (2 nodes): `ChromeStorageBackend`, `StorageBackend`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Session Storage Test`** (1 nodes): `RequestObserver`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Causal Scope Guards`** (2 nodes): `MemorySessionStorage`, `StorageBackend`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Graph Description Helper`** (1 nodes): `EpochRouter`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Extension Build Pipeline`** (1 nodes): `CausalSessionStateRepository`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 43`** (2 nodes): `dir`, `files`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 44`** (2 nodes): `close()`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (1 nodes): `__dirname`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `PromotionGate` connect `Adaptation Transaction Health` to `DNR Rule ID Allocation`, `Azure OpenAI Cloud Planner`, `Request Observer`, `Chromium Verification Suites`, `Background Runtime Wiring`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **Why does `CausalOrchestrator` connect `Recipe Promotion Gates` to `DNR Rule ID Allocation`, `Chromium Verification Suites`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `NavigationRegistry` connect `DNR Action Compilation` to `Adaptation Engine Lifecycle and Recovery`, `Network Request Telemetry`, `DNR Rule ID Allocation`, `Background Service Worker Lifecycle`, `Chromium Verification Suites`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **What connects `BenchmarkRunResult`, `__dirname`, `corpus` to the rest of the system?**
  _129 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Transaction Health and Rollback` be split into smaller, more focused modules?**
  _Cohesion score 0.06293965198074787 - nodes in this community are weakly interconnected._
- **Should `AI Planning and Oracle Server` be split into smaller, more focused modules?**
  _Cohesion score 0.07312925170068027 - nodes in this community are weakly interconnected._
- **Should `Background Service Worker Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.07729468599033816 - nodes in this community are weakly interconnected._