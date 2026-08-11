# ADAPT — Phase 1 Research, Engineering Specification, and Coding-Agent Build Prompt

> **Project:** Adaptive Chromium ad/privacy blocker  
> **Phase:** 1 — deterministic adaptive foundation  
> **Research snapshot:** 2026-08-12  
> **Target:** Chromium / Manifest V3 first  
> **Status:** Engineering plan; agent must re-verify all time-sensitive API, dependency, policy, and licensing facts before implementation.

---

## 0. Executive decision

The best Phase 1 is **not** “put an LLM in an ad blocker.”

The best Phase 1 is a fast, deterministic Chromium MV3 blocker that can:

1. block known ads and trackers using native Chromium Declarative Net Request (DNR);
2. observe requests and page state without keeping a permanent background process alive;
3. detect likely anti-adblock reactions and functional breakage;
4. stage a **temporary, tab-scoped alternative strategy**;
5. verify whether the page improved;
6. roll the experiment back if it did not;
7. promote a successful strategy into a persistent site recipe;
8. replay that recipe instantly on later visits;
9. preserve a clean, typed interface where Phase 2 AI can later choose among **predefined safe actions** rather than writing arbitrary code.

The core closed loop is:

```text
LOAD
  │
  ├─► deterministic static blocking
  │
  ├─► observe network + DOM + navigation
  │
  └─► page-health evaluation
          │
          ├─ healthy ──────────────► continue
          │
          └─ suspicious/broken
                    │
                    ▼
             choose candidate
                    │
                    ▼
        stage TAB-SCOPED experiment
                    │
                    ▼
              verify outcome
               /          \
            worse          better
             │                │
          rollback          commit
                              │
                              ▼
                       save site recipe
```

That is the Phase 1 innovation.

### One important reality check

The engineering target should be **adaptive resistance to anti-adblock detection**, not a promise of mathematical invisibility.

A page controls its own JavaScript, markup, timing measurements, server responses, and application logic. A sufficiently adversarial publisher can create a novel challenge or infer environmental differences. No extension can guarantee that every future detector will be unable to distinguish an altered page from an unaltered one.

What we *can* build is stronger in practice:

> **Unknown detector → observe → diagnose → try a reversible strategy → verify → remember.**

That is a concrete, testable engineering objective.

---

# 1. Scope of Phase 1

## 1.1 Phase 1 MUST include

### Network plane
- Chromium Manifest V3.
- Static DNR rulesets.
- Dynamic DNR rules for persisted learned rules.
- Session DNR rules for temporary adaptation experiments.
- `webRequest` observation for request telemetry where Chromium exposes it.
- Rule-ID, priority, ownership, and lifecycle management.
- Reliable reconciliation after service-worker restart.

### Page plane
- An **ISOLATED-world** content sensor at `document_start`.
- Frame-aware page telemetry.
- Mutation observation with strict performance controls.
- SPA/navigation lifecycle handling.
- Detection of high-confidence anti-adblock UI/state changes.
- Page-health scoring.
- Reversible DOM actions.
- Minimal, packaged MAIN-world operations only where a strategy genuinely requires page-runtime interaction.

### Adaptive plane
- Typed strategy/action DSL.
- Transactional experiment lifecycle:
  - stage;
  - evaluate;
  - commit;
  - rollback.
- Site recipe persistence.
- Recipe validity/versioning.
- Local audit log explaining what happened.
- Safety/privacy policy that prevents the adaptation engine from silently trading away user privacy to satisfy a detector.

### Engineering plane
- Synthetic anti-adblock test laboratory.
- Unit tests.
- Browser integration/E2E tests.
- Performance benchmarks.
- Security review.
- Chrome Web Store policy review.
- Dependency and license review.
- Architecture Decision Records (ADRs).
- Research ledger recording every API/dependency assumption and its evidence.

---

## 1.2 Phase 1 MUST NOT include

Do **not** inflate Phase 1 with attractive but unnecessary features.

Specifically exclude:

- general-purpose LLM inference;
- cloud AI;
- screenshot/vision classification;
- automatic arbitrary JavaScript generation;
- a native desktop daemon;
- a local MITM HTTPS proxy;
- system-wide blocking;
- Firefox/Safari support;
- mobile support;
- a giant React settings dashboard;
- accounts, sync, telemetry server, or community recipe cloud;
- autonomous live-site differential browsing that deliberately disables privacy protection and leaks tracking traffic;
- mechanisms intended to bypass paywalls, authentication, DRM, subscription gates, or non-advertising access controls.

Phase 1 should create the **machine that can safely adapt**. Phase 2 can make its decision-maker intelligent.

---

# 2. The most important research findings

## 2.1 Chromium MV3 means DNR must be the hot-path network blocker

For ordinary Manifest V3 extensions, `webRequest` is useful for **observation**, but ordinary store-installed MV3 extensions do not have the old synchronous `webRequestBlocking` power available to policy-installed extensions.

Therefore:

```text
WRONG ARCHITECTURE
request
  ↓
webRequest
  ↓
WASM/LLM decides synchronously
  ↓
block

RIGHT MV3 ARCHITECTURE
request
  ↓
Chromium DNR engine
  ↓
block/allow/redirect immediately

webRequest observation
  ↓
our analysis
  ↓
install/update DNR rule for future matching traffic
```

Chrome's own content-filtering guidance explicitly describes combining `webRequest` observation with dynamically generated DNR rules.

### Consequence

**Brave `adblock-rust` should not be the primary Phase 1 request-blocking engine inside the extension.**

`adblock-rust` is an excellent native/WASM filtering library and is worth studying, but a WASM matcher living inside an extension cannot replace DNR as the synchronous Chromium MV3 enforcement primitive.

Keep an abstraction that could later use `adblock-rust` for:
- offline parsing;
- classification;
- filter syntax tooling;
- recipe simulation;
- a future native companion.

Do not place it in the request hot path in Phase 1.

---

## 2.2 DNR has enough capacity, but quotas must influence the design

Current Chrome documentation reports:

- up to **100 static rulesets** declared;
- up to **50 static rulesets enabled**;
- a guaranteed minimum of **30,000 static rules**;
- up to **30,000 safe dynamic rules**;
- up to **5,000 unsafe dynamic rules**;
- up to **5,000 session rules**;
- up to **1,000 regex rules per relevant ruleset type**;
- each compiled regex must fit Chromium's complexity/size constraint.

DNR “safe” actions include:
- `block`;
- `allow`;
- `allowAllRequests`;
- `upgradeScheme`.

Actions such as redirects and header modification consume the smaller unsafe-rule budget.

### Design implication

Use quotas like an operating budget:

| Rule class | Purpose | Prefer |
|---|---|---|
| Static | known global baseline | lots of cheap block rules |
| Dynamic safe | persisted learned network decisions | block/allow only when justified |
| Dynamic unsafe | persisted redirects/header adaptations | rare |
| Session safe | live experiment candidates | preferred experiment layer |
| Session unsafe | temporary redirect/header experiment | rare and aggressively cleaned |
| DOM recipe | page presentation/compatibility | use when network quota is unnecessary |

Do **not** turn every adaptive observation into a dynamic DNR rule.

---

## 2.3 Session rules are our experimental transaction layer

