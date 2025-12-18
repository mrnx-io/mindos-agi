// =============================================================================
// World Model Types
// =============================================================================

import { z } from "zod"

// -----------------------------------------------------------------------------
// World State
// -----------------------------------------------------------------------------

export const EntitySchema = z.object({
  entity_id: z.string().uuid(),
  type: z.string(),
  name: z.string(),
  properties: z.record(z.unknown()),
  relationships: z.array(
    z.object({
      target_id: z.string().uuid(),
      relation_type: z.string(),
      strength: z.number().min(0).max(1),
      metadata: z.record(z.unknown()).optional(),
    })
  ),
  last_observed: z.string().datetime(),
  confidence: z.number().min(0).max(1),
})

export type Entity = z.infer<typeof EntitySchema>

export const WorldStateSchema = z.object({
  state_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  timestamp: z.string().datetime(),
  entities: z.array(EntitySchema),
  active_goals: z.array(z.string().uuid()),
  environmental_factors: z.record(z.unknown()),
  uncertainty_bounds: z.object({
    overall: z.number().min(0).max(1),
    per_entity: z.record(z.number()),
  }),
  checksum: z.string(),
})

export type WorldState = z.infer<typeof WorldStateSchema>

// -----------------------------------------------------------------------------
// Causal Graph
// -----------------------------------------------------------------------------

export const CausalNodeSchema = z.object({
  node_id: z.string().uuid(),
  label: z.string(),
  type: z.enum(["action", "state", "event", "condition"]),
  probability: z.number().min(0).max(1),
  variables: z.record(z.unknown()),
})

export type CausalNode = z.infer<typeof CausalNodeSchema>

export const CausalEdgeSchema = z.object({
  source_id: z.string().uuid(),
  target_id: z.string().uuid(),
  causal_strength: z.number().min(-1).max(1),
  time_lag_ms: z.number().optional(),
  conditions: z.array(z.string()).optional(),
})

export type CausalEdge = z.infer<typeof CausalEdgeSchema>

export const CausalGraphSchema = z.object({
  graph_id: z.string().uuid(),
  nodes: z.array(CausalNodeSchema),
  edges: z.array(CausalEdgeSchema),
  root_causes: z.array(z.string().uuid()),
  terminal_effects: z.array(z.string().uuid()),
  created_at: z.string().datetime(),
})

export type CausalGraph = z.infer<typeof CausalGraphSchema>

// -----------------------------------------------------------------------------
// Simulation
// -----------------------------------------------------------------------------

export const SimulationConfigSchema = z.object({
  max_depth: z.number().int().min(1).max(20).default(5),
  branch_factor: z.number().int().min(1).max(10).default(3),
  time_horizon_ms: z.number().int().default(3600000),
  uncertainty_threshold: z.number().min(0).max(1).default(0.3),
  include_side_effects: z.boolean().default(true),
})

export type SimulationConfig = z.infer<typeof SimulationConfigSchema>

export const SimulationResultSchema = z.object({
  simulation_id: z.string().uuid(),
  initial_state: WorldStateSchema,
  action_sequence: z.array(
    z.object({
      action_id: z.string().uuid(),
      action_type: z.string(),
      parameters: z.record(z.unknown()),
    })
  ),
  predicted_states: z.array(
    z.object({
      state: WorldStateSchema,
      probability: z.number().min(0).max(1),
      path_from_initial: z.array(z.string().uuid()),
    })
  ),
  side_effects: z.array(
    z.object({
      effect_type: z.string(),
      affected_entities: z.array(z.string().uuid()),
      severity: z.enum(["negligible", "minor", "moderate", "major", "critical"]),
      reversible: z.boolean(),
    })
  ),
  risk_assessment: z.object({
    overall_risk: z.number().min(0).max(1),
    failure_probability: z.number().min(0).max(1),
    worst_case_outcome: z.string(),
    best_case_outcome: z.string(),
  }),
  computation_time_ms: z.number(),
  created_at: z.string().datetime(),
})

export type SimulationResult = z.infer<typeof SimulationResultSchema>

// -----------------------------------------------------------------------------
// Prediction
// -----------------------------------------------------------------------------

export const PredictionSchema = z.object({
  prediction_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  prediction_type: z.enum([
    "state_change",
    "event_occurrence",
    "goal_outcome",
    "resource_availability",
  ]),
  target_description: z.string(),
  predicted_outcome: z.record(z.unknown()),
  confidence: z.number().min(0).max(1),
  time_horizon: z.object({
    earliest: z.string().datetime(),
    most_likely: z.string().datetime(),
    latest: z.string().datetime(),
  }),
  supporting_evidence: z.array(z.string()),
  assumptions: z.array(z.string()),
  created_at: z.string().datetime(),
  validated_at: z.string().datetime().optional(),
  actual_outcome: z.record(z.unknown()).optional(),
  accuracy_score: z.number().min(0).max(1).optional(),
})

export type Prediction = z.infer<typeof PredictionSchema>

// -----------------------------------------------------------------------------
// Counterfactual Analysis
// -----------------------------------------------------------------------------

export const CounterfactualSchema = z.object({
  counterfactual_id: z.string().uuid(),
  original_event_id: z.string().uuid(),
  altered_conditions: z.array(
    z.object({
      entity_id: z.string().uuid(),
      property: z.string(),
      original_value: z.unknown(),
      counterfactual_value: z.unknown(),
    })
  ),
  predicted_alternate_outcome: z.record(z.unknown()),
  divergence_point: z.string().datetime(),
  causal_explanation: z.string(),
  created_at: z.string().datetime(),
})

export type Counterfactual = z.infer<typeof CounterfactualSchema>
