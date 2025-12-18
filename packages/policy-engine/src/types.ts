// =============================================================================
// Policy Engine Types
// =============================================================================

import { z } from "zod"

// -----------------------------------------------------------------------------
// Risk Assessment Types
// -----------------------------------------------------------------------------

export const RiskCategorySchema = z.enum([
  "data_access",
  "external_communication",
  "system_modification",
  "financial",
  "identity",
  "security",
  "compliance",
])

export type RiskCategory = z.infer<typeof RiskCategorySchema>

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"])

export type RiskLevel = z.infer<typeof RiskLevelSchema>

export const RiskAssessmentSchema = z.object({
  assessment_id: z.string().uuid(),
  action_type: z.string(),
  action_details: z.record(z.unknown()),
  risk_score: z.number().min(0).max(1),
  risk_level: RiskLevelSchema,
  categories: z.array(RiskCategorySchema),
  factors: z.array(
    z.object({
      factor: z.string(),
      weight: z.number(),
      score: z.number(),
      description: z.string(),
    })
  ),
  requires_approval: z.boolean(),
  timestamp: z.string().datetime(),
})

export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>

// -----------------------------------------------------------------------------
// Hard Stop Types
// -----------------------------------------------------------------------------

export const HardStopPatternSchema = z.object({
  pattern_id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  pattern_type: z.enum(["regex", "keyword", "semantic", "structural"]),
  pattern: z.string(),
  categories: z.array(RiskCategorySchema),
  severity: z.enum(["block", "warn", "audit"]),
  enabled: z.boolean().default(true),
})

export type HardStopPattern = z.infer<typeof HardStopPatternSchema>

export const HardStopResultSchema = z.object({
  blocked: z.boolean(),
  triggered_patterns: z.array(z.string()),
  warnings: z.array(z.string()),
  audit_log: z.array(z.string()),
  details: z.record(z.unknown()),
})

export type HardStopResult = z.infer<typeof HardStopResultSchema>

// -----------------------------------------------------------------------------
// Approval Types
// -----------------------------------------------------------------------------

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "auto_approved",
])

export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>

export const ApprovalRequestSchema = z.object({
  approval_id: z.string().uuid(),
  task_id: z.string().uuid(),
  step_id: z.string().uuid().optional(),
  action_type: z.string(),
  action_details: z.record(z.unknown()),
  risk_assessment_id: z.string().uuid(),
  status: ApprovalStatusSchema,
  requested_at: z.string().datetime(),
  responded_at: z.string().datetime().optional(),
  responder_id: z.string().optional(),
  response_reason: z.string().optional(),
  expires_at: z.string().datetime(),
})

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>

// -----------------------------------------------------------------------------
// Policy Profile Types
// -----------------------------------------------------------------------------

export const PolicyProfileSchema = z.object({
  profile_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  risk_tolerance: z.number().min(0).max(1).default(0.5),
  auto_approve_threshold: z.number().min(0).max(1).default(0.3),
  require_approval_threshold: z.number().min(0).max(1).default(0.7),
  category_overrides: z.record(RiskCategorySchema, z.number()).optional(),
  blocked_actions: z.array(z.string()).default([]),
  allowed_actions: z.array(z.string()).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})

export type PolicyProfile = z.infer<typeof PolicyProfileSchema>
