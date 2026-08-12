# ADR-008: AI Provider Abstraction

## Context
ADAPT requires an adaptive intelligence layer to reason about unknown anti-adblock mechanisms. However, the core extension engine must remain independent of any single model provider (Azure, OpenAI, Anthropic, local model) and operate entirely offline during standard CI.

## Decision
1. Define a generic, model-independent `AdaptivePlanner` interface (`src/shared/ai/planner-interface.ts`).
2. Provide a deterministic `MockPlanner` implementation for offline tests and CI.
3. Provide an `AzurePlanner` implementation residing in the development oracle toolchain (`tools/ai-oracle/`).
4. Prevent any direct coupling between the core `AdaptationTransactionEngine` and external SDKs.

## Consequences
- **Positive**: Clean separation of concerns; offline testability; pluggable backend support without refactoring core engine.
- **Negative**: Requires maintaining mock fixtures alongside provider implementations.
