// =============================================================================
// Episodic Memory System
// =============================================================================

import type pg from "pg"
import type { Episode, MemoryQuery } from "./types.js"

// -----------------------------------------------------------------------------
// Episodic Memory Interface
// -----------------------------------------------------------------------------

export interface EpisodicMemory {
  record(input: RecordEpisodeInput): Promise<Episode>
  recall(episodeId: string): Promise<Episode | null>
  search(identityId: string, query: MemoryQuery): Promise<Episode[]>
  getRecent(identityId: string, limit?: number): Promise<Episode[]>
  consolidate(identityId: string): Promise<ConsolidationResult>
  forget(episodeId: string): Promise<void>
  updateImportance(episodeId: string, importance: number): Promise<void>
}

export interface RecordEpisodeInput {
  identity_id: string
  event_type: string
  content: Record<string, unknown>
  context?: Record<string, unknown>
  importance?: number
  emotional_valence?: number
}

export interface ConsolidationResult {
  episodes_processed: number
  memories_created: number
  episodes_archived: number
}

// -----------------------------------------------------------------------------
// Create Episodic Memory
// -----------------------------------------------------------------------------

export function createEpisodicMemory(pool: pg.Pool): EpisodicMemory {
  async function record(input: RecordEpisodeInput): Promise<Episode> {
    const episode: Episode = {
      episode_id: crypto.randomUUID(),
      identity_id: input.identity_id,
      event_type: input.event_type,
      content: input.content,
      context: input.context,
      timestamp: new Date().toISOString(),
      importance: input.importance ?? 0.5,
      emotional_valence: input.emotional_valence ?? 0,
      retrieval_count: 0,
    }

    await pool.query(
      `INSERT INTO events (
        event_id, identity_id, event_type, payload, timestamp,
        importance, emotional_valence, retrieval_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        episode.episode_id,
        episode.identity_id,
        episode.event_type,
        JSON.stringify({ content: episode.content, context: episode.context }),
        episode.timestamp,
        episode.importance,
        episode.emotional_valence,
        episode.retrieval_count,
      ]
    )

    return episode
  }

  async function recall(episodeId: string): Promise<Episode | null> {
    const result = await pool.query(
      `UPDATE events SET
        retrieval_count = retrieval_count + 1,
        last_retrieved = $1
       WHERE event_id = $2
       RETURNING *`,
      [new Date().toISOString(), episodeId]
    )

    if (result.rows.length === 0) return null

    return rowToEpisode(result.rows[0])
  }

  async function search(identityId: string, query: MemoryQuery): Promise<Episode[]> {
    let sql = "SELECT * FROM events WHERE identity_id = $1"
    const params: unknown[] = [identityId]
    let paramIndex = 2

    if (query.time_range) {
      sql += ` AND timestamp >= $${paramIndex} AND timestamp <= $${paramIndex + 1}`
      params.push(query.time_range.start, query.time_range.end)
      paramIndex += 2
    }

    if (query.min_importance !== undefined) {
      sql += ` AND importance >= $${paramIndex}`
      params.push(query.min_importance)
      paramIndex++
    }

    if (query.query) {
      sql += ` AND (payload::text ILIKE $${paramIndex} OR event_type ILIKE $${paramIndex})`
      params.push(`%${query.query}%`)
      paramIndex++
    }

    sql += ` ORDER BY timestamp DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`
    params.push(query.limit, query.offset)

    const result = await pool.query(sql, params)
    return result.rows.map(rowToEpisode)
  }

  async function getRecent(identityId: string, limit = 10): Promise<Episode[]> {
    const result = await pool.query(
      `SELECT * FROM events
       WHERE identity_id = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [identityId, limit]
    )

    return result.rows.map(rowToEpisode)
  }

  async function consolidate(identityId: string): Promise<ConsolidationResult> {
    // Get episodes older than 7 days with low retrieval
    const oldEpisodes = await pool.query(
      `SELECT * FROM events
       WHERE identity_id = $1
       AND timestamp < NOW() - INTERVAL '7 days'
       AND retrieval_count < 3
       AND importance < 0.5`,
      [identityId]
    )

    let memoriesCreated = 0
    let episodesArchived = 0

    // Group by event_type and summarize
    const byType = new Map<string, typeof oldEpisodes.rows>()
    for (const row of oldEpisodes.rows) {
      const existing = byType.get(row.event_type) ?? []
      existing.push(row)
      byType.set(row.event_type, existing)
    }

    for (const [eventType, episodes] of byType) {
      if (episodes.length >= 3) {
        // Create consolidated semantic memory
        await pool.query(
          `INSERT INTO semantic_memories (
            memory_id, identity_id, content, source_episode_ids,
            category, confidence, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [
            crypto.randomUUID(),
            identityId,
            `Summary of ${episodes.length} ${eventType} events`,
            JSON.stringify(episodes.map((e) => e.event_id)),
            eventType,
            0.7,
            new Date().toISOString(),
          ]
        )
        memoriesCreated++

        // Archive episodes
        await pool.query("UPDATE events SET archived = true WHERE event_id = ANY($1)", [
          episodes.map((e) => e.event_id),
        ])
        episodesArchived += episodes.length
      }
    }

    return {
      episodes_processed: oldEpisodes.rows.length,
      memories_created: memoriesCreated,
      episodes_archived: episodesArchived,
    }
  }

  async function forget(episodeId: string): Promise<void> {
    await pool.query("DELETE FROM events WHERE event_id = $1", [episodeId])
  }

  async function updateImportance(episodeId: string, importance: number): Promise<void> {
    await pool.query("UPDATE events SET importance = $1 WHERE event_id = $2", [
      Math.max(0, Math.min(1, importance)),
      episodeId,
    ])
  }

  return {
    record,
    recall,
    search,
    getRecent,
    consolidate,
    forget,
    updateImportance,
  }
}

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

function rowToEpisode(row: Record<string, unknown>): Episode {
  const payload = row.payload as Record<string, unknown> | undefined

  return {
    episode_id: row.event_id as string,
    identity_id: row.identity_id as string,
    event_type: row.event_type as string,
    content: (payload?.content as Record<string, unknown>) ?? {},
    context: payload?.context as Record<string, unknown> | undefined,
    timestamp: row.timestamp as string,
    importance: (row.importance as number) ?? 0.5,
    emotional_valence: (row.emotional_valence as number) ?? 0,
    retrieval_count: (row.retrieval_count as number) ?? 0,
    last_retrieved: row.last_retrieved as string | undefined,
  }
}
