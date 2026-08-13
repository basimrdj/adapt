# Phase 3.1B Security Review

## Reviewed controls

- No AI-generated JavaScript or selectors enter the page runtime.
- No `eval` or `new Function` is permitted in production bundles by the
  integrity gate.
- Scriptlet names, worlds, arguments, and domain scopes are typed build data.
- Unsupported scriptlets are recorded and never executed.
- MAIN-world execution is limited to `set-constant` with a top-level property
  and a small value allowlist.
- Generic and domain CSS is selector-validated and bounded.
- The page observer catches DOM, geometry, and computed-style faults.
- Manifest WAR exposure is bounded and dynamic when redirect resources exist.
- Build provenance includes source version metadata and SHA-256 hashes.
- The existing production bundle test continues to reject Azure endpoints,
  development markers, and secret names.

## Supply-chain findings

The current AdGuard build dependencies are GPL-3.0-only according to installed
package metadata. This is documented in `LICENSE_REVIEW.md` and remains a
release blocker until the build path is relicensed, replaced, or explicitly
accepted under compatible distribution terms.

## Remaining risks

Filter text is external input and must continue to be fetched with identity,
format, cache, and hash validation. A future compact page index must preserve
the same exception semantics. Security review is not complete for any new
MAIN-world scriptlet beyond the current `set-constant` implementation.
