// =============================================================================
// MindOS - Policy Types
// =============================================================================

import { z } from "zod"
import { ActionSchema } from "./schemas.js"

// -----------------------------------------------------------------------------
// Risk Levels
// -----------------------------------------------------------------------------

export const RiskLevelSchema = z.enum(["minimal", "low", "medium", "high", "critical"])
export type RiskLevel = z.infer<typeof RiskLevelSchema>

// -----------------------------------------------------------------------------
// Policy Verdict
// -----------------------------------------------------------------------------

export const PolicyVerdictSchema = z.enum([
  "allow",
  "deny",
  "escalate",
  "require_approval",
  "block",
  "allow_with_logging",
])
export type PolicyVerdict = z.infer<typeof PolicyVerdictSchema>

// -----------------------------------------------------------------------------
// Policy Decision
// -----------------------------------------------------------------------------

export const PolicyModeSchema = z.enum(["auto_execute", "require_approval", "block"])
export type PolicyMode = z.infer<typeof PolicyModeSchema>

// Legacy discriminated union (kept for backwards compatibility)
export const PolicyModeDecisionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("auto_execute"),
    reason: z.string().optional(),
  }),
  z.object({
    mode: z.literal("require_approval"),
    reason: z.string(),
    risk_factors: z.array(z.string()).optional(),
    suggested_level: z.enum(["read_only", "write_safe", "privileged"]).optional(),
  }),
  z.object({
    mode: z.literal("block"),
    reason: z.string(),
    violation_type: z.string(),
  }),
])
export type PolicyModeDecision = z.infer<typeof PolicyModeDecisionSchema>

// Primary PolicyDecision type used by mind-service
export const PolicyDecisionSchema = z.object({
  verdict: PolicyVerdictSchema,
  reason: z.string(),
  risk_level: RiskLevelSchema,
  risk_score: z.number().min(0).max(1),
  requires_approval: z.boolean(),
  mitigations: z.array(z.string()),
  evaluated_at: z.string().datetime(),
})
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>

// -----------------------------------------------------------------------------
// Policy Profile
// -----------------------------------------------------------------------------

export const TrustLevelSchema = z.enum(["low", "medium", "high"])
export type TrustLevel = z.infer<typeof TrustLevelSchema>

export const PolicyProfileSchema = z.object({
  // Trust and thresholds
  trust_level: TrustLevelSchema.default("medium"),
  auto_approve_threshold: z.number().min(0).max(1).default(0.35),
  approval_threshold: z.number().min(0).max(1).default(0.6),
  block_threshold: z.number().min(0).max(1).default(0.9),

  // Tool access
  allowed_tools: z.array(z.string()).default([]),
  blocked_tools: z.array(z.string()).default([]),

  // Historical data
  historical_success_rate: z.number().min(0).max(1).optional(),

  // Legacy fields (kept for backwards compatibility)
  mode: z.enum(["autonomous", "human_gated", "supervised"]).default("human_gated"),
  risk_threshold: z.number().min(0).max(1).default(0.35),
  max_iterations: z.number().int().min(1).default(20),
  allowed_tool_globs: z.array(z.string()).default(["*"]),
  denied_tool_globs: z.array(z.string()).default([]),

  // Hard stops (always require approval)
  hard_stop_keywords: z
    .array(z.string())
    .default([
      "wire",
      "transfer",
      "bank",
      "payment",
      "billing",
      "invoice pay",
      "password",
      "credential",
      "api key",
      "token",
      "delete",
      "drop table",
      "terminate",
      "disable",
      "revoke",
    ]),

  // Soft warnings
  warning_keywords: z
    .array(z.string())
    .default(["send", "post", "publish", "modify", "update", "create"]),

  // Time-based restrictions
  active_hours: z
    .object({
      enabled: z.boolean().default(false),
      start_hour: z.number().int().min(0).max(23).default(9),
      end_hour: z.number().int().min(0).max(23).default(17),
      timezone: z.string().default("UTC"),
    })
    .optional(),

  // Rate limiting
  rate_limits: z
    .object({
      actions_per_minute: z.number().int().min(1).default(60),
      high_risk_per_hour: z.number().int().min(0).default(10),
      approvals_per_day: z.number().int().min(0).default(50),
    })
    .optional(),
})
export type PolicyProfile = z.infer<typeof PolicyProfileSchema>

// -----------------------------------------------------------------------------
// Risk Assessment
// -----------------------------------------------------------------------------

export const RiskFactorSchema = z.object({
  factor: z.string(),
  weight: z.number().min(0).max(1),
  score: z.number().min(0).max(1),
  // Legacy fields for backwards compatibility
  present: z.boolean().optional(),
  details: z.string().optional(),
})
export type RiskFactor = z.infer<typeof RiskFactorSchema>

export const RiskAssessmentSchema = z.object({
  score: z.number().min(0).max(1),
  level: RiskLevelSchema,
  factors: z.array(RiskFactorSchema),
  summary: z.string(),
  // Legacy fields for backwards compatibility
  action: ActionSchema.optional(),
  overall_risk: z.number().min(0).max(1).optional(),
  recommendation: PolicyDecisionSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
})
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>

// -----------------------------------------------------------------------------
// Policy Learning
// -----------------------------------------------------------------------------

export const PolicyUpdateSchema = z.object({
  field: z.string(),
  old_value: z.unknown(),
  new_value: z.unknown(),
  reason: z.string(),
  source: z.enum(["task_outcome", "human_feedback", "self_improvement"]),
  confidence: z.number().min(0).max(1),
  requires_approval: z.boolean(),
})
export type PolicyUpdate = z.infer<typeof PolicyUpdateSchema>

export const PolicyEffectivenessSchema = z.object({
  total_decisions: z.number().int(),
  auto_executes: z.number().int(),
  approvals_requested: z.number().int(),
  approvals_granted: z.number().int(),
  approvals_denied: z.number().int(),
  false_positives: z.number().int(), // Blocked but should have allowed
  false_negatives: z.number().int(), // Allowed but caused issues
  avg_risk_score: z.number(),
  period_start: z.string().datetime(),
  period_end: z.string().datetime(),
})
export type PolicyEffectiveness = z.infer<typeof PolicyEffectivenessSchema>
