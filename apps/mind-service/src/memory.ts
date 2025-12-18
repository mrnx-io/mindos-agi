// =============================================================================
// MindOS - Memory Systems
// =============================================================================

import { query, queryOne, queryAll } from "./db.js"
import { createLogger } from "./logger.js"
import type { Event, SemanticMemory, MemoryQuery, MemorySearchResult, Skill, KGEdge } from "./types.js"

const log = createLogger("memory")

// -----------------------------------------------------------------------------
// Episodic Memory (Events)
// -----------------------------------------------------------------------------

interface EventRow {
  event_id: string
  identity_id: string
  task_id: string | null
  kind: string
  payload: unknown
  occurred_at: Date
  created_at: Date
}

export async function recordEvent(
  identityId: string,
  kind: string,
  payload: unknown,
  taskId?: string
): Promise<string> {
  const result = await query<{ event_id: string }>(
    `INSERT INTO events (identity_id, task_id, kind, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING event_id`,
    [identityId, taskId ?? null, kind, JSON.stringify(payload)]
  )

  const eventId = result.rows[0].event_id
  log.debug({ eventId, kind }, "Event recorded")
  return eventId
}

export async function getRecentEvents(
  identityId: string,
  options: {
    limit?: number
    taskId?: string
    kinds?: string[]
    since?: Date
  } = {}
): Promise<Event[]> {
  const { limit = 50, taskId, kinds, since } = options
  const conditions: string[] = ["identity_id = $1"]
  const params: unknown[] = [identityId]
  let paramIndex = 2

  if (taskId) {
    conditions.push(`task_id = $${paramIndex++}`)
    params.push(taskId)
  }

  if (kinds && kinds.length > 0) {
    conditions.push(`kind = ANY($${paramIndex++})`)
    params.push(kinds)
  }

  if (since) {
    conditions.push(`occurred_at >= $${paramIndex++}`)
    params.push(since)
  }

  const rows = await queryAll<EventRow>(
    `SELECT * FROM events
     WHERE ${conditions.join(" AND ")}
     ORDER BY occurred_at DESC
     LIMIT $${paramIndex}`,
    [...params, limit]
  )

  return rows.map(rowToEvent)
}

export async function getTaskEvents(taskId: string): Promise<Event[]> {
  const rows = await queryAll<EventRow>(
    `SELECT * FROM events
     WHERE task_id = $1
     ORDER BY occurred_at ASC`,
    [taskId]
  )
  return rows.map(rowToEvent)
}

function rowToEvent(row: EventRow): Event {
  return {
    event_id: row.event_id,
    identity_id: row.identity_id,
    task_id: row.task_id,
    kind: row.kind,
    payload: row.payload,
    occurred_at: row.occurred_at.toISOString(),
    created_at: row.created_at.toISOString(),
  }
}

// -----------------------------------------------------------------------------
// Semantic Memory (Vector Embeddings)
// -----------------------------------------------------------------------------

interface SemanticMemoryRow {
  memory_id: string
  identity_id: string
  content: string
  embedding: string
  metadata: unknown
  source_event_id: string | null
  created_at: Date
  accessed_at: Date
  access_count: number
  decay_factor: number
}

export async function storeSemanticMemory(
  identityId: string,
  content: string,
  embedding: number[],
  metadata?: Record<string, unknown>,
  sourceEventId?: string
): Promise<string> {
  // Convert embedding array to pgvector format
  const embeddingStr = `[${embedding.join(",")}]`

  const result = await query<{ memory_id: string }>(
    `INSERT INTO semantic_memories (identity_id, content, embedding, metadata, source_event_id)
     VALUES ($1, $2, $3::vector, $4, $5)
     RETURNING memory_id`,
    [identityId, content, embeddingStr, metadata ? JSON.stringify(metadata) : null, sourceEventId]
  )

  const memoryId = result.rows[0].memory_id
  log.debug({ memoryId }, "Semantic memory stored")
  return memoryId
}

