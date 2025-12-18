// =============================================================================
// MindOS - Core Zod Schemas
// =============================================================================

import { z } from "zod"

// -----------------------------------------------------------------------------
// Base Types
// -----------------------------------------------------------------------------

export const UUIDSchema = z.string().uuid()
export const TimestampSchema = z.string().datetime()
export const JSONSchema = z.record(z.unknown())

// -----------------------------------------------------------------------------
// Event Schemas
// -----------------------------------------------------------------------------

export const EventEnvelopeSchema = z.object({
  event_id: UUIDSchema,
  identity_id: UUIDSchema,
  occurred_at: TimestampSchema,
  source: z.string().min(1),
  type: z.string().min(1),
  payload: JSONSchema,
  provenance: JSONSchema.optional().default({}),
})
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>

// -----------------------------------------------------------------------------
// Goal & Task Schemas
// -----------------------------------------------------------------------------

export const GoalRequestSchema = z.object({
  identity_id: UUIDSchema,
  goal: z.string().min(1),
  priority: z.number().int().min(0).max(10).optional().default(5),
  metadata: JSONSchema.optional().default({}),
})
export type GoalRequest = z.infer<typeof GoalRequestSchema>

export const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "paused",
  "done",
  "failed",
  "cancelled",
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const TaskSchema = z.object({
  task_id: UUIDSchema,
  identity_id: UUIDSchema,
  parent_task_id: UUIDSchema.nullable().optional(),
  status: TaskStatusSchema,
  priority: z.number().int().min(0).max(10),
  goal: z.string(),
  risk_score: z.number().min(0).max(1),
  confidence_score: z.number().min(0).max(1),
  metadata: JSONSchema,
  result: JSONSchema.nullable().optional(),
  error: z.string().nullable().optional(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
})
export type Task = z.infer<typeof TaskSchema>

// -----------------------------------------------------------------------------
// Action & Decision Schemas
// -----------------------------------------------------------------------------

export const ActionKindSchema = z.enum([
  "tool",
  "tool_call", // Alias for "tool" used by mind-service
  "write_report",
  "ask_approval",
  "delegate",
  "reflect",
  "noop",
])
export type ActionKind = z.infer<typeof ActionKindSchema>

export const ActionSchema = z.object({
  name: z.string().min(1),
  kind: ActionKindSchema,
  tool: z.string().optional(),
  args: JSONSchema.optional(),
  expected: z.string().optional(),
  risk: z.number().min(0).max(1),
  uncertainty: z.number().min(0).max(1),
})
export type Action = z.infer<typeof ActionSchema>

export const DecisionSchema = z.object({
  done: z.boolean(),
  summary: z.string(),
  assumptions: z.array(z.string()).default([]),
  next: ActionSchema.nullable(),
  final_report: z.string().optional(),
  checkpoints: z.array(z.string()).default([]),
  metacognitive_notes: z.string().optional(),
})
export type Decision = z.infer<typeof DecisionSchema>

// -----------------------------------------------------------------------------
// Step Schemas
// -----------------------------------------------------------------------------

export const StepKindSchema = z.enum([
  "plan",
  "tool",
  "decision",
  "note",
  "report",
  "reflection",
  "metacognition",
])
export type StepKind = z.infer<typeof StepKindSchema>

export const TaskStepSchema = z.object({
  step_id: UUIDSchema,
  task_id: UUIDSchema,
  step_idx: z.number().int().min(0),
  kind: StepKindSchema,
  name: z.string(),
  input: JSONSchema,
  output: JSONSchema,
  error: z.string().nullable().optional(),
  evidence: JSONSchema,
  duration_ms: z.number().int().optional(),
  model_used: z.string().optional(),
  created_at: TimestampSchema,
  // Extended fields used by prompts.ts
  description: z.string().optional(),
  summary: z.string().optional(),
  action: z
    .object({
      kind: ActionKindSchema,
      tool: z.string().optional(),
    })
    .optional(),
  result: z
    .object({
      success: z.boolean(),
      output: JSONSchema.optional(),
    })
    .optional(),
  started_at: TimestampSchema.optional(),
  completed_at: TimestampSchema.optional(),
})
export type TaskStep = z.infer<typeof TaskStepSchema>

// -----------------------------------------------------------------------------
// Approval Schemas
// -----------------------------------------------------------------------------

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "timeout",
  "escalated",
])
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>

export const ApprovalRequestSchema = z.object({
  action: ActionSchema,
  reason: z.string(),
  risk_score: z.number().min(0).max(1),
  context: JSONSchema.optional(),
})
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>

export const ApprovalResolutionSchema = z.object({
  level: z.enum(["read_only", "write_safe", "privileged"]),
  note: z.string().optional(),
  approved_by: z.string().optional(),
})
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>

export const ApprovalSchema = z.object({
  approval_id: z.string(),
  task_id: UUIDSchema,
  status: ApprovalStatusSchema,
  request: ApprovalRequestSchema,
  resolution: ApprovalResolutionSchema.nullable().optional(),
  created_at: TimestampSchema,
  resolved_at: TimestampSchema.nullable().optional(),
  expires_at: TimestampSchema.nullable().optional(),
})
export type Approval = z.infer<typeof ApprovalSchema>