This is one of the strongest Phase 1 architectural choices.

DNR session rules:
- can be added/removed at runtime;
- are separate from the persistent dynamic set;
- are cleared when appropriate browser/extension lifecycle boundaries occur;
- support tab scoping through rule conditions where applicable;
- can be updated atomically.

Use them to implement:

```text
candidate strategy
      ↓
compile temporary rule(s)
      ↓
scope to current tab/site
      ↓
apply
      ↓
measure
      ↓
success? ─ yes ─► translate/promote to persistent recipe
   │
   no
   ▼
remove temporary rules
```

This makes adaptation **transactional**, not destructive.

---

## 2.4 The service worker is an event coordinator, not a permanent brain

Chrome can terminate an extension service worker after roughly 30 seconds of inactivity and imposes other lifetime limits.

Therefore:

**Never rely on module/global memory for correctness.**

Persist anything required to reconstruct state:
- installed recipe metadata;
- rule allocations;
- experiment state;
- schema versions;
- configuration;
- health history that matters across restarts.

Service-worker listeners must be registered synchronously at module startup.

The architecture must survive this at any line:

```text
service worker dies here
```

and reconstruct itself correctly on the next event.

---

## 2.5 Offscreen documents are not the Phase 1 orchestrator

An offscreen document can provide hidden DOM capabilities when needed, but Chrome restricts its extension API access primarily to `chrome.runtime`, and only a small number of offscreen documents are allowed.

Phase 1 does not need an offscreen document.

Add one later only for a concrete requirement such as:
- model runtime requiring document APIs;
- canvas/image processing;
- audio;
- DOM parsing unavailable in the worker.

Do not use offscreen as a keepalive hack.

---

## 2.6 ISOLATED world should be the default page execution environment

An ISOLATED-world content script has its own JavaScript environment. The page does not get direct access to the extension's variables/functions.

However, both worlds share the **DOM**. Any DOM mutation can still be observed by a sufficiently motivated page.

Therefore the realistic objective is:

> minimize unique fingerprints and invasive mutations, not pretend DOM modifications are invisible.

Use MAIN-world execution only for small, prepackaged compatibility operations.

---

## 2.7 Web-accessible resources are an extension fingerprinting surface

Chrome explicitly notes that web-accessible resources can allow malicious sites to fingerprint installed extensions.

Phase 1 policy:

- **zero web-accessible resources by default**;
- add a resource only when a feature cannot work without it;
- constrain origin matching;
- use `use_dynamic_url: true` where applicable;
- document exactly why the exposure exists;
- test whether DNR redirect behavior still works with the selected dynamic-resource design.

A DNR redirect to an extension-owned resource requires that resource to be web accessible, so redirects must be treated as a deliberate exception, not the default anti-detection solution.

---

## 2.8 Remote code is incompatible with the product architecture

Chrome Web Store MV3 policy requires executable extension logic to be packaged with the extension. Remote data/configuration is allowed, but using remotely fetched data as an interpreter for complex executable commands can itself violate policy.

Therefore the adaptation engine must use a **closed, packaged action vocabulary**.

Good:

```json
{
  "action": "RESTORE_SCROLL",
  "scope": "top-frame"
}
```

Bad:

```json
{
  "javascript": "fetch(...); patchWhatever(...);"
}
```

Also bad:

```json
{
  "command": "arbitrary remotely-designed mini-program"
}
```

Phase 2 AI can return parameters for known, audited operations; it should not become a remote-code delivery mechanism.

---

# 3. Existing projects: what to reuse, what to study, what not to couple ourselves to

## 3.1 uBlock Origin Lite — best architectural reference for MV3 efficiency

uBO Lite is an MV3 content blocker designed around declarative filtering. It deliberately relies on Chromium handling filtering rather than maintaining a permanent process.

### Learn from it
- DNR-native mindset.
- Static ruleset generation.
- Reliability when service worker is asleep.
- Declarative cosmetic/scriptlet strategy.
- Ruleset partitioning.
- Browser-managed filtering as much as possible.

### Do not blindly copy
uBOL is GPL-3.0. Study architecture and behavior, but do not copy implementation into a differently licensed codebase without an explicit license decision.

uBOL is also deliberately “Lite”; our adaptive transaction engine is a different goal.

---

## 3.2 AdGuard Browser Extension — best production reference for a sophisticated MV3 pipeline

AdGuard's current browser extension is an important implementation reference because it demonstrates a real MV3 blocker with:
- DNR;
- content filtering;
- scripting;
- request observation;
- automated ruleset refresh builds;
- separate handling of script/filter updates;
- Chromium MV3 support.

Their `@adguard/dnr-rulesets` package publishes prebuilt rulesets and is operationally attractive.

### Critical constraint
The extension and the DNR ruleset package are GPL-3.0-family licensed.

If our project is intended to be GPL, that may be completely acceptable.

If we want future proprietary/commercial licensing flexibility, do not quietly make this dependency foundational. Have the agent perform a real licensing review before adoption.

---

## 3.3 eyeo WebExt Ad-Filtering Solution — mature “buy instead of build” option

eyeo offers a WebExtension filtering SDK with:
- MV3 support;
- DNR generation;
- isolated and MAIN-world components;
- snippets;
- filtering APIs;
- tests;
- optional model support.

It proves how much complexity already exists in a production-quality filtering core.

### Why it is not automatically our default
- licensing/product implications need explicit review;
- it introduces a large preexisting policy/model into our architecture;
- our Phase 1 innovation is the adaptive transaction engine, and we want control over its core abstractions.

### Required agent spike
Before implementing a home-grown production filter compiler, the coding agent must compare:

1. direct DNR + our own orchestration;
2. eyeo SDK;
3. AdGuard's DNR ruleset pipeline;
4. uBOL's build/pipeline concepts.

Do not decide based on vibes. Record:
- current license;
- latest maintained version;
- rule syntax coverage;
- bundle size;
- startup behavior;
- DNR footprint;
- CWS implications;
- API ergonomics;
- performance;
- ability to support our session-rule transaction design.

---

## 3.4 Brave `adblock-rust` — excellent library, wrong primary Phase 1 enforcement location

Features include:
- network filtering;
- cosmetic filtering;
- resource replacements;
- hosts syntax;
- uBO syntax extensions;
- WASM/native builds;
- MPL-2.0.

This is attractive for later:
- offline filter parsing;
- native companion;
- rule simulation;
- classifier features;
- non-Chromium environments.

But Phase 1 network enforcement must remain DNR-native.

---

## 3.5 Filter list licensing is a first-class engineering concern

EasyList's official license page states that repository contents are generally dual licensed under:
- GPL v3-or-later; or
- CC BY-SA 3.0-or-later,

unless otherwise noted.

Referenced external subscriptions may have other terms.

Therefore:
- do not bundle random lists because “every blocker uses them”;
- pin every list source and license;
- record required attribution;
- store provenance in build metadata;
- distinguish **source-code license** from **filter-data license**.

The agent must create `docs/filter-list-licenses.md` before a production list is bundled.

---

# 4. Recommended Phase 1 technical stack

## 4.1 Core recommendation

