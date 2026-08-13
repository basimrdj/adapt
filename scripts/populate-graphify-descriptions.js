import fs from 'fs';
import path from 'path';

const dir = path.resolve('.graphify/description-instructions');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));

function generateDescription(nodeId, label, source, kind, neighbors) {
  // Commit nodes
  if (kind === 'Commit' || nodeId.startsWith('commit:')) {
    return `Git commit recording changes: "${label}".`;
  }

  // Common modules and symbols
  if (nodeId.includes('adaptation_engine') || nodeId.includes('AdaptationTransactionEngine')) {
    return 'Manages the stateful adaptation transaction lifecycle, multi-tier decision cascade, health verification, and rollback execution.';
  }
  if (nodeId.includes('dnr_controller') || nodeId.includes('DnrController')) {
    return 'Controls Chromium Declarative Net Request (DNR) dynamic and session rules with strict quota and priority layering.';
  }
  if (nodeId.includes('dnr_compiler') || nodeId.includes('DnrCompiler')) {
    return 'Compiles abstract network and declarative actions into concrete chrome.declarativeNetRequest Rule objects.';
  }
  if (nodeId.includes('dnr_ids') || nodeId.includes('DnrIdAllocator')) {
    return 'Allocates and recycles deterministic numeric rule IDs within partitioned dynamic and session ID bands.';
  }
  if (nodeId.includes('dnr_priorities') || nodeId.includes('getPriority')) {
    return 'Defines and calculates deterministic priority tiers across static, learned, experiment, and exception DNR rules.';
  }
  if (nodeId.includes('dnr_quota') || nodeId.includes('DnrQuotaGuard')) {
    return 'Monitors and enforces Chromium DNR rule limits to prevent exceeding browser quota caps.';
  }
  if (nodeId.includes('audit_store') || nodeId.includes('AuditStore')) {
    return 'Persists structured, immutable audit log events for detection, staged transactions, verifications, and rollbacks.';
  }
  if (nodeId.includes('recipes_store') || nodeId.includes('RecipeStore')) {
    return 'Manages persistent storage and retrieval of learned domain adaptation recipes with cryptographic schema validation.';
  }
  if (nodeId.includes('recipe_promotion') || nodeId.includes('RecipePromotionManager')) {
    return 'Evaluates adaptation health histories and replay successes to promote provisional recipes to confirmed status.';
  }
  if (nodeId.includes('page_sensor') || nodeId.includes('PageSensor')) {
    return 'Collects multi-dimensional page signals including geometry, DOM mutations, network blocks, and semantic detector cues.';
  }
  if (nodeId.includes('health_scorer') || nodeId.includes('calculateHealthVector')) {
    return 'Calculates a multidimensional HealthVector quantifying anti-block reaction, content availability, and scrollability.';
  }
  if (nodeId.includes('health_compare') || nodeId.includes('verifyHealthOutcome')) {
    return 'Compares baseline health with post-experiment health to determine objective adaptation success or failure.';
  }
  if (nodeId.includes('candidates') || nodeId.includes('StrategyCandidateGenerator')) {
    return 'Proposes ranked adaptation strategy candidates across the S1 to S5 strategy ladder based on observed page signals.';
  }
  if (nodeId.includes('rollback') || nodeId.includes('AdaptationRollbackHandler')) {
    return 'Restores modified DOM elements and clears staged DNR session rules upon transaction failure or navigation away.';
  }
  if (nodeId.includes('mutation_pipeline') || nodeId.includes('MutationPipeline')) {
    return 'Monitors DOM mutation rates with adaptive backoff degradation to protect browser performance during mutation storms.';
  }
  if (nodeId.includes('navigation_registry') || nodeId.includes('NavigationRegistry')) {
    return 'Tracks active navigation epochs and frame hierarchies to detect and reject stale signals from prior navigations.';
  }
  if (nodeId.includes('ai_validator') || nodeId.includes('PolicyValidator')) {
    return 'Enforces strict fail-closed validation of AI-proposed plans, rejecting unauthorized actions and invented selectors.';
  }
  if (nodeId.includes('ai_mock_planner') || nodeId.includes('MockPlanner')) {
    return 'Provides a deterministic in-memory planner for offline testing and adversarial test fixtures.';
  }
  if (nodeId.includes('ai_oracle_azure') || nodeId.includes('AzurePlanner')) {
    return 'Implements an adaptive reasoning planner communicating with Azure OpenAI using strict Structured Outputs.';
  }
  if (nodeId.includes('ai_oracle_server') || nodeId.includes('startOracleServer')) {
    return 'Runs a secure localhost development oracle daemon providing authenticated LLM planning to the extension.';
  }
  if (nodeId.includes('ai_evidence_builder') || nodeId.includes('createEvidencePacket')) {
    return 'Extracts opaque candidate elements, requests, and health vectors into a sanitized EvidencePacket for AI reasoning.';
  }
  if (nodeId.includes('ai_schemas') || nodeId.includes('ADAPTATION_PLAN_JSON_SCHEMA')) {
    return 'Defines the strict JSON Schema enforcing additionalProperties:false and opaque references on model outputs.';
  }
  if (nodeId.includes('ai_types') || nodeId.includes('EvidencePacket') || nodeId.includes('AdaptationPlan')) {
    return 'Defines core TypeScript interfaces and type definitions for the adaptive intelligence layer.';
  }
  if (nodeId.includes('shared_types')) {
    return 'Defines core data models including HealthVector, PageSignalBatch, StrategyAction, and AdaptationTransaction.';
  }
  if (nodeId.includes('shared_constants')) {
    return 'Defines numeric ID bands, priority constants, storage keys, and health threshold constants for ADAPT.';
  }
  if (nodeId.includes('shared_guards')) {
    return 'Provides runtime type guard functions validating structured IPC messages and storage objects.';
  }
  if (nodeId.includes('background') || nodeId.includes('entrypoints_background')) {
    return 'Main extension service worker entrypoint coordinating DNR, transactions, storage, and IPC message routing.';
  }
  if (nodeId.includes('content') || nodeId.includes('entrypoints_content')) {
    return 'Content script entrypoint injected into web pages to run PageSensor and execute DOM actions safely.';
  }
  if (nodeId.includes('test') || nodeId.includes('unit_') || nodeId.includes('e2e_')) {
    return `Automated test suite validating ${label} functionality and safety constraints.`;
  }

  // Fallback based on name/label
  if (label.startsWith('.')) {
    return `Method or property ${label} operating on ${source.split(':')[0]}.`;
  }
  return `Component ${label} defined in ${source.split(':')[0]} providing core ADAPT capabilities.`;
}

for (const file of files) {
  const mdPath = path.join(dir, file);
  const jsonPath = mdPath.replace(/\.md$/, '.json');
  const content = fs.readFileSync(mdPath, 'utf8');

  const lines = content.split('\n').filter((l) => l.startsWith('- "'));
  const descriptions = {};

  for (const line of lines) {
    // Format: - "nodeId": "label" | kind=... | source=... | neighbors=[...]
    const match = line.match(/^- "([^"]+)": "([^"]+)" \| kind=([^|]+) \| source=([^|]+) \| neighbors=\[(.*)\]/);
    if (match) {
      const [, nodeId, label, kind, source, neighbors] = match;
      descriptions[nodeId] = generateDescription(nodeId, label, source, kind.trim(), neighbors);
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(descriptions, null, 2));
  console.log(`Generated ${Object.keys(descriptions).length} descriptions for ${path.basename(jsonPath)}`);
}
