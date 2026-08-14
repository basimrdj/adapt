import { DnrController } from '../../core/dnr/controller';
import { normalizeUrlForTelemetry } from '../../core/network/normalize-url';
import { PrimitiveDefinition, PrimitiveId, PRIMITIVE_DEFINITIONS } from './primitive-registry';
import { EphemeralNavigationTargetRegistry } from './navigation-targets';
import { StrategyAction } from '../../shared/types';

export type PrimitiveExecutionStatus = 'EXECUTABLE_AND_BROWSER_TESTED' | 'CAPABILITY_GAP';

export type CapabilityGapCode =
  | 'NO_EXECUTOR'
  | 'UNRESOLVED_OPAQUE_TARGET'
  | 'UNRESOLVED_REQUEST'
  | 'ROLLBACK_NOT_RELIABLE'
  | 'FORBIDDEN_CONTEXT'
  | 'UNSUPPORTED_SCRIPTLET'
  | 'DNR_RULE_NOT_EXPRESSIBLE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'EXECUTOR_ERROR';

export interface PrimitiveExecutionMatrixEntry {
  primitiveId: PrimitiveId;
  status: PrimitiveExecutionStatus;
  executionWorld: PrimitiveDefinition['executionWorld'];
  requiredEvidence: string[];
  requiredOpaqueRefKinds: string[];
  rollbackConfidence: number;
  browserTestId: string;
  capabilityGapReason?: string;
}

export interface PrimitiveExecutionContext {
  txId: string;
  tabId: number;
  frameId: number;
  documentId: string;
  primitiveId: PrimitiveId;
  opaqueRefs: string[];
  evidence: string[];
}

export interface PrimitiveExecutionRecord {
  txId: string;
  primitiveId: PrimitiveId;
  tabId: number;
  frameId: number;
  documentId: string;
  opaqueRefs: string[];
  sessionRuleIds: number[];
  domActionIds: string[];
  navigationRef?: string;
  closedTargetUrl?: string;
  undoTabId?: number;
  startedWallMs: number;
  committed: boolean;
}

export type SendTabMessage = (tabId: number, message: unknown) => Promise<{
  success?: boolean;
  actionIds?: string[];
}>;

export interface NetworkTarget {
  urlFilter: string;
  resourceTypes: chrome.declarativeNetRequest.ResourceType[];
  firstParty: boolean;
  trackerLike: boolean;
}

export interface PrimitiveExecutorDeps {
  dnrController: DnrController;
  sendTabMessage: SendTabMessage;
  resolveRequest: (ref: string) => NetworkTarget | undefined;
  navigationTargets: EphemeralNavigationTargetRegistry;
  tabsApi?: Pick<typeof chrome.tabs, 'remove' | 'create'>;
}

const EXECUTABLE: ReadonlyMap<PrimitiveId, { browserTestId: string; requiredOpaqueRefKinds: string[] }> = new Map([
  ['TEMPORARY_NETWORK_ALLOW', { browserTestId: 'network-allow', requiredOpaqueRefKinds: ['request'] }],
  ['TEMPORARY_NETWORK_BLOCK', { browserTestId: 'network-block', requiredOpaqueRefKinds: ['request'] }],
  ['TARGETED_SESSION_DNR', { browserTestId: 'targeted-session-dnr', requiredOpaqueRefKinds: ['request'] }],
  ['TOGGLE_COSMETIC_ACTION', { browserTestId: 'toggle-cosmetic', requiredOpaqueRefKinds: ['element'] }],
  ['PRESERVE_BAIT', { browserTestId: 'preserve-bait', requiredOpaqueRefKinds: ['element'] }],
  ['RESTORE_LAYOUT', { browserTestId: 'restore-layout', requiredOpaqueRefKinds: ['element'] }],
  ['REMOVE_REACTION_UI', { browserTestId: 'remove-reaction-ui', requiredOpaqueRefKinds: ['element'] }],
  ['RESTORE_SCROLL', { browserTestId: 'restore-scroll', requiredOpaqueRefKinds: [] }],
  ['RESTORE_POINTER_INTERACTION', { browserTestId: 'restore-pointer', requiredOpaqueRefKinds: [] }],
  ['PLAYER_HEALTH_RECOVERY', { browserTestId: 'player-health', requiredOpaqueRefKinds: [] }],
  ['CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET', { browserTestId: 'close-unwanted-target', requiredOpaqueRefKinds: ['navigation'] }],
  ['STOP_MATCHED_REDIRECT_CHAIN', { browserTestId: 'stop-redirect-chain', requiredOpaqueRefKinds: ['navigation'] }],
]);