```text
Manifest V3
TypeScript (strict)
WXT as build/scaffolding layer — after a short validation spike
Chromium DNR
webRequest observation
webNavigation
chrome.storage + IndexedDB where justified
Vanilla/minimal UI
Puppeteer E2E
Vitest/unit tests (verify latest compatible version before pinning)
ESLint + Prettier or equivalent
No React in Phase 1
No AI runtime in Phase 1
```

## 4.2 Why no React

The blocker hot path has no need for React.

A popup with:
- protection on/off;
- current-site status;
- blocked/adaptation counts;
- diagnostics button;

does not justify shipping a UI framework during foundational development.

Use a tiny DOM UI first.

If Phase 3 becomes a rich observability dashboard, add a UI framework then.

---

# 4.3 WXT: recommended, but not sacred

WXT is MIT-licensed, actively maintained, TypeScript-first, MV3-capable, and generates manifests/build output.

That gives us:
- simpler extension entrypoints;
- dev reload;
- build ergonomics;
- typed config;
- less hand-written boilerplate.

### Mandatory validation spike

Before committing:
1. scaffold a WXT MV3 extension;
2. verify exact generated manifest;
3. verify a `document_start` all-frame sensor;
4. verify service-worker listener registration occurs synchronously enough for our needs;
5. verify static DNR resources land exactly as expected;
6. verify Puppeteer can load the unpacked output;
7. inspect final bundle for unexpected web-accessible resources, remote-code references, source maps, or framework runtime.

If WXT obstructs DNR build control or startup semantics, fall back to a small Vite/esbuild + explicit manifest pipeline.

**Architecture must not depend on WXT.** WXT is a build tool, not a domain layer.

---

# 5. Manifest and permission design

## 5.1 Proposed initial manifest capabilities

Target only normal web origins:

```text
http://*/*
https://*/*
```

Do not pretend we can filter:
- `chrome://`;
- Chrome Web Store protected pages;
- other privileged browser surfaces where extension access is restricted.

### Candidate permissions

```jsonc
{
  "permissions": [
    "declarativeNetRequestWithHostAccess",
    "scripting",
    "storage",
    "webRequest",
    "webNavigation",
    "unlimitedStorage"
  ],
  "host_permissions": [
    "http://*/*",
    "https://*/*"
  ]
}
```

### Development-only candidate

```text
declarativeNetRequestFeedback
```

Do not assume production observability can rely on `onRuleMatchedDebug`; Chromium exposes that primarily for unpacked/development debugging.

### Add only when needed
- `tabs`
- `activeTab`
- `offscreen`
- `userScripts`
- `cookies`
- `contextMenus`

Every permission must have:
- a feature owner;
- a documented reason;
- a test proving it is needed;
- a Chrome Web Store justification.

---

## 5.2 Minimum Chromium version

Recommended initial engineering baseline: **Chromium 128+**.

Why:
- it avoids carrying old MV3 compatibility branches;
- current DNR behavior/quotas are mature;
- Chrome 128 adds useful modern DNR behavior and quota handling;
- this is an experimental high-end blocker, not an immediate mass-market compatibility exercise.

Before public release, re-evaluate whether `121` is sufficient and whether lowering the minimum meaningfully increases user reach without adding dangerous compatibility paths.

Do not use APIs added after the chosen minimum without guards or bumping the minimum.

---

# 6. System architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│                         CHROMIUM                                 │
│                                                                  │
│  ┌─────────────────────┐       ┌─────────────────────────────┐   │
│  │ DNR enforcement     │       │ Web page / frames           │   │
│  │                     │       │                             │   │
│  │ static rules        │       │ ISOLATED sensor            │   │
│  │ dynamic rules       │       │ MAIN ops (rare)             │   │
│  │ session experiments │       │ DOM action executor         │   │
│  └──────────┬──────────┘       └──────────────┬──────────────┘   │
│             │                                  │                  │
│             └──────────────┬───────────────────┘                  │
│                            ▼                                      │
│                 ┌───────────────────────┐                         │
│                 │ Extension worker      │                         │
│                 │                       │                         │
│                 │ navigation registry   │                         │
│                 │ request observer      │                         │
│                 │ health coordinator    │                         │
│                 │ adaptation txn engine │                         │
│                 │ DNR controller        │                         │
│                 │ recipe manager        │                         │
│                 └───────────┬───────────┘                         │
│                             │                                     │
│                       persistent state                            │
│                             │                                     │
│              ┌──────────────┴──────────────┐                     │
│              │ chrome.storage / IndexedDB  │                     │
│              └─────────────────────────────┘                     │
└──────────────────────────────────────────────────────────────────┘
```

---

# 7. Domain modules

## 7.1 `DnrController`

Single owner of DNR mutation.

No other module directly calls:
- `updateDynamicRules`;
- `updateSessionRules`;
- `updateEnabledRulesets`;
- static rule toggles.

Responsibilities:
- rule allocation;
- rule validation;
- priority policy;
- atomic update;
- reconciliation;
- persistence mapping;
- quota monitoring;
- audit trail;
- garbage collection.

### Invariant

```text
DNR state in Chromium
        ==
logical rule registry after reconciliation
```

If mismatch occurs, reconcile instead of guessing.

---

## 7.2 `RequestObserver`

Uses allowed `webRequest` events for telemetry.

Responsibilities:
- coarse request graph per navigation;
- URL/domain/resource-type metadata;
- initiator context where available;
- timing/order signals;
- successful/failed request observations that Chromium exposes;
- no request body collection by default;
- no raw sensitive URL query storage unless needed for a short-lived diagnostic and redacted.

### Privacy rule

Normalize URLs aggressively:

Prefer:

```text
https://ads.example.net/path
```

over:

```text
https://ads.example.net/path?user_id=...&email=...&token=...
```

Store hostname + coarse path signature unless exact URL matching is required for a rule.

---

## 7.3 `NavigationRegistry`

Owns:
- tab/document/frame navigation identity;
- SPA transitions;
- lifecycle boundaries;
- stale-event rejection.

Use document/frame identifiers where Chromium provides them.

A recipe and health measurement must belong to a **specific navigation epoch**, not just a tab ID.

Why:

```text
tab 17:
site A → site B → SPA route C
```

is not one page.

---

## 7.4 `PageSensor`

Runs in ISOLATED world.

### At `document_start`

Do almost nothing synchronously:
- register lightweight hooks;
- identify document/frame;
- begin small mutation observer;
- post sensor-ready event.

Never perform a full DOM traversal at document start.

### Sensor inputs

Collect derived signals, not giant snapshots:

#### Geometry/state
- viewport size;
- visible fixed/sticky overlays;
- approximate overlay viewport coverage;
- `body` / `html` scroll-lock state;
- key main-content visibility;
- top-level modal count.

#### Textual
Local phrase/features associated with ad-block reactions:
- ad blocker / adblock / whitelist / advertising blocking;
- disable blocker;
- allow ads;
- turn off blocking;
- blocker detected;
- variants and normalized token patterns.

Do **not** classify on words alone.

#### Structural
- newly inserted full-screen layers;
- iframe insertion/removal;
- body/main content hidden after page settled;
- root class/style changes correlated with a suspected detector;
- repeated removal/reinsertion loops;
- open Shadow DOM observations where reachable.

#### Interaction health
- pointer-events disabled globally;
- content covered by overlay;
- scroll locked;
- media/player placeholder state when a media surface exists;
- route/navigation still responsive.

---

## 7.5 `MutationPipeline`

MutationObserver is dangerous if implemented lazily.

### Rules
- one observer per relevant frame whenever possible;
- batch mutations;
- process only changed branches;
- maintain candidate indexes;
- never repeatedly run `querySelectorAll("*")`;
- use hard work budgets;
- back off under mutation storms;
- skip extension-generated nodes/actions through internal WeakSet/WeakMap markers rather than public IDs/classes;
- do not write conspicuous attributes like `data-adapt-blocker="true"` into page DOM.

### Degradation mode

If mutations exceed threshold:

```text
NORMAL → COALESCED → SAMPLING → PAUSED/RECOVER
```

The blocker must never create more jank than the ads.

---

# 8. Anti-adblock reaction detector

Phase 1 should detect **reactions**, not attempt to reverse-engineer every detector script.

That distinction is powerful.

A detector can be obfuscated, renamed, encrypted, or dynamically generated. Its visible reaction often still has measurable consequences.

## 8.1 Signal groups

### A. Semantic signals
Examples of normalized concepts:
- disable ad blocker;
- whitelist us;
- ads support us;
- blocker detected;
- cannot continue while blocking.

### B. Gating signals
- main content hidden;
- player replaced;
- full-page modal;
- scroll locked;
- pointer events suppressed;
- large overlay introduced after page init.

### C. Temporal signals
- reaction appears shortly after a blocked/suspicious resource event;
- repeated polling/reappearance;
- reaction appears after a route change;
- reaction disappears after an adaptation candidate.

### D. Differential signals
During a controlled experiment:
- anti-block score decreased;
- main-content availability increased;
- overlay removed;
- page functionality restored.

## 8.2 Scoring

Use a transparent heuristic model first.

Example initial structure:

```text
reactionScore =
    semanticEvidence       * w1
  + gatingEvidence         * w2
  + geometryEvidence       * w3
  + temporalCorrelation    * w4
  + repeatedBehavior       * w5
  - benignModalEvidence    * w6
