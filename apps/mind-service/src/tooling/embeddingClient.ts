// =============================================================================
// MindOS - Embedding Client
// =============================================================================

import { request } from "undici"
import { env } from "../config.js"
import { createLogger } from "../logger.js"
import type { RequestContext } from "./toolmeshClient.js"

const log = createLogger("embedding-client")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface EmbeddingResponse {
  success: boolean
  data?: {
    embedding: number[]
    dimensions: number
  }
  error?: string
}

interface BatchEmbeddingResponse {
  success: boolean
  data?: {
    embeddings: number[][]
    dimensions: number
    count: number
  }
  error?: string
}

// -----------------------------------------------------------------------------
// HTTP Client
// -----------------------------------------------------------------------------

async function embeddingRequest<T>(
  path: string,
  body: unknown,
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
    const response = await request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })

    const data = (await response.body.json()) as T
    return data
  } catch (err) {
    log.error({ url, error: err }, "Embedding request failed")
    throw err
  }
}

// -----------------------------------------------------------------------------
// Embedding Generation
// -----------------------------------------------------------------------------

export async function generateEmbedding(text: string, context?: RequestContext): Promise<number[]> {
  const response = await embeddingRequest<EmbeddingResponse>(
    "/embeddings/generate",
    { text },
    context
  )

  if (!response.success || !response.data) {
    throw new Error(response.error ?? "Failed to generate embedding")
  }

  return response.data.embedding
}

export async function generateEmbeddings(
  texts: string[],
  context?: RequestContext
): Promise<number[][]> {
  if (texts.length === 0) return []

  const response = await embeddingRequest<BatchEmbeddingResponse>(
    "/embeddings/generate/batch",
    { texts },
    context
  )

  if (!response.success || !response.data) {
    throw new Error(response.error ?? "Failed to generate embeddings")
  }

  return response.data.embeddings
}
