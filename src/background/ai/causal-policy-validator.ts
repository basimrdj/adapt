/**
 * Phase 3 M3 — validateCausalDecision (spec §32).
 *
 * Fail CLOSED. Never throw. Reject unknown fields, invented refs, action expansion,
 * stale epochs, budget exhaustion, risk-ceiling breaches, and un-gated promotion.
 */

import {
  CAUSAL_PLAN_SCHEMA_VERSION,
  CausalPlannerDecisionV1,
  CausalValidationResult,
  CurrentEpochState,
  EVIDENCE_PACKET_SCHEMA_VERSION,
  EvidencePacketV3,
  FORBIDDEN_ACTION_KEYS,
  PacketExperiment,
  containsForbiddenToken,
  isAllowedExpectedOutcome,
  isAllowedReasonCode,
  isFiniteNumber,
  isOpaqueRefString,
  looksLikeSelectorOrUrl,
} from '../../shared/causal/experiments';

export type { CausalValidationResult };

const EXPERIMENT_KEYS = new Set([
  'schemaVersion',
  'decision',
  'experimentRef',
  'hypothesisRef',
  'reasonCode',
  'expectedOutcome',
  'confidence',
]);

const ABSTAIN_KEYS = new Set([
  'schemaVersion',
  'decision',
  'reasonCode',
  'expectedOutcome',
  'confidence',
]);

const PROMOTE_KEYS = new Set([
  'schemaVersion',
  'decision',
  'hypothesisRef',
  'reasonCode',
  'expectedOutcome',
  'confidence',
]);

const FORBIDDEN_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_ACTION_KEYS);

const EXPERIMENT_REF_RE = /^experiment:x\d+$/;
const HYPOTHESIS_REF_RE = /^hypothesis:h\d+$/;

function fail(reason: string): CausalValidationResult {
  return { ok: false, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasActionExpansion(obj: Record<string, unknown>): string | null {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEY_SET.has(key)) return key;
  }
  return null;
}

function extraKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}

function stringLooksInvented(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (containsForbiddenToken(value)) return true;
  if (looksLikeSelectorOrUrl(value)) return true;
  return false;
}

function packetEpochMatches(packet: EvidencePacketV3, now: CurrentEpochState): boolean {
  return (
    packet.scope.tabId === now.tabId &&
    packet.scope.navigationEpoch === now.navigationEpoch &&
    packet.scope.documentId === now.documentId
  );
}

function finiteRisks(exp: PacketExperiment): string | null {
  if (!isFiniteNumber(exp.expectedInformationGain)) return 'non-finite expectedInformationGain';
  if (!isFiniteNumber(exp.expectedHealthRisk)) return 'non-finite expectedHealthRisk';
  if (!isFiniteNumber(exp.privacyRisk)) return 'non-finite privacyRisk';
  if (!isFiniteNumber(exp.rollbackConfidence)) return 'non-finite rollbackConfidence';
  if (!isFiniteNumber(exp.estimatedDurationMs)) return 'non-finite estimatedDurationMs';
  return null;
}

function validateActionRefs(exp: PacketExperiment): string | null {
  if (!Array.isArray(exp.actionRefs)) return 'actionRefs is not an array';
  for (const ref of exp.actionRefs) {
    if (typeof ref !== 'string' || !isOpaqueRefString(ref)) {
      return `invented or invalid actionRef: ${String(ref)}`;
    }
    if (containsForbiddenToken(ref) || looksLikeSelectorOrUrl(ref)) {
      return `unsafe actionRef: ${ref}`;
    }
  }
  return null;
}

export function validateCausalDecision(
  packet: EvidencePacketV3,
  decision: unknown,
  now: CurrentEpochState,
  opts?: { promotionGatePass?: boolean }
): CausalValidationResult {
  try {
    return validateCausalDecisionInner(packet, decision, now, opts);
  } catch {
    return fail('validator_exception');
  }
}

