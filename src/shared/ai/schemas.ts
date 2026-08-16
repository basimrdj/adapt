/**
 * JSON Schema for OpenAI / Azure Structured Outputs (strict mode compliant).
 * Requires additionalProperties: false, all properties required, explicit typing.
 */

export const ADAPTATION_PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'number' },
    decision: {
      type: 'string',
      enum: ['ADAPT', 'OBSERVE', 'ABSTAIN'],
    },
    hypothesis: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: [
            'FULLSCREEN_GATE',
            'SCROLL_LOCK_GATE',
            'BAIT_DETECTOR',
            'PROBE_DETECTOR',
            'BENIGN_CONSENT',
            'BENIGN_LOGIN',
            'BENIGN_NEWSLETTER',
            'UNKNOWN',
          ],
        },
        confidence: { type: 'number' },
        explanation: { type: 'string' },
      },
      required: ['category', 'confidence', 'explanation'],
      additionalProperties: false,
    },
    selectedStrategyTier: {
      type: 'string',
      enum: ['S1', 'S2', 'S3', 'ABSTAIN'],
    },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          actionType: {
            type: 'string',
            enum: [
              'DOM_REMOVE_OVERLAY',
              'DOM_RESTORE_SCROLL',
              'DOM_RESTORE_POINTER_EVENTS',
              'DOM_PRESERVE_BAIT',
              'DOM_HIDE_CANDIDATE',
              'NET_TEMP_BLOCK',
              'TARGETED_SESSION_DNR',
              'NET_REDIRECT_LOCAL',
              'OBSERVE_MORE',
              'ABSTAIN',
            ],
          },
          targetRef: { type: 'string' },
          parameter: { type: 'string' },
        },
        required: ['actionType', 'targetRef', 'parameter'],
        additionalProperties: false,
      },
    },
    verification: {
      type: 'object',
      properties: {
        expectedHealthDelta: { type: 'number' },
        maxWaitMs: { type: 'number' },
      },
      required: ['expectedHealthDelta', 'maxWaitMs'],
      additionalProperties: false,
    },
    abortConditions: {
      type: 'array',
      items: { type: 'string' },
    },
    explanationCodes: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: [
    'schemaVersion',
    'decision',
    'hypothesis',
    'selectedStrategyTier',
    'actions',
    'verification',
    'abortConditions',
    'explanationCodes',
  ],
  additionalProperties: false,
} as const;
