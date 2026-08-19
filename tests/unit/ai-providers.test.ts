/**
 * Multi-provider transport pins (hermetic loopback HTTP, no credentials):
 *
 *  A. URL construction per provider (plannerRequestUrl) — base-URL joining,
 *     verbatim full URLs, azure bare-host completion to the proven v1 path.
 *  B. Legacy inference — configs without a provider field resolve azure by host
 *     and relay otherwise, so pre-multiprovider stored configs never break.
 *  C. openai-compatible — /chat/completions, Bearer, strict json_schema dialect,
 *     plan extraction from choices[0].message.content, finish_reason length = truncated.
 *  D. anthropic — /v1/messages, x-api-key + anthropic-version (never Bearer),
 *     system lifted to top level, content-block extraction, stop_reason
 *     max_tokens = truncated.
 *  E. azure — v1 URL → Bearer only; classic deployments URL → api-key only;
 *     proven strict json_schema + reasoning_effort body unchanged.
 *  F. relay — raw EvidencePacket body, .plan unwrap (harness/loopback compat).
 *  G. validConfig — provider enum, model required for explicit chat providers,
 *     legacy model-less configs stay valid.
 *  H. openai dialect negotiation — 400/422 parameter rejections downgrade the
 *     request shape (token field, reasoning_effort, response_format), the working
 *     dialect is cached per endpoint+model, and non-parameter faults never retry.
 *  I. plan extraction robustness — markdown-fenced and prose-wrapped JSON,
 *     content-parts arrays; garbage stays an honest schema failure.
 *  J. connection-test policy surfacing — validator rejection reasons reach the
 *     Options page so BYOK users see WHY a reached provider was refused.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  AiConfig,
  DEFAULT_OPENAI_DIALECT,
  PLANNER_OUTPUT_TOKEN_BUDGET,
  RemotePlanner,
  anthropicStopReason,
  negotiateOpenAiDialect,
  parsePlanJsonText,
  plannerRequestUrl,
  resolveProviderKind,
  validConfig,
} from '../../src/background/ai/remote-planner';
import { runPlannerConnectionTest } from '../../src/background/ai/test-connection';
import { AI_STATUS_STORAGE_KEY, AiPlannerStatus } from '../../src/background/ai/status';
import { EvidencePacket } from '../../src/shared/ai/types';

let localBacking: Map<string, unknown>;
let sessionBacking: Map<string, unknown>;

function installChromeStub(): void {
  localBacking = new Map();
  sessionBacking = new Map();
  const areaFor = (backing: Map<string, unknown>) => ({
    get: async (key: string | string[]) => {
      if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => backing.has(k)).map((k) => [k, backing.get(k)]));
      return { [key]: backing.get(key) };
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) backing.set(key, value);
    },
    remove: async (key: string) => { backing.delete(key); },
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: areaFor(sessionBacking), local: areaFor(localBacking) },
  };
}

const lastFailureClass = async (): Promise<string | undefined> => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  const status = localBacking.get(AI_STATUS_STORAGE_KEY) as AiPlannerStatus | undefined;
  return status?.lastFailureClass;
};

const minimalEvidence = {
  schemaVersion: 1,
  transactionId: 'tx_providers',
  navigationEpoch: 'nav_providers',
  timestamp: Date.now(),
  siteContext: { originClass: 'publisher', pageTypeEstimate: 'unknown' },
  trigger: { reason: 'CONNECTION_TEST', confidence: 0.5 },
  healthBefore: {} as never,
  currentHealth: {} as never,
  observedReaction: { detectorTypes: [], antiBlockConfidence: 0.5, mutationBurstDetected: false },
  candidateElements: [],
  candidateRequests: [],
  availableActions: ['ABSTAIN'],
  knownConstraints: [],
  previousAttempts: [],
} as EvidencePacket;

const PLAN_JSON = JSON.stringify({
  schemaVersion: 1,
  decision: 'ABSTAIN',
  hypothesis: { category: 'UNKNOWN', confidence: 0.5, explanation: 'pin' },
  selectedStrategyTier: 'ABSTAIN',
  actions: [],
  verification: { expectedHealthDelta: 0, maxWaitMs: 1000 },
  abortConditions: [],
  explanationCodes: [],
});

interface CapturedRequest {
  url: string;
  authorization?: string;
  apiKey?: string;
  anthropicVersion?: string;
  body: Record<string, unknown>;
}

/** Loopback server that captures the request shape and responds with `responder`. */
async function captureServer(
  responder: (req: CapturedRequest) => { status?: number; body: string }
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const captured: CapturedRequest = {
        url: req.url ?? '',
        authorization: req.headers.authorization,
        apiKey: req.headers['api-key'] as string | undefined,
        anthropicVersion: req.headers['anthropic-version'] as string | undefined,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
      };
      const out = responder(captured);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

beforeEach(installChromeStub);
afterEach(() => vi.unstubAllGlobals());

// ---- A. URL construction ---------------------------------------------------------

describe('A. plannerRequestUrl', () => {
  it('openai: appends /chat/completions to base, trims trailing slashes, keeps full URLs verbatim', () => {
    expect(plannerRequestUrl({ provider: 'openai', endpoint: 'https://api.openai.com/v1', model: 'm' }))
      .toBe('https://api.openai.com/v1/chat/completions');
    expect(plannerRequestUrl({ provider: 'openai', endpoint: 'https://api.groq.com/openai/v1/', model: 'm' }))
      .toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(plannerRequestUrl({ provider: 'openai', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'm' }))
      .toBe('http://127.0.0.1:1234/v1/chat/completions');
  });

  it('anthropic: completes base and /v1 to /v1/messages, keeps full URLs verbatim', () => {
    expect(plannerRequestUrl({ provider: 'anthropic', endpoint: 'https://api.anthropic.com', model: 'm' }))
      .toBe('https://api.anthropic.com/v1/messages');
    expect(plannerRequestUrl({ provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1', model: 'm' }))
      .toBe('https://api.anthropic.com/v1/messages');
    expect(plannerRequestUrl({ provider: 'anthropic', endpoint: 'https://gateway.example.com/v1/messages', model: 'm' }))
      .toBe('https://gateway.example.com/v1/messages');
  });

  it('azure: bare host completes to the proven v1 path; full URLs stay verbatim', () => {
    expect(plannerRequestUrl({ provider: 'azure', endpoint: 'https://res.openai.azure.com', model: 'dep' }))
      .toBe('https://res.openai.azure.com/openai/v1/chat/completions');
    const classic = 'https://res.openai.azure.com/openai/deployments/dep/chat/completions?api-version=2025-01-01';
    expect(plannerRequestUrl({ provider: 'azure', endpoint: classic, model: 'dep' })).toBe(classic);
    const v1 = 'https://res.openai.azure.com/openai/v1/chat/completions';
    expect(plannerRequestUrl({ provider: 'azure', endpoint: v1, model: 'dep' })).toBe(v1);
  });

  it('relay: endpoint used verbatim', () => {
    expect(plannerRequestUrl({ provider: 'relay', endpoint: 'https://relay.example.com/plan' }))
      .toBe('https://relay.example.com/plan');
  });
});

// ---- B. legacy inference -----------------------------------------------------------

describe('B. resolveProviderKind legacy inference', () => {
  it('infers azure from host, relay for anything else, explicit provider always wins', () => {
    expect(resolveProviderKind({ endpoint: 'https://x.openai.azure.com/openai/v1/chat/completions' })).toBe('azure');
    expect(resolveProviderKind({ endpoint: 'http://127.0.0.1:9/plan' })).toBe('relay');
    expect(resolveProviderKind({ endpoint: 'https://planner.example.com/v1/plan' })).toBe('relay');
    expect(resolveProviderKind({ provider: 'anthropic', endpoint: 'https://x.openai.azure.com', model: 'm' })).toBe('anthropic');
    expect(resolveProviderKind({ endpoint: 'not a url' })).toBe('relay');
  });
});

// ---- C. openai-compatible transport --------------------------------------------------

describe('C. openai-compatible transport', () => {
  it('posts the chat-completions shape with Bearer and extracts the plan', async () => {
    let seen: CapturedRequest | undefined;
    const server = await captureServer((req) => {
      seen = req;
      return { body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: PLAN_JSON } }] }) };
    });
    const planner = new RemotePlanner({ provider: 'openai', endpoint: `${server.base}/v1`, token: 'sk-test', model: 'gpt-x' });
    const plan = await planner.plan(minimalEvidence);
    expect(plan.decision).toBe('ABSTAIN');
    expect(seen?.url).toBe('/v1/chat/completions');
    expect(seen?.authorization).toBe('Bearer sk-test');
    expect(seen?.apiKey).toBeUndefined();
    expect(seen?.anthropicVersion).toBeUndefined();
    expect(seen?.body.model).toBe('gpt-x');
    expect((seen?.body.messages as Array<{ role: string }>).at(0)?.role).toBe('system');
    // Optimistic modern dialect: strict json_schema (the same server-side plan
    // guarantee the Azure path has), modern token field, low reasoning effort.
    const fmt = seen?.body.response_format as { type: string; json_schema?: { strict: boolean } };
    expect(fmt.type).toBe('json_schema');
    expect(fmt.json_schema?.strict).toBe(true);
    expect(seen?.body.max_completion_tokens).toBe(PLANNER_OUTPUT_TOKEN_BUDGET);
    expect(seen?.body.max_tokens).toBeUndefined();
    expect(seen?.body.reasoning_effort).toBe('low');
    await server.close();
  });

  it('omits the Authorization header when no key is configured (local model servers)', async () => {
    let seen: CapturedRequest | undefined;
    const server = await captureServer((req) => {
      seen = req;
      return { body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: PLAN_JSON } }] }) };
    });
    const planner = new RemotePlanner({ provider: 'openai', endpoint: `${server.base}/v1`, model: 'local' });
    await planner.plan(minimalEvidence);
    expect(seen?.authorization).toBeUndefined();
    await server.close();
  });

  it('finish_reason length is classified truncated and never reaches the validator', async () => {
    const server = await captureServer(() => ({
      body: JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"schemaVersion":1,"dec' } }] }),
    }));
    const planner = new RemotePlanner({ provider: 'openai', endpoint: server.base, model: 'm' });
    await expect(planner.plan(minimalEvidence)).rejects.toThrow('truncated at token cap');
    expect(await lastFailureClass()).toBe('truncated');
    await server.close();
  });
});

