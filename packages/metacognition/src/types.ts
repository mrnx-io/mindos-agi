// =============================================================================
// Metacognition Types
// =============================================================================

import { z } from "zod"

// -----------------------------------------------------------------------------
// Self-Observation
// -----------------------------------------------------------------------------

export const SelfObservationSchema = z.object({
  observation_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  observation_type: z.enum([
    "cognitive_state",
    "emotional_state",
    "performance_metric",
    "resource_usage",
    "decision_quality",
    "belief_update",
  ]),
  content: z.record(z.unknown()),
  timestamp: z.string().datetime(),
  context: z.object({
    current_task: z.string().optional(),
    recent_actions: z.array(z.string()),
    environmental_factors: z.record(z.unknown()),
  }),
})

export type SelfObservation = z.infer<typeof SelfObservationSchema>

// -----------------------------------------------------------------------------
// Confidence Assessment
// -----------------------------------------------------------------------------

export const ConfidenceIntervalSchema = z.object({
  assessment_id: z.string().uuid(),
  subject: z.string(),
  point_estimate: z.number().min(0).max(1),
  lower_bound: z.number().min(0).max(1),
  upper_bound: z.number().min(0).max(1),
  distribution_type: z.enum(["normal", "beta", "uniform", "unknown"]),
  sample_size: z.number().int().nonnegative(),
  calibration_factor: z.number().min(0).max(2),
  reasoning: z.string(),
  created_at: z.string().datetime(),
})

export type ConfidenceInterval = z.infer<typeof ConfidenceIntervalSchema>

// -----------------------------------------------------------------------------
// Hypothesis Generation
// -----------------------------------------------------------------------------

export const HypothesisSchema = z.object({
  hypothesis_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  triggered_by: z.string().uuid(), // Failure event ID
  hypothesis_type: z.enum([
    "root_cause",
    "improvement",
    "alternative_approach",
    "missing_capability",
    "environmental_factor",
  ]),
  statement: z.string(),
  supporting_evidence: z.array(z.string()),
  contradicting_evidence: z.array(z.string()),
  prior_probability: z.number().min(0).max(1),
  posterior_probability: z.number().min(0).max(1).optional(),
  testable_predictions: z.array(z.string()),
  status: z.enum(["proposed", "testing", "confirmed", "rejected", "inconclusive"]),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().optional(),
})

export type Hypothesis = z.infer<typeof HypothesisSchema>

// -----------------------------------------------------------------------------
// Introspection
// -----------------------------------------------------------------------------

export const IntrospectionTriggerSchema = z.object({
  trigger_type: z.enum([
    "scheduled",
    "failure_detected",
    "uncertainty_threshold",
    "performance_degradation",
    "user_request",
    "belief_conflict",
  ]),
  trigger_source: z.string(),
  urgency: z.enum(["low", "medium", "high", "critical"]),
  context: z.record(z.unknown()),
})

export type IntrospectionTrigger = z.infer<typeof IntrospectionTriggerSchema>

export const IntrospectionResultSchema = z.object({
  introspection_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  trigger: IntrospectionTriggerSchema,
  observations: z.array(SelfObservationSchema),
  insights: z.array(z.object({
    insight_id: z.string().uuid(),
    category: z.enum(["strength", "weakness", "opportunity", "threat", "pattern", "anomaly"]),
    description: z.string(),
    confidence: z.number().min(0).max(1),
    actionable: z.boolean(),
    suggested_actions: z.array(z.string()),
  })),
  hypotheses_generated: z.array(z.string().uuid()),
  belief_updates: z.array(z.object({
    belief_id: z.string(),
    previous_value: z.unknown(),
    new_value: z.unknown(),
    reason: z.string(),
  })),
  duration_ms: z.number(),
  created_at: z.string().datetime(),
})

export type IntrospectionResult = z.infer<typeof IntrospectionResultSchema>

// -----------------------------------------------------------------------------
// Belief Management
// -----------------------------------------------------------------------------

export const BeliefSchema = z.object({
  belief_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  category: z.enum([
    "self_capability",
    "world_state",
    "causal_relationship",
    "preference",
    "goal",
    "constraint",
  ]),
  statement: z.string(),
  confidence: z.number().min(0).max(1),
  evidence_ids: z.array(z.string()),
  last_validated: z.string().datetime(),
  contradiction_count: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})

export type Belief = z.infer<typeof BeliefSchema>

export const BeliefUpdateSchema = z.object({
  update_id: z.string().uuid(),
  belief_id: z.string().uuid(),
  update_type: z.enum(["confidence_change", "evidence_added", "contradiction_detected", "validation"]),
  previous_confidence: z.number().min(0).max(1),
  new_confidence: z.number().min(0).max(1),
  reason: z.string(),
  evidence_id: z.string().optional(),
  created_at: z.string().datetime(),
})

export type BeliefUpdate = z.infer<typeof BeliefUpdateSchema>

// -----------------------------------------------------------------------------
// Learning Record
// -----------------------------------------------------------------------------

export const LearningRecordSchema = z.object({
  record_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  learning_type: z.enum([
    "skill_acquisition",
    "knowledge_integration",
    "behavior_modification",
    "error_correction",
    "strategy_refinement",
  ]),
  source_event: z.string().uuid(),
  lesson_learned: z.string(),
  generalization_level: z.enum(["specific", "domain", "general"]),
  application_contexts: z.array(z.string()),
  effectiveness_score: z.number().min(0).max(1).optional(),
  created_at: z.string().datetime(),
})

export type LearningRecord = z.infer<typeof LearningRecordSchema>
