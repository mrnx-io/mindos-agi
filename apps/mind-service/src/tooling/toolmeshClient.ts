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

// -----------------------------------------------------------------------------
// HTTP Client
// -----------------------------------------------------------------------------

async function toolmeshRequest<T>(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown
): Promise<T> {
  const url = `${env.TOOLMESH_URL}${path}`

  try {
    const response = await request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })

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
  limit = 5
): Promise<Array<{ tool: Tool; similarity: number }>> {
  return toolmeshRequest<Array<{ tool: Tool; similarity: number }>>(
    "/tools/search/semantic",
    "POST",
    { query: intent, limit }
  )
}

// -----------------------------------------------------------------------------
// Tool Execution
// -----------------------------------------------------------------------------

export async function callTool(request: ToolCallRequest): Promise<ToolCallResult> {
  const start = Date.now()

  log.info(
    { tool: request.tool_name, idempotencyKey: request.idempotency_key },
    "Calling tool via ToolMesh"
  )

  const result = await toolmeshRequest<ToolCallResult>("/tools/call", "POST", request)

  log.info(
    {
      tool: request.tool_name,
      success: result.success,
      duration_ms: Date.now() - start,
    },
    "Tool call completed"
  )

  return result
}

export async function callToolWithRetry(
  request: ToolCallRequest,
  maxRetries = 3
): Promise<ToolCallResult> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await callTool(request)
      return result
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      log.warn(
        { tool: request.tool_name, attempt, error: lastError.message },
        "Tool call failed, retrying"
      )

      // Exponential backoff
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 100))
      }
    }
  }

  throw lastError
}

// -----------------------------------------------------------------------------
// Idempotent Execution
// -----------------------------------------------------------------------------

export async function callToolIdempotent(
  toolName: string,
  parameters: Record<string, unknown>,
  idempotencyKey: string,
  identityId: string
): Promise<ToolCallResult> {
  // First check if we have a cached result for this key
  const cached = await toolmeshRequest<ToolCallResult | null>(
    `/tools/calls/${encodeURIComponent(idempotencyKey)}`,
    "GET"
  )

  if (cached) {
    log.info({ toolName, idempotencyKey }, "Returning cached tool result")
    return cached
  }

  // Execute the call
  return callTool({
    tool_name: toolName,
    parameters,
    idempotency_key: idempotencyKey,
    identity_id: identityId,
    timeout_ms: 30000,
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