// ---- D. anthropic transport ------------------------------------------------------------

describe('D. anthropic transport', () => {
  it('posts the Messages shape with x-api-key and extracts the first text block', async () => {
    let seen: CapturedRequest | undefined;
    const server = await captureServer((req) => {
      seen = req;
      return {
        body: JSON.stringify({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: PLAN_JSON }],
        }),
      };
    });
    const planner = new RemotePlanner({ provider: 'anthropic', endpoint: server.base, token: 'sk-ant', model: 'claude-haiku-4-5' });
    const plan = await planner.plan(minimalEvidence);
    expect(plan.decision).toBe('ABSTAIN');
    expect(seen?.url).toBe('/v1/messages');
    expect(seen?.apiKey).toBeUndefined();
    expect(seen?.authorization).toBeUndefined();
    expect(seen?.anthropicVersion).toBe('2023-06-01');
    expect(seen?.body.model).toBe('claude-haiku-4-5');
    expect(typeof seen?.body.system).toBe('string');
    const messages = seen?.body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages.at(0)?.role).toBe('user');
    expect(seen?.body.max_tokens).toBe(PLANNER_OUTPUT_TOKEN_BUDGET);
    expect(seen?.body.response_format).toBeUndefined();
    expect(seen?.body.tool_choice).toBeUndefined();
    await server.close();
  });

  it('sends the key as x-api-key when provided', async () => {
    let capturedKey: string | undefined;
    const server = http.createServer((req, res) => {
      capturedKey = req.headers['x-api-key'] as string | undefined;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: PLAN_JSON }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const planner = new RemotePlanner({ provider: 'anthropic', endpoint: `http://127.0.0.1:${port}`, token: 'sk-ant-key', model: 'm' });
    await planner.plan(minimalEvidence);
    expect(capturedKey).toBe('sk-ant-key');
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  it('stop_reason max_tokens is classified truncated', async () => {
    const server = await captureServer(() => ({
      body: JSON.stringify({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"schemaVersion":1' }] }),
    }));
    const planner = new RemotePlanner({ provider: 'anthropic', endpoint: server.base, token: 'k', model: 'm' });
    await expect(planner.plan(minimalEvidence)).rejects.toThrow('truncated at token cap');
    expect(await lastFailureClass()).toBe('truncated');
    await server.close();
  });

  it('anthropicStopReason is a pure payload inspector', () => {
    expect(anthropicStopReason({ stop_reason: 'max_tokens' })).toBe('max_tokens');
    expect(anthropicStopReason({ stop_reason: 'end_turn' })).toBe('end_turn');
    expect(anthropicStopReason({})).toBeUndefined();
    expect(anthropicStopReason(null)).toBeUndefined();
  });
});

// ---- E. azure transport -----------------------------------------------------------------

describe('E. azure transport', () => {
  const okResponder = (req: CapturedRequest, seen: { r?: CapturedRequest }) => {
    seen.r = req;
    return { body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: PLAN_JSON } }] }) };
  };

  it('v1 URL authenticates with Bearer only and keeps the proven strict body', async () => {
    const seen: { r?: CapturedRequest } = {};
    const server = await captureServer((req) => okResponder(req, seen));
    // Loopback stands in for the host; provider 'azure' + v1 path shape is what
    // selects Bearer — the production v1 endpoint carries '/openai/v1/' in its URL.
    const planner = new RemotePlanner({ provider: 'azure', endpoint: `${server.base}/openai/v1/chat/completions`, token: 'az-key', model: 'dep-1' });
    const plan = await planner.plan(minimalEvidence);
    expect(plan.decision).toBe('ABSTAIN');
    expect(seen.r?.url).toBe('/openai/v1/chat/completions');
    expect(seen.r?.authorization).toBe('Bearer az-key');
    expect(seen.r?.apiKey).toBeUndefined();
    const fmt = seen.r?.body.response_format as { type: string; json_schema?: { strict: boolean } };
    expect(fmt.type).toBe('json_schema');
    expect(fmt.json_schema?.strict).toBe(true);
    expect(seen.r?.body.reasoning_effort).toBe('low');
    expect(seen.r?.body.max_completion_tokens).toBe(PLANNER_OUTPUT_TOKEN_BUDGET);
    expect(seen.r?.body.model).toBe('dep-1');
    await server.close();
  });

  it('classic deployments URL authenticates with the api-key header only', async () => {
    const seen: { r?: CapturedRequest } = {};
    const server = await captureServer((req) => okResponder(req, seen));
    const planner = new RemotePlanner({
      provider: 'azure',
      endpoint: `${server.base}/openai/deployments/dep-1/chat/completions?api-version=2025-01-01`,
      token: 'az-key',
      model: 'dep-1',
    });
    await planner.plan(minimalEvidence);
    expect(seen.r?.url).toBe('/openai/deployments/dep-1/chat/completions?api-version=2025-01-01');
    expect(seen.r?.apiKey).toBe('az-key');
    expect(seen.r?.authorization).toBeUndefined();
    await server.close();
  });

  it('bare resource host is completed to the v1 path', async () => {
    const seen: { r?: CapturedRequest } = {};
    const server = await captureServer((req) => okResponder(req, seen));
    const planner = new RemotePlanner({ provider: 'azure', endpoint: server.base, token: 'az-key', model: 'dep-1' });
    await planner.plan(minimalEvidence);
    expect(seen.r?.url).toBe('/openai/v1/chat/completions');
    await server.close();
  });
});

