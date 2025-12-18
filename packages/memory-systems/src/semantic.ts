// =============================================================================
// Semantic Memory System (Vector-Based)
// =============================================================================

import type pg from "pg"
import type OpenAI from "openai"
import type { SemanticMemory, MemoryQuery } from "./types.js"

// -----------------------------------------------------------------------------
// Semantic Memory Interface
// -----------------------------------------------------------------------------

export interface SemanticMemoryStore {
  store(input: StoreSemanticInput): Promise<SemanticMemory>
  retrieve(memoryId: string): Promise<SemanticMemory | null>
  search(identityId: string, query: MemoryQuery): Promise<SemanticSearchResult[]>
  searchByEmbedding(identityId: string, embedding: number[], limit?: number): Promise<SemanticSearchResult[]>
  update(memoryId: string, updates: Partial<SemanticMemory>): Promise<SemanticMemory>
  delete(memoryId: string): Promise<void>
  getByCategory(identityId: string, category: string): Promise<SemanticMemory[]>
  getByTags(identityId: string, tags: string[]): Promise<SemanticMemory[]>
}

export interface StoreSemanticInput {
  identity_id: string
  content: string
  source_episode_ids?: string[]
  category?: string
  tags?: string[]
  confidence?: number
}

export interface SemanticSearchResult {
  memory: SemanticMemory
  similarity: number
}

// -----------------------------------------------------------------------------
// Create Semantic Memory Store
// -----------------------------------------------------------------------------