```

Do not hard-code final weights based on intuition. Establish an initial set, then tune against labeled synthetic + real benign samples.

### High-confidence trigger

Require evidence from **at least two different signal families** before entering autonomous adaptation, unless one signal is extremely specific and tested.

Example:

```text
"disable your ad blocker" + 80% viewport overlay
```

is much stronger than just the string “ad”.

---

# 9. Page Health Engine

The adaptive blocker must optimize two goals simultaneously:

```text
maximize unwanted-content suppression
while
minimizing functional breakage
```

This is directly consistent with research such as AutoFR, which models the trade-off between ad blocking and visual breakage.

## 9.1 Health dimensions

Return a structured vector, not just one score:

```ts
type HealthVector = {
  antiBlockReaction: number;    // 0..1, LOWER is better
  contentAvailability: number;  // 0..1
  interaction: number;          // 0..1
  scrollability: number;        // 0..1
  mediaHealth?: number;         // 0..1 when applicable
  navigationHealth: number;     // 0..1
  visualObstruction: number;    // 0..1, LOWER is better
  mutationStability: number;    // 0..1
  confidence: number;           // 0..1
};
```

Then derive an aggregate only for decision convenience.

## 9.2 Never treat “overlay disappeared” as success by itself

A bad strategy can make the overlay disappear by breaking the whole page.

Success requires:

```text
reaction ↓
AND
core health >= previous health - allowed tolerance
```

For certain dimensions such as main-content availability:

```text
must not regress
```

---

# 10. Adaptive strategy model

## 10.1 Closed action vocabulary

Phase 1 actions should be audited and typed.

### Network actions

```text
NET_BLOCK
NET_ALLOW_EXCEPTION
NET_REDIRECT_LOCAL
NET_DISABLE_SITE_RULE
```

### DOM actions

```text
DOM_HIDE
DOM_COLLAPSE
DOM_RESTORE
DOM_REMOVE_OVERLAY
DOM_RESTORE_SCROLL
DOM_RESTORE_POINTER_EVENTS
DOM_PRESERVE_BAIT_CANDIDATE
```

### Lifecycle actions

```text
OBSERVE
WAIT_STABILITY
RELOAD_IF_USER_ALLOWED
ROLLBACK
COMMIT_RECIPE
```

### Runtime compatibility actions
Keep these tiny and prepackaged:

```text
RUNTIME_OP:<known-op-id>
```

No arbitrary JS strings.

---

## 10.2 Strategy ladder

Recommended first strategy ordering:

### S0 — Baseline
Static DNR + safe cosmetic rules.

### S1 — Cosmetic rollback
If the anti-block reaction correlates with an element being cosmetically hidden:
- restore/suppress that cosmetic intervention;
- continue blocking associated unwanted network traffic where possible.

### S2 — Preserve suspected bait
Keep a small bait-like element structurally present while preventing it from becoming visually intrusive, when this can be done without fake claims of successful advertising execution.

### S3 — Reaction UI removal
If the page's only response is an anti-adblock overlay:
- remove/collapse overlay;
- restore scroll/pointer state;
- verify underlying content remains functional.

### S4 — Narrow network exception
Only when evidence is strong that a specific **non-sensitive** probe request is responsible.

**Privacy invariant:** do not automatically allow a third-party tracker or executable advertising payload merely to silence a detector.

### S5 — Local resource redirect
Where technically and legally appropriate, redirect a narrowly identified probe/resource to a packaged benign compatibility resource.

This consumes scarcer unsafe DNR capacity and may require a web-accessible resource, so use rarely.

### S6 — Prepackaged MAIN-world compatibility op
Only when a known page-runtime detector requires a minimal, auditable operation.

### S7 — Give up safely
If no safe strategy works:
- keep privacy protection;
- explain that the site reacted;
- allow the user to make a conscious per-site decision.

An “extreme” blocker is not one that secretly leaks user data to win a cat-and-mouse game.

---

# 11. Adaptation transactions

## 11.1 Transaction state machine

```text
IDLE
  ↓
CANDIDATE_CREATED
  ↓
STAGED
  ↓
OBSERVING
  ├─► VERIFIED_SUCCESS ─► COMMITTING ─► COMMITTED
  ├─► VERIFIED_FAILURE ─► ROLLING_BACK ─► ROLLED_BACK
  └─► TIMEOUT          ─► ROLLING_BACK ─► ROLLED_BACK
```

Every transition must be persisted enough that a service-worker death cannot leave orphaned experimental rules indefinitely.

## 11.2 Transaction record

```ts
interface AdaptationTransaction {
  txId: string;
  tabId: number;
  documentId?: string;
  siteKey: string;
  createdAt: number;

  baselineHealth: HealthVector;
  candidate: StrategyCandidate;

  sessionRuleIds: number[];
  domActionIds: string[];

  state:
    | "candidate"
    | "staged"
    | "observing"
    | "committing"
    | "committed"
    | "rolling_back"
    | "rolled_back"
    | "failed";

