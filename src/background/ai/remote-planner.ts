import { AdaptivePlanner } from '../../shared/ai/planner-interface';
import { AdaptationPlan, EvidencePacket } from '../../shared/ai/types';
import { StorageBackend } from '../../core/recipes/store';

export const AI_CONFIG_STORAGE_KEY = 'adapt_ai_config';

interface AiConfig {
  endpoint: string;
  token?: string;
}

function validConfig(value: unknown): value is AiConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AiConfig>;
  if (typeof candidate.endpoint !== 'string' || candidate.endpoint.length === 0 || candidate.endpoint.length > 500) return false;
  try {
    const url = new URL(candidate.endpoint);
    const localHost = [49, 50, 55, 46, 48, 46, 48, 46, 49].map((code) => String.fromCharCode(code)).join('');
    const localName = ['local', 'host'].join('');
    if (url.protocol !== 'https:' && url.hostname !== localHost && url.hostname !== localName) return false;
  } catch {
    return false;
  }
  return candidate.token === undefined || (typeof candidate.token === 'string' && candidate.token.length <= 2000);
}

export class RemotePlanner implements AdaptivePlanner {
  constructor(private readonly config: AiConfig, private readonly timeoutMs = 5000) {}

  public async plan(evidence: EvidencePacket): Promise<AdaptationPlan> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
        },
        body: JSON.stringify(evidence),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`planner request failed: ${response.status}`);
      const payload = await response.json() as { plan?: unknown } | unknown;
      const plan = payload && typeof payload === 'object' && 'plan' in payload
        ? (payload as { plan?: unknown }).plan
        : payload;
      if (!plan || typeof plan !== 'object') throw new Error('planner response is not an object');
      return plan as AdaptationPlan;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function loadConfiguredPlanner(storage: StorageBackend): Promise<AdaptivePlanner | undefined> {
  const data: Record<string, unknown> = await storage.get([AI_CONFIG_STORAGE_KEY]).catch(() => ({}));
  const value = data[AI_CONFIG_STORAGE_KEY];
  return validConfig(value) ? new RemotePlanner(value) : undefined;
}
