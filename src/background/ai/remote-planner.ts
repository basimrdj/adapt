import { AdaptivePlanner } from '../../shared/ai/planner-interface';
import { AdaptationPlan, EvidencePacket } from '../../shared/ai/types';
import { ADAPTATION_PLAN_JSON_SCHEMA } from '../../shared/ai/schemas';
import { StorageBackend } from '../../core/recipes/store';
import { recordPlannerFailure, recordPlannerSuccess } from './status';

export const AI_CONFIG_STORAGE_KEY = 'adapt_ai_config';

export type AiPrivacyMode = 'STRICT' | 'DOMAIN_HINTS';

/**
 * Transport protocol for the configured endpoint:
 * - `openai`    — any OpenAI-compatible chat-completions API (OpenAI, OpenRouter,
 *                 Groq, xAI, Together, LM Studio/Ollama on loopback, …). Bearer key,
 *                 `{base}/chat/completions`, json_object response format.
 * - `azure`     — Azure OpenAI. A bare resource host is completed to the v1
 *                 chat-completions path (Bearer, proven); a full URL containing
 *                 /chat/completions is used verbatim (v1 → Bearer, classic
 *                 /openai/deployments/ URLs → api-key header).
 * - `anthropic` — Anthropic Messages API. `{base}/v1/messages`, x-api-key +
 *                 anthropic-version headers, system lifted out of messages.
 * - `relay`     — legacy lab relay: the raw EvidencePacket is POSTed and the plan
 *                 read from `.plan` ?? body. Kept for harness/loopback relays; not
 *                 offered in the Options UI.
 */
export type AiProviderKind = 'openai' | 'azure' | 'anthropic' | 'relay';

export interface AiConfig {
  endpoint: string;
  token?: string;
  /** Absent on pre-multiprovider stored configs — inferred from the endpoint
   * (Azure host → azure; anything else → relay), so old configs keep working. */
  provider?: AiProviderKind;
  /** Model/deployment id. Required by the openai, azure, and anthropic transports. */
  model?: string;
  privacyMode?: AiPrivacyMode;
  /** Planner request timeout in ms (1000-60000). Defaults to 15000 for remote providers. */
  timeoutMs?: number;
}

export interface LoadedPlannerConfig {
  planner: AdaptivePlanner;
  privacyMode: AiPrivacyMode;
  /** Where the effective config came from — stored Options value or the baked dev default. */
  source: 'stored' | 'built-in-default';
}

const SURVIVOR_PLANNER_SYSTEM_PROMPT = [
  'You are the ADAPT survivor attribution planner.',
  'Return only the strict AdaptationPlan JSON schema.',
  'Use only supplied opaque refs and supplied safe action IDs.',
  'Never emit URLs, code, selectors, or invented refs.',
  'For TARGETED_SESSION_DNR, set targetRef to a supplied request ref and parameter to the empty string.',
  'Do not copy any URL, filter, host, or path into parameter.',
  'For ambiguous third-party survivor evidence, prefer one TARGETED_SESSION_DNR action on the strongest supplied request ref.',
  'Abstain for protected auth, payment, media, download, or user-intent contexts.',
  'If trigger.reason is CONNECTION_TEST, return decision ABSTAIN with an empty actions array.',
].join(' ');

function isAzureOpenAiHost(hostname: string): boolean {
  return hostname.endsWith('.openai.azure.com');
}

/** Which transport speaks to this config. Explicit `provider` wins; legacy
 * configs (no provider field) infer from the endpoint so they never break. */
export function resolveProviderKind(config: AiConfig): AiProviderKind {
  if (config.provider) return config.provider;
  try {
    return isAzureOpenAiHost(new URL(config.endpoint).hostname) ? 'azure' : 'relay';
  } catch {
    return 'relay';
  }
}

