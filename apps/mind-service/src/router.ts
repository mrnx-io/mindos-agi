// =============================================================================
// MindOS - Multi-Model Router
// =============================================================================

import Anthropic from "@anthropic-ai/sdk"
import { GoogleGenerativeAI } from "@google/generative-ai"
import OpenAI from "openai"
import {
  type ModelConfig,
  env,
  getModelConfig,
  isCircuitOpen,
  modelChain,
  recordFailure,
  recordSuccess,
} from "./config.js"
import { createLogger } from "./logger.js"
import type { XaiAgentTool, XaiAgentToolType } from "./types.js"

// Re-export xAI types for backwards compatibility
export type { XaiAgentTool, XaiAgentToolType }

const log = createLogger("router")

// -----------------------------------------------------------------------------
// Client Initialization
// -----------------------------------------------------------------------------

let openaiClient: OpenAI | null = null
let anthropicClient: Anthropic | null = null
let googleClient: GoogleGenerativeAI | null = null
let xaiClient: OpenAI | null = null

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    if (!env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY not configured")
    }
    openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY })
  }
  return openaiClient
}

function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY not configured")
    }
    anthropicClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  }
  return anthropicClient
}

function getGoogle(): GoogleGenerativeAI {
  if (!googleClient) {
    if (!env.GOOGLE_AI_API_KEY) {
      throw new Error("GOOGLE_AI_API_KEY not configured")
    }
    googleClient = new GoogleGenerativeAI(env.GOOGLE_AI_API_KEY)
  }
  return googleClient
}

function getXai(): OpenAI {
  if (!xaiClient) {
    if (!env.XAI_API_KEY) {
      throw new Error("XAI_API_KEY not configured")
    }
    xaiClient = new OpenAI({
      apiKey: env.XAI_API_KEY,
      baseURL: "https://api.x.ai/v1",
    })
  }
  return xaiClient
}

// -----------------------------------------------------------------------------
// Message Types
// -----------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface CompletionOptions {
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  tools?: ToolDefinition[]
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } }
  jsonMode?: boolean
  reasoningEffort?: "low" | "medium" | "high" | "xhigh"
}

export interface ToolDefinition {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export interface CompletionResult {
  content: string | null
  toolCalls: ToolCall[]
  model: string
  provider: string
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  latencyMs: number
  finishReason: string
}

// -----------------------------------------------------------------------------
// xAI Agent Tools Types
// -----------------------------------------------------------------------------

// XaiAgentTool and XaiAgentToolType are imported from types.js and re-exported above

export interface XaiCompletionOptions extends CompletionOptions {
  xaiAgentTools?: XaiAgentTool[]
}

export interface XaiServerToolCall {
  id: string
  type: "server_tool_use"
  name: XaiAgentToolType
  input: Record<string, unknown>
}

export interface XaiServerToolResult {
  id: string
  type: "server_tool_result"
  name: XaiAgentToolType
  output: unknown
}

export interface XaiCompletionResult extends CompletionResult {
  serverToolCalls?: XaiServerToolCall[]
  serverToolResults?: XaiServerToolResult[]
}

// -----------------------------------------------------------------------------
// Provider Implementations
// -----------------------------------------------------------------------------

async function callOpenAI(
  config: ModelConfig,
  options: CompletionOptions
): Promise<CompletionResult> {
  const client = getOpenAI()
  const start = Date.now()

  // Build request body, only including properties that have values
  // to satisfy exactOptionalPropertyTypes
  // Explicitly set stream: false to help TypeScript narrow the response type
  const requestBody: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: config.model,
    messages: options.messages,
    temperature: options.temperature ?? config.temperature,
    max_tokens: options.maxTokens ?? config.maxTokens,
    stream: false,
  }

  if (options.tools && options.tools.length > 0) {
    requestBody.tools = options.tools
  }
  if (options.toolChoice) {
    requestBody.tool_choice = options.toolChoice
  }
  if (options.jsonMode) {
    requestBody.response_format = { type: "json_object" }
  }
  // OpenAI only supports low/medium/high for reasoning_effort
  if (options.reasoningEffort && options.reasoningEffort !== "xhigh") {
    requestBody.reasoning_effort = options.reasoningEffort as "low" | "medium" | "high"
  }

  const response = await client.chat.completions.create(requestBody)

