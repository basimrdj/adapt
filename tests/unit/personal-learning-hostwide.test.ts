/**
 * Phase F within-run host-wide staging (PersonalLearningManager).
 *
 * Once a narrow survivor-AI session rule is marked healthy, the manager stages a
 * host-wide session TWIN (requestDomains = family host, site-scoped, same resource
 * types) so later pages of the run are protected before durable promotion lands.
 * These tests pin: twin shape, AI-gate coverage via the twin, G5 width refusals,
 * promotion cleanup of both session rules, the T8 storm guard on twins, and the
 * durable-covers skip / dedupe-removal hygiene.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DnrController, DnrBackend } from '../../src/core/dnr/controller';
import { OwnershipStore, LearnedRuleOwnership } from '../../src/core/dnr/ownership';
import { PersonalLearningManager } from '../../src/background/learning/personal-learning';

type Rule = chrome.declarativeNetRequest.Rule;

/** Forensics writes to chrome.storage.session — stub both storage areas. */
function installChromeStub(): void {
  const areaFor = () => {
    const backing = new Map<string, unknown>();
    return {
      get: async (key: string) => ({ [key]: backing.get(key) }),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) backing.set(key, value);
      },
    };
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: areaFor(), local: areaFor() },
  };
}

function makeBackend(opts?: { failDynamic?: boolean }): { backend: DnrBackend; session: Map<number, Rule>; dynamic: Map<number, Rule> } {
  const session = new Map<number, Rule>();
  const dynamic = new Map<number, Rule>();
  const backend: DnrBackend = {
    getSessionRules: async () => [...session.values()],
    getDynamicRules: async () => [...dynamic.values()],
    updateSessionRules: async (u) => {
      for (const id of u.removeRuleIds ?? []) session.delete(id);
      for (const rule of u.addRules ?? []) session.set(rule.id, rule);
    },
    updateDynamicRules: async (u) => {
      if (opts?.failDynamic) throw new Error('dynamic-write-failed');
      for (const id of u.removeRuleIds ?? []) dynamic.delete(id);
      for (const rule of u.addRules ?? []) dynamic.set(rule.id, rule);
    },
  };
  return { backend, session, dynamic };
}

function makeStore(): OwnershipStore {
  const backendFor = () => {
    const backing = new Map<string, unknown>();
    return {
      get: async (key: string) => ({ [key]: backing.get(key) }),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) backing.set(key, value);
      },
    };
  };
  return new OwnershipStore(backendFor(), backendFor());
}

async function makeManager(opts?: { failDynamic?: boolean }) {
  const ownership = makeStore();
  await ownership.load();
  const { backend, session, dynamic } = makeBackend(opts);
  const controller = new DnrController(backend, ownership);
  const manager = new PersonalLearningManager(controller);
  manager.rebuildIndex();
  return { ownership, controller, manager, session, dynamic };
}

