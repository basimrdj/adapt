# ADAPT Phase 3 final acceptance - 2026-08-13

## Verdict

PHASE 3 VERIFIED

This verdict was reached only after repairing defects found by an independent fresh-browser audit and rerunning the complete release surface. Phase 3.5 implementation was not started during this verification.

## Environment and immutable identifiers

| Item | Accepted value |
|---|---|
| Repository | `/Users/basimhussain/Projects/adapt` |
| Verified base HEAD | `65e9333cc6a5f9724f74add69842a1a95d7fb8f7` |
| Phase 3 commits | `47e10ea`, `6c9e2f2`, `f0686a5`, `b3d5c04`, `65e9333` - all reachable from `main` |
| OS | macOS 27.0 build 26A5406e, arm64 |
| Chromium used by automated acceptance | Chrome for Testing 151.0.7922.77 |
| Extension ID | `kmolblmghlfkdflbgphodfpglfcdpcfi` |
| Fresh persistent restart profile | `/var/folders/dh/8fvjmp5j03b360bl2kz4jw9h0000gp/T/adapt-phase3-profile-s4lcbm` (ephemeral; deleted after test) |
| Novel fixture | `t29-phase3-acceptance` |
| Modified detector | `t29-phase3-acceptance?detector=modified` |

## Independent audit findings and repairs

The prior `169 passed` report did not prove the original 20-step contract. Fresh browser execution exposed these release-blocking faults:

1. fingerprint identity could be checked only after an action was already applied;
2. draft recipes could not progress to `RECIPE_SAFE` through later replays;
3. document-local opaque IDs fragmented cross-visit causal evidence;
4. causal observation messages were not truly serialized;
5. candidate regeneration erased experiment-updated hypotheses;
6. recipe fingerprints could capture post-intervention rather than baseline state;
7. resource, scroll, and pointer timing could invalidate or suppress a valid DOM-only replay;
8. a second candidate could be marked attempted while the first transaction was still staged;
9. the legacy fallback could race and erase the causal discrimination sequence;
10. M7's incomplete dependency pins did not reproduce in a clean virtual environment.

The repairs preserve the original safety boundary: actions remain pre-generated, opaque-ref scoped, document/epoch checked, reversible, privacy bounded, and promotion gated. DOM-only recipes no longer depend on webRequest timing; network recipes still retain resource-set constraints. Fingerprints are checked before action application and changed detector identity invalidates before replay.

## Canonical gate results

| Gate | Result | Evidence |
|---|---|---|
| Typecheck | PASS | `npm run typecheck` |
| Unit/property/policy/integration | PASS | 27 files, 140 tests |
| Production build | PASS | background, content, and popup bundles produced |
| Real Chromium | PASS | 6 files, 32 tests, no skips |
| Bundle/security | PASS | 4 focused production-bundle and hostile-policy checks |
| M7 clean reproduction | PASS | fresh venv, pinned dependencies, 4 algorithm tests |
| M7 raw recomputation | PASS | 216/216 rows, 12/12 families, all seeds and algorithms represented |
| Graphify portability | PASS | 102 portable files checked |
| Graphify structural integrity | PASS | 841 nodes, 2,007 edges, 100% extracted, scope `all`, built from `65e9333` |

Graphify still has assistant-mode description batches pending. That is semantic documentation enrichment, not a missing code node, stale structural graph, portability failure, or release gate. The refreshed graph was used to identify the high-blast-radius bridge nodes `CausalOrchestrator`, `BeliefUpdater`, `CausalEngine`, `NavigationRegistry`, and `PromotionGate`; the new Chromium tests exercise the affected orchestration, transaction, replay, and restart paths.

## M7 independent reproduction

The clean run used:

- causal-learn 0.1.4.4;
- NumPy 2.2.6;
- SciPy 1.14.1;
- scikit-learn 1.7.1;
- pandas 2.3.3;
- NetworkX 3.4.2;
- Matplotlib 3.10.6.