  const firstChoice = response.choices[0]
  if (!firstChoice) {
    throw new Error("OpenAI returned no choices")
  }
  const message = firstChoice.message
  const toolCalls: ToolCall[] =
    message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: tc.type,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    })) ?? []

  return {
    content: message.content,
    toolCalls,
    model: config.model,
    provider: "openai",
    usage: {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    },
    latencyMs: Date.now() - start,
    finishReason: firstChoice.finish_reason,
  }
}

async function callAnthropic(
  config: ModelConfig,
  options: CompletionOptions
): Promise<CompletionResult> {
  const client = getAnthropic()
  const start = Date.now()

  // Convert messages format
  const systemMessage = options.messages.find((m) => m.role === "system")
  const nonSystemMessages = options.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }))

  // Convert tools to Anthropic format
  const tools = options.tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
  }))

  // Build request body conditionally to satisfy exactOptionalPropertyTypes
  // Explicitly set stream: false to help TypeScript narrow the response type
  const requestBody: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: config.model,
    max_tokens: options.maxTokens ?? config.maxTokens,
    messages: nonSystemMessages,
    stream: false,
  }

  // Only include system if it has a value
  if (systemMessage?.content) {
    requestBody.system = systemMessage.content
  }
  if (tools && tools.length > 0) {
    requestBody.tools = tools
  }

  const response = await client.messages.create(requestBody)

  // Extract content and tool calls
  let content: string | null = null
  const toolCalls: ToolCall[] = []

  for (const block of response.content) {
    if (block.type === "text") {
      content = block.text
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      })
    }
  }

  return {
    content,
    toolCalls,
    model: config.model,
    provider: "anthropic",
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    },
    latencyMs: Date.now() - start,
    finishReason: response.stop_reason ?? "unknown",
  }
}

async function callGoogle(
  config: ModelConfig,
  options: CompletionOptions
): Promise<CompletionResult> {
  const client = getGoogle()
  const start = Date.now()

  const model = client.getGenerativeModel({ model: config.model })

  // Convert messages to Google format
  const systemMessage = options.messages.find((m) => m.role === "system")
  const history = options.messages
    .filter((m) => m.role !== "system")
    .slice(0, -1)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }))

  const lastMessage = options.messages[options.messages.length - 1]
  if (!lastMessage) {
    throw new Error("No messages provided to Google model")
  }

  // Build chat config conditionally to satisfy exactOptionalPropertyTypes
  const chatConfig: Parameters<typeof model.startChat>[0] = {
    history,
  }
  if (systemMessage) {
    // systemInstruction can be a string directly
    chatConfig.systemInstruction = systemMessage.content
  }

  const chat = model.startChat(chatConfig)

  const result = await chat.sendMessage(lastMessage.content)
  const response = result.response

  return {
    content: response.text(),
    toolCalls: [], // Google tool calling would need separate handling
    model: config.model,
    provider: "google",
    usage: {
      promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
    },
    latencyMs: Date.now() - start,
    finishReason: "stop",
  }
}

// -----------------------------------------------------------------------------
// xAI Helper Functions (extracted to reduce complexity)
// -----------------------------------------------------------------------------

interface XaiRawMessage {
  content: string | null
  tool_calls?: unknown[]
  server_tool_calls?: Array<{ id: string; name: string; input: string | Record<string, unknown> }>
  server_tool_results?: Array<{ id: string; name: string; output: unknown }>
}

function buildXaiToolsArray(options: XaiCompletionOptions): unknown[] {
  const allTools: unknown[] = [...(options.tools ?? [])]

  if (!options.xaiAgentTools || !env.XAI_ENABLE_AGENT_TOOLS) {
    return allTools
  }

  const enabledTools = env.XAI_AGENT_TOOLS_ENABLED.split(",")
  for (const agentTool of options.xaiAgentTools) {
    if (enabledTools.includes(agentTool.type)) {
      allTools.push(agentTool)
    }
  }

  return allTools
}

function parseFunctionToolCalls(
  rawToolCalls: OpenAI.ChatCompletionMessageToolCall[] | undefined
): ToolCall[] {
  if (!rawToolCalls) return []

  return rawToolCalls
    .filter((tc) => tc.type === "function")
    .map((tc) => ({
      id: tc.id,
      type: tc.type,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }))
}

