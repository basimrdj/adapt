# Phase 3.5B Architecture

## Production path

```text
page sensor / webRequest / webNavigation
  -> authenticated causal event graph
  -> hypothesis lattice
  -> SAEI primitive proposal
  -> policy validator
  -> executor feasibility check
  -> real reversible browser transaction
  -> health snapshot
  -> commit or rollback
  -> belief update
  -> draft recipe / bounded next experiment
```

`CausalOrchestrator` owns the control loop. `PrimitiveRegistry` remains the
descriptive and policy surface; `PrimitiveExecutorRegistry` is the trusted
execution surface. SAEI never receives raw selectors or raw URLs. Page nodes
carry opaque element references, request references, navigation references, and
coarse feature values only.

## Execution boundaries

- Background network actions use tab-scoped session DNR rules.
- DOM actions run through the existing content-script `DomActionExecutor`.
- Navigation actions resolve only through the background-owned ephemeral target
  registry.
- Main-world scriptlet operations remain explicitly unsupported where rollback
  cannot be proven.
- Health is requested from the real content sensor after staging; evaluator
  truth is not passed into production runtime state.

## Persistence

- `chrome.storage.session` stores causal graphs, active autonomy loops, pending
  primitive transactions, budgets, and capability gaps.
- `chrome.storage.local` stores long-lived causal recipes only.
- Raw page content and raw URLs are not included in causal state, recipes,
  telemetry, or AI input.

## Safety rule

Any primitive without an executor, an opaque target, a reliable rollback, or
required evidence is recorded as a capability gap or policy abstention. It is
never counted as a successful intervention.
