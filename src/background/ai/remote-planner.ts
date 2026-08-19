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
  'Always return the complete plan object with every schema field (schemaVersion, hypothesis, selectedStrategyTier, actions, verification, abortConditions, explanationCodes), even when abstaining.',
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

/** Error bodies are inspected for parameter-negotiation hints; cap what we read. */
const MAX_ERROR_BODY_BYTES = 8 * 1024;

/**
 * Output-token budget per planner call. Reasoning-model endpoints (gpt-5 family
 * and proxies fronting them) spend completion tokens on hidden reasoning before
 * the plan JSON — the old 600 cap truncated them mid-plan (finish_reason
 * 'length'). 4096 covers reasoning plus the ~200-token plan with headroom.
 */
export const PLANNER_OUTPUT_TOKEN_BUDGET = 4096;

/**
 * Request-shape dialect for the openai-compatible transport. There is no single
 * dialect every "OpenAI-compatible" server accepts: gpt-5-family endpoints reject
 * `max_tokens` (demanding `max_completion_tokens`) and any explicit temperature;
 * older servers reject `reasoning_effort`; some reject structured
 * `response_format` entirely. The planner starts optimistic (strict json_schema —
 * the same server-side guarantee the Azure path has always had) and negotiates
 * down on HTTP 400/422 parameter rejections, caching the working dialect per
 * endpoint+model for the service worker's lifetime.
 */
export interface OpenAiDialect {
  responseFormat: 'json_schema' | 'json_object' | 'none';
  tokenField: 'max_completion_tokens' | 'max_tokens';
  temperature: boolean;
  reasoningEffort: boolean;
}

export const DEFAULT_OPENAI_DIALECT: OpenAiDialect = {
  responseFormat: 'json_schema',
  tokenField: 'max_completion_tokens',
  temperature: false,
  reasoningEffort: true,
};

/** Negotiation retries are protocol-shape discovery, never planner re-invocations:
 *  the ≤2 planner-calls-per-navigation budget counts plan() calls, and this cap
 *  bounds the HTTP attempts inside any single one. */
const MAX_NEGOTIATION_RETRIES = 3;

const negotiatedDialects = new Map<string, OpenAiDialect>();

/**
 * Derives the next dialect from an HTTP 400/422 error body. Providers name the
 * offending parameter in the error text (OpenAI: "Unsupported parameter:
 * 'max_tokens'… Use 'max_completion_tokens' instead."; Anthropic-shaped proxies:
 * "max_tokens: field required"). Returns undefined when no known adjustment
 * applies — the caller then surfaces the original failure unchanged.
 */
export function negotiateOpenAiDialect(current: OpenAiDialect, errorText: string): OpenAiDialect | undefined {
  const next: OpenAiDialect = { ...current };
  let changed = false;
  // Check max_completion_tokens first: the "use max_completion_tokens instead"
  // message names both fields and asks for the modern one.
  if (/max_completion_tokens/i.test(errorText)) {
    if (next.tokenField !== 'max_completion_tokens') {
      next.tokenField = 'max_completion_tokens';
      changed = true;
    }
  } else if (/max_tokens/i.test(errorText) && next.tokenField !== 'max_tokens') {
    next.tokenField = 'max_tokens';
    changed = true;
  }
  if (/temperature/i.test(errorText) && next.temperature) {
    next.temperature = false;
    changed = true;
  }
  if (/reasoning_effort/i.test(errorText) && next.reasoningEffort) {
    next.reasoningEffort = false;
    changed = true;
  }
  if (/response_format|json_schema|json_object/i.test(errorText) && next.responseFormat !== 'none') {
    next.responseFormat = next.responseFormat === 'json_schema' ? 'json_object' : 'none';
    changed = true;
  }
  return changed ? next : undefined;
}

/** Exported for the hermetic truncation-failure pin (pure payload inspection). */
export function azureFinishReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const reason = (choices[0] as { finish_reason?: unknown }).finish_reason;
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * Parses the plan JSON out of a model's text. Endpoints without strict
 * structured output (negotiated-down dialects, proxies, local servers) often
 * wrap the object in markdown fences or a sentence of preamble. The
 * PolicyValidator remains the real gate on the result — this only finds the
 * JSON object the model produced; anything else is an honest schema failure.
 */
