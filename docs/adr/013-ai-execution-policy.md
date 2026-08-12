# ADR-013: AI Execution Policy & Decision Cascade

## Context
Calling an LLM for every page load or trivial detection introduces excessive latency, cost, and availability risk.

## Decision
1. Implement a 5-level decision cascade:
   - **Level 0**: Deterministic SiteRecipe replay ($0\text{ ms}$ AI overhead).
   - **Level 1**: Deterministic strategy candidate generator ($0\text{ ms}$ AI overhead).
   - **Level 2**: First AI planning attempt on unknown/ambiguous reactions.
   - **Level 3**: Second AI planning attempt if the first experiment failed but page remains safe.
   - **Level 4**: Fail-closed ABSTAIN.
2. Enforce a hard ceiling of at most 2 AI planner calls per adaptation transaction.

## Consequences
- **Positive**: Zero latency overhead for known sites; minimal token expenditure; bounded loop risk.
- **Negative**: Extremely complex multi-stage edge cases terminate in abstention after 2 attempts.
