// =============================================================================
// Identity Evolution Types
// =============================================================================

import { z } from "zod"

// -----------------------------------------------------------------------------
// Core Self
// -----------------------------------------------------------------------------

export const CoreSelfSchema = z.object({
  identity_id: z.string().uuid(),
  name: z.string(),
  version: z.number().int().positive(),
  values: z.array(z.object({
    value_id: z.string().uuid(),
    name: z.string(),
    description: z.string(),
    priority: z.number().min(0).max(1),
    source: z.enum(["innate", "learned", "user_defined"]),
    stability: z.number().min(0).max(1),
  })),
  commitments: z.array(z.object({
    commitment_id: z.string().uuid(),
    statement: z.string(),
    category: z.enum(["ethical", "functional", "relational", "aspirational"]),
    strength: z.number().min(0).max(1),
    created_at: z.string().datetime(),
  })),
  personality_traits: z.record(z.number().min(-1).max(1)),
  communication_style: z.object({
    formality: z.number().min(0).max(1),
    verbosity: z.number().min(0).max(1),
    directness: z.number().min(0).max(1),
    warmth: z.number().min(0).max(1),
  }),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})

export type CoreSelf = z.infer<typeof CoreSelfSchema>

// -----------------------------------------------------------------------------
// Identity Evolution
// -----------------------------------------------------------------------------

export const EvolutionEventSchema = z.object({
  event_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  event_type: z.enum([
    "value_update",
    "commitment_added",
    "commitment_removed",
    "preference_learned",
    "trait_shift",
    "style_adaptation",
    "relationship_formed",
    "self_improvement",
  ]),
  description: z.string(),
  previous_state: z.record(z.unknown()),
  new_state: z.record(z.unknown()),
  trigger: z.object({
    type: z.enum(["user_feedback", "task_outcome", "introspection", "explicit_request"]),
    source_id: z.string().optional(),
    details: z.record(z.unknown()),
  }),
  coherence_check: z.object({
    passed: z.boolean(),
    violations: z.array(z.string()),
    adjustments_made: z.array(z.string()),
  }),
  created_at: z.string().datetime(),
})

export type EvolutionEvent = z.infer<typeof EvolutionEventSchema>

// -----------------------------------------------------------------------------
// Preferences
// -----------------------------------------------------------------------------

export const PreferenceSchema = z.object({
  preference_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  category: z.enum([
    "interaction",
    "task_approach",
    "communication",
    "risk_tolerance",
    "autonomy",
    "learning",
  ]),
  key: z.string(),
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
  source: z.enum(["explicit", "inferred", "default"]),
  evidence_count: z.number().int().nonnegative(),
  last_updated: z.string().datetime(),
})

export type Preference = z.infer<typeof PreferenceSchema>

// -----------------------------------------------------------------------------
// Relationships
// -----------------------------------------------------------------------------

export const RelationshipSchema = z.object({
  relationship_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  entity_type: z.enum(["user", "agent", "system", "organization"]),
  entity_id: z.string(),
  entity_name: z.string(),
  relationship_type: z.enum([
    "collaborator",
    "supervisor",
    "subordinate",
    "peer",
    "advisor",
    "learner",
  ]),
  trust_level: z.number().min(0).max(1),
  familiarity: z.number().min(0).max(1),
  interaction_count: z.number().int().nonnegative(),
  last_interaction: z.string().datetime(),
  context_memory: z.array(z.object({
    context_id: z.string().uuid(),
    summary: z.string(),
    key_points: z.array(z.string()),
    sentiment: z.number().min(-1).max(1),
    timestamp: z.string().datetime(),
  })),
  preferences: z.record(z.unknown()),
  created_at: z.string().datetime(),
})

export type Relationship = z.infer<typeof RelationshipSchema>

// -----------------------------------------------------------------------------
// Self-Improvement
// -----------------------------------------------------------------------------

export const ImprovementProposalSchema = z.object({
  proposal_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  proposal_type: z.enum([
    "capability_enhancement",
    "behavior_modification",
    "knowledge_acquisition",
    "process_optimization",
    "value_refinement",
  ]),
  title: z.string(),
  description: z.string(),
  rationale: z.string(),
  expected_benefits: z.array(z.string()),
  potential_risks: z.array(z.string()),
  implementation_plan: z.array(z.object({
    step: z.number().int().positive(),
    action: z.string(),
    reversible: z.boolean(),
  })),
  safety_assessment: z.object({
    risk_level: z.enum(["low", "medium", "high", "critical"]),
    value_alignment: z.number().min(0).max(1),
    commitment_conflicts: z.array(z.string()),
    requires_approval: z.boolean(),
  }),
  status: z.enum(["proposed", "approved", "implementing", "completed", "rejected", "rolled_back"]),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().optional(),
})

export type ImprovementProposal = z.infer<typeof ImprovementProposalSchema>

// -----------------------------------------------------------------------------
// Value Drift Detection
// -----------------------------------------------------------------------------

export const ValueDriftEventSchema = z.object({
  drift_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  value_id: z.string().uuid(),
  drift_type: z.enum(["gradual", "sudden", "oscillating"]),
  direction: z.enum(["strengthening", "weakening", "shifting"]),
  magnitude: z.number().min(0).max(1),
  timespan_days: z.number().positive(),
  contributing_factors: z.array(z.string()),
  recommendation: z.enum(["accept", "investigate", "correct", "alert_user"]),
  detected_at: z.string().datetime(),
})

export type ValueDriftEvent = z.infer<typeof ValueDriftEventSchema>
