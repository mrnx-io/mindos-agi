// =============================================================================
// Relationship Memory System
// =============================================================================

import type pg from "pg"
import type { Relationship } from "./types.js"

// -----------------------------------------------------------------------------
// Relationship Manager Interface
// -----------------------------------------------------------------------------

export interface RelationshipManager {
  getRelationship(identityId: string, entityId: string): Promise<Relationship | null>
  getAllRelationships(identityId: string): Promise<Relationship[]>
  createRelationship(
    relationship: Omit<Relationship, "relationship_id" | "created_at">
  ): Promise<Relationship>
  updateRelationship(relationshipId: string, updates: Partial<Relationship>): Promise<Relationship>
  recordInteraction(relationshipId: string, interaction: Interaction): Promise<void>
  recallContext(relationshipId: string, query?: string): Promise<ContextMemory[]>
  decayRelationships(identityId: string): Promise<number>
}

export interface Interaction {
  interaction_id: string
  summary: string
  key_points: string[]
  sentiment: number
  topics: string[]
  duration_ms?: number
  outcome?: "positive" | "neutral" | "negative"
  timestamp: string
}

export interface ContextMemory {
  context_id: string
  summary: string
  key_points: string[]
  sentiment: number
  timestamp: string
  relevance_score?: number
}

// -----------------------------------------------------------------------------
// Create Relationship Manager
// -----------------------------------------------------------------------------

