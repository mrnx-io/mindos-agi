// =============================================================================
// MindOS - Tool Registry
// =============================================================================

import { query, queryAll, queryOne } from "../db.js"
import { createLogger } from "../logger.js"
import { generateEmbedding, getCachedEmbedding } from "./embeddings.js"

const log = createLogger("tool-registry")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface Tool {
  tool_id: string
  name: string
  description: string
  parameters: Record<string, unknown>
  server_name: string
  risk_level?: "low" | "medium" | "high"
  tags?: string[]
  estimated_duration_ms?: number
  created_at: string
  updated_at: string
}

interface ToolRow {
  tool_id: string
  name: string
  description: string
  parameters: unknown
  server_name: string
  embedding: string | null
  risk_level: string | null
  tags: string[] | null
  estimated_duration_ms: number | null
  call_count: number
  avg_latency_ms: number | null
  success_rate: number | null
  created_at: Date
  updated_at: Date
}

// -----------------------------------------------------------------------------
// Tool CRUD
// -----------------------------------------------------------------------------

export async function registerTool(tool: {
  name: string
  description: string
  parameters: Record<string, unknown>
  serverName: string
  riskLevel?: string
  tags?: string[]
}): Promise<string> {
  // Generate embedding for semantic search
  const embeddingText = `${tool.name}: ${tool.description}`
  const embedding = await generateEmbedding(embeddingText)
  const embeddingStr = `[${embedding.join(",")}]`

  const result = await query<{ tool_id: string }>(
    `INSERT INTO tool_registry (name, description, parameters, server_name, embedding, risk_level, tags)
     VALUES ($1, $2, $3, $4, $5::vector, $6, $7)
     ON CONFLICT (name) DO UPDATE
     SET description = EXCLUDED.description,
         parameters = EXCLUDED.parameters,
         server_name = EXCLUDED.server_name,
         embedding = EXCLUDED.embedding,
         risk_level = EXCLUDED.risk_level,
         tags = EXCLUDED.tags,
         updated_at = NOW()
     RETURNING tool_id`,
    [
      tool.name,
      tool.description,
      JSON.stringify(tool.parameters),
      tool.serverName,
      embeddingStr,
      tool.riskLevel ?? null,
      tool.tags ?? null,
    ]
  )

  log.info({ toolId: result.rows[0].tool_id, name: tool.name }, "Tool registered")
  return result.rows[0].tool_id
}

export async function getTool(name: string): Promise<Tool | null> {
  const row = await queryOne<ToolRow>("SELECT * FROM tool_registry WHERE name = $1", [name])
  return row ? rowToTool(row) : null
}

export async function listTools(serverName?: string): Promise<Tool[]> {
  const condition = serverName ? "WHERE server_name = $1" : ""
  const params = serverName ? [serverName] : []

  const rows = await queryAll<ToolRow>(
    `SELECT * FROM tool_registry ${condition} ORDER BY name`,
    params
  )

  return rows.map(rowToTool)
}

export async function deleteTool(name: string): Promise<boolean> {
  const result = await query("DELETE FROM tool_registry WHERE name = $1", [name])
  return (result.rowCount ?? 0) > 0
}

// -----------------------------------------------------------------------------
// Semantic Search
// -----------------------------------------------------------------------------

export async function searchToolsSemantic(
  queryText: string,
  options: {
    limit?: number
    minSimilarity?: number
    serverName?: string
    tags?: string[]
  } = {}
): Promise<Array<{ tool: Tool; similarity: number }>> {
  const { limit = 10, minSimilarity = 0.3, serverName, tags } = options

  // Get embedding for query
  const queryEmbedding = await getCachedEmbedding(queryText)
  const embeddingStr = `[${queryEmbedding.join(",")}]`

  // Build conditions
  const conditions: string[] = ["embedding IS NOT NULL"]
  const params: unknown[] = [embeddingStr, limit]
  let paramIndex = 3

  if (serverName) {
    conditions.push(`server_name = $${paramIndex++}`)
    params.push(serverName)
  }

  if (tags && tags.length > 0) {
    conditions.push(`tags && $${paramIndex++}`)
    params.push(tags)
  }

  const rows = await queryAll<ToolRow & { similarity: number }>(
    `SELECT *,
            1 - (embedding <=> $1::vector) as similarity
     FROM tool_registry
     WHERE ${conditions.join(" AND ")}
       AND 1 - (embedding <=> $1::vector) >= ${minSimilarity}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    params
  )

  return rows.map((row) => ({
    tool: rowToTool(row),
    similarity: row.similarity,
  }))
}

// -----------------------------------------------------------------------------
// Tool Stats
// -----------------------------------------------------------------------------

export async function recordToolCall(
  toolName: string,
  params: {
    success: boolean
    latencyMs: number
    errorCode?: string
  }
): Promise<void> {
  // Update tool stats
  await query(
    `UPDATE tool_registry
     SET call_count = call_count + 1,
         avg_latency_ms = CASE
           WHEN avg_latency_ms IS NULL THEN $2
           ELSE (avg_latency_ms * (call_count - 1) + $2) / call_count
         END,
         success_rate = CASE
           WHEN success_rate IS NULL THEN $3::numeric
           ELSE (success_rate * (call_count - 1) + $3::numeric) / call_count
         END,
         updated_at = NOW()
     WHERE name = $1`,
    [toolName, params.latencyMs, params.success ? 1 : 0]
  )

  // Log the call
  await query(
    `INSERT INTO tool_call_log (tool_name, success, latency_ms, error_code)
     VALUES ($1, $2, $3, $4)`,
    [toolName, params.success, params.latencyMs, params.errorCode ?? null]
  )
}

export async function getToolStats(toolName: string): Promise<{
  callCount: number
  avgLatencyMs: number | null
  successRate: number | null
  recentErrors: string[]
}> {
  const tool = await queryOne<ToolRow>("SELECT * FROM tool_registry WHERE name = $1", [toolName])

  if (!tool) {
    throw new Error(`Tool not found: ${toolName}`)
  }

  // Get recent errors
  const errors = await queryAll<{ error_code: string }>(
    `SELECT DISTINCT error_code
     FROM tool_call_log
     WHERE tool_name = $1 AND success = false AND error_code IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 5`,
    [toolName]
  )

  return {
    callCount: tool.call_count,
    avgLatencyMs: tool.avg_latency_ms,
    successRate: tool.success_rate,
    recentErrors: errors.map((e) => e.error_code),
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function rowToTool(row: ToolRow): Tool {
  return {
    tool_id: row.tool_id,
    name: row.name,
    description: row.description,
    parameters: row.parameters as Record<string, unknown>,
    server_name: row.server_name,
    risk_level: row.risk_level as Tool["risk_level"],
    tags: row.tags ?? undefined,
    estimated_duration_ms: row.estimated_duration_ms ?? undefined,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}
