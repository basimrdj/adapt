# ADR-015: Model Configuration & Parameter Selection

## Context
Configuring LLM inference for content blocking requires balancing output correctness, reasoning depth, latency, and token cost.

## Decision
1. **Target Deployment**: `<your-model-deployment>` (GPT-5.4 mini) hosted on Azure OpenAI.
2. **Reasoning Effort**: Set to `low` by default. Empirical testing proved that `low` reasoning achieves 100% schema and strategy accuracy with $1.6\text{s} - 3.1\text{s}$ latency and minimal token consumption, whereas `high` reasoning consumes disproportionate tokens without improving structured plan accuracy.
3. **Completion Token Budget**: Capped at $600$ tokens maximum.
4. **Stateless Operations**: Enforce `store: false` or stateless calls to prevent server-side data retention.

## Consequences
- **Positive**: High speed, low token costs, no session state pollution.
- **Negative**: Long-form explanations are constrained (which aligns with our structured plan DSL).
