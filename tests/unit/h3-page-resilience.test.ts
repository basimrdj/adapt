/**
 * H3 — page-side resilience pins.
 *
 * A. MutationPipeline trailing-edge starvation: a steady drip of sub-threshold
 *    mutations must not defer the batch callback forever (max-wait 500ms).
 * B. PageSensor: same max-wait on the signal-batch scheduler; synthetic
 *    (untrusted) clicks never ship USER_INTENT_ENVELOPE work; trusted intent
 *    traffic is rate-limited per document.
 * C. DomActionExecutor: concurrent re-hide watches capped at 4 (oldest settles
 *    first); the dynamic full-screen overlay sweep hides at most 8 candidates.
 * D. early-runtime.js (first direct execution tests): a rule that throws (or
 *    whose wrapper cannot stick on frozen intrinsics) is counted and never
 *    aborts the remaining same-domain rules.
 * E. stealth-main.ts: the adsbygoogle stub tracks processed slots in a
 *    WeakSet — zero `data-adapt-*` DOM attribute fingerprint.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { MutationPipeline } from '../../src/page/mutations';
import { PageSensor } from '../../src/page/sensor';
import { DomActionExecutor } from '../../src/page/dom-actions';
import { DomAction } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Shared DOM stubs (pattern mirrors dom-actions-rehide.test.ts)
// ---------------------------------------------------------------------------

class MockMutationObserver {
  public static instances: MockMutationObserver[] = [];
  public disconnected = false;
  constructor(private readonly callback: (mutations: MutationRecord[]) => void) {
    MockMutationObserver.instances.push(this);
  }
  public observe(): void { /* noop */ }
  public disconnect(): void {
    this.disconnected = true;
  }
  public fire(mutations: MutationRecord[] = []): void {
    if (!this.disconnected) this.callback(mutations);
  }
}

interface FakeElement {
  nodeType: 1;
  tagName: string;
  id: string;
  className: string;
  isConnected: boolean;
  position: string;
  rect: { width: number; height: number };
  getBoundingClientRect: () => { width: number; height: number };
  style: {
    readonly display: string;
    setProperty: (prop: string, value: string, priority?: string) => void;
    removeProperty: (prop: string) => void;
  };
}

function makeElement(tag: string, className = ''): FakeElement {
  const styles = new Map<string, string>();
  const el: FakeElement = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: '',
    className,
    isConnected: true,
    position: 'static',
    rect: { width: 0, height: 0 },
    getBoundingClientRect() {
      return el.rect;
    },
    style: {
      get display() {
        return styles.get('display') ?? '';
      },
      setProperty: (prop, value) => void styles.set(prop, value),
      removeProperty: (prop) => void styles.delete(prop),
    },
  };
  return el;
}

function installPageDomStub(registry: FakeElement[]): void {
  MockMutationObserver.instances = [];
  (globalThis as Record<string, unknown>).MutationObserver = MockMutationObserver;
  (globalThis as Record<string, unknown>).window = {
    // Lazy indirection: vitest fake timers replace globalThis.setTimeout AFTER
    // this stub installs — bind at call time, not at setup time.
    setTimeout: (handler: () => void, ms?: number) => globalThis.setTimeout(handler, ms),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
    getComputedStyle: (el: FakeElement) => ({
      display: el.style.display === 'none' ? 'none' : 'block',
      position: el.position,
    }),
    innerWidth: 1024,
    innerHeight: 768,
  };
  (globalThis as Record<string, unknown>).document = {
    documentElement: {},
    addEventListener: () => undefined,
    querySelectorAll: (selector: string) =>
      registry.filter((el) => {
        if (selector.includes(',')) {
          const tags = selector.split(',').map((part) => part.trim().toUpperCase());
          return tags.includes(el.tagName);
        }
        if (selector.startsWith('.')) return el.className.split(/\s+/).includes(selector.slice(1));
        if (selector.startsWith('#')) return el.id === selector.slice(1);
        const [tag, ...classes] = selector.split('.');
        if (classes.length > 0 && tag) {
          const owned = el.className.split(/\s+/);
          return el.tagName === tag.toUpperCase() && classes.every((cls) => owned.includes(cls));
        }
        return el.tagName === selector.toUpperCase();
      }),
  };
}

