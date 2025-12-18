// =============================================================================
// MindOS - Task Types
// =============================================================================

import { z } from "zod"
import { JSONSchema, TaskSchema, TaskStepSchema, UUIDSchema } from "./schemas.js"

// -----------------------------------------------------------------------------
// Task Execution Context
// -----------------------------------------------------------------------------

export const ExecutionContextSchema = z.object({
  task: TaskSchema,
  identity_id: UUIDSchema,
  iteration: z.number().int().min(0),
  max_iterations: z.number().int().min(1),
  recent_events: z.array(
    z.object({
      type: z.string(),
      source: z.string(),
      occurred_at: z.string(),
      payload: JSONSchema,
    })
  ),
  semantic_memories: z.array(
    z.object({
      text: z.string(),
      score: z.number(),
      kind: z.string(),
    })
  ),
  progress: z.array(
    TaskStepSchema.pick({
      step_idx: true,
      kind: true,
      name: true,
      output: true,
      error: true,
    })
  ),
  world_state: JSONSchema.optional(),
  metacognitive_context: JSONSchema.optional(),
  // Extended context fields for prompts
  background: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  resources: z.array(z.string()).optional(),
})
export type ExecutionContext = z.infer<typeof ExecutionContextSchema>

// -----------------------------------------------------------------------------
// Task Outcome
// -----------------------------------------------------------------------------

export const TaskOutcomeSchema = z.object({
  status: z.enum(["done", "failed", "waiting_approval", "cancelled"]),
  summary: z.string(),
  report: z.string().optional(),
  error: z.string().optional(),
  approval_id: z.string().optional(),
  evidence_ids: z.array(UUIDSchema).default([]),
  duration_ms: z.number().int().optional(),
  iterations_used: z.number().int().optional(),
})
export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>

// -----------------------------------------------------------------------------
// Task Delegation
// -----------------------------------------------------------------------------

export const DelegationRequestSchema = z.object({
  delegator_task_id: UUIDSchema,
  subtask_goal: z.string(),
  subtask_context: JSONSchema,
  required_capabilities: z.array(z.string()).optional(),
  deadline: z.string().datetime().optional(),
  priority: z.number().int().min(0).max(10).optional(),
})
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>

export const DelegationResponseSchema = z.object({
  delegation_id: UUIDSchema,
  accepted: z.boolean(),
  delegatee_id: UUIDSchema.optional(),
  rejection_reason: z.string().optional(),
  estimated_completion: z.string().datetime().optional(),
})
export type DelegationResponse = z.infer<typeof DelegationResponseSchema>

// -----------------------------------------------------------------------------
// Task Reflection
// -----------------------------------------------------------------------------

export const TaskReflectionSchema = z.object({
  task_id: UUIDSchema,
  success: z.boolean(),
  summary: z.string(),
  what_worked: z.array(z.string()),
  what_failed: z.array(z.string()),
  lessons_learned: z.array(z.string()),
  suggested_improvements: z.array(
    z.object({
      target: z.string(),
      suggestion: z.string(),
      confidence: z.number().min(0).max(1),
    })
  ),
  skills_to_update: z.array(
    z.object({
      skill_name: z.string(),
      update_type: z.enum(["create", "update", "deprecate"]),
      content: z.string().optional(),
    })
  ),
})
export type TaskReflection = z.infer<typeof TaskReflectionSchema>

// -----------------------------------------------------------------------------
// Task Priority Queue
// -----------------------------------------------------------------------------

export const QueuedTaskSchema = z.object({
  task_id: UUIDSchema,
  goal: z.string(),
  priority: z.number(),
  risk_score: z.number(),
  queued_at: z.string().datetime(),
  estimated_duration_ms: z.number().optional(),
  dependencies: z.array(UUIDSchema).default([]),
})
export type QueuedTask = z.infer<typeof QueuedTaskSchema>
