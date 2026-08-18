import {
  GeometrySignal,
  HealthVector,
  InteractionSignal,
  MutationSignal,
  DomAction,
  OpaqueElementObservation,
  PageSignalBatch,
  SemanticSignal,
} from '../shared/types';
import { extractGeometrySignals } from './geometry';
import { extractSemanticSignals } from './semantic-signals';
import { extractInteractionSignals } from './interaction-health';
import { MutationPipeline } from './mutations';
import { DomActionExecutor } from './dom-actions';
import { ContentToBackgroundMessage, BackgroundToContentMessage } from '../shared/messages';
import { calculateHealthVector } from '../core/health/scorer';
import { OpaqueTargetRegistry } from './opaque-targets';
import { createIntentEnvelope, protectedTransactionIntentFor } from './intent-envelope';
import { SurvivorDiscoveryEngine } from './survivor-discovery';

const MAX_BATCH_WAIT_MS = 500;
const INTENT_WINDOW_MS = 10_000;
const MAX_INTENT_ENVELOPES_PER_WINDOW = 20;
/** Cold-worker handshake: a READY delivered while the service worker is still
 * starting can arrive before the navigation epoch exists and is dropped without
 * a response. READY is retried (bounded backoff) until the background acks this
 * document, then one full-state batch is flushed so a static page whose initial
 * batch also fell into that window never stays unprotected. */
const READY_RETRY_MAX_ATTEMPTS = 8;
const READY_RETRY_BASE_MS = 500;
const READY_RETRY_MAX_DELAY_MS = 4_000;

function elementRefFromOpaqueRefs(refs: readonly string[]): `element:e${number}` | undefined {
  const ref = refs.find((value) => value.startsWith('element:e'));
  return ref as `element:e${number}` | undefined;
}

function autonomyDomActions(
  primitiveId: string,
  opaqueRefs: readonly string[],
  txId: string
): DomAction[] | null {
  const targetRef = elementRefFromOpaqueRefs(opaqueRefs);
  const action = (type: DomAction['type'], index: number, target?: `element:e${number}`): DomAction => ({
    id: `autonomy_${txId}_${primitiveId}_${index}`,
    type,
    ...(target ? { targetRef: target } : {}),
  });
  switch (primitiveId) {
    case 'TOGGLE_COSMETIC_ACTION':
      return targetRef ? [action('DOM_REMOVE_OVERLAY', 0, targetRef)] : null;
    case 'PRESERVE_BAIT':
      return targetRef ? [action('DOM_PRESERVE_BAIT_CANDIDATE', 0, targetRef)] : null;
    case 'RESTORE_LAYOUT':
      return targetRef ? [action('BAIT_PRESERVE_LAYOUT', 0, targetRef)] : null;
    case 'REMOVE_REACTION_UI':
      return targetRef
        ? [action('DOM_REMOVE_OVERLAY', 0, targetRef), action('DOM_RESTORE_SCROLL', 1)]
        : null;
    case 'RESTORE_SCROLL':
      return [action('DOM_RESTORE_SCROLL', 0)];
    case 'RESTORE_POINTER_INTERACTION':
      return [action('DOM_RESTORE_POINTER_EVENTS', 0)];
    case 'PLAYER_HEALTH_RECOVERY':
      return [action('DOM_RESTORE_SCROLL', 0), action('DOM_RESTORE_POINTER_EVENTS', 1), action('DOM_RESTORE_PLAYER', 2)];
    default:
      return null;
  }
}

export class PageSensor {
  private navigationId: string;
  private mutationPipeline: MutationPipeline;
  private domExecutor: DomActionExecutor;
  private debounceTimer: number | null = null;
  private firstDeferredAt: number | null = null;
  private intentWindowStart = 0;
  private intentCount = 0;
  private readonly targets = new OpaqueTargetRegistry();
  private readonly survivorDiscovery: SurvivorDiscoveryEngine;
  private sensorFaults = 0;
  private readyAcked = false;
  private readyRetryActive = false;
  private readyAttempts = 0;

