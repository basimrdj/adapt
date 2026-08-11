import { MutationSignal } from '../shared/types';
import { ADAPT_THRESHOLDS } from '../shared/constants';

export class MutationPipeline {
  private observer: MutationObserver | null = null;
  private mutationCount = 0;
  private lastResetTime = Date.now();
  private degradationState: 'NORMAL' | 'COALESCED' | 'SAMPLING' | 'PAUSED' = 'NORMAL';
  private reinsertionCount = 0;
  private onBatchCallback?: () => void;
  private debounceTimer: number | null = null;

  constructor(onBatchCallback?: () => void) {
    this.onBatchCallback = onBatchCallback;
  }

  public start(): void {
    if (this.observer) return;

    this.observer = new MutationObserver((mutations) => {
      this.mutationCount += mutations.length;
      this.checkDegradation();

      if (this.degradationState === 'PAUSED') {
        return; // Mute processing during storm
      }

      const debounceDelay =
        this.degradationState === 'SAMPLING'
          ? 300
          : this.degradationState === 'COALESCED'
          ? 150
          : 60;

      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer);
      }

      this.debounceTimer = window.setTimeout(() => {
        if (this.onBatchCallback) {
          this.onBatchCallback();
        }
      }, debounceDelay);
    });

    if (document.documentElement) {
      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden'],
      });
    }
  }

  public reset(): void {
    this.mutationCount = 0;
    this.lastResetTime = Date.now();
    this.degradationState = 'NORMAL';
    this.reinsertionCount = 0;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  public stop(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  private checkDegradation(): void {
    const elapsed = (Date.now() - this.lastResetTime) / 1000;
    if (elapsed > 1) {
      const rate = this.mutationCount / elapsed;
      if (rate > ADAPT_THRESHOLDS.MUTATION_PAUSE_THRESHOLD) {
        this.degradationState = 'PAUSED';
        setTimeout(() => {
          this.degradationState = 'NORMAL';
        }, 2000);
      } else if (rate > ADAPT_THRESHOLDS.MUTATION_COALESCE_THRESHOLD) {
        this.degradationState = 'SAMPLING';
      } else if (rate > ADAPT_THRESHOLDS.MUTATION_BURST_THRESHOLD) {
        this.degradationState = 'COALESCED';
      } else {
        this.degradationState = 'NORMAL';
      }

      this.mutationCount = 0;
      this.lastResetTime = Date.now();
    }
  }

  public getSignals(): MutationSignal {
    const elapsed = Math.max(0.1, (Date.now() - this.lastResetTime) / 1000);
    const mutationRatePerSecond = this.mutationCount / elapsed;

    return {
      mutationRatePerSecond,
      rapidReinsertionDetected: this.reinsertionCount > 2,
      overlayReinsertedCount: this.reinsertionCount,
      degradationState: this.degradationState,
    };
  }
}