const BROWSER_TESTED = new Set<PrimitiveId>(['RESTORE_SCROLL', 'REMOVE_REACTION_UI']);

const GAP_REASONS: Partial<Record<PrimitiveId, string>> = {
  ACTIVATE_PACKAGED_SCRIPTLET: 'Packaged scriptlet activation has no production rollback proof.',
  DISABLE_PACKAGED_SCRIPTLET: 'Packaged scriptlet deactivation has no production rollback proof.',
  QUARANTINE_NAVIGATION_TARGET: 'No reversible browser quarantine primitive is defined.',
  SUPPRESS_MATCHED_WINDOW_OPEN_BEHAVIOR: 'Window-open suppression would require unsafe page API interception.',
};

function actionId(txId: string, primitiveId: PrimitiveId, index = 0): string {
  return `autonomy_${txId}_${primitiveId}_${index}`;
}

function requestRef(refs: readonly string[]): string | undefined {
  return refs.find((ref) => ref.startsWith('request:r'));
}

function elementRef(refs: readonly string[]): string | undefined {
  return refs.find((ref) => ref.startsWith('element:e'));
}

function navigationRef(refs: readonly string[]): string | undefined {
  return refs.find((ref) => ref.startsWith('navigation:n'));
}

export class PrimitiveExecutorRegistry {
  private readonly staged = new Map<string, PrimitiveExecutionRecord>();

  constructor(private readonly deps: PrimitiveExecutorDeps) {}

  matrix(): PrimitiveExecutionMatrixEntry[] {
    return PRIMITIVE_DEFINITIONS.map((definition) => {
      const executable = EXECUTABLE.get(definition.id);
      const gap = GAP_REASONS[definition.id];
      const browserTested = executable !== undefined && BROWSER_TESTED.has(definition.id);
      return {
        primitiveId: definition.id,
        status: browserTested ? 'EXECUTABLE_AND_BROWSER_TESTED' : 'CAPABILITY_GAP',
        executionWorld: definition.executionWorld,
        requiredEvidence: [...definition.requiredEvidence],
        requiredOpaqueRefKinds: executable?.requiredOpaqueRefKinds ?? [],
        rollbackConfidence: browserTested ? 0.99 : 0,
        browserTestId: browserTested ? executable.browserTestId : 'none',
        ...(!browserTested ? { capabilityGapReason: gap ?? 'Trusted executor exists but no real browser holdout test covers this primitive yet.' } : {}),
      };
    });
  }

  get(txId: string): PrimitiveExecutionRecord | undefined {
    const record = this.staged.get(txId);
    return record ? { ...record, opaqueRefs: [...record.opaqueRefs], sessionRuleIds: [...record.sessionRuleIds], domActionIds: [...record.domActionIds] } : undefined;
  }

  hydrate(record: PrimitiveExecutionRecord): void {
    this.staged.set(record.txId, {
      ...record,
      opaqueRefs: [...record.opaqueRefs],
      sessionRuleIds: [...record.sessionRuleIds],
      domActionIds: [...record.domActionIds],
    });
  }

  getGap(primitiveId: PrimitiveId): { code: CapabilityGapCode; reason: string } | undefined {
    if (EXECUTABLE.has(primitiveId)) return undefined;
    return {
      code: primitiveId.includes('SCRIPTLET') ? 'UNSUPPORTED_SCRIPTLET' : 'NO_EXECUTOR',
      reason: GAP_REASONS[primitiveId] ?? 'No trusted executor is registered.',
    };
  }

