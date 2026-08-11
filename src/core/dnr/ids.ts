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
    let candidate = this.nextId[band];
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

    let loops = 0;
    while (this.allocatedIds.has(candidate)) {
      candidate++;
      if (candidate > max) {
        candidate = min;
        loops++;
        if (loops > 1) {
          throw new Error(`Exhausted DNR Rule ID pool for band: ${band}`);
        }
      }
    }

    this.nextId[band] = candidate + 1;
    const alloc: RuleIdAllocation = {
      id: candidate,
      band,
      ownerId,
      allocatedAt: Date.now(),
    };
    this.allocatedIds.set(candidate, alloc);
    return candidate;
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