  verification?: VerificationResult;
}
```

## 11.3 Crash recovery

At worker startup/event wake:

1. load active transaction registry;
2. query actual session/dynamic rules;
3. inspect still-valid tabs/documents;
4. roll back orphaned experiments by default;
5. only resume an experiment when navigation identity matches exactly.

**Default after uncertainty = rollback**, not continue.

---

# 12. DNR priority and ID policy

Do not improvise priorities throughout the codebase.

## 12.1 Priority bands

Initial proposed logical bands:

```text
10      packaged baseline filters
100     persisted learned site blocks
200     persisted compatibility rules
500     temporary experiment blocks
600     temporary experiment redirects
900     explicit site compatibility allows
1000    explicit user allow/trust decision
```

The agent must verify Chromium's exact current action/priority semantics before coding this table.

Never depend on ambiguous same-priority ordering. Give conflicting rules explicit different priorities.

## 12.2 ID namespaces

Rule IDs are integers. Maintain deterministic ownership:

```text
1_000_000 – 1_999_999  learned dynamic safe
2_000_000 – 2_999_999  learned dynamic unsafe
3_000_000 – 3_999_999  experiment session safe
4_000_000 – 4_999_999  experiment session unsafe
```

Static rules are generated separately.

The exact ranges are implementation choices, not Chromium requirements.

Store:
- logical rule UUID;
- numeric DNR ID;
- owner recipe/transaction;
- action class;
- creation schema version.

Never derive numeric IDs from a non-collision-resistant truncated hostname hash and hope for the best.

---

# 13. Site recipe system

## 13.1 Recipe objective

A recipe is a compact, auditable summary of what we have learned for a site.

It is **not executable remote code**.

Example:

```json
{
  "schemaVersion": 1,
  "siteKey": "example.com",
  "match": {
    "host": "example.com",
    "pathClass": "*"
  },
  "actions": [
    {
      "type": "DOM_RESTORE_SCROLL",
      "selectorFingerprint": "..."
    },
    {
      "type": "NET_BLOCK",
      "destinationHost": "ads.example-cdn.com",
      "resourceTypes": ["script", "image"]
    }
  ],
  "evidence": {
    "successfulNavigations": 4,
    "lastHealthDelta": 0.28,
    "confidence": 0.96
  },
  "createdAt": "...",
  "updatedAt": "..."
}
```

## 13.2 Recipe states

```text
candidate
provisional
confirmed
degraded
quarantined
expired
```

### Suggested promotion policy

A live experiment that succeeds once:
- becomes `provisional`.

After repeated successful independent navigations with no breakage:
- becomes `confirmed`.

If page fingerprint/health changes:
- mark `degraded`;
- stop blindly applying invasive actions;
- return to observation/adaptation.

---

# 14. Site fingerprinting / staleness

Do not build a privacy-invasive global site fingerprint database.

We only need enough information to determine whether a stored recipe is still plausibly valid.

Phase 1 recipe validity signals can include:
- hostname;
- coarse route class;
- set/hash of major script origins;
- high-level DOM landmarks;
- detector-reaction signature;
- recipe schema version.

Avoid:
- full DOM dumps;
- text of private pages;
- form values;
- authentication tokens;
- user-specific content hashes.

A recipe should be site-behavior memory, not browsing-history surveillance.

---

# 15. Cosmetic blocking strategy

Network blocking alone leaves placeholders and first-party/native ads.

Phase 1 needs cosmetics, but cosmetics are also a common source of anti-block detection and page breakage.

## 15.1 Divide cosmetic rules into

```text
STATIC_SAFE
STATIC_PROCEDURAL_OR_COMPLEX
LEARNED_SITE
EXPERIMENTAL
```

### Initial recommendation

For the first working milestone:
- use simple CSS selectors from an audited filter source;
- inject them declaratively or through a controlled style manager;
- maintain per-rule ownership;
- make site-scoped rollback possible.

Do not start by implementing the entire uBO procedural cosmetic language.

## 15.2 Avoid publicly unique markers

Bad:

```html
<div data-adapt-hidden="1">
```

Better:
- track nodes in isolated-world WeakSets;
- manage injected styles from extension context;
- if a DOM wrapper is absolutely required, generate non-semantic per-document identifiers and minimize use.

Remember: a site can still observe computed styles/DOM changes. We are reducing fingerprints, not claiming invisibility.

---

# 16. MAIN-world operations

MAIN-world logic should be treated like surgery.

## 16.1 Requirements for every MAIN operation

Each operation must have:
- immutable packaged implementation;
- stable operation ID;
- narrowly typed arguments;
- domain/scope guard;
- rollback plan where possible;
- unit test;
- hostile-page test;
- CSP test;
- performance budget;
- audit log entry.

## 16.2 MAIN-world anti-patterns

Never:
- expose a persistent `window.ADAPT` object;
- add globally recognizable functions;
- monkeypatch dozens of browser APIs by default;
- replace native prototypes globally without necessity;
- use `eval`;
- fetch code;
- execute model-generated JavaScript;
- install hooks on every site “just in case.”

The lower our MAIN-world footprint, the smaller our compatibility and detection surface.

---

# 17. Privacy and security invariants

These outrank “winning” against a detector.

## 17.1 Privacy invariants

1. No cloud telemetry in Phase 1.
2. No browsing history upload.
3. No screenshot upload.
4. No page text upload.
5. Query strings and fragments are redacted from persistent telemetry unless a specific rule genuinely requires them.
6. Adaptation must not automatically allow known tracking just to make anti-adblock UI disappear.
7. No cross-site recipe data used to construct a user profile.
8. Local diagnostics are user-clearable.
9. Incognito support is off until separately designed/tested.
10. No collection of form values, keystrokes, passwords, auth headers, cookies, or page storage.

## 17.2 Security invariants

1. Treat every web page as hostile input.
2. Treat DOM strings as untrusted.
3. Content-script → worker messages require schema validation.
4. Worker → content-script commands require schema validation.
5. Never use `innerHTML` for untrusted strings in extension UI.
6. No remote executable code.
7. No arbitrary command interpreter.
8. No unsafe deserialization.
9. No exposed extension resource without explicit review.
10. No general externally connectable interface.
11. No extension secret placed into page DOM.
12. No reliance on obscurity for authorization.
13. Build artifacts must be inspectable/reproducible.

---

# 18. Chrome Web Store design constraints

Even before publication, design for compliance.

## 18.1 Single purpose

The extension purpose should remain narrow:

> block unwanted advertising/tracking and adapt to ad-blocking-related page breakage/reactions.

Do not bolt unrelated:
- VPN;
- downloader;
- coupon system;
- password manager;
- scraper;
- crypto;
- AI chat.

onto the extension.

## 18.2 Permission justification

Create:

`docs/permissions.md`

For every permission:

```text
permission
feature requiring it
why a less powerful permission is insufficient
what data it exposes
how data is handled
test proving usage
```

## 18.3 Remote updates

Remote servers may eventually deliver:
- filter data;
- rule metadata;
- model weights only after policy review;
- non-executable configuration.

Do not deliver remote executable logic.

A remote recipe system in a later phase must remain a constrained data format whose behavior is already implemented and auditable in the package. The coding agent must specifically re-read current CWS policy before designing this; Chrome warns that complex remote-command interpreters can be treated as remote logic.

---

# 19. Data/storage architecture

## 19.1 `chrome.storage.local`

Use for:
- user settings;
- enabled feature flags;
- site recipe index;
- small metadata;
- schema versions.

## 19.2 `chrome.storage.session`

Use for:
- hot ephemeral worker-reconstructable state where appropriate;
- navigation-local coordination;
- caches that should not survive browser restarts.

Do not depend on it alone for rollback-critical data unless losing it is provably safe.

## 19.3 IndexedDB

Use if/when:
- recipe histories become large;
- audit logs need indexes;
- filter metadata exceeds simple key/value ergonomics.

Phase 1 can begin with `chrome.storage.local` plus a clean repository interface. Move to IndexedDB only based on measured need.

## 19.4 `unlimitedStorage`

Request only if production rule/filter/recipe data actually justifies it.

It can remove quota/eviction constraints for extension storage, but requesting a permission simply because another blocker does is not acceptable. Measure first and document the reason.

---

# 20. Local auditability

Every autonomous adaptation should generate a human-readable local record:

```text
Site: example.com
Trigger:
  anti-block reaction score: 0.91
  fixed overlay: 78% viewport
  semantic match: "disable your ad blocker"