  async stage(context: PrimitiveExecutionContext): Promise<
    | { ok: true; record: PrimitiveExecutionRecord }
    | { ok: false; gap: { code: CapabilityGapCode; reason: string } }
  > {
    const gap = this.getGap(context.primitiveId);
    if (gap) return { ok: false, gap };
    const matrix = EXECUTABLE.get(context.primitiveId)!;
    if (matrix.requiredOpaqueRefKinds.some((kind) => !context.opaqueRefs.some((ref) => ref.startsWith(`${kind}:`)))) {
      return { ok: false, gap: { code: 'UNRESOLVED_OPAQUE_TARGET', reason: 'Required opaque reference is missing.' } };
    }

    const record: PrimitiveExecutionRecord = {
      txId: context.txId,
      primitiveId: context.primitiveId,
      tabId: context.tabId,
      frameId: context.frameId,
      documentId: context.documentId,
      opaqueRefs: [...context.opaqueRefs],
      sessionRuleIds: [],
      domActionIds: [],
      startedWallMs: Date.now(),
      committed: false,
    };

    if (context.primitiveId === 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET') {
      const ref = navigationRef(context.opaqueRefs);
      const target = ref ? this.deps.navigationTargets.get(ref) : undefined;
      if (!ref || !target || target.closed || !this.deps.tabsApi) {
        return { ok: false, gap: { code: 'UNRESOLVED_OPAQUE_TARGET', reason: 'Navigation target is unavailable or already closed.' } };
      }
      await this.deps.tabsApi.remove(target.tabId).catch(() => {
        throw new Error('navigation target could not be closed');
      });
      record.navigationRef = ref;
      record.closedTargetUrl = target.url;
      this.deps.navigationTargets.markClosed(ref);
      this.staged.set(context.txId, record);
      return { ok: true, record: this.get(context.txId)! };
    }

    if (context.primitiveId === 'TEMPORARY_NETWORK_ALLOW'
      || context.primitiveId === 'TEMPORARY_NETWORK_BLOCK'
      || context.primitiveId === 'TARGETED_SESSION_DNR'
      || context.primitiveId === 'STOP_MATCHED_REDIRECT_CHAIN') {
      let target: NetworkTarget | undefined;
      if (context.primitiveId === 'STOP_MATCHED_REDIRECT_CHAIN') {
        const ref = navigationRef(context.opaqueRefs);
        const navigation = ref ? this.deps.navigationTargets.get(ref) : undefined;
        if (!navigation) return { ok: false, gap: { code: 'UNRESOLVED_OPAQUE_TARGET', reason: 'Redirect target is unavailable.' } };
        const parsed = new URL(navigation.url);
        const normalized = normalizeUrlForTelemetry(navigation.url);
        target = {
          urlFilter: `|${parsed.protocol}//${normalized.hostname}${normalized.coarsePath}*`,
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
          firstParty: false,
          trackerLike: true,
        };
        record.navigationRef = ref;
      } else {
        const ref = requestRef(context.opaqueRefs);
        target = ref ? this.deps.resolveRequest(ref) : undefined;
        if (!target) return { ok: false, gap: { code: 'UNRESOLVED_REQUEST', reason: 'Request reference is not in the trusted resource registry.' } };
        if (context.primitiveId === 'TEMPORARY_NETWORK_ALLOW' && (!target.firstParty || target.trackerLike)) {
          return { ok: false, gap: { code: 'FORBIDDEN_CONTEXT', reason: 'Temporary allow is limited to first-party non-tracker resources.' } };
        }
      }
      if (!target) {
        return { ok: false, gap: { code: 'UNRESOLVED_REQUEST', reason: 'Trusted network target could not be resolved.' } };
      }
      const action = context.primitiveId === 'TEMPORARY_NETWORK_ALLOW'
        ? { id: actionId(context.txId, context.primitiveId), type: 'NET_ALLOW_EXCEPTION' as const, urlFilter: target.urlFilter, resourceTypes: target.resourceTypes }
        : { id: actionId(context.txId, context.primitiveId), type: 'NET_BLOCK' as const, urlFilter: target.urlFilter, resourceTypes: target.resourceTypes };
      const result = await this.deps.dnrController.addSessionExperimentRules(context.tabId, context.txId, [action]);
      record.sessionRuleIds = result.ruleIds;
      this.staged.set(context.txId, record);
      return { ok: true, record: this.get(context.txId)! };
    }

    const domResponse = await this.deps.sendTabMessage(context.tabId, {
      v: 1,
      type: 'APPLY_AUTONOMY_PRIMITIVE',
      txId: context.txId,
      primitiveId: context.primitiveId,
      opaqueRefs: [...context.opaqueRefs],
      documentId: context.documentId,
    });
    if (!domResponse.success) {
      return { ok: false, gap: { code: 'UNRESOLVED_OPAQUE_TARGET', reason: 'Content executor rejected the primitive target.' } };
    }
    record.domActionIds = [...(domResponse.actionIds ?? [])];
    this.staged.set(context.txId, record);
    return { ok: true, record: this.get(context.txId)! };
  }

