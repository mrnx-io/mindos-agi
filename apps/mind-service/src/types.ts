// =============================================================================
// MindOS - Type Re-exports
// =============================================================================

// Re-export all types from shared-types
export * from "@mindos/shared-types"

// Local type extensions
export interface MindServiceContext {
  identityId: string
  taskId?: string
  stepId?: string
  correlationId: string
}

export interface ModelResponse {
  content: string
  model: string
  provider: string
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  latencyMs: number
  cached: boolean
}

export interface ToolExecutionResult {
  success: boolean
  output: unknown
  error?: string
  duration_ms: number
  evidence_id?: string
}

export interface PlanStep {
  description: string
  tool?: string
  parameters?: Record<string, unknown>
  expected_outcome?: string
  risk_factors?: string[]
  alternatives?: string[]
}

export interface ExecutionPlan {
  goal: string
  steps: PlanStep[]
  success_criteria: string[]
  rollback_strategy?: string
  estimated_risk: number
}
