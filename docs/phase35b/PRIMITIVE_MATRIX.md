# Primitive Execution Matrix

The JSON artifact is authoritative: `artifacts/phase35b/PRIMITIVE_EXECUTION_MATRIX.json`.
The matrix intentionally has only two states:

- `EXECUTABLE_AND_BROWSER_TESTED`
- `CAPABILITY_GAP`

| Primitive | Final state | Reason / browser test |
|---|---|---|
| `TEMPORARY_NETWORK_ALLOW` | `CAPABILITY_GAP` | Trusted executor exists; no browser holdout row. |
| `TEMPORARY_NETWORK_BLOCK` | `CAPABILITY_GAP` | Trusted executor exists; no browser holdout row. |
| `TARGETED_SESSION_DNR` | `CAPABILITY_GAP` | Trusted executor exists; no browser holdout row. |
| `TOGGLE_COSMETIC_ACTION` | `CAPABILITY_GAP` | Trusted executor exists; no browser holdout row. |
| `PRESERVE_BAIT` | `CAPABILITY_GAP` | Trusted executor exists; no browser holdout row. |
| `RESTORE_LAYOUT` | `CAPABILITY_GAP` | Trusted executor exists; no browser holdout row. |
| `REMOVE_REACTION_UI` | `EXECUTABLE_AND_BROWSER_TESTED` | `remove-reaction-ui`; real overlay removal plus scroll restoration and rollback. |
| `RESTORE_SCROLL` | `EXECUTABLE_AND_BROWSER_TESTED` | `restore-scroll`; real scroll repair and rollback. |
| `RESTORE_POINTER_INTERACTION` | `CAPABILITY_GAP` | Trusted executor exists; no browser holdout row. |
| `ACTIVATE_PACKAGED_SCRIPTLET` | `CAPABILITY_GAP` | No reliable production rollback proof. |
| `DISABLE_PACKAGED_SCRIPTLET` | `CAPABILITY_GAP` | No reliable production rollback proof. |
| `QUARANTINE_NAVIGATION_TARGET` | `CAPABILITY_GAP` | No safe reversible browser quarantine primitive. |
| `CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET` | `CAPABILITY_GAP` | Executor exists; final browser holdout did not prove it. |
| `SUPPRESS_MATCHED_WINDOW_OPEN_BEHAVIOR` | `CAPABILITY_GAP` | Unsafe page API interception would be required. |
| `STOP_MATCHED_REDIRECT_CHAIN` | `CAPABILITY_GAP` | Executor exists; no browser holdout row. |
| `PLAYER_HEALTH_RECOVERY` | `CAPABILITY_GAP` | Trusted executor exists; no browser holdout row. |

The final coverage is 2/16 = 0.125. This is deliberately not presented as
full capability coverage.
