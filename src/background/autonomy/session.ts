import { StorageBackend } from '../../core/recipes/store';
import { STORAGE_KEYS } from '../../shared/constants';
import { AutonomousExperiment, AutonomyLoopState } from './saei';
import { HealthVector } from '../../shared/types';
import { PageFingerprint } from '../../shared/causal/recipes';
import { PrimitiveExecutionRecord } from './executor-registry';

export interface AutonomyPendingState {
  txId: string;
  graphId: string;
  experiment: AutonomousExperiment;
  execution: PrimitiveExecutionRecord;
  baseline: HealthVector;
  fingerprint?: PageFingerprint;
  siteKey: string;
  navigationId: string;
  frameId: number;
  documentId: string;
  tabId: number;
  recipeReplay?: {
    recordId: string;
    applicationKey: string;
    fingerprint: PageFingerprint;
  };
}

export interface AutonomySessionSnapshot {
  version: 1 | 2;
  savedWallMs: number;
  loops: Array<[string, AutonomyLoopState]>;
  pending: AutonomyPendingState[];
}

export class AutonomySessionRepository {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly backend: StorageBackend) {}

  async restore(): Promise<Map<string, AutonomyLoopState>> {
    const data = await this.backend.get([STORAGE_KEYS.AUTONOMY_STATE]);
    const snapshot = data[STORAGE_KEYS.AUTONOMY_STATE] as AutonomySessionSnapshot | undefined;
    if (!snapshot || (snapshot.version !== 1 && snapshot.version !== 2) || !Array.isArray(snapshot.loops)) return new Map();
    return new Map(snapshot.loops.filter(([key, value]) => typeof key === 'string' && value && typeof value === 'object'));
  }

  async restoreSnapshot(): Promise<AutonomySessionSnapshot | undefined> {
    const data = await this.backend.get([STORAGE_KEYS.AUTONOMY_STATE]);
    const snapshot = data[STORAGE_KEYS.AUTONOMY_STATE] as AutonomySessionSnapshot | undefined;
    if (!snapshot || (snapshot.version !== 1 && snapshot.version !== 2) || !Array.isArray(snapshot.loops)) return undefined;
    return { ...snapshot, pending: Array.isArray(snapshot.pending) ? snapshot.pending : [] };
  }

  persist(loops: ReadonlyMap<string, AutonomyLoopState>, pending: readonly AutonomyPendingState[] = []): Promise<void> {
    const snapshot: AutonomySessionSnapshot = {
      version: 2,
      savedWallMs: Date.now(),
      loops: [...loops.entries()].map(([key, value]) => [key, JSON.parse(JSON.stringify(value)) as AutonomyLoopState]),
      pending: JSON.parse(JSON.stringify(pending)) as AutonomyPendingState[],
    };
    this.writeChain = this.writeChain.then(() => this.backend.set({ [STORAGE_KEYS.AUTONOMY_STATE]: snapshot }));
    return this.writeChain;
  }
}
