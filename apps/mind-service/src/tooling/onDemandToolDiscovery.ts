// =============================================================================
// MindOS - On-Demand Tool Discovery (Hybrid Loading Strategy)
// =============================================================================
//
// Implements three discovery modes:
// 1. Initial Discovery - Semantic search on task goal (replaces listTools())
// 2. Proactive Discovery - LLM emits <tool_request> blocks for new capabilities
// 3. On-Demand Expansion - Dynamic tool lookup during action execution
//
// Achieves 60-85% token reduction compared to loading all tools upfront.
// =============================================================================

import { env } from "../config.js"
import { createLogger } from "../logger.js"
import type { Tool, ToolDiscoveryOptions, ToolDiscoveryStats, ToolRequestBlock } from "../types.js"
import {
  type RequestContext,
  findToolByIntent,
  listTools as listAllTools,
} from "./toolmeshClient.js"

const log = createLogger("on-demand-tools")

// Re-export types for backwards compatibility
export type { ToolDiscoveryOptions, ToolRequestBlock, ToolDiscoveryStats }

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Resolved options with guaranteed non-undefined values */
export interface ResolvedToolDiscoveryOptions {
  initialTopK: number
  expansionTopK: number
  minSimilarity: number
  enableProactive: boolean
  cacheEnabled: boolean
}

export interface ToolDiscoveryContext {
  /** Map of discovered tools by name */
  discoveredTools: Map<string, Tool>
  /** Set of pending capability requests to prevent duplicates */
  pendingRequests: Set<string>
  /** Original task goal for context */
  taskGoal: string
  /** Resolved options with defaults */
  options: ResolvedToolDiscoveryOptions
  /** Request context for tracing */
  requestContext?: RequestContext
}

// -----------------------------------------------------------------------------
// Default Configuration
// -----------------------------------------------------------------------------

const DEFAULT_OPTIONS: Required<ToolDiscoveryOptions> = {
  initialTopK: 8,
  expansionTopK: 5,
  minSimilarity: 0.4,
  enableProactive: true,
  cacheEnabled: true,
}

// Estimated tokens per tool (name + description + parameters schema)
const AVG_TOKENS_PER_TOOL = 200
// Estimated size of medium tool registry
const ESTIMATED_REGISTRY_SIZE = 50

// -----------------------------------------------------------------------------
// Discovery Context Management
// -----------------------------------------------------------------------------

/**
 * Create a new discovery context for a task.
 * The context tracks discovered tools and prevents duplicate discovery requests.
 */
export function createDiscoveryContext(
  taskGoal: string,
  options: ToolDiscoveryOptions = {},
  requestContext?: RequestContext
): ToolDiscoveryContext {
  const resolvedOptions: ResolvedToolDiscoveryOptions = {
    initialTopK: options.initialTopK ?? env.TOOL_DISCOVERY_INITIAL_K ?? DEFAULT_OPTIONS.initialTopK,
    expansionTopK:
      options.expansionTopK ?? env.TOOL_DISCOVERY_EXPANSION_K ?? DEFAULT_OPTIONS.expansionTopK,
    minSimilarity:
      options.minSimilarity ?? env.TOOL_DISCOVERY_MIN_SIMILARITY ?? DEFAULT_OPTIONS.minSimilarity,
    enableProactive:
      options.enableProactive ??
      env.ENABLE_PROACTIVE_TOOL_DISCOVERY ??
      DEFAULT_OPTIONS.enableProactive,
    cacheEnabled: options.cacheEnabled ?? true,
  }

  // Build context object, only including requestContext if it's defined
  // to satisfy exactOptionalPropertyTypes
  const context: ToolDiscoveryContext = {
    discoveredTools: new Map(),
    pendingRequests: new Set(),
    taskGoal,
    options: resolvedOptions,
  }
  if (requestContext) {
    context.requestContext = requestContext
  }
  return context
}

// -----------------------------------------------------------------------------
// Initial Discovery (replaces listTools())
// -----------------------------------------------------------------------------

/**
 * Discover initial tools based on the task goal using semantic search.
 * This replaces the upfront listTools() call that loaded ALL tools.
 */
export async function discoverInitialTools(ctx: ToolDiscoveryContext): Promise<Tool[]> {
  const { taskGoal, options } = ctx

  // Check if on-demand discovery is disabled
  if (!env.ENABLE_ON_DEMAND_TOOLS) {
    log.info("On-demand discovery disabled, falling back to full tool list")
    return discoverAllTools(ctx)
  }

  log.info(
    { goal: taskGoal.slice(0, 100), topK: options.initialTopK },
    "Starting initial tool discovery"
  )

  try {
    // Semantic search based on task goal
    const results = await findToolByIntent(taskGoal, options.initialTopK)

    // Filter by similarity threshold and cache
    const tools: Tool[] = []
    for (const { tool, similarity } of results) {
      if (similarity >= options.minSimilarity) {
        ctx.discoveredTools.set(tool.tool_name, tool)
        tools.push(tool)
        log.debug({ tool: tool.tool_name, similarity: similarity.toFixed(3) }, "Discovered tool")
      }
    }

    log.info(
      {
        discovered: tools.length,
        cached: ctx.discoveredTools.size,
        goal: taskGoal.slice(0, 50),
      },
      "Initial discovery complete"
    )

    return tools
  } catch (error) {
    log.error({ error }, "Initial discovery failed, falling back to full list")
    return discoverAllTools(ctx)
  }
}