function uninstallPageDomStub(): void {
  delete (globalThis as Record<string, unknown>).MutationObserver;
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
}

// ---------------------------------------------------------------------------
// A. MutationPipeline max-wait
// ---------------------------------------------------------------------------

describe('MutationPipeline trailing-edge starvation guard', () => {
  beforeEach(() => {
    installPageDomStub([]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstallPageDomStub();
  });

  it('still debounces a single burst (normal path unchanged)', () => {
    const batches = vi.fn();
    const pipeline = new MutationPipeline(batches);
    pipeline.start();
    MockMutationObserver.instances[0]!.fire([]);
    vi.advanceTimersByTime(59);
    expect(batches).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(batches).toHaveBeenCalledTimes(1);
    pipeline.stop();
  });

  it('continuous sub-threshold mutations cannot defer the batch past 500ms', () => {
    const batches = vi.fn();
    const pipeline = new MutationPipeline(batches);
    pipeline.start();

    // 2/s forever — each mutation resets the trailing-edge 60ms timer.
    for (let i = 0; i < 50; i++) {
      MockMutationObserver.instances[0]!.fire([]);
      vi.advanceTimersByTime(40);
    }
    // Without the max-wait guard this is 0 no matter how long we run.
    expect(batches.mock.calls.length).toBeGreaterThanOrEqual(3);
    pipeline.stop();
  });
});

// ---------------------------------------------------------------------------
// B. PageSensor — scheduler max-wait + intent gating
// ---------------------------------------------------------------------------

class FakeHTMLElement {
  public tagName = 'DIV';
}
class FakeHTMLAnchorElement extends FakeHTMLElement {
  public tagName = 'A';
  public href = 'http://site.test/next';
  public target = '';
  public hasAttribute(): boolean {
    return false;
  }
  public closest(): this {
    return this;
  }
}

describe('PageSensor intent gating and batch scheduler', () => {
  let sentMessages: Array<{ type: string }>;
  let clickHandler: ((event: Record<string, unknown>) => void) | null;
  let pipelineObserverFired: () => void;
  /** Programmable READY responder: return value becomes the sendMessage resolution. */
  let readyResponder: (() => unknown) | null;

  const makeSensor = (responder?: () => unknown): PageSensor => {
    MockMutationObserver.instances = [];
    sentMessages = [];
    clickHandler = null;
    readyResponder = responder ?? null;

    (globalThis as Record<string, unknown>).MutationObserver = MockMutationObserver;
    (globalThis as Record<string, unknown>).HTMLElement = FakeHTMLElement;
    (globalThis as Record<string, unknown>).HTMLAnchorElement = FakeHTMLAnchorElement;
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        onMessage: { addListener: () => undefined },
        sendMessage: (msg: { type: string }) => {
          sentMessages.push(msg);
          if (msg.type === 'PAGE_SENSOR_READY' && readyResponder) {
            return Promise.resolve(readyResponder());
          }
          return Promise.resolve(undefined);
        },
      },
    };
    (globalThis as Record<string, unknown>).window = {
      setTimeout: (handler: () => void, ms?: number) => globalThis.setTimeout(handler, ms),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
      addEventListener: () => undefined,
      innerWidth: 1024,
      innerHeight: 768,
      location: { href: 'http://site.test/', origin: 'http://site.test' },
    };
    (globalThis as Record<string, unknown>).document = {
      readyState: 'loading', // no automatic batch; tests drive the scheduler
      documentElement: {},
      addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => {
        if (type === 'click') clickHandler = handler;
      },
      querySelectorAll: () => [],
    };

    const sensor = new PageSensor('nav_h3');
    sensor.init();
    pipelineObserverFired = () => MockMutationObserver.instances[0]?.fire([]);
    return sensor;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).MutationObserver;
    delete (globalThis as Record<string, unknown>).HTMLElement;
    delete (globalThis as Record<string, unknown>).HTMLAnchorElement;
    delete (globalThis as Record<string, unknown>).chrome;
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
  });

  it('untrusted synthetic clicks never ship USER_INTENT_ENVELOPE messages', () => {
    makeSensor();
    const anchor = new FakeHTMLAnchorElement();
    for (let i = 0; i < 1000; i++) {
      clickHandler!({ isTrusted: false, target: anchor, button: 0 });
    }
    expect(sentMessages.filter((m) => m.type === 'USER_INTENT_ENVELOPE')).toHaveLength(0);
  });

  it('trusted intent traffic is rate-limited per document window', () => {
    makeSensor();
    const anchor = new FakeHTMLAnchorElement();
    for (let i = 0; i < 100; i++) {
      clickHandler!({ isTrusted: true, target: anchor, button: 0 });
      vi.advanceTimersByTime(10);
    }
    expect(
      sentMessages.filter((m) => m.type === 'USER_INTENT_ENVELOPE').length
    ).toBeLessThanOrEqual(20);
  });

  it('signal-batch scheduler cannot be starved by continuous re-scheduling', () => {
    const sensor = makeSensor();
    const schedule = (sensor as unknown as { scheduleSignalBatch: () => void }).scheduleSignalBatch.bind(sensor);

    // A mutation batch every 40ms re-enters the scheduler forever. Over 3.2s of
    // virtual time the 500ms max-wait must force batches through regardless.
    for (let i = 0; i < 80; i++) {
      pipelineObserverFired(); // MutationPipeline callback → scheduleSignalBatch
      schedule(); // plus direct re-schedules (SPA transitions, DOM ready)
      vi.advanceTimersByTime(40);
    }
    const batches = sentMessages.filter((m) => m.type === 'PAGE_SIGNAL_BATCH');
    expect(batches.length).toBeGreaterThanOrEqual(3);
  });

  it('READY is retried with backoff until the background acks, then flushes a batch', async () => {
    let readyCalls = 0;
    makeSensor();
    // First three READY sends die in the cold-worker window (no response);
    // the fourth is acknowledged.
    readyResponder = () => {
      readyCalls += 1;
      return readyCalls >= 4 ? { success: true, navigationId: 'nav_h3' } : undefined;
    };
    // The init READY already went out before the responder attached — it got
    // undefined, so the retry chain is armed. Drive the backoff schedule.
    for (let i = 0; i < 40 && readyCalls < 4; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }
    const readySends = sentMessages.filter((m) => m.type === 'PAGE_SENSOR_READY').length;
    expect(readySends).toBeGreaterThanOrEqual(4);
    // Post-ack flush: one full-state batch converges the background's view.
    await vi.advanceTimersByTimeAsync(200);
    expect(sentMessages.some((m) => m.type === 'CAUSAL_OBSERVATION_BATCH' || m.type === 'PAGE_SIGNAL_BATCH')).toBe(true);
    // Once acked the chain stops: no further READY retries appear.
    const settled = sentMessages.filter((m) => m.type === 'PAGE_SENSOR_READY').length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sentMessages.filter((m) => m.type === 'PAGE_SENSOR_READY').length).toBe(settled);
  });

  it('READY retry is bounded when the background never acks', async () => {
    makeSensor();
    readyResponder = () => undefined; // black hole
    await vi.advanceTimersByTimeAsync(120_000);
    const readySends = sentMessages.filter((m) => m.type === 'PAGE_SENSOR_READY').length;
    // 1 initial + READY_RETRY_MAX_ATTEMPTS retries, then the chain stands down.
    expect(readySends).toBeLessThanOrEqual(10);
    const settled = sentMessages.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sentMessages.length).toBe(settled);
  });

  it('post-ack SPA READYs are fire-and-forget — no retry chain re-arms', async () => {
    const sensor = makeSensor(() => ({ success: true, navigationId: 'nav_h3' }));
    await vi.advanceTimersByTimeAsync(0); // resolve the init READY ack
    const baseline = sentMessages.filter((m) => m.type === 'PAGE_SENSOR_READY').length;
    expect(baseline).toBe(1);
    // Three SPA transitions — each sends exactly one READY, zero retries.
    const spa = (sensor as unknown as { handleSpaTransition: () => void }).handleSpaTransition.bind(sensor);
    spa();
    spa();
    spa();
    const afterSpa = sentMessages.filter((m) => m.type === 'PAGE_SENSOR_READY').length;
    expect(afterSpa).toBe(baseline + 3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sentMessages.filter((m) => m.type === 'PAGE_SENSOR_READY').length).toBe(afterSpa);
  });
});

