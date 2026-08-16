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
});