Raw-result verification recomputed the run count, family and seed coverage, skeleton metrics, orientation metrics, latent-family metric, and the unchanged `0.80` orientation eligibility gate. PC, GES, and FCI each achieved held-out skeleton F1 `1.000`, but orientation precision `0.250`; none is eligible for production. The decision remains: offline research only, intervention-first online reasoning.

## Original 20-step exit contract

| # | Contract | Result and evidence |
|---:|---|---|
| 1 | Novel synthetic anti-block breakage | PASS - new delayed external-script T29 fixture |
| 2 | Phase 1/2 recipes cannot already solve it | PASS - fresh profile/local storage; causal experiment records appear before any learned recipe |
| 3 | Correct document-epoch scope | PASS - document `2014B1BE7F457BD2E778838E2F6AD5F6`, epoch `1`; separate SPA/commit identity test passes |
| 4 | At least two plausible hypotheses | PASS - scroll-lock reaction and bait-visibility probe generate distinct experiments |
| 5 | Low-risk discriminator chosen | PASS - scroll restoration selected first as `experiment:x1` |
| 6 | Policy accepts only pre-generated opaque ref | PASS - `policy:experiment:x1`; allowlisted `strategy:s3` plus opaque request ref; hostile policy corpus has zero escapes |
| 7 | Transaction stages reversibly | PASS - `tx_1962194013_1786624737588_s6by9` |
| 8 | Wrong intervention rolls back | PASS - `experiment:x1` -> `ROLLED_BACK`, `rollbackVerified=true` |
| 9 | Wrong confidence falls | PASS - failure updates the scroll belief with negative evidence; belief updater/unit bounds pass |
| 10 | Second safe experiment supports truth | PASS - `experiment:x2`, bait preservation, `COMMITTED` |
| 11 | Health improves and privacy holds | PASS - health delta `0.4175`, privacy score `1` |
| 12 | Promotion gate passes | PASS - safety/statistical/replay/privacy/fingerprint/rollback gates; two stable replays |
| 13 | Deterministic recipe persists | PASS - local-storage `recipe:rcp1`, lifecycle `RECIPE_SAFE` |
| 14 | Browser restarts | PASS - browser closed and relaunched with the exact persistent profile above |
| 15 | Repeat uses zero AI/exploration | PASS - `explorationRecordsAfterRestart=0`; deterministic causal replay path contains no AI call |
| 16 | Modified detector invalidates stale recipe | PASS - `DETECTOR_MISMATCH` before action application |
| 17 | Worker termination leaves no corruption | PASS - CDP `Runtime.terminateExecution`, session restore and idempotent DOM action proof |
| 18 | Rapid navigation yields zero stale mutations | PASS - rapid A -> B -> C Chromium test plus slow-planner stale-response unit suite |
| 19 | Concurrent tabs have zero leakage | PASS - simultaneous independent transactions and 20-tab stress matrix |
| 20 | Hostile instructions yield zero escapes | PASS - hostile policy/red-team corpus, malformed IPC, and forbidden intervention checks |

Second transaction evidence: `tx_1962194013_1786624738096_04grs`, policy decision `policy:experiment:x2`, same document and epoch, `rollbackVerified=true`. Restart evidence recorded Chrome 151.0.7922.77, extension ID `kmolblmghlfkdflbgphodfpglfcdpcfi`, recipe `recipe:rcp1`, `stableReplays=2`, zero exploration records, and detector invalidation reason `DETECTOR_MISMATCH`.

## User acceptance command

```bash
npm run verify:phase3
```

Interactive execution opens the synthetic fixture in a new profile and waits for manual inspection. Non-interactive execution writes `artifacts/phase3/latest.json` and `artifacts/phase3/latest.md` and exits non-zero on any failed executable gate.

## Final release statement

PHASE 3 VERIFIED
