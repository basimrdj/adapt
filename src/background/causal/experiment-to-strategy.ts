/**
 * Phase 3 M4 — map ExperimentCandidate → Phase 1 StrategyCandidate.
 *
 * Frozen intervention → StrategyAction mapping. Never invents new action kinds.
 * INV-X5: refuse form-submit / purchase / auth / paywall.
 * temp_network_exception is session-scoped and only emitted after a trusted
 * background resolver maps an opaque request ref to a first-party coarse URL.
 */

import {
  AllowedInterventionVariable,
  ExperimentCandidate,
  containsForbiddenToken,
  looksLikeSelectorOrUrl,
} from '../../shared/causal/experiments';
import { StrategyAction, StrategyCandidate, StrategyLadderTier } from '../../shared/types';

/** RFC 2606 .invalid host — cannot match a real tracker. Tab-scoped via DNR session rules. */
export const NOOP_SESSION_ALLOW_FILTER = '||adapt-causal-noop.invalid^';

export interface ResolvedNetworkTarget {
  urlFilter: string;
  resourceTypes: chrome.declarativeNetRequest.ResourceType[];
  firstParty: boolean;
  trackerLike: boolean;
}

export interface StrategyResolutionContext {
  resolveRequest(ref: `request:r${number}`): ResolvedNetworkTarget | undefined;
}

const FORBIDDEN_RE =
  /form[_\s-]?submit|purchase|subscribe|login|logout|paywall|password|credential|auth[_\s-]?bypass/i;

const ALLOWED: ReadonlySet<string> = new Set([
  'temp_network_exception',
  'preserve_bait_geometry',
  'remove_overlay_gate',
  'restore_scroll',
  'dom_hide_candidate',
]);

function isAllowedVariable(v: string): v is AllowedInterventionVariable {
  return ALLOWED.has(v);
}

function riskFromHealth(healthRisk: number): 'LOW' | 'MEDIUM' {
  return healthRisk >= 0.15 ? 'MEDIUM' : 'LOW';
}

function unsafeText(value: string): boolean {
  return FORBIDDEN_RE.test(value) || containsForbiddenToken(value) || looksLikeSelectorOrUrl(value);
}

/**
 * Returns a reversible LOW/MEDIUM Phase 1 candidate, or null if the
 * intervention cannot be mapped without violating INV-X5 / privacy.
 */
export function experimentToStrategy(
  selected: ExperimentCandidate,
  resolution?: StrategyResolutionContext
): StrategyCandidate | null {
  const variable = selected.intervention.variable;
  if (!isAllowedVariable(variable)) return null;
  if (unsafeText(variable)) return null;
  for (const ref of selected.intervention.actionRefs) {
    if (unsafeText(ref)) return null;
  }

  const actions: StrategyAction[] = [];
  let tier: StrategyLadderTier;
  let name: string;

  switch (variable) {
    case 'temp_network_exception':
      {
      const request = selected.intervention.actionRefs.find(
        (ref): ref is `request:r${number}` => ref.startsWith('request:r')
      );
      const target = request ? resolution?.resolveRequest(request) : undefined;
      if (!target || !target.firstParty || target.trackerLike || target.urlFilter.includes('.invalid')) {
        return null;
      }
      tier = 'S1';
      name = 'Causal: session network exception';
      actions.push({
        id: `net_allow_${selected.id}`,
        type: 'NET_ALLOW_EXCEPTION',
        urlFilter: target.urlFilter,
        resourceTypes: target.resourceTypes,
      });
      break;
      }
    case 'preserve_bait_geometry':
      tier = 'S2';
      name = 'Causal: preserve bait geometry';
      actions.push({
        id: `dom_bait_${selected.id}`,
        type: 'DOM_PRESERVE_BAIT_CANDIDATE',
        targetRef: selected.intervention.actionRefs.find(
          (ref): ref is `element:e${number}` => ref.startsWith('element:e')
        ),
      });
      break;
    case 'remove_overlay_gate':
      tier = 'S3';
      name = 'Causal: remove overlay gate';
      // One logical overlay-gate variable (INV-X3): hide/remove overlay.
      // Pointer restore is a mechanical part of the same gate (scroll is separate).
      actions.push({
        id: `dom_overlay_${selected.id}`,
        type: 'DOM_REMOVE_OVERLAY',
        targetRef: selected.intervention.actionRefs.find(
          (ref): ref is `element:e${number}` => ref.startsWith('element:e')
        ),
      });
      actions.push({
        id: `dom_pointer_${selected.id}`,
        type: 'DOM_RESTORE_POINTER_EVENTS',
      });
      break;
    case 'restore_scroll':
      tier = 'S3';
      name = 'Causal: restore scroll';
      actions.push({
        id: `dom_scroll_${selected.id}`,
        type: 'DOM_RESTORE_SCROLL',
      });
      break;
    case 'dom_hide_candidate':
      tier = 'S1';
      name = 'Causal: hide candidate';
      actions.push({
        id: `dom_hide_${selected.id}`,
        type: 'DOM_HIDE',
        targetRef: selected.intervention.actionRefs.find(
          (ref): ref is `element:e${number}` => ref.startsWith('element:e')
        ),
      });
      break;
  }

  if (actions.length === 0) return null;

  return {
    id: `causal_cand_${selected.id}`,
    tier,
    name,
    rationale: `Mapped intervention ${variable} to a reversible Phase 1 strategy (one variable).`,
    actions,
    isReversible: true,
    estimatedRisk: riskFromHealth(selected.expected.healthRisk),
  };
}
