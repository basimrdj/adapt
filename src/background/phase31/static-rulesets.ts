interface Phase31RulesetCatalogEntry {
  id: string;
  family: string;
  title: string;
  count: number;
  priority: number;
  defaultEnabled: boolean;
}

interface Phase31RulesetCatalog {
  version: 1;
  generatedAt: string;
  rulesets: Phase31RulesetCatalogEntry[];
}

export const RULESET_RUNTIME_STATE_KEY = 'adapt_ruleset_runtime_state';

interface RulesetRuntimeState {
  capturedAt: string;
  stage: 'load' | 'reconcile-complete' | 'reconcile-failed' | 'catalog-missing';
  manifestDefaultRulesets: string[];
  catalogRulesets: string[];
  enabledRulesets: string[];
  availableStaticRuleCount: number | null;
  expectedEnabledRuleCount: number | null;
  optionalEnabledRulesets: string[];
  failedEnableAttempts: string[];
  reconciliationErrors?: string[];
  reason?: string;
}

async function recordRuntimeState(state: RulesetRuntimeState): Promise<void> {
  try {
    await chrome.storage.session.set({ [RULESET_RUNTIME_STATE_KEY]: state });
  } catch {
    // Runtime evidence is best-effort and must not block startup.
  }
}

function validCatalog(value: unknown): value is Phase31RulesetCatalog {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Phase31RulesetCatalog>;
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.rulesets) &&
    candidate.rulesets.every(
      (entry) =>
        entry &&
        typeof entry.id === 'string' &&
        typeof entry.count === 'number' &&
        Number.isFinite(entry.count) &&
        entry.count >= 0 &&
        typeof entry.priority === 'number'
    )
  );
}

/**
 * A full Phase 3 build has no Phase 3.1 catalog, so this is deliberately a
 * no-op in that case. A production Phase 3.1 artifact contains a catalog and
 * optional packaged static rulesets. We greedily enable as many as Chromium's
 * live shared static-rule pool permits.
 */
export async function reconcilePhase31StaticRulesets(): Promise<void> {
  let catalog: Phase31RulesetCatalog;

  try {
    const response = await fetch(
      chrome.runtime.getURL('phase31-rulesets/catalog.json'),
      { cache: 'no-store' }
    );
    if (!response.ok) {
      await recordRuntimeState({
        capturedAt: new Date().toISOString(),
        stage: 'catalog-missing',
        manifestDefaultRulesets: ['ruleset_baseline'],
        catalogRulesets: [],
        enabledRulesets: [],
        availableStaticRuleCount: null,
        expectedEnabledRuleCount: null,
        optionalEnabledRulesets: [],
        failedEnableAttempts: [],
        reason: `catalog-http-${response.status}`,
      });
      return;
    }

    const parsed: unknown = await response.json();
    if (!validCatalog(parsed)) return;
    catalog = parsed;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } catch {
    await recordRuntimeState({
      capturedAt: new Date().toISOString(),
      stage: 'catalog-missing',
      manifestDefaultRulesets: ['ruleset_baseline'],
      catalogRulesets: [],
      enabledRulesets: [],
      availableStaticRuleCount: null,
      expectedEnabledRuleCount: null,
      optionalEnabledRulesets: [],
      failedEnableAttempts: [],
      reason: 'catalog-unavailable-or-invalid',
    });
    return;
  }

  try {
    const enabledBefore = await chrome.declarativeNetRequest.getEnabledRulesets();
    const enabled = new Set(enabledBefore);
    const availableBefore = await chrome.declarativeNetRequest.getAvailableStaticRuleCount();
    let available = availableBefore;
    const expectedRuleCount = (ids: readonly string[]): number => ids.reduce((sum, id) => sum + (catalog.rulesets.find((entry) => entry.id === id)?.count ?? 0), 0);
    await recordRuntimeState({
      capturedAt: new Date().toISOString(),
      stage: 'load',
      manifestDefaultRulesets: ['ruleset_baseline', ...catalog.rulesets.filter((entry) => entry.defaultEnabled).map((entry) => entry.id)],
      catalogRulesets: catalog.rulesets.map((entry) => entry.id),
      enabledRulesets: enabledBefore,
      availableStaticRuleCount: availableBefore,
      expectedEnabledRuleCount: expectedRuleCount(enabledBefore),
      optionalEnabledRulesets: [],
      failedEnableAttempts: [],
      reason: 'captured-before-optional-reconciliation',
    });

    const candidates = catalog.rulesets
      .filter((entry) => !entry.defaultEnabled && !enabled.has(entry.id))
      .sort((a, b) => b.priority - a.priority);

    const enableRulesetIds: string[] = [];

    for (const entry of candidates) {
      if (entry.count <= available) {
        enableRulesetIds.push(entry.id);
        available -= entry.count;
      }
    }

    const enableBatches: string[][] = [];
    let currentBatch: string[] = [];
    let currentBatchCount = 0;
    for (const id of enableRulesetIds) {
      const entry = catalog.rulesets.find((candidate) => candidate.id === id);
      const count = entry?.count ?? 0;
      if (currentBatch.length > 0 && currentBatchCount + count > 25_000) {
        enableBatches.push(currentBatch);
        currentBatch = [];
        currentBatchCount = 0;
      }
      currentBatch.push(id);
      currentBatchCount += count;
    }
    if (currentBatch.length > 0) enableBatches.push(currentBatch);

    const reconciliationErrors: string[] = [];
    for (const batch of enableBatches) {
      try {
        await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: batch });
      } catch (error) {
        reconciliationErrors.push(`${batch.join(',')}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const enabledAfter = await chrome.declarativeNetRequest.getEnabledRulesets();
    const availableAfter = await chrome.declarativeNetRequest.getAvailableStaticRuleCount();
    await recordRuntimeState({
      capturedAt: new Date().toISOString(),
      stage: reconciliationErrors.length > 0 ? 'reconcile-failed' : 'reconcile-complete',
        manifestDefaultRulesets: ['ruleset_baseline', ...catalog.rulesets.filter((entry) => entry.defaultEnabled).map((entry) => entry.id)],
      catalogRulesets: catalog.rulesets.map((entry) => entry.id),
      enabledRulesets: enabledAfter,
      availableStaticRuleCount: availableAfter,
      expectedEnabledRuleCount: expectedRuleCount(enabledAfter),
      optionalEnabledRulesets: enableRulesetIds.filter((id) => enabledAfter.includes(id)),
      failedEnableAttempts: enableRulesetIds.filter((id) => !enabledAfter.includes(id)),
      reconciliationErrors,
      reason: `before:${enabledBefore.length}/${availableBefore}`,
    });
  } catch (error) {
    await recordRuntimeState({
      capturedAt: new Date().toISOString(),
      stage: 'reconcile-failed',
      manifestDefaultRulesets: ['ruleset_baseline', ...catalog.rulesets.filter((entry) => entry.defaultEnabled).map((entry) => entry.id)],
      catalogRulesets: catalog.rulesets.map((entry) => entry.id),
      enabledRulesets: [],
      availableStaticRuleCount: null,
      expectedEnabledRuleCount: null,
      optionalEnabledRulesets: [],
      failedEnableAttempts: [],
      reason: error instanceof Error ? error.message : 'reconciliation-error',
    });
    // Static rule capacity is shared with other extensions and can change.
    // The guaranteed baseline remains enabled even if optional expansion fails.
  }
}