  async rollback(txId: string): Promise<{ ok: boolean; errors: string[] }> {
    const record = this.staged.get(txId);
    if (!record) return { ok: true, errors: [] };
    const errors: string[] = [];
    if (record.sessionRuleIds.length > 0) {
      await this.deps.dnrController.removeSessionExperimentRules(record.sessionRuleIds).catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
      });
    }
    if (record.domActionIds.length > 0) {
      const response = await this.deps.sendTabMessage(record.tabId, {
        v: 1,
        type: 'ROLLBACK_AUTONOMY_PRIMITIVE',
        txId: record.txId,
        actionIds: [...record.domActionIds],
        documentId: record.documentId,
      }).catch((error: unknown) => ({ success: false, error: error instanceof Error ? error.message : String(error) }));
      if (!response.success) errors.push('DOM primitive rollback was not acknowledged');
    }
    if (record.closedTargetUrl && record.navigationRef && this.deps.tabsApi) {
      const recreated = await this.deps.tabsApi.create({ url: record.closedTargetUrl, active: false }).catch(() => undefined);
      if (!recreated?.id) errors.push('closed navigation target could not be reopened');
    }
    this.staged.delete(txId);
    return { ok: errors.length === 0, errors };
  }

  async commit(txId: string): Promise<void> {
    const record = this.staged.get(txId);
    if (record) record.committed = true;
  }

  discard(txId: string): void {
    this.staged.delete(txId);
  }
}

export function primitiveRecipeActions(primitiveId: PrimitiveId, opaqueRefs: readonly string[]): StrategyAction[] {
  const targetRef = elementRef(opaqueRefs) as `element:e${number}` | undefined;
  const id = `recipe_${primitiveId}_${targetRef ?? 'global'}`;
  switch (primitiveId) {
    case 'TOGGLE_COSMETIC_ACTION':
      return targetRef ? [{ id, type: 'DOM_REMOVE_OVERLAY', targetRef }] : [];
    case 'REMOVE_REACTION_UI':
      return targetRef
        ? [{ id: `${id}_overlay`, type: 'DOM_REMOVE_OVERLAY', targetRef }, { id: `${id}_scroll`, type: 'DOM_RESTORE_SCROLL' }]
        : [];
    case 'PRESERVE_BAIT':
      return targetRef ? [{ id, type: 'DOM_PRESERVE_BAIT_CANDIDATE', targetRef }] : [];
    case 'RESTORE_LAYOUT':
      return targetRef ? [{ id, type: 'BAIT_PRESERVE_LAYOUT', targetRef }] : [];
    case 'RESTORE_SCROLL':
      return [{ id, type: 'DOM_RESTORE_SCROLL' }];
    case 'RESTORE_POINTER_INTERACTION':
      return [{ id, type: 'DOM_RESTORE_POINTER_EVENTS' }];
    case 'PLAYER_HEALTH_RECOVERY':
      return [{ id: `${id}_scroll`, type: 'DOM_RESTORE_SCROLL' }, { id: `${id}_pointer`, type: 'DOM_RESTORE_POINTER_EVENTS' }];
    default:
      return [];
  }
}
