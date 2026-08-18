import { EvidencePacket, AdaptationPlan, PolicyValidationResult } from './types';
import { StrategyAction } from '../types';

/** Same audited grammars as the page-filter compiler's set-constant scriptlet. */
const STEALTH_UNSAFE_PATH_ROOTS = new Set([
  'Array', 'Atomics', 'BigInt', 'Boolean', 'Date', 'Document', 'Error', 'Function', 'JSON',
  'Math', 'Number', 'Object', 'Promise', 'Proxy', 'Reflect', 'RegExp', 'String', 'Symbol',
  'Uint8Array', 'Window', 'chrome', 'document', 'globalThis', 'location', 'navigator', 'window',
]);

function isStealthSafePath(value: string): boolean {
  const segments = value.split('.');
  if (segments.length === 0 || segments.length > 8) return false;
  if (!segments.every((segment) => /^[A-Za-z_$][\w$]{0,63}$/.test(segment))) return false;
  if (segments.some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) return false;
  return !STEALTH_UNSAFE_PATH_ROOTS.has(segments[0] ?? '');
}

function isStealthConstantValue(value: string): boolean {
  if (value === '' || /^(undefined|null|true|false|noopFunc|noopCallbackFunc|noopPromiseResolve|noopPromiseReject|trueFunc|falseFunc|emptyObj|emptyArray|emptyArr)$/.test(value)) return true;
  return /^-?\d{1,6}(?:\.\d{1,3})?$/.test(value);
}

/** Decodes the audited `path=value` parameter grammar; null when outside it. */
export function decodeStealthConstantParameter(parameter: string): { path: string; value: string } | null {
  const equals = parameter.indexOf('=');
  if (equals <= 0 || equals !== parameter.lastIndexOf('=')) return null;
  const path = parameter.slice(0, equals);
  const value = parameter.slice(equals + 1);
  if (!isStealthSafePath(path) || !isStealthConstantValue(value)) return null;
  return { path, value };
}

/** Mirrors ADAPTATION_PLAN_JSON_SCHEMA's hypothesis.category enum. Enforced here
 *  (not only by the schema) because non-Azure endpoints have no strict
 *  structured-output guarantee — this class is the only guard on that path. */
const HYPOTHESIS_CATEGORIES: ReadonlySet<string> = new Set([
  'FULLSCREEN_GATE',
  'SCROLL_LOCK_GATE',
  'BAIT_DETECTOR',
  'PROBE_DETECTOR',
  'BENIGN_CONSENT',
  'BENIGN_LOGIN',
  'BENIGN_NEWSLETTER',
  'UNKNOWN',
]);

/** Free-text plan fields (explanation, abortConditions, explanationCodes) are the
 *  only plan channel that is neither enum- nor ref-constrained, and page-controlled
 *  text reaches the model through evidence textSignals. Prose must never carry
 *  URLs, code, or JSON blobs — prompt-injection echo found by the real-model eval
 *  (inject_010/040/070/100 smuggled a fake plan JSON into explanation text). */
const PROSE_FORBIDDEN_RE = /https?:\/\/|javascript:|<\s*script|[{}]|\bwindow\.[A-Za-z]|\bdocument\.[A-Za-z]/i;
const PROSE_MAX_LENGTH = 400;

/** Mirrors ADAPTATION_PLAN_JSON_SCHEMA's selectedStrategyTier enum (non-Azure guard). */
const STRATEGY_TIERS: ReadonlySet<string> = new Set(['S1', 'S2', 'S3', 'ABSTAIN']);
/** Plans are one-intervention proposals; more actions than this is never legitimate. */
const MAX_PLAN_ACTIONS = 4;
/** Prose channels stay small: bounded arrays of bounded strings. */
const MAX_PROSE_ENTRIES = 8;

