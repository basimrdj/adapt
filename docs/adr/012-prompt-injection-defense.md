# ADR-012: Prompt Injection Defense Architecture

## Context
Adversarial websites may embed prompt injection payloads into overlay text, element attributes, or invisible DOM nodes to force content blockers to disable filtering.

## Decision
1. Explicitly designate all page-supplied text as untrusted data in the planner system prompt.
2. Forbid the model from emitting free-form JavaScript, CSS selectors, regex patterns, or network URLs.
3. Constrain model output to predefined action DSL enum types and opaque element references.
4. Enforce strict validation in `PolicyValidator` before staging any action into the transaction engine.

## Consequences
- **Positive**: Attacker success rate is mathematically bounded to 0% for arbitrary code/selector execution.
- **Negative**: Prompt engineering must remain concise to stay within latency and token budgets.
