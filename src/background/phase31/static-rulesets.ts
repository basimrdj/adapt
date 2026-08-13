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
    if (!response.ok) return;

    const parsed: unknown = await response.json();
    if (!validCatalog(parsed)) return;
    catalog = parsed;
  } catch {
    return;
  }

  try {
    const enabled = new Set(
      await chrome.declarativeNetRequest.getEnabledRulesets()
    );
    let available =
      await chrome.declarativeNetRequest.getAvailableStaticRuleCount();

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

    if (enableRulesetIds.length === 0) return;

    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds,
    });
  } catch {
    // Static rule capacity is shared with other extensions and can change.
    // The guaranteed baseline remains enabled even if optional expansion fails.
  }
}