// ---------------------------------------------------------------------------
// C. DomActionExecutor caps
// ---------------------------------------------------------------------------

describe('DomActionExecutor bounded watches and sweeps', () => {
  let registry: FakeElement[];

  beforeEach(() => {
    registry = [];
    installPageDomStub(registry);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstallPageDomStub();
  });

  const hideAction = (id: string, selector: string): DomAction =>
    ({ id, type: 'DOM_REMOVE_OVERLAY', selector } as unknown as DomAction);

  it('caps concurrent re-hide watches at 4 — the oldest settles first', () => {
    const settled: Array<[string, number]> = [];
    const executor = new DomActionExecutor(undefined, (actionId, count) => settled.push([actionId, count]));

    const walls = Array.from({ length: 5 }, (_, i) => {
      const el = makeElement('div', `wall${i}`);
      registry.push(el);
      return el;
    });

    expect(executor.applyAction(hideAction('h1', '.wall0'))).toBe(true);
    // Earn one re-hide on the oldest watch so its eviction settles with telemetry.
    walls[0]!.style.removeProperty('display');
    MockMutationObserver.instances.forEach((observer) => observer.fire());
    vi.advanceTimersByTime(60);
    expect(executor.rehideCountFor('h1')).toBe(1);

    for (let i = 1; i < 5; i++) {
      expect(executor.applyAction(hideAction(`h${i + 1}`, `.wall${i}`))).toBe(true);
    }

    // 5 observers were created over time; the first was disconnected when the
    // 5th watch exceeded the cap, and its settle fired with the earned count.
    expect(MockMutationObserver.instances).toHaveLength(5);
    expect(MockMutationObserver.instances[0]!.disconnected).toBe(true);
    expect(MockMutationObserver.instances[4]!.disconnected).toBe(false);
    expect(settled).toEqual([['h1', 1]]);
  });

  it('dynamic overlay sweep hides at most 8 full-viewport candidates', () => {
    for (let i = 0; i < 12; i++) {
      const el = makeElement('div', 'overlayish');
      el.position = 'fixed';
      el.rect = { width: 1024, height: 768 };
      registry.push(el);
    }
    const executor = new DomActionExecutor(undefined, () => undefined);
    const action = { id: 'sweep1', type: 'DOM_REMOVE_OVERLAY' } as unknown as DomAction;
    expect(executor.applyAction(action)).toBe(true);
    expect(registry.filter((el) => el.style.display === 'none')).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// D. early-runtime.js direct execution
// ---------------------------------------------------------------------------

const EARLY_RUNTIME_SOURCE = readFileSync(
  join(__dirname, '../../src/page/filtering/early-runtime.js'),
  'utf8'
);

function runEarlyRuntime(
  groups: Record<string, Array<{ name: string; args: string[] }>>,
  harden?: (ctx: vm.Context) => void
): vm.Context {
  const sandbox: Record<string, unknown> = {
    location: { hostname: 'example.com' },
    setTimeout: () => 0,
    setInterval: () => 0,
    open: () => null,
    eval: () => undefined,
  };
  const ctx = vm.createContext(sandbox);
  harden?.(ctx);
  const source = EARLY_RUNTIME_SOURCE.replace('__EARLY_RULES__', JSON.stringify(groups));
  vm.runInContext(source, ctx);
  return ctx;
}

describe('early-runtime shard execution', () => {
  it('frozen intrinsic: wrapper that cannot stick is counted, not silent, and never throws outward', () => {
    const ctx = runEarlyRuntime(
      { 'example.com': [{ name: 'prevent-setTimeout', args: ['/ad/'] }] },
      (ctx) =>
        vm.runInContext(
          'Object.defineProperty(globalThis, "setTimeout", { value: globalThis.setTimeout, writable: false, configurable: false })',
          ctx
        )
    );
    expect((ctx as Record<string, unknown>).__eshf).toBe(1);
  });

  it('per-rule isolation: a failing rule never aborts the remaining same-domain rules', () => {
    const ctx = runEarlyRuntime(
      {
        'example.com': [
          { name: 'prevent-setTimeout', args: ['/ad/'] }, // fails: frozen below
          { name: 'set-constant', args: ['foo.bar', 'false'] }, // must still apply
        ],
      },
      (ctx) =>
        vm.runInContext(
          'Object.defineProperty(globalThis, "setTimeout", { value: globalThis.setTimeout, writable: false, configurable: false })',
          ctx
        )
    );
    expect(((ctx as Record<string, unknown>).foo as Record<string, unknown>).bar).toBe(false);
    expect((ctx as Record<string, unknown>).__eshf).toBe(1);
  });

  it('clean run applies rules and exposes no failure counter', () => {
    const ctx = runEarlyRuntime({
      'example.com': [{ name: 'set-constant', args: ['foo.bar', 'false'] }],
    });
    expect(((ctx as Record<string, unknown>).foo as Record<string, unknown>).bar).toBe(false);
    expect((ctx as Record<string, unknown>).__eshf).toBeUndefined();
  });

  it('malformed rule entries are contained per-rule instead of aborting the shard', () => {
    const groups = {
      'example.com': [
        { name: 'set-constant' } as { name: string; args: string[] }, // missing args — throws inside apply
        { name: 'set-constant', args: ['ok.flag', 'true'] },
      ],
    };
    const sandbox: Record<string, unknown> = { location: { hostname: 'example.com' } };
    const ctx = vm.createContext(sandbox);
    const source = EARLY_RUNTIME_SOURCE.replace(
      '__EARLY_RULES__',
      JSON.stringify(groups).replace('"args":undefined', '')
    );
    vm.runInContext(source, ctx);
    expect(((ctx as Record<string, unknown>).ok as Record<string, unknown>).flag).toBe(true);
    expect((ctx as Record<string, unknown>).__eshf).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// E. stealth-main WeakSet shim marker
// ---------------------------------------------------------------------------

describe('stealth-main adsbygoogle stub', () => {
  it('tracks processed slots in a WeakSet — zero data-adapt-* attributes', () => {
    const source = readFileSync(join(__dirname, '../../src/entrypoints/stealth-main.ts'), 'utf8');
    const js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
    }).outputText;

    const makeIns = () => {
      const attrs: Record<string, string> = {};
      return { attrs, setAttribute: (k: string, v: string) => void (attrs[k] = v) };
    };
    const ins1 = makeIns();
    const ins2 = makeIns();
    const sandbox: Record<string, unknown> = {
      document: {
        querySelectorAll: (selector: string) => (selector === 'ins.adsbygoogle' ? [ins1, ins2] : []),
        currentScript: null,
      },
      Document: function Document() {},
    };
    (sandbox.Document as { prototype: unknown }).prototype = {
      getElementById: () => null,
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(js, ctx);

    const adsbygoogle = (ctx as Record<string, unknown>).adsbygoogle as { push: (c: unknown) => number; loaded: boolean };
    expect(adsbygoogle.loaded).toBe(true);
    adsbygoogle.push({});
    expect(ins1.attrs).toEqual({ 'data-ad-status': 'filled' });
    adsbygoogle.push({});
    expect(ins2.attrs).toEqual({ 'data-ad-status': 'filled' });
    adsbygoogle.push({}); // no unprocessed slots remain — no-op, no attribute spam
    expect(ins1.attrs['data-adapt-shimmed']).toBeUndefined();
    expect(ins2.attrs['data-adapt-shimmed']).toBeUndefined();
    expect(Object.keys(ins1.attrs)).toHaveLength(1);
    expect(Object.keys(ins2.attrs)).toHaveLength(1);

    // Detector flag surface still seeded.
    expect((ctx as Record<string, unknown>).adblock).toBe(false);
  });
});
