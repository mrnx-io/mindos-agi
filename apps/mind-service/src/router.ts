// =============================================================================
// MindOS - Multi-Model Router
// =============================================================================

import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"
import { GoogleGenerativeAI } from "@google/generative-ai"
import {
  env,
  modelChain,
  getModelConfig,
  isCircuitOpen,
  recordSuccess,
  recordFailure,
  type ModelConfig,
} from "./config.js"
import { createLogger } from "./logger.js"
import type { ModelResponse } from "./types.js"

const log = createLogger("router")

// -----------------------------------------------------------------------------
// Client Initialization
// -----------------------------------------------------------------------------

let openaiClient: OpenAI | null = null
let anthropicClient: Anthropic | null = null
let googleClient: GoogleGenerativeAI | null = null

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
// Provider Implementations
// -----------------------------------------------------------------------------

async function callOpenAI(
  config: ModelConfig,
  options: CompletionOptions
): Promise<CompletionResult> {
  const client = getOpenAI()
  const start = Date.now()

  const response = await client.chat.completions.create({
    model: config.model,
    messages: options.messages,
    temperature: options.temperature ?? config.temperature,
    max_tokens: options.maxTokens ?? config.maxTokens,
    tools: options.tools,
    tool_choice: options.toolChoice,
    response_format: options.jsonMode ? { type: "json_object" } : undefined,
    ...(options.reasoningEffort && { reasoning_effort: options.reasoningEffort }),
  })

  const message = response.choices[0].message
  const toolCalls: ToolCall[] = message.tool_calls?.map((tc) => ({
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
    finishReason: response.choices[0].finish_reason,
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

  const response = await client.messages.create({
    model: config.model,
    max_tokens: options.maxTokens ?? config.maxTokens,
    system: systemMessage?.content,
    messages: nonSystemMessages,
    tools,
  })

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

  const chat = model.startChat({
    history,
    systemInstruction: systemMessage ? { parts: [{ text: systemMessage.content }] } : undefined,
  })

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
// Unified Router
// -----------------------------------------------------------------------------

async function callModel(
  modelId: string,
  options: CompletionOptions
): Promise<CompletionResult> {
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
      // xAI uses OpenAI-compatible API
      return callOpenAI({ ...config, provider: "openai" }, options)
    default:
      throw new Error(`Unknown provider: ${config.provider}`)
  }
}

export async function complete(
  options: CompletionOptions,
  preferFast = false
): Promise<CompletionResult> {
  // Select model chain based on preference
  const models = preferFast ? [modelChain.fast, ...modelChain.fallbacks] : [modelChain.primary, ...modelChain.fallbacks]

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

  try {
    const data = JSON.parse(result.content) as T
    return { data, raw: result }
  } catch {
    throw new Error(`Failed to parse JSON response: ${result.content}`)
  }
}

// -----------------------------------------------------------------------------
// Tool Calling
// -----------------------------------------------------------------------------

export async function completeWithTools(
  options: CompletionOptions
): Promise<CompletionResult> {
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