export class PolicyValidator {
  /**
   * Strictly validates an AI proposed AdaptationPlan against the EvidencePacket
   * and maps approved proposals to Phase 1 StrategyAction primitives.
   */
  public validate(evidence: EvidencePacket, rawPlan: unknown): PolicyValidationResult {
    const reasons: string[] = [];

    if (!rawPlan || typeof rawPlan !== 'object') {
      return { valid: false, reasons: ['Plan is null or non-object'] };
    }

    const plan = rawPlan as AdaptationPlan;

    // 1. Validate Schema Version & Decision
    if (plan.schemaVersion !== 1) {
      reasons.push(`Unsupported schemaVersion: ${plan.schemaVersion}`);
    }

    if (!['ADAPT', 'OBSERVE', 'ABSTAIN'].includes(plan.decision)) {
      reasons.push(`Invalid decision: ${plan.decision}`);
    }

    // 2. Validate Hypothesis & Confidence
    if (
      !plan.hypothesis ||
      typeof plan.hypothesis.confidence !== 'number' ||
      !Number.isFinite(plan.hypothesis.confidence)
    ) {
      reasons.push('Missing or invalid hypothesis.confidence');
    } else if (plan.hypothesis.confidence < 0 || plan.hypothesis.confidence > 1.0) {
      reasons.push(`Confidence out of bounds [0, 1]: ${plan.hypothesis.confidence}`);
    }

    if (
      !plan.hypothesis ||
      typeof plan.hypothesis.category !== 'string' ||
      !HYPOTHESIS_CATEGORIES.has(plan.hypothesis.category)
    ) {
      reasons.push(`Unknown hypothesis.category: ${String(plan.hypothesis?.category)}`);
    }

    // Tier enum (mirrors the JSON schema; non-Azure endpoints have no strict mode).
    if (typeof plan.selectedStrategyTier !== 'string' || !STRATEGY_TIERS.has(plan.selectedStrategyTier)) {
      reasons.push(`Invalid selectedStrategyTier: ${String(plan.selectedStrategyTier)}`);
    }

    // Bounded prose arrays — an unbounded list is a memory/log injection channel.
    if (Array.isArray(plan.abortConditions) && plan.abortConditions.length > MAX_PROSE_ENTRIES) {
      reasons.push(`abortConditions exceeds ${MAX_PROSE_ENTRIES} entries`);
    }
    if (Array.isArray(plan.explanationCodes) && plan.explanationCodes.length > MAX_PROSE_ENTRIES) {
      reasons.push(`explanationCodes exceeds ${MAX_PROSE_ENTRIES} entries`);
    }

    // Free-text hygiene: reject injection echo / smuggled content in the only
    // unconstrained prose channels (see PROSE_FORBIDDEN_RE).
    const proseFields: string[] = [
      ...(plan.hypothesis && typeof plan.hypothesis.explanation === 'string' ? [plan.hypothesis.explanation] : []),
      ...(Array.isArray(plan.abortConditions) ? plan.abortConditions : []),
      ...(Array.isArray(plan.explanationCodes) ? plan.explanationCodes : []),
    ].filter((value): value is string => typeof value === 'string');
    for (const text of proseFields) {
      if (text.length > PROSE_MAX_LENGTH || PROSE_FORBIDDEN_RE.test(text)) {
        reasons.push('Free-text plan field carries URL, code, JSON blob, or exceeds 400 chars');
        break;
      }
    }

    // 3. Validate Actions & Opaque Reference Matching
    if (!Array.isArray(plan.actions)) {
      reasons.push('Plan.actions is not an array');
    } else {
      if (plan.actions.length > MAX_PLAN_ACTIONS) {
        reasons.push(`Plan.actions exceeds ${MAX_PLAN_ACTIONS} entries (${plan.actions.length})`);
      }
      // An ADAPT decision with no actions stages an empty transaction — the
      // honest "nothing to do" decision is ABSTAIN (per the planner contract).
      if (plan.decision === 'ADAPT' && plan.actions.length === 0) {
        reasons.push('ADAPT decision carries an empty actions array (use ABSTAIN)');
      }
      const validElementRefs = new Set(evidence.candidateElements.map((e) => e.ref));
      const validRequestRefs = new Set(evidence.candidateRequests.map((r) => r.ref));
      const allowedActions = new Set(evidence.availableActions);

      for (let i = 0; i < plan.actions.length; i++) {
        const act = plan.actions[i];
        if (!act) continue;
        if (!allowedActions.has(act.actionType)) {
          reasons.push(`Action ${act.actionType} is not in availableActions`);
        }

        // If targetRef is provided, it MUST exist in the evidence packet
        if (act.targetRef && act.targetRef.length > 0) {
          const isElement = act.targetRef.startsWith('element:');
          const isRequest = act.targetRef.startsWith('request:');

          if (isElement && !validElementRefs.has(act.targetRef)) {
            reasons.push(`Action [${i}] references non-existent element: ${act.targetRef}`);
          } else if (isRequest && !validRequestRefs.has(act.targetRef)) {
            reasons.push(`Action [${i}] references non-existent request: ${act.targetRef}`);
          } else if (!isElement && !isRequest) {
            reasons.push(`Action [${i}] has invalid targetRef format: ${act.targetRef}`);
          }
        }

        if (act.actionType === 'DOM_PRESERVE_BAIT') {
          if (!act.targetRef || !validElementRefs.has(act.targetRef)) {
            reasons.push(`Action [${i}] bait preservation requires a valid opaque element ref`);
          }
          if (act.parameter) reasons.push(`Action [${i}] bait preservation does not accept parameters`);
        }
        if (act.actionType === 'TARGETED_SESSION_DNR') {
          if (!act.targetRef || !validRequestRefs.has(act.targetRef)) {
            reasons.push(`Action [${i}] targeted session DNR requires a valid opaque request ref`);
          }
          if (act.parameter) reasons.push(`Action [${i}] targeted session DNR does not accept parameters`);
        }
        if (act.actionType === 'STEALTH_SET_CONSTANT') {
          if (!act.parameter || !decodeStealthConstantParameter(act.parameter)) {
            reasons.push(`Action [${i}] stealth constant parameter must be audited 'safePath=constantValue' grammar`);
          }
        }
      }
    }

    // 4. Validate Verification parameters
    if (
      !plan.verification ||
      typeof plan.verification.maxWaitMs !== 'number' ||
      !Number.isFinite(plan.verification.maxWaitMs) ||
      plan.verification.maxWaitMs < 0 ||
      plan.verification.maxWaitMs > 10000
    ) {
      reasons.push('Invalid verification.maxWaitMs (must be 0-10000ms finite number)');
    }

    if (
      plan.verification &&
      (typeof plan.verification.expectedHealthDelta !== 'number' ||
        !Number.isFinite(plan.verification.expectedHealthDelta))
    ) {
      reasons.push('Invalid verification.expectedHealthDelta (must be finite number)');
    }

    if (reasons.length > 0) {
      return { valid: false, reasons };
    }

    // Map validated proposals to Phase 1 StrategyAction primitives
    const mappedStrategyActions: StrategyAction[] = [];
    if (plan.decision === 'ADAPT') {
      for (const act of plan.actions) {
        switch (act.actionType) {
          case 'DOM_REMOVE_OVERLAY':
            mappedStrategyActions.push({
              id: `ai_act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'DOM_REMOVE_OVERLAY',
            });
            break;
          case 'DOM_RESTORE_SCROLL':
            mappedStrategyActions.push({
              id: `ai_act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'DOM_RESTORE_SCROLL',
            });
            break;
          case 'DOM_RESTORE_POINTER_EVENTS':
            mappedStrategyActions.push({
              id: `ai_act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'DOM_RESTORE_POINTER_EVENTS',
            });
            break;
          case 'DOM_PRESERVE_BAIT':
            mappedStrategyActions.push({
              id: `ai_act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'BAIT_PRESERVE_LAYOUT',
              targetRef: act.targetRef as `element:e${number}`,
            });
            break;
          case 'DOM_HIDE_CANDIDATE':
            mappedStrategyActions.push({
              id: `ai_act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'DOM_COLLAPSE',
            });
            break;
          // NET_TEMP_BLOCK is deliberately NOT mapped: no evidence builder offers
          // it, and its free-text parameter would flow into a DNR urlFilter with
          // no grammar guard. If a future builder offers it, gate the parameter
          // with the same audited-grammar discipline as STEALTH_SET_CONSTANT.
          case 'TARGETED_SESSION_DNR':
            break;
        }
      }
    }

    // Stealth constants ride alongside the primitive mapping: applied MAIN-world,
    // verified by the transaction outcome, persisted per site only when healthy.
    const stealthConstants: Array<{ path: string; value: string }> = [];
    if (plan.decision === 'ADAPT') {
      for (const act of plan.actions) {
        if (act.actionType !== 'STEALTH_SET_CONSTANT') continue;
        const decoded = decodeStealthConstantParameter(act.parameter ?? '');
        if (decoded && stealthConstants.length < 4) stealthConstants.push(decoded);
      }
    }

    return {
      valid: true,
      reasons: [],
      sanitizedPlan: plan,
      mappedStrategyActions,
      stealthConstants,
    };
  }
}
