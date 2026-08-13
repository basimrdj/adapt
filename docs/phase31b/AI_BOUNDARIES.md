# Phase 3.1B AI Boundaries

## Deterministic path

Known network, cosmetic, procedural, and supported scriptlet rules are compiled
before page load. A normal visit therefore requires zero AI calls and zero
exploratory experiments.

## Novel path

The existing Phase 3 path remains:

1. normalize scoped events;
2. build an opaque evidence packet;
3. generate bounded hypotheses;
4. optionally rank with an advisory planner;
5. validate through `PolicyValidator`;
6. run the smallest reversible experiment;
7. measure health and update belief;
8. promote only a successful, scoped intervention to a recipe.

AI is not allowed to emit executable JavaScript, raw selectors, arbitrary DNR,
or browser commands. The new page plane accepts only compiled filter data and
typed scriptlet descriptors from the build pipeline.

## Provider failure

Provider failure, malformed output, prompt injection, or stale evidence must
fall back to deterministic blocking or abstention. Baseline blocking never
depends on an AI provider being reachable.
