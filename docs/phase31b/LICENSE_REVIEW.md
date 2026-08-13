# Phase 3.1B License Review

Status: distribution review required before a proprietary release.

ADAPT has no `LICENSE` file in the repository. That means the project’s own
distribution rights are not explicitly documented and must be resolved by the
owner before publication.

| Dependency or data | Observed license | Use in this branch | Distribution consequence |
|---|---|---|---|
| `@adguard/tswebextension` 5.0.0 | GPL-3.0-only in installed package metadata | Existing build-time CLI dependency; not imported by the new page runtime | Do not ship its runtime or generated GPL scriptlet code in a proprietary extension without permission or GPL-compatible distribution. |
| `@adguard/tsurlfilter` 5.0.1 | GPL-3.0-only in installed package metadata | Transitive/build/reference dependency | Do not copy its parser, matcher, or content runtime into ADAPT. |
| `@adguard/dnr-rulesets` 4.2.x | GPL-3.0-only in installed package metadata | Existing maintained DNR build path | Treat the current build toolchain as a licensing review item; the generated JSON must not be assumed to clear the upstream code license. |
| AdGuard filter text IDs 2, 3, 17, 19, 21, 208 | Source-specific headers and registry terms | Data input; source version and SHA-256 are recorded | Retain source headers, provenance, and any attribution required by each list. Do not collapse all list terms into one license. |
| EasyList/EasyPrivacy | Not bundled by this branch | Research/benchmark reference only | No distribution consequence until explicitly added and reviewed. |
| uBlock Origin Lite source | GPL-3.0 | Architecture/reference only | No source copied or linked into ADAPT. |
| New ADAPT page compiler/runtime | ADAPT-authored; project license unresolved | New implementation | Owner must choose and document the project license. |

## Copyleft boundary

The page compiler, page runtime, isolated scriptlets, early plane, MAIN-world
bridge, tests, and documentation in this branch are independently implemented.
No uBO/uBOL or AdGuard runtime source was copied. The current DNR build still
invokes the existing AdGuard converter/tooling path, so this branch is not yet
a legal clearance for a proprietary distributed artifact. Adding the audited
primitives does not change that blocker.

## Required owner decision

Before release, choose one of:

1. Obtain compatible commercial/dual-license permission for the required
   AdGuard build/runtime pieces and record it here.
2. Replace the GPL build-time converter and redirect-resource generation with an
   independently licensed implementation and separately review every filter
   data source.
3. Distribute ADAPT under GPL-compatible terms with complete corresponding
   source and attribution.

Until that decision is recorded, the merge recommendation is **NO** for a
proprietary release. This is a licensing blocker, not a TypeScript or test
failure.