// ---- F. relay legacy transport -------------------------------------------------------------

describe('F. relay legacy transport', () => {
  it('posts the raw evidence packet and unwraps .plan', async () => {
    let seen: CapturedRequest | undefined;
    const server = await captureServer((req) => {
      seen = req;
      return { body: JSON.stringify({ plan: JSON.parse(PLAN_JSON) }) };
    });
    const planner = new RemotePlanner({ endpoint: server.base, token: 'relay-key' });
    const plan = await planner.plan(minimalEvidence);
    expect(plan.decision).toBe('ABSTAIN');
    expect(seen?.body.transactionId).toBe('tx_providers');
    expect(seen?.authorization).toBe('Bearer relay-key');
    await server.close();
  });
});

// ---- G. validConfig provider rules ------------------------------------------------------------

describe('G. validConfig provider rules', () => {
  const base: AiConfig = { endpoint: 'https://api.openai.com/v1', model: 'gpt-x' };

  it('rejects unknown providers', () => {
    expect(validConfig({ ...base, provider: 'gemini' })).toBe(false);
  });

  it('requires a model for explicit chat providers', () => {
    expect(validConfig({ provider: 'openai', endpoint: 'https://api.openai.com/v1' })).toBe(false);
    expect(validConfig({ provider: 'anthropic', endpoint: 'https://api.anthropic.com' })).toBe(false);
    expect(validConfig({ provider: 'azure', endpoint: 'https://res.openai.azure.com' })).toBe(false);
    expect(validConfig({ provider: 'openai', endpoint: 'https://api.openai.com/v1', model: 'm' })).toBe(true);
    expect(validConfig({ provider: 'anthropic', endpoint: 'https://api.anthropic.com', model: 'm', token: 'k' })).toBe(true);
  });

  it('legacy model-less configs stay valid (back-compat)', () => {
    expect(validConfig({ endpoint: 'http://127.0.0.1:8080/plan' })).toBe(true);
    expect(validConfig({ endpoint: 'https://res.openai.azure.com/openai/v1/chat/completions', token: 'k' })).toBe(true);
    expect(validConfig({ provider: 'relay', endpoint: 'https://relay.example.com/plan' })).toBe(true);
  });

  it('loopback http is allowed only for 127.0.0.1/localhost regardless of provider', () => {
    expect(validConfig({ provider: 'openai', endpoint: 'http://127.0.0.1:1234/v1', model: 'm' })).toBe(true);
    expect(validConfig({ provider: 'openai', endpoint: 'http://192.168.1.20:1234/v1', model: 'm' })).toBe(false);
  });
});