function parseServerToolCalls(rawMessage: XaiRawMessage): XaiServerToolCall[] {
  if (!rawMessage.server_tool_calls) return []

  return rawMessage.server_tool_calls.map((stc) => ({
    id: stc.id,
    type: "server_tool_use" as const,
    name: stc.name as XaiAgentToolType,
    input: typeof stc.input === "string" ? JSON.parse(stc.input) : stc.input,
  }))
}

function parseServerToolResults(rawMessage: XaiRawMessage): XaiServerToolResult[] {
  if (!rawMessage.server_tool_results) return []

  return rawMessage.server_tool_results.map((str) => ({
    id: str.id,
    type: "server_tool_result" as const,
    name: str.name as XaiAgentToolType,
    output: str.output,
  }))
}

// -----------------------------------------------------------------------------
// xAI Completion
// -----------------------------------------------------------------------------

async function callXai(
  config: ModelConfig,
  options: XaiCompletionOptions
): Promise<XaiCompletionResult> {
  const client = getXai()
  const start = Date.now()

  const allTools = buildXaiToolsArray(options)

  // Build request body conditionally to satisfy exactOptionalPropertyTypes
  // xAI uses OpenAI-compatible API
  const requestBody: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: config.model,
    messages: options.messages,
    temperature: options.temperature ?? config.temperature,
    max_tokens: options.maxTokens ?? config.maxTokens,
    stream: false,
  }

  if (allTools.length > 0) {
    requestBody.tools = allTools as OpenAI.Chat.Completions.ChatCompletionTool[]
  }
  if (options.toolChoice) {
    requestBody.tool_choice = options.toolChoice
  }
  if (options.jsonMode) {
    requestBody.response_format = { type: "json_object" }
  }

  const response = await client.chat.completions.create(requestBody)

  const firstChoice = response.choices[0]
  if (!firstChoice) {
    throw new Error("xAI returned no choices")
  }
  const message = firstChoice.message
  const rawMessage = message as unknown as XaiRawMessage

  const toolCalls = parseFunctionToolCalls(message.tool_calls)
  const serverToolCalls = parseServerToolCalls(rawMessage)
  const serverToolResults = parseServerToolResults(rawMessage)

  return {
    content: message.content,
    toolCalls,
    serverToolCalls: serverToolCalls.length > 0 ? serverToolCalls : [],
    serverToolResults: serverToolResults.length > 0 ? serverToolResults : [],
    model: config.model,
    provider: "xai",
    usage: {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    },
    latencyMs: Date.now() - start,
    finishReason: firstChoice.finish_reason,
  }
}

// -----------------------------------------------------------------------------
// Unified Router
// -----------------------------------------------------------------------------

async function callModel(modelId: string, options: CompletionOptions): Promise<CompletionResult> {
  const config = getModelConfig(modelId)

  if (!config.apiKey) {
    throw new Error(`API key not configured for ${config.provider}`)
  }

  switch (config.provider) {
    case "openai":
      return callOpenAI(config, options)
    case "anthropic":
      return callAnthropic(config, options)
    case "google":
      return callGoogle(config, options)
    case "xai":
      return callXai(config, options)
    default:
      throw new Error(`Unknown provider: ${config.provider}`)
  }
}

export async function complete(
  options: CompletionOptions,
  preferFast = false
): Promise<CompletionResult> {
  // Select model chain based on preference
  const models = preferFast
    ? [modelChain.fast, ...modelChain.fallbacks]
    : [modelChain.primary, ...modelChain.fallbacks]

  // Try each model in the chain
  let lastError: Error | null = null

  for (const modelId of models) {
    // Skip if circuit is open
    if (isCircuitOpen(modelId)) {
      log.warn({ modelId }, "Circuit open, skipping model")
      continue
    }

    try {
      log.debug({ modelId }, "Attempting model call")
      const result = await callModel(modelId, options)
      recordSuccess(modelId)
      log.info(
        { modelId, latencyMs: result.latencyMs, tokens: result.usage.totalTokens },
        "Model call successful"
      )
      return result
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      recordFailure(modelId)
      log.error({ modelId, error: lastError.message }, "Model call failed")
    }
  }

  throw lastError ?? new Error("All models failed")
}

// -----------------------------------------------------------------------------
// Structured Output
// -----------------------------------------------------------------------------

