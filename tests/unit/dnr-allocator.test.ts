import { describe, it, expect } from 'vitest';
import { DnrIdAllocator } from '../../src/core/dnr/ids';
import { ID_BANDS } from '../../src/shared/constants';

describe('DnrIdAllocator', () => {
  it('allocates IDs within specific numeric bands', () => {
    const allocator = new DnrIdAllocator();

    const safeId = allocator.allocate('DYNAMIC_SAFE', 'recipe_1');
    expect(safeId).toBeGreaterThanOrEqual(ID_BANDS.DYNAMIC_SAFE_MIN);
    expect(safeId).toBeLessThanOrEqual(ID_BANDS.DYNAMIC_SAFE_MAX);

    const unsafeId = allocator.allocate('DYNAMIC_UNSAFE', 'recipe_1');
    expect(unsafeId).toBeGreaterThanOrEqual(ID_BANDS.DYNAMIC_UNSAFE_MIN);
    expect(unsafeId).toBeLessThanOrEqual(ID_BANDS.DYNAMIC_UNSAFE_MAX);

    const sessionId = allocator.allocate('SESSION_SAFE', 'tx_1');
    expect(sessionId).toBeGreaterThanOrEqual(ID_BANDS.SESSION_SAFE_MIN);
    expect(sessionId).toBeLessThanOrEqual(ID_BANDS.SESSION_SAFE_MAX);

    const sessionUnsafeId = allocator.allocate('SESSION_UNSAFE', 'tx_1');
    expect(sessionUnsafeId).toBeGreaterThanOrEqual(ID_BANDS.SESSION_UNSAFE_MIN);
    expect(sessionUnsafeId).toBeLessThanOrEqual(ID_BANDS.SESSION_UNSAFE_MAX);
  });

  it('releases allocated IDs and releases by owner', () => {
    const allocator = new DnrIdAllocator();
    const id1 = allocator.allocate('SESSION_SAFE', 'tx_99');
    const id2 = allocator.allocate('SESSION_SAFE', 'tx_99');
    const id3 = allocator.allocate('SESSION_SAFE', 'tx_100');

    expect(allocator.getAllAllocations().length).toBe(3);

    const released = allocator.releaseByOwner('tx_99');
    expect(released).toEqual([id1, id2]);
    expect(allocator.getAllAllocations().length).toBe(1);

    allocator.release(id3);
    expect(allocator.getAllAllocations().length).toBe(0);
  });
});
