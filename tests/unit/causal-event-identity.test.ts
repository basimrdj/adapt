import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { NavigationRegistry } from '../../src/core/navigation/registry';
import { isSyntheticDocumentId } from '../../src/core/navigation/epoch';
import { EventNormalizer } from '../../src/background/causal/event-normalizer';
import { EpochRouter } from '../../src/background/causal/epoch-router';
import {
  clampConfidence,
  hashOrigin,
  isStaleScope,
  scopesEqual,
  timestampDeltaMs,
} from '../../src/shared/causal/events';

function committed(
  registry: NavigationRegistry,
  tabId: number,
  url: string,
  documentId: string,
  frameId = 0,
  parentFrameId?: number
) {
  return registry.onNavigationCommitted(tabId, frameId, url, parentFrameId, documentId);
}

describe('causal event identity (M1)', () => {
  it('real navigation A→B: documentId changes, navigationEpoch increments, old scope is stale', () => {
    const registry = new NavigationRegistry();
    const a = committed(registry, 1, 'https://example.com/a', 'doc-A');
    const oldKey = registry.getCausalKey(1, 0);
    expect(oldKey).toEqual({
      tabId: 1,
      navigationEpoch: 1,
      documentId: 'doc-A',
      frameId: 0,
    });
    expect(a.navigationId).toBeTruthy();

    const b = committed(registry, 1, 'https://example.com/b', 'doc-B');
    expect(b.documentId).toBe('doc-B');
    expect(b.documentId).not.toBe(a.documentId);
    expect(b.navigationEpoch).toBe(a.navigationEpoch + 1);
    expect(b.navigationId).not.toBe(a.navigationId);
    expect(b.frameId).toBe(0);

    const live = registry.getCausalKey(1, 0)!;
    expect(registry.isCausalScopeValid(oldKey!)).toBe(false);
    expect(registry.isCausalScopeValid(live)).toBe(true);
    expect(isStaleScope(live, oldKey!)).toBe(true);
    expect(registry.isEpochValid(1, a.navigationId, 0)).toBe(false);
    expect(registry.isEpochValid(1, b.navigationId, 0)).toBe(true);
  });

  it('SPA history.pushState: documentId unchanged, navigationEpoch increments, old epoch stale', () => {
    const registry = new NavigationRegistry();
    const initial = committed(registry, 1, 'https://spa.com/home', 'doc-SPA');
    const spa = registry.onHistoryStateUpdated(1, 0, 'https://spa.com/feed');

    expect(spa).not.toBeNull();
    expect(spa!.documentId).toBe(initial.documentId);
    expect(spa!.documentId).toBe('doc-SPA');
    expect(spa!.navigationEpoch).toBe(initial.navigationEpoch + 1);
    expect(spa!.navigationId).not.toBe(initial.navigationId);

    const oldKey = {
      tabId: 1,
      navigationEpoch: initial.navigationEpoch,
      documentId: initial.documentId,
      frameId: 0,
    };
    const newKey = registry.getCausalKey(1, 0)!;
    expect(registry.isCausalScopeValid(oldKey)).toBe(false);
    expect(registry.isCausalScopeValid(newKey)).toBe(true);
    expect(isStaleScope(newKey, oldKey)).toBe(true);
    expect(newKey.documentId).toBe(oldKey.documentId);
    expect(newKey.navigationEpoch).not.toBe(oldKey.navigationEpoch);
  });

  it('frameId stays 0 across A→B while documentId changes — documentId is required', () => {
    const registry = new NavigationRegistry();
    const a = committed(registry, 1, 'https://news.com/a', 'uuid-A');
    const b = committed(registry, 1, 'https://news.com/b', 'uuid-B');

    expect(a.frameId).toBe(0);
    expect(b.frameId).toBe(0);
    expect(a.frameId).toBe(b.frameId);
    expect(a.documentId).not.toBe(b.documentId);
    expect(registry.isCausalScopeValid({
      tabId: 1,
      navigationEpoch: a.navigationEpoch,
      documentId: a.documentId,
      frameId: 0,
    })).toBe(false);
  });

  it('cross-tab: tab 1 event cannot route into tab 2 epoch', () => {
    const registry = new NavigationRegistry();
    const router = new EpochRouter(registry);
    committed(registry, 1, 'https://example.com/one', 'doc-tab-1');
    committed(registry, 2, 'https://example.com/two', 'doc-tab-2');

    const key1 = registry.getCausalKey(1, 0)!;
    const key2 = registry.getCausalKey(2, 0)!;

    expect(router.route(key1).ok).toBe(true);
    expect(router.route(key2).ok).toBe(true);
    expect(scopesEqual(key1, key2)).toBe(false);

    const forgedOntoTab2 = { ...key1, tabId: 2 };
    const decision = router.route(forgedOntoTab2);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(['CROSS_TAB', 'TAB_MISMATCH', 'DOCUMENT_MISMATCH']).toContain(decision.reason);
    }
    expect(decision.ok === false && decision.reason).toBe('CROSS_TAB');

    expect(registry.isCausalScopeValid(forgedOntoTab2)).toBe(false);
    expect(isStaleScope(key2, key1)).toBe(true);
  });

  it('replay stale EventNode after navigation: normalizer returns null and router rejects', () => {
    const registry = new NavigationRegistry();
    const normalizer = new EventNormalizer(registry);
    const router = new EpochRouter(registry);

    committed(registry, 1, 'https://example.com/a', 'doc-A');
    const nodeA = normalizer.normalizeNavigation({
      type: 'committed',
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/a',
      documentId: 'doc-A',
      timeStamp: 1000,
    });
    expect(nodeA).not.toBeNull();
    expect(router.accept(nodeA!).ok).toBe(true);

    committed(registry, 1, 'https://example.com/b', 'doc-B');

    const stale = normalizer.normalizeNavigation({
      type: 'committed',
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/a',
      documentId: 'doc-A',
    });
    expect(stale).toBeNull();

    const acceptStale = router.accept(nodeA!);
    expect(acceptStale.ok).toBe(false);
    if (!acceptStale.ok) {
      expect(acceptStale.reason).toBe('DOCUMENT_MISMATCH');
    }
  });

  it('subframe epochs are cleared on main-frame navigation', () => {
    const registry = new NavigationRegistry();
    const main1 = committed(registry, 1, 'https://example.com/', 'doc-main-1');
    const sub1 = committed(registry, 1, 'https://ad-frame.com/', 'doc-sub-1', 101, 0);

    expect(registry.isEpochValid(1, main1.navigationId, 0)).toBe(true);
    expect(registry.isEpochValid(1, sub1.navigationId, 101)).toBe(true);
    expect(registry.isCausalScopeValid(registry.getCausalKey(1, 101)!)).toBe(true);

    const main2 = committed(registry, 1, 'https://another.com/', 'doc-main-2');
    expect(registry.isEpochValid(1, main1.navigationId, 0)).toBe(false);
    expect(registry.isEpochValid(1, main2.navigationId, 0)).toBe(true);
    expect(registry.isEpochValid(1, sub1.navigationId, 101)).toBe(false);
    expect(registry.getCausalKey(1, 101)).toBeUndefined();
    expect(registry.isCausalScopeValid({
      tabId: 1,
      navigationEpoch: sub1.navigationEpoch,
      documentId: sub1.documentId,
      frameId: 101,
    })).toBe(false);
  });

  it('originHash is 64-char hex, not the raw origin string', () => {
    const registry = new NavigationRegistry();
    const normalizer = new EventNormalizer(registry);
    const epoch = committed(registry, 1, 'https://example.com/path?q=1', 'doc-origin');
    const node = normalizer.normalizeNavigation({
      type: 'committed',
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/path?q=1',
      documentId: 'doc-origin',
    });
    expect(node).not.toBeNull();
    expect(node!.scope.originHash).toMatch(/^[0-9a-f]{64}$/);
    expect(node!.scope.originHash).not.toBe(epoch.origin);
    expect(node!.scope.originHash).not.toContain('example.com');
    expect(node!.scope.originHash).toBe(hashOrigin(epoch.origin));
    expect(hashOrigin(epoch.origin)).toBe(
      createHash('sha256').update(epoch.origin, 'utf8').digest('hex')
    );
  });

  it('request normalizer never puts query strings or full URLs with secrets into features', () => {
    const registry = new NavigationRegistry();
    const normalizer = new EventNormalizer(registry);
    committed(registry, 1, 'https://example.com/', 'doc-req');

    const node = normalizer.normalizeRequest({
      type: 'start',
      tabId: 1,
      frameId: 0,
      requestId: '12345',
      url: 'https://ad-tracker.net/pixel/track.gif?user_id=12345&token=secret#frag',
      resourceType: 'image',
      documentId: 'doc-req',
      timeStamp: 50,
    });
    expect(node).not.toBeNull();
    expect(node!.kind).toBe('REQUEST_START');
    expect(node!.provenance).toBe('webRequest');
    expect(node!.features.hostname).toBe('ad-tracker.net');
    expect(node!.features.coarsePath).toBe('/pixel/track.gif');
    expect(node!.features.isSecure).toBe(true);
    expect(node!.features.resourceType).toBe('image');

    const serialized = JSON.stringify(node!.features);
    expect(serialized).not.toContain('token=');
    expect(serialized).not.toContain('user_id');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('?');
    expect(node!.features).not.toHaveProperty('url');
    expect(Object.values(node!.features).join(' ')).not.toContain('https://ad-tracker.net/pixel');

    expect(node!.refs.length).toBe(1);
    expect(node!.refs[0]).toMatch(/^request:r\d+$/);
    expect(node!.refs.join('')).not.toContain('12345');
  });

  it('normalizer fails closed without a live epoch or on document mismatch', () => {
    const registry = new NavigationRegistry();
    const normalizer = new EventNormalizer(registry);
    expect(
      normalizer.normalizeNavigation({
        type: 'committed',
        tabId: 9,
        frameId: 0,
        url: 'https://example.com/',
      })
    ).toBeNull();

    committed(registry, 1, 'https://example.com/', 'live-doc');
    expect(
      normalizer.normalizeRequest({
        type: 'error',
        tabId: 1,
        frameId: 0,
        requestId: 'r1',
        url: 'https://example.com/x',
        documentId: 'live-doc',
      })
    ).not.toBeNull();
    expect(
      normalizer.normalizeRequest({
        type: 'error',
        tabId: 1,
        frameId: 0,
        requestId: 'stale-r1',
        url: 'https://example.com/x',
        documentId: 'old-doc',
      })
    ).toBeNull();
    expect(
      normalizer.normalizeNavigation({
        type: 'committed',
        tabId: 1,
        frameId: 0,
        url: 'https://example.com/',
        documentId: 'other-doc',
      })
    ).toBeNull();
  });

  it('synthetic missing: documentId is used when Chrome id is absent; confidence is lower', () => {
    const registry = new NavigationRegistry();
    const normalizer = new EventNormalizer(registry);
    const epoch = registry.onNavigationCommitted(1, 0, 'https://example.com/');
    expect(isSyntheticDocumentId(epoch.documentId)).toBe(true);
    expect(epoch.documentId.startsWith('missing:')).toBe(true);
    expect(epoch.navigationEpoch).toBe(1);

    const node = normalizer.normalizeNavigation({
      type: 'committed',
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/',
    });
    expect(node).not.toBeNull();
    expect(node!.observationConfidence).toBe(0.6);

    const real = committed(registry, 2, 'https://example.com/', 'chrome-uuid');
    expect(isSyntheticDocumentId(real.documentId)).toBe(false);
    const realNode = new EventNormalizer(registry).normalizeNavigation({
      type: 'committed',
      tabId: 2,
      frameId: 0,
      url: 'https://example.com/',
      documentId: 'chrome-uuid',
    });
    expect(realNode!.observationConfidence).toBe(1);
  });

  it('Chrome timeStamp uses extension.wall_ms; missing stamp uses wall clock', () => {
    const registry = new NavigationRegistry();
    const normalizer = new EventNormalizer(registry);
    committed(registry, 1, 'https://example.com/', 'doc-ts');

    const withTs = normalizer.normalizeNavigation({
      type: 'start',
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/',
      documentId: 'doc-ts',
      timeStamp: 12.5,
    });
    expect(withTs!.kind).toBe('NAV_START');
    expect(withTs!.timestamp.domain).toBe('extension.wall_ms');
    expect(withTs!.timestamp.value).toBe(12.5);
    expect(typeof withTs!.timestamp.capturedWallMs).toBe('number');

    const wall = normalizer.normalizeNavigation({
      type: 'domReady',
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/',
      documentId: 'doc-ts',
    });
    expect(wall!.kind).toBe('DOM_READY');
    expect(wall!.timestamp.domain).toBe('extension.wall_ms');

    expect(timestampDeltaMs(withTs!.timestamp, wall!.timestamp)).not.toBeNull();
    expect(timestampDeltaMs(withTs!.timestamp, withTs!.timestamp)).toBe(0);
  });

  it('history events are NAV_COMMIT with spa:true and keep live documentId', () => {
    const registry = new NavigationRegistry();
    const normalizer = new EventNormalizer(registry);
    committed(registry, 1, 'https://spa.com/home', 'doc-spa');
    registry.onHistoryStateUpdated(1, 0, 'https://spa.com/feed');

    const node = normalizer.normalizeNavigation({
      type: 'history',
      tabId: 1,
      frameId: 0,
      url: 'https://spa.com/feed',
      documentId: 'doc-spa',
    });
    expect(node).not.toBeNull();
    expect(node!.kind).toBe('NAV_COMMIT');
    expect(node!.features.spa).toBe(true);
    expect(node!.scope.documentId).toBe('doc-spa');
    expect(node!.scope.navigationEpoch).toBe(2);
  });

  it('EpochRouter: STALE_EPOCH, FRAME_MISMATCH, NO_EPOCH', () => {
    const registry = new NavigationRegistry();
    const router = new EpochRouter(registry);
    committed(registry, 1, 'https://example.com/a', 'doc-A');
    const keyA = registry.getCausalKey(1, 0)!;
    committed(registry, 1, 'https://example.com/a', 'doc-A-spa-same');
    // same tab, new document
    const staleDoc = router.route(keyA);
    expect(staleDoc.ok).toBe(false);
    if (!staleDoc.ok) expect(staleDoc.reason).toBe('DOCUMENT_MISMATCH');

    const spaStart = committed(registry, 3, 'https://spa.com/home', 'spa-doc');
    registry.onHistoryStateUpdated(3, 0, 'https://spa.com/feed');
    const staleEpoch = router.route({
      tabId: 3,
      navigationEpoch: spaStart.navigationEpoch,
      documentId: 'spa-doc',
      frameId: 0,
    });
    expect(staleEpoch.ok).toBe(false);
    if (!staleEpoch.ok) expect(staleEpoch.reason).toBe('STALE_EPOCH');

    expect(router.route({ tabId: 99, navigationEpoch: 1, documentId: 'x', frameId: 0 }).ok).toBe(
      false
    );
    const noEpoch = router.route({ tabId: 99, navigationEpoch: 1, documentId: 'x', frameId: 0 });
    expect(noEpoch.ok === false && noEpoch.reason).toBe('NO_EPOCH');

    committed(registry, 4, 'https://example.com/', 'main-doc');
    const frameMismatch = router.route({
      tabId: 4,
      navigationEpoch: 1,
      documentId: 'main-doc',
      frameId: 7,
    });
    expect(frameMismatch.ok === false && frameMismatch.reason).toBe('FRAME_MISMATCH');
  });

  it('clampConfidence is finite and in [0,1]', () => {
    expect(clampConfidence(0.4)).toBe(0.4);
    expect(clampConfidence(-1)).toBe(0);
    expect(clampConfidence(2)).toBe(1);
    expect(clampConfidence(Number.NaN)).toBe(0);
    expect(clampConfidence(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