// ---- H. openai dialect negotiation ---------------------------------------------------

describe('H. openai dialect negotiation', () => {
  const okPlan = () => ({ body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: PLAN_JSON } }] }) });

  it('negotiateOpenAiDialect applies only the adjustment the error text names', () => {
    // OpenAI gpt-5-family token-field rejection names BOTH fields and asks for
    // the modern one — the modern field must win.
    const modern = negotiateOpenAiDialect(
      { ...DEFAULT_OPENAI_DIALECT, tokenField: 'max_tokens' },
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."
    );
    expect(modern?.tokenField).toBe('max_completion_tokens');
    // Anthropic-backed proxies demand max_tokens when they don't know the modern field.
    const legacy = negotiateOpenAiDialect(DEFAULT_OPENAI_DIALECT, 'invalid_request_error: max_tokens: Field required');
    expect(legacy?.tokenField).toBe('max_tokens');
    expect(legacy?.responseFormat).toBe('json_schema');
    // temperature and reasoning_effort drop only when named.
    expect(negotiateOpenAiDialect({ ...DEFAULT_OPENAI_DIALECT, temperature: true }, "Unsupported value: 'temperature'")?.temperature).toBe(false);
    expect(negotiateOpenAiDialect(DEFAULT_OPENAI_DIALECT, "Unsupported parameter: 'reasoning_effort'")?.reasoningEffort).toBe(false);
    // response_format steps down one rung at a time, never below none.
    expect(negotiateOpenAiDialect(DEFAULT_OPENAI_DIALECT, 'response_format is not supported')?.responseFormat).toBe('json_object');
    expect(negotiateOpenAiDialect({ ...DEFAULT_OPENAI_DIALECT, responseFormat: 'json_object' }, 'json_object not supported')?.responseFormat).toBe('none');
    expect(negotiateOpenAiDialect({ ...DEFAULT_OPENAI_DIALECT, responseFormat: 'none' }, 'json_schema json_object response_format none')).toBeUndefined();
    // Unactionable errors (unknown model, auth phrasing) never rewrite the dialect.
    expect(negotiateOpenAiDialect(DEFAULT_OPENAI_DIALECT, 'The model `gpt-x` does not exist')).toBeUndefined();
  });

  it('retries a 400 with the downgraded dialect and caches the winner per endpoint+model', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = await captureServer((req) => {
      bodies.push(req.body);
      if (bodies.length === 1) return { status: 400, body: JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort'" } }) };
      if (bodies.length === 2) return { status: 400, body: JSON.stringify({ error: { message: 'response_format json_schema is not supported for this model' } }) };
      return okPlan();
    });
    const config: AiConfig = { provider: 'openai', endpoint: `${server.base}/v1`, token: 'sk-test', model: 'gpt-x' };
    const planner = new RemotePlanner(config);
    const plan = await planner.plan(minimalEvidence);
    expect(plan.decision).toBe('ABSTAIN');
    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.reasoning_effort).toBe('low');
    expect(bodies[1]?.reasoning_effort).toBeUndefined();
    expect((bodies[1]?.response_format as { type: string }).type).toBe('json_schema');
    expect((bodies[2]?.response_format as { type: string }).type).toBe('json_object');
    // A second plan() on the same endpoint+model must skip negotiation entirely.
    const again = new RemotePlanner(config);
    await again.plan(minimalEvidence);
    expect(bodies).toHaveLength(4);
    expect((bodies[3]?.response_format as { type: string }).type).toBe('json_object');
    expect(bodies[3]?.reasoning_effort).toBeUndefined();
    await server.close();
  });

  it('switches to max_tokens when an Anthropic-backed proxy requires it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = await captureServer((req) => {
      bodies.push(req.body);
      if (!('max_tokens' in req.body)) {
        return { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: Field required' } }) };
      }
      return okPlan();
    });
    const planner = new RemotePlanner({ provider: 'openai', endpoint: `${server.base}/v1`, token: 'k', model: 'claude-via-proxy' });
    const plan = await planner.plan(minimalEvidence);
    expect(plan.decision).toBe('ABSTAIN');
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    const final = bodies.at(-1) ?? {};
    expect(final.max_tokens).toBe(PLANNER_OUTPUT_TOKEN_BUDGET);
    expect(final.max_completion_tokens).toBeUndefined();
    await server.close();
  });

  it('never negotiates auth, rate-limit, or server faults — they surface immediately', async () => {
    for (const status of [401, 429, 500]) {
      let hits = 0;
      const server = await captureServer(() => {
        hits += 1;
        return { status, body: JSON.stringify({ error: { message: "reasoning_effort response_format max_tokens" } }) };
      });
      const planner = new RemotePlanner({ provider: 'openai', endpoint: `${server.base}/v1`, token: 'k', model: 'm' });
      await expect(planner.plan(minimalEvidence)).rejects.toThrow(`planner request failed: ${status}`);
      expect(hits).toBe(1);
      await server.close();
    }
  });

  it('gives up after bounded retries and reports http-4xx when nothing actionable remains', async () => {
    let hits = 0;
    const server = await captureServer(() => {
      hits += 1;
      return { status: 400, body: JSON.stringify({ error: { message: 'response_format not supported here' } }) };
    });
    const planner = new RemotePlanner({ provider: 'openai', endpoint: `${server.base}/v1`, token: 'k', model: 'm' });
    await expect(planner.plan(minimalEvidence)).rejects.toThrow('planner request failed: 400');
    // json_schema → json_object → none → no further adjustment: 3 attempts total.
    expect(hits).toBe(3);
    expect(await lastFailureClass()).toBe('http-4xx');
    await server.close();
  });

  it('does not retry a 400 that names no known parameter', async () => {
    let hits = 0;
    const server = await captureServer(() => {
      hits += 1;
      return { status: 400, body: JSON.stringify({ error: { message: 'The model `gpt-x` does not exist or you do not have access to it.' } }) };
    });
    const planner = new RemotePlanner({ provider: 'openai', endpoint: `${server.base}/v1`, token: 'k', model: 'gpt-x' });
    await expect(planner.plan(minimalEvidence)).rejects.toThrow('planner request failed: 400');
    expect(hits).toBe(1);
    await server.close();
  });
});

