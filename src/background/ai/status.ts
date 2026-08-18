/**
 * Bounded AI planner status for the Options page (section 13: no silent failure).
 *
 * DEVELOPMENT-ONLY credential storage note: the planner credential itself lives in
 * chrome.storage.local under `adapt_ai_config` — acceptable only for this private
 * development build; public distribution needs an authenticated relay with
 * user-scoped credentials. This status record never contains the credential, the
 * endpoint, browsing URLs, or packet contents — only timestamps, latency, and a
 * coarse failure class.
 */

export const AI_STATUS_STORAGE_KEY = 'adapt_ai_status';

export type PlannerFailureClass = 'timeout' | 'transport' | 'schema' | 'policy' | 'truncated' | `http-${string}`;

export interface AiPlannerStatus {
  version: 1;
  lastSuccessAt?: number;
  lastLatencyMs?: number;
  lastFailureAt?: number;
  lastFailureClass?: PlannerFailureClass;
}

async function writeStatus(patch: Partial<AiPlannerStatus>): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([AI_STATUS_STORAGE_KEY]);
    const prior = stored[AI_STATUS_STORAGE_KEY] as AiPlannerStatus | undefined;
    const next: AiPlannerStatus = { version: 1, ...(prior && prior.version === 1 ? prior : {}), ...patch };
    await chrome.storage.local.set({ [AI_STATUS_STORAGE_KEY]: next });
  } catch {
    // Status reporting must never break protection.
  }
}

export async function recordPlannerSuccess(latencyMs: number): Promise<void> {
  await writeStatus({ lastSuccessAt: Date.now(), lastLatencyMs: latencyMs });
}

export async function recordPlannerFailure(failureClass: PlannerFailureClass): Promise<void> {
  await writeStatus({ lastFailureAt: Date.now(), lastFailureClass: failureClass });
}

export async function readPlannerStatus(): Promise<AiPlannerStatus> {
  try {
    const stored = await chrome.storage.local.get([AI_STATUS_STORAGE_KEY]);
    const value = stored[AI_STATUS_STORAGE_KEY] as AiPlannerStatus | undefined;
    return value && value.version === 1 ? value : { version: 1 };
  } catch {
    return { version: 1 };
  }
}
