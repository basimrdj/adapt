import { PageSignalBatch, DomAction, HealthVector, RuntimeOpAction, CausalPageObservationBatch, UserIntentEnvelope } from './types';

/**
 * Message protocol definitions between content scripts and background service worker.
 */

export type ContentToBackgroundMessage =
  | {
      v: 1;
      type: 'PAGE_SENSOR_READY';
      navigationId: string;
      url: string;
      origin: string;
    }
  | {
      v: 1;
      type: 'PAGE_SIGNAL_BATCH';
      navigationId: string;
      payload: PageSignalBatch;
    }
  | {
      v: 1;
      type: 'CAUSAL_OBSERVATION_BATCH';
      navigationId: string;
      payload: CausalPageObservationBatch;
    }
  | {
      v: 1;
      type: 'USER_INTENT_ENVELOPE';
      navigationId: string;
      payload: UserIntentEnvelope;
    }
  | {
      v: 1;
      type: 'HEALTH_SNAPSHOT';
      navigationId: string;
      txId?: string;
      payload: HealthVector;
    }
  | {
      v: 1;
      type: 'DOM_ACTION_RESULT';
      navigationId: string;
      actionId: string;
      txId?: string;
      operation?: 'apply' | 'rollback';
      success: boolean;
      error?: string;
    }
  | {
      v: 1;
      type: 'PAGE_FILTER_MAIN_SCRIPTLET';
      ruleId: string;
      name: string;
      args: string[];
    };

export type BackgroundToContentMessage =
  | {
      v: 1;
      type: 'APPLY_DOM_ACTION';
      txId: string;
      payload: DomAction;
      documentId?: string;
    }
  | {
      v: 1;
      type: 'ROLLBACK_DOM_ACTION';
      txId: string;
      actionId: string;
      documentId?: string;
    }
  | {
      v: 1;
      type: 'REQUEST_HEALTH_SNAPSHOT';
      txId?: string;
    }
  | {
      v: 1;
      type: 'EXECUTE_RUNTIME_OP';
      txId: string;
      payload: RuntimeOpAction;
    };
