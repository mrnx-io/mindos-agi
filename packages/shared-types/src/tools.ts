// =============================================================================
// MindOS - Tool Types
// =============================================================================

import { z } from "zod"
import { JSONSchema, UUIDSchema } from "./schemas.js"

// -----------------------------------------------------------------------------
// Tool Mode
// -----------------------------------------------------------------------------

export const ToolModeSchema = z.enum(["read_only", "write_safe", "privileged"])
export type ToolMode = z.infer<typeof ToolModeSchema>

// -----------------------------------------------------------------------------
// Tool Registry Entry
// -----------------------------------------------------------------------------

export const ToolSchema = z.object({
  namespaced_name: z.string(), // mcp__server__tool format
  server_id: z.string(),
  tool_name: z.string(),
  description: z.string().nullable().optional(),
  input_schema: JSONSchema.nullable().optional(),
  output_schema: JSONSchema.nullable().optional(),
  annotations: JSONSchema.nullable().optional(),
  schema_hash: z.string(),

  // Alias fields for backwards compatibility
  name: z.string().optional(), // Alias for tool_name
  parameters: JSONSchema.optional(), // Alias for input_schema
  risk_level: z.enum(["low", "medium", "high"]).optional(), // Risk classification

  // Hints
  read_only_hint: z.boolean().optional(),
  destructive_hint: z.boolean().optional(),
  idempotent_hint: z.boolean().optional(),
  cost_hint: z.enum(["low", "medium", "high"]).optional(),

  // Stats
  call_count: z.number().int().min(0).optional(),
  success_count: z.number().int().min(0).optional(),
  failure_count: z.number().int().min(0).optional(),
  avg_latency_ms: z.number().optional(),

  // Health
  health_status: z.enum(["healthy", "degraded", "unhealthy", "unknown"]).optional(),

  // Performance estimates
  estimated_duration_ms: z.number().int().min(0).optional(),
})
export type Tool = z.infer<typeof ToolSchema>

// -----------------------------------------------------------------------------
// Tool Search
// -----------------------------------------------------------------------------

export const ToolSearchRequestSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().min(1).max(50).optional().default(10),
  mode: ToolModeSchema.optional(),
  server_ids: z.array(z.string()).optional(),
})
export type ToolSearchRequest = z.infer<typeof ToolSearchRequestSchema>

export const ToolSearchResultSchema = z.object({
  query: z.string(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: JSONSchema.optional(),
      score: z.number().optional(),
    })
  ),
})
export type ToolSearchResult = z.infer<typeof ToolSearchResultSchema>

// -----------------------------------------------------------------------------
// Tool Call
// -----------------------------------------------------------------------------

export const ToolCallRequestSchema = z.object({
  traceId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  namespacedTool: z.string().optional(),
  serverId: z.string().optional(),
  toolName: z.string().optional(),
  arguments: JSONSchema.optional(),
  mode: ToolModeSchema.optional(),
})
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>

export const ToolCallResultSchema = z.object({
  ok: z.boolean(),
  toolCallId: UUIDSchema,
  tool: z.string(),
  previewText: z.string(),
  structured: JSONSchema.nullable().optional(),
  duration_ms: z.number().int().optional(),
  error: z.string().optional(),
})
export type ToolCallResult = z.infer<typeof ToolCallResultSchema>

// -----------------------------------------------------------------------------
// Tool Program Step (for step-based programs)
// -----------------------------------------------------------------------------

export const ToolProgramStepSchema = z.object({
  step_id: z.string(),
  sequence: z.number().int().min(0),
  description: z.string(),
  tool: z.string(),
  parameters: z.record(z.unknown()),
  condition: z.string().optional(),
  on_error: z.enum(["abort", "skip", "retry"]).default("abort"),
  max_retries: z.number().int().min(0).default(0),
  output_as: z.string().optional(),
})
export type ToolProgramStep = z.infer<typeof ToolProgramStepSchema>

// -----------------------------------------------------------------------------
// Tool Program (supports both code-based and step-based)
// -----------------------------------------------------------------------------

export const ToolProgramSchema = z.object({
  // Common fields
  objective: z.string(),
  input: JSONSchema,

  // Code-based program (LLM-generated code)
  code: z.string(),
  compiler_notes: z.string().optional(),
  verifier_issues: z.array(z.string()).optional(),

  // Step-based program
  program_id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  steps: z.array(ToolProgramStepSchema).optional(),
  requires_approval: z.boolean().optional(),
  max_parallel: z.number().int().min(1).optional(),
  created_at: z.string().optional(),
})
export type ToolProgram = z.infer<typeof ToolProgramSchema>

export const ToolProgramResultSchema = z.object({
  ok: z.boolean(),
  objective: z.string(),
  toolCandidates: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
    })
  ),
  code: z.string(),
  compilerNotes: z.string(),
  verifierIssues: z.array(z.string()),
  executor: JSONSchema,
  out: JSONSchema.optional(),
  traceId: z.string().optional(),
  toolCallIds: z.array(UUIDSchema).optional(),
})
export type ToolProgramResult = z.infer<typeof ToolProgramResultSchema>

