import { describe, it, expect } from 'vitest';
import { NavigationRegistry } from '../../src/core/navigation/registry';

describe('NavigationRegistry', () => {
  it('creates and tracks navigation epochs', () => {
    const registry = new NavigationRegistry();
    const epoch = registry.onNavigationCommitted(1, 0, 'https://example.com/articles/123');

    expect(epoch.tabId).toBe(1);
    expect(epoch.siteKey).toBe('example.com');
    expect(epoch.isMainFrame).toBe(true);
    expect(registry.isEpochValid(1, epoch.navigationId)).toBe(true);
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
});