  constructor(navigationId: string) {
    this.navigationId = navigationId;
    this.domExecutor = new DomActionExecutor(this.targets, (actionId, reHideCount) => {
      // Post-hoc re-hide telemetry (P4): additive DOM_ACTION_RESULT follow-up.
      // Carries no hideSelectors, so the cosmetic-learning ack path ignores it.
      this.sendMessage({
        v: 1,
        type: 'DOM_ACTION_RESULT',
        navigationId: this.navigationId,
        actionId,
        operation: 'apply',
        success: true,
        reHideCount,
      });
    });
    this.mutationPipeline = new MutationPipeline(() => this.scheduleSignalBatch());
    this.survivorDiscovery = new SurvivorDiscoveryEngine(navigationId, this.targets);
  }

  public init(): void {
    this.sendReady();

    this.mutationPipeline.start();

    chrome.runtime.onMessage.addListener(
      (message: BackgroundToContentMessage, _sender, sendResponse) => {
        try {
          const response = this.handleBackgroundMessage(message);
          sendResponse(response);
        } catch {
          this.sensorFaults++;
          sendResponse({ success: false });
        }
        return false;
      }
    );

    window.addEventListener('popstate', () => this.handleSpaTransition());
    window.addEventListener('hashchange', () => this.handleSpaTransition());
    document.addEventListener(
      'click',
      (event) => {
        try {
          // Synthetic clicks (element.click(), dispatchEvent) never create
          // background work — a hostile page can emit thousands per second.
          // Genuine user gestures are additionally rate-limited per document
          // so intent traffic stays bounded no matter what the page does.
          if (!event.isTrusted) return;
          const now = Date.now();
          if (now - this.intentWindowStart >= INTENT_WINDOW_MS) {
            this.intentWindowStart = now;
            this.intentCount = 0;
          }
          if (this.intentCount >= MAX_INTENT_ENVELOPES_PER_WINDOW) return;
          this.intentCount += 1;
          const intent = createIntentEnvelope(event, this.targets);
          if (!intent) return;
          this.sendMessage({
            v: 1,
            type: 'USER_INTENT_ENVELOPE',
            navigationId: this.navigationId,
            payload: intent,
          });
          // Layer-2 trigger: a trusted click on a flow-shaped element begins
          // protected transaction mode for this tab (covers checkout/3DS flows
          // that never navigate the main frame to a protected host).
          const protectedKind = protectedTransactionIntentFor(event);
          if (protectedKind) {
            this.sendMessage({
              v: 1,
              type: 'PROTECTED_TRANSACTION_INTENT',
              navigationId: this.navigationId,
              kind: protectedKind,
            });
          }
        } catch {
          this.sensorFaults++;
        }
      },
      true
    );

    if (document.readyState === 'loading') {
      document.addEventListener(
        'DOMContentLoaded',
        () => this.scheduleSignalBatch(),
        { once: true }
      );
    } else {
      this.scheduleSignalBatch();
    }
  }

  private handleSpaTransition(): void {
    this.mutationPipeline.reset();
    this.sendReady();
    this.scheduleSignalBatch();
  }

  /**
   * READY handshake. Before the first background ack, a single retry chain
   * re-sends READY with bounded backoff — this is the cold-worker window guard
   * (see READY_RETRY_* constants). Once acked, READY is fire-and-forget: the
   * background already holds this document's epoch, so SPA-transition READYs
   * land on a warm handler.
   */
  private sendReady(): void {
    if (this.readyAcked) {
      this.sendMessage({
        v: 1,
        type: 'PAGE_SENSOR_READY',
        navigationId: this.navigationId,
        url: window.location.href,
        origin: window.location.origin,
      });
      return;
    }
    if (this.readyRetryActive) return; // one chain coalesces init + SPA bursts
    this.readyRetryActive = true;
    this.sendReadyAttempt();
  }

