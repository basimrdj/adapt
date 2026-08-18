import { DnrIdAllocator, RuleIdAllocation } from './ids';
import { OwnershipStore, LearnedRuleOwnership } from './ownership';
import { ID_BANDS } from '../../shared/constants';

export interface ReconciliationResult {
  orphanedSessionRulesRemoved: number[];
  orphanedDynamicRulesRemoved: number[];
  /** Rules kept because persisted ownership proved they are ours. */
  restoredSessionRuleIds: number[];
  restoredDynamicRuleIds: number[];
  /** In-band rules with no ownership record — kept for investigation this boot. */
  unknownRuleIdsKept: number[];
  /** Ownership records whose physical rule no longer exists — metadata cleaned. */
  metadataRecordsCleaned: number[];
  /** PROMOTING records settled from physical ground truth (crash-window journal). */
  promotingRecordsResolved: number[];
  reconciledSuccessfully: boolean;
  /** True when orphan removal was suppressed because ownership used an unreadable schema. */
  foreignSchemaProtected: boolean;
  /**
   * Physical ground truth for in-band rules, so the controller can reseed its
   * in-memory quota tracker and rule metadata after a restart (both are
   * worker-lifetime otherwise and drift from what Chrome actually enforces).
   */
  observedSession: Array<{ id: number; isRegex: boolean }>;
  observedDynamic: Array<{ id: number; band: 'DYNAMIC_SAFE' | 'DYNAMIC_UNSAFE'; isRegex: boolean }>;
  errors: string[];
}

function bandForId(id: number): RuleIdAllocation['band'] | undefined {
  if (id >= ID_BANDS.DYNAMIC_SAFE_MIN && id <= ID_BANDS.DYNAMIC_SAFE_MAX) return 'DYNAMIC_SAFE';
  if (id >= ID_BANDS.DYNAMIC_UNSAFE_MIN && id <= ID_BANDS.DYNAMIC_UNSAFE_MAX) return 'DYNAMIC_UNSAFE';
  if (id >= ID_BANDS.SESSION_SAFE_MIN && id <= ID_BANDS.SESSION_SAFE_MAX) return 'SESSION_SAFE';
  if (id >= ID_BANDS.SESSION_UNSAFE_MIN && id <= ID_BANDS.SESSION_UNSAFE_MAX) return 'SESSION_UNSAFE';
  return undefined;
}

/** Unknown in-band rules are removed only after this many consecutive sightings. */
const UNKNOWN_GRACE_RECONCILES = 2;

