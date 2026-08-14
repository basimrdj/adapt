import { StorageBackend } from '../../core/recipes/store';
import { STORAGE_KEYS } from '../../shared/constants';
import { AutonomyLoopState } from './saei';

export interface AutonomySessionSnapshot {
  version: 1;
  savedWallMs: number;
  loops: Array<[string, AutonomyLoopState]>;
}

export class AutonomySessionRepository {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly backend: StorageBackend) {}

  async restore(): Promise<Map<string, AutonomyLoopState>> {
    const data = await this.backend.get([STORAGE_KEYS.AUTONOMY_STATE]);
    const snapshot = data[STORAGE_KEYS.AUTONOMY_STATE] as AutonomySessionSnapshot | undefined;
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.loops)) return new Map();
    return new Map(snapshot.loops.filter(([key, value]) => typeof key === 'string' && value && typeof value === 'object'));
  }

  persist(loops: ReadonlyMap<string, AutonomyLoopState>): Promise<void> {
    const snapshot: AutonomySessionSnapshot = {
      version: 1,
      savedWallMs: Date.now(),
      loops: [...loops.entries()].map(([key, value]) => [key, JSON.parse(JSON.stringify(value)) as AutonomyLoopState]),
    };
    this.writeChain = this.writeChain.then(() => this.backend.set({ [STORAGE_KEYS.AUTONOMY_STATE]: snapshot }));
    return this.writeChain;
  }
}
