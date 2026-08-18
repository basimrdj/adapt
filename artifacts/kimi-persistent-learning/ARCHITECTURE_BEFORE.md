# ARCHITECTURE BEFORE — Persistent Personal Learning Pass (baseline map)

Snapshot of the learned-protection architecture as it existed before this pass
(branch state at the start of the pass; commit 0f433a8 + working-tree Phase 2
AI-wiring changes). This is the "before" picture against which every Phase A/B/C
change was made.

## 1. Learned-rule lifecycle (before)

```
survivor observed → AI gate (maybeRunSurvivorAi) → PolicyValidator →
executor stages TARGETED_SESSION_DNR → chrome.session DNR rule
→ outcome verifier → healthy | rolled-back
→ (nothing else — end of lifecycle)
```

- The ONLY persistence mechanism was `chrome.declarativeNetRequest` session rules.
- `DnrController.persistLearnedRules()` (dynamic-rule persistence) existed in the
  codebase but had **zero production callers** from the survivor/AI path. Learned
  protections were never promoted to durable rules.
- No ownership metadata existed for learned rules. Chrome held the rules; ADAPT
  held nothing.

## 2. Startup reconcile (before)

- On every service-worker start, `DnrReconciler` compared in-memory allocator
  allocations (empty after a restart) against Chrome's session ruleset.
- Any in-band learned session rule looked UNKNOWN → **deleted on sight**.
- Net effect: every service-worker restart (routine in MV3 — idle suspend,
  update, crash) silently wiped all learned protections. Full browser restarts
  wiped them too (session rules are in-memory by Chrome semantics).

## 3. AI discovery gate (before)

- `auditedOrigins: Set<originHash>` — worker-lifetime latch. Once an origin had
  been audited, it could never be audited again **until the worker died**.
- The latch DID reset on worker restart — so after every restart the same origin
  would re-audit and burn another AI call, even for request families ADAPT had
  already learned (there was no "known family" concept to check against).
- Budget: ≤ 2 survivor-AI calls per document graph (`survivorAiCalls` per
  graphId). Trigger: survivors present, or ≥ 2 third-party REQUEST_COMPLETE
  nodes (post-escape evidence only — the AI can never see what the static plane
  already blocked).

## 4. External-benchmark ceiling (the 354/128 symptom)

- The external one-run test navigates each site once, in a fresh profile.
- With learning never surviving restarts and promotion never existing, every
  navigation scored exactly the static ruleset plane (~354 blocked) plus at most
  one narrow session rule — which could only affect requests made *after* the
  AI's post-escape observation window, and only at one exact path.
- First-view (pre-request) checks are structurally unreachable for a system
  whose only evidence is REQUEST_COMPLETE nodes and whose learned rules die with
  the worker.

## 5. Supporting planes (unchanged by this pass)

- ~178k-rule static DNR plane (declared rulesets) — untouched.
- Page filtering plane, survivor discovery, RemotePlanner wiring, Options page,
  PolicyValidator, popup broker — untouched except where explicitly listed in
  the final report.

## 6. Credential handling (before → unchanged constraint)

- Azure OpenAI planner config lived in `chrome.storage.local` via the Options
  page, or in the gitignored dev-defaults generated file. Never committed,
  never logged, never written to artifacts. This pass preserved that invariant
  and the STRICT privacy mode (opaque refs only to the remote model).
