import { describe, expect, it } from 'vitest';
import {
  classifyPopupDestination,
  decidePopupOpen,
  PopupActivationContext,
} from '../../src/page/popup-broker-policy';

const activation = (overrides: Partial<PopupActivationContext> = {}): PopupActivationContext => ({
  deadlineMs: 2000,
  expectedNewContext: false,
  protectedFlow: false,
  openedCount: 0,
  ...overrides,
});

describe('document-start popup broker policy', () => {
  it('prevents an unassociated popup before a target can be created', () => {
    const decision = decidePopupOpen(undefined, classifyPopupDestination('https://ads.invalid/x', 'https://site.invalid/'), 100);
    expect(decision).toEqual({ allow: false, reason: 'no-activation' });
  });

  it('allows one matching target-blank destination', () => {
    const destination = classifyPopupDestination('https://identity.invalid/login', 'https://site.invalid/');
    const decision = decidePopupOpen(activation({ expectedNewContext: true, expectedDestinationKey: destination.key }), destination, 100);
    expect(decision).toEqual({ allow: true, reason: 'protected-flow' });
  });

  it('preserves protected flows and blocks extra fan-out', () => {
    const destination = classifyPopupDestination('https://checkout.invalid/pay', 'https://site.invalid/');
    expect(decidePopupOpen(activation(), destination, 100).allow).toBe(true);
    expect(decidePopupOpen(activation({ openedCount: 1 }), destination, 100)).toEqual({ allow: false, reason: 'extra-target' });
  });

  it('blocks a same-tab click from opening an unrelated target', () => {
    const destination = classifyPopupDestination('https://ads.invalid/x', 'https://site.invalid/');
    expect(decidePopupOpen(activation(), destination, 100)).toEqual({ allow: false, reason: 'unexpected-target' });
  });

  it('classifies protected identity/payment hosts by host, not pathname keywords', () => {
    // Continuation paths with no keyword previously dead-ended at cross-origin
    // and the broker denied the popup — the OAuth dead-open class.
    expect(classifyPopupDestination('https://accounts.google.com/AccountChooser?continue=x', 'https://site.invalid/').className).toBe('oauth-like');
    expect(classifyPopupDestination('https://accounts.google.com/CompleteSignIn?x=1', 'https://site.invalid/').className).toBe('oauth-like');
    expect(classifyPopupDestination('https://login.live.com/ppsecure/post.srf?uaid=x', 'https://site.invalid/').className).toBe('oauth-like');
    expect(classifyPopupDestination('https://login.microsoftonline.com/common/SAS/ProcessAuth', 'https://site.invalid/').className).toBe('oauth-like');
    expect(classifyPopupDestination('https://js.stripe.com/v3/three-d-secure/x', 'https://shop.invalid/').className).toBe('payment-like');
    // Discipline: lookalikes and unregistered hosts do not get the discount
    // (keyword-free paths, so only the host check could classify them).
    expect(classifyPopupDestination('https://accounts.google.com.evil.invalid/AccountChooser', 'https://site.invalid/').className).toBe('cross-origin');
    expect(classifyPopupDestination('https://tracker.invalid/pixel', 'https://site.invalid/').className).toBe('cross-origin');
    // Pathname-keyword fallback still works for unregistered identity providers,
    // and protected hosts classify identically first- or third-party.
    expect(classifyPopupDestination('https://idp.invalid/oauth2/authorize', 'https://site.invalid/').className).toBe('oauth-like');
    expect(classifyPopupDestination('https://accounts.google.com/AccountChooser', 'https://accounts.google.com/ServiceLogin').className).toBe('oauth-like');
  });

  it('extends the activation deadline for protected destinations (async SDK continuations), not for ads', () => {
    const act = activation({ deadlineMs: 1000 }); // base window already expired at nowMs=3000
    const chooser = classifyPopupDestination('https://accounts.google.com/AccountChooser?continue=x', 'https://site.invalid/');
    expect(decidePopupOpen(act, chooser, 3000)).toEqual({ allow: true, reason: 'protected-flow' });
    // …but not forever: past the extended window the gesture is stale.
    expect(decidePopupOpen(act, chooser, 7000)).toEqual({ allow: false, reason: 'no-activation' });
    // Unprotected destinations get no extension.
    const ads = classifyPopupDestination('https://ads.invalid/x', 'https://site.invalid/');
    expect(decidePopupOpen(act, ads, 3000)).toEqual({ allow: false, reason: 'no-activation' });
    // Fan-out suppression still applies inside the extended window.
    expect(decidePopupOpen(activation({ deadlineMs: 1000, openedCount: 1 }), chooser, 3000)).toEqual({ allow: false, reason: 'extra-target' });
  });
});