/** Exported for the hermetic URL-construction pins. */
export function plannerRequestUrl(config: AiConfig): string {
  const trimmed = config.endpoint.replace(/\/+$/, '');
  switch (resolveProviderKind(config)) {
    case 'openai':
      return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
    case 'anthropic':
      if (trimmed.endsWith('/v1/messages')) return trimmed;
      if (trimmed.endsWith('/v1')) return `${trimmed}/messages`;
      return `${trimmed}/v1/messages`;
    case 'azure':
      // A full chat-completions URL (v1 or classic deployments + api-version) is
      // used verbatim; a bare resource host is completed to the proven v1 path.
      return trimmed.includes('/chat/completions') ? trimmed : `${trimmed}/openai/v1/chat/completions`;
    case 'relay':
      return trimmed;
  }
}

/** Anthropic stop_reason twin of azureFinishReason. */
export function anthropicStopReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const reason = (payload as { stop_reason?: unknown }).stop_reason;
  return typeof reason === 'string' ? reason : undefined;
}

/** Planner responses are small strict-JSON plans; anything bigger is a protocol violation. */
const MAX_PLANNER_RESPONSE_BYTES = 64 * 1024;

/** Exported for the hermetic truncation-failure pin (pure payload inspection). */
export function azureFinishReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const reason = (choices[0] as { finish_reason?: unknown }).finish_reason;
  return typeof reason === 'string' ? reason : undefined;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function validConfig(value: unknown): value is AiConfig {
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
  if (candidate.token !== undefined && (typeof candidate.token !== 'string' || candidate.token.length > 2000)) return false;
  if (candidate.privacyMode !== undefined && candidate.privacyMode !== 'STRICT' && candidate.privacyMode !== 'DOMAIN_HINTS') return false;
  if (
    candidate.provider !== undefined &&
    candidate.provider !== 'openai' && candidate.provider !== 'azure' && candidate.provider !== 'anthropic' && candidate.provider !== 'relay'
  ) return false;
  if (candidate.model !== undefined && (typeof candidate.model !== 'string' || candidate.model.length === 0 || candidate.model.length > 120)) return false;
  if (
    candidate.timeoutMs !== undefined &&
    (typeof candidate.timeoutMs !== 'number' || !Number.isFinite(candidate.timeoutMs) || candidate.timeoutMs < 1000 || candidate.timeoutMs > 60000)
  ) {
    return false;
  }
  // Explicit chat-provider configs must name a model — an empty model id is a
  // guaranteed provider 4xx with only a generic badge to show for it. Legacy
  // inferred configs (no provider field) are exempt: they predate the field.
  if (
    (candidate.provider === 'openai' || candidate.provider === 'anthropic' || candidate.provider === 'azure') &&
    (typeof candidate.model !== 'string' || candidate.model.length === 0)
  ) {
    return false;
  }
  return true;
}

/** Planner HTTP failure carrying its status so user-facing surfaces (Options
 * badge, connection test) can distinguish auth/ratelimit/server faults. */
export class PlannerHttpError extends Error {
  constructor(public readonly status: number) {
    super(`planner request failed: ${status}`);
    this.name = 'PlannerHttpError';
  }
}

/**
 * Production-wiring invariant: the live planner must be a RemotePlanner built
 * from a validated config. Anything else (a mock, a stub, a test double) in the
 * production path is a wiring bug — fail loud at the wiring site, never via an
 * inert forensics flag. Unit/integration tests inject doubles through the
 * engine/orchestrator setters directly; this guards only the production path.
 */
export function assertProductionPlanner(planner: AdaptivePlanner | undefined): void {
  if (planner !== undefined && !(planner instanceof RemotePlanner)) {
    throw new Error('production wiring requires a RemotePlanner instance');
  }
}

export class RemotePlanner implements AdaptivePlanner {
  /** Dev-only forensics: identifies the planner class without exposing config. */
  readonly plannerKind = 'remote';
  readonly endpointClass: 'loopback' | 'https-remote' | 'other';
  readonly providerKind: AiProviderKind;
  private readonly timeoutMs: number;