function validateCausalDecisionInner(
  packet: EvidencePacketV3,
  decision: unknown,
  now: CurrentEpochState,
  opts?: { promotionGatePass?: boolean }
): CausalValidationResult {
  if (packet.schemaVersion !== EVIDENCE_PACKET_SCHEMA_VERSION) {
    return fail(`unsupported packet schemaVersion: ${String(packet.schemaVersion)}`);
  }
  if (!isPlainObject(decision)) {
    return fail('decision is null or non-object');
  }

  const expansion = hasActionExpansion(decision);
  if (expansion) {
    return fail(`action expansion forbidden: ${expansion}`);
  }

  for (const value of Object.values(decision)) {
    if (stringLooksInvented(value)) {
      return fail('invented selector, url, or unsafe action string');
    }
  }

  if (decision.schemaVersion !== CAUSAL_PLAN_SCHEMA_VERSION) {
    return fail(`unsupported schemaVersion: ${String(decision.schemaVersion)}`);
  }

  const decisionKind = decision.decision;
  if (decisionKind !== 'EXPERIMENT' && decisionKind !== 'ABSTAIN' && decisionKind !== 'PROMOTE_RECIPE') {
    return fail(`invalid decision: ${String(decisionKind)}`);
  }

  const allowedKeys =
    decisionKind === 'EXPERIMENT'
      ? EXPERIMENT_KEYS
      : decisionKind === 'ABSTAIN'
        ? ABSTAIN_KEYS
        : PROMOTE_KEYS;
  const extras = extraKeys(decision, allowedKeys);
  if (extras.length > 0) {
    return fail(`unknown fields: ${extras.join(',')}`);
  }

  if (typeof decision.reasonCode !== 'string' || !isAllowedReasonCode(decision.reasonCode)) {
    return fail(`unknown or missing reasonCode: ${String(decision.reasonCode)}`);
  }

  if (!isFiniteNumber(decision.confidence)) {
    return fail('missing or non-finite confidence');
  }
  if (decision.confidence < 0 || decision.confidence > 1) {
    return fail(`confidence out of bounds [0, 1]: ${decision.confidence}`);
  }

  if (decision.expectedOutcome !== undefined) {
    if (
      typeof decision.expectedOutcome !== 'string' ||
      !isAllowedExpectedOutcome(decision.expectedOutcome)
    ) {
      return fail(`invalid expectedOutcome: ${String(decision.expectedOutcome)}`);
    }
  }

  if (!packetEpochMatches(packet, now)) {
    return fail('epoch or document is not current');
  }

  if (decisionKind === 'ABSTAIN') {
    const abstain: CausalPlannerDecisionV1 = {
      schemaVersion: 'causal-plan-1',
      decision: 'ABSTAIN',
      reasonCode: decision.reasonCode,
      confidence: decision.confidence,
    };
    if (decision.expectedOutcome !== undefined) {
      abstain.expectedOutcome = decision.expectedOutcome;
    }
    return { ok: true, decision: abstain };
  }

  if (decisionKind === 'PROMOTE_RECIPE') {
    if (opts?.promotionGatePass !== true) {
      return fail('PROMOTE_RECIPE rejected: promotionGatePass is not true');
    }
    if (typeof decision.hypothesisRef !== 'string' || !HYPOTHESIS_REF_RE.test(decision.hypothesisRef)) {
      return fail('missing or malformed hypothesisRef');
    }
    const hypRef = decision.hypothesisRef as `hypothesis:h${number}`;
    if (!packet.hypotheses.some((h) => h.ref === hypRef)) {
      return fail(`unknown hypothesisRef: ${hypRef}`);
    }
    const promote: CausalPlannerDecisionV1 = {
      schemaVersion: 'causal-plan-1',
      decision: 'PROMOTE_RECIPE',
      hypothesisRef: hypRef,
      reasonCode: decision.reasonCode,
      confidence: decision.confidence,
    };
    if (decision.expectedOutcome !== undefined) {
      promote.expectedOutcome = decision.expectedOutcome;
    }
    return { ok: true, decision: promote };
  }

  if (typeof decision.experimentRef !== 'string' || !EXPERIMENT_REF_RE.test(decision.experimentRef)) {
    return fail('missing or malformed experimentRef');
  }
  if (typeof decision.hypothesisRef !== 'string' || !HYPOTHESIS_REF_RE.test(decision.hypothesisRef)) {
    return fail('missing or malformed hypothesisRef');
  }

  const experimentRef = decision.experimentRef as `experiment:x${number}`;
  const hypothesisRef = decision.hypothesisRef as `hypothesis:h${number}`;

  const selected = packet.availableExperiments.find((e) => e.ref === experimentRef);
  if (!selected) {
    return fail(`unknown experimentRef: ${experimentRef}`);
  }
  if (!packet.hypotheses.some((h) => h.ref === hypothesisRef)) {
    return fail(`unknown hypothesisRef: ${hypothesisRef}`);
  }

  const riskErr = finiteRisks(selected);
  if (riskErr) return fail(riskErr);

  const refErr = validateActionRefs(selected);
  if (refErr) return fail(refErr);

  if (containsForbiddenToken(selected.interventionVariable) || looksLikeSelectorOrUrl(selected.interventionVariable)) {
    return fail('unsafe interventionVariable');
  }

  if (!isFiniteNumber(packet.policy.remainingInterventions) || packet.policy.remainingInterventions <= 0) {
    return fail('remainingInterventions is 0');
  }

  if (selected.expectedHealthRisk > packet.policy.maxExperimentRisk) {
    return fail('expectedHealthRisk exceeds maxExperimentRisk');
  }
  if (selected.privacyRisk > packet.policy.maxPrivacyRisk) {
    return fail('privacyRisk exceeds maxPrivacyRisk');
  }
  if (selected.rollbackConfidence < packet.policy.minRollbackConfidence) {
    return fail('rollbackConfidence below minimum');
  }

  if (packet.policy.requiresSingleVariable && selected.oneVariable !== true) {
    return fail('one-variable invariant violated');
  }
  if (selected.oneVariable === false) {
    return fail('one-variable invariant violated');
  }

  const accepted: CausalPlannerDecisionV1 = {
    schemaVersion: 'causal-plan-1',
    decision: 'EXPERIMENT',
    experimentRef,
    hypothesisRef,
    reasonCode: decision.reasonCode,
    confidence: decision.confidence,
  };
  if (decision.expectedOutcome !== undefined) {
    accepted.expectedOutcome = decision.expectedOutcome;
  }
  return { ok: true, decision: accepted };
}
