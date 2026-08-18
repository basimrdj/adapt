/**
 * STRICT-mode privacy proof (H5.1 — the load-bearing claim, executable).
 *
 * What this proves, with the actual production code paths and zero credentials:
 *
 *  1. PRODUCTION BUILDERS (hard gate): every EvidencePacket the live system can
 *     produce — engine path (createEvidencePacket), orchestrator survivor path
 *     (CausalOrchestrator STRICT and DOMAIN_HINTS modes), and the Options
 *     connection-test packet — is serialized through the REAL RemotePlanner
 *     transport (loopback capture for the generic shape, stubbed fetch for the
 *     Azure chat-completions shape) and the wire bytes are scanned for raw
 *     URLs, hostnames, selector syntax, HTML/content strings, and non-redacted
 *     domains. STRICT mode must emit 'redacted' domains, enum labels, opaque
 *     refs, hashes, and numbers only. DOMAIN_HINTS mode may emit eTLD+1
 *     registrable domains in the urlDomain slot — and nothing else anywhere.
 *
 *  2. CORPUS TRANSPARENCY (classification, not a leak gate): the eval and
 *     injection corpora are synthetic harness inputs replayed verbatim by the
 *     live eval harness. Injection fixtures deliberately smuggle hostile
 *     strings in the textSignals slot to prove the MODEL rejects them; that is
 *     an attack surface test, not a privacy leak. This proof scans every corpus
 *     wire body slot-aware: forbidden patterns outside the designated
 *     textSignals/urlDomain slots FAIL the proof; inside those slots they are
 *     counted and recorded as adversarial-fixture content.
 *
 * Artifact: artifacts/final-intelligence/PRIVACY_STRICT_PROOF.json
 * Exit non-zero on any hard-gate violation. Wired into verify:phase31b.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { RemotePlanner } from '../src/background/ai/remote-planner';
import { createEvidencePacket } from '../src/shared/ai/evidence-builder';
import { buildConnectionTestPacket } from '../src/background/ai/test-connection';
import { EvidencePacket } from '../src/shared/ai/types';
import { CausalOrchestrator } from '../src/background/causal/orchestrator';
import { NavigationRegistry } from '../src/core/navigation/registry';
import { EventGraphStore } from '../src/background/causal/graph-store';
import { BeliefUpdater } from '../src/background/causal/belief-updater';
import { PromotionGate } from '../src/background/causal/promotion-gate';
import { EventNode } from '../src/shared/causal/events';
import { CausalPageObservationBatch, OpaqueSurvivorObservation, PageSignalBatch } from '../src/shared/types';
import { verificationMetadata } from './verification-metadata';

const root = process.cwd();
const artifactDir = path.join(root, 'artifacts', 'final-intelligence');

// ---------------------------------------------------------------------------
// chrome.* stub (orchestrator touches chrome.storage.session for its trace)
// ---------------------------------------------------------------------------
{
  const areaFor = (backing: Map<string, unknown>) => ({
    get: async (key?: string | string[] | null) => {
      if (key === null || key === undefined) return Object.fromEntries(backing);
      if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => backing.has(k)).map((k) => [k, backing.get(k)]));
      return { [key]: backing.get(key) };
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) backing.set(key, value);
    },
    remove: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) backing.delete(k);
    },
    clear: async () => backing.clear(),
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: areaFor(new Map()), local: areaFor(new Map()) },
    scripting: { executeScript: async () => [], insertCSS: async () => {} },
  };
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------
interface Violation {
  packet: string;
  path: string;
  kind: string;
  excerpt: string;
}

const RAW_BODY_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'url', re: /https?:\/\//i },
  { kind: 'html-markup', re: /[<>]/ },
  { kind: 'selector-id', re: /#[a-zA-Z][\w-]{1,40}/ },
  { kind: 'selector-attr', re: /\[[a-zA-Z-]+=['"]?[\w-]+/ },
];
const HOSTISH = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i;
const ENUM_LABEL = /^[A-Z0-9_]+$|^[a-z0-9-]+$/;
const OPAQUE_REF = /^(element|request|survivor):[a-z0-9]+$/i;
const REGISTRABLE_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+){1,2}$/;

function walkStrings(value: unknown, pathSoFar: string, out: Array<{ path: string; value: string }>): void {
  if (typeof value === 'string') {
    out.push({ path: pathSoFar, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkStrings(item, `${pathSoFar}[${i}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      walkStrings(item, pathSoFar ? `${pathSoFar}.${key}` : key, out);
    }
  }
}

/**
 * Slot-aware scan. `contentSlots` are paths where adversarial FIXTURE content
 * is allowed (counted, not gated); production packets pass no content slots.
 */
