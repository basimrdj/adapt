/**
 * Options-page "Test connection" probe (Surgical Fix 1).
 *
 * Sends a tiny synthetic bounded EvidencePacket through the SAME production transport
 * (RemotePlanner.plan) and validates the response with the SAME production
 * PolicyValidator. It never touches a page: no DNR rules, no DOM, no executor, no
 * learned state. The synthetic refs exist only inside this packet; a provider
 * response referencing anything else fails validation, which is the point.
 */

import { EvidencePacket } from '../../shared/ai/types';
import { HealthVector } from '../../shared/types';
import { PolicyValidator } from '../../shared/ai/validator';
import { AiConfig, PlannerHttpError, RemotePlanner } from './remote-planner';
import { recordPlannerFailure } from './status';

export interface ConnectionTestResult {
  providerReached: boolean;
  schemaValid: boolean;
  latencyMs: number | null;
  decision?: string;
  errorClass?: string;
}

export const TEST_REQUEST_REFS = ['request:r990001', 'request:r990002'] as const;

export function buildConnectionTestPacket(): EvidencePacket {
  const neutralHealth: HealthVector = {
    antiBlockReaction: 0,
    contentAvailability: 1,
    interaction: 1,
    scrollability: 1,
    navigationHealth: 1,
    visualObstruction: 0,
    mutationStability: 1,
    confidence: 0.5,
  };
  return {
    schemaVersion: 1,
    transactionId: 'ai_connection_test',
    navigationEpoch: 'options-page-test',
    timestamp: Date.now(),
    siteContext: { originClass: 'unknown', pageTypeEstimate: 'unknown' },
    trigger: { reason: 'CONNECTION_TEST', confidence: 0.5 },
    healthBefore: neutralHealth,
    currentHealth: neutralHealth,
    observedReaction: { detectorTypes: [], antiBlockConfidence: 0, mutationBurstDetected: false },
    candidateElements: [],
    candidateRequests: TEST_REQUEST_REFS.map((ref) => ({
      ref,
      urlDomain: 'redacted',
      resourceType: 'script',
      isBlockedByBaseline: false,
      failureObserved: false,
      thirdParty: true,
    })),
    availableActions: ['TARGETED_SESSION_DNR', 'ABSTAIN'],
    knownConstraints: ['NO_ARBITRARY_CODE', 'OPAQUE_REFS_ONLY', 'NO_MAIN_FRAME_BLOCK', 'PROTECTED_CONTEXTS_ABSTAIN'],
    previousAttempts: [],
  };
}

export async function runPlannerConnectionTest(config: AiConfig): Promise<ConnectionTestResult> {
  const packet = buildConnectionTestPacket();
  const planner = new RemotePlanner(config);
  const startedAt = Date.now();
  try {
    const plan = await planner.plan(packet);
    const latencyMs = Date.now() - startedAt;
    const validation = new PolicyValidator().validate(packet, plan);
    // A transport success whose plan fails production policy is not a working
    // connection — surface it as the last failure so the badge stays honest.
    if (!validation.valid) void recordPlannerFailure('policy');
    return {
      providerReached: true,
      schemaValid: validation.valid,
      latencyMs,
      decision: validation.sanitizedPlan?.decision,
      ...(validation.valid ? {} : { errorClass: 'schema' }),
    };
  } catch (error) {
    return {
      providerReached: false,
      schemaValid: false,
      latencyMs: Date.now() - startedAt,
      // Distinct user-visible classes: auth/ratelimit/server faults carry their
      // status, truncation and schema violations are protocol faults, aborts
      // are timeouts, everything else is transport.
      errorClass: error instanceof PlannerHttpError
        ? `http-${error.status}`
        : error instanceof Error
          ? error.name === 'AbortError'
            ? 'timeout'
            : error.message === 'planner completion truncated at token cap'
              ? 'truncated'
              : error.message.startsWith('planner ')
                ? 'schema'
                : 'transport'
          : 'transport',
    };
  }
}
