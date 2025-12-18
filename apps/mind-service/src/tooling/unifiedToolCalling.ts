import { createLogger } from "../logger.js"

const log = createLogger("unified-tool-calling")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type UnifiedProvider = "openai" | "anthropic" | "google" | "xai" | "toolmesh"
export type ToolSource = "function_call" | "server_tool" | "mcp"

export interface UnifiedToolCall {
  id: string
  name: string
  parameters: Record<string, unknown>
  source: ToolSource
  provider: UnifiedProvider
  raw?: unknown // Original provider-specific format
}

export interface UnifiedToolResult {
  tool_call_id: string
  success: boolean
  output: unknown
  error?: string
  provider: UnifiedProvider
  latency_ms: number
  evidence_id?: string
}

export interface UnifiedToolDefinition {
  name: string
  description: string
  parameters: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
  }
}

// Provider-specific response types
export interface OpenAIToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string // JSON string
  }
}

export interface AnthropicToolUse {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface GeminiFunctionCall {
  name: string
  args: Record<string, unknown>
}

export interface XAIToolExecution {
  tool_name: string
  tool_call_id: string
  result: unknown
  status: "success" | "error"
}

// -----------------------------------------------------------------------------
// Tool Format Converters
// -----------------------------------------------------------------------------

/**
 * Convert unified tool definition to OpenAI format (GPT-5.2)
 */
export function toOpenAITool(tool: UnifiedToolDefinition): {
  type: "function"
  function: { name: string; description: string; parameters: Record<string, unknown> }
} {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

/**
 * Convert unified tool definition to Anthropic format (Claude Opus 4.5)
 */
export function toAnthropicTool(tool: UnifiedToolDefinition): {
  name: string
  description: string
  input_schema: Record<string, unknown>
} {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }
}

/**
 * Convert unified tool definition to Google/Gemini format (Gemini 3 Pro)
 */
export function toGeminiTool(tool: UnifiedToolDefinition): {
  name: string
  description: string
  parametersJsonSchema: Record<string, unknown>
} {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.parameters,
  }
}

/**
 * Convert unified tool definition to xAI format (Grok 4.1)
 * Note: xAI uses server-side tool execution for its native tools
 */
export function toXAITool(tool: UnifiedToolDefinition): {
  name: string
  description: string
  parameters: Record<string, unknown>
} {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }
}

// -----------------------------------------------------------------------------
// Tool Call Normalizers
// -----------------------------------------------------------------------------

/**
 * Extract and normalize tool calls from OpenAI response (GPT-5.2)
 * Handles parallel tool calling
 */
export function normalizeOpenAIToolCalls(
  toolCalls: OpenAIToolCall[] | undefined
): UnifiedToolCall[] {
  if (!toolCalls) return []

  return toolCalls.map((tc) => {
    let parameters: Record<string, unknown> = {}
    try {
      parameters = JSON.parse(tc.function.arguments)
    } catch {
      log.warn({ toolCallId: tc.id }, "Failed to parse OpenAI tool call arguments")
    }

    return {
      id: tc.id,
      name: tc.function.name,
      parameters,
      source: "function_call" as const,
      provider: "openai" as const,
      raw: tc,
    }
  })
}

/**
 * Extract and normalize tool calls from Anthropic response (Claude Opus 4.5)
 */
export function normalizeAnthropicToolCalls(
  content: Array<{ type: string } & Record<string, unknown>> | undefined
): UnifiedToolCall[] {
  if (!content) return []

  return content
    .filter((block) => block.type === "tool_use")
    .map((tu) => {
      const toolUse = tu as unknown as AnthropicToolUse
      return {
        id: toolUse.id,
        name: toolUse.name,
        parameters: toolUse.input,
        source: "function_call" as const,
        provider: "anthropic" as const,
        raw: toolUse,
      }
    })
}

/**
 * Extract and normalize tool calls from Google/Gemini response (Gemini 3 Pro)
 */
export function normalizeGeminiToolCalls(
  functionCalls: GeminiFunctionCall[] | undefined
): UnifiedToolCall[] {
  if (!functionCalls) return []

  return functionCalls.map((fc, index) => ({
    id: `gemini-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 10)}`,
    name: fc.name,
    parameters: fc.args,
    source: "function_call" as const,
    provider: "google" as const,
    raw: fc,
  }))
}