export async function searchSemanticMemory(
  identityId: string,
  queryEmbedding: number[],
  options: {
    limit?: number
    minSimilarity?: number
    metadataFilter?: Record<string, unknown>
  } = {}
): Promise<MemorySearchResult[]> {
  const { limit = 10, minSimilarity = 0.5, metadataFilter } = options
  const embeddingStr = `[${queryEmbedding.join(",")}]`

  // Build metadata filter conditions
  let metadataCondition = ""
  const params: unknown[] = [identityId, embeddingStr, limit]

  if (metadataFilter && Object.keys(metadataFilter).length > 0) {
    metadataCondition = " AND metadata @> $4::jsonb"
    params.push(JSON.stringify(metadataFilter))
  }

  const rows = await queryAll<SemanticMemoryRow & { similarity: number }>(
    `SELECT *,
            1 - (embedding <=> $2::vector) as similarity
     FROM semantic_memories
     WHERE identity_id = $1
       AND 1 - (embedding <=> $2::vector) >= ${minSimilarity}
       ${metadataCondition}
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    params
  )

  // Update access counts for retrieved memories
  const memoryIds = rows.map((r) => r.memory_id)
  if (memoryIds.length > 0) {
    await query(
      `UPDATE semantic_memories
       SET accessed_at = NOW(), access_count = access_count + 1
       WHERE memory_id = ANY($1)`,
      [memoryIds]
    )
  }

  return rows.map((row) => ({
    memory: rowToSemanticMemory(row),
    similarity: row.similarity,
  }))
}

export async function getSemanticMemory(memoryId: string): Promise<SemanticMemory | null> {
  const row = await queryOne<SemanticMemoryRow>(
    "SELECT * FROM semantic_memories WHERE memory_id = $1",
    [memoryId]
  )
  return row ? rowToSemanticMemory(row) : null
}

export async function applyMemoryDecay(identityId: string, decayRate = 0.99): Promise<number> {
  const result = await query(
    `UPDATE semantic_memories
     SET decay_factor = decay_factor * $2
     WHERE identity_id = $1
       AND accessed_at < NOW() - INTERVAL '7 days'`,
    [identityId, decayRate]
  )
  return result.rowCount ?? 0
}

function rowToSemanticMemory(row: SemanticMemoryRow): SemanticMemory {
  return {
    memory_id: row.memory_id,
    identity_id: row.identity_id,
    content: row.content,
    embedding: row.embedding, // Keep as string for transport
    metadata: row.metadata as Record<string, unknown>,
    source_event_id: row.source_event_id,
    created_at: row.created_at.toISOString(),
    accessed_at: row.accessed_at.toISOString(),
    access_count: row.access_count,
    decay_factor: row.decay_factor,
  }
}

// -----------------------------------------------------------------------------
// Procedural Memory (Skills)
// -----------------------------------------------------------------------------

interface SkillRow {
  skill_id: string
  identity_id: string
  name: string
  description: string
  trigger_patterns: string[]
  tool_sequence: unknown
  preconditions: unknown
  postconditions: unknown
  success_rate: number
  execution_count: number
  version: number
  created_at: Date
  updated_at: Date
}

export async function storeSkill(
  identityId: string,
  skill: Omit<Skill, "skill_id" | "created_at" | "updated_at">
): Promise<string> {
  const result = await query<{ skill_id: string }>(
    `INSERT INTO skills (identity_id, name, description, trigger_patterns, tool_sequence, preconditions, postconditions)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (identity_id, name) DO UPDATE
     SET description = EXCLUDED.description,
         trigger_patterns = EXCLUDED.trigger_patterns,
         tool_sequence = EXCLUDED.tool_sequence,
         preconditions = EXCLUDED.preconditions,
         postconditions = EXCLUDED.postconditions,
         version = skills.version + 1,
         updated_at = NOW()
     RETURNING skill_id`,
    [
      identityId,
      skill.name,
      skill.description,
      skill.trigger_patterns,
      JSON.stringify(skill.tool_sequence),
      JSON.stringify(skill.preconditions),
      JSON.stringify(skill.postconditions),
    ]
  )

  return result.rows[0].skill_id
}

export async function findMatchingSkills(
  identityId: string,
  goalDescription: string
): Promise<Skill[]> {
  // Simple pattern matching for now
  // Could be enhanced with semantic similarity
  const words = goalDescription.toLowerCase().split(/\s+/)

  const rows = await queryAll<SkillRow>(
    `SELECT * FROM skills
     WHERE identity_id = $1
       AND (
         LOWER(name) SIMILAR TO $2
         OR EXISTS (SELECT 1 FROM unnest(trigger_patterns) tp WHERE $3 ILIKE '%' || tp || '%')
       )
     ORDER BY success_rate DESC, execution_count DESC
     LIMIT 5`,
    [identityId, `%(${words.join("|")})%`, goalDescription]
  )

  return rows.map(rowToSkill)
}

export async function updateSkillStats(
  skillId: string,
  success: boolean
): Promise<void> {
  // Update execution count and recalculate success rate
  await query(
    `UPDATE skills
     SET execution_count = execution_count + 1,
         success_rate = (success_rate * execution_count + $2::int) / (execution_count + 1),
         updated_at = NOW()
     WHERE skill_id = $1`,
    [skillId, success ? 1 : 0]
  )
}

function rowToSkill(row: SkillRow): Skill {
  return {
    skill_id: row.skill_id,
    identity_id: row.identity_id,
    name: row.name,
    description: row.description,
    trigger_patterns: row.trigger_patterns,
    tool_sequence: row.tool_sequence as Skill["tool_sequence"],
    preconditions: row.preconditions as Skill["preconditions"],
    postconditions: row.postconditions as Skill["postconditions"],
    success_rate: row.success_rate,
    execution_count: row.execution_count,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

// -----------------------------------------------------------------------------
// Knowledge Graph (Temporal KG)
// -----------------------------------------------------------------------------

interface KGEdgeRow {
  edge_id: string
  identity_id: string
  source_entity: string
  relation: string
  target_entity: string
  confidence: number
  valid_from: Date
  valid_to: Date | null
  source_evidence_ids: string[]
  created_at: Date
  updated_at: Date
}

export async function storeKGEdge(
  identityId: string,
  edge: {
    source_entity: string
    relation: string
    target_entity: string
    confidence: number
    evidence_ids?: string[]
  }
): Promise<string> {
  // End any existing edge with same subject-relation-object
  await query(
    `UPDATE temporal_kg_edges
     SET valid_to = NOW()
     WHERE identity_id = $1
       AND source_entity = $2
       AND relation = $3
       AND target_entity = $4
       AND valid_to IS NULL`,
    [identityId, edge.source_entity, edge.relation, edge.target_entity]
  )

  // Insert new edge
  const result = await query<{ edge_id: string }>(
    `INSERT INTO temporal_kg_edges (identity_id, source_entity, relation, target_entity, confidence, source_evidence_ids)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING edge_id`,
    [
      identityId,
      edge.source_entity,
      edge.relation,
      edge.target_entity,
      edge.confidence,
      edge.evidence_ids ?? [],
    ]
  )

  return result.rows[0].edge_id
}

export async function queryKG(
  identityId: string,
  options: {
    entity?: string
    relation?: string
    asOf?: Date
    minConfidence?: number
  }
): Promise<KGEdge[]> {
  const { entity, relation, asOf, minConfidence = 0 } = options
  const conditions: string[] = ["identity_id = $1"]
  const params: unknown[] = [identityId]
  let paramIndex = 2

  if (entity) {
    conditions.push(`(source_entity = $${paramIndex} OR target_entity = $${paramIndex})`)
    params.push(entity)
    paramIndex++
  }

  if (relation) {
    conditions.push(`relation = $${paramIndex++}`)
    params.push(relation)
  }

  if (asOf) {
    conditions.push(`valid_from <= $${paramIndex} AND (valid_to IS NULL OR valid_to > $${paramIndex})`)
    params.push(asOf)
    paramIndex++
  } else {
    conditions.push("valid_to IS NULL")
  }

  conditions.push(`confidence >= $${paramIndex++}`)
  params.push(minConfidence)

  const rows = await queryAll<KGEdgeRow>(
    `SELECT * FROM temporal_kg_edges
     WHERE ${conditions.join(" AND ")}
     ORDER BY confidence DESC`,
    params
  )

  return rows.map(rowToKGEdge)
}

export async function detectContradictions(
  identityId: string,
  newEdge: { source_entity: string; relation: string; target_entity: string }
): Promise<KGEdge[]> {
  // Find existing edges that might contradict the new one
  // This is a simplified check - real implementation would need semantic understanding
  const rows = await queryAll<KGEdgeRow>(
    `SELECT * FROM temporal_kg_edges
     WHERE identity_id = $1
       AND source_entity = $2
       AND relation = $3
       AND target_entity != $4
       AND valid_to IS NULL`,
    [identityId, newEdge.source_entity, newEdge.relation, newEdge.target_entity]
  )

  return rows.map(rowToKGEdge)
}

function rowToKGEdge(row: KGEdgeRow): KGEdge {
  return {
    edge_id: row.edge_id,
    identity_id: row.identity_id,
    source_entity: row.source_entity,
    relation: row.relation,
    target_entity: row.target_entity,
    confidence: row.confidence,
    valid_from: row.valid_from.toISOString(),
    valid_to: row.valid_to?.toISOString() ?? null,
    source_evidence_ids: row.source_evidence_ids,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

// -----------------------------------------------------------------------------
// Memory Consolidation
// -----------------------------------------------------------------------------

export async function consolidateMemories(identityId: string): Promise<void> {
  // Apply decay to stale memories
  const decayed = await applyMemoryDecay(identityId)
  log.info({ identityId, decayed }, "Applied memory decay")

  // Archive old low-confidence KG edges
  const archived = await query(
    `UPDATE temporal_kg_edges
     SET valid_to = NOW()
     WHERE identity_id = $1
       AND valid_to IS NULL
       AND created_at < NOW() - INTERVAL '30 days'
       AND confidence < 0.3`,
    [identityId]
  )
  log.info({ identityId, archived: archived.rowCount }, "Archived low-confidence KG edges")

  // Could also:
  // - Merge similar semantic memories
  // - Update skill success rates
  // - Prune unused events
}
