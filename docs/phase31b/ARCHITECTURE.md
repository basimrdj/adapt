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

The page compiler is the sole cosmetic owner (`cosmeticOwners: 1` and
`cosmeticOwner: phase31b-page-plane`). The Phase 3.1 v6 pipeline is network-only;
it does not parse or emit generic cosmetic CSS.

`PageFilteringRuntime` is event-driven, frame-local, service-worker independent,
and re-applies on SPA history changes and bounded mutation batches. It limits
candidate traversal, degrades under mutation storms, and catches hostile DOM
errors.

The generated page plane is indexed rather than loaded as one monolithic file:

- `page-filtering/index.json` is a 412-byte startup index;
- `generic.json` contains the compact generic base;
- `domain-index.json` maps hostnames to 339 domain shards;
- `domains/` contains hostname-targeted page rules and exception indexes;
- `early-manifest.json` and `early/` contain 337 document-start early shards.

The runtime loads the generic artifact and only the domain shards selected by
the hostname index. Mutation lookup uses the compiled candidate maps rather
than scanning all rules against all exceptions.

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

The audited MAIN-world registry includes `set-constant`,
`abort-current-inline-script`, `abort-on-property-read`,
`abort-on-property-write`, `prevent-fetch`, `prevent-xhr`,
`prevent-setTimeout`, `prevent-eval-if`, `prevent-window-open`, and
`json-prune`. Each descriptor is validated for name, argument grammar,
property path, execution world, domain scope, and exception compatibility before
it contributes to supported coverage.

`set-constant` supports only bounded nested paths and a typed value grammar.
`__proto__`, `prototype`, `constructor`, dangerous native roots, arbitrary
source, eval, Function constructors, remote code, and AI-provided scriptlets
are rejected. The early plane is immutable, generated at build time, and
registered at document start through hostname-filtered `include_globs` so the
manifest does not require parsing the 14 MB page index before startup.