// ---- I. plan extraction robustness -----------------------------------------------------

describe('I. plan extraction robustness', () => {
  it('parsePlanJsonText tolerates fences and preamble, rejects garbage', () => {
    expect((parsePlanJsonText(PLAN_JSON) as { decision: string }).decision).toBe('ABSTAIN');
    expect((parsePlanJsonText(`\`\`\`json\n${PLAN_JSON}\n\`\`\``) as { decision: string }).decision).toBe('ABSTAIN');
    expect((parsePlanJsonText(`Here is the plan:\n${PLAN_JSON}`) as { decision: string }).decision).toBe('ABSTAIN');
    expect(parsePlanJsonText('no json here at all')).toBeUndefined();
    expect(parsePlanJsonText('')).toBeUndefined();
    expect(parsePlanJsonText('{"unterminated": ')).toBeUndefined();
  });

  it('openai: markdown-fenced content still yields the plan', async () => {
    const server = await captureServer(() => ({
      body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: `\`\`\`json\n${PLAN_JSON}\n\`\`\`` } }] }),
    }));
    const planner = new RemotePlanner({ provider: 'openai', endpoint: server.base, model: 'm' });
    const plan = await planner.plan(minimalEvidence);
    expect(plan.decision).toBe('ABSTAIN');
    await server.close();
  });

  it('openai: content-parts arrays are concatenated before parsing', async () => {
    const half = Math.floor(PLAN_JSON.length / 2);
    const server = await captureServer(() => ({
      body: JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: { content: [{ type: 'text', text: PLAN_JSON.slice(0, half) }, { type: 'text', text: PLAN_JSON.slice(half) }] },
        }],
      }),
    }));
    const planner = new RemotePlanner({ provider: 'openai', endpoint: server.base, model: 'm' });
    const plan = await planner.plan(minimalEvidence);
    expect(plan.decision).toBe('ABSTAIN');
    await server.close();
  });

  it('anthropic: fenced text blocks still yield the plan', async () => {
    const server = await captureServer(() => ({
      body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: `\`\`\`\n${PLAN_JSON}\n\`\`\`` }] }),
    }));
    const planner = new RemotePlanner({ provider: 'anthropic', endpoint: server.base, token: 'k', model: 'm' });
    const plan = await planner.plan(minimalEvidence);
    expect(plan.decision).toBe('ABSTAIN');
    await server.close();
  });

  it('unparseable content stays an honest schema failure', async () => {
    const server = await captureServer(() => ({
      body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'I cannot help with that.' } }] }),
    }));
    const planner = new RemotePlanner({ provider: 'openai', endpoint: server.base, model: 'm' });
    await expect(planner.plan(minimalEvidence)).rejects.toThrow('planner response is not an object');
    expect(await lastFailureClass()).toBe('schema');
    await server.close();
  });
});

