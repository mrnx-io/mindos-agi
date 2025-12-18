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

  // Service URLs
  TOOLMESH_URL: z.string().url().default("http://localhost:3001"),
  EXECUTOR_URL: z.string().url().default("http://localhost:3002"),
  GROUNDING_SERVICE_URL: z.string().url().default("http://localhost:3003"),
  SWARM_COORDINATOR_URL: z.string().url().default("http://localhost:3005"),

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
  "gemini-3-flash": { provider: "google", model: "gemini-3-flash", maxTokens: 8192, temperature: 0.7 },

  // xAI - Grok 4.1 (Nov 2025)
  "grok-4.1": { provider: "xai", model: "grok-4.1", maxTokens: 8192, temperature: 0.7 },
  "grok-4.1-fast": { provider: "xai", model: "grok-4.1-fast", maxTokens: 8192, temperature: 0.7 },
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
    circuitBreakers.set(modelId, {
      failures: 0,
      lastFailure: null,
      open: false,
      halfOpenAt: null,
    })
  }
  return circuitBreakers.get(modelId)!
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
