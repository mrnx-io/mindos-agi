// =============================================================================
// MindOS - Mind Service Configuration
// =============================================================================

import { z } from "zod"

// -----------------------------------------------------------------------------
// Environment Schema
// -----------------------------------------------------------------------------

const EnvSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Model API Keys
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_AI_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),

  // Model Routing
  MODEL_PRIMARY: z.string().default("gpt-5.2"),
  MODEL_FALLBACK_1: z.string().default("claude-opus-4-5-20251101"),
  MODEL_FALLBACK_2: z.string().default("gemini-3-pro"),
  MODEL_FAST: z.string().default("gpt-5.2-mini"),

  // xAI Agent Tools Configuration
  XAI_ENABLE_AGENT_TOOLS: z.coerce.boolean().default(true),
  XAI_AGENT_TOOLS_ENABLED: z.string().default("web_search,x_search,code_execution,mcp"),
  XAI_PREFER_AGENT_TOOLS: z.coerce.boolean().default(false),
  XAI_CODE_EXECUTION_TIMEOUT_MS: z.coerce.number().default(300000),

  // Service URLs
  TOOLMESH_URL: z.string().url().default("http://localhost:3001"),
  EXECUTOR_URL: z.string().url().default("http://localhost:3002"),
  GROUNDING_SERVICE_URL: z.string().url().default("http://localhost:3003"),
  SWARM_COORDINATOR_URL: z.string().url().default("http://localhost:3005"),

  // Service Tokens (for inter-service authentication)
  TOOLMESH_TOKEN: z.string().optional(),
  EXECUTOR_TOKEN: z.string().optional(),
  GROUNDING_TOKEN: z.string().optional(),

  // Restate
  RESTATE_ADMIN_URL: z.string().url().default("http://localhost:9070"),

  // Policy Thresholds
  RISK_THRESHOLD_AUTO: z.coerce.number().min(0).max(1).default(0.3),
  RISK_THRESHOLD_APPROVAL: z.coerce.number().min(0).max(1).default(0.7),
  RISK_THRESHOLD_BLOCK: z.coerce.number().min(0).max(1).default(0.9),

  // Feature Flags
  ENABLE_METACOGNITION: z.coerce.boolean().default(true),
  ENABLE_WORLD_MODEL: z.coerce.boolean().default(true),
  ENABLE_SWARM: z.coerce.boolean().default(true),
  ENABLE_GROUNDING: z.coerce.boolean().default(true),

  // Metacognition & Self-Improvement (Workstream A)
  ENABLE_HYPOTHESIS_ACTIONS: z.coerce.boolean().default(true),
  ENABLE_AUTO_CALIBRATION: z.coerce.boolean().default(true),
  ENABLE_AUTO_CONFLICT_RESOLUTION: z.coerce.boolean().default(true),
  ENABLE_SKILL_EFFECTIVENESS_TRACKING: z.coerce.boolean().default(true),
  CALIBRATION_MAX_SINGLE_ADJUSTMENT: z.coerce.number().min(0).max(0.2).default(0.05),
  CALIBRATION_MAX_CUMULATIVE_DRIFT: z.coerce.number().min(0).max(0.5).default(0.2),
  CALIBRATION_COOLDOWN_MS: z.coerce.number().default(86400000), // 24 hours
  CONFLICT_AUTO_RESOLVE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),

  // World Model Integration (Workstream B)
  ENABLE_WORLD_MODEL_SIMULATION: z.coerce.boolean().default(true),
  WORLD_MODEL_LOOKAHEAD_STEPS: z.coerce.number().int().min(1).max(10).default(3),
  WORLD_MODEL_LOOKAHEAD_INTERVAL: z.coerce.number().int().min(1).default(2),
  WORLD_MODEL_CHECKPOINT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  WORLD_MODEL_CHECKPOINT_TTL_MS: z.coerce.number().default(3600000), // 1 hour
  WORLD_MODEL_HISTORY_LOOKBACK_DAYS: z.coerce.number().int().min(1).default(30),
  ENABLE_COUNTERFACTUAL_ANALYSIS: z.coerce.boolean().default(true),

  // Swarm Collaboration (Workstream C)
  SWARM_DELEGATION_MIN_STEPS: z.coerce.number().int().min(1).default(5),
  SWARM_DELEGATION_MIN_DURATION_MS: z.coerce.number().default(120000), // 2 minutes
  SWARM_DELEGATION_RISK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  MAX_SWARM_SIZE: z.coerce.number().int().min(1).default(10),
  SWARM_COLLABORATION_ANALYSIS_ENABLED: z.coerce.boolean().default(true),
  SWARM_SPECIALIZATION_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),

  // Cross-Verification (Workstream D)
  CROSS_VERIFY_ALL_WEB_SEARCH: z.coerce.boolean().default(true),
  CROSS_VERIFY_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  CROSS_VERIFY_REQUIRE_CORROBORATION: z.coerce.boolean().default(false),

  // Notification Settings (for significant self-modifications)
  NOTIFICATION_WEBHOOK_URL: z.string().url().optional(),
  NOTIFICATION_SLACK_WEBHOOK_URL: z.string().url().optional(),
  NOTIFY_ON_SIGNIFICANT_CALIBRATION: z.coerce.boolean().default(true),
  NOTIFY_ON_SKILL_CREATION: z.coerce.boolean().default(true),
  NOTIFY_ON_CONFLICT_ESCALATION: z.coerce.boolean().default(true),
  SIGNIFICANT_CALIBRATION_THRESHOLD: z.coerce.number().min(0).max(1).default(0.1),

  // On-Demand Tool Discovery Configuration
  ENABLE_ON_DEMAND_TOOLS: z.coerce.boolean().default(true),
  ENABLE_PROACTIVE_TOOL_DISCOVERY: z.coerce.boolean().default(true),
  TOOL_DISCOVERY_INITIAL_K: z.coerce.number().int().min(1).max(50).default(8),
  TOOL_DISCOVERY_EXPANSION_K: z.coerce.number().int().min(1).max(20).default(5),
  TOOL_DISCOVERY_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.4),
  TOOL_DISCOVERY_CACHE_TTL_MS: z.coerce.number().default(300000),

  // Logging
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

  // Server
  PORT: z.coerce.number().default(3000),
})

