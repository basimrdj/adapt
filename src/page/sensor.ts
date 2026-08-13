import { PageSignalBatch, HealthVector } from '../shared/types';
import { extractGeometrySignals } from './geometry';
import { extractSemanticSignals } from './semantic-signals';
import { extractInteractionSignals } from './interaction-health';
import { MutationPipeline } from './mutations';
import { DomActionExecutor } from './dom-actions';
import { ContentToBackgroundMessage, BackgroundToContentMessage } from '../shared/messages';
import { calculateHealthVector } from '../core/health/scorer';
import { OpaqueTargetRegistry } from './opaque-targets';

export class PageSensor {
  private navigationId: string;
  private mutationPipeline: MutationPipeline;
  private domExecutor: DomActionExecutor;
  private debounceTimer: number | null = null;
  private readonly targets = new OpaqueTargetRegistry();

  constructor(navigationId: string) {
    this.navigationId = navigationId;
    this.domExecutor = new DomActionExecutor(this.targets);
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
    chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage, _sender, sendResponse) => {
      const response = this.handleBackgroundMessage(message);
      sendResponse(response);
      return false;
    });

    // Listen for SPA navigation events
    window.addEventListener('popstate', () => this.handleSpaTransition());
    window.addEventListener('hashchange', () => this.handleSpaTransition());

    // Schedule initial signals on page load / DOMContentLoaded
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.scheduleSignalBatch());
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

    // Causal ingestion is queued first; the background can then decide whether
    // the legacy deterministic fallback is still needed for this batch.
    this.sendMessage({
      v: 1,
      type: 'CAUSAL_OBSERVATION_BATCH',
      navigationId: this.navigationId,
      payload: {
        timestamp: Date.now(),
        pageSignals: batch,
        elements: this.targets.observe(),
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

  private handleBackgroundMessage(message: BackgroundToContentMessage): { success: boolean; actionId?: string } {
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
