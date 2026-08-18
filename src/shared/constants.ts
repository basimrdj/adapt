/**
 * Constants and numeric ID bands for ADAPT.
 */

export const SCHEMA_VERSION = 1;

// DNR Rule ID Partitioning
export const ID_BANDS = {
  DYNAMIC_SAFE_MIN: 1_000_000,
  DYNAMIC_SAFE_MAX: 1_999_999,
  DYNAMIC_UNSAFE_MIN: 2_000_000,
  DYNAMIC_UNSAFE_MAX: 2_999_999,
  SESSION_SAFE_MIN: 3_000_000,
  SESSION_SAFE_MAX: 3_999_999,
  SESSION_UNSAFE_MIN: 4_000_000,
  SESSION_UNSAFE_MAX: 4_999_999,
} as const;

// DNR Priority Bands
export const PRIORITIES = {
  STATIC_BASELINE: 10,
  PERSISTED_LEARNED_BLOCK: 100,
  PERSISTED_COMPAT_RULE: 200,
  EXPERIMENT_BLOCK: 500,
  EXPERIMENT_REDIRECT: 600,
  COMPATIBILITY_EXCEPTION: 900,
  USER_OVERRIDE: 1000,
} as const;

// Quota Limits in Chromium MV3
export const QUOTA_LIMITS = {
  MAX_DYNAMIC_SAFE: 30_000,
  MAX_DYNAMIC_UNSAFE: 5_000,
  MAX_SESSION_RULES: 5_000,
  MAX_REGEX_RULES: 1_000,
} as const;

// Storage Keys
export const STORAGE_KEYS = {
  RECIPES: 'adapt_recipes_v1',
  DYNAMIC_RULE_ALLOCATIONS: 'adapt_dnr_dynamic_v1',
  ACTIVE_TRANSACTIONS: 'adapt_active_txs_v1',
  CAUSAL_EXPERIMENTS: 'adapt_causal_experiments_v1',
  CAUSAL_SESSION_STATE: 'adapt_causal_session_state_v1',
  CAUSAL_RECIPES: 'adapt_causal_recipes_v1',
  AUTONOMY_STATE: 'adapt_autonomy_state_v1',
  SETTINGS: 'adapt_settings_v1',
  AUDIT_LOGS: 'adapt_audit_logs_v1',
  PAUSED_HOSTS: 'adapt_paused_hosts',
  SCHEMA_VERSION: 'adapt_schema_version',
} as const;

// Observation & Health Thresholds
export const ADAPT_THRESHOLDS = {
  EXPERIMENT_OBSERVATION_MS: 3000,
  TRANSACTION_TIMEOUT_MS: 15000,
  MUTATION_BURST_THRESHOLD: 100, // per sec
  MUTATION_COALESCE_THRESHOLD: 300,
  MUTATION_PAUSE_THRESHOLD: 600,
  HIGH_CONFIDENCE_REACTION_SCORE: 0.65,
  MIN_HEALTH_DELTA_FOR_SUCCESS: 0.20,
  MAX_ALLOWED_CONTENT_REGRESSION: -0.05,
} as const;

// Known Anti-Adblock Semantic Keywords
export const DETECTOR_KEYWORDS = [
  'adblock',
  'ad blocker',
  'ad-blocker',
  'adblocking',
  'disable your ad blocker',
  'disable adblock',
  'turn off adblock',
  'turn off your ad blocker',
  'whitelist',
  'whitelist us',
  'please disable',
  'ads support us',
  'advertising helps',
  'blocker detected',
  'adblock detected',
  'continue without disabling',
  'support our journalism',
  'anti-adblock',
] as const;