Experiment:
  strategy: cosmetic rollback
  temporary rules: [3012841]
  started: ...

Before:
  content 0.74
  reaction 0.91
  interaction 0.40

After:
  content 0.75
  reaction 0.08
  interaction 0.98

Decision:
  success
  provisional recipe saved
```

This will be invaluable when Phase 2 AI begins making decisions.

Without auditability, adaptive behavior becomes impossible to debug.

---

# 21. Test laboratory

Do not begin by chasing random production websites.

Build controlled hostile test pages first.

Host them locally, ideally with multiple ports/origins to emulate third-party behavior.

## 21.1 Required synthetic scenarios

### T01 — basic third-party ad
- page loads image/script from ad-like third-party origin;
- baseline DNR should block.

### T02 — simple cosmetic ad
- first-party DOM ad container;
- CSS cosmetic rule should hide/collapse.

### T03 — bait-element detector
- page inserts obvious ad bait;
- periodically checks visibility/dimensions;
- shows anti-block overlay if bait disappears.

Expected:
- detector recognizes reaction;
- strategy can preserve/restore bait while other unwanted content remains suppressed.

### T04 — blocked-probe detector
- page loads a benign “ad probe” script;
- detector checks whether probe completed.

Expected:
- reaction detected;
- engine can test a narrowly scoped compatibility strategy without broadly allowing tracking.

### T05 — full-screen anti-block overlay
- detector adds fixed overlay;
- body scroll disabled.

Expected:
- reaction UI action removes obstruction;
- scroll restored;
- underlying page remains interactive.

### T06 — delayed detector
- reaction fires 3–10 seconds after load.

Expected:
- health window catches it;
- no assumption that page is healthy after `DOMContentLoaded`.

### T07 — repeated detector
- overlay reappears after removal.

Expected:
- mutation pipeline notices repeated behavior;
- engine avoids infinite remove/reinsert loop;
- strategy escalates or safely gives up.

### T08 — SPA route
- first route healthy;
- `pushState` route introduces ads/detector.

Expected:
- new route/navigation epoch;
- sensor remains correct;
- recipe scope appropriate.

### T09 — same-tab cross-site navigation
- recipe from A must never leak into B.

### T10 — nested iframe
- ad/detector inside subframe;
- frame identification correct.

### T11 — about:blank/blob related frame
- verify `match_about_blank` / origin fallback behavior.

### T12 — benign consent modal
- resembles full-screen gate but is not anti-adblock.

Expected:
- no autonomous anti-adblock strategy.

### T13 — newsletter modal
- tests semantic/geometry false positive handling.

### T14 — functional script with ad-looking URL
- blocking it breaks navigation/player.

Expected:
- health regression caught;
- rule rolled back.

### T15 — mutation storm
- hundreds/thousands of DOM mutations/sec.

Expected:
- sensor degrades gracefully;
- CPU budget maintained.

### T16 — site service-worker cached content
- demonstrate DNR blind spot for content generated from service-worker cache paths where applicable.

Expected:
- documented limitation;
- no fake “blocked” telemetry.

### T17 — popunder attempt
- user gesture triggers unwanted `window.open`.

Expected:
- test current Chromium capabilities and define what Phase 1 can/cannot safely do.

### T18 — open Shadow DOM
- ad/reaction in open shadow root.

### T19 — closed Shadow DOM
- explicitly demonstrate limitation.

### T20 — hostile page probes extension fingerprints
- attempts to fetch known WAR paths;
- looks for globals/markers;
- monitors DOM mutation patterns.

Expected:
- no trivial stable fingerprint intentionally exposed by us.

### T21 — service-worker termination during experiment
- forcibly idle/restart worker.

Expected:
- transaction recovers or rolls back correctly.

### T22 — browser restart with provisional recipe
- dynamic rules persist;
- session experiments do not;
- recipe registry reconciles correctly.

### T23 — extension update/migration
- storage/schema migration tested;
- no orphan rule IDs.

### T24 — DNR quota boundary
- synthetic near-limit dynamic/session sets.

Expected:
- graceful refusal/compaction;
- no corrupted state.

### T25 — adversarial message payload
- hostile page influences content-script DOM input to produce malformed/extreme messages.

Expected:
- schema rejection;
- no code execution.

---

# 22. E2E browser matrix

Phase 1 CI:

```text
Chromium stable
Chromium beta
```

Nightly/manual:

```text
Chromium dev/canary
```

Before release, test:
- fresh profile;
- existing profile;
- extension reload;
- browser restart;
- another content blocker installed (we should warn about conflicts rather than pretend determinism);
- CSP-heavy pages;
- pages with service workers;
- very large DOM;
- long-running SPA.

Do not optimize for interaction with another adblocker. uBO itself warns that stacking content blockers can interfere with anti-blocking/privacy behavior.

Our blocker should detect likely competing blockers where feasible and show a warning in diagnostics.

---

# 23. Performance engineering

The project wins only if normal pages feel as fast as a declarative blocker.

## 23.1 Hot-path rule

**No AI and no heavy parser in the network hot path.**

Chromium DNR does blocking.

## 23.2 Initial engineering budgets

These are project targets, not claims from research. Measure and revise them.

### Content sensor
- document-start synchronous work: target < 2 ms median, < 5 ms p95 on dev reference hardware;
- no whole-DOM traversal during initial sync path;
- mutation processing in bounded batches;
- steady-state observer should approach zero work when DOM is quiet.

### Worker
- no keepalive polling;
- wake only on meaningful events;
- batch DNR changes;
- no large synchronous JSON transformations during navigation.

### Page impact
- target negligible LCP/INP regression on pages without adaptation;
- benchmark with blocker disabled vs baseline rules vs full Phase 1 sensor;
- report p50/p95, not cherry-picked single runs.

### Memory
Do not set a marketing number before measuring.
Instead measure:
- extension worker idle/active;
- content script per tab;
- 1 / 10 / 50 tab cases;
- recipe DB growth;
- mutation-storm case.

---

# 24. Observability limitations we must design around

## 24.1 `onRuleMatchedDebug` is not a production telemetry primitive

Use DNR feedback/debug APIs in unpacked/dev builds.

Production should maintain its own logical rule registry and use request/page observations rather than relying on an event that is only intended for debugging/unpacked use.

## 24.2 DNR does not see everything

Chrome documents that DNR applies to requests reaching the network stack and can have limitations with responses produced through a page service worker / CacheStorage.

The UI must never report “we blocked X” based on assumptions.

## 24.3 WebSockets

A network filter can act on connection establishment where Chromium exposes the request, but extension APIs do not give us a generic ability to inspect/manipulate every application message after a WebSocket is established.

Do not promise message-level WebSocket ad filtering in Phase 1.

## 24.4 Closed Shadow DOM

A normal content script cannot enumerate arbitrary internals of a closed shadow root.

Document the limitation.

## 24.5 Browser-protected pages

No “works on literally every page” claim.

---

# 25. Filter pipeline strategy

## 25.1 Do not write a full ABP/uBO parser before proving the adaptive engine

A complete filtering syntax implementation is a project by itself.

Phase 1 sequence:

### Stage A — architecture baseline
Use a small, internally authored DNR test ruleset sufficient for:
- blocking;
- exceptions;
- session experiments;
- redirects;
- rule lifecycle tests.

### Stage B — production list integration spike
Agent compares:
- EasyList/EasyPrivacy build-time conversion options;
- eyeo tooling;
- AdGuard DNR tooling;
- uBOL conversion concepts;
- a minimal custom compiler only if justified.

### Stage C — selected list provider
Adopt one only after:
- license decision;
- syntax coverage tests;
- rule-count analysis;
- performance test;
- update strategy;
- attribution/provenance.

This prevents the entire architecture from becoming hostage to a filter parser.

---

# 26. Filter update design

Static rules are ideal for large known lists.

Dynamic rules are for:
- user/local learning;
- urgent safe data updates where policy allows;
- site recipes.

Do **not** waste dynamic quota mirroring the entire global static list.

A future production build can automate static-filter refresh releases. AdGuard demonstrates this model in production, and Chrome provides an expedited/skip-review path for certain safe static rule-only updates subject to current policy.

The agent must verify the exact policy at implementation/release time.

---

# 27. Messaging protocol

All inter-context communication must be versioned.

Example:

```ts
type Message =
  | {
      v: 1;
      type: "PAGE_SIGNAL_BATCH";
      navigationId: string;
      payload: PageSignalBatch;
    }
  | {
      v: 1;
      type: "APPLY_DOM_ACTION";
      txId: string;
      payload: DomAction;
    }
  | {
      v: 1;
      type: "HEALTH_SNAPSHOT";
      txId?: string;
      payload: HealthVector;
    };
