# ADR-006: Adaptation Transactions & State Machine

## Context
Automated adaptation must be deterministic, isolated to the specific tab experiencing issues, verifiable against objective health criteria, and completely reversible upon failure or navigation change.

## Decision
1. **Transaction Lifecycle**:
   - `IDLE` → `CANDIDATE_CREATED` → `STAGED` → `OBSERVING` → `VERIFIED_SUCCESS` (`COMMITTING` → `COMMITTED`) OR `VERIFIED_FAILURE`/`TIMEOUT` (`ROLLING_BACK` → `ROLLED_BACK`).
2. **Isolation & Scoping**: Experimental network rules are applied via `chrome.declarativeNetRequest.updateSessionRules` with `condition.tabIds: [tabId]`. Experimental DOM actions are injected into the specific document frame.
3. **Health Verification Criteria**:
   - Success requires: $\Delta \text{reaction} < -0.40$ (significant drop in detector symptoms) AND $\Delta \text{contentAvailability} \ge 0.00$ (no content regression) AND $\text{interaction} \ge 0.70$.
4. **Promotion**: Successful transactions are promoted into persistent `SiteRecipe` objects stored in `RecipeStore`.

## Consequences
- **Positive**: Zero cross-tab pollution, instant rollback on failure, persistent memory of verified fixes.
- **Negative**: Adds state machine complexity in background worker.
