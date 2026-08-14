import { describe, expect, it } from 'vitest';
import { IntentTracker } from '../../../src/background/autonomy/intent-tracker';
import { classifyNavigationTarget } from '../../../src/background/autonomy/popup-classifier';

describe('navigation intent correlation', () => {
  it('correlates a media gesture without treating every target as unwanted', () => {
    const tracker = new IntentTracker();
    tracker.record(1, 0, 'doc', {
      ref: 'intent:i1', documentMonotonicMs: 1, capturedWallMs: Date.now(),
      elementRef: 'element:e1', elementRole: 'media-control', declaredDestinationClass: 'unknown',
      button: 0, modifiers: [], interactionType: 'click', navigationReasonablyExpected: false,
      sourceOriginHash: 'source',
    });
    const target = tracker.correlate({
      sourceTabId: 1, sourceFrameId: 0, targetTabId: 2,
      url: 'https://other.invalid/ad', sourceOrigin: 'https://source.invalid',
      timeStamp: Date.now(), foregroundState: 'background', openerRelationship: 'implicit',
    });
    expect(target.riskSignals).toEqual(expect.arrayContaining(['UNEXPECTED_AFTER_GESTURE', 'MEDIA_GESTURE_TARGET']));
    expect(classifyNavigationTarget(target).disposition).not.toBe('OBSERVE_ONLY');
  });

  it('keeps explicit OAuth and payment flows as negative controls', () => {
    const tracker = new IntentTracker();
    tracker.record(1, 0, 'doc', {
      ref: 'intent:i2', documentMonotonicMs: 1, capturedWallMs: Date.now(),
      elementRef: 'element:e2', elementRole: 'link', declaredDestinationClass: 'oauth-like',
      button: 0, modifiers: [], interactionType: 'click', navigationReasonablyExpected: true,
      sourceOriginHash: 'source',
    });
    const target = tracker.correlate({
      sourceTabId: 1, sourceFrameId: 0, targetTabId: 2,
      url: 'https://identity.invalid/oauth/authorize', sourceOrigin: 'https://source.invalid',
      timeStamp: Date.now(), foregroundState: 'foreground', openerRelationship: 'explicit',
    });
    const classification = classifyNavigationTarget(target);
    expect(classification.disposition).toBe('OBSERVE_ONLY');
    expect(classification.negativeControl).toBe(true);
  });
});
