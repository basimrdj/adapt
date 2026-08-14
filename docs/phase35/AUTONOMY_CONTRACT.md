# ADAPT Phase 3.5 Autonomy Contract

ADAPT is autonomous only when a trial starts from an unresolved, previously
unknown failure and no developer or hostname-specific hint is supplied.

## Successful autonomous trial

A successful trial must satisfy all of the following:

1. The page mechanism is unknown to the runtime test and no hostname recipe
   exists.
2. No developer hint, selector, warning string, URL, or site-specific fixture
   is supplied to the runtime.
3. ADAPT observes the anomaly through structured, privacy-preserving signals.
4. The anomaly is represented in the causal event graph.
5. ADAPT creates multiple competing hypotheses and chooses a bounded,
   reversible, policy-approved experiment.
6. Page health remains acceptable while the experiment runs.
7. The unwanted reaction or advertising side effect is resolved without
   bypassing authentication, DRM, subscriptions, paywalls, purchases, or
   security controls.
8. The successful primitive sequence is promoted into a deterministic recipe.
9. A second visit replays the recipe with zero AI calls, zero exploration, and
   no developer intervention.

Any trial that requires a human to identify the root cause is not an autonomy
pass. A capability that cannot be expressed by the shipped Primitive Registry
is recorded as `CAPABILITY_GAP`; generated code is never executed.

## Privacy boundary

The sensorium stores coarse categories, hashes, opaque element/request/frame
references, destination classes, and confidence values. It does not store raw
page text, selectors, form values, cookies, authentication headers, or raw
URLs in causal state.

## Holdout policy

Holdout scenarios are generated from mechanism combinations and are never
inspected by the runtime. The evaluator owns expected outcomes; the runtime
receives only the generated observations. Real-world holdouts remain outside
implementation data and are evaluated manually after synthetic gates pass.
