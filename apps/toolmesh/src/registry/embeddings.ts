// =============================================================================
// MindOS - Embeddings Service
// =============================================================================

import OpenAI from "openai"
import { env } from "../config.js"
import { createLogger } from "../logger.js"

const _log = createLogger("embeddings")

// -----------------------------------------------------------------------------
// OpenAI Client
// -----------------------------------------------------------------------------

let openaiClient: OpenAI | null = null

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    if (!env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY not configured for embeddings")
    }
    openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY })
  }
  return openaiClient
}

// -----------------------------------------------------------------------------
// Embedding Generation
// -----------------------------------------------------------------------------

export async function generateEmbedding(text: string): Promise<number[]> {
  const client = getOpenAI()

  const response = await client.embeddings.create({
    model: env.EMBEDDING_MODEL,
    input: text,
    dimensions: env.EMBEDDING_DIMENSIONS,
  })

  return response.data[0].embedding
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []

  const client = getOpenAI()

  // Batch in groups of 100 (API limit)
  const batchSize = 100
  const embeddings: number[][] = []

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)

    const response = await client.embeddings.create({
      model: env.EMBEDDING_MODEL,
      input: batch,
      dimensions: env.EMBEDDING_DIMENSIONS,
    })

    embeddings.push(...response.data.map((d) => d.embedding))
  }

  return embeddings
}

// -----------------------------------------------------------------------------
// Embedding Cache (in-memory)
// -----------------------------------------------------------------------------

const embeddingCache = new Map<string, { embedding: number[]; timestamp: number }>()
const CACHE_TTL_MS = 1000 * 60 * 60 // 1 hour

export async function getCachedEmbedding(text: string): Promise<number[]> {
  const cacheKey = hashText(text)
  const cached = embeddingCache.get(cacheKey)

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.embedding
  }

  const embedding = await generateEmbedding(text)
  embeddingCache.set(cacheKey, { embedding, timestamp: Date.now() })

  // Cleanup old entries
  if (embeddingCache.size > 10000) {
    const now = Date.now()
    for (const [key, value] of embeddingCache) {
      if (now - value.timestamp > CACHE_TTL_MS) {
        embeddingCache.delete(key)
      }
    }
  }

  return embedding
}

function hashText(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return hash.toString(36)
}

// -----------------------------------------------------------------------------
// Similarity Calculation
// -----------------------------------------------------------------------------

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have the same length")
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}
