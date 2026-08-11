import { PageSignalBatch, HealthVector } from '../shared/types';
import { extractGeometrySignals } from './geometry';
import { extractSemanticSignals } from './semantic-signals';
import { extractInteractionSignals } from './interaction-health';
import { MutationPipeline } from './mutations';
import { DomActionExecutor } from './dom-actions';
import { ContentToBackgroundMessage, BackgroundToContentMessage } from '../shared/messages';
import { calculateHealthVector } from '../core/health/scorer';

export class PageSensor {
  private navigationId: string;
  private mutationPipeline: MutationPipeline;
  private domExecutor: DomActionExecutor;
  private debounceTimer: number | null = null;

  constructor(navigationId: string) {
    this.navigationId = navigationId;
    this.domExecutor = new DomActionExecutor();
    this.mutationPipeline = new MutationPipeline(() => this.scheduleSignalBatch());
  }

  public init(): void {
    // Notify background that sensor is ready
    this.sendMessage({
      v: 1,
      type: 'PAGE_SENSOR_READY',
      navigationId: this.navigationId,
      url: window.location.href,
      origin: window.location.origin,
    });

    this.mutationPipeline.start();

    // Listen for background commands
    chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage) => {
      this.handleBackgroundMessage(message);
    });

    // Schedule initial signals on page load / DOMContentLoaded
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.scheduleSignalBatch());
    } else {
      this.scheduleSignalBatch();
    }
  }

  private scheduleSignalBatch(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.collectAndSendBatch();
    }, 60);
  }

  public collectAndSendBatch(): PageSignalBatch {
    const geometry = extractGeometrySignals();
    const semantic = extractSemanticSignals();
    const interaction = extractInteractionSignals();
    const mutation = this.mutationPipeline.getSignals();

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

  private handleBackgroundMessage(message: BackgroundToContentMessage): void {
    if (!message || message.v !== 1) return;

    switch (message.type) {
      case 'APPLY_DOM_ACTION': {
        const success = this.domExecutor.applyAction(message.payload);
        this.sendMessage({
          v: 1,
          type: 'DOM_ACTION_RESULT',
          navigationId: this.navigationId,
          actionId: message.payload.id,
          success,
        });
        break;
      }

      case 'ROLLBACK_DOM_ACTION': {
        this.domExecutor.rollbackAction(message.actionId);
        break;
      }

      case 'REQUEST_HEALTH_SNAPSHOT': {
        this.getHealthSnapshot(message.txId);
        break;
      }
    }
  }

  private sendMessage(msg: ContentToBackgroundMessage): void {
    try {
      chrome.runtime.sendMessage(msg);
    } catch {
      // Worker might be sleeping; ignored safely
    }
  }
}
