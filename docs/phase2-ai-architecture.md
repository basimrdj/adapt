# ADAPT Phase 2 — AI Architecture

## 1. Core Design Principle
The AI intelligence layer is an **advisory planner**, not an authoritative enforcement engine.
The model never directly executes browser operations, generates arbitrary selectors/code, or overrides Phase 1 safety invariants.

```
UNKNOWN / FAILED REACTION
          │
          ▼
   EvidencePacket (Opaque References)
          │
          ▼
   Adaptive AI Planner (Low Reasoning Effort, Structured Output)
          │
          ▼
   Strict Structured AdaptationPlan
          │
          ▼
   PolicyValidator (Reference Validation & Whitelist Mapping)
          │
          ▼
   Phase 1 Transactional Engine (Session DNR / Sandboxed DOM Actions)
          │
          ▼
   Health Vector Verification
          │
    ┌─────┴─────┐
    ▼           ▼
[Success]    [Failure]
    │           │
Commit      Deterministic Rollback
Recipe
```

## 2. Model-Independent Abstraction
The core architecture interacts solely with the `AdaptivePlanner` interface:
- `MockPlanner`: Deterministic local mock used for offline CI and reproducible testing.
- `AzurePlanner`: Connects via development oracle to Azure OpenAI `buzz-gpt-5-4-mini`.

## 3. Decision Cascade
1. **Level 0 (Known Recipe)**: Deterministic recipe replay ($0\text{ ms}$ AI overhead).
2. **Level 1 (Deterministic Heuristic)**: Phase 1 candidate generator ($0\text{ ms}$ AI overhead).
3. **Level 2 (Novel / Ambiguous Reaction)**: AI planner invoked with compact `EvidencePacket`.
4. **Level 3 (Second Attempt on Failure)**: At most 1 subsequent AI plan if page integrity is preserved.
5. **Level 4 (Unresolved)**: Clean `ABSTAIN`. Hard limit of max 2 AI calls per transaction.
