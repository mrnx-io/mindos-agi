// =============================================================================
// MindOS - ToolMesh Server (MCP Gateway)
// =============================================================================

import cors from "@fastify/cors"
import Fastify from "fastify"
import { z } from "zod"
import { extractContext, validateToken } from "./auth.js"
import { env } from "./config.js"
import { checkHealth as checkDbHealth, closePool } from "./db.js"
import {
  acquireOrWait,
  cleanupOldRequests,
  getRequest,
  markCompleted,
  markFailed,
  resetStuckRequests,
} from "./idempotency/toolCallRequests.js"
import { createLogger, logger } from "./logger.js"
import { callTool, checkAllHealth, getHubStatus, initializeHub, shutdownHub } from "./mcp/hub.js"
import {
  getTool,
  getToolStats,
  listTools,
  recordToolCall,
  searchToolsSemantic,
} from "./registry/toolRegistry.js"
import { isCircuitOpen, recordFailure, recordSuccess, withRetry } from "./retry/retry.js"

const log = createLogger("server")

// -----------------------------------------------------------------------------
// Request Schemas
// -----------------------------------------------------------------------------

const ToolCallRequestSchema = z.object({
  tool_name: z.string(),
  parameters: z.record(z.unknown()).default({}),
  idempotency_key: z.string().optional(),
  identity_id: z.string(),
  timeout_ms: z.number().optional().default(30000),
})

