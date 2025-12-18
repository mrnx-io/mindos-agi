// =============================================================================
// MindOS - Langfuse LLM Observability
// =============================================================================

import Langfuse from "langfuse"

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface LangfuseConfig {
  publicKey?: string
  secretKey?: string
  baseUrl?: string
  enabled?: boolean
}

export interface LLMCallMetrics {
  model: string
  provider: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
  success: boolean
  error?: string
}

// -----------------------------------------------------------------------------
// Client Instance
// -----------------------------------------------------------------------------

let langfuseClient: Langfuse | null = null

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

export function initLangfuse(config: LangfuseConfig): void {
  // Skip if disabled
  if (config.enabled === false) {
    console.log("[langfuse] Langfuse disabled")
    return
  }

  if (!config.publicKey || !config.secretKey) {
    console.log("[langfuse] Missing Langfuse credentials, skipping initialization")
    return
  }

  if (langfuseClient) {
    console.log("[langfuse] Langfuse already initialized")
    return
  }

  langfuseClient = new Langfuse({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    ...(config.baseUrl && { baseUrl: config.baseUrl }),
  })

  console.log("[langfuse] Langfuse initialized")

  // Graceful shutdown
  process.on("SIGTERM", () => {
    langfuseClient
      ?.shutdownAsync()
      .then(() => console.log("[langfuse] Langfuse shut down"))
      .catch((err: Error) => console.error("[langfuse] Error shutting down:", err))
  })
}

// -----------------------------------------------------------------------------
// LLM Call Tracking
// -----------------------------------------------------------------------------

export function trackLLMCall(
  name: string,
  metrics: LLMCallMetrics,
  metadata?: Record<string, unknown>
): void {
  if (!langfuseClient) return

  const trace = langfuseClient.trace({
    name,
    metadata: {
      ...metadata,
      model: metrics.model,
      provider: metrics.provider,
    },
  })

  trace.generation({
    name: `${metrics.provider}/${metrics.model}`,
    model: metrics.model,
    usage: {
      input: metrics.promptTokens,
      output: metrics.completionTokens,
      total: metrics.totalTokens,
    },
    metadata: {
      latencyMs: metrics.latencyMs,
      success: metrics.success,
      error: metrics.error,
    },
  })
}

// -----------------------------------------------------------------------------
// Trace Context
// -----------------------------------------------------------------------------

export function createTrace(
  name: string,
  options?: {
    userId?: string
    sessionId?: string
    metadata?: Record<string, unknown>
  }
) {
  if (!langfuseClient) return null

  return langfuseClient.trace({
    name,
    userId: options?.userId ?? null,
    sessionId: options?.sessionId ?? null,
    metadata: options?.metadata,
  })
}

export function createSpan(
  trace: ReturnType<typeof createTrace>,
  name: string,
  metadata?: Record<string, unknown>
) {
  if (!trace) return null

  return trace.span({
    name,
    metadata,
  })
}

// -----------------------------------------------------------------------------
// Shutdown
// -----------------------------------------------------------------------------

export async function shutdownLangfuse(): Promise<void> {
  if (langfuseClient) {
    await langfuseClient.shutdownAsync()
    langfuseClient = null
    console.log("[langfuse] Langfuse shut down")
  }
}

// -----------------------------------------------------------------------------
// Get Client
// -----------------------------------------------------------------------------

export function getLangfuseClient(): Langfuse | null {
  return langfuseClient
}
