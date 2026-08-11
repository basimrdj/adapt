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

  it('rejects allocations exceeding safe dynamic rules limit', () => {
    const tracker = new DnrQuotaTracker();
    tracker.updateUsage({ dynamicSafe: QUOTA_LIMITS.MAX_DYNAMIC_SAFE });
    const res = tracker.checkCapacity({ dynamicSafe: 1 });
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('Exceeds max safe dynamic rules quota');
  });

  it('rejects allocations exceeding unsafe rules limit', () => {
    const tracker = new DnrQuotaTracker();
    tracker.updateUsage({ dynamicUnsafe: QUOTA_LIMITS.MAX_DYNAMIC_UNSAFE });
    const res = tracker.checkCapacity({ dynamicUnsafe: 1 });
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('Exceeds max unsafe dynamic rules quota');
  });
});
