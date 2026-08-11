import { describe, it, expect } from 'vitest';
import { DnrQuotaTracker } from '../../src/core/dnr/quota';
import { QUOTA_LIMITS } from '../../src/shared/constants';

describe('DnrQuotaTracker', () => {
  it('allows allocations within quota limits', () => {
    const tracker = new DnrQuotaTracker();
    const res = tracker.checkCapacity({
      dynamicSafe: 1000,
      dynamicUnsafe: 50,
      session: 20,
    });
    expect(res.allowed).toBe(true);
  });

  it('rejects allocations exceeding total dynamic rules limit', () => {
    const tracker = new DnrQuotaTracker();
    tracker.updateUsage({ dynamicSafe: QUOTA_LIMITS.MAX_DYNAMIC_SAFE });
    const res = tracker.checkCapacity({ dynamicSafe: 1 });
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('Exceeds max total dynamic rules quota');
  });

  it('rejects allocations exceeding unsafe rules subset limit', () => {
    const tracker = new DnrQuotaTracker();
    tracker.updateUsage({ dynamicUnsafe: QUOTA_LIMITS.MAX_DYNAMIC_UNSAFE });
    const res = tracker.checkCapacity({ dynamicUnsafe: 1 });
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('Exceeds max unsafe dynamic rules quota');
  });

  it('properly tracks and decrements rule usage', () => {
    const tracker = new DnrQuotaTracker();
    tracker.incrementUsage({ sessionRules: 100, regexSessionRules: 10 });
    expect(tracker.getUsage().sessionRules).toBe(100);
    expect(tracker.getUsage().regexSessionRules).toBe(10);

    tracker.decrementUsage({ sessionRules: 40, regexSessionRules: 4 });
    expect(tracker.getUsage().sessionRules).toBe(60);
    expect(tracker.getUsage().regexSessionRules).toBe(6);
  });
});
