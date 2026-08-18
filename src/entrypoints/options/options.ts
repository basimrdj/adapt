/**
 * ADAPT settings — AI planner (bring-your-own-key) + adaptive memory + diagnostics.
 *
 * Writes exactly the schema `loadConfiguredPlanner()` reads under `adapt_ai_config`.
 * Any OpenAI-compatible endpoint, Azure OpenAI, or Anthropic: the service worker's
 * RemotePlanner picks the transport from `provider`. The credential is never
 * displayed, logged, or sent anywhere except the configured provider endpoint via
 * the service worker's production transport.
 */

import { AI_CONFIG_STORAGE_KEY, AiConfig, AiProviderKind, validConfig } from '../../background/ai/remote-planner';
import { AI_STATUS_STORAGE_KEY, AiPlannerStatus } from '../../background/ai/status';

type UiProvider = 'openai' | 'azure' | 'anthropic';

interface AdminStatusResponse {
  configured: boolean;
  source: 'stored' | 'built-in-default' | 'none';
  endpoint: string | null;
  hasToken: boolean;
  privacyMode: 'STRICT' | 'DOMAIN_HINTS';
  provider: AiProviderKind | null;
  model: string | null;
  timeoutMs: number | null;
  status: AiPlannerStatus;
}

interface ConnectionTestResponse {
  providerReached: boolean;
  schemaValid: boolean;
  latencyMs: number | null;
  decision?: string;
  errorClass?: string;
}

const PROVIDER_NOTE: Record<UiProvider, string> = {
  openai:
    'Any OpenAI-compatible endpoint — OpenAI, OpenRouter, Groq, xAI, Together, or a local model server on 127.0.0.1. /chat/completions is appended automatically.',
  azure:
    'Paste the resource host (https://<resource>.openai.azure.com) — the v1 chat-completions path is added automatically — or a full classic deployments URL including ?api-version=…',
  anthropic:
    'Anthropic Messages API. Base URL https://api.anthropic.com — /v1/messages is appended automatically.',
};

interface Preset {
  provider: UiProvider;
  endpoint: string;
  endpointPlaceholder: string;
  modelPlaceholder: string;
}

const PRESETS: Record<string, Preset> = {
  openai: { provider: 'openai', endpoint: 'https://api.openai.com/v1', endpointPlaceholder: 'https://api.openai.com/v1', modelPlaceholder: 'gpt-4o-mini' },
  openrouter: { provider: 'openai', endpoint: 'https://openrouter.ai/api/v1', endpointPlaceholder: 'https://openrouter.ai/api/v1', modelPlaceholder: 'openai/gpt-4o-mini' },
  groq: { provider: 'openai', endpoint: 'https://api.groq.com/openai/v1', endpointPlaceholder: 'https://api.groq.com/openai/v1', modelPlaceholder: 'llama-3.3-70b-versatile' },
  xai: { provider: 'openai', endpoint: 'https://api.x.ai/v1', endpointPlaceholder: 'https://api.x.ai/v1', modelPlaceholder: 'grok-3-mini' },
  lmstudio: { provider: 'openai', endpoint: 'http://127.0.0.1:1234/v1', endpointPlaceholder: 'http://127.0.0.1:1234/v1', modelPlaceholder: 'local-model' },
  azure: { provider: 'azure', endpoint: '', endpointPlaceholder: 'https://<resource>.openai.azure.com', modelPlaceholder: 'deployment name, e.g. my-gpt-4o-mini' },
  anthropic: { provider: 'anthropic', endpoint: 'https://api.anthropic.com', endpointPlaceholder: 'https://api.anthropic.com', modelPlaceholder: 'claude-haiku-4-5' },
};

