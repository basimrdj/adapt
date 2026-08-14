import { describe, expect, it } from 'vitest';
import { AutonomySessionRepository } from '../../../src/background/autonomy/session';
import { AutonomyLoopState } from '../../../src/background/autonomy/saei';

class MemoryBackend {
  private data: Record<string, unknown> = {};
  get(keys: string[]): Promise<Record<string, unknown>> {
    return Promise.resolve(Object.fromEntries(keys.filter((key) => key in this.data).map((key) => [key, this.data[key]])));
  }
  set(value: Record<string, unknown>): Promise<void> {
    this.data = { ...this.data, ...value };
    return Promise.resolve();
  }
  remove(keys: string[]): Promise<void> {
    for (const key of keys) delete this.data[key];
    return Promise.resolve();
  }
}

const state: AutonomyLoopState = {
  status: 'EXPLORING', hypotheses: [], experiments: [], attempts: 1, aiCalls: 0, capabilityGaps: [],
};

describe('autonomy worker-restart persistence', () => {
  it('restores an in-progress loop from session storage', async () => {
    const backend = new MemoryBackend();
    const first = new AutonomySessionRepository(backend);
    const loops = new Map([['graph:1', state]]);
    await first.persist(loops);
    const restarted = new AutonomySessionRepository(backend);
    const restored = await restarted.restore();
    expect(restored.get('graph:1')?.status).toBe('EXPLORING');
    expect(restored.get('graph:1')?.attempts).toBe(1);
  });
});
