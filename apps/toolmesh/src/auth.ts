// =============================================================================
// MindOS - ToolMesh Authentication
// =============================================================================

import type { FastifyReply, FastifyRequest } from "fastify"
import { env } from "./config.js"
import { createLogger } from "./logger.js"

const log = createLogger("auth")

// -----------------------------------------------------------------------------
// Token Validation
// -----------------------------------------------------------------------------

export async function validateToken(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Skip auth if no token configured
  if (!env.TOOLMESH_TOKEN) {
    return
  }

  const authHeader = request.headers.authorization

  if (!authHeader) {
    log.warn({ ip: request.ip }, "Missing authorization header")
    reply.code(401).send({ error: "Missing authorization header" })
    return
  }

  const [scheme, token] = authHeader.split(" ")

  if (scheme !== "Bearer" || !token) {
    log.warn({ ip: request.ip }, "Invalid authorization scheme")
    reply.code(401).send({ error: "Invalid authorization scheme" })
    return
  }

  if (token !== env.TOOLMESH_TOKEN) {
    log.warn({ ip: request.ip }, "Invalid token")
    reply.code(403).send({ error: "Invalid token" })
    return
  }
}

// -----------------------------------------------------------------------------
// Request Context
// -----------------------------------------------------------------------------

export interface RequestContext {
  identityId?: string
  correlationId: string
}

export function extractContext(request: FastifyRequest): RequestContext {
  return {
    identityId: request.headers["x-identity-id"] as string | undefined,
    correlationId: (request.headers["x-correlation-id"] as string) ?? crypto.randomUUID(),
  }
}