export function createSemanticMemoryStore(
  pool: pg.Pool,
  openai: OpenAI,
  embeddingModel: string = "text-embedding-3-small"
): SemanticMemoryStore {
  async function generateEmbedding(text: string): Promise<number[]> {
    const response = await openai.embeddings.create({
      model: embeddingModel,
      input: text,
    })

    return response.data[0].embedding
  }

  async function store(input: StoreSemanticInput): Promise<SemanticMemory> {
    const embedding = await generateEmbedding(input.content)
    const now = new Date().toISOString()

    const memory: SemanticMemory = {
      memory_id: crypto.randomUUID(),
      identity_id: input.identity_id,
      content: input.content,
      embedding,
      source_episode_ids: input.source_episode_ids ?? [],
      category: input.category,
      tags: input.tags ?? [],
      confidence: input.confidence ?? 0.5,
      created_at: now,
      updated_at: now,
    }

    await pool.query(
      `INSERT INTO semantic_memories (
        memory_id, identity_id, content, embedding,
        source_episode_ids, category, tags, confidence,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        memory.memory_id,
        memory.identity_id,
        memory.content,
        `[${embedding.join(",")}]`,
        JSON.stringify(memory.source_episode_ids),
        memory.category,
        JSON.stringify(memory.tags),
        memory.confidence,
        memory.created_at,
        memory.updated_at,
      ]
    )

    return memory
  }

  async function retrieve(memoryId: string): Promise<SemanticMemory | null> {
    const result = await pool.query(
      `SELECT * FROM semantic_memories WHERE memory_id = $1`,
      [memoryId]
    )

    if (result.rows.length === 0) return null

    return rowToMemory(result.rows[0])
  }

  async function search(
    identityId: string,
    query: MemoryQuery
  ): Promise<SemanticSearchResult[]> {
    if (query.embedding) {
      return searchByEmbedding(identityId, query.embedding, query.limit)
    }

    if (query.query) {
      const embedding = await generateEmbedding(query.query)
      return searchByEmbedding(identityId, embedding, query.limit)
    }

    // Fallback to text search
    let sql = `SELECT * FROM semantic_memories WHERE identity_id = $1`
    const params: unknown[] = [identityId]
    let paramIndex = 2

    if (query.categories && query.categories.length > 0) {
      sql += ` AND category = ANY($${paramIndex})`
      params.push(query.categories)
      paramIndex++
    }

    if (query.tags && query.tags.length > 0) {
      sql += ` AND tags && $${paramIndex}`
      params.push(JSON.stringify(query.tags))
      paramIndex++
    }

    if (query.min_confidence !== undefined) {
      sql += ` AND confidence >= $${paramIndex}`
      params.push(query.min_confidence)
      paramIndex++
    }

    sql += ` ORDER BY updated_at DESC LIMIT $${paramIndex}`
    params.push(query.limit)

    const result = await pool.query(sql, params)

    return result.rows.map((row) => ({
      memory: rowToMemory(row),
      similarity: 1.0,
    }))
  }

  async function searchByEmbedding(
    identityId: string,
    embedding: number[],
    limit: number = 10
  ): Promise<SemanticSearchResult[]> {
    const result = await pool.query(
      `SELECT *,
        1 - (embedding <=> $1::vector) as similarity
       FROM semantic_memories
       WHERE identity_id = $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [`[${embedding.join(",")}]`, identityId, limit]
    )

    return result.rows.map((row) => ({
      memory: rowToMemory(row),
      similarity: row.similarity as number,
    }))
  }

  async function update(
    memoryId: string,
    updates: Partial<SemanticMemory>
  ): Promise<SemanticMemory> {
    const existing = await retrieve(memoryId)
    if (!existing) {
      throw new Error(`Memory ${memoryId} not found`)
    }

    const updated: SemanticMemory = {
      ...existing,
      ...updates,
      memory_id: existing.memory_id,
      identity_id: existing.identity_id,
      created_at: existing.created_at,
      updated_at: new Date().toISOString(),
    }

    // Regenerate embedding if content changed
    if (updates.content && updates.content !== existing.content) {
      updated.embedding = await generateEmbedding(updates.content)
    }

    await pool.query(
      `UPDATE semantic_memories SET
        content = $1,
        embedding = $2,
        source_episode_ids = $3,
        category = $4,
        tags = $5,
        confidence = $6,
        updated_at = $7
       WHERE memory_id = $8`,
      [
        updated.content,
        updated.embedding ? `[${updated.embedding.join(",")}]` : null,
        JSON.stringify(updated.source_episode_ids),
        updated.category,
        JSON.stringify(updated.tags),
        updated.confidence,
        updated.updated_at,
        memoryId,
      ]
    )

    return updated
  }

  async function deleteMemory(memoryId: string): Promise<void> {
    await pool.query(
      `DELETE FROM semantic_memories WHERE memory_id = $1`,
      [memoryId]
    )
  }

  async function getByCategory(
    identityId: string,
    category: string
  ): Promise<SemanticMemory[]> {
    const result = await pool.query(
      `SELECT * FROM semantic_memories
       WHERE identity_id = $1 AND category = $2
       ORDER BY updated_at DESC`,
      [identityId, category]
    )

    return result.rows.map(rowToMemory)
  }

  async function getByTags(
    identityId: string,
    tags: string[]
  ): Promise<SemanticMemory[]> {
    const result = await pool.query(
      `SELECT * FROM semantic_memories
       WHERE identity_id = $1 AND tags && $2
       ORDER BY updated_at DESC`,
      [identityId, JSON.stringify(tags)]
    )

    return result.rows.map(rowToMemory)
  }

  return {
    store,
    retrieve,
    search,
    searchByEmbedding,
    update,
    delete: deleteMemory,
    getByCategory,
    getByTags,
  }
}

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

function rowToMemory(row: Record<string, unknown>): SemanticMemory {
  return {
    memory_id: row.memory_id as string,
    identity_id: row.identity_id as string,
    content: row.content as string,
    embedding: row.embedding as number[] | undefined,
    source_episode_ids: (row.source_episode_ids as string[]) ?? [],
    category: row.category as string | undefined,
    tags: (row.tags as string[]) ?? [],
    confidence: (row.confidence as number) ?? 0.5,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}
