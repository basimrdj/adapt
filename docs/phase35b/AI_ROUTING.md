# AI Routing

## Current production state

The existing Phase 2 planner/oracle contracts remain bounded and security
validated, but no safe production planner is wired into SAEI. The final live
artifact therefore reports `aiCalls: 0` and `plannerConfigured: false`.

This is an explicit gap, not a fabricated success path.

## Required future routing

When a safe planner is connected, routing must remain:

1. known recipe: zero AI calls;
2. deterministic causal candidate: zero AI calls;
3. clear safe SAEI experiment: zero AI calls;
4. only ambiguous comparable hypotheses: at most one bounded advisory call.

The planner may receive opaque references, event categories, coarse health
features, hypothesis IDs/classes, primitive IDs, and risk metadata. It may only
return ranked hypothesis IDs, ranked primitive IDs, confidence, or abstain.
Policy validation and executor feasibility remain authoritative.

No AI output may execute a browser action, create a raw DNR rule, emit a raw
selector, or access URLs, page text, cookies, headers, form values, or
authorization data.