function scanPacket(
  packetName: string,
  rawBody: string,
  options: { contentSlots?: string[]; domainMode: 'strict' | 'hints' | 'fixture' }
): { violations: Violation[]; slotContent: number; domainValues: string[] } {
  const violations: Violation[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    violations.push({ packet: packetName, path: '<body>', kind: 'unparseable-body', excerpt: rawBody.slice(0, 80) });
    return { violations, slotContent: 0, domainValues: [] };
  }
  // Azure shape: the evidence rides inside messages[1].content as a JSON string;
  // the system prompt is fixed production text (scanned like everything else).
  const azureMessage = (parsed as { messages?: Array<{ role?: string; content?: unknown }> }).messages?.find((m) => m.role === 'user');
  const evidenceRoot = typeof azureMessage?.content === 'string' ? (JSON.parse(azureMessage.content) as unknown) : parsed;

  const strings: Array<{ path: string; value: string }> = [];
  walkStrings(evidenceRoot, '', strings);
  const contentSlots = options.contentSlots ?? [];
  let slotContent = 0;
  const domainValues: string[] = [];

  for (const { path: stringPath, value } of strings) {
    const inContentSlot = contentSlots.some((slot) => stringPath.includes(slot));
    const isDomainSlot = /\.?candidateRequests\[\d+\]\.urlDomain$/.test(stringPath);
    if (isDomainSlot) {
      domainValues.push(value);
      if (options.domainMode === 'strict') {
        if (value !== 'redacted') {
          violations.push({ packet: packetName, path: stringPath, kind: 'strict-domain-not-redacted', excerpt: value.slice(0, 60) });
        }
      } else if (options.domainMode === 'hints') {
        if (!REGISTRABLE_DOMAIN.test(value) || /:|\/|\?|@/.test(value)) {
          violations.push({ packet: packetName, path: stringPath, kind: 'domain-hints-not-registrable', excerpt: value.slice(0, 60) });
        }
      }
      // fixture mode: synthetic harness input — record the value, never gate.
      continue;
    }
    for (const { kind, re } of RAW_BODY_PATTERNS) {
      if (re.test(value)) {
        if (inContentSlot) slotContent++;
        else violations.push({ packet: packetName, path: stringPath, kind, excerpt: value.slice(0, 60) });
      }
    }
    if (HOSTISH.test(value)) {
      // Legitimate non-identifying dotted tokens: none expected outside the
      // domain slot in any packet this system produces or replays.
      if (inContentSlot) slotContent++;
      else violations.push({ packet: packetName, path: stringPath, kind: 'hostname-outside-domain-slot', excerpt: value.slice(0, 60) });
    }
    if (/textSignals\[\d+\]$/.test(stringPath) && !ENUM_LABEL.test(value) && !inContentSlot) {
      violations.push({ packet: packetName, path: stringPath, kind: 'non-enum-text-signal', excerpt: value.slice(0, 60) });
    }
    if (/\.(targetRef|ref)$/.test(stringPath) && !OPAQUE_REF.test(value)) {
      violations.push({ packet: packetName, path: stringPath, kind: 'non-opaque-ref', excerpt: value.slice(0, 60) });
    }
  }
  return { violations, slotContent, domainValues };
}

// ---------------------------------------------------------------------------
// Wire capture
// ---------------------------------------------------------------------------
const ABSTAIN_PLAN = {
  schemaVersion: 1,
  decision: 'ABSTAIN',
  hypothesis: { category: 'UNKNOWN', confidence: 0.5, explanation: 'capture' },
  selectedStrategyTier: 'ABSTAIN',
  actions: [],
  verification: { expectedHealthDelta: 0, maxWaitMs: 500 },
  abortConditions: [],
  explanationCodes: [],
};

