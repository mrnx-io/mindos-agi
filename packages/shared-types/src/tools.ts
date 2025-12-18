// =============================================================================
// MindOS - Tool Types
// =============================================================================

import { z } from "zod"
import { UUIDSchema, JSONSchema } from "./schemas.js"

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
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: JSONSchema.optional(),
    score: z.number().optional(),
  })),
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
// Tool Program (LLM-generated code)
// -----------------------------------------------------------------------------

export const ToolProgramSchema = z.object({
  objective: z.string(),
  input: JSONSchema,
  code: z.string(),
  compiler_notes: z.string().optional(),
  verifier_issues: z.array(z.string()).optional(),
})
export type ToolProgram = z.infer<typeof ToolProgramSchema>

export const ToolProgramResultSchema = z.object({
  ok: z.boolean(),
  objective: z.string(),
  toolCandidates: z.array(z.object({
    name: z.string(),
    description: z.string(),
  })),
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
  checks: z.array(z.object({
    check: z.string(),
    passed: z.boolean(),
    details: z.string().optional(),
  })),
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
