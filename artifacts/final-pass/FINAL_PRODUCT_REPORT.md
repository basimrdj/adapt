| Metric | BEFORE | AFTER |
|---|---:|---:|
| Ad Networks | 7/17 | USER MANUAL RETEST REQUIRED; controlled 1/1 matched |
| Trackers | 5/5 | USER MANUAL RETEST REQUIRED; controlled 1/1 matched |
| Analytics | 5/5 | USER MANUAL RETEST REQUIRED |
| Social Media | 3/5 | USER MANUAL RETEST REQUIRED |
| Annoyances | 2/3 | USER MANUAL RETEST REQUIRED; controlled 1/1 matched |
| Malware Domains | 2/2 | USER MANUAL RETEST REQUIRED; controlled 1/1 matched |
| First-click unwanted tabs | 1 | 0 created; 20/20 first encounters |
| Small anti-block banner | visible | resolved in latest run; 304 ms |
| Repeat popup protection | yes | 20/20 repeat attempts prevented |
| Protected flows preserved | ? | 40/40 tested |
| AI calls on easy cases | 0 | 0 observed |
| AI calls on ambiguous cases | 0 | 0; provider unavailable |
| AI measurable improvement | n/a | not assessed |

# Verdict

**FINAL PRODUCT FAIL — DO NOT SPEND MORE CREDITS**

Internal product gates are partially verified, but the acceptance contract is not met. The blind real-world streaming holdout remains untouched and requires a user manual retest after this run.

## Build identity

- Current HEAD: `f45ca67a3aad9d19ad8543f57a7725576b8d3617`
- Branch: `feat/phase31b-page-plane`
- PR #2: draft and unmerged
- `main`: untouched
- Build: PASS; 178,254 packaged DNR rules, 30,000 default-enabled rules, 12 static shards
- Page plane: 7,636 parsed scriptlets; 4,471 fully executable; 2,959 early executable; 0 confirmed detector-bait rules

## Blocking attribution

The development-only harness exercised five maintained-source families without using the reserved holdout or public benchmark hostnames. All five controlled requests were accepted by the converter, located in packaged rules, enabled in the running browser, and matched through Chromium `testMatchOutcome`: `5/5`, with `0` unexplained escapes.

The external 37-test benchmark was not run from this environment. No 37-test score is claimed; external category totals remain **USER MANUAL RETEST REQUIRED**.

The generic coverage fix is static-ruleset reconciliation: the packaged optional shards are discovered from the generated catalog and enabled greedily within Chromium’s available static-rule quota. The attribution artifact records source match, compiler outcome, opaque generated rule reference, enabled state, and runtime match outcome without storing browsing URLs.

## Semantic reaction targeting

The page plane now resolves small semantic reactions locally by walking a bounded ancestor chain from matched text-bearing nodes, scoring visible isolated containers, and registering the selected reaction container as an opaque `semantic-reaction-ui` target. The existing bounded remove primitive acts on that target rather than the main content tree.

- Latest probe: reaction removed, reinsertion removed, false positives `false`
- Latest measured latency: `304 ms`
- Three-repeat stability check: `322 ms` resolved, one unresolved run, `304 ms` resolved
- Required target: 100% active resolution and <=250 ms median
- Gate status: **FAIL** because latency exceeds the target and repeated resolution was not stable
- Negative controls preserved: article, FAQ, DNS settings, footer/legal text, and benign status toast

## First-popup prevention

The packaged document-start MAIN-world broker keeps synchronous local activation intent and prevents unrelated `window.open` calls before target creation. The existing navigation listeners remain telemetry/fallback only.

- Attempts: `40`
- Prevented before target creation: `40`
- Unexpected targets created: `0`
- Fallback closures: `0`
- Legitimate target-blank targets preserved: `20/20`
- OAuth flows preserved: `20/20`

This is prevention, not create-then-close cleanup.

## AI A/B result

The existing bounded planner interface was recovered and wired as an advisory, schema-validated escalation. It is not on the network-blocking hot path, first-popup synchronous path, known/static path, or recipe replay path. The trigger is deterministic: no deterministic candidate plus at least two independent ambiguity signals, with a maximum of one call per novel navigation and a 2.8-second timeout.

The provider-backed A/B gate did not run because no safe provider configuration exists in this environment: no Azure OpenAI key/base URL/model, no `ADAPT_AI_ENDPOINT`, and no usable Azure CLI configuration.

- Actual AI calls: `0`
- Ambiguous-case calls: `0`; blocked before provider-backed run
- Easy/known/static/replay calls: `0`
- AI median latency: not measured
- Estimated calls per 1,000 ordinary page loads: not measurable from an unconfigured provider run; observed `0`
- A/B improvement: not assessed
- Decision: **AI DID NOT EARN DEFAULT ROUTING**; integration remains off by default until a real provider-backed ambiguous holdout is run

The semantic phrase evidence trigger was corrected after two legacy AI recipe tests exposed that `detectedPhrases` were not counted when categories were absent. The rerun AI suite is `23/23` green.

## Files changed

- `src/entrypoints/early-popup-broker.ts`
- `src/page/popup-broker-policy.ts`
- `src/page/filtering/early-runtime.js`
- `src/manifest.json`
- `scripts/build.ts`
- `src/page/opaque-targets.ts`
- `src/page/sensor.ts`
- `src/background/causal/orchestrator.ts`
- `src/core/adaptation/engine.ts`
- `src/background/ai/remote-planner.ts`
- `src/entrypoints/background.ts`
- `src/shared/types.ts`
- `tests/unit/popup-broker-policy.test.ts`
- `scripts/final-pass/blocking-attribution.ts`
- `scripts/final-pass/verify-product.ts`
- `artifacts/final-pass/BLOCKING_MISS_ATTRIBUTION.json`
- `artifacts/final-pass/FIRST_POPUP_PREVENTION.json`
- `artifacts/final-pass/SEMANTIC_REACTION_PROBE.json`
- `artifacts/final-pass/SEMANTIC_NEGATIVE_CONTROLS.json`
- `artifacts/final-pass/AI_AB_TEST.json`
- `artifacts/final-pass/FINAL_PRODUCT_REPORT.md`

Existing `artifacts/phase31b` and `artifacts/phase35b` evidence changes were preserved and not reset.

## Verification

- `npm run build:full`: PASS
- `npm run typecheck`: PASS
- Page-filter unit tests: `10/10` PASS
- AI unit tests: `23/23` PASS
- Popup broker policy tests: `4/4` PASS
- Controlled blocking attribution: `5/5` PASS
- First-popup prevention: `20/20` first encounters with zero unwanted target creation
- Protected navigation controls: `40/40` preserved in the focused probe
- Full prior regression evidence remains recorded in the existing Phase 3.1B/3.5B artifacts; no reset or merge was performed

## GitHub Actions

- Final workflow run: `31899343595`
- Typecheck job: `95047537806`
- Page-unit job: `95047537719`
- Autonomy-fast job: `95047537728`
- Build-integrity-security job: `95047537735`
- Autonomy-live job: `95048935822`
- Earlier push/PR runs recorded in prior evidence: `31798853194`, `31798855777`

## Release blockers

- Semantic reaction latency/stability gate is not met.
- No real provider-backed ambiguous AI call or A/B improvement result was observed.
- External 37-test benchmark and blind streaming holdout remain manual retests; the holdout was not inspected or modified.
- Existing licensing review remains unresolved for proprietary release.

No hostname-specific holdout rule, selector, popup destination, or site-derived fixture was added.
