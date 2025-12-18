// =============================================================================
// MindOS - ToolMesh Client
// =============================================================================

import { request } from "undici"
import { env } from "../config.js"
import { createLogger } from "../logger.js"
import type { Tool, ToolCallRequest, ToolCallResult, ToolSearchRequest } from "../types.js"

const log = createLogger("toolmesh-client")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface ToolMeshResponse<T> {
  success: boolean
  data?: T
  error?: string
}

export interface RequestContext {
  correlationId?: string
  identityId?: string
}

// -----------------------------------------------------------------------------
// HTTP Client
// -----------------------------------------------------------------------------

async function toolmeshRequest<T>(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
  context?: RequestContext
): Promise<T> {
  const url = `${env.TOOLMESH_URL}${path}`

  // Build headers with authentication and context propagation
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  }

  // Add authorization header if token is configured
  if (env.TOOLMESH_TOKEN) {
    headers.Authorization = `Bearer ${env.TOOLMESH_TOKEN}`
  }

  // Add correlation ID for distributed tracing
  if (context?.correlationId) {
    headers["x-correlation-id"] = context.correlationId
  }

  // Add identity context
  if (context?.identityId) {
    headers["x-identity-id"] = context.identityId
  }

  try {
    // Build request options conditionally to satisfy exactOptionalPropertyTypes
    const requestOptions: Parameters<typeof request>[1] = {
      method,
      headers,
    }
    if (body) {
      requestOptions.body = JSON.stringify(body)
    }
    const response = await request(url, requestOptions)

    const data = (await response.body.json()) as ToolMeshResponse<T>

    if (!data.success) {
      throw new Error(data.error || "ToolMesh request failed")
    }

    return data.data as T
  } catch (err) {
    log.error({ url, error: err }, "ToolMesh request failed")
    throw err
  }
}

// -----------------------------------------------------------------------------
// Tool Discovery
// -----------------------------------------------------------------------------

export async function listTools(): Promise<Tool[]> {
  return toolmeshRequest<Tool[]>("/tools")
}

export async function getTool(toolName: string): Promise<Tool | null> {
  try {
    return await toolmeshRequest<Tool>(`/tools/${encodeURIComponent(toolName)}`)
  } catch {
    return null
  }
}

export async function searchTools(request: ToolSearchRequest): Promise<Tool[]> {
  return toolmeshRequest<Tool[]>("/tools/search", "POST", request)
}

export async function findToolByIntent(
  intent: string,
  limit = 5,
  context?: RequestContext
): Promise<Array<{ tool: Tool; similarity: number }>> {
  return toolmeshRequest<Array<{ tool: Tool; similarity: number }>>(
    "/tools/search/semantic",
    "POST",
    { query: intent, limit },
    context
  )
}

/**
 * Discover tools for multiple intents in parallel.
 * Useful for batch discovery when the planner identifies multiple action areas.
 */
export async function findToolsByIntents(
  intents: string[],
  limitPerIntent = 3,
  context?: RequestContext
): Promise<Map<string, Array<{ tool: Tool; similarity: number }>>> {
  const results = new Map<string, Array<{ tool: Tool; similarity: number }>>()

  if (intents.length === 0) return results

  // Parallel execution for efficiency
  const promises = intents.map(async (intent) => {
    try {
      const tools = await findToolByIntent(intent, limitPerIntent, context)
      return { intent, tools, success: true as const }
    } catch (error) {
      log.warn({ intent, error }, "Batch intent search failed")
      return { intent, tools: [], success: false as const }
    }
  })

  const resolved = await Promise.all(promises)
  for (const { intent, tools } of resolved) {
    results.set(intent, tools)
  }

  return results
}

// -----------------------------------------------------------------------------
// Tool Execution
// -----------------------------------------------------------------------------

export async function callTool(
  request: ToolCallRequest,
  context?: RequestContext
): Promise<ToolCallResult> {
  const start = Date.now()

  log.info(
    { tool: request.toolName, idempotencyKey: request.idempotencyKey },
    "Calling tool via ToolMesh"
  )

  const result = await toolmeshRequest<ToolCallResult>("/tools/call", "POST", request, context)

  log.info(
    {
      tool: request.toolName,
      success: result.ok,
      duration_ms: Date.now() - start,
    },
    "Tool call completed"
  )

  return result
}

export async function callToolWithRetry(
  request: ToolCallRequest,
  maxRetries = 3,
  context?: RequestContext
): Promise<ToolCallResult> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await callTool(request, context)
      return result
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      log.warn(
        { tool: request.toolName, attempt, error: lastError.message },
        "Tool call failed, retrying"
      )

      // Exponential backoff
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 100))
      }
    }
  }

  throw lastError
}

// -----------------------------------------------------------------------------
// Idempotent Execution
// -----------------------------------------------------------------------------

export async function callToolIdempotent(
  toolNameParam: string,
  parameters: Record<string, unknown>,
  idempotencyKeyParam: string,
  _identityId: string
): Promise<ToolCallResult> {
  // First check if we have a cached result for this key
  const cached = await toolmeshRequest<ToolCallResult | null>(
    `/tools/calls/${encodeURIComponent(idempotencyKeyParam)}`,
    "GET"
  )

  if (cached) {
    log.info(
      { toolName: toolNameParam, idempotencyKey: idempotencyKeyParam },
      "Returning cached tool result"
    )
    return cached
  }

  // Execute the call
  return callTool({
    toolName: toolNameParam,
    arguments: parameters,
    idempotencyKey: idempotencyKeyParam,
  })
}

// -----------------------------------------------------------------------------
// Tool Status
// -----------------------------------------------------------------------------

export async function getToolStatus(toolName: string): Promise<{
  available: boolean
  healthy: boolean
  lastCheck: string
  recentFailures: number
}> {
  return toolmeshRequest(`/tools/${encodeURIComponent(toolName)}/status`)
}

export async function checkToolMeshHealth(): Promise<boolean> {
  try {
    await toolmeshRequest("/health")
    return true
  } catch {
    return false
  }
}

// -----------------------------------------------------------------------------
// Tool Registry Management
// -----------------------------------------------------------------------------

export async function refreshToolRegistry(): Promise<{ added: number; removed: number }> {
  return toolmeshRequest("/tools/refresh", "POST")
}

export async function getRegistryStats(): Promise<{
  totalTools: number
  activeServers: number
  callsToday: number
  avgLatencyMs: number
}> {
  return toolmeshRequest("/tools/stats")
}