async function until(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

const narrowAction = (host: string) => ({
  id: `narrow_${host}`,
  type: 'NET_BLOCK' as const,
  urlFilter: `|https://${host}/px/a*`,
  resourceTypes: ['script' as chrome.declarativeNetRequest.ResourceType],
});

/** Simulate the survivor-AI flow: stage narrow, attach context, mark healthy. */
async function stageHealthyNarrow(
  manager: PersonalLearningManager,
  controller: DnrController,
  host: string,
  siteKey: string
): Promise<number> {
  const txId = `tx_${host}`;
  const { ruleIds } = await controller.addSessionExperimentRules(undefined, txId, [narrowAction(host)]);
  manager.registerStagedContext(txId, { siteKey, confidence: 0.9 });
  manager.markHealthy(txId);
  return ruleIds[0]!;
}

const rulesForHost = (rules: Map<number, Rule>, host: string): Rule[] =>
  [...rules.values()].filter((rule) => JSON.stringify(rule.condition).includes(host));

function makeDurableRecord(ruleId: number, host: string, hostWide: boolean): LearnedRuleOwnership {
  return {
    schemaVersion: 1,
    ruleId,
    band: 'DYNAMIC_SAFE',
    ownerId: `personal_${host.replace(/[^a-z0-9.-]/g, '_')}`,
    lifecycle: 'PERSISTED_DYNAMIC',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    requestFamilyKey: `${host}/`,
    scheme: 'https:',
    authority: host,
    host,
    coarsePath: '/',
    resourceTypes: ['script'],
    hostWide,
    scopeClass: 'personal-blocklist',
    evidenceCount: 1,
    healthyObservationCount: 1,
    matchCount: 0,
    healthFailureCount: 0,
    rollbackCount: 0,
  };
}

describe('Phase F: within-run host-wide session staging', () => {
  beforeEach(() => {
    installChromeStub();
  });

  it('stages a site-scoped host-wide twin at markHealthy and covers the family pre-promotion', async () => {
    const { ownership, controller, manager, session, dynamic } = await makeManager();
    const narrowId = await stageHealthyNarrow(manager, controller, 'ads-fam.test', 'site-a.test');
    expect(narrowId).toBeDefined();

    const staged = await until(() => rulesForHost(session, 'ads-fam.test').some((rule) => rule.condition.requestDomains?.includes('ads-fam.test')));
    expect(staged).toBe(true);
    const twin = rulesForHost(session, 'ads-fam.test').find((rule) => rule.condition.requestDomains?.includes('ads-fam.test'))!;
    expect(twin.condition.urlFilter).toBeUndefined();
    expect(twin.condition.initiatorDomains).toEqual(['site-a.test']);
    // Host-wide width lifts the type restriction (telemetry beacons must not leak) —
    // every non-navigation type is covered; main_frame stays allowed.
    expect(twin.condition.resourceTypes).toContain('ping');
    expect(twin.condition.resourceTypes).toContain('websocket');
    expect(twin.condition.resourceTypes).toContain('script');
    expect(twin.condition.resourceTypes).not.toContain('main_frame');

    const twinRecord = ownership.session.all().find((record) => record.host === 'ads-fam.test' && record.hostWide);
    expect(twinRecord?.lifecycle).toBe('HEALTHY_SESSION');
    expect(twinRecord?.learnedFromSiteKey).toBe('site-a.test');

    // The AI gate can stand down on later pages of this site — before any durable rule exists.
    expect(dynamic.size).toBe(0);
    expect(manager.isFamilyCovered('ads-fam.test', 'script', 'site-a.test')).toBe(true);
    expect(manager.isFamilyCovered('sub.ads-fam.test', 'script', 'site-a.test')).toBe(true);
    expect(manager.isFamilyCovered('ads-fam.test', 'script', 'other-site.test')).toBe(false);
    // Host-wide width lifts the type restriction: ping/image families on this host
    // are covered too — detector telemetry must not leak past the twin.
    expect(manager.isFamilyCovered('ads-fam.test', 'image', 'site-a.test')).toBe(true);
    expect(manager.isFamilyCovered('ads-fam.test', 'ping', 'site-a.test')).toBe(true);
  });

  it('promotion installs a durable NARROW rule; the host-wide twin stays session-scoped', async () => {
    const { ownership, controller, manager, session, dynamic } = await makeManager();
    await stageHealthyNarrow(manager, controller, 'ads-fam.test', 'site-a.test');
    expect(await until(() => rulesForHost(session, 'ads-fam.test').length === 2)).toBe(true);

    manager.observeRequestInitiation('https://ads-fam.test/px/a/1.js', 'script', 'https://site-a.test/page', 'req-1');

    // The durable rule keeps the proven narrow family shape — never host width.
    // A width-gate miss must not outlive the browser session that staged it.
    expect(await until(() => ownership.durable.all().some((record) => record.lifecycle === 'PERSISTED_DYNAMIC'))).toBe(true);
    const durableRecords = ownership.durable.all().filter((record) => record.host === 'ads-fam.test');
    expect(durableRecords.length).toBe(1);
    expect(durableRecords[0]!.hostWide).toBe(false);
    const durable = rulesForHost(dynamic, 'ads-fam.test');
    expect(durable.length).toBe(1);
    expect(durable[0]!.condition.requestDomains).toBeUndefined();
    expect(durable[0]!.condition.urlFilter).toBeDefined();
    expect(durable[0]!.condition.initiatorDomains).toEqual(['site-a.test']);
    // The host-wide twin survives as session-scoped coverage: the session area
    // keeps it (no durable-hostWide supersede cleanup fires) and it re-derives
    // from the healthy family on later sessions.
    expect(rulesForHost(session, 'ads-fam.test').some((rule) => rule.condition.requestDomains?.includes('ads-fam.test'))).toBe(true);
    expect(manager.isFamilyCovered('ads-fam.test', 'script', 'site-a.test')).toBe(true);
  });

  it('refuses host-wide staging for shared-infra and first-party families', async () => {
    const { controller, manager, session } = await makeManager();
    await stageHealthyNarrow(manager, controller, 'cdn-cloudflare.test', 'site-a.test');
    await stageHealthyNarrow(manager, controller, 'site-a.test', 'site-a.test');
    await settle();

    expect(rulesForHost(session, 'cdn-cloudflare.test').some((rule) => rule.condition.requestDomains)).toBe(false);
    expect(rulesForHost(session, 'site-a.test').some((rule) => rule.condition.requestDomains)).toBe(false);
    expect(manager.isFamilyCovered('cdn-cloudflare.test', 'script', 'site-a.test')).toBe(false);
    expect(manager.isFamilyCovered('site-a.test', 'script', 'site-a.test')).toBe(false);
  });

  it('refuses host-wide staging for sister-domain asset CDNs and first-party content CDNs', async () => {
    const { controller, manager, session } = await makeManager();
    // The cnbc lesson: static-redesign.cnbcfm.com learned on cnbc.com — the
    // publisher's own asset CDN on a sibling registrable domain. Widening it
    // host-wide blocked the site's fonts, CSS, JS chunks, and images.
    await stageHealthyNarrow(manager, controller, 'static-redesign.cnbcfm.com', 'www.cnbc.com');
    // First-party content CDNs without brand containment in the label.
    await stageHealthyNarrow(manager, controller, 'video.fbcdn.net', 'www.facebook.com');
    await stageHealthyNarrow(manager, controller, 'i.ytimg.com', 'www.youtube.com');
    await settle();

    expect(rulesForHost(session, 'static-redesign.cnbcfm.com').some((rule) => rule.condition.requestDomains)).toBe(false);
    expect(rulesForHost(session, 'video.fbcdn.net').some((rule) => rule.condition.requestDomains)).toBe(false);
    expect(rulesForHost(session, 'i.ytimg.com').some((rule) => rule.condition.requestDomains)).toBe(false);
    expect(manager.isFamilyCovered('static-redesign.cnbcfm.com', 'image', 'www.cnbc.com')).toBe(false);
    expect(manager.isFamilyCovered('video.fbcdn.net', 'media', 'www.facebook.com')).toBe(false);
    expect(manager.isFamilyCovered('i.ytimg.com', 'image', 'www.youtube.com')).toBe(false);
    // The narrow learned blocks themselves still stand — refusal only caps width.
    expect(rulesForHost(session, 'static-redesign.cnbcfm.com').length).toBe(1);
    expect(rulesForHost(session, 'video.fbcdn.net').length).toBe(1);
    expect(rulesForHost(session, 'i.ytimg.com').length).toBe(1);
  });

  it('T8 retry-storm guard revokes a host-wide session twin', async () => {
    const { ownership, controller, manager, session } = await makeManager({ failDynamic: true });
    const narrowId = await stageHealthyNarrow(manager, controller, 'ads-storm.test', 'site-a.test');
    expect(await until(() => rulesForHost(session, 'ads-storm.test').length === 2)).toBe(true);
    const twinRecord = ownership.session.all().find((record) => record.host === 'ads-storm.test' && record.hostWide)!;

    // Simulate the narrow rule leaving (promotion attempt); the twin becomes the
    // first index match, exactly like the post-promotion within-run state.
    await controller.removeSessionExperimentRules([narrowId], 'promotion');
    manager.rebuildIndex();

    for (let i = 0; i < 6; i++) {
      manager.observeBlocked(`https://ads-storm.test/px/b/retry-${i}.js`, 'script', 'https://site-a.test/page', `storm-${i}`, 7);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await until(() => ownership.session.get(twinRecord.ruleId)?.lifecycle === 'REVOKED')).toBe(true);
    expect(rulesForHost(session, 'ads-storm.test').length).toBe(0);
  });

  it('content-breakage net revokes a host-wide twin after 2 blocked content fetches, narrow rule survives', async () => {
    const { ownership, controller, manager, session } = await makeManager({ failDynamic: true });
    await stageHealthyNarrow(manager, controller, 'ads-cdn-misjudge.test', 'site-a.test');
    expect(await until(() => rulesForHost(session, 'ads-cdn-misjudge.test').length === 2)).toBe(true);
    const twinRecord = ownership.session.all().find((record) => record.host === 'ads-cdn-misjudge.test' && record.hostWide)!;

    // Two distinct content-type failures — no retry storm on any single family,
    // so T8 stays silent; the widening itself is refuted (the cnbcfm class:
    // fonts/css/images dying one-shot each across the host).
    manager.observeBlocked('https://ads-cdn-misjudge.test/assets/logo.png', 'image', 'https://site-a.test/page', 'c1', 7);
    await new Promise((resolve) => setTimeout(resolve, 10));
    manager.observeBlocked('https://ads-cdn-misjudge.test/assets/body.woff2', 'font', 'https://site-a.test/page', 'c2', 7);
    expect(await until(() => ownership.session.get(twinRecord.ruleId)?.lifecycle === 'REVOKED')).toBe(true);

    const remaining = rulesForHost(session, 'ads-cdn-misjudge.test');
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.condition.requestDomains).toBeUndefined();
    // Only the widening was refuted: the narrow experiment rule stays healthy
    // (isFamilyCovered answers twin/durable coverage, so it reads cold here).
    const narrowRecord = ownership.session.all().find((record) => record.host === 'ads-cdn-misjudge.test' && !record.hostWide);
    expect(narrowRecord?.lifecycle).toBe('HEALTHY_SESSION');
    expect(manager.isFamilyCovered('ads-cdn-misjudge.test', 'image', 'site-a.test')).toBe(false);
  });

  it('skips twin staging when a durable host-wide rule already covers the family', async () => {
    const { ownership, controller, manager, session, dynamic } = await makeManager();
    ownership.durable.upsert(makeDurableRecord(1_000_500, 'ads-dupe.test', true));
    dynamic.set(1_000_500, {
      id: 1_000_500,
      priority: 100,
      action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
      condition: { requestDomains: ['ads-dupe.test'], resourceTypes: ['script' as chrome.declarativeNetRequest.ResourceType] },
    });
    manager.rebuildIndex();

    await stageHealthyNarrow(manager, controller, 'ads-dupe.test', 'site-a.test');
    await settle();
    // No twin staged — the durable rule already protects the family host-wide.
    expect(rulesForHost(session, 'ads-dupe.test').length).toBe(1);
    expect(rulesForHost(session, 'ads-dupe.test')[0]!.condition.requestDomains).toBeUndefined();
  });

  it('dedupe promotion removes the redundant session rule', async () => {
    const { ownership, controller, manager, session } = await makeManager();
    // A narrow durable record for the same family but a different resource type —
    // the session rule still matches first for script observations.
    const durableRecord = { ...makeDurableRecord(1_000_600, 'ads-dupe2.test', false), coarsePath: '/px/a', requestFamilyKey: 'ads-dupe2.test/px/a', resourceTypes: ['image'] };
    ownership.durable.upsert(durableRecord);
    manager.rebuildIndex();

    const narrowId = await stageHealthyNarrow(manager, controller, 'ads-dupe2.test', 'site-a.test');
    expect(await until(() => rulesForHost(session, 'ads-dupe2.test').length === 2)).toBe(true);

    manager.observeRequestInitiation('https://ads-dupe2.test/px/a/x.js', 'script', 'https://site-a.test/page', 'req-dupe');
    // Dedupe: the durable narrow rule covers this family — the narrow session rule
    // is removed instead of duplicated. The durable rule is NOT host-wide, so the
    // healthy twin stays behind as the within-run host-wide protection.
    expect(await until(() => ownership.session.get(narrowId) === undefined)).toBe(true);
    const remaining = rulesForHost(session, 'ads-dupe2.test');
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.condition.requestDomains).toEqual(['ads-dupe2.test']);
    expect(ownership.durable.get(1_000_600)?.evidenceCount).toBe(2);
  });

  it('bucketed index: subdomain tolerance survives promotion and clearAll, buckets stay narrow', async () => {
    const { ownership, controller, manager, session, dynamic } = await makeManager();
    await stageHealthyNarrow(manager, controller, 'ads-fam.test', 'site-a.test');
    expect(await until(() => rulesForHost(session, 'ads-fam.test').length === 2)).toBe(true);

    // Host-wide twin covers subdomains via the bucket; unrelated hosts stay cold.
    expect(manager.isFamilyCovered('cdn.ads-fam.test', 'script', 'site-a.test')).toBe(true);
    expect(manager.isFamilyCovered('deep.sub.ads-fam.test', 'script', 'site-a.test')).toBe(true);
    expect(manager.isFamilyCovered('unrelated.net', 'script', 'site-a.test')).toBe(false);
    expect(manager.observeRequestInitiation('https://unrelated.net/px/a/x.js', 'script', 'https://site-a.test/p', 'cold-1')).toBe(false);

    // A subdomain observation matches the twin (bucketed suffix tolerance) and
    // triggers its promotion; the durable rule keeps the narrow family shape
    // (width never persists) and the session twin keeps subdomain coverage alive.
    expect(manager.observeRequestInitiation('https://cdn.ads-fam.test/other/path.js', 'script', 'https://site-a.test/p', 'b1')).toBe(true);
    expect(await until(() => rulesForHost(dynamic, 'ads-fam.test').length === 1)).toBe(true);
    expect(rulesForHost(dynamic, 'ads-fam.test')[0]!.condition.requestDomains).toBeUndefined();
    expect(rulesForHost(dynamic, 'ads-fam.test')[0]!.condition.urlFilter).toBeDefined();
    expect(rulesForHost(session, 'ads-fam.test').some((rule) => rule.condition.requestDomains?.includes('ads-fam.test'))).toBe(true);
    expect(manager.isFamilyCovered('cdn.ads-fam.test', 'script', 'site-a.test')).toBe(true);

    // The narrow session rule dedupes onto the durable narrow rule and is
    // removed; the host-wide twin remains as the session-scoped coverage.
    manager.observeRequestInitiation('https://ads-fam.test/px/a/x.js', 'script', 'https://site-a.test/p', 'b2');
    expect(await until(() => rulesForHost(session, 'ads-fam.test').every((rule) => rule.condition.requestDomains !== undefined))).toBe(true);
    expect(manager.isFamilyCovered('ads-fam.test', 'script', 'site-a.test')).toBe(true);

    // Naive last-two-labels buckets: co.uk hosts share a bucket, suffix filter decides.
    await stageHealthyNarrow(manager, controller, 'ads-uk.co.uk', 'site-a.test');
    expect(await until(() => rulesForHost(session, 'ads-uk.co.uk').length === 2)).toBe(true);
    expect(manager.isFamilyCovered('cdn.ads-uk.co.uk', 'script', 'site-a.test')).toBe(true);
    expect(manager.isFamilyCovered('other.co.uk', 'script', 'site-a.test')).toBe(false);

    await manager.clearAll();
    // clearAll resets durable memory only — session-stage rules die with the
    // browser, so both host-wide twins correctly still cover.
    expect(manager.isFamilyCovered('cdn.ads-fam.test', 'script', 'site-a.test')).toBe(true);
    expect(manager.isFamilyCovered('cdn.ads-uk.co.uk', 'script', 'site-a.test')).toBe(true);
    expect(ownership.durable.all().filter((record) => record.lifecycle !== 'REVOKED')).toEqual([]);
  });
});
