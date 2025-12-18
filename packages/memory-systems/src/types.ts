// =============================================================================
// Memory Systems Types
// =============================================================================

import { z } from "zod"

// -----------------------------------------------------------------------------
// Episodic Memory Types
// -----------------------------------------------------------------------------

export const EpisodeSchema = z.object({
  episode_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  event_type: z.string(),
  content: z.record(z.unknown()),
  context: z.record(z.unknown()).optional(),
  timestamp: z.string().datetime(),
  importance: z.number().min(0).max(1).default(0.5),
  emotional_valence: z.number().min(-1).max(1).default(0),
  retrieval_count: z.number().int().default(0),
  last_retrieved: z.string().datetime().optional(),
})

export type Episode = z.infer<typeof EpisodeSchema>

// -----------------------------------------------------------------------------
// Semantic Memory Types
// -----------------------------------------------------------------------------

export const SemanticMemorySchema = z.object({
  memory_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  content: z.string(),
  embedding: z.array(z.number()).optional(),
  source_episode_ids: z.array(z.string().uuid()).default([]),
  category: z.string().optional(),
  tags: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})

export type SemanticMemory = z.infer<typeof SemanticMemorySchema>

// -----------------------------------------------------------------------------
// Procedural Memory Types
// -----------------------------------------------------------------------------

export const ProcedureSchema = z.object({
  procedure_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  trigger_conditions: z.array(z.string()),
  steps: z.array(
    z.object({
      step_number: z.number().int(),
      action: z.string(),
      parameters: z.record(z.unknown()).optional(),
      expected_outcome: z.string().optional(),
    })
  ),
  success_rate: z.number().min(0).max(1).default(0.5),
  execution_count: z.number().int().default(0),
  last_executed: z.string().datetime().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})

export type Procedure = z.infer<typeof ProcedureSchema>

// -----------------------------------------------------------------------------
// Autobiographical Memory Types
// -----------------------------------------------------------------------------

export const LifeEventSchema = z.object({
  event_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  event_type: z.enum([
    "milestone",
    "turning_point",
    "lesson_learned",
    "relationship_change",
    "capability_gain",
    "value_shift",
  ]),
  title: z.string(),
  narrative: z.string(),
  significance: z.number().min(0).max(1),
  related_episodes: z.array(z.string().uuid()).default([]),
  impact_on_identity: z.record(z.unknown()).optional(),
  timestamp: z.string().datetime(),
})

export type LifeEvent = z.infer<typeof LifeEventSchema>

export const IdentityNarrativeSchema = z.object({
  narrative_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  version: z.number().int(),
  core_narrative: z.string(),
  key_themes: z.array(z.string()),
  life_events: z.array(z.string().uuid()),
  self_concept: z.record(z.unknown()),
  values: z.array(z.string()),
  goals: z.array(z.string()),
  created_at: z.string().datetime(),
})

export type IdentityNarrative = z.infer<typeof IdentityNarrativeSchema>

// -----------------------------------------------------------------------------
// Memory Query Types
// -----------------------------------------------------------------------------

export const MemoryQuerySchema = z.object({
  query: z.string().optional(),
  embedding: z.array(z.number()).optional(),
  time_range: z
    .object({
      start: z.string().datetime(),
      end: z.string().datetime(),
    })
    .optional(),
  categories: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  min_importance: z.number().min(0).max(1).optional(),
  min_confidence: z.number().min(0).max(1).optional(),
  limit: z.number().int().positive().default(10),
  offset: z.number().int().nonnegative().default(0),
})

export type MemoryQuery = z.infer<typeof MemoryQuerySchema>

export const MemorySearchResultSchema = z.object({
  memory_id: z.string(),
  memory_type: z.enum(["episodic", "semantic", "procedural", "autobiographical"]),
  content: z.unknown(),
  similarity_score: z.number().min(0).max(1).optional(),
  timestamp: z.string().datetime(),
})

export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>