export type Env = z.infer<typeof EnvSchema>

// Parse and validate environment
function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env)
  if (!result.success) {
    console.error("Invalid environment configuration:")
    console.error(result.error.format())
    process.exit(1)
  }
  return result.data
}

export const env = loadEnv()

// -----------------------------------------------------------------------------
// Model Configuration
// -----------------------------------------------------------------------------

export type ModelProvider = "openai" | "anthropic" | "google" | "xai"

export interface ModelConfig {
  provider: ModelProvider
  model: string
  maxTokens: number
  temperature: number
  apiKey: string | undefined
}

const MODEL_CONFIGS: Record<string, Omit<ModelConfig, "apiKey">> = {
  // OpenAI - GPT-5.2 family (Dec 2025)
  "gpt-5.2": { provider: "openai", model: "gpt-5.2", maxTokens: 32768, temperature: 0.7 },
  "gpt-5.2-mini": { provider: "openai", model: "gpt-5.2-mini", maxTokens: 16384, temperature: 0.7 },
  // Legacy OpenAI (kept for fallback compatibility)
  "gpt-4o": { provider: "openai", model: "gpt-4o", maxTokens: 16384, temperature: 0.7 },
  "gpt-4o-mini": { provider: "openai", model: "gpt-4o-mini", maxTokens: 16384, temperature: 0.7 },

  // Anthropic - Claude 4.5 (Nov 2025)
  "claude-opus-4-5-20251101": {
    provider: "anthropic",
    model: "claude-opus-4-5-20251101",
    maxTokens: 16384,
    temperature: 0.7,
  },
  "claude-sonnet-4-20250514": {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    maxTokens: 8192,
    temperature: 0.7,
  },

  // Google - Gemini 3 (Dec 2025)
  "gemini-3-pro": { provider: "google", model: "gemini-3-pro", maxTokens: 8192, temperature: 0.7 },
  "gemini-3-flash": {
    provider: "google",
    model: "gemini-3-flash",
    maxTokens: 8192,
    temperature: 0.7,
  },

  // xAI - Grok 4.1 (Dec 2025) - 2M context, 128K output
  "grok-4-1": { provider: "xai", model: "grok-4-1", maxTokens: 131072, temperature: 0.7 },
  "grok-4-1-fast": { provider: "xai", model: "grok-4-1-fast", maxTokens: 131072, temperature: 0.7 },
  "grok-4-1-fast-reasoning": {
    provider: "xai",
    model: "grok-4-1-fast-reasoning",
    maxTokens: 131072,
    temperature: 0.7,
  },
}