const ToolSearchRequestSchema = z.object({
  query: z.string(),
  limit: z.number().optional().default(10),
  min_similarity: z.number().optional().default(0.3),
  server_name: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

// -----------------------------------------------------------------------------
// Server Setup
// -----------------------------------------------------------------------------

const app = Fastify({
  logger: false, // We use our own logger
})

await app.register(cors, {
  origin: true,
})

// Auth middleware
app.addHook("preHandler", validateToken)

// -----------------------------------------------------------------------------
// Health Endpoints
// -----------------------------------------------------------------------------

app.get("/health", async () => {
  const dbHealthy = await checkDbHealth()
  const hubStatus = getHubStatus()

  return {
    status: dbHealthy ? "healthy" : "unhealthy",
    database: dbHealthy,
    hub: hubStatus,
  }
})

// -----------------------------------------------------------------------------
// Tool Discovery Endpoints
// -----------------------------------------------------------------------------

app.get("/tools", async (request, _reply) => {
  const serverName = request.query as { server_name?: string }
  const tools = await listTools(serverName.server_name)

  return {
    success: true,
    data: tools,
  }
})

app.get("/tools/:name", async (request, reply) => {
  const { name } = request.params as { name: string }
  const tool = await getTool(name)

  if (!tool) {
    reply.code(404)
    return { success: false, error: "Tool not found" }
  }

  return { success: true, data: tool }
})

app.get("/tools/:name/status", async (request, reply) => {
  const { name } = request.params as { name: string }

  try {
    const stats = await getToolStats(name)
    const tool = await getTool(name)

    return {
      success: true,
      data: {
        available: !!tool,
        healthy: !isCircuitOpen(tool?.server_name ?? ""),
        ...stats,
      },
    }
  } catch (_err) {
    reply.code(404)
    return { success: false, error: "Tool not found" }
  }
})

app.post("/tools/search", async (request, _reply) => {
  const body = ToolSearchRequestSchema.parse(request.body)
  const results = await searchToolsSemantic(body.query, {
    limit: body.limit,
    minSimilarity: body.min_similarity,
    serverName: body.server_name,
    tags: body.tags,
  })

  return {
    success: true,
    data: results.map((r) => r.tool),
  }
})

app.post("/tools/search/semantic", async (request, _reply) => {
  const body = ToolSearchRequestSchema.parse(request.body)
  const results = await searchToolsSemantic(body.query, {
    limit: body.limit,
    minSimilarity: body.min_similarity,
    serverName: body.server_name,
    tags: body.tags,
  })

  return {
    success: true,
    data: results,
  }
})

// -----------------------------------------------------------------------------
// Tool Execution Endpoints
// -----------------------------------------------------------------------------

app.post("/tools/call", async (request, reply) => {
  const startTime = Date.now()
  const body = ToolCallRequestSchema.parse(request.body)
  const ctx = extractContext(request)

  log.info(
    { tool: body.tool_name, identityId: body.identity_id, correlationId: ctx.correlationId },
    "Tool call request"
  )

  // Get tool to find server
  const tool = await getTool(body.tool_name)
  if (!tool) {
    reply.code(404)
    return { success: false, error: `Tool not found: ${body.tool_name}` }
  }

  // Check circuit breaker
  if (isCircuitOpen(tool.server_name)) {
    reply.code(503)
    return { success: false, error: `Server ${tool.server_name} is in cooldown` }
  }

  // Handle idempotency
  const idempotencyKey =
    body.idempotency_key ?? `${body.identity_id}-${body.tool_name}-${Date.now()}`

  const { shouldExecute, existingResult } = await acquireOrWait(
    idempotencyKey,
    body.tool_name,
    body.parameters,
    body.identity_id
  )

  if (!shouldExecute && existingResult) {
    // Return cached result
    return {
      success: existingResult.status === "completed",
      output: existingResult.result,
      error: existingResult.error,
      cached: true,
    }
  }

  // Execute with retry
  try {
    const result = await withRetry(
      tool.server_name,
      async () => callTool(body.tool_name, body.parameters),
      { maxAttempts: 3 }
    )

    const latencyMs = Date.now() - startTime

    // Record success
    recordSuccess(tool.server_name)
    await recordToolCall(body.tool_name, {
      success: result.success,
      latencyMs,
    })
    await markCompleted(idempotencyKey, result)

    log.info({ tool: body.tool_name, success: result.success, latencyMs }, "Tool call completed")

    return {
      success: result.success,
      output: result.output,
      error: result.error,
      cached: false,
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - startTime

    recordFailure(tool.server_name)
    await recordToolCall(body.tool_name, {
      success: false,
      latencyMs,
      errorCode: error.slice(0, 100),
    })
    await markFailed(idempotencyKey, error)

    log.error({ tool: body.tool_name, error, latencyMs }, "Tool call failed")

    reply.code(500)
    return {
      success: false,
      error,
      cached: false,
    }
  }
})

app.get("/tools/calls/:idempotencyKey", async (request, _reply) => {
  const { idempotencyKey } = request.params as { idempotencyKey: string }
  const result = await getRequest(idempotencyKey)

  if (!result || result.status !== "completed") {
    return { success: true, data: null }
  }

  return {
    success: true,
    data: {
      success: result.status === "completed",
      output: result.result,
      error: result.error,
    },
  }
})

// -----------------------------------------------------------------------------
// Registry Management Endpoints
// -----------------------------------------------------------------------------

app.post("/tools/refresh", async (_request, _reply) => {
  await shutdownHub()
  await initializeHub()

  return {
    success: true,
    data: getHubStatus(),
  }
})

app.get("/tools/stats", async () => {
  const hubStatus = getHubStatus()
  const tools = await listTools()

  return {
    success: true,
    data: {
      totalTools: tools.length,
      activeServers: hubStatus.servers.filter((s) => s.healthy).length,
      ...hubStatus,
    },
  }
})

// -----------------------------------------------------------------------------
// Server Health Management
// -----------------------------------------------------------------------------

app.get("/servers/health", async () => {
  const health = await checkAllHealth()
  return { success: true, data: health }
})

// -----------------------------------------------------------------------------
// Embeddings Endpoints
// -----------------------------------------------------------------------------

const EmbeddingRequestSchema = z.object({
  text: z.string().min(1),
})

const BatchEmbeddingRequestSchema = z.object({
  texts: z.array(z.string().min(1)).min(1).max(100),
})

app.post("/embeddings/generate", async (request, _reply) => {
  const body = EmbeddingRequestSchema.parse(request.body)

  const { generateEmbedding } = await import("./registry/embeddings.js")
  const embedding = await generateEmbedding(body.text)

  return {
    success: true,
    data: {
      embedding,
      dimensions: embedding.length,
    },
  }
})

app.post("/embeddings/generate/batch", async (request, _reply) => {
  const body = BatchEmbeddingRequestSchema.parse(request.body)

  const { generateEmbeddings } = await import("./registry/embeddings.js")
  const embeddings = await generateEmbeddings(body.texts)

  return {
    success: true,
    data: {
      embeddings,
      dimensions: embeddings[0]?.length ?? 0,
      count: embeddings.length,
    },
  }
})

// -----------------------------------------------------------------------------
// Maintenance Tasks
// -----------------------------------------------------------------------------

async function runMaintenance(): Promise<void> {
  await cleanupOldRequests(24)
  await resetStuckRequests(5)
}

// Run maintenance every hour
setInterval(runMaintenance, 60 * 60 * 1000)

// -----------------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------------

async function main() {
  logger.info({ port: env.PORT, host: env.HOST }, "Starting ToolMesh server")

  // Verify database
  const dbHealthy = await checkDbHealth()
  if (!dbHealthy) {
    logger.error("Database connection failed")
    process.exit(1)
  }
  logger.info("Database connection verified")

  // Initialize MCP hub
  await initializeHub()

  // Start server
  await app.listen({ port: env.PORT, host: env.HOST })
  logger.info({ port: env.PORT }, "ToolMesh server started")

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...")
    await shutdownHub()
    await closePool()
    await app.close()
    logger.info("Shutdown complete")
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  logger.error({ err }, "Fatal error during startup")
  process.exit(1)
})
