// =============================================================================
// MindOS - Mind Service Entry Point
// =============================================================================

import { createEndpointHandler } from "@restatedev/restate-sdk/fetch"
import http from "node:http"
import { Readable } from "node:stream"
import { env } from "./config.js"
import { checkDatabaseHealth, closeDatabasePool } from "./db.js"
import { logger } from "./logger.js"
import { checkExecutorHealth } from "./tooling/executorClient.js"
import { checkToolMeshHealth } from "./tooling/toolmeshClient.js"
import { identityService } from "./workflows/identity.js"
import { createIdentity, mindObject } from "./workflows/mind.js"
import { taskObject } from "./workflows/task.js"

// -----------------------------------------------------------------------------
// Health Check Endpoint
// -----------------------------------------------------------------------------

async function healthCheck(): Promise<{
  status: "healthy" | "degraded" | "unhealthy"
  checks: Record<string, boolean>
}> {
  const checks: Record<string, boolean> = {}

  // Check database
  checks.database = await checkDatabaseHealth()

  // Check ToolMesh (non-critical)
  checks.toolmesh = await checkToolMeshHealth()

  // Check Executor (non-critical)
  checks.executor = await checkExecutorHealth()

  // Determine overall status
  const criticalHealthy = checks.database
  const allHealthy = Object.values(checks).every(Boolean)

  return {
    status: criticalHealthy ? (allHealthy ? "healthy" : "degraded") : "unhealthy",
    checks,
  }
}

// -----------------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------------

async function main() {
  logger.info({ port: env.PORT }, "Starting MindOS Mind Service")

  // Verify database connectivity
  const dbHealthy = await checkDatabaseHealth()
  if (!dbHealthy) {
    logger.error("Database connection failed, exiting")
    process.exit(1)
  }
  logger.info("Database connection verified")

  // Start Restate server over HTTP/1.1 (request-response mode)
  const handler = createEndpointHandler({
    services: [mindObject, taskObject, identityService],
  })

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
      const method = req.method ?? "GET"
      const headers = new Headers()

      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          headers.set(key, value)
        } else if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item)
        }
      }

      const init: RequestInit & { duplex?: "half"; body?: unknown } = { method, headers }
      if (method !== "GET" && method !== "HEAD") {
        init.body = req
        init.duplex = "half"
      }

      const request = new Request(url, init)
      const response = await handler(request)

      res.statusCode = response.status
      response.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })

      if (response.body) {
        Readable.fromWeb(response.body as ReadableStream).pipe(res)
      } else {
        res.end()
      }
    } catch (err) {
      logger.error({ err }, "Failed to handle request")
      res.statusCode = 500
      res.end()
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.listen(env.PORT, () => resolve())
    server.on("error", reject)
  })

  logger.info({ port: env.PORT }, "Mind Service started")

  // Log configuration
  logger.info(
    {
      modelPrimary: env.MODEL_PRIMARY,
      modelFast: env.MODEL_FAST,
      toolmeshUrl: env.TOOLMESH_URL,
      executorUrl: env.EXECUTOR_URL,
      metacognition: env.ENABLE_METACOGNITION,
      worldModel: env.ENABLE_WORLD_MODEL,
      swarm: env.ENABLE_SWARM,
      grounding: env.ENABLE_GROUNDING,
    },
    "Configuration loaded"
  )

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...")
    await closeDatabasePool()
    logger.info("Shutdown complete")
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

// -----------------------------------------------------------------------------
// Exports for programmatic use
// -----------------------------------------------------------------------------

export { mindObject, taskObject, identityService, createIdentity }
export { healthCheck }
export * from "./types.js"
export * from "./config.js"
export * from "./db.js"
export * from "./memory.js"
export * from "./evidence.js"
export * from "./policy.js"
export * from "./router.js"
export * from "./prompts.js"
export * from "./tooling/index.js"

// -----------------------------------------------------------------------------
// Run if main module
// -----------------------------------------------------------------------------

main().catch((err) => {
  logger.error({ err }, "Fatal error during startup")
  process.exit(1)
})
