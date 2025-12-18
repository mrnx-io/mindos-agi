// =============================================================================
// MindOS - World Model Types
// =============================================================================

import { z } from "zod"
import { UUIDSchema, TimestampSchema, JSONSchema, ActionSchema } from "./schemas.js"

// -----------------------------------------------------------------------------
// World State
// -----------------------------------------------------------------------------

export const WorldStateKindSchema = z.enum([
  "snapshot",      // Current state capture
  "prediction",    // Predicted future state
  "counterfactual", // "What if" scenario
  "checkpoint",    // Saved rollback point
])
export type WorldStateKind = z.infer<typeof WorldStateKindSchema>

export const WorldStateSchema = z.object({
  state_id: UUIDSchema,
  identity_id: UUIDSchema,
  task_id: UUIDSchema.nullable().optional(),
  kind: WorldStateKindSchema,
  state: JSONSchema,
  causal_graph: JSONSchema,
  predicted_from_state_id: UUIDSchema.nullable().optional(),
  predicted_action: JSONSchema.nullable().optional(),
  prediction_confidence: z.number().min(0).max(1).nullable().optional(),
  verified_at: TimestampSchema.nullable().optional(),
  actual_outcome: JSONSchema.nullable().optional(),
  prediction_accuracy: z.number().min(0).max(1).nullable().optional(),
  created_at: TimestampSchema,
})
export type WorldState = z.infer<typeof WorldStateSchema>

// -----------------------------------------------------------------------------
// Causal Graph
// -----------------------------------------------------------------------------

export const CausalNodeSchema = z.object({
  node_id: z.string(),
  type: z.enum(["entity", "state", "action", "event"]),
  name: z.string(),
  properties: JSONSchema,
  timestamp: TimestampSchema.optional(),
})
export type CausalNode = z.infer<typeof CausalNodeSchema>

export const CausalEdgeSchema = z.object({
  source_id: z.string(),
  target_id: z.string(),
  relationship: z.enum([
    "causes",
    "enables",
    "prevents",
    "affects",
    "depends_on",
    "precedes",
    "follows",
  ]),
  strength: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  evidence: z.array(UUIDSchema).optional(),
})
export type CausalEdge = z.infer<typeof CausalEdgeSchema>

export const CausalGraphSchema = z.object({
  nodes: z.array(CausalNodeSchema),
  edges: z.array(CausalEdgeSchema),
  root_nodes: z.array(z.string()),
  leaf_nodes: z.array(z.string()),
})
export type CausalGraph = z.infer<typeof CausalGraphSchema>

// -----------------------------------------------------------------------------
// Simulation
// -----------------------------------------------------------------------------

export const SimulationRequestSchema = z.object({
  identity_id: UUIDSchema,
  base_state_id: UUIDSchema.optional(), // Use current if not provided
  action: ActionSchema,
  depth: z.number().int().min(1).max(10).optional().default(1), // How many steps ahead
  branches: z.number().int().min(1).max(5).optional().default(1), // Alternative outcomes
})
export type SimulationRequest = z.infer<typeof SimulationRequestSchema>

export const SimulationOutcomeSchema = z.object({
  outcome_id: UUIDSchema,
  action: ActionSchema,
  resulting_state: WorldStateSchema,
  probability: z.number().min(0).max(1),
  utility: z.number(), // Estimated value (can be negative)
  risks: z.array(z.object({
    risk: z.string(),
    probability: z.number().min(0).max(1),
    severity: z.number().min(0).max(1),
  })),
  side_effects: z.array(z.string()),
  reversibility: z.enum(["instant", "reversible", "partially_reversible", "irreversible"]),
})
export type SimulationOutcome = z.infer<typeof SimulationOutcomeSchema>

export const SimulationResultSchema = z.object({
  request: SimulationRequestSchema,
  base_state: WorldStateSchema,
  outcomes: z.array(SimulationOutcomeSchema),
  recommended_action: ActionSchema.nullable(),
  recommendation_confidence: z.number().min(0).max(1),
  simulation_duration_ms: z.number().int(),
})
export type SimulationResult = z.infer<typeof SimulationResultSchema>

// -----------------------------------------------------------------------------
// Prediction
// -----------------------------------------------------------------------------

export const PredictionSchema = z.object({
  prediction_id: UUIDSchema,
  identity_id: UUIDSchema,
  statement: z.string(),
  target_time: TimestampSchema,
  conditions: z.array(z.string()),
  probability: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  based_on: z.array(z.object({
    type: z.enum(["evidence", "simulation", "pattern", "rule"]),
    reference: z.string(),
    weight: z.number().min(0).max(1),
  })),
  verification_status: z.enum([
    "pending",
    "verified_correct",
    "verified_incorrect",
    "conditions_not_met",
    "expired",
  ]),
  actual_outcome: z.string().nullable().optional(),
  created_at: TimestampSchema,
})
export type Prediction = z.infer<typeof PredictionSchema>

// -----------------------------------------------------------------------------
// State Diff
// -----------------------------------------------------------------------------

export const StateDiffSchema = z.object({
  before_state_id: UUIDSchema,
  after_state_id: UUIDSchema,
  changes: z.array(z.object({
    path: z.string(), // JSON path
    before: JSONSchema.nullable(),
    after: JSONSchema.nullable(),
    change_type: z.enum(["added", "removed", "modified"]),
  })),
  summary: z.string(),
})
export type StateDiff = z.infer<typeof StateDiffSchema>

// -----------------------------------------------------------------------------
// Rollback
// -----------------------------------------------------------------------------

export const RollbackRequestSchema = z.object({
  identity_id: UUIDSchema,
  target_state_id: UUIDSchema,
  reason: z.string(),
  preserve_memories: z.boolean().optional().default(true),
})
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>

export const RollbackResultSchema = z.object({
  success: z.boolean(),
  rolled_back_from: UUIDSchema,
  rolled_back_to: UUIDSchema,
  preserved_memories: z.number().int(),
  lost_changes: z.array(z.string()),
  error: z.string().optional(),
})
export type RollbackResult = z.infer<typeof RollbackResultSchema>