const DEFAULT_PLACEHOLDERS: Record<UiProvider, { endpoint: string; model: string }> = {
  openai: { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  azure: { endpoint: 'https://<resource>.openai.azure.com', model: 'deployment name' },
  anthropic: { endpoint: 'https://api.anthropic.com', model: 'claude-haiku-4-5' },
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element ${id}`);
  return node as T;
}

const enabledInput = el<HTMLInputElement>('enabled');
const endpointInput = el<HTMLInputElement>('endpoint');
const modelInput = el<HTMLInputElement>('model');
const tokenInput = el<HTMLInputElement>('token');
const timeoutInput = el<HTMLInputElement>('timeout');
const privacySelect = el<HTMLSelectElement>('privacy');
const badge = el<HTMLSpanElement>('status-badge');
const tokenState = el<HTMLElement>('token-state');
const testResult = el<HTMLDivElement>('test-result');
const lastSuccess = el<HTMLElement>('last-success');
const lastFailure = el<HTMLElement>('last-failure');
const providerNote = el<HTMLElement>('provider-note');
const relayNotice = el<HTMLElement>('relay-notice');
const segments = Array.from(document.querySelectorAll<HTMLButtonElement>('.segment'));
const chips = Array.from(document.querySelectorAll<HTMLButtonElement>('.chip'));

let selectedProvider: UiProvider | null = null;
let savedToken: string | undefined;
let effectiveSource: AdminStatusResponse['source'] = 'none';
/** Last status snapshot — the baked-credential test path is allowed only while the
 * form still describes that baked config exactly (the baked key never enters the page). */
let lastEffective: { endpoint: string | null; provider: AiProviderKind | null; model: string | null } = { endpoint: null, provider: null, model: null };

function selectProvider(provider: UiProvider | null): void {
  selectedProvider = provider;
  for (const segment of segments) {
    segment.classList.toggle('active', segment.dataset.provider === provider);
  }
  if (provider) {
    providerNote.textContent = PROVIDER_NOTE[provider];
    endpointInput.placeholder = DEFAULT_PLACEHOLDERS[provider].endpoint;
    modelInput.placeholder = DEFAULT_PLACEHOLDERS[provider].model;
  }
}

function applyPreset(name: string): void {
  const preset = PRESETS[name];
  if (!preset) return;
  relayNotice.hidden = true;
  selectProvider(preset.provider);
  endpointInput.value = preset.endpoint;
  endpointInput.placeholder = preset.endpointPlaceholder;
  modelInput.placeholder = preset.modelPlaceholder;
  tokenInput.focus();
}

function setBadge(state: 'unconfigured' | 'configured' | 'verified' | 'error', text: string): void {
  badge.className = `badge ${state}`;
  badge.textContent = text;
}

function fmtTime(t?: number): string {
  return t ? new Date(t).toLocaleTimeString() : 'never';
}

async function admin<T>(message: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage({ scope: 'adapt-ai-admin', ...message }) as Promise<T>;
}

function formConfig(): { config?: AiConfig; error?: string } {
  const endpoint = endpointInput.value.trim();
  const model = modelInput.value.trim();
  const token = tokenInput.value.length > 0 ? tokenInput.value : savedToken;
  const timeoutRaw = timeoutInput.value.trim();
  const timeoutMs = timeoutRaw.length > 0 ? Number.parseInt(timeoutRaw, 10) : undefined;
  if (!selectedProvider) {
    return { error: 'Pick a provider protocol first.' };
  }
  const candidate: AiConfig = {
    provider: selectedProvider,
    endpoint,
    model,
    ...(token ? { token } : {}),
    ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
    privacyMode: privacySelect.value === 'DOMAIN_HINTS' ? 'DOMAIN_HINTS' : 'STRICT',
  };
  if (!validConfig(candidate)) {
    return {
      error:
        'Invalid configuration: base URL must be https (or 127.0.0.1/localhost) ≤500 chars, a model id is required, key ≤2000 chars, timeout 1000–60000 ms.',
    };
  }
  return { config: candidate };
}

async function refresh(): Promise<void> {
  const response = await admin<AdminStatusResponse>({ type: 'AI_GET_STATUS' });
  effectiveSource = response.source;
  lastEffective = { endpoint: response.endpoint, provider: response.provider, model: response.model };

  enabledInput.checked = response.configured;
  endpointInput.value = response.endpoint ?? '';
  modelInput.value = response.model ?? '';
  timeoutInput.value = response.timeoutMs !== null ? String(response.timeoutMs) : '';
  privacySelect.value = response.privacyMode;

  const legacyRelay = response.configured && response.provider === 'relay';
  relayNotice.hidden = !legacyRelay;
  if (response.provider && response.provider !== 'relay') {
    selectProvider(response.provider);
  } else if (legacyRelay) {
    selectProvider(null);
    providerNote.textContent = 'Legacy relay endpoint active. It keeps working as-is; migrating to a standard provider is one click above.';
  } else {
    selectProvider('openai');
  }

  tokenState.textContent = response.hasToken
    ? response.source === 'built-in-default' ? 'baked into this build (hidden)' : 'saved (hidden)'
    : 'none saved';
  tokenInput.placeholder = response.hasToken ? '••••••••  (saved — leave empty to keep)' : 'no key saved';

  // Derive the badge from persisted planner status, not just configured state, so an
  // asynchronous storage.onChanged refresh cannot downgrade a freshly verified result
  // and a provider failure after the last success is surfaced instead of silent.
  if (!response.configured) {
    setBadge('unconfigured', 'UNCONFIGURED');
  } else {
    const successAt = response.status.lastSuccessAt ?? 0;
    const failureAt = response.status.lastFailureAt ?? 0;
    if (failureAt > successAt) setBadge('error', 'LAST PROVIDER FAILURE');
    else if (successAt > 0) setBadge('verified', 'CONNECTION VERIFIED');
    else setBadge('configured', 'CONFIGURED');
  }
  lastSuccess.textContent = response.status.lastSuccessAt
    ? `${fmtTime(response.status.lastSuccessAt)} (${response.status.lastLatencyMs ?? '?'} ms)`
    : 'never';
  lastFailure.textContent = response.status.lastFailureAt
    ? `${fmtTime(response.status.lastFailureAt)} (${response.status.lastFailureClass ?? 'error'})`
    : 'never';
}

async function onSave(): Promise<void> {
  testResult.textContent = '';
  if (!enabledInput.checked) {
    // Tombstone null (not key removal): an absent key falls back to the built-in
    // default, so an explicit disable must store an explicit non-config value.
    await chrome.storage.local.set({ [AI_CONFIG_STORAGE_KEY]: null });
    savedToken = undefined;
    setBadge('unconfigured', 'UNCONFIGURED');
    tokenState.textContent = 'none saved';
    return;
  }
  const { config, error } = formConfig();
  if (!config) {
    setBadge('error', 'ERROR');
    testResult.className = 'err';
    testResult.textContent = error ?? 'invalid configuration';
    return;
  }
  await chrome.storage.local.set({ [AI_CONFIG_STORAGE_KEY]: config });
  savedToken = config.token;
  tokenInput.value = '';
  setBadge('configured', 'CONFIGURED');
  await refresh();
}

async function onTest(): Promise<void> {
  // Testing the baked-in default is allowed only while the form still describes it
  // exactly — the baked credential never touches the page, so any deviation must go
  // through the form config (which falls back to the saved token, never the baked one).
  const useDefault =
    effectiveSource === 'built-in-default' &&
    tokenInput.value.length === 0 &&
    endpointInput.value.trim() === (lastEffective.endpoint ?? '') &&
    modelInput.value.trim() === (lastEffective.model ?? '') &&
    selectedProvider === (lastEffective.provider === 'relay' ? null : lastEffective.provider);

  const { config, error } = useDefault ? { config: undefined } : formConfig();
  if (!useDefault && !config) {
    testResult.className = 'err';
    testResult.textContent = error ?? 'invalid configuration';
    return;
  }
  testResult.className = '';
  testResult.textContent = 'Testing…';
  let result: ConnectionTestResponse;
  try {
    result = useDefault
      ? await admin<ConnectionTestResponse>({ type: 'AI_TEST_DEFAULT_CONNECTION' })
      : await admin<ConnectionTestResponse>({ type: 'AI_TEST_CONNECTION', config });
  } catch {
    setBadge('error', 'ERROR');
    testResult.className = 'err';
    testResult.textContent = 'Test failed: the background service worker did not respond.';
    return;
  }
  // Refresh first so the status lines update; the test outcome badge is applied last
  // so the refresh cannot downgrade a freshly verified result.
  await refresh();
  if (result.providerReached && result.schemaValid) {
    setBadge('verified', 'CONNECTION VERIFIED');
    testResult.className = 'ok';
    testResult.textContent = `Connection verified — latency: ${result.latencyMs ?? '?'} ms (decision: ${result.decision ?? 'n/a'})`;
  } else if (result.providerReached) {
    setBadge('error', 'ERROR');
    testResult.className = 'err';
    testResult.textContent = `Provider reached but response failed production schema validation (${result.errorClass ?? 'schema'}).`;
  } else {
    setBadge('error', 'ERROR');
    testResult.className = 'err';
    testResult.textContent = `Provider unreachable (${result.errorClass ?? 'transport'}).`;
  }
}

async function onClear(): Promise<void> {
  enabledInput.checked = false;
  await onSave();
}

const learnedCount = el<HTMLElement>('learned-count');
const learnedResult = el<HTMLDivElement>('learned-result');

async function refreshLearned(): Promise<void> {
  try {
    const status = await chrome.runtime.sendMessage({ scope: 'adapt-learning-admin', type: 'LEARNING_STATUS' }) as { personalRuleCount?: number };
    learnedCount.textContent = String(status.personalRuleCount ?? 0);
  } catch {
    learnedCount.textContent = '?';
  }
}

async function onClearLearned(): Promise<void> {
  learnedResult.textContent = 'Clearing…';
  try {
    const result = await chrome.runtime.sendMessage({ scope: 'adapt-learning-admin', type: 'LEARNING_CLEAR_ALL' }) as { cleared?: boolean; removed?: number };
    learnedResult.textContent = result.cleared ? `Cleared ${result.removed ?? 0} learned rule(s).` : 'Clear failed.';
  } catch {
    learnedResult.textContent = 'Clear failed: background did not respond.';
  }
  await refreshLearned();
}

/**
 * User-initiated diagnostics export. The credential is NEVER included. Hosts are
 * projected to first DNS labels; full raw identities stay in local storage.
 * The forensic trace (chrome.storage.session) only exists while the browser
 * session that produced it is still open.
 */
async function onExportDiagnostics(): Promise<void> {
  learnedResult.textContent = 'Exporting…';
  try {
    const sessionData = await chrome.storage.session.get('adapt_kimi_forensics_v1');
    const localData = await chrome.storage.local.get([AI_STATUS_STORAGE_KEY, 'adapt_dnr_dynamic_v1']);
    const durableFile = localData['adapt_dnr_dynamic_v1'] as { rules?: Record<string, Record<string, unknown>> } | undefined;
    const personalRules = Object.values(durableFile?.rules ?? {}).map((record) => ({
      ruleId: record.ruleId,
      lifecycle: record.lifecycle,
      hostWide: record.hostWide,
      hostLabel: String(record.host ?? '').split('.')[0] || null,
      siteLabel: String(record.learnedFromSiteKey ?? '').split('.')[0] || null,
      siteScoped: Array.isArray(record.initiatorDomains) && record.initiatorDomains.length > 0,
      sitesObserved: Array.isArray(record.observedSiteKeys) ? record.observedSiteKeys.length : 0,
      matchCount: record.matchCount,
      evidenceCount: record.evidenceCount,
      healthFailureCount: record.healthFailureCount,
      rollbackCount: record.rollbackCount,
      widthRefusalReason: record.widthRefusalReason ?? null,
      revokedReason: record.revokedReason ?? null,
      promotionReason: record.promotionReason ?? null,
      createdAt: record.createdAt,
      lastMatchedAt: record.lastMatchedAt ?? null,
      resourceTypes: record.resourceTypes,
    }));
    const dynamicRules = await chrome.declarativeNetRequest.getDynamicRules().catch(() => [] as chrome.declarativeNetRequest.Rule[]);
    const sessionRules = await chrome.declarativeNetRequest.getSessionRules().catch(() => [] as chrome.declarativeNetRequest.Rule[]);
    const learnedDynamic = dynamicRules
      .filter((rule) => rule.id >= 1_000_000 && rule.id <= 1_999_999)
      .map((rule) => ({
        id: rule.id,
        matchStyle: rule.condition.urlFilter ? 'narrow-url' : rule.condition.requestDomains ? 'host-wide' : 'other',
        requestDomainLabels: (rule.condition.requestDomains ?? []).map((domain) => domain.split('.')[0]),
        siteScoped: Boolean(rule.condition.initiatorDomains?.length),
        resourceTypes: rule.condition.resourceTypes ?? null,
      }));
    const bundle = {
      exportedAt: new Date().toISOString(),
      note: 'User-initiated diagnostics export. No credential. Hosts projected to first labels; forensics contain salted hashes only.',
      aiStatus: localData[AI_STATUS_STORAGE_KEY] ?? null,
      personalRules,
      dnr: {
        dynamicRuleCount: dynamicRules.length,
        sessionRuleCount: sessionRules.length,
        learnedDynamic,
        learnedSessionCount: sessionRules.filter((rule) => rule.id >= 3_000_000 && rule.id <= 3_999_999).length,
      },
      forensics: sessionData['adapt_kimi_forensics_v1'] ?? null,
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `adapt-diagnostics-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    learnedResult.textContent = `Diagnostics exported — ${personalRules.length} learned rule(s), ${learnedDynamic.length} durable DNR rule(s), forensics ${bundle.forensics ? 'included' : 'EMPTY (browser restarted since the test?)'}.`;
  } catch {
    learnedResult.textContent = 'Export failed: storage read error.';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  for (const segment of segments) {
    segment.addEventListener('click', () => {
      relayNotice.hidden = true;
      selectProvider(segment.dataset.provider as UiProvider);
    });
  }
  for (const chip of chips) {
    chip.addEventListener('click', () => applyPreset(chip.dataset.preset ?? ''));
  }
  el<HTMLButtonElement>('btn-save').addEventListener('click', () => void onSave());
  el<HTMLButtonElement>('btn-test').addEventListener('click', () => void onTest());
  el<HTMLButtonElement>('btn-clear').addEventListener('click', () => void onClear());
  el<HTMLButtonElement>('btn-clear-learned').addEventListener('click', () => void onClearLearned());
  el<HTMLButtonElement>('btn-export-diagnostics').addEventListener('click', () => void onExportDiagnostics());
  void refreshLearned();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[AI_STATUS_STORAGE_KEY] || changes[AI_CONFIG_STORAGE_KEY])) void refresh();
  });
  void (async () => {
    const stored = await chrome.storage.local.get([AI_CONFIG_STORAGE_KEY]);
    const existing = stored[AI_CONFIG_STORAGE_KEY];
    savedToken = validConfig(existing) ? existing.token : undefined;
    await refresh();
  })();
});
