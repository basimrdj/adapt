import { ID_BANDS } from '../../shared/constants';

export type IdBandType = 'DYNAMIC_SAFE' | 'DYNAMIC_UNSAFE' | 'SESSION_SAFE' | 'SESSION_UNSAFE';

export interface RuleIdAllocation {
  id: number;
  band: IdBandType;
  ownerId: string; // transactionId or recipeId
  allocatedAt: number;
}

export class DnrIdAllocator {
  private allocatedIds = new Map<number, RuleIdAllocation>();
  private nextId: Record<IdBandType, number> = {
    DYNAMIC_SAFE: ID_BANDS.DYNAMIC_SAFE_MIN,
    DYNAMIC_UNSAFE: ID_BANDS.DYNAMIC_UNSAFE_MIN,
    SESSION_SAFE: ID_BANDS.SESSION_SAFE_MIN,
    SESSION_UNSAFE: ID_BANDS.SESSION_UNSAFE_MIN,
  };

  constructor(initialAllocations: RuleIdAllocation[] = []) {
    for (const alloc of initialAllocations) {
      this.allocatedIds.set(alloc.id, alloc);
      if (alloc.id >= this.nextId[alloc.band]) {
        this.nextId[alloc.band] = alloc.id + 1;
      }
    }
  }

  public allocate(band: IdBandType, ownerId: string): number {
    const max =
      band === 'DYNAMIC_SAFE'
        ? ID_BANDS.DYNAMIC_SAFE_MAX
        : band === 'DYNAMIC_UNSAFE'
        ? ID_BANDS.DYNAMIC_UNSAFE_MAX
        : band === 'SESSION_SAFE'
        ? ID_BANDS.SESSION_SAFE_MAX
        : ID_BANDS.SESSION_UNSAFE_MAX;

    const min =
      band === 'DYNAMIC_SAFE'
        ? ID_BANDS.DYNAMIC_SAFE_MIN
        : band === 'DYNAMIC_UNSAFE'
        ? ID_BANDS.DYNAMIC_UNSAFE_MIN
        : band === 'SESSION_SAFE'
        ? ID_BANDS.SESSION_SAFE_MIN
        : ID_BANDS.SESSION_UNSAFE_MIN;

    // Clamp before the collision scan: a nextId past the band ceiling must wrap
    // back to the floor, never leak into the neighbouring band. A rule id outside
    // its band reconciles under the wrong band and can be misclassified as an
    // orphan or collide with a foreign band's live rule.
    let candidate = this.nextId[band];
    if (candidate > max || candidate < min) candidate = min;

    const bandSize = max - min + 1;
    let visited = 0;
    while (this.allocatedIds.has(candidate)) {
      candidate = candidate >= max ? min : candidate + 1;
      visited++;
      if (visited >= bandSize) {
        throw new Error(`Exhausted DNR Rule ID pool for band: ${band}`);
      }
    }

    this.nextId[band] = candidate >= max ? min : candidate + 1;
    const alloc: RuleIdAllocation = {
      id: candidate,
      band,
      ownerId,
      allocatedAt: Date.now(),
    };
    this.allocatedIds.set(candidate, alloc);
    return candidate;
  }

  /**
   * Adopts allocations recovered from authoritative browser/storage state after a
   * worker or browser restart. An empty in-memory Map is NOT evidence that an ID is
   * free — recovered records make previously-owned IDs unallocatable again.
   */
  public adopt(recovered: RuleIdAllocation[]): number {
    let adopted = 0;
    for (const alloc of recovered) {
      if (!this.allocatedIds.has(alloc.id)) {
        this.allocatedIds.set(alloc.id, alloc);
        adopted++;
      }
      if (alloc.id >= this.nextId[alloc.band]) {
        this.nextId[alloc.band] = alloc.id + 1;
      }
    }
    return adopted;
  }

  public isAllocated(id: number): boolean {
    return this.allocatedIds.has(id);
  }

  public release(id: number): boolean {
    return this.allocatedIds.delete(id);
  }

  public releaseByOwner(ownerId: string): number[] {
    const released: number[] = [];
    for (const [id, alloc] of this.allocatedIds.entries()) {
      if (alloc.ownerId === ownerId) {
        this.allocatedIds.delete(id);
        released.push(id);
      }
    }
    return released;
  }

  public getAllAllocations(): RuleIdAllocation[] {
    return Array.from(this.allocatedIds.values());
  }

  public getAllocationsForBand(band: IdBandType): RuleIdAllocation[] {
    return Array.from(this.allocatedIds.values()).filter((a) => a.band === band);
  }
}