// ---- J. connection-test policy surfacing -------------------------------------------------

describe('J. connection-test policy surfacing', () => {
  it('a reached provider whose plan fails the validator reports the rejection reasons', async () => {
    // A lazy model answering the CONNECTION_TEST instruction literally:
    // parseable JSON, but missing schemaVersion/hypothesis/tier/verification.
    const lazyPlan = JSON.stringify({ decision: 'ABSTAIN', actions: [] });
    const server = await captureServer(() => ({
      body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: lazyPlan } }] }),
    }));
    const result = await runPlannerConnectionTest({ provider: 'openai', endpoint: `${server.base}/v1`, token: 'k', model: 'lazy-model' });
    expect(result.providerReached).toBe(true);
    expect(result.schemaValid).toBe(false);
    expect(result.errorClass).toBe('schema');
    expect(result.policyReasons?.length).toBeGreaterThan(0);
    expect(result.policyReasons?.[0]).toContain('schemaVersion');
    expect(await lastFailureClass()).toBe('policy');
    await server.close();
  });

  it('a reached provider with a complete abstain plan verifies clean', async () => {
    const server = await captureServer(() => ({
      body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: PLAN_JSON } }] }),
    }));
    const result = await runPlannerConnectionTest({ provider: 'openai', endpoint: `${server.base}/v1`, token: 'k', model: 'good-model' });
    expect(result.providerReached).toBe(true);
    expect(result.schemaValid).toBe(true);
    expect(result.decision).toBe('ABSTAIN');
    expect(result.policyReasons).toBeUndefined();
    await server.close();
  });
});
