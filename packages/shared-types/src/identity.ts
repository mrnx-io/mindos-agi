// =============================================================================
// MindOS - Identity Types
// =============================================================================

import { z } from "zod"
import { PolicyProfileSchema } from "./policy.js"
import { JSONSchema, TimestampSchema, UUIDSchema } from "./schemas.js"

// -----------------------------------------------------------------------------
// Core Self (Autobiographical)
// -----------------------------------------------------------------------------

export const CoreSelfSchema = z.object({
  values: z
    .array(
      z.object({
        name: z.string(),
        importance: z.number().min(0).max(1),
        description: z.string(),
      })
    )
    .default([]),

  goals: z
    .array(
      z.object({
        name: z.string(),
        priority: z.number().min(0).max(10),
        description: z.string(),
        deadline: TimestampSchema.optional(),
        progress: z.number().min(0).max(1).optional(),
      })
    )
    .default([]),

  constraints: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(["hard", "soft"]),
        description: z.string(),
        reason: z.string().optional(),
      })
    )
    .default([]),

  personality_traits: z.record(z.number().min(-1).max(1)).default({}),

  trust_defaults: z
    .object({
      new_tools: z.number().min(0).max(1).default(0.5),
      external_data: z.number().min(0).max(1).default(0.7),
      human_input: z.number().min(0).max(1).default(0.9),
      swarm_agents: z.number().min(0).max(1).default(0.8),
    })
    .default({}),
})
export type CoreSelf = z.infer<typeof CoreSelfSchema>

// -----------------------------------------------------------------------------
// Identity
// -----------------------------------------------------------------------------

export const IdentitySchema = z.object({
  identity_id: UUIDSchema,
  display_name: z.string(),
  core_self: CoreSelfSchema,
  policy_profile: PolicyProfileSchema,
  metadata: JSONSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
})
export type Identity = z.infer<typeof IdentitySchema>

// -----------------------------------------------------------------------------
// Identity Evolution
// -----------------------------------------------------------------------------

export const EvolutionKindSchema = z.enum([
  "value_update",
  "goal_update",
  "constraint_update",
  "preference_learned",
  "relationship_formed",
  "capability_gained",
  "capability_deprecated",
  "personality_drift",
  "coherence_correction",
])
export type EvolutionKind = z.infer<typeof EvolutionKindSchema>

export const EvolutionTriggerSchema = z.enum([
  "task_outcome",
  "explicit_instruction",
  "reflection",
  "metacognitive",
  "swarm_consensus",
  "human_feedback",
  "coherence_check",
])
export type EvolutionTrigger = z.infer<typeof EvolutionTriggerSchema>

export const IdentityEvolutionSchema = z.object({
  evolution_id: UUIDSchema,
  identity_id: UUIDSchema,
  kind: EvolutionKindSchema,
  field_path: z.string(),
  old_value: JSONSchema.nullable(),
  new_value: JSONSchema,
  trigger_type: EvolutionTriggerSchema,
  trigger_reference: z.string().nullable().optional(),
  requires_approval: z.boolean(),
  approved_at: TimestampSchema.nullable().optional(),
  approved_by: z.string().nullable().optional(),
  rolled_back_at: TimestampSchema.nullable().optional(),
  rollback_reason: z.string().nullable().optional(),
  created_at: TimestampSchema,
})
export type IdentityEvolution = z.infer<typeof IdentityEvolutionSchema>

// -----------------------------------------------------------------------------
// Coherence Check
// -----------------------------------------------------------------------------

export const CoherenceIssueSchema = z.object({
  type: z.enum(["contradiction", "gap", "outdated", "inconsistent"]),
  description: z.string(),
  affected_fields: z.array(z.string()),
  severity: z.enum(["low", "medium", "high"]),
  suggested_resolution: z.string().optional(),
})
export type CoherenceIssue = z.infer<typeof CoherenceIssueSchema>

export const CoherenceCheckResultSchema = z.object({
  identity_id: UUIDSchema,
  is_coherent: z.boolean(),
  overall_score: z.number().min(0).max(1),
  issues: z.array(CoherenceIssueSchema),
  checked_at: TimestampSchema,
})
export type CoherenceCheckResult = z.infer<typeof CoherenceCheckResultSchema>

// -----------------------------------------------------------------------------
// Relationship Memory
// -----------------------------------------------------------------------------

export const RelationshipSchema = z.object({
  entity_id: z.string(),
  entity_type: z.enum(["human", "tool", "service", "agent"]),
  name: z.string(),
  relationship_type: z.string(),
  trust_level: z.number().min(0).max(1),
  interaction_count: z.number().int().min(0),
  last_interaction: TimestampSchema.nullable().optional(),
  notes: z.array(z.string()).default([]),
  preferences: JSONSchema.default({}),
})
export type Relationship = z.infer<typeof RelationshipSchema>
