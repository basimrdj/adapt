# Phase 3.5B Live Execution

## Real transaction lifecycle

`stageAutonomousExperiment()` allocates a transaction ID, verifies the current
document epoch, and calls the trusted executor. The executor either stages a
real DNR/DOM/navigation change or returns a typed capability gap. On success,
the pending mapping is persisted before the health request is sent.

`onHealthSnapshot()` routes the actual content-script health vector to
`finishAutonomous()`. `verifyHealthOutcome()` decides whether the page became
healthier while preserving content, network integrity, privacy, and
interaction. Successful actions commit; failed actions roll back idempotently.

## Implemented reversible path

The final browser holdout exercised `RESTORE_SCROLL` and
`REMOVE_REACTION_UI`. The latter is an atomic reversible action sequence:
remove the authenticated overlay target and restore scroll state. The final
recorded run committed both overlay repairs and verified rollback on the failed
scroll-only discriminator.

## Current gaps

- Popup target closure is not accepted as browser-proven in the final run.
- No safe quarantine primitive is implemented.
- Packaged scriptlet rollback is not proven.
- Session-DNR and redirect executors have unit coverage but not a browser
  holdout row yet.
- Recipe replay did not reach a passing eligible trial in the final corpus.

The live score therefore remains a failure/partial result, not a product
release claim.
