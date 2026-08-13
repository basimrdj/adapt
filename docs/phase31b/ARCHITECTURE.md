# Phase 3.1B Architecture

## Plane A: native network fast path

The existing Phase 3.1 v6 pipeline remains responsible for DNR conversion,
sharding, static quota accounting, optional capacity-aware enablement, and
redirect-resource validation. The baseline ruleset and causal DNR transaction
engine are preserved.

## Plane B: compiled page filtering

`src/page/filtering/compiler.ts` parses a bounded subset of maintained cosmetic
and scriptlet syntax into a typed bundle. The build writes:

- `dist/phase31-page-cosmetic.css` for generic plain CSS at document start;
- `dist/page-filtering/index.json` for domain-specific, exception, procedural,
  and audited scriptlet descriptors;
- `dist/phase31/BUILD-MANIFEST.json` for source hashes, counts, versions, and
  artifact provenance.

`PageFilteringRuntime` is event-driven, frame-local, service-worker independent,
and re-applies on SPA history changes and bounded mutation batches. It limits
candidate traversal, degrades under mutation storms, and catches hostile DOM
errors.

Supported procedural primitives are `:has-text`, `:matches-css`, `:remove`, and
`:remove-attr`. Unsafe or unimplemented primitives are recorded instead of
silently treated as ordinary selectors.

## Plane C: causal anti-adblock response

The verified Phase 3 causal graph, epoch scoping, health measurement,
transaction rollback, belief updates, and recipe promotion remain intact. The
new page plane only adds deterministic observations/interventions; it does not
replace the causal engine or grant AI direct page authority.

## Plane D: bounded AI

Known filter matches do not call AI. Novel behavior continues through the
existing opaque evidence, deterministic candidate, policy validation,
reversible experiment, health measurement, and recipe promotion path.

## Main-world boundary

The only new MAIN-world primitive is `set-constant` for a single validated
top-level property name and a small typed value set. Prototype paths, arbitrary
source, eval, Function constructors, remote code, and AI-provided scriptlets
are rejected.
