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
import { createIntentEnvelope } from './intent-envelope';
import { SurvivorDiscoveryEngine } from './survivor-discovery';

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
  private readonly targets = new OpaqueTargetRegistry();
  private readonly survivorDiscovery: SurvivorDiscoveryEngine;
  private sensorFaults = 0;

  constructor(navigationId: string) {
    this.navigationId = navigationId;
    this.domExecutor = new DomActionExecutor(this.targets);
    this.mutationPipeline = new MutationPipeline(() => this.scheduleSignalBatch());
    this.survivorDiscovery = new SurvivorDiscoveryEngine(navigationId, this.targets);
  }

  public init(): void {
    this.sendMessage({
      v: 1,
      type: 'PAGE_SENSOR_READY',
      navigationId: this.navigationId,
      url: window.location.href,
      origin: window.location.origin,
    });

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
          const intent = createIntentEnvelope(event, this.targets);
          if (!intent) return;
          this.sendMessage({
            v: 1,
            type: 'USER_INTENT_ENVELOPE',
            navigationId: this.navigationId,
            payload: intent,
          });
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
    this.sendMessage({
      v: 1,
      type: 'PAGE_SENSOR_READY',
      navigationId: this.navigationId,
      url: window.location.href,
      origin: window.location.origin,
    });
    this.scheduleSignalBatch();
  }

  private scheduleSignalBatch(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);

    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
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

  private sendMessage(msg: ContentToBackgroundMessage): void {
    try {
      const pending = chrome.runtime.sendMessage(msg);
      if (pending && typeof pending.catch === 'function') {
        void pending.catch(() => {
          // Service worker may have terminated or the extension may be reloading.
        });
      }
    } catch {
      // Extension context can disappear during reload/navigation.
    }
  }
}