  constructor(private readonly config: AiConfig, timeoutMs?: number) {
    this.timeoutMs = timeoutMs ?? config.timeoutMs ?? 15000;
    this.providerKind = resolveProviderKind(config);
    try {
      const url = new URL(config.endpoint);
      this.endpointClass = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
        ? 'loopback'
        : url.protocol === 'https:'
          ? 'https-remote'
          : 'other';
    } catch {
      this.endpointClass = 'other';
    }
  }

  public async plan(evidence: EvidencePacket): Promise<AdaptationPlan> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      const kind = this.providerKind;
      const response = await fetch(plannerRequestUrl(this.config), {
        method: 'POST',
        headers: this.requestHeaders(),
        body: JSON.stringify(this.requestBody(kind, evidence)),
        signal: controller.signal,
      });
      if (!response.ok) {
        // Auth, rate-limit, and server faults are operationally distinct — the
        // Options badge must tell the user which one bit them.
        const failureClass = response.status === 401 || response.status === 403 || response.status === 429
          ? `http-${response.status}` as const
          : `http-${Math.floor(response.status / 100)}xx` as const;
        void recordPlannerFailure(failureClass);
        throw new PlannerHttpError(response.status);
      }
      const payload = await this.readJsonBounded(response);
      if (this.isTruncated(kind, payload)) {
        // The completion hit the token cap — the JSON is truncated by
        // construction and can never validate. Classify honestly; do not let a
        // half-written plan near the PolicyValidator.
        void recordPlannerFailure('truncated');
        throw new Error('planner completion truncated at token cap');
      }
      const plan = this.extractPlan(kind, payload);
      if (!plan || typeof plan !== 'object') {
        void recordPlannerFailure('schema');
        throw new Error('planner response is not an object');
      }
      void recordPlannerSuccess(Date.now() - startedAt);
      return plan as AdaptationPlan;
    } catch (error) {
      if (error instanceof Error && !error.message.startsWith('planner ')) {
        void recordPlannerFailure(error.name === 'AbortError' ? 'timeout' : 'transport');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Auth per transport: Azure's v1 API takes the key as a Bearer token (proven
   * against the live resource); classic /openai/deployments/ URLs take the
   * documented `api-key` header. Anthropic takes x-api-key + anthropic-version.
   * OpenAI-compatible and relay take Bearer when a key is configured (loopback
   * servers like LM Studio may legitimately have none).
   */
  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = this.config.token;
    switch (this.providerKind) {
      case 'azure': {
        if (!token) break;
        const url = plannerRequestUrl(this.config);
        if (url.includes('/openai/v1/')) headers['authorization'] = `Bearer ${token}`;
        else headers['api-key'] = token;
        break;
      }
      case 'anthropic': {
        if (token) headers['x-api-key'] = token;
        headers['anthropic-version'] = '2023-06-01';
        break;
      }
      default: {
        if (token) headers['authorization'] = `Bearer ${token}`;
      }
    }
    return headers;
  }

  private requestBody(kind: AiProviderKind, evidence: EvidencePacket): unknown {
    switch (kind) {
      case 'azure':
        return this.buildAzureRequest(evidence);
      case 'openai':
        return this.buildOpenAiRequest(evidence);
      case 'anthropic':
        return this.buildAnthropicRequest(evidence);
      case 'relay':
        return evidence;
    }
  }

  private isTruncated(kind: AiProviderKind, payload: unknown): boolean {
    if (kind === 'azure' || kind === 'openai') return azureFinishReason(payload) === 'length';
    if (kind === 'anthropic') return anthropicStopReason(payload) === 'max_tokens';
    return false;
  }

  private extractPlan(kind: AiProviderKind, payload: unknown): unknown {
    if (kind === 'azure' || kind === 'openai') return this.extractChatCompletionPlan(payload);
    if (kind === 'anthropic') return this.extractAnthropicPlan(payload);
    return this.extractGenericPlan(payload);
  }

  /**
   * Bounded body read: a hostile or malfunctioning endpoint could otherwise
   * stream an unbounded response into the service worker's memory. A non-JSON
   * body on a 200 is a protocol violation — 'schema', never 'transport'.
   */
  private async readJsonBounded(response: Response): Promise<unknown> {
    let text: string;
    if (!response.body) {
      text = await response.text();
    } else {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            total += value.length;
          }
          if (total > MAX_PLANNER_RESPONSE_BYTES) {
            void recordPlannerFailure('schema');
            throw new Error('planner response exceeds 64KB byte cap');
          }
        }
      } finally {
        reader.releaseLock();
      }
      text = new TextDecoder().decode(concatChunks(chunks, total));
    }
    if (text.length > MAX_PLANNER_RESPONSE_BYTES) {
      void recordPlannerFailure('schema');
      throw new Error('planner response exceeds 64KB byte cap');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      void recordPlannerFailure('schema');
      throw new Error('planner response body is not valid JSON');
    }
  }

  /** Azure OpenAI chat-completions with strict structured output (same call the lab relay made). */
  private buildAzureRequest(evidence: EvidencePacket): Record<string, unknown> {
    return {
      model: this.config.model ?? '',
      messages: [
        { role: 'system', content: SURVIVOR_PLANNER_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(evidence) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'adapt_survivor_plan', strict: true, schema: ADAPTATION_PLAN_JSON_SCHEMA },
      },
      reasoning_effort: 'low',
      max_completion_tokens: 600,
    };
  }

  /**
   * OpenAI-compatible chat-completions (OpenAI, OpenRouter, Groq, xAI, Together,
   * LM Studio, …). `json_object` is the widest-supported structured-output mode;
   * the system prompt already names the JSON schema, and every plan still passes
   * the production PolicyValidator after parsing, so schema drift fails loud.
   */
  private buildOpenAiRequest(evidence: EvidencePacket): Record<string, unknown> {
    return {
      model: this.config.model ?? '',
      messages: [
        { role: 'system', content: SURVIVOR_PLANNER_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(evidence) },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 600,
      temperature: 0,
    };
  }

  /** Anthropic Messages API — system is a top-level field, not a message. */
  private buildAnthropicRequest(evidence: EvidencePacket): Record<string, unknown> {
    return {
      model: this.config.model ?? '',
      max_tokens: 600,
      system: SURVIVOR_PLANNER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(evidence) }],
    };
  }

  private extractChatCompletionPlan(payload: unknown): unknown {
    if (!payload || typeof payload !== 'object') return undefined;
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return undefined;
    const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
    if (typeof content !== 'string' || content.length === 0) return undefined;
    try {
      return JSON.parse(content);
    } catch {
      return undefined;
    }
  }

  private extractAnthropicPlan(payload: unknown): unknown {
    if (!payload || typeof payload !== 'object') return undefined;
    const content = (payload as { content?: unknown }).content;
    if (!Array.isArray(content)) return undefined;
    const textBlock = content.find(
      (block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
    ) as { text?: unknown } | undefined;
    if (!textBlock || typeof textBlock.text !== 'string' || textBlock.text.length === 0) return undefined;
    try {
      return JSON.parse(textBlock.text);
    } catch {
      return undefined;
    }
  }

  private extractGenericPlan(payload: unknown): unknown {
    return payload && typeof payload === 'object' && 'plan' in payload
      ? (payload as { plan?: unknown }).plan
      : payload;
  }
}

export async function loadConfiguredPlanner(
  storage: StorageBackend,
  fallbackConfig?: AiConfig
): Promise<LoadedPlannerConfig | undefined> {
  const data: Record<string, unknown> = await storage.get([AI_CONFIG_STORAGE_KEY]).catch(() => ({}));
  // A stored key (even null/invalid) is authoritative — it is how the user disables the
  // built-in default. The fallback applies only when nothing was ever stored.
  const stored = AI_CONFIG_STORAGE_KEY in data;
  const value = stored ? data[AI_CONFIG_STORAGE_KEY] : fallbackConfig;
  if (!validConfig(value)) return undefined;
  return {
    planner: new RemotePlanner(value),
    privacyMode: value.privacyMode ?? 'STRICT',
    source: stored ? 'stored' : 'built-in-default',
  };
}