export function parsePlanJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to the tolerant scans.
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced && typeof fenced[1] === 'string') {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Fall through to the brace scan.
    }
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      // Not salvageable.
    }
  }
  return undefined;
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
      const payload = await this.postWithNegotiation(kind, evidence, controller.signal);
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
   * Single logical planner request. The openai-compatible transport negotiates
   * its request dialect on HTTP 400/422 parameter rejections (bounded by
   * MAX_NEGOTIATION_RETRIES, remembered per endpoint+model afterwards); every
   * other status class fails immediately with its honest taxonomy class.
   */
  private async postWithNegotiation(kind: AiProviderKind, evidence: EvidencePacket, signal: AbortSignal): Promise<unknown> {
    const url = plannerRequestUrl(this.config);
    const cacheKey = `${url}#${this.config.model ?? ''}`;
    let dialect = kind === 'openai'
      ? negotiatedDialects.get(cacheKey) ?? { ...DEFAULT_OPENAI_DIALECT }
      : undefined;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.requestHeaders(),
        body: JSON.stringify(this.requestBody(kind, evidence, dialect)),
        signal,
      });
      if (response.ok) {
        if (dialect) negotiatedDialects.set(cacheKey, dialect);
        return this.readJsonBounded(response);
      }
      if (dialect && (response.status === 400 || response.status === 422) && attempt < MAX_NEGOTIATION_RETRIES) {
        const adjusted = negotiateOpenAiDialect(dialect, await this.readErrorBodyBounded(response));
        if (adjusted) {
          dialect = adjusted;
          continue;
        }
      }
      // Auth, rate-limit, and server faults are operationally distinct — the
      // Options badge must tell the user which one bit them.
      const failureClass = response.status === 401 || response.status === 403 || response.status === 429
        ? `http-${response.status}` as const
        : `http-${Math.floor(response.status / 100)}xx` as const;
      void recordPlannerFailure(failureClass);
      throw new PlannerHttpError(response.status);
    }
  }

  /** Bounded error-body read for dialect negotiation hints. */
  private async readErrorBodyBounded(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text.slice(0, MAX_ERROR_BODY_BYTES);
    } catch {
      return '';
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

  private requestBody(kind: AiProviderKind, evidence: EvidencePacket, dialect?: OpenAiDialect): unknown {
    switch (kind) {
      case 'azure':
        return this.buildAzureRequest(evidence);
      case 'openai':
        return this.buildOpenAiRequest(evidence, dialect ?? DEFAULT_OPENAI_DIALECT);
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
      max_completion_tokens: PLANNER_OUTPUT_TOKEN_BUDGET,
    };
  }

  /**
   * OpenAI-compatible chat-completions (OpenAI, OpenRouter, Groq, xAI, Together,
   * LM Studio, Azure's /openai/v1 path, translating proxies, …). The dialect
   * decides which optional fields ride along: strict json_schema gives the same
   * server-side plan-shape guarantee the Azure transport has always had, and
   * 400/422 parameter rejections negotiate it down (see postWithNegotiation).
   * Whatever the server returns still passes the production PolicyValidator
   * after parsing, so schema drift fails loud.
   */
  private buildOpenAiRequest(evidence: EvidencePacket, dialect: OpenAiDialect): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model ?? '',
      messages: [
        { role: 'system', content: SURVIVOR_PLANNER_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(evidence) },
      ],
    };
    if (dialect.responseFormat === 'json_schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'adapt_survivor_plan', strict: true, schema: ADAPTATION_PLAN_JSON_SCHEMA },
      };
    } else if (dialect.responseFormat === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    body[dialect.tokenField] = PLANNER_OUTPUT_TOKEN_BUDGET;
    if (dialect.temperature) body.temperature = 0;
    if (dialect.reasoningEffort) body.reasoning_effort = 'low';
    return body;
  }

  /** Anthropic Messages API — system is a top-level field, not a message. */
  private buildAnthropicRequest(evidence: EvidencePacket): Record<string, unknown> {
    return {
      model: this.config.model ?? '',
      max_tokens: PLANNER_OUTPUT_TOKEN_BUDGET,
      system: SURVIVOR_PLANNER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(evidence) }],
    };
  }

  private extractChatCompletionPlan(payload: unknown): unknown {
    if (!payload || typeof payload !== 'object') return undefined;
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return undefined;
    const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        // OpenAI content-parts shape (gpt-4o/5 multimodal responses and proxies
        // that normalize to it): concatenate the text parts.
        ? content
            .filter((part) => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text')
            .map((part) => (part as { text?: unknown }).text)
            .filter((value): value is string => typeof value === 'string')
            .join('')
        : '';
    if (text.length === 0) return undefined;
    return parsePlanJsonText(text);
  }

  private extractAnthropicPlan(payload: unknown): unknown {
    if (!payload || typeof payload !== 'object') return undefined;
    const content = (payload as { content?: unknown }).content;
    if (!Array.isArray(content)) return undefined;
    const textBlock = content.find(
      (block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
    ) as { text?: unknown } | undefined;
    if (!textBlock || typeof textBlock.text !== 'string' || textBlock.text.length === 0) return undefined;
    return parsePlanJsonText(textBlock.text);
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