  private sendReadyAttempt(): void {
    const response = this.sendMessage({
      v: 1,
      type: 'PAGE_SENSOR_READY',
      navigationId: this.navigationId,
      url: window.location.href,
      origin: window.location.origin,
    });
    void Promise.resolve(response).then((ack) => {
      if (this.readyAcked) return;
      const acknowledged = Boolean(
        ack && typeof ack === 'object' && (ack as { success?: unknown }).success === true
      );
      if (acknowledged) {
        this.readyAcked = true;
        this.readyRetryActive = false;
        // The initial batch may have been dropped in the same cold-worker
        // window; a fresh full-state batch converges the background's view.
        this.scheduleSignalBatch();
        return;
      }
      if (this.readyAttempts >= READY_RETRY_MAX_ATTEMPTS) {
        this.readyRetryActive = false;
        return;
      }
      this.readyAttempts += 1;
      const delay = Math.min(
        READY_RETRY_BASE_MS * Math.pow(1.7, this.readyAttempts - 1),
        READY_RETRY_MAX_DELAY_MS
      );
      window.setTimeout(() => this.sendReadyAttempt(), delay);
    });
  }

  private scheduleSignalBatch(): void {
    // Trailing-edge starvation guard (mirrors MutationPipeline): continuous
    // re-scheduling must not defer the batch forever.
    if (this.debounceTimer !== null) {
      if (this.firstDeferredAt !== null && Date.now() - this.firstDeferredAt >= MAX_BATCH_WAIT_MS) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
        this.firstDeferredAt = null;
        this.collectAndSendBatch();
        return;
      }
      clearTimeout(this.debounceTimer);
    } else {
      this.firstDeferredAt = Date.now();
    }

    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.firstDeferredAt = null;
      this.collectAndSendBatch();
    }, 60);
  }

  private probe<T>(producer: () => T, fallback: () => T): T {
    try {
      return producer();
    } catch {
      this.sensorFaults++;
      return fallback();
    }
  }

  private neutralGeometry(): GeometrySignal {
    return {
      viewportWidth: window.innerWidth || document.documentElement?.clientWidth || 1024,
      viewportHeight: window.innerHeight || document.documentElement?.clientHeight || 768,
      hasFixedOverlay: false,
      overlayCoverageRatio: 0,
      bodyScrollLocked: false,
      htmlScrollLocked: false,
      modalCount: 0,
      mainContentHidden: false,
      mainContentHeight: 0,
    };
  }

  private neutralSemantic(): SemanticSignal {
    return {
      detectedPhrases: [],
      adblockKeywordDensity: 0,
      confidenceScore: 0,
    };
  }

  private neutralInteraction(): InteractionSignal {
    return {
      pointerEventsSuppressed: false,
      bodyOverflowHidden: false,
      contentCovered: false,
    };
  }

  private neutralMutation(): MutationSignal {
    return {
      mutationRatePerSecond: 0,
      rapidReinsertionDetected: false,
      overlayReinsertedCount: 0,
      degradationState: 'NORMAL',
    };
  }

  public collectAndSendBatch(): PageSignalBatch {
    const geometry = this.probe(
      () => extractGeometrySignals(),
      () => this.neutralGeometry()
    );
    const semantic = this.probe(
      () => extractSemanticSignals(),
      () => this.neutralSemantic()
    );
    const interaction = this.probe(
      () => extractInteractionSignals(),
      () => this.neutralInteraction()
    );
    const mutation = this.probe(
      () => this.mutationPipeline.getSignals(),
      () => this.neutralMutation()
    );

    const suspectedDetectorTypes: string[] = [];
    if (semantic.detectedPhrases.length > 0) suspectedDetectorTypes.push('SEMANTIC_PROMPT');
    if (geometry.hasFixedOverlay) suspectedDetectorTypes.push('FULLSCREEN_GATE');
    if (geometry.bodyScrollLocked || geometry.htmlScrollLocked) suspectedDetectorTypes.push('SCROLL_LOCK');
    if (interaction.pointerEventsSuppressed) suspectedDetectorTypes.push('POINTER_LOCK');

    const batch: PageSignalBatch = {
      navigationId: this.navigationId,
      timestamp: Date.now(),
      geometry,
      semantic,
      interaction,
      mutation,
      suspectedDetectorTypes,
    };

    const elements = this.probe<OpaqueElementObservation[]>(
      () => this.targets.observe(semantic),
      () => []
    );
    const survivorObservation = this.probe(
      () => this.survivorDiscovery.observe(semantic, batch, elements),
      () => ({ survivors: [], resourceAssociations: [] })
    );

    this.sendMessage({
      v: 1,
      type: 'CAUSAL_OBSERVATION_BATCH',
      navigationId: this.navigationId,
      payload: {
        timestamp: Date.now(),
        pageSignals: batch,
        elements,
        survivors: survivorObservation.survivors,
        resourceAssociations: survivorObservation.resourceAssociations,
      },
    });

    this.sendMessage({
      v: 1,
      type: 'PAGE_SIGNAL_BATCH',
      navigationId: this.navigationId,
      payload: batch,
    });

    return batch;
  }

  public getHealthSnapshot(txId?: string): HealthVector {
    const batch = this.collectAndSendBatch();
    const health = calculateHealthVector(batch);

    this.sendMessage({
      v: 1,
      type: 'HEALTH_SNAPSHOT',
      navigationId: this.navigationId,
      txId,
      payload: health,
    });

    return health;
  }

  private handleBackgroundMessage(
    message: BackgroundToContentMessage
  ): { success: boolean; actionId?: string; actionIds?: string[] } {
    if (!message || message.v !== 1) return { success: false };

    switch (message.type) {
      case 'APPLY_DOM_ACTION': {
        const success = this.domExecutor.applyAction(message.payload);
        this.sendMessage({
          v: 1,
          type: 'DOM_ACTION_RESULT',
          navigationId: this.navigationId,
          txId: message.txId,
          operation: 'apply',
          actionId: message.payload.id,
          success,
          hideSelectors: success ? this.domExecutor.hideSelectorsFor(message.payload.id) : [],
        });
        return { success, actionId: message.payload.id };
      }

      case 'ROLLBACK_DOM_ACTION': {
        const success = this.domExecutor.rollbackAction(message.actionId);
        this.sendMessage({
          v: 1,
          type: 'DOM_ACTION_RESULT',
          navigationId: this.navigationId,
          txId: message.txId,
          operation: 'rollback',
          actionId: message.actionId,
          success,
        });
        return { success, actionId: message.actionId };
      }

      case 'REQUEST_HEALTH_SNAPSHOT': {
        this.getHealthSnapshot(message.txId);
        return { success: true };
      }

      case 'EXECUTE_RUNTIME_OP':
        return { success: false };

      case 'APPLY_AUTONOMY_PRIMITIVE': {
        const actions = autonomyDomActions(message.primitiveId, message.opaqueRefs, message.txId);
        if (!actions) return { success: false };
        const applied: string[] = [];
        for (const action of actions) {
          if (!this.domExecutor.applyAction(action)) {
            for (const actionId of applied.reverse()) this.domExecutor.rollbackAction(actionId);
            return { success: false };
          }
          applied.push(action.id);
        }
        const hideSelectors = [...new Set(applied.flatMap((id) => this.domExecutor.hideSelectorsFor(id)))];
        this.sendMessage({
          v: 1,
          type: 'DOM_ACTION_RESULT',
          navigationId: this.navigationId,
          txId: message.txId,
          operation: 'apply',
          actionId: applied[applied.length - 1] ?? '',
          success: true,
          hideSelectors,
        });
        return { success: true, actionIds: applied };
      }

      case 'ROLLBACK_AUTONOMY_PRIMITIVE': {
        let success = true;
        for (const actionId of message.actionIds) {
          success = this.domExecutor.rollbackAction(actionId) && success;
        }
        return { success };
      }
    }
  }

  /**
   * Fire-and-forget transport. Returns the background's response (undefined
   * when the worker is down, the context is gone, or the message type has no
   * response) so the READY handshake can tell acknowledged from dropped.
   */
  private sendMessage(msg: ContentToBackgroundMessage): Promise<unknown> {
    try {
      const pending = chrome.runtime.sendMessage(msg);
      if (pending && typeof pending.catch === 'function') {
        return Promise.resolve(pending).catch(() => {
          // Service worker may have terminated or the extension may be reloading.
          return undefined;
        });
      }
      return Promise.resolve(undefined);
    } catch {
      // Extension context can disappear during reload/navigation.
      return Promise.resolve(undefined);
    }
  }
}