export function createRelationshipManager(pool: pg.Pool): RelationshipManager {
  async function getRelationship(
    identityId: string,
    entityId: string
  ): Promise<Relationship | null> {
    const result = await pool.query(
      "SELECT * FROM relationships WHERE identity_id = $1 AND entity_id = $2",
      [identityId, entityId]
    )

    if (result.rows.length === 0) return null

    const row = result.rows[0]
    return {
      relationship_id: row.relationship_id,
      identity_id: row.identity_id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      entity_name: row.entity_name,
      relationship_type: row.relationship_type,
      trust_level: row.trust_level,
      familiarity: row.familiarity,
      interaction_count: row.interaction_count,
      last_interaction: row.last_interaction,
      context_memory: row.context_memory ?? [],
      preferences: row.preferences ?? {},
      created_at: row.created_at,
    }
  }

  async function getAllRelationships(identityId: string): Promise<Relationship[]> {
    const result = await pool.query(
      "SELECT * FROM relationships WHERE identity_id = $1 ORDER BY last_interaction DESC",
      [identityId]
    )

    return result.rows.map((row) => ({
      relationship_id: row.relationship_id,
      identity_id: row.identity_id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      entity_name: row.entity_name,
      relationship_type: row.relationship_type,
      trust_level: row.trust_level,
      familiarity: row.familiarity,
      interaction_count: row.interaction_count,
      last_interaction: row.last_interaction,
      context_memory: row.context_memory ?? [],
      preferences: row.preferences ?? {},
      created_at: row.created_at,
    }))
  }

  async function createRelationship(
    relationship: Omit<Relationship, "relationship_id" | "created_at">
  ): Promise<Relationship> {
    const fullRelationship: Relationship = {
      ...relationship,
      relationship_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    }

    await pool.query(
      `INSERT INTO relationships (
        relationship_id, identity_id, entity_type, entity_id, entity_name,
        relationship_type, trust_level, familiarity, interaction_count,
        last_interaction, context_memory, preferences, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        fullRelationship.relationship_id,
        fullRelationship.identity_id,
        fullRelationship.entity_type,
        fullRelationship.entity_id,
        fullRelationship.entity_name,
        fullRelationship.relationship_type,
        fullRelationship.trust_level,
        fullRelationship.familiarity,
        fullRelationship.interaction_count,
        fullRelationship.last_interaction,
        JSON.stringify(fullRelationship.context_memory),
        JSON.stringify(fullRelationship.preferences),
        fullRelationship.created_at,
      ]
    )

    return fullRelationship
  }

  async function updateRelationship(
    relationshipId: string,
    updates: Partial<Relationship>
  ): Promise<Relationship> {
    const result = await pool.query("SELECT * FROM relationships WHERE relationship_id = $1", [
      relationshipId,
    ])

    if (result.rows.length === 0) {
      throw new Error(`Relationship ${relationshipId} not found`)
    }

    const current = result.rows[0]

    const updated: Relationship = {
      relationship_id: current.relationship_id,
      identity_id: current.identity_id,
      entity_type: updates.entity_type ?? current.entity_type,
      entity_id: current.entity_id,
      entity_name: updates.entity_name ?? current.entity_name,
      relationship_type: updates.relationship_type ?? current.relationship_type,
      trust_level: updates.trust_level ?? current.trust_level,
      familiarity: updates.familiarity ?? current.familiarity,
      interaction_count: updates.interaction_count ?? current.interaction_count,
      last_interaction: updates.last_interaction ?? current.last_interaction,
      context_memory: updates.context_memory ?? current.context_memory ?? [],
      preferences: updates.preferences ?? current.preferences ?? {},
      created_at: current.created_at,
    }

    await pool.query(
      `UPDATE relationships SET
        entity_name = $1,
        relationship_type = $2,
        trust_level = $3,
        familiarity = $4,
        interaction_count = $5,
        last_interaction = $6,
        context_memory = $7,
        preferences = $8
      WHERE relationship_id = $9`,
      [
        updated.entity_name,
        updated.relationship_type,
        updated.trust_level,
        updated.familiarity,
        updated.interaction_count,
        updated.last_interaction,
        JSON.stringify(updated.context_memory),
        JSON.stringify(updated.preferences),
        relationshipId,
      ]
    )

    return updated
  }

  async function recordInteraction(
    relationshipId: string,
    interaction: Interaction
  ): Promise<void> {
    const result = await pool.query("SELECT * FROM relationships WHERE relationship_id = $1", [
      relationshipId,
    ])

    if (result.rows.length === 0) {
      throw new Error(`Relationship ${relationshipId} not found`)
    }

    const relationship = result.rows[0]
    const contextMemory: ContextMemory[] = relationship.context_memory ?? []

    // Add new context memory
    contextMemory.unshift({
      context_id: interaction.interaction_id,
      summary: interaction.summary,
      key_points: interaction.key_points,
      sentiment: interaction.sentiment,
      timestamp: interaction.timestamp,
    })

    // Keep only recent memories (max 50)
    const trimmedMemory = contextMemory.slice(0, 50)

    // Update trust and familiarity based on interaction
    let trustDelta = 0
    let familiarityDelta = 0.05 // Small increase per interaction

    switch (interaction.outcome) {
      case "positive":
        trustDelta = 0.05
        familiarityDelta = 0.1
        break
      case "negative":
        trustDelta = -0.1
        break
      default:
        trustDelta = 0.01
        break
    }

    const newTrust = Math.min(1, Math.max(0, relationship.trust_level + trustDelta))
    const newFamiliarity = Math.min(1, relationship.familiarity + familiarityDelta)

    await pool.query(
      `UPDATE relationships SET
        trust_level = $1,
        familiarity = $2,
        interaction_count = interaction_count + 1,
        last_interaction = $3,
        context_memory = $4
      WHERE relationship_id = $5`,
      [
        newTrust,
        newFamiliarity,
        interaction.timestamp,
        JSON.stringify(trimmedMemory),
        relationshipId,
      ]
    )
  }

  async function recallContext(relationshipId: string, query?: string): Promise<ContextMemory[]> {
    const result = await pool.query(
      "SELECT context_memory FROM relationships WHERE relationship_id = $1",
      [relationshipId]
    )

    if (result.rows.length === 0) return []

    const contextMemory: ContextMemory[] = result.rows[0].context_memory ?? []

    if (!query) {
      // Return most recent memories
      return contextMemory.slice(0, 10)
    }

    // Search for relevant memories
    const queryTerms = query.toLowerCase().split(/\s+/)

    const scored = contextMemory.map((memory) => {
      const text = `${memory.summary} ${memory.key_points.join(" ")}`.toLowerCase()
      let score = 0

      for (const term of queryTerms) {
        if (text.includes(term)) {
          score += 1
        }
      }

      return {
        ...memory,
        relevance_score: score / queryTerms.length,
      }
    })

    return scored
      .filter((m) => m.relevance_score > 0)
      .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
      .slice(0, 10)
  }

  async function decayRelationships(identityId: string): Promise<number> {
    const now = Date.now()
    const oneMonthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()

    // Find stale relationships
    const staleResult = await pool.query(
      `SELECT * FROM relationships
       WHERE identity_id = $1 AND last_interaction < $2`,
      [identityId, oneMonthAgo]
    )

    let decayedCount = 0

    for (const relationship of staleResult.rows) {
      // Calculate decay based on time since last interaction
      const lastInteraction = new Date(relationship.last_interaction).getTime()
      const daysSinceInteraction = (now - lastInteraction) / (24 * 60 * 60 * 1000)

      // Decay factor: 1% per day after 30 days
      const decayFactor = Math.max(0, 1 - (daysSinceInteraction - 30) * 0.01)

      if (decayFactor < relationship.familiarity) {
        const newFamiliarity = Math.max(0.1, relationship.familiarity * decayFactor)
        const newTrust = Math.max(0.1, relationship.trust_level * (decayFactor + 0.2)) // Trust decays slower

        await pool.query(
          `UPDATE relationships SET
            familiarity = $1,
            trust_level = $2
          WHERE relationship_id = $3`,
          [newFamiliarity, newTrust, relationship.relationship_id]
        )

        decayedCount++
      }
    }

    return decayedCount
  }

  return {
    getRelationship,
    getAllRelationships,
    createRelationship,
    updateRelationship,
    recordInteraction,
    recallContext,
    decayRelationships,
  }
}

// -----------------------------------------------------------------------------
// Relationship Insights
// -----------------------------------------------------------------------------

export interface RelationshipInsights {
  total_relationships: number
  by_type: Record<string, number>
  avg_trust: number
  avg_familiarity: number
  most_trusted: Relationship | null
  most_familiar: Relationship | null
  most_active: Relationship | null
  needs_attention: Relationship[]
}

export function analyzeRelationships(relationships: Relationship[]): RelationshipInsights {
  if (relationships.length === 0) {
    return {
      total_relationships: 0,
      by_type: {},
      avg_trust: 0,
      avg_familiarity: 0,
      most_trusted: null,
      most_familiar: null,
      most_active: null,
      needs_attention: [],
    }
  }

  // Count by type
  const byType = relationships.reduce(
    (acc, r) => {
      acc[r.relationship_type] = (acc[r.relationship_type] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>
  )

  // Calculate averages
  const avgTrust = relationships.reduce((sum, r) => sum + r.trust_level, 0) / relationships.length
  const avgFamiliarity =
    relationships.reduce((sum, r) => sum + r.familiarity, 0) / relationships.length

  // Find extremes
  const mostTrusted = relationships.reduce(
    (best, r) => (r.trust_level > (best?.trust_level ?? 0) ? r : best),
    null as Relationship | null
  )

  const mostFamiliar = relationships.reduce(
    (best, r) => (r.familiarity > (best?.familiarity ?? 0) ? r : best),
    null as Relationship | null
  )

  const mostActive = relationships.reduce(
    (best, r) => (r.interaction_count > (best?.interaction_count ?? 0) ? r : best),
    null as Relationship | null
  )

  // Find relationships needing attention
  const now = Date.now()
  const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000

  const needsAttention = relationships.filter((r) => {
    const lastInteraction = new Date(r.last_interaction).getTime()
    const isStale = lastInteraction < twoWeeksAgo
    const isImportant = r.trust_level > 0.7 || r.familiarity > 0.7

    return isStale && isImportant
  })

  return {
    total_relationships: relationships.length,
    by_type: byType,
    avg_trust: avgTrust,
    avg_familiarity: avgFamiliarity,
    most_trusted: mostTrusted,
    most_familiar: mostFamiliar,
    most_active: mostActive,
    needs_attention: needsAttention,
  }
}

// -----------------------------------------------------------------------------
// Relationship Context Builder
// -----------------------------------------------------------------------------

export interface RelationshipContext {
  relationship: Relationship
  recent_memories: ContextMemory[]
  communication_preferences: Record<string, unknown>
  interaction_patterns: InteractionPattern[]
  suggested_topics: string[]
}

export interface InteractionPattern {
  pattern_type: "frequency" | "timing" | "topic" | "sentiment"
  description: string
  value: unknown
}

export async function buildRelationshipContext(
  manager: RelationshipManager,
  identityId: string,
  entityId: string
): Promise<RelationshipContext | null> {
  const relationship = await manager.getRelationship(identityId, entityId)
  if (!relationship) return null

  const recentMemories = await manager.recallContext(relationship.relationship_id)

  // Analyze interaction patterns
  const patterns = analyzeInteractionPatterns(relationship, recentMemories)

  // Suggest topics based on past interactions
  const suggestedTopics = extractSuggestedTopics(recentMemories)

  return {
    relationship,
    recent_memories: recentMemories,
    communication_preferences: relationship.preferences,
    interaction_patterns: patterns,
    suggested_topics: suggestedTopics,
  }
}

function analyzeInteractionPatterns(
  relationship: Relationship,
  memories: ContextMemory[]
): InteractionPattern[] {
  const patterns: InteractionPattern[] = []

  // Frequency pattern
  if (relationship.interaction_count > 10) {
    const avgPerMonth =
      relationship.interaction_count /
      ((Date.now() - new Date(relationship.created_at).getTime()) / (30 * 24 * 60 * 60 * 1000))

    patterns.push({
      pattern_type: "frequency",
      description: `Average ${avgPerMonth.toFixed(1)} interactions per month`,
      value: avgPerMonth,
    })
  }

  // Sentiment pattern
  if (memories.length > 0) {
    const avgSentiment = memories.reduce((sum, m) => sum + m.sentiment, 0) / memories.length

    patterns.push({
      pattern_type: "sentiment",
      description:
        avgSentiment > 0.3
          ? "Generally positive interactions"
          : avgSentiment < -0.3
            ? "Often challenging interactions"
            : "Neutral/mixed interactions",
      value: avgSentiment,
    })
  }

  // Topic pattern
  const allKeyPoints = memories.flatMap((m) => m.key_points)
  const topicCounts = allKeyPoints.reduce(
    (acc, topic) => {
      const normalized = topic.toLowerCase()
      acc[normalized] = (acc[normalized] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>
  )

  const topTopics = Object.entries(topicCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([topic]) => topic)

  if (topTopics.length > 0) {
    patterns.push({
      pattern_type: "topic",
      description: `Common topics: ${topTopics.join(", ")}`,
      value: topTopics,
    })
  }

  return patterns
}

function extractSuggestedTopics(memories: ContextMemory[]): string[] {
  if (memories.length === 0) return []

  // Extract key points from recent positive interactions
  const positiveMemories = memories.filter((m) => m.sentiment > 0)
  const keyPoints = positiveMemories.flatMap((m) => m.key_points)

  // Count occurrences
  const topicCounts = keyPoints.reduce(
    (acc, point) => {
      const words = point
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 4)
      for (const word of words) {
        acc[word] = (acc[word] ?? 0) + 1
      }
      return acc
    },
    {} as Record<string, number>
  )

  // Return top topics
  return Object.entries(topicCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([topic]) => topic)
}
