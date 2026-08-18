/**
 * Bounded re-hide watches (P4) — after a successful hide, a TTL/cap-bounded
 * MutationObserver re-hides re-shown or re-inserted matches and settles a single
 * reHideCount telemetry callback. Pins: re-hide on style re-show, re-hide of
 * re-inserted clones, the 25-re-hide cap + settle, the 20s TTL + settle, and the
 * rollback interlock (the watch must stop BEFORE styles are reverted so it can
 * never fight an intentional rollback).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DomActionExecutor } from '../../src/page/dom-actions';
import { DomAction } from '../../src/shared/types';

interface FakeElement {
  nodeType: 1;
  tagName: string;
  id: string;
  className: string;
  isConnected: boolean;
  style: {
    readonly display: string;
    setProperty: (prop: string, value: string, priority?: string) => void;
    removeProperty: (prop: string) => void;
  };
}

class MockMutationObserver {
  public static instances: MockMutationObserver[] = [];
  public disconnected = false;
  constructor(private readonly callback: () => void) {
    MockMutationObserver.instances.push(this);
  }
  public observe(): void { /* noop */ }
  public disconnect(): void {
    this.disconnected = true;
  }
  public fire(): void {
    if (!this.disconnected) this.callback();
  }
}

function makeElement(tag: string, className = ''): FakeElement {
  const styles = new Map<string, string>();
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: '',
    className,
    isConnected: true,
    style: {
      get display() {
        return styles.get('display') ?? '';
      },
      setProperty: (prop, value) => void styles.set(prop, value),
      removeProperty: (prop) => void styles.delete(prop),
    },
  };
}

function installDomStub(registry: FakeElement[]): void {
  MockMutationObserver.instances = [];
  (globalThis as Record<string, unknown>).MutationObserver = MockMutationObserver;
  (globalThis as Record<string, unknown>).window = {
    // Lazy indirection: vitest fake timers replace globalThis.setTimeout AFTER
    // this stub installs — bind at call time, not at setup time.
    setTimeout: (handler: () => void, ms?: number) => globalThis.setTimeout(handler, ms),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
    getComputedStyle: (el: FakeElement) => ({ display: el.style.display === 'none' ? 'none' : 'block' }),
  };
  (globalThis as Record<string, unknown>).document = {
    querySelectorAll: (selector: string) =>
      registry.filter((el) => {
        if (selector.startsWith('.')) return el.className.split(/\s+/).includes(selector.slice(1));
        if (selector.startsWith('#')) return el.id === selector.slice(1);
        return el.tagName === selector.toUpperCase();
      }),
  };
}

function hideAction(id: string, selector: string): DomAction {
  return { id, type: 'DOM_REMOVE_OVERLAY', selector } as unknown as DomAction;
}

/** Apply → re-show → fire observer → run the coalesced sweep. */
function reshowAndSweep(el: FakeElement): void {
  el.style.removeProperty('display');
  MockMutationObserver.instances.forEach((observer) => observer.fire());
  vi.advanceTimersByTime(60); // REHIDE_COALESCE_MS
}

describe('DomActionExecutor bounded re-hide watch', () => {
  let registry: FakeElement[];

  beforeEach(() => {
    registry = [];
    installDomStub(registry);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).MutationObserver;
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
  });

  it('re-hides a re-shown element and a re-inserted clone, then settles on TTL', () => {
    const wall = makeElement('div', 'wall');
    registry.push(wall);
    const settled: Array<[string, number]> = [];
    const executor = new DomActionExecutor(undefined, (actionId, count) => settled.push([actionId, count]));

    expect(executor.applyAction(hideAction('a1', '.wall'))).toBe(true);
    expect(wall.style.display).toBe('none');

    // Detector re-shows the same element.
    reshowAndSweep(wall);
    expect(wall.style.display).toBe('none');
    expect(executor.rehideCountFor('a1')).toBe(1);

    // Detector appends a fresh clone of the wall.
    const clone = makeElement('div', 'wall');
    registry.push(clone);
    MockMutationObserver.instances.forEach((observer) => observer.fire());
    vi.advanceTimersByTime(60);
    expect(clone.style.display).toBe('none');
    expect(executor.rehideCountFor('a1')).toBe(2);

    // TTL expiry stops the watch and settles exactly once.
    vi.advanceTimersByTime(20_000);
    expect(settled).toEqual([['a1', 2]]);
    expect(executor.rehideCountFor('a1')).toBe(0); // watch removed

    // After settling, a re-show is NOT fought (escalation belongs to the AI loop).
    reshowAndSweep(wall);
    expect(wall.style.display).toBe('');
  });

  it('caps re-hides at 25 per action and settles with the count', () => {
    const wall = makeElement('div', 'wall');
    registry.push(wall);
    const settled: Array<[string, number]> = [];
    const executor = new DomActionExecutor(undefined, (actionId, count) => settled.push([actionId, count]));
    executor.applyAction(hideAction('a2', '.wall'));

    for (let i = 0; i < 30; i++) reshowAndSweep(wall);
    expect(settled).toEqual([['a2', 25]]);
    // The 26th+ re-show stands — the bounded watch is done.
    expect(wall.style.display).toBe('');
  });

  it('rollback stops the watch first — an intentional restore is never re-hidden', () => {
    const wall = makeElement('div', 'wall');
    registry.push(wall);
    const settled: Array<[string, number]> = [];
    const executor = new DomActionExecutor(undefined, (actionId, count) => settled.push([actionId, count]));
    executor.applyAction(hideAction('a3', '.wall'));
    reshowAndSweep(wall);
    expect(executor.rehideCountFor('a3')).toBe(1);

    expect(executor.rollbackAction('a3')).toBe(true);
    expect(wall.style.display).toBe(''); // original style restored
    expect(settled).toEqual([['a3', 1]]); // settled with the count earned so far

    // Any late observer delivery after rollback is a no-op.
    MockMutationObserver.instances.forEach((observer) => observer.fire());
    vi.advanceTimersByTime(60);
    expect(wall.style.display).toBe('');
    expect(settled).toHaveLength(1);
  });

  it('non-hide actions install no watch', () => {
    const executor = new DomActionExecutor(undefined, () => undefined);
    expect(executor.applyAction({ id: 's1', type: 'DOM_RESTORE_SCROLL' } as unknown as DomAction)).toBe(true);
    expect(MockMutationObserver.instances).toHaveLength(0);
  });
});