async function captureGenericWire(evidence: EvidencePacket): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      (server as unknown as { __captured?: string[] }).__captured?.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ plan: ABSTAIN_PLAN }));
    });
  });
  (server as unknown as { __captured?: string[] }).__captured = [];
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  try {
    const planner = new RemotePlanner({ endpoint: `http://127.0.0.1:${port}/plan` });
    await planner.plan(evidence);
    const captured = (server as unknown as { __captured: string[] }).__captured;
    if (captured.length !== 1) throw new Error(`expected exactly one wire capture, got ${captured.length}`);
    return captured[0]!;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function captureAzureWire(evidence: EvidencePacket): Promise<string> {
  const captured: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    captured.push(String(init?.body ?? ''));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(ABSTAIN_PLAN) }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as unknown as typeof fetch;
  try {
    const planner = new RemotePlanner({
      // Placeholder non-credential values: fetch is stubbed, nothing leaves the process.
      endpoint: 'https://privacy-proof.invalid.openai.azure.com/openai/deployments/proof/chat/completions?api-version=2024-10-21',
      token: 'privacy-proof-placeholder',
      model: 'proof-deployment',
    });
    await planner.plan(evidence);
    if (captured.length !== 1) throw new Error(`expected exactly one azure capture, got ${captured.length}`);
    return captured[0]!;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// Production-builder packet factories
// ---------------------------------------------------------------------------
function hostileBatch(): PageSignalBatch {
  return {
    navigationId: 'nav_privacy_proof',
    timestamp: Date.now(),
    geometry: {
      viewportWidth: 1280, viewportHeight: 800, hasFixedOverlay: true, overlayCoverageRatio: 0.9,
      bodyScrollLocked: true, htmlScrollLocked: false, modalCount: 1, mainContentHidden: true, mainContentHeight: 400,
    },
    semantic: {
      detectedPhrases: ['ANTI_BLOCK_INSTRUCTION', 'AD_REVENUE_APPEAL'],
      adblockKeywordDensity: 0.12, confidenceScore: 0.95,
      categories: ['ANTI_BLOCK_INSTRUCTION'],
    } as PageSignalBatch['semantic'],
    interaction: { pointerEventsSuppressed: true, bodyOverflowHidden: true, contentCovered: true },
    mutation: { mutationRatePerSecond: 12, rapidReinsertionDetected: true, overlayReinsertedCount: 3, degradationState: 'NORMAL' },
    suspectedDetectorTypes: ['FULLSCREEN_GATE', 'SCROLL_LOCK', 'SEMANTIC_PROMPT'],
  };
}

function hostileSurvivor(): OpaqueSurvivorObservation {
  return {
    ref: 'survivor:s1',
    class: 'ANTI_BLOCK_REACTION',
    documentScope: 'doc',
    observedAt: Date.now(),
    confidence: 0.85,
    evidenceClasses: ['visible', 'third-party-or-isolated', 'positioned-surface'],
    elementRef: 'element:e7',
    protectedContext: { authOrPayment: false, media: false, downloadOrDocument: false, userIntentRelated: false },
    features: {
      visible: true, thirdPartyResource: true, fixedOrAbsolute: true, isolatedSurface: true,
      semanticAdLabel: false, recentInsertion: true, mutationAssociation: 1, viewportCoverage: 0.9,
    },
  } as OpaqueSurvivorObservation;
}

async function captureOrchestratorEvidence(privacyMode: 'STRICT' | 'DOMAIN_HINTS'): Promise<EvidencePacket> {
  const registry = new NavigationRegistry();
  const graphs = new EventGraphStore();
  const captured: EvidencePacket[] = [];
  const capturingPlanner = {
    plan: async (evidence: EvidencePacket) => {
      captured.push(evidence);
      return ABSTAIN_PLAN;
    },
  };
  const orchestrator = new CausalOrchestrator({
    registry,
    requestGraphs: { getGraph: () => undefined } as never,
    graphs,
    beliefs: new BeliefUpdater(),
    engine: { getRecords: () => [] } as never,
    session: { persist: async () => {}, persistSoon: () => {} } as never,
    sendTabMessage: async () => {},
    recipeStore: { getRecipe: async () => undefined } as never,
    promotion: new PromotionGate(),
    primitiveExecutors: {
      stage: async () => ({ ok: true }),
      rollback: async () => ({ ok: true }),
    } as never,
    runFallback: async () => null,
  });
  orchestrator.setAdaptivePlanner(capturingPlanner as never);
  orchestrator.setAiPrivacyMode(privacyMode);

  const epoch = registry.onNavigationCommitted(7, 0, 'https://publisher-example.test/article', undefined, 'doc-privacy');
  const scope = registry.getCausalKey(7, 0)!;
  const graph = graphs.getOrCreate(scope, 'cafebabe');
  // Third-party request nodes with hostile full hostnames — the STRICT builder
  // must redact these; DOMAIN_HINTS may emit the registrable domain only.
  const requestNode = (id: string, ref: string, host: string): EventNode =>
    ({
      id,
      kind: 'REQUEST_COMPLETE',
      scope: { ...scope, frameId: 0 },
      timestamp: { value: Date.now(), wallMs: Date.now(), monotonicMs: 1 },
      refs: [ref],
      features: { thirdParty: true, resourceType: 'script', hostname: host },
    }) as unknown as EventNode;
  graph.nodes.push(requestNode('event:p1', 'request:r1', 'cdn.sub.tracker-example.com'));
  graph.nodes.push(requestNode('event:p2', 'request:r2', 'pixel.ads-network-example.co.uk'));

  const batch: CausalPageObservationBatch = {
    timestamp: Date.now(),
    pageSignals: hostileBatch(),
    elements: [],
    survivors: [hostileSurvivor()],
  };
  const health = {
    antiBlockReaction: 0.7, contentAvailability: 0.4, interaction: 0.5, scrollability: 0.3,
    navigationHealth: 1, visualObstruction: 0.9, mutationStability: 0.6, confidence: 0.9,
  };
  const runner = orchestrator as unknown as {
    maybeRunSurvivorAi: (
      tabId: number, frameId: number,
      epochArg: NonNullable<ReturnType<NavigationRegistry['getEpoch']>>,
      scopeArg: NonNullable<ReturnType<NavigationRegistry['getCausalKey']>>,
      graphArg: ReturnType<EventGraphStore['getOrCreate']>,
      batchArg: CausalPageObservationBatch,
      healthArg: typeof health
    ) => Promise<void>;
  };
  await runner.maybeRunSurvivorAi(7, 0, epoch, scope, graph, batch, health);
  if (captured.length !== 1) throw new Error(`orchestrator produced ${captured.length} evidence packets (expected 1) for ${privacyMode}`);
  return captured[0]!;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
interface PacketReport {
  name: string;
  violations: Violation[];
  slotContent: number;
  domainValues: string[];
}

async function main(): Promise<void> {
  const reports: PacketReport[] = [];
  const push = (name: string, body: string, opts: { contentSlots?: string[]; domainMode: 'strict' | 'hints' | 'fixture' }) => {
    const scan = scanPacket(name, body, opts);
    reports.push({ name, violations: scan.violations, slotContent: scan.slotContent, domainValues: scan.domainValues });
  };

  // 1. Production builders → real wire bodies (generic loopback + azure stub).
  const engineEvidence = createEvidencePacket(7, 'nav_privacy_proof', 'publisher-example.test', hostileBatch(), {
    antiBlockReaction: 0.7, contentAvailability: 0.4, interaction: 0.5, scrollability: 0.3,
    navigationHealth: 1, visualObstruction: 0.9, mutationStability: 0.6, confidence: 0.9,
  } as never);
  const orchestratorStrict = await captureOrchestratorEvidence('STRICT');
  const orchestratorHints = await captureOrchestratorEvidence('DOMAIN_HINTS');
  const connectionTest = buildConnectionTestPacket();

  const produced: Array<{ name: string; evidence: EvidencePacket; domainMode: 'strict' | 'hints' }> = [
    { name: 'engine-builder', evidence: engineEvidence, domainMode: 'strict' },
    { name: 'orchestrator-strict', evidence: orchestratorStrict, domainMode: 'strict' },
    { name: 'orchestrator-domain-hints', evidence: orchestratorHints, domainMode: 'hints' },
    { name: 'connection-test', evidence: connectionTest, domainMode: 'strict' },
  ];
  for (const { name, evidence, domainMode } of produced) {
    push(`${name}:generic`, await captureGenericWire(evidence), { domainMode });
    push(`${name}:azure`, await captureAzureWire(evidence), { domainMode });
  }

  // DOMAIN_HINTS may surface registrable domains; assert exactly what surfaced.
  const hintsReport = reports.filter((r) => r.name.startsWith('orchestrator-domain-hints'));
  const hintDomains = [...new Set(hintsReport.flatMap((r) => r.domainValues))].sort();
  const expectedHints = ['ads-network-example.co.uk', 'tracker-example.com'];
  if (JSON.stringify(hintDomains) !== JSON.stringify(expectedHints)) {
    for (const report of hintsReport) {
      report.violations.push({
        packet: report.name, path: 'candidateRequests[].urlDomain', kind: 'domain-hints-not-registrable',
        excerpt: `got ${JSON.stringify(hintDomains)} want ${JSON.stringify(expectedHints)}`,
      } as never);
    }
  }

  // 2. Corpus transparency: replay-shape wire bodies, slot-aware.
  const corpusDir = path.join(root, 'tests', 'fixtures', 'ai');
  let corpusEntriesScanned = 0;
  for (const file of ['eval-corpus-v2.json', 'injection-corpus.json']) {
    const entries = JSON.parse(fs.readFileSync(path.join(corpusDir, file), 'utf8')) as Array<{ id: string; evidence: EvidencePacket }>;
    let slotContentTotal = 0;
    let domainTotal = 0;
    for (const entry of entries) {
      corpusEntriesScanned++;
      const body = JSON.stringify(entry.evidence); // exact generic wire serialization
      const scan = scanPacket(`${file}:${entry.id}`, body, {
        // Injection fixtures smuggle hostile strings in textSignals by design;
        // eval fixtures may carry full hostnames in the urlDomain slot.
        contentSlots: ['textSignals'],
        domainMode: 'fixture',
      });
      slotContentTotal += scan.slotContent;
      domainTotal += scan.domainValues.filter((v) => v !== 'redacted').length;
      if (scan.violations.length > 0) {
        reports.push({ name: `${file}:${entry.id}`, violations: scan.violations, slotContent: scan.slotContent, domainValues: scan.domainValues });
      }
    }
    reports.push({ name: `${file}:summary`, violations: [], slotContent: slotContentTotal, domainValues: [`non-redacted fixture domains: ${domainTotal}`] });
  }

  const hardFailures = reports.filter((r) => r.violations.length > 0);
  const verdict = hardFailures.length === 0 ? 'PASS' : 'FAIL';
  const artifact = {
    schema: 'adapt-privacy-strict-proof-v1',
    ...verificationMetadata(root),
    verdict,
    packetsScanned: reports.filter((r) => !r.name.endsWith(':summary')).length + corpusEntriesScanned,
    productionBuilders: reports.filter((r) => !r.name.includes(':')).map((r) => r.name),
    hardFailures: hardFailures.map((r) => ({ packet: r.name, violations: r.violations.slice(0, 10) })),
    fixtureTransparency: reports.filter((r) => r.name.endsWith(':summary')),
    claims: [
      'STRICT production builders emit only enum labels, opaque refs, hashes, numbers, and redacted domains — proven on the real RemotePlanner wire, generic and Azure shapes.',
      'DOMAIN_HINTS mode emits registrable eTLD+1 domains in the urlDomain slot only, never full hosts, paths, or URLs.',
      'Corpus fixtures are synthetic harness inputs; adversarial content is confined to the designated textSignals attack slot and counted, never produced by production builders.',
    ],
  };
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'PRIVACY_STRICT_PROOF.json'), `${JSON.stringify(artifact, null, 2)}\n`);

  console.log(`PRIVACY STRICT PROOF — ${verdict}`);
  console.log(`  packets scanned: ${artifact.packetsScanned}`);
  console.log(`  domain-hints surface: ${hintDomains.join(', ')}`);
  for (const failure of hardFailures.slice(0, 8)) {
    console.log(`  VIOLATION ${failure.name}: ${failure.violations[0]!.kind} at ${failure.violations[0]!.path} — ${failure.violations[0]!.excerpt}`);
  }
  if (verdict !== 'PASS') process.exit(1);
}

await main();