export function getModelConfig(modelId: string): ModelConfig {
  const config = MODEL_CONFIGS[modelId]
  if (!config) {
    throw new Error(`Unknown model: ${modelId}`)
  }

  const apiKeyMap: Record<ModelProvider, string | undefined> = {
    openai: env.OPENAI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    google: env.GOOGLE_AI_API_KEY,
    xai: env.XAI_API_KEY,
  }

  return {
    ...config,
    apiKey: apiKeyMap[config.provider],
  }
}

// -----------------------------------------------------------------------------
// Model Routing Chain
// -----------------------------------------------------------------------------

export interface ModelChain {
  primary: string
  fallbacks: string[]
  fast: string
}

export const modelChain: ModelChain = {
  primary: env.MODEL_PRIMARY,
  fallbacks: [env.MODEL_FALLBACK_1, env.MODEL_FALLBACK_2].filter(Boolean),
  fast: env.MODEL_FAST,
}

// -----------------------------------------------------------------------------
// Circuit Breaker State
// -----------------------------------------------------------------------------

interface CircuitState {
  failures: number
  lastFailure: number | null
  open: boolean
  halfOpenAt: number | null
}

const circuitBreakers = new Map<string, CircuitState>()

const CIRCUIT_THRESHOLD = 3
const CIRCUIT_RESET_MS = 60000 // 1 minute

export function getCircuitState(modelId: string): CircuitState {
  if (!circuitBreakers.has(modelId)) {
    const newState: CircuitState = {
      failures: 0,
      lastFailure: null,
      open: false,
      halfOpenAt: null,
    }
    circuitBreakers.set(modelId, newState)
    return newState
  }
  // TypeScript now knows the value exists because has() returned true
  const state = circuitBreakers.get(modelId)
  if (!state) {
    // This should never happen, but satisfies TypeScript
    throw new Error(`Circuit state not found for model ${modelId}`)
  }
  return state
}

export function recordSuccess(modelId: string): void {
  const state = getCircuitState(modelId)
  state.failures = 0
  state.open = false
  state.halfOpenAt = null
}

export function recordFailure(modelId: string): void {
  const state = getCircuitState(modelId)
  state.failures++
  state.lastFailure = Date.now()

  if (state.failures >= CIRCUIT_THRESHOLD) {
    state.open = true
    state.halfOpenAt = Date.now() + CIRCUIT_RESET_MS
  }
}

export function isCircuitOpen(modelId: string): boolean {
  const state = getCircuitState(modelId)
  if (!state.open) return false

  // Check if we should try half-open
  if (state.halfOpenAt && Date.now() >= state.halfOpenAt) {
    state.halfOpenAt = null
    return false // Allow one attempt
  }

  return true
}

// -----------------------------------------------------------------------------
// Health Probes
// -----------------------------------------------------------------------------

const healthStatus = new Map<string, { healthy: boolean; lastCheck: number }>()

export function setModelHealth(modelId: string, healthy: boolean): void {
  healthStatus.set(modelId, { healthy, lastCheck: Date.now() })
}

export function isModelHealthy(modelId: string): boolean {
  const status = healthStatus.get(modelId)
  if (!status) return true // Assume healthy if not checked
  return status.healthy
}