// -----------------------------------------------------------------------------
// Two-Phase Execution
// -----------------------------------------------------------------------------

export const PreflightResultSchema = z.object({
  canProceed: z.boolean(),
  plan: z.string(),
  parameters: JSONSchema,
  concerns: z.array(z.string()),
  checks: z.array(
    z.object({
      check: z.string(),
      passed: z.boolean(),
      details: z.string().optional(),
    })
  ),
})
export type PreflightResult = z.infer<typeof PreflightResultSchema>

export const TwoPhaseResultSchema = z.object({
  preflight: PreflightResultSchema,
  execution: ToolProgramResultSchema.optional(),
  skipped: z.boolean().optional(),
  skip_reason: z.string().optional(),
})
export type TwoPhaseResult = z.infer<typeof TwoPhaseResultSchema>

// -----------------------------------------------------------------------------
// MCP Server
// -----------------------------------------------------------------------------

export const McpServerConfigSchema = z.object({
  command: z.string().optional(), // For stdio
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  type: z.enum(["stdio", "http", "streamableHttp", "sse"]).optional(),
  url: z.string().url().optional(), // For http/sse
  headers: z.record(z.string()).optional(),
  toolTtlMs: z.number().int().positive().optional(),
  connectTimeoutMs: z.number().int().positive().optional(),

  // Policy
  mode: ToolModeSchema.optional(),
  allowGlobs: z.array(z.string()).optional(),
  denyGlobs: z.array(z.string()).optional(),
})
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>

export const McpServerStatusSchema = z.object({
  serverId: z.string(),
  transport: z.enum(["stdio", "http", "sse"]),
  connected: z.boolean(),
  lastError: z.string().optional(),
  lastToolRefreshAt: z.string().optional(),
  toolCount: z.number().int().min(0).optional(),
})
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>

// -----------------------------------------------------------------------------
// xAI Agent Tools
// -----------------------------------------------------------------------------

export const XaiAgentToolTypeSchema = z.enum([
  "web_search",
  "x_search",
  "code_execution",
  "collections_search",
  "mcp",
])
export type XaiAgentToolType = z.infer<typeof XaiAgentToolTypeSchema>

export const XaiAgentToolSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("web_search") }),
  z.object({ type: z.literal("x_search") }),
  z.object({ type: z.literal("code_execution") }),
  z.object({ type: z.literal("collections_search") }),
  z.object({
    type: z.literal("mcp"),
    server_label: z.string(),
    server_url: z.string().url(),
    allowed_tools: z.array(z.string()).optional(),
  }),
])
export type XaiAgentTool = z.infer<typeof XaiAgentToolSchema>

export const ToolProviderSchema = z.enum(["xai", "mindos", "both"])
export type ToolProvider = z.infer<typeof ToolProviderSchema>

export const ToolRoutingDecisionSchema = z.object({
  provider: ToolProviderSchema,
  reason: z.string(),
  xaiTool: XaiAgentToolTypeSchema.optional(),
  mindosTool: z.string().optional(),
})
export type ToolRoutingDecision = z.infer<typeof ToolRoutingDecisionSchema>

export const HybridToolResultSchema = z.object({
  provider: ToolProviderSchema,
  xaiContent: z.string().nullable().optional(),
  mindosOutput: JSONSchema.optional(),
  evidenceId: z.string().optional(),
  crossVerified: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  latencyMs: z.number().int().min(0).optional(),
})
export type HybridToolResult = z.infer<typeof HybridToolResultSchema>

// -----------------------------------------------------------------------------
// On-Demand Tool Discovery
// -----------------------------------------------------------------------------

export const ToolRequestBlockSchema = z.object({
  capability: z.string(),
  reason: z.string(),
  priority: z.enum(["high", "medium", "low"]).optional(),
})
export type ToolRequestBlock = z.infer<typeof ToolRequestBlockSchema>

export const ToolDiscoveryOptionsSchema = z.object({
  initialTopK: z.number().int().min(1).max(50).optional(),
  expansionTopK: z.number().int().min(1).max(20).optional(),
  minSimilarity: z.number().min(0).max(1).optional(),
  enableProactive: z.boolean().optional(),
  cacheEnabled: z.boolean().optional(),
})
export type ToolDiscoveryOptions = z.infer<typeof ToolDiscoveryOptionsSchema>

export const ToolDiscoveryModeSchema = z.enum(["initial", "proactive", "expansion", "fallback"])
export type ToolDiscoveryMode = z.infer<typeof ToolDiscoveryModeSchema>

export const ToolDiscoveryStatsSchema = z.object({
  totalDiscovered: z.number().int().min(0),
  estimatedTokensSaved: z.number().int().min(0),
  primaryMode: ToolDiscoveryModeSchema,
})
export type ToolDiscoveryStats = z.infer<typeof ToolDiscoveryStatsSchema>