// -----------------------------------------------------------------------------
// Proactive Discovery (MCP-Zero Pattern)
// -----------------------------------------------------------------------------

/**
 * Regex pattern to extract <tool_request> blocks from LLM responses.
 * Matches JSON objects within the tags.
 */
const TOOL_REQUEST_PATTERN = /<tool_request>\s*({[\s\S]*?})\s*<\/tool_request>/g

/**
 * Parse <tool_request> blocks from an LLM response.
 * Returns an array of capability requests that can be used for discovery.
 */
export function parseToolRequests(llmResponse: string): ToolRequestBlock[] {
  if (!llmResponse) return []

  const requests: ToolRequestBlock[] = []
  const matches = llmResponse.matchAll(TOOL_REQUEST_PATTERN)

  for (const match of matches) {
    const request = parseToolRequestMatch(match)
    if (request) {
      requests.push(request)
    }
  }

  if (requests.length > 0) {
    log.info({ count: requests.length }, "Parsed tool request blocks")
  }

  return requests
}

/**
 * Parse a single tool request match from regex.
 * Returns null if parsing fails or data is invalid.
 */
function parseToolRequestMatch(match: RegExpMatchArray): ToolRequestBlock | null {
  const jsonStr = match[1]
  if (!jsonStr) return null

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>
    return buildToolRequestBlock(parsed)
  } catch (_e) {
    log.warn({ raw: jsonStr.slice(0, 100) }, "Failed to parse tool request block")
    return null
  }
}

/**
 * Build a validated ToolRequestBlock from parsed JSON.
 * Returns null if required fields are missing or invalid.
 */
function buildToolRequestBlock(parsed: Record<string, unknown>): ToolRequestBlock | null {
  if (typeof parsed.capability !== "string" || parsed.capability.length === 0) {
    return null
  }

  return {
    capability: parsed.capability,
    reason: typeof parsed.reason === "string" ? parsed.reason : "LLM requested",
    priority: isValidPriority(parsed.priority) ? parsed.priority : "medium",
  }
}

function isValidPriority(value: unknown): value is "high" | "medium" | "low" {
  return value === "high" || value === "medium" || value === "low"
}

/**
 * Handle proactive tool discovery based on LLM-emitted <tool_request> blocks.
 * This implements the MCP-Zero pattern where the LLM requests capabilities mid-conversation.
 */
export async function handleProactiveDiscovery(
  ctx: ToolDiscoveryContext,
  requests: ToolRequestBlock[]
): Promise<Tool[]> {
  if (!ctx.options.enableProactive || requests.length === 0) {
    return []
  }

  log.info({ requestCount: requests.length }, "Processing proactive tool requests")

  const newTools: Tool[] = []

  // Sort by priority (high first)
  const sortedRequests = [...requests].sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 }
    return priorityOrder[a.priority ?? "medium"] - priorityOrder[b.priority ?? "medium"]
  })

  for (const request of sortedRequests) {
    // Skip if already discovered or pending
    const normalizedCapability = request.capability.toLowerCase().trim()
    if (ctx.pendingRequests.has(normalizedCapability)) {
      continue
    }

    ctx.pendingRequests.add(normalizedCapability)

    try {
      // Search for matching tools
      const results = await findToolByIntent(request.capability, ctx.options.expansionTopK)

      for (const { tool, similarity } of results) {
        if (similarity >= ctx.options.minSimilarity && !ctx.discoveredTools.has(tool.tool_name)) {
          ctx.discoveredTools.set(tool.tool_name, tool)
          newTools.push(tool)
          log.debug(
            {
              tool: tool.tool_name,
              similarity: similarity.toFixed(3),
              capability: request.capability.slice(0, 50),
            },
            "Proactively discovered tool"
          )
        }
      }
    } catch (error) {
      log.warn(
        { capability: request.capability, error },
        "Proactive discovery failed for capability"
      )
    } finally {
      ctx.pendingRequests.delete(normalizedCapability)
    }
  }

  if (newTools.length > 0) {
    log.info({ newTools: newTools.map((t) => t.tool_name) }, "Proactive discovery added tools")
  }

  return newTools
}

// -----------------------------------------------------------------------------
// On-Demand Expansion (Mid-Execution)
// -----------------------------------------------------------------------------