```

### Rules
- reject unknown versions;
- reject oversized messages;
- validate enums and numeric ranges;
- sanitize selector/path data;
- never send raw DOM nodes;
- never send functions;
- never send page-owned objects.

---

# 28. Suggested repository structure

```text
adapt/
├─ docs/
│  ├─ research-ledger.md
│  ├─ source-ledger.md
│  ├─ filter-list-licenses.md
│  ├─ permissions.md
│  ├─ threat-model.md
│  ├─ performance.md
│  └─ adr/
│     ├─ 001-build-stack.md
│     ├─ 002-filter-engine.md
│     ├─ 003-dnr-rule-lifecycle.md
│     ├─ 004-storage.md
│     ├─ 005-privacy-invariants.md
│     ├─ 006-adaptation-transactions.md
│     └─ 007-test-strategy.md
│
├─ src/
│  ├─ entrypoints/
│  │  ├─ background.ts
│  │  ├─ content.ts
│  │  ├─ popup/
│  │  └─ options/
│  │
│  ├─ core/
│  │  ├─ dnr/
│  │  │  ├─ controller.ts
│  │  │  ├─ ids.ts
│  │  │  ├─ priorities.ts
│  │  │  ├─ compiler.ts
│  │  │  ├─ reconcile.ts
│  │  │  └─ quota.ts
│  │  │
│  │  ├─ navigation/
│  │  │  ├─ registry.ts
│  │  │  └─ epoch.ts
│  │  │
│  │  ├─ network/
│  │  │  ├─ observer.ts
│  │  │  ├─ normalize-url.ts
│  │  │  └─ request-graph.ts
│  │  │
│  │  ├─ health/
│  │  │  ├─ model.ts
│  │  │  ├─ scorer.ts
│  │  │  └─ compare.ts
│  │  │
│  │  ├─ adaptation/
│  │  │  ├─ engine.ts
│  │  │  ├─ transaction.ts
│  │  │  ├─ candidates.ts
│  │  │  ├─ verify.ts
│  │  │  └─ rollback.ts
│  │  │
│  │  ├─ recipes/
│  │  │  ├─ schema.ts
│  │  │  ├─ store.ts
│  │  │  ├─ validity.ts
│  │  │  └─ promotion.ts
│  │  │
│  │  └─ audit/
│  │     ├─ events.ts
│  │     └─ store.ts
│  │
│  ├─ page/
│  │  ├─ sensor.ts
│  │  ├─ mutations.ts
│  │  ├─ geometry.ts
│  │  ├─ semantic-signals.ts
│  │  ├─ interaction-health.ts
│  │  ├─ dom-actions.ts
│  │  └─ main-ops/
│  │
│  ├─ shared/
│  │  ├─ messages.ts
│  │  ├─ guards.ts
│  │  ├─ constants.ts
│  │  └─ types.ts
│  │
│  └─ rules/
│     ├─ static/
│     └─ generated/
│
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ e2e/
│  └─ pages/
│     ├─ t01-basic-ad/
│     ├─ t02-cosmetic/
│     ├─ t03-bait-detector/
│     └─ ...
│
├─ scripts/
│  ├─ build-rules.ts
│  ├─ validate-rules.ts
│  ├─ license-report.ts
│  └─ benchmark.ts
│
├─ wxt.config.ts
├─ package.json
├─ tsconfig.json
└─ README.md
```

If the agent rejects WXT after the required spike, keep the domain structure and replace only the extension-build shell.

---

# 29. Phase 1 milestone plan

## M0 — Re-verify research before coding

### Tasks
- read current Chrome DNR docs;
- current webRequest docs;
- service worker lifecycle;
- content scripts/worlds;
- Web Accessible Resources;
- MV3 remote-code policy;
- CWS permission/privacy rules;
- WXT current docs/release/license;
- candidate blocker SDK/tooling current docs/licenses;
- EasyList current license;
- current Chromium stable version.

### Deliverables
- `docs/research-ledger.md`
- `docs/source-ledger.md`
- ADR-001 build stack
- ADR-002 filter engine

### Exit criteria
No material architecture assumption is “because ChatGPT said so.”

---

## M1 — Minimal MV3 shell

### Build
- strict TypeScript;
- MV3 manifest;
- worker;
- isolated `document_start` content script;
- popup showing enabled/site state;
- local storage wrapper;
- CI;
- unpacked Chrome launch from tests.

### Exit criteria
- install/reload cleanly;
- zero console errors;
- worker may sleep and wake without losing correctness;
- no unnecessary web-accessible resources;
- permissions documented.

---

## M2 — DNR controller

### Build
- static test rules;
- dynamic rule registry;
- session rule registry;
- ID allocator;
- priority policy;
- atomic update wrapper;
- startup reconciliation;
- quota reporting;
- dev debug listener.

### Tests
- block;
- allow;
- redirect;
- session cleanup;
- dynamic persistence;
- browser restart;
- extension update;
- quota boundary.

### Exit criteria
DNR state is deterministic and recoverable.

---

## M3 — Navigation + request observation

### Build
- navigation epochs;
- frame/document identity;
- SPA route handling;
- webRequest request graph;
- URL redaction/normalization;
- lifecycle cleanup.

### Exit criteria
Events from a previous document can never mutate current-document state.

---

## M4 — Page sensor + health model

### Build
- geometry signals;
- semantic anti-block signals;
- interaction signals;
- scroll/pointer state;
- bounded mutation pipeline;
- health vector;
- benign-modal negative controls.

### Exit criteria
Synthetic detector pages are recognized with low false positives on benign-modal test cases.

Do not tune to only the happy-path fixtures.

---

## M5 — Adaptation transaction engine

### Build
- strategy candidates;
- stage via tab/session scope;
- timed observation;
- before/after comparison;
- rollback;
- crash recovery;
- local audit log.

### Exit criteria
For T03–T07:
- at least one designed safe strategy succeeds where applicable;
- failed strategies fully roll back;
- killing worker mid-experiment leaves no unsafe persistent state.

This is the first **Phase 1 breakthrough milestone**.

---

## M6 — Recipe memory

### Build
- recipe schema;
- provisional/confirmed states;
- replay;
- staleness;
- recipe invalidation;
- promotion from successful transaction;
- rollback after regression.

### Exit criteria
Second visit to a solved synthetic site applies successful strategy without re-running full exploration.

---

## M7 — Production filter integration

Only now integrate serious global filter data.

### Required decision
Select tooling/list source based on:
- license;
- coverage;
- conversion accuracy;
- DNR quota;
- cosmetics/snippets implications;
- update cadence;
- bundle impact.

### Exit criteria
- real baseline blocking;
- filter provenance;
- no license ambiguity recorded as “TODO”;
- conversion tests;
- DNR validation passes.

---

## M8 — Hardening

### Security
- hostile message tests;
- CSP tests;
- WAR audit;
- permissions audit;
- no remote code;
- dependency audit;
- DOM injection review.

### Performance
- 1/10/50 tabs;
- large DOM;
- mutation storm;
- long SPA;
- cold browser startup;
- worker restarts.

### Quality
- stable + beta Chromium;
- diagnostics;
- exportable local debug report with sensitive data redacted.

---

# 30. Phase 1 acceptance criteria

Phase 1 is complete only when ALL are true.

## Network
- [ ] DNR blocks known test traffic before page JS can use it.
- [ ] dynamic rule persistence reconciles correctly after restart.
- [ ] session experiments are temporary and recoverable.
- [ ] quotas are measured and surfaced.
- [ ] unsafe rule budget is protected.

## Page
- [ ] sensor starts at `document_start`.
- [ ] frame and SPA lifecycle are correct.
- [ ] no unbounded full-DOM scans.
- [ ] benign modal tests do not routinely trigger adaptation.
- [ ] mutation storms degrade safely.

## Adaptation
- [ ] reaction detection exists.
- [ ] health vector exists.
- [ ] experiment transaction state machine exists.
- [ ] rollback is proven.
- [ ] successful strategy can be promoted.
- [ ] recipe replay works.
- [ ] recipe invalidation works.

## Privacy/security
- [ ] no cloud telemetry.
- [ ] no remote code.
- [ ] no arbitrary JS generation/execution.
- [ ] no silent tracking allow solely for detector appeasement.
- [ ] messages validated.
- [ ] WAR surface audited.
- [ ] permission surface audited.

## Engineering
- [ ] research ledger current.
- [ ] dependency/license ledger current.
- [ ] unit/integration/E2E green.
- [ ] Chrome stable + beta pass.
- [ ] worker-death test passes.
- [ ] restart/update migration tests pass.
- [ ] performance report exists.
- [ ] known limitations documented.

---

# 31. Research rules for the coding agent

These rules are **mandatory**.

## Rule R1 — Re-research before committing
## Rule R2 — Primary sources first
## Rule R3 — Search for a better alternative before adding a major dependency
## Rule R4 — Verify licensing independently
## Rule R5 — Test browser behavior, do not trust docs alone
## Rule R6 — Preserve privacy while adapting
## Rule R7 — Every autonomous action must be reversible or explicitly classified irreversible
## Rule R8 — One variable per experiment when possible
## Rule R9 — Don't overfit to one website
## Rule R10 — Do not treat paywalls/access controls as anti-adblock
## Rule R11 — Minimize MAIN-world surface
## Rule R12 — Do not expose a fingerprint casually
## Rule R13 — Never use service-worker keepalive tricks
## Rule R14 — Do not rely on dev-only APIs in production
## Rule R15 — No AI in Phase 1 hot path
## Rule R16 — No arbitrary model-generated code
## Rule R17 — Keep browser APIs behind adapters
## Rule R18 — Build test pages before clever detector logic
## Rule R19 — Performance regression is a bug
## Rule R20 — Maintain a `KNOWN_UNKNOWNS.md`

---

# 32. High-priority unknowns the agent must experimentally resolve
- U1. Best filter-rule integration path
- U2. WXT vs minimal raw build
- U3. DNR redirect + `use_dynamic_url`
- U4. Production blocked-count observability
- U5. Cosmetic rollback granularity
- U6. Frame/SPA navigation identity
- U7. Service-worker death during DNR mutation
- U8. Competing blocker behavior
- U9. Popup/popunder controls under MV3
- U10. Safe bait preservation

---

# 33. Threat model
Adversaries:
A. Ordinary ad network
B. Anti-adblock script
C. Hostile page
D. Compromised filter source
E. Buggy adaptation

---

# 34. Why “adaptive” can outperform static anti-adblock maintenance
- CV-Inspector & AutoFR research insights.

---

# 35. Phase 2 interface to preserve now
```ts
interface StrategyPlanner {
  propose(input: StrategyContext): Promise<StrategyCandidate[]>;
}
```

---

# 36. What Phase 1 should feel like to the user
Normal site: instant, quiet.
Problem site: detector reaction → ADAPT stages reversible experiment → reaction resolved → local recipe saved.

---

# 37. Coding standards
Strict TypeScript, pure scoring functions, versioned message schemas, side effects behind controllers, lockfile committed, zero swallowed exceptions.

---

# 38. Definition of “done” for every feature
Code + unit tests + E2E fixture + negative case + restart behavior + privacy review + performance check + docs + source note.

---

# 39. Source / research ledger references
1. Declarative Net Request API
2. Content filtering guidance
3. Extension service worker lifecycle
4. Content scripts
5. Manifest content scripts
6. Scripting API
7. Web Accessible Resources
8. MV3 remote-code policy
9. Improve extension security
10. Storage and cookies
11. Chrome Web Store privacy/permissions
12. uBlock Origin Lite
13. uBlock Origin / uAssets
14. AdGuard Browser Extension
15. AdGuard DNR rulesets package
16. Brave adblock-rust
17. eyeo WebExt Ad-Filtering Solution
18. WXT
19. EasyList license
20. CV-Inspector (NDSS 2021)
21. AutoFR (USENIX Security 2023)
22. AdVersarial
