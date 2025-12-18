// =============================================================================
// MindOS - Memory Types
// =============================================================================

import { z } from "zod"
import { UUIDSchema, TimestampSchema, JSONSchema } from "./schemas.js"

// -----------------------------------------------------------------------------
// Memory Kinds
// -----------------------------------------------------------------------------

export const MemoryKindSchema = z.enum([
  "semantic",     // Factual knowledge
  "procedural",   // Skills and procedures
  "constraint",   // Rules and limitations
  "preference",   // Learned preferences
  "relationship", // Entity relationships
])
export type MemoryKind = z.infer<typeof MemoryKindSchema>

// -----------------------------------------------------------------------------
// Semantic Memory
// -----------------------------------------------------------------------------

export const SemanticMemorySchema = z.object({
  memory_id: UUIDSchema,
  identity_id: UUIDSchema,
  kind: MemoryKindSchema,
  text: z.string(),
  embedding: z.array(z.number()).optional(), // Vector embedding
  meta: JSONSchema,
  confidence: z.number().min(0).max(1),
  access_count: z.number().int().min(0),
  last_accessed_at: TimestampSchema.nullable().optional(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
})
export type SemanticMemory = z.infer<typeof SemanticMemorySchema>

// -----------------------------------------------------------------------------
// Memory Query
// -----------------------------------------------------------------------------

export const MemoryQuerySchema = z.object({
  identity_id: UUIDSchema,
  query: z.string(),
  k: z.number().int().min(1).max(100).optional().default(8),
  kind: MemoryKindSchema.optional(),
  min_confidence: z.number().min(0).max(1).optional(),
  include_embeddings: z.boolean().optional().default(false),
})
export type MemoryQuery = z.infer<typeof MemoryQuerySchema>

export const MemorySearchResultSchema = z.object({
  memory_id: UUIDSchema,
  text: z.string(),
  kind: MemoryKindSchema,
  score: z.number(), // Similarity score
  confidence: z.number(),
  meta: JSONSchema,
})
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>

// -----------------------------------------------------------------------------
// Memory Operations
// -----------------------------------------------------------------------------

export const AddMemoryRequestSchema = z.object({
  identity_id: UUIDSchema,
  kind: MemoryKindSchema,
  text: z.string(),
  meta: JSONSchema.optional().default({}),
  confidence: z.number().min(0).max(1).optional().default(1.0),
  source_task_id: UUIDSchema.optional(),
  source_evidence_id: UUIDSchema.optional(),
})
export type AddMemoryRequest = z.infer<typeof AddMemoryRequestSchema>

export const UpdateMemoryRequestSchema = z.object({
  memory_id: UUIDSchema,
  text: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  meta: JSONSchema.optional(),
})
export type UpdateMemoryRequest = z.infer<typeof UpdateMemoryRequestSchema>

// -----------------------------------------------------------------------------
// Memory Decay
// -----------------------------------------------------------------------------

export const MemoryDecayConfigSchema = z.object({
  enabled: z.boolean().default(true),
  decay_rate: z.number().min(0).max(1).default(0.01), // Per day
  min_confidence: z.number().min(0).max(1).default(0.1),
  access_boost: z.number().min(0).max(1).default(0.1), // Confidence boost on access
  reinforcement_threshold: z.number().int().min(1).default(3), // Accesses before permanent
})
export type MemoryDecayConfig = z.infer<typeof MemoryDecayConfigSchema>

// -----------------------------------------------------------------------------
// Episodic Memory (Events)
// -----------------------------------------------------------------------------

export const EpisodicQuerySchema = z.object({
  identity_id: UUIDSchema,
  start_time: TimestampSchema.optional(),
  end_time: TimestampSchema.optional(),
  sources: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(1000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
})
export type EpisodicQuery = z.infer<typeof EpisodicQuerySchema>

// -----------------------------------------------------------------------------
// Procedural Memory (Skills)
// -----------------------------------------------------------------------------

export const SkillSchema = z.object({
  skill_id: UUIDSchema,
  identity_id: UUIDSchema,
  name: z.string(),
  version: z.string(),
  description: z.string(),
  triggers: z.array(z.string()), // When to use this skill
  procedure: z.string(), // The actual skill content/instructions
  examples: z.array(z.object({
    input: z.string(),
    output: z.string(),
  })).optional(),
  performance_stats: z.object({
    uses: z.number().int(),
    successes: z.number().int(),
    avg_duration_ms: z.number().optional(),
  }).optional(),
  deprecated: z.boolean().default(false),
  superseded_by: UUIDSchema.optional(),
})
export type Skill = z.infer<typeof SkillSchema>

// -----------------------------------------------------------------------------
// Knowledge Graph Memory
// -----------------------------------------------------------------------------

export const KGEdgeSchema = z.object({
  edge_id: UUIDSchema,
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  confidence: z.number().min(0).max(1),
  valid_from: TimestampSchema,
  valid_until: TimestampSchema.nullable().optional(),
  source_type: z.string(),
  source_reference: z.string().optional(),
})
export type KGEdge = z.infer<typeof KGEdgeSchema>

export const KGQuerySchema = z.object({
  identity_id: UUIDSchema,
  subject: z.string().optional(),
  predicate: z.string().optional(),
  object: z.string().optional(),
  include_historical: z.boolean().optional().default(false),
  min_confidence: z.number().min(0).max(1).optional(),
})
export type KGQuery = z.infer<typeof KGQuerySchema>