/**
 * Extract and normalize tool executions from xAI response (Grok 4.1)
 * Note: xAI executes tools server-side and returns results directly
 */
export function normalizeXAIToolExecutions(
  executions: XAIToolExecution[] | undefined
): UnifiedToolResult[] {
  if (!executions) return []

  return executions.map((exec) => ({
    tool_call_id: exec.tool_call_id,
    success: exec.status === "success",
    output: exec.result,
    ...(exec.status === "error" && { error: String(exec.result) }),
    provider: "xai" as const,
    latency_ms: 0, // Server-side execution, latency unknown
  }))
}

// -----------------------------------------------------------------------------
// Unified Tool Call Executor
// -----------------------------------------------------------------------------

export interface ExecuteUnifiedToolCallOptions {
  toolCall: UnifiedToolCall
  identityId?: string
  context?: {
    taskId?: string
    stepId?: string
  }
  handlers: ToolHandlers
}

export interface ToolHandlers {
  executeToolmesh: (name: string, params: Record<string, unknown>) => Promise<unknown>
  executeXAI?: (name: string, params: Record<string, unknown>) => Promise<unknown>
  executeCustom?: (name: string, params: Record<string, unknown>) => Promise<unknown>
}

/**
 * Execute a unified tool call through the appropriate backend
 */
export async function executeUnifiedToolCall(
  options: ExecuteUnifiedToolCallOptions
): Promise<UnifiedToolResult> {
  const { toolCall, handlers } = options
  const start = Date.now()

  log.debug({ toolName: toolCall.name, provider: toolCall.provider }, "Executing unified tool call")

  try {
    let output: unknown

    // Route to appropriate handler based on source
    switch (toolCall.source) {
      case "server_tool": {
        // xAI server-side tools (already executed)
        if (handlers.executeXAI) {
          output = await handlers.executeXAI(toolCall.name, toolCall.parameters)
        } else {
          throw new Error("xAI handler not configured")
        }
        break
      }

      case "mcp": {
        // MCP tools go through ToolMesh
        output = await handlers.executeToolmesh(toolCall.name, toolCall.parameters)
        break
      }
      default: {
        // Standard function calls - route based on tool name
        if (isXAINativeTool(toolCall.name) && handlers.executeXAI) {
          output = await handlers.executeXAI(toolCall.name, toolCall.parameters)
        } else if (handlers.executeCustom && isCustomTool(toolCall.name)) {
          output = await handlers.executeCustom(toolCall.name, toolCall.parameters)
        } else {
          output = await handlers.executeToolmesh(toolCall.name, toolCall.parameters)
        }
        break
      }
    }

    return {
      tool_call_id: toolCall.id,
      success: true,
      output,
      provider: toolCall.provider,
      latency_ms: Date.now() - start,
    }
  } catch (error) {
    log.error({ toolName: toolCall.name, error }, "Tool execution failed")

    return {
      tool_call_id: toolCall.id,
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      provider: toolCall.provider,
      latency_ms: Date.now() - start,
    }
  }
}

// -----------------------------------------------------------------------------
// Tool Result Formatters
// -----------------------------------------------------------------------------

/**
 * Format tool result for OpenAI (GPT-5.2)
 */
export function formatOpenAIToolResult(result: UnifiedToolResult): {
  role: "tool"
  tool_call_id: string
  content: string
} {
  return {
    role: "tool",
    tool_call_id: result.tool_call_id,
    content: result.success
      ? JSON.stringify(result.output)
      : JSON.stringify({ error: result.error }),
  }
}

/**
 * Format tool result for Anthropic (Claude Opus 4.5)
 */
export function formatAnthropicToolResult(result: UnifiedToolResult): {
  type: "tool_result"
  tool_use_id: string
  content: string
  is_error?: boolean
} {
  return {
    type: "tool_result",
    tool_use_id: result.tool_call_id,
    content: result.success
      ? JSON.stringify(result.output)
      : JSON.stringify({ error: result.error }),
    is_error: !result.success,
  }
}