/**
 * Expand the tool context when an action references a tool not yet discovered.
 * This provides a safety net for tools missed during initial/proactive discovery.
 */
export async function expandToolContext(
  ctx: ToolDiscoveryContext,
  intent: string
): Promise<Tool[]> {
  log.debug({ intent: intent.slice(0, 50) }, "On-demand tool expansion")

  try {
    const results = await findToolByIntent(intent, ctx.options.expansionTopK)
    const newTools: Tool[] = []

    for (const { tool, similarity } of results) {
      if (similarity >= ctx.options.minSimilarity && !ctx.discoveredTools.has(tool.tool_name)) {
        ctx.discoveredTools.set(tool.tool_name, tool)
        newTools.push(tool)
      }
    }

    if (newTools.length > 0) {
      log.info(
        { newTools: newTools.map((t) => t.tool_name), intent: intent.slice(0, 30) },
        "Expansion discovered tools"
      )
    }

    return newTools
  } catch (error) {
    log.warn({ intent, error }, "Tool expansion failed")
    return []
  }
}

/**
 * Try to find a specific tool by exact name match.
 * Falls back to semantic search if not already discovered.
 */
export async function ensureToolDiscovered(
  ctx: ToolDiscoveryContext,
  toolName: string
): Promise<Tool | null> {
  // Check if already discovered
  const existing = ctx.discoveredTools.get(toolName)
  if (existing) {
    return existing
  }

  // Try semantic search with the tool name
  const expanded = await expandToolContext(ctx, toolName)
  const found = expanded.find((t) => t.tool_name === toolName)

  if (found) {
    return found
  }

  // Tool not found even after expansion
  log.warn({ toolName }, "Tool not found via on-demand discovery")
  return null
}

// -----------------------------------------------------------------------------
// Tool Context Formatting
// -----------------------------------------------------------------------------

/**
 * Get all discovered tools as an array for use in prompts.
 */
export function formatToolsForContext(ctx: ToolDiscoveryContext): Tool[] {
  return Array.from(ctx.discoveredTools.values())
}

/**
 * Get discovery statistics for logging and monitoring.
 */
export function getDiscoveryStats(ctx: ToolDiscoveryContext): ToolDiscoveryStats {
  const totalDiscovered = ctx.discoveredTools.size
  const estimatedTokensSaved = Math.max(
    0,
    (ESTIMATED_REGISTRY_SIZE - totalDiscovered) * AVG_TOKENS_PER_TOOL
  )

  // Determine primary discovery mode (rough heuristic)
  let primaryMode: ToolDiscoveryStats["primaryMode"] = "initial"
  if (totalDiscovered === 0) {
    primaryMode = "fallback"
  } else if (totalDiscovered > ctx.options.initialTopK) {
    primaryMode = "proactive"
  }

  return {
    totalDiscovered,
    estimatedTokensSaved,
    primaryMode,
  }
}

// -----------------------------------------------------------------------------
// Fallback: Full Tool List (for edge cases)
// -----------------------------------------------------------------------------

/**
 * Fallback to loading all tools when on-demand discovery fails or is disabled.
 * This ensures the system remains functional even if semantic search is unavailable.
 */
export async function discoverAllTools(ctx: ToolDiscoveryContext): Promise<Tool[]> {
  log.warn("Falling back to full tool list discovery")

  try {
    const allTools = await listAllTools()

    for (const tool of allTools) {
      ctx.discoveredTools.set(tool.tool_name, tool)
    }

    log.info({ totalTools: allTools.length }, "Full tool list loaded")
    return allTools
  } catch (error) {
    log.error({ error }, "Failed to load full tool list")
    return []
  }
}

// -----------------------------------------------------------------------------
// Batch Discovery (for multiple intents)
// -----------------------------------------------------------------------------

/**
 * Discover tools for multiple intents in parallel.
 * Useful when the planner identifies multiple action areas upfront.
 */
export async function discoverToolsForIntents(
  ctx: ToolDiscoveryContext,
  intents: string[],
  limitPerIntent = 3
): Promise<Tool[]> {
  if (intents.length === 0) return []

  log.info({ intentCount: intents.length }, "Batch tool discovery")

  const allNewTools: Tool[] = []

  // Execute in parallel
  const results = await Promise.allSettled(
    intents.map(async (intent) => {
      const tools = await findToolByIntent(intent, limitPerIntent)
      return { intent, tools }
    })
  )

  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const { tool, similarity } of result.value.tools) {
        if (similarity >= ctx.options.minSimilarity && !ctx.discoveredTools.has(tool.tool_name)) {
          ctx.discoveredTools.set(tool.tool_name, tool)
          allNewTools.push(tool)
        }
      }
    }
  }

  if (allNewTools.length > 0) {
    log.info({ newTools: allNewTools.length, intents: intents.length }, "Batch discovery complete")
  }

  return allNewTools
}
