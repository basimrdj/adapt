import { MutationSignal } from '../shared/types';
import { ADAPT_THRESHOLDS } from '../shared/constants';

const REINSERTION_WINDOW_MS = 3000;
const REINSERTION_MARKER = /(ad[-_ ]?block|anti[-_ ]?ad|disable[-_ ]?ad|blocker[-_ ]?gate)/i;

export class MutationPipeline {
  private observer: MutationObserver | null = null;
  private mutationCount = 0;
  private lastResetTime = Date.now();
  private degradationState: 'NORMAL' | 'COALESCED' | 'SAMPLING' | 'PAUSED' = 'NORMAL';
  private reinsertionEvents: number[] = [];
  private onBatchCallback?: () => void;
  private debounceTimer: number | null = null;
  private readonly recentlyRemoved = new Map<string, number>();
  private domReadyListenerInstalled = false;

  constructor(onBatchCallback?: () => void) {
    this.onBatchCallback = onBatchCallback;
  }

  public start(): void {
    if (this.observer) return;

    this.observer = new MutationObserver((mutations) => {
      try {
        this.observeReinsertions(mutations);
        this.mutationCount += mutations.length;
        this.checkDegradation();

        if (this.degradationState === 'PAUSED') return;

        const debounceDelay =
          this.degradationState === 'SAMPLING'
            ? 300
            : this.degradationState === 'COALESCED'
              ? 150
              : 60;

        if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);

        this.debounceTimer = window.setTimeout(() => {
          try {
            this.onBatchCallback?.();
          } catch {
            // Sensor callback failures are contained by PageSensor too; never
            // let a page mutation surface as an uncaught content-script error.
          }
        }, debounceDelay);
      } catch {
        // Mutation observation is advisory. Fail closed and wait for the next batch.
      }
    });

    if (!this.attachObserver() && !this.domReadyListenerInstalled) {
      this.domReadyListenerInstalled = true;
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          this.domReadyListenerInstalled = false;
          this.attachObserver();
        },
        { once: true }
      );
    }
  }

  private attachObserver(): boolean {
    if (!this.observer || !document.documentElement) return false;

    try {
      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden'],
      });
      return true;
    } catch {
      return false;
    }
  }

  private signature(node: Node): string | null {
    if (node.nodeType !== 1) return null;

    const el = node as Element;
    const id = (el.id || '').slice(0, 96);
    const className =
      typeof (el as HTMLElement).className === 'string'
        ? (el as HTMLElement).className.slice(0, 160)
        : '';
    const marker = `${id} ${className}`;

    if (!REINSERTION_MARKER.test(marker)) return null;
    return `${el.tagName}|${id}|${className}`;
  }

  private observeReinsertions(mutations: MutationRecord[]): void {
    const now = Date.now();

    for (const [key, removedAt] of this.recentlyRemoved.entries()) {
      if (now - removedAt > REINSERTION_WINDOW_MS) {
        this.recentlyRemoved.delete(key);
      }
    }

    for (const mutation of mutations) {
      for (const node of mutation.removedNodes) {
        const key = this.signature(node);
        if (key) this.recentlyRemoved.set(key, now);
      }

      for (const node of mutation.addedNodes) {
        const key = this.signature(node);
        if (!key) continue;

        const removedAt = this.recentlyRemoved.get(key);
        if (removedAt !== undefined && now - removedAt <= REINSERTION_WINDOW_MS) {
          this.reinsertionEvents.push(now);
          this.recentlyRemoved.delete(key);
        }
      }
    }
  }

  public reset(): void {
    this.mutationCount = 0;
    this.lastResetTime = Date.now();
    this.degradationState = 'NORMAL';
    this.reinsertionEvents = [];
    this.recentlyRemoved.clear();

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

    this.recentlyRemoved.clear();
  }

  private checkDegradation(): void {
    const elapsed = (Date.now() - this.lastResetTime) / 1000;
    if (elapsed <= 1) return;

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

  public getSignals(): MutationSignal {
    const now = Date.now();
    this.reinsertionEvents = this.reinsertionEvents.filter(
      (timestamp) => now - timestamp <= REINSERTION_WINDOW_MS
    );

    const elapsed = Math.max(0.1, (now - this.lastResetTime) / 1000);
    const mutationRatePerSecond = this.mutationCount / elapsed;
    const recentReinsertions = this.reinsertionEvents.length;

    return {
      mutationRatePerSecond,
      rapidReinsertionDetected: recentReinsertions > 2,
      overlayReinsertedCount: recentReinsertions,
      degradationState: this.degradationState,
    };
  }
}