/**
 * Format tool result for Google/Gemini (Gemini 3 Pro)
 */
export function formatGeminiToolResult(result: UnifiedToolResult): {
  functionResponse: {
    name: string
    response: Record<string, unknown>
  }
} {
  return {
    functionResponse: {
      name: result.tool_call_id.split("-")[0] ?? "unknown", // Extract name from ID
      response: result.success ? { result: result.output } : { error: result.error },
    },
  }
}

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

const XAI_NATIVE_TOOLS = new Set(["web_search", "x_search", "code_execution", "collections_search"])

function isXAINativeTool(toolName: string): boolean {
  return XAI_NATIVE_TOOLS.has(toolName)
}

function isCustomTool(toolName: string): boolean {
  // Custom tools are defined by the application
  return toolName.startsWith("custom_") || toolName.startsWith("mindos_")
}

// -----------------------------------------------------------------------------
// Batch Tool Call Processing
// -----------------------------------------------------------------------------

/**
 * Process multiple tool calls in parallel (for GPT-5.2 parallel tool calling)
 */
export async function executeBatchToolCalls(
  toolCalls: UnifiedToolCall[],
  handlers: ToolHandlers,
  options?: { identityId?: string; concurrency?: number }
): Promise<UnifiedToolResult[]> {
  const concurrency = options?.concurrency ?? 5
  const results: UnifiedToolResult[] = []

  // Process in batches to respect concurrency limit
  for (let i = 0; i < toolCalls.length; i += concurrency) {
    const batch = toolCalls.slice(i, i + concurrency)

    const batchResults = await Promise.all(
      batch.map((toolCall) =>
        executeUnifiedToolCall({
          toolCall,
          ...(options?.identityId && { identityId: options.identityId }),
          handlers,
        })
      )
    )

    results.push(...batchResults)
  }

  return results
}

// -----------------------------------------------------------------------------
// Tool Definition Aggregation
// -----------------------------------------------------------------------------

/**
 * Merge tool definitions from multiple sources
 */
export function mergeToolDefinitions(
  ...toolSets: UnifiedToolDefinition[][]
): UnifiedToolDefinition[] {
  const merged = new Map<string, UnifiedToolDefinition>()

  for (const toolSet of toolSets) {
    for (const tool of toolSet) {
      // Later definitions override earlier ones
      merged.set(tool.name, tool)
    }
  }

  return Array.from(merged.values())
}

/**
 * Filter tools based on provider capabilities
 */
export function filterToolsForProvider(
  tools: UnifiedToolDefinition[],
  provider: UnifiedProvider
): UnifiedToolDefinition[] {
  return tools.filter((tool) => {
    // xAI has native versions of certain tools
    if (provider === "xai" && isXAINativeTool(tool.name)) {
      return false // Use native xAI version instead
    }

    return true
  })
}

// -----------------------------------------------------------------------------
// Cross-Provider Tool Compatibility
// -----------------------------------------------------------------------------

/**
 * Check if a tool is compatible with a specific provider
 */
export function isToolCompatible(tool: UnifiedToolDefinition, provider: UnifiedProvider): boolean {
  // All providers support basic function calling
  if (provider === "toolmesh") return true

  // xAI has restrictions on parameter types for native tools
  if (provider === "xai" && isXAINativeTool(tool.name)) {
    return true
  }

  // Check parameter schema compatibility
  const params = tool.parameters.properties ?? {}
  for (const param of Object.values(params)) {
    const paramType = (param as Record<string, unknown>).type

    // Anthropic doesn't support certain complex types
    if (provider === "anthropic" && paramType === "function") {
      return false
    }
  }

  return true
}

/**
 * Get the best provider for a specific tool
 */
export function getBestProviderForTool(
  toolName: string,
  availableProviders: UnifiedProvider[]
): UnifiedProvider {
  // xAI native tools
  if (isXAINativeTool(toolName) && availableProviders.includes("xai")) {
    return "xai"
  }

  // Default to ToolMesh for everything else
  if (availableProviders.includes("toolmesh")) {
    return "toolmesh"
  }

  // Fallback to first available
  return availableProviders[0] ?? "toolmesh"
}
