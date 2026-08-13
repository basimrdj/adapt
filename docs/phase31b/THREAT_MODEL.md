# Phase 3.1B Threat Model

## Threat actors

- DOM bait detectors measuring `offsetHeight`, bounding boxes, or computed CSS.
- Network-probe and blocked-request detectors.
- Mutation and reinsertion detectors.
- Timer, reload-loop, scroll-lock, pointer-lock, and fullscreen gates.
- JavaScript environment and extension-resource probes.
- SPA scripts that re-render or replace the body.
- Benign dialogs that resemble anti-adblock prompts.

## Extension fingerprint surface

The implementation avoids stable ADAPT marker nodes, page-visible production
logging, ADAPT globals, arbitrary injected source, and permanent polling loops.
Generic CSS is declarative. Runtime observation is bounded and event-driven.
The existing redirect resources use dynamic WAR URLs when present.

## Safety model

- Isolated-world scriptlets are the default.
- MAIN-world execution is explicit, typed, narrowly allowlisted, and routed
  through `chrome.scripting.executeScript`.
- Page-controlled DOM input crosses sensor fault boundaries.
- Causal actions are reversible and health-checked.
- Consent, login, paywall, and benign-text cases remain negative controls.

## Honest limitation

This does not claim invisibility or universal anti-adblock resistance. The
adversarial corpus is a measurable test set, not proof against untested
detectors. Closed shadow roots, arbitrary proprietary scriptlet syntax, and
page-specific MAIN-world behavior remain explicit limitations.