export class DnrReconciler {
  /**
   * Reconciles physical Chromium DNR rules with persisted ADAPT ownership.
   *
   * "The current worker did not allocate it" is NOT treated as "orphan": ownership
   * metadata survives worker restarts (session area) and browser restarts (durable
   * area), so a learned rule is removed only when it is a PROVEN orphan — inside an
   * ADAPT id band, with no ownership record, seen UNKNOWN_GRACE_RECONCILES times.
   */
  public async reconcile(
    idAllocator: DnrIdAllocator,
    ownership: OwnershipStore,
    dnrBackend: {
      getDynamicRules: () => Promise<chrome.declarativeNetRequest.Rule[]>;
      getSessionRules: () => Promise<chrome.declarativeNetRequest.Rule[]>;
      updateDynamicRules: (options: { removeRuleIds?: number[] }) => Promise<void>;
      updateSessionRules: (options: { removeRuleIds?: number[] }) => Promise<void>;
    }
  ): Promise<ReconciliationResult> {
    const result: ReconciliationResult = {
      orphanedSessionRulesRemoved: [],
      orphanedDynamicRulesRemoved: [],
      restoredSessionRuleIds: [],
      restoredDynamicRuleIds: [],
      unknownRuleIdsKept: [],
      metadataRecordsCleaned: [],
      promotingRecordsResolved: [],
      reconciledSuccessfully: true,
      foreignSchemaProtected: false,
      observedSession: [],
      observedDynamic: [],
      errors: [],
    };

    // An ownership area written in a schema this build cannot read is not an
    // empty area. Never garbage-collect against unreadable ground truth: keep
    // every physical rule, reserve its id, and skip removals/metadata cleanup.
    const foreignSchema = ownership.hasForeignSchema();

    try {
      const actualSession = await dnrBackend.getSessionRules();
      const actualDynamic = await dnrBackend.getDynamicRules();
      const sessionIds = new Set(actualSession.map((rule) => rule.id));
      const dynamicIds = new Set(actualDynamic.map((rule) => rule.id));
      const adopted: RuleIdAllocation[] = [];

      // 1. Classify physical session rules. Every physical rule is recorded in
      // observedSession (Chrome charges quota for out-of-band ids too — e.g.
      // rules staged by a different build of this extension), but only in-band
      // rules are ever classified for adoption or removal.
      const sessionToRemove: number[] = [];
      for (const rule of actualSession) {
        result.observedSession.push({ id: rule.id, isRegex: Boolean(rule.condition?.regexFilter) });
        const band = bandForId(rule.id);
        if (!band || !band.startsWith('SESSION_')) continue; // foreign rule — never touch
        const record = ownership.session.get(rule.id);
        if (foreignSchema) {
          // Unreadable ownership: keep the rule, reserve the id, never remove.
          result.unknownRuleIdsKept.push(rule.id);
          adopted.push({ id: rule.id, band, ownerId: `foreign-schema-${rule.id}`, allocatedAt: Date.now() });
          continue;
        }
        if (record) {
          // KNOWN + PRESENT → keep, restore allocation.
          result.restoredSessionRuleIds.push(rule.id);
          ownership.session.clearUnknownSighting(rule.id);
          adopted.push({ id: rule.id, band, ownerId: record.ownerId, allocatedAt: record.createdAt });
        } else {
          const sightings = ownership.session.unknownSighting(rule.id);
          if (sightings >= UNKNOWN_GRACE_RECONCILES) {
            sessionToRemove.push(rule.id); // PROVEN ORPHAN
          } else {
            // UNKNOWN ADAPT-MANAGED RULE → investigate conservatively: keep the rule,
            // reserve the id so it is never reused while under investigation.
            result.unknownRuleIdsKept.push(rule.id);
            adopted.push({ id: rule.id, band, ownerId: `recovered-unknown-${rule.id}`, allocatedAt: Date.now() });
          }
        }
      }

      // 2. Classify physical dynamic rules (same record-all / classify-in-band split).
      const dynamicToRemove: number[] = [];
      for (const rule of actualDynamic) {
        const band = bandForId(rule.id);
        result.observedDynamic.push({
          id: rule.id,
          band: band === 'DYNAMIC_UNSAFE' ? 'DYNAMIC_UNSAFE' : 'DYNAMIC_SAFE',
          isRegex: Boolean(rule.condition?.regexFilter),
        });
        if (!band || !band.startsWith('DYNAMIC_')) continue;
        const record = ownership.durable.get(rule.id);
        if (foreignSchema) {
          result.unknownRuleIdsKept.push(rule.id);
          adopted.push({ id: rule.id, band, ownerId: `foreign-schema-${rule.id}`, allocatedAt: Date.now() });
          continue;
        }
        if (record) {
          result.restoredDynamicRuleIds.push(rule.id);
          ownership.durable.clearUnknownSighting(rule.id);
          adopted.push({ id: rule.id, band, ownerId: record.ownerId, allocatedAt: record.createdAt });
        } else {
          const sightings = ownership.durable.unknownSighting(rule.id);
          if (sightings >= UNKNOWN_GRACE_RECONCILES) {
            dynamicToRemove.push(rule.id);
          } else {
            result.unknownRuleIdsKept.push(rule.id);
            adopted.push({ id: rule.id, band, ownerId: `recovered-unknown-${rule.id}`, allocatedAt: Date.now() });
          }
        }
      }

      // 3. KNOWN + MISSING → ownership without a physical rule is stale metadata.
      for (const record of ownership.session.all()) {
        if (!sessionIds.has(record.ruleId)) {
          ownership.session.delete(record.ruleId);
          result.metadataRecordsCleaned.push(record.ruleId);
        }
      }
      for (const record of ownership.durable.all()) {
        // A durable record mid-promotion (PROMOTING) is settled by ground truth
        // below; only settled states are cleaned here.
        if (!dynamicIds.has(record.ruleId) && record.lifecycle !== 'PROMOTING') {
          ownership.durable.delete(record.ruleId);
          result.metadataRecordsCleaned.push(record.ruleId);
        }
      }

      // 3b. PROMOTING is the crash window of the ownership-first promotion
      // journal: a worker that dies between the durable metadata write and the
      // physical install (or between install and the PERSISTED_DYNAMIC patch)
      // would otherwise strand this lifecycle forever — invisible to the user,
      // excluded from decay, and a phantom dedupe target for future promotions.
      // Ground truth settles it deterministically: physical rule present → the
      // promotion committed, mark PERSISTED_DYNAMIC; missing → the promotion
      // never landed, drop the record so the family can be re-learned.
      for (const record of ownership.durable.all()) {
        if (record.lifecycle !== 'PROMOTING') continue;
        if (dynamicIds.has(record.ruleId)) {
          ownership.durable.patch(record.ruleId, { lifecycle: 'PERSISTED_DYNAMIC' });
        } else {
          ownership.durable.delete(record.ruleId);
          result.metadataRecordsCleaned.push(record.ruleId);
        }
        result.promotingRecordsResolved.push(record.ruleId);
      }

      // 4. Apply proven-orphan removals and rebuild allocator state.
      if (foreignSchema) {
        result.foreignSchemaProtected = true;
        result.errors.push('ownership schema unreadable — orphan removal suppressed this boot');
      }
      if (!foreignSchema && sessionToRemove.length > 0) {
        await dnrBackend.updateSessionRules({ removeRuleIds: sessionToRemove });
        sessionToRemove.forEach((id) => idAllocator.release(id));
        result.orphanedSessionRulesRemoved = sessionToRemove;
      }
      if (!foreignSchema && dynamicToRemove.length > 0) {
        await dnrBackend.updateDynamicRules({ removeRuleIds: dynamicToRemove });
        dynamicToRemove.forEach((id) => idAllocator.release(id));
        result.orphanedDynamicRulesRemoved = dynamicToRemove;
      }
      idAllocator.adopt(adopted);
      await ownership.flush();
    } catch (err: unknown) {
      result.reconciledSuccessfully = false;
      result.errors.push(err instanceof Error ? err.message : String(err));
    }

    return result;
  }
}

export type { LearnedRuleOwnership };