export async function completeJson<T>(
  options: CompletionOptions,
  schema?: Record<string, unknown>
): Promise<{ data: T; raw: CompletionResult }> {
  const result = await complete({
    ...options,
    jsonMode: true,
    messages: [
      ...options.messages,
      {
        role: "user",
        content: schema
          ? `Respond with valid JSON matching this schema: ${JSON.stringify(schema)}`
          : "Respond with valid JSON.",
      },
    ],
  })

  if (!result.content) {
    throw new Error("No content in response")
  }

  const parsed = parseJsonFromText<T>(result.content)
  if (parsed) {
    return { data: parsed, raw: result }
  }

  throw new Error(`Failed to parse JSON response: ${result.content}`)
}

function parseJsonFromText<T>(content: string): T | null {
  const trimmed = content.trim()

  try {
    return JSON.parse(trimmed) as T
  } catch {
    // continue
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim()) as T
    } catch {
      // continue
    }
  }

  const candidates: string[] = []
  const firstObject = trimmed.indexOf("{")
  const lastObject = trimmed.lastIndexOf("}")
  if (firstObject !== -1 && lastObject > firstObject) {
    candidates.push(trimmed.slice(firstObject, lastObject + 1))
  }

  const firstArray = trimmed.indexOf("[")
  const lastArray = trimmed.lastIndexOf("]")
  if (firstArray !== -1 && lastArray > firstArray) {
    candidates.push(trimmed.slice(firstArray, lastArray + 1))
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      // continue
    }
  }

  return null
}

// -----------------------------------------------------------------------------
// Tool Calling
// -----------------------------------------------------------------------------

export async function completeWithTools(options: CompletionOptions): Promise<CompletionResult> {
  if (!options.tools || options.tools.length === 0) {
    throw new Error("Tools required for tool calling")
  }

  return complete({
    ...options,
    toolChoice: options.toolChoice ?? "auto",
  })
}

// -----------------------------------------------------------------------------
// Streaming (for future use)
// -----------------------------------------------------------------------------

export async function* stream(
  options: CompletionOptions
): AsyncGenerator<{ delta: string; done: boolean }> {
  const config = getModelConfig(modelChain.primary)

  if (config.provider === "openai") {
    const client = getOpenAI()
    const stream = await client.chat.completions.create({
      model: config.model,
      messages: options.messages,
      temperature: options.temperature ?? config.temperature,
      max_tokens: options.maxTokens ?? config.maxTokens,
      stream: true,
    })

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? ""
      const done = chunk.choices[0]?.finish_reason !== null
      yield { delta, done }
    }
  } else {
    // Fall back to non-streaming for other providers
    const result = await complete(options)
    yield { delta: result.content ?? "", done: true }
  }
}

// -----------------------------------------------------------------------------
// xAI Agent Tools Completion
// -----------------------------------------------------------------------------

export async function completeWithXaiAgentTools(
  options: XaiCompletionOptions,
  agentTools: XaiAgentToolType[] = ["web_search"]
): Promise<XaiCompletionResult> {
  // Filter out 'mcp' type as it requires additional configuration (server_label, server_url)
  // Only simple tool types (web_search, x_search, code_execution, collections_search) can be auto-mapped
  const simpleToolTypes = agentTools.filter(
    (type): type is Exclude<XaiAgentToolType, "mcp"> => type !== "mcp"
  )
  const xaiTools: XaiAgentTool[] = simpleToolTypes.map((type) => ({ type }))
  const modelId = env.MODEL_FAST.includes("grok") ? env.MODEL_FAST : "grok-4-1-fast"
  const config = getModelConfig(modelId)

  log.info({ modelId, agentTools }, "Calling xAI with Agent Tools")

  return callXai(config, { ...options, xaiAgentTools: xaiTools })
}

// Direct xAI call with specific model (for advanced use cases)
export async function callXaiDirect(
  modelId: string,
  options: XaiCompletionOptions
): Promise<XaiCompletionResult> {
  const config = getModelConfig(modelId)
  if (config.provider !== "xai") {
    throw new Error(`Model ${modelId} is not an xAI model`)
  }
  return callXai(config, options)
}

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------

export async function checkModelHealth(modelId: string): Promise<boolean> {
  try {
    await callModel(modelId, {
      messages: [{ role: "user", content: "Say 'ok'" }],
      maxTokens: 5,
    })
    return true
  } catch {
    return false
  }
}
