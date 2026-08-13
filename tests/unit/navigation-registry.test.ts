import { describe, it, expect } from 'vitest';
import { NavigationRegistry } from '../../src/core/navigation/registry';
import { isSyntheticDocumentId } from '../../src/core/navigation/epoch';

describe('NavigationRegistry', () => {
  it('creates and tracks navigation epochs', () => {
    const registry = new NavigationRegistry();
    const epoch = registry.onNavigationCommitted(1, 0, 'https://example.com/articles/123');

    expect(epoch.tabId).toBe(1);
    expect(epoch.siteKey).toBe('example.com');
    expect(epoch.isMainFrame).toBe(true);
    expect(registry.isEpochValid(1, epoch.navigationId)).toBe(true);
    expect(epoch.navigationEpoch).toBe(1);
    expect(isSyntheticDocumentId(epoch.documentId)).toBe(true);
  });

  it('invalidates subframe epochs when main frame navigates', () => {
    const registry = new NavigationRegistry();
    const mainEpoch1 = registry.onNavigationCommitted(1, 0, 'https://example.com/');
    const subEpoch1 = registry.onNavigationCommitted(1, 101, 'https://ad-frame.com/', 0);

    expect(registry.isEpochValid(1, mainEpoch1.navigationId, 0)).toBe(true);
    expect(registry.isEpochValid(1, subEpoch1.navigationId, 101)).toBe(true);

    // Main frame navigates to new site
    const mainEpoch2 = registry.onNavigationCommitted(1, 0, 'https://another.com/');
    expect(registry.isEpochValid(1, mainEpoch1.navigationId, 0)).toBe(false);
    expect(registry.isEpochValid(1, mainEpoch2.navigationId, 0)).toBe(true);
    // Subframe from previous document must be invalidated
    expect(registry.isEpochValid(1, subEpoch1.navigationId, 101)).toBe(false);
    expect(mainEpoch2.navigationEpoch).toBeGreaterThan(mainEpoch1.navigationEpoch);
  });

  it('handles SPA history state updates', () => {
    const registry = new NavigationRegistry();
    const initialEpoch = registry.onNavigationCommitted(1, 0, 'https://spa.com/home');
    const spaEpoch = registry.onHistoryStateUpdated(1, 0, 'https://spa.com/feed');

    expect(spaEpoch).not.toBeNull();
    expect(spaEpoch?.navigationId).not.toBe(initialEpoch.navigationId);
    expect(registry.isEpochValid(1, initialEpoch.navigationId, 0)).toBe(false);
    expect(registry.isEpochValid(1, spaEpoch!.navigationId, 0)).toBe(true);
  });

  it('records Chrome documentId on commit and keeps it across SPA history', () => {
    const registry = new NavigationRegistry();
    const initial = registry.onNavigationCommitted(1, 0, 'https://spa.com/home', undefined, 'chrome-doc-1');
    expect(initial.documentId).toBe('chrome-doc-1');
    expect(initial.navigationEpoch).toBe(1);

    const spa = registry.onHistoryStateUpdated(1, 0, 'https://spa.com/feed');
    expect(spa).not.toBeNull();
    expect(spa!.documentId).toBe('chrome-doc-1');
    expect(spa!.navigationEpoch).toBe(2);
    expect(spa!.navigationId).not.toBe(initial.navigationId);
    expect(registry.isCausalScopeValid({
      tabId: 1,
      navigationEpoch: 1,
      documentId: 'chrome-doc-1',
      frameId: 0,
    })).toBe(false);
    expect(registry.isCausalScopeValid({
      tabId: 1,
      navigationEpoch: 2,
      documentId: 'chrome-doc-1',
      frameId: 0,
    })).toBe(true);
  });

  it('changes documentId on real A→B navigation while frameId stays 0', () => {
    const registry = new NavigationRegistry();
    const a = registry.onNavigationCommitted(1, 0, 'https://news.com/a', undefined, 'uuid-A');
    const b = registry.onNavigationCommitted(1, 0, 'https://news.com/b', undefined, 'uuid-B');
    expect(a.frameId).toBe(0);
    expect(b.frameId).toBe(0);
    expect(a.documentId).toBe('uuid-A');
    expect(b.documentId).toBe('uuid-B');
    expect(b.navigationEpoch).toBe(a.navigationEpoch + 1);
    expect(registry.getCausalKey(1, 0)?.documentId).toBe('uuid-B');
  });

  it('deduplicates a runtime-wakeup epoch and the later onCommitted event', () => {
    const registry = new NavigationRegistry();
    const runtime = registry.onNavigationCommitted(9, 0, 'https://news.com/a', undefined, 'uuid-A');
    const committed = registry.onNavigationCommitted(9, 0, 'https://news.com/a#ready', undefined, 'uuid-A');
    expect(committed.navigationId).toBe(runtime.navigationId);
    expect(committed.navigationEpoch).toBe(runtime.navigationEpoch);
    expect(committed.url).toBe('https://news.com/a#ready');
  });

  it('returns null from history update when no epoch exists', () => {
    const registry = new NavigationRegistry();
    expect(registry.onHistoryStateUpdated(1, 0, 'https://spa.com/feed')).toBeNull();
  });
});
