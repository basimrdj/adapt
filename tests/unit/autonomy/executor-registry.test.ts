import { describe, expect, it } from 'vitest';
import { EphemeralNavigationTargetRegistry } from '../../../src/background/autonomy/navigation-targets';
import { PrimitiveExecutorRegistry } from '../../../src/background/autonomy/executor-registry';
import { PRIMITIVE_DEFINITIONS } from '../../../src/background/autonomy/primitive-registry';
import type { NavigationTargetObservation } from '../../../src/shared/types';

function observation(): NavigationTargetObservation {
  return {
    ref: 'navigation:n1',
    sourceTabId: 1,
    sourceFrameId: 0,
    targetTabId: 2,
    capturedWallMs: Date.now(),
    sourceOriginHash: 'source',
    destinationOriginHash: 'target',
    destinationClass: 'cross-origin',
    redirectCount: 0,
    foregroundState: 'background',
    openerRelationship: 'implicit',
    riskSignals: ['UNEXPECTED_AFTER_GESTURE', 'EXTRA_TARGET', 'DESTINATION_MISMATCH'],
  };
}

describe('PrimitiveExecutorRegistry', () => {
  it('executes and rolls back DOM and session-DNR primitives', async () => {
    const added: number[][] = [];
    const removed: number[][] = [];
    const dnr = {
      addSessionExperimentRules: async () => {
        added.push([1]);
        return { ruleIds: [3_000_001], quotaCheck: { allowed: true } as never };
      },
      removeSessionExperimentRules: async (ids: number[]) => {
        removed.push(ids);
      },
    };
    const sent: unknown[] = [];
    const targets = new EphemeralNavigationTargetRegistry();
    const registry = new PrimitiveExecutorRegistry({
      dnrController: dnr as never,
      sendTabMessage: async (_tabId, message) => {
        sent.push(message);
        return { success: true, actionIds: ['autonomy-action-1'] };
      },
      resolveRequest: () => ({
        urlFilter: '|https://first.invalid/resource*',
        resourceTypes: ['script'] as never,
        firstParty: true,
        trackerLike: false,
      }),
      navigationTargets: targets,
    });

    const dom = await registry.stage({
      txId: 'tx-dom', tabId: 1, frameId: 0, documentId: 'doc',
      primitiveId: 'REMOVE_REACTION_UI', opaqueRefs: ['element:e1'], evidence: ['OVERLAY_APPEARED'],
    });
    expect(dom.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect((await registry.rollback('tx-dom')).ok).toBe(true);
    expect(sent).toHaveLength(2);

    const network = await registry.stage({
      txId: 'tx-network', tabId: 1, frameId: 0, documentId: 'doc',
      primitiveId: 'TEMPORARY_NETWORK_BLOCK', opaqueRefs: ['request:r1'], evidence: ['REQUEST_START'],
    });
    expect(network.ok).toBe(true);
    expect(added).toHaveLength(1);
    expect((await registry.rollback('tx-network')).ok).toBe(true);
    expect(removed).toEqual([[3_000_001]]);
  });

  it('closes only a registered target and restores it idempotently', async () => {
    const removed: number[] = [];
    const created: string[] = [];
    const targets = new EphemeralNavigationTargetRegistry();
    targets.record(observation(), 'https://target.invalid/path');
    const registry = new PrimitiveExecutorRegistry({
      dnrController: {} as never,
      sendTabMessage: async () => ({ success: true }),
      resolveRequest: () => undefined,
      navigationTargets: targets,
      tabsApi: {
        remove: async (tabId: number | number[]) => { removed.push(typeof tabId === 'number' ? tabId : tabId[0] ?? -1); },
        create: async ({ url }: { url?: string }) => { created.push(url ?? ''); return { id: 9 } as chrome.tabs.Tab; },
      } as never,
    });
    const staged = await registry.stage({
      txId: 'tx-nav', tabId: 1, frameId: 0, documentId: 'doc',
      primitiveId: 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET', opaqueRefs: ['navigation:n1'], evidence: ['UNEXPECTED_NAV_TARGET', 'POPUP_OR_POPUNDER'],
    });
    expect(staged.ok).toBe(true);
    expect(removed).toEqual([2]);
    expect((await registry.rollback('tx-nav')).ok).toBe(true);
    expect(created).toEqual(['https://target.invalid/path']);
    expect((await registry.rollback('tx-nav')).ok).toBe(true);
  });

  it('reports a binary execution matrix with explicit gaps', () => {
    const registry = new PrimitiveExecutorRegistry({
      dnrController: {} as never,
      sendTabMessage: async () => ({ success: true }),
      resolveRequest: () => undefined,
      navigationTargets: new EphemeralNavigationTargetRegistry(),
    });
    const matrix = registry.matrix();
    expect(matrix).toHaveLength(PRIMITIVE_DEFINITIONS.length);
    expect(matrix.every((entry) => entry.status === 'EXECUTABLE_AND_BROWSER_TESTED' || entry.status === 'CAPABILITY_GAP')).toBe(true);
    expect(matrix.filter((entry) => entry.status === 'CAPABILITY_GAP').map((entry) => entry.primitiveId)).toEqual(expect.arrayContaining([
      'ACTIVATE_PACKAGED_SCRIPTLET',
      'DISABLE_PACKAGED_SCRIPTLET',
      'QUARANTINE_NAVIGATION_TARGET',
      'SUPPRESS_MATCHED_WINDOW_OPEN_BEHAVIOR',
    ]));
  });
});
