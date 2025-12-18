// =============================================================================
// MindOS - Metacognition Types
// =============================================================================

import { z } from "zod"
import { JSONSchema, TimestampSchema, UUIDSchema } from "./schemas.js"

// -----------------------------------------------------------------------------
// Observation Kinds
// -----------------------------------------------------------------------------

export const MetacognitiveKindSchema = z.enum([
  "confidence_assessment",
  "uncertainty_detection",
  "hypothesis_generation",
  "belief_update",
  "introspection",
  "capability_assessment",
  "failure_analysis",
])
export type MetacognitiveKind = z.infer<typeof MetacognitiveKindSchema>

// -----------------------------------------------------------------------------
// Confidence Interval
// -----------------------------------------------------------------------------

export const ConfidenceIntervalSchema = z.object({
  point_estimate: z.number().min(0).max(1),
  lower_bound: z.number().min(0).max(1),
  upper_bound: z.number().min(0).max(1),
  distribution: z.enum(["normal", "beta", "uniform"]).optional(),
})
export type ConfidenceInterval = z.infer<typeof ConfidenceIntervalSchema>

// -----------------------------------------------------------------------------
// Self Observation
// -----------------------------------------------------------------------------

export const SelfObservationSchema = z.object({
  observation_id: UUIDSchema,
  identity_id: UUIDSchema,
  task_id: UUIDSchema.nullable().optional(),
  step_id: UUIDSchema.nullable().optional(),
  kind: MetacognitiveKindSchema,
  observation: JSONSchema,
  meta_confidence: z.number().min(0).max(1),
  triggered_actions: z.array(JSONSchema).default([]),
  outcome: JSONSchema.nullable().optional(),
  created_at: TimestampSchema,
})
export type SelfObservation = z.infer<typeof SelfObservationSchema>

// -----------------------------------------------------------------------------
// Confidence Assessment
// -----------------------------------------------------------------------------

export const ConfidenceAssessmentSchema = z.object({
  target: z.string(), // What we're assessing confidence about
  target_type: z.enum(["decision", "prediction", "memory", "tool_output", "belief"]),
  confidence: ConfidenceIntervalSchema,
  factors: z.array(
    z.object({
      factor: z.string(),
      impact: z.number().min(-1).max(1), // Negative = reduces confidence
      weight: z.number().min(0).max(1),
    })
  ),
  epistemic_status: z.enum([
    "known", // High confidence, strong evidence
    "believed", // Moderate confidence
    "suspected", // Low confidence
    "uncertain", // Cannot assess
    "unknown", // No information
  ]),
})
export type ConfidenceAssessment = z.infer<typeof ConfidenceAssessmentSchema>

// -----------------------------------------------------------------------------
// Uncertainty Detection
// -----------------------------------------------------------------------------

export const UncertaintyTypeSchema = z.enum([
  "aleatoric", // Inherent randomness
  "epistemic", // Lack of knowledge
  "model", // Model limitations
  "input", // Input quality issues
])
export type UncertaintyType = z.infer<typeof UncertaintyTypeSchema>

export const UncertaintyDetectionSchema = z.object({
  source: z.string(),
  uncertainty_type: UncertaintyTypeSchema,
  magnitude: z.number().min(0).max(1),
  reducible: z.boolean(),
  reduction_strategy: z.string().optional(),
  affected_decisions: z.array(z.string()),
})
export type UncertaintyDetection = z.infer<typeof UncertaintyDetectionSchema>

// -----------------------------------------------------------------------------
// Hypothesis
// -----------------------------------------------------------------------------

export const HypothesisSchema = z.object({
  hypothesis_id: UUIDSchema,
  statement: z.string(),
  context: z.string(),
  prior_probability: z.number().min(0).max(1),
  current_probability: z.number().min(0).max(1),
  supporting_evidence: z.array(
    z.object({
      evidence_id: UUIDSchema.optional(),
      description: z.string(),
      strength: z.number().min(0).max(1),
    })
  ),
  contradicting_evidence: z.array(
    z.object({
      evidence_id: UUIDSchema.optional(),
      description: z.string(),
      strength: z.number().min(0).max(1),
    })
  ),
  testable: z.boolean(),
  test_plan: z.string().optional(),
  status: z.enum(["proposed", "testing", "supported", "refuted", "inconclusive"]),
})
export type Hypothesis = z.infer<typeof HypothesisSchema>

// -----------------------------------------------------------------------------
// Belief Update
// -----------------------------------------------------------------------------

export const BeliefUpdateSchema = z.object({
  belief: z.string(),
  prior: z.number().min(0).max(1),
  posterior: z.number().min(0).max(1),
  evidence: z.array(
    z.object({
      description: z.string(),
      likelihood_ratio: z.number().positive(),
    })
  ),
  update_method: z.enum(["bayesian", "heuristic", "override"]),
  timestamp: TimestampSchema,
})
export type BeliefUpdate = z.infer<typeof BeliefUpdateSchema>

// -----------------------------------------------------------------------------
// Introspection
// -----------------------------------------------------------------------------

export const IntrospectionTriggerSchema = z.enum([
  "periodic",
  "failure",
  "uncertainty",
  "decision_point",
  "user_request",
  "anomaly",
])
export type IntrospectionTrigger = z.infer<typeof IntrospectionTriggerSchema>

export const IntrospectionResultSchema = z.object({
  trigger: IntrospectionTriggerSchema,
  questions_asked: z.array(z.string()),
  answers: z.array(
    z.object({
      question: z.string(),
      answer: z.string(),
      confidence: z.number().min(0).max(1),
    })
  ),
  insights: z.array(z.string()),
  action_items: z.array(
    z.object({
      action: z.string(),
      priority: z.enum(["low", "medium", "high"]),
      rationale: z.string(),
    })
  ),
  duration_ms: z.number().int(),
})
export type IntrospectionResult = z.infer<typeof IntrospectionResultSchema>

// -----------------------------------------------------------------------------
// Capability Assessment
// -----------------------------------------------------------------------------

export const CapabilityAssessmentSchema = z.object({
  capability: z.string(),
  current_level: z.number().min(0).max(1),
  confidence_in_assessment: z.number().min(0).max(1),
  recent_performance: z.array(
    z.object({
      task_id: UUIDSchema,
      success: z.boolean(),
      difficulty: z.number().min(0).max(1),
      timestamp: TimestampSchema,
    })
  ),
  trend: z.enum(["improving", "stable", "declining", "insufficient_data"]),
  recommendations: z.array(z.string()),
})
export type CapabilityAssessment = z.infer<typeof CapabilityAssessmentSchema>

// -----------------------------------------------------------------------------
// Failure Analysis
// -----------------------------------------------------------------------------

export const FailureAnalysisSchema = z.object({
  task_id: UUIDSchema,
  failure_type: z.enum([
    "planning",
    "tool_selection",
    "tool_execution",
    "reasoning",
    "memory",
    "policy",
    "external",
    "unknown",
  ]),
  root_cause: z.string(),
  contributing_factors: z.array(z.string()),
  could_have_been_prevented: z.boolean(),
  prevention_strategy: z.string().optional(),
  similar_past_failures: z.array(UUIDSchema),
  lessons: z.array(z.string()),
})
export type FailureAnalysis = z.infer<typeof FailureAnalysisSchema>
