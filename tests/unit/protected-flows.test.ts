/**
 * Protected-flow guard regression suite (the Azure unknown_msal_error boot
 * class and the Google chooser dead-click class): learned rules must NEVER
 * target protected flows — dedicated identity hosts, identity dependency CDNs,
 * captcha providers, payment/3DS hosts — not staged, not widened, not promoted
 * — and legacy poison already in a profile is purged at startup from physical
 * ground truth.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { DnrController, DnrBackend } from '../../src/core/dnr/controller';
import { OwnershipStore, LearnedRuleOwnership } from '../../src/core/dnr/ownership';
import {
  isProtectedAuthHost,
  isProtectedCaptchaHost,
  isProtectedFlowHost,
  isProtectedPaymentHost,
  filterTextMentionsProtectedFlow,
  ruleTargetsProtectedAuthHost,
  ruleTargetsProtectedFlow,
} from '../../src/shared/protected-flows';
import { PersonalLearningManager } from '../../src/background/learning/personal-learning';
import { IntentTracker } from '../../src/background/autonomy/intent-tracker';
import { StrategyAction } from '../../src/shared/types';

type Rule = chrome.declarativeNetRequest.Rule;

function installChromeStub(): void {
  const areaFor = () => {
    const backing = new Map<string, unknown>();
    return {
      get: async (key: string) => ({ [key]: backing.get(key) }),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) backing.set(key, value);
      },
      remove: async (key: string) => { backing.delete(key); },
    };
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: areaFor(), local: areaFor() },
  };
}

function makeOwnershipBackend() {
  const backing = new Map<string, unknown>();
  return {
    backing,
    get: async (key: string) => ({ [key]: backing.get(key) }),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) backing.set(key, value);
    },
  };
}

function makeBackend() {
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
      for (const id of u.removeRuleIds ?? []) dynamic.delete(id);
      for (const rule of u.addRules ?? []) dynamic.set(rule.id, rule);
    },
  };
  return { backend, session, dynamic };
}

function poisonRule(id: number, host: string, hostWide = false): Rule {
  return {
    id,
    priority: 1,
    action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
    condition: hostWide
      ? { requestDomains: [host], resourceTypes: ['script', 'image', 'xmlhttprequest'] as chrome.declarativeNetRequest.ResourceType[] }
      : { urlFilter: `||${host}/tracker^`, resourceTypes: ['script'] as chrome.declarativeNetRequest.ResourceType[] },
  };
}

function poisonRecord(ruleId: number, host: string, lifecycle: LearnedRuleOwnership['lifecycle'], hostWide = false): LearnedRuleOwnership {
  return {
    schemaVersion: 1,
    ruleId,
    band: hostWide ? 'SESSION_SAFE' : 'SESSION_SAFE',
    ownerId: `tx_${ruleId}`,
    lifecycle,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    requestFamilyKey: `${host}/tracker`,
    scheme: 'https:',
    authority: host,
    host,
    coarsePath: '/tracker',
    resourceTypes: ['script'],
    hostWide,
    scopeClass: 'session-experiment',
    evidenceCount: 3,
    healthyObservationCount: 1,
    matchCount: 2,
    rollbackCount: 0,
  } as LearnedRuleOwnership;
}

describe('protected-flow guard: auth endpoints are unblockable by learned rules', () => {
  beforeEach(installChromeStub);

  it('isProtectedAuthHost: exact + subdomain + dot-boundary semantics', () => {
    expect(isProtectedAuthHost('login.microsoftonline.com')).toBe(true);
    expect(isProtectedAuthHost('aadcdn.msauth.net')).toBe(true); // suffix of msauth.net
    expect(isProtectedAuthHost('tenant.okta.com')).toBe(true);
    expect(isProtectedAuthHost('LOGIN.LIVE.COM')).toBe(true);
    expect(isProtectedAuthHost('notmsauth.net')).toBe(false); // no dot boundary
    expect(isProtectedAuthHost('msauth.net.evil.com')).toBe(false); // protected host is not the suffix
    expect(isProtectedAuthHost('ads.example.com')).toBe(false);
    expect(isProtectedAuthHost('')).toBe(false);
    expect(isProtectedAuthHost(undefined)).toBe(false);
  });

  it('ruleTargetsProtectedAuthHost: targets hit, initiator-only does not', () => {
    expect(ruleTargetsProtectedAuthHost(poisonRule(1, 'aadcdn.msftauth.net'))).toBe(true);
    expect(ruleTargetsProtectedAuthHost(poisonRule(2, 'login.live.com', true))).toBe(true);
    expect(ruleTargetsProtectedAuthHost({
      id: 3, priority: 1, action: { type: 'block' },
      condition: { regexFilter: '^https?://logincdn\\.msauth\\.net/shared/.*/chunks/.*\\.js', resourceTypes: ['script'] },
    } as Rule)).toBe(true); // escaped dots are unescaped before tokenizing
    expect(ruleTargetsProtectedAuthHost({
      id: 4, priority: 1, action: { type: 'block' },
      condition: { urlFilter: '||tracker.example.com^', initiatorDomains: ['login.live.com'], resourceTypes: ['script'] },
    } as Rule)).toBe(false); // scoped TO a login page but TARGETS a tracker — not poison
    expect(ruleTargetsProtectedAuthHost(poisonRule(5, 'ads.example.com'))).toBe(false);
  });

  it('matrix predicates: dependency CDNs, captcha, payment hosts — with dot-boundary discipline', () => {
    // Identity dependency CDNs (the Google dead-click class)
    expect(isProtectedFlowHost('www.gstatic.com')).toBe(true);
    expect(isProtectedFlowHost('accounts.gstatic.com')).toBe(true);
    expect(isProtectedFlowHost('ssl.gstatic.com')).toBe(true);
    expect(isProtectedFlowHost('apis.google.com')).toBe(true);
    expect(isProtectedFlowHost('content.googleapis.com')).toBe(true);
    expect(isProtectedFlowHost('applepay.cdn-apple.com')).toBe(true);
    // Captcha providers
    expect(isProtectedCaptchaHost('www.recaptcha.net')).toBe(true);
    expect(isProtectedCaptchaHost('hcaptcha.com')).toBe(true);
    expect(isProtectedCaptchaHost('challenges.cloudflare.com')).toBe(true);
    expect(isProtectedCaptchaHost('client-api.arkoselabs.com')).toBe(true);
    // Payment / 3DS
    expect(isProtectedPaymentHost('js.stripe.com')).toBe(true);
    expect(isProtectedPaymentHost('api.stripe.com')).toBe(true);
    expect(isProtectedPaymentHost('www.paypal.com')).toBe(true);
    expect(isProtectedPaymentHost('checkoutshopper-live.adyen.com')).toBe(true);
    expect(isProtectedPaymentHost('js.klarna.com')).toBe(true);
    expect(isProtectedPaymentHost('pay.google.com')).toBe(true);
    // Discipline: lookalikes and mixed-use giants stay blockable
    expect(isProtectedFlowHost('notgstatic.com')).toBe(false);
    expect(isProtectedFlowHost('gstatic.com.evil.com')).toBe(false);
    expect(isProtectedFlowHost('google.com')).toBe(false); // search ads stay covered
    expect(isProtectedFlowHost('www.google.com')).toBe(false);
    expect(isProtectedFlowHost('stripe.rs-1028-a.com')).toBe(false); // phishing lookalike
    expect(isProtectedFlowHost('facebook.com')).toBe(false); // content host with login path
    expect(isProtectedFlowHost(undefined)).toBe(false);
  });

  it('path-pair protection: google.com/recaptcha is protected, the rest of google.com is not', () => {
    expect(filterTextMentionsProtectedFlow('||google.com/recaptcha/api2/anchor^')).toBe(true);
    expect(filterTextMentionsProtectedFlow('|https://www.google.com/recaptcha/api.js|')).toBe(true);
    expect(filterTextMentionsProtectedFlow('^https?://www\\.google\\.com/recaptcha/.*')).toBe(true); // escaped regex form
    expect(filterTextMentionsProtectedFlow('||google.com/adsense/^')).toBe(false);
    expect(filterTextMentionsProtectedFlow('||google.com/pagead/^')).toBe(false);
  });

  it('ruleTargetsProtectedFlow: learned rules against the full matrix are caught', () => {
    expect(ruleTargetsProtectedFlow(poisonRule(11, 'www.gstatic.com'))).toBe(true); // the proven dead-click poison
    expect(ruleTargetsProtectedFlow(poisonRule(12, 'accounts.gstatic.com', true))).toBe(true);
    expect(ruleTargetsProtectedFlow(poisonRule(13, 'firebaselogging-pa.googleapis.com', true))).toBe(true); // telemetry hosts on dependency CDNs are refused at the learned planes (static lists still cover them)
    expect(ruleTargetsProtectedFlow(poisonRule(14, 'js.stripe.com'))).toBe(true);
    expect(ruleTargetsProtectedFlow(poisonRule(15, 'hcaptcha.com', true))).toBe(true);
    expect(ruleTargetsProtectedFlow({
      id: 16, priority: 1, action: { type: 'block' },
      condition: { urlFilter: '||google.com/recaptcha/api2/bframe^', resourceTypes: ['sub_frame'] },
    } as Rule)).toBe(true);
    expect(ruleTargetsProtectedFlow(poisonRule(17, 'pagead2.googlesyndication.com'))).toBe(false); // ad hosts stay blockable
    expect(ruleTargetsProtectedFlow(poisonRule(18, 'doubleclick.net', true))).toBe(false);
  });

  it('intent classification is host-aware: continuation paths on identity hosts stay oauth-like', () => {
    const tracker = new IntentTracker();
    const tabId = 41;
    // No recorded intent — orphan target. destinationClass must still classify
    // by host, not by pathname keywords.
    const accountChooser = tracker.correlate({ sourceTabId: tabId, sourceFrameId: 0, targetTabId: 42, url: 'https://accounts.google.com/AccountChooser?continue=x', sourceOrigin: 'https://example.com' });
    expect(accountChooser.destinationClass).toBe('oauth-like');
    const completeSignIn = tracker.correlate({ sourceTabId: tabId, sourceFrameId: 0, targetTabId: 43, url: 'https://accounts.google.com/CompleteSignIn?x=1', sourceOrigin: 'https://example.com' });
    expect(completeSignIn.destinationClass).toBe('oauth-like');
    const ppsecure = tracker.correlate({ sourceTabId: tabId, sourceFrameId: 0, targetTabId: 44, url: 'https://login.live.com/ppsecure/post.srf?uaid=x', sourceOrigin: 'https://example.com' });
    expect(ppsecure.destinationClass).toBe('oauth-like');
    const sas = tracker.correlate({ sourceTabId: tabId, sourceFrameId: 0, targetTabId: 45, url: 'https://login.microsoftonline.com/common/SAS/ProcessAuth', sourceOrigin: 'https://example.com' });
    expect(sas.destinationClass).toBe('oauth-like');
    const stripe = tracker.correlate({ sourceTabId: tabId, sourceFrameId: 0, targetTabId: 46, url: 'https://js.stripe.com/v3/three-d-secure/x', sourceOrigin: 'https://shop.example.com' });
    expect(stripe.destinationClass).toBe('payment-like');
    // Non-registered hosts keep the pathname fallback, and plain cross-origin stays cross-origin.
    const pathFallback = tracker.correlate({ sourceTabId: tabId, sourceFrameId: 0, targetTabId: 47, url: 'https://idp.example.org/oauth2/authorize', sourceOrigin: 'https://example.com' });
    expect(pathFallback.destinationClass).toBe('oauth-like');
    const ordinary = tracker.correlate({ sourceTabId: tabId, sourceFrameId: 0, targetTabId: 48, url: 'https://tracker.example.net/pixel', sourceOrigin: 'https://example.com' });
    expect(ordinary.destinationClass).toBe('cross-origin');
    // Same-origin is same-origin even on a protected host.
    const sameOrigin = tracker.correlate({ sourceTabId: tabId, sourceFrameId: 0, targetTabId: 49, url: 'https://accounts.google.com/AccountChooser', sourceOrigin: 'https://accounts.google.com' });
    expect(sameOrigin.destinationClass).toBe('same-origin');
  });

  it('staging refuses protected-host actions at birth; clean actions still stage', async () => {
    const { backend, session } = makeBackend();
    const ownership = new OwnershipStore(makeOwnershipBackend(), makeOwnershipBackend());
    await ownership.load();
    const controller = new DnrController(backend, ownership);
    const actions: StrategyAction[] = [
      { id: 'a1', type: 'NET_BLOCK', urlFilter: '||aadcdn.msauth.net/shared/chunks/app.js', resourceTypes: ['script'] } as StrategyAction,
      { id: 'a2', type: 'NET_BLOCK', urlFilter: '', requestDomains: ['login.live.com'], resourceTypes: ['image'] } as StrategyAction,
      { id: 'a3', type: 'NET_BLOCK', urlFilter: '||ads.example.com/banner^', resourceTypes: ['script'] } as StrategyAction,
    ];
    const { ruleIds } = await controller.addSessionExperimentRules(7, 'tx_mix', actions);
    expect(ruleIds).toHaveLength(1); // only the clean action compiled
    const installed = [...session.values()];
    expect(installed).toHaveLength(1);
    expect(installed[0]!.condition.urlFilter).toContain('ads.example.com');
  });

  it('persistLearnedRules refuses durable rules against auth hosts', async () => {
    const { backend, dynamic } = makeBackend();
    const ownership = new OwnershipStore(makeOwnershipBackend(), makeOwnershipBackend());
    await ownership.load();
    const controller = new DnrController(backend, ownership);
    const ids = await controller.persistLearnedRules('recipe_x', [
      { id: 'd1', type: 'NET_BLOCK', urlFilter: '||login.microsoftonline.com/telemetry^', resourceTypes: ['image'] } as StrategyAction,
      { id: 'd2', type: 'NET_BLOCK', urlFilter: '||tracker.example.net/pixel^', resourceTypes: ['image'] } as StrategyAction,
    ]);
    expect(ids).toHaveLength(1);
    expect([...dynamic.values()][0]!.condition.urlFilter).toContain('tracker.example.net');
  });

  it('startup purge removes legacy poison physically — metadata-backed and orphan — keeps clean rules', async () => {
    const { backend, session, dynamic } = makeBackend();
    const ownership = new OwnershipStore(makeOwnershipBackend(), makeOwnershipBackend());
    await ownership.load();
    const controller = new DnrController(backend, ownership);

    // Legacy poison as a pre-guard profile would carry it: one with ownership
    // metadata, one whose metadata was lost, plus healthy rules that must stay.
    session.set(910001, poisonRule(910001, 'aadcdn.msauth.net'));
    session.set(910002, poisonRule(910002, 'tracker.example.com'));
    dynamic.set(700001, poisonRule(700001, 'msftauth.net', true));
    dynamic.set(700002, poisonRule(700002, 'ads.example.net'));
    // The Google chooser dead-click poison: a legacy host-wide rule on the
    // sign-in dependency CDN, exactly the class proven by interception repro.
    dynamic.set(700003, poisonRule(700003, 'www.gstatic.com', true));
    dynamic.set(700004, poisonRule(700004, 'js.stripe.com', true));
    ownership.session.upsert(poisonRecord(910001, 'aadcdn.msauth.net', 'HEALTHY_SESSION'));
    ownership.session.upsert(poisonRecord(910002, 'tracker.example.com', 'HEALTHY_SESSION'));
    ownership.durable.upsert(poisonRecord(700002, 'ads.example.net', 'PERSISTED_DYNAMIC'));
    ownership.durable.upsert(poisonRecord(700003, 'www.gstatic.com', 'PERSISTED_DYNAMIC', true));
    // 700001 deliberately has NO ownership record — the physical sweep must still get it.

    const removed = await controller.purgeProtectedAuthRules();
    expect(removed).toBe(4);
    expect(session.has(910001)).toBe(false);
    expect(dynamic.has(700001)).toBe(false);
    expect(dynamic.has(700003)).toBe(false);
    expect(dynamic.has(700004)).toBe(false);
    expect(session.has(910002)).toBe(true);
    expect(dynamic.has(700002)).toBe(true);
    // Evidence trail: the metadata-backed poison survives as REVOKED.
    expect(ownership.session.get(910001)?.lifecycle).toBe('REVOKED');
    expect(ownership.session.get(910002)?.lifecycle).toBe('HEALTHY_SESSION');
  });

  it('learning loop: healthy protected-host rule gets no twin and is revoked instead of promoted', async () => {
    const { backend, session, dynamic } = makeBackend();
    const ownership = new OwnershipStore(makeOwnershipBackend(), makeOwnershipBackend());
    await ownership.load();
    // Bypass the birth guard to simulate a legacy staged record reaching the loop.
    const controller = new DnrController(backend, ownership);
    session.set(920001, poisonRule(920001, 'logincdn.msauth.net'));
    ownership.session.upsert(poisonRecord(920001, 'logincdn.msauth.net', 'STAGED_SESSION'));
    const learning = new PersonalLearningManager(controller);
    learning.rebuildIndex();

    learning.registerStagedContext('tx_920001', { siteKey: 'login.live.com' });
    learning.markHealthy('tx_920001');
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the async twin stage attempt settle
    expect([...session.values()].filter((r) => r.condition.requestDomains?.includes('logincdn.msauth.net'))).toHaveLength(0); // no twin
    expect(session.has(920001)).toBe(true); // still staged at this point

    // A later match drives promotion — the protected host is revoked, never persisted.
    const observed = learning.observeBlocked('https://logincdn.msauth.net/tracker/lib.js', 'script', 'https://login.live.com/page');
    expect(observed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.has(920001)).toBe(false); // revoked by the promote guard
    expect(dynamic.size).toBe(0); // never persisted
    expect(ownership.session.get(920001)?.lifecycle).toBe('REVOKED');
  });
});
