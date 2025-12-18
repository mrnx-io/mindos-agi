// =============================================================================
// World Model Simulator
// =============================================================================

import type pg from "pg"
import type {
  WorldState,
  SimulationConfig,
  SimulationResult,
  Entity,
} from "./types.js"

// -----------------------------------------------------------------------------
// Simulator Engine
// -----------------------------------------------------------------------------

export interface WorldModelSimulator {
  captureState(identityId: string): Promise<WorldState>
  simulateAction(
    action: ActionInput,
    initialState: WorldState,
    config?: Partial<SimulationConfig>
  ): Promise<SimulationResult>
  simulateSequence(
    actions: ActionInput[],
    initialState: WorldState,
    config?: Partial<SimulationConfig>
  ): Promise<SimulationResult>
  compareOutcomes(results: SimulationResult[]): OutcomeComparison
  rollback(stateId: string): Promise<WorldState>
  checkpoint(state: WorldState): Promise<string>
}

export interface ActionInput {
  action_id: string
  action_type: string
  parameters: Record<string, unknown>
  target_entities?: string[]
  expected_duration_ms?: number
}

export interface OutcomeComparison {
  best_outcome_index: number
  worst_outcome_index: number
  risk_rankings: number[]
  success_probability_rankings: number[]
  recommendation: string
}

// -----------------------------------------------------------------------------
// Default Configuration
// -----------------------------------------------------------------------------

const DEFAULT_CONFIG: SimulationConfig = {
  max_depth: 5,
  branch_factor: 3,
  time_horizon_ms: 3600000,
  uncertainty_threshold: 0.3,
  include_side_effects: true,
}

// -----------------------------------------------------------------------------
// Create Simulator
// -----------------------------------------------------------------------------

export function createWorldModelSimulator(pool: pg.Pool): WorldModelSimulator {
  // State checkpoints
  const checkpoints = new Map<string, WorldState>()

  // -----------------------------------------------------------------------------
  // Capture Current State
  // -----------------------------------------------------------------------------

  async function captureState(identityId: string): Promise<WorldState> {
    // Fetch entities from knowledge graph
    const entitiesResult = await pool.query(
      `SELECT * FROM knowledge_graph_entities WHERE identity_id = $1`,
      [identityId]
    )

    const entities: Entity[] = entitiesResult.rows.map((row) => ({
      entity_id: row.entity_id,
      type: row.entity_type,
      name: row.name,
      properties: row.properties ?? {},
      relationships: row.relationships ?? [],
      last_observed: row.updated_at,
      confidence: row.confidence ?? 0.8,
    }))

    // Fetch active goals
    const goalsResult = await pool.query(
      `SELECT task_id FROM tasks WHERE identity_id = $1 AND status IN ('pending', 'in_progress')`,
      [identityId]
    )

    const activeGoals = goalsResult.rows.map((r) => r.task_id)

    // Calculate uncertainty
    const avgConfidence = entities.length > 0
      ? entities.reduce((sum, e) => sum + e.confidence, 0) / entities.length
      : 0.5

    const uncertaintyPerEntity: Record<string, number> = {}
    for (const entity of entities) {
      uncertaintyPerEntity[entity.entity_id] = 1 - entity.confidence
    }

    const state: WorldState = {
      state_id: crypto.randomUUID(),
      identity_id: identityId,
      timestamp: new Date().toISOString(),
      entities,
      active_goals: activeGoals,
      environmental_factors: {},
      uncertainty_bounds: {
        overall: 1 - avgConfidence,
        per_entity: uncertaintyPerEntity,
      },
      checksum: "",
    }

    // Generate checksum
    state.checksum = await generateChecksum(state)

    return state
  }

  // -----------------------------------------------------------------------------
  // Simulate Single Action
  // -----------------------------------------------------------------------------

  async function simulateAction(
    action: ActionInput,
    initialState: WorldState,
    config: Partial<SimulationConfig> = {}
  ): Promise<SimulationResult> {
    return simulateSequence([action], initialState, config)
  }

  // -----------------------------------------------------------------------------
  // Simulate Action Sequence
  // -----------------------------------------------------------------------------

  async function simulateSequence(
    actions: ActionInput[],
    initialState: WorldState,
    config: Partial<SimulationConfig> = {}
  ): Promise<SimulationResult> {
    const startTime = performance.now()
    const fullConfig = { ...DEFAULT_CONFIG, ...config }

    const predictedStates: SimulationResult["predicted_states"] = []
    const sideEffects: SimulationResult["side_effects"] = []

    let currentState = structuredClone(initialState)
    const pathHistory: string[] = [initialState.state_id]

    for (const action of actions) {
      // Apply action to state
      const { newState, effects } = applyAction(action, currentState, fullConfig)

      // Generate branch states based on uncertainty
      const branches = generateBranches(newState, action, fullConfig)

      for (const branch of branches) {
        predictedStates.push({
          state: branch.state,
          probability: branch.probability,
          path_from_initial: [...pathHistory, branch.state.state_id],
        })
      }

      // Collect side effects
      sideEffects.push(...effects)

      // Move to most likely state for next action
      currentState = branches.reduce((best, branch) =>
        branch.probability > best.probability ? branch : best
      , branches[0]).state

      pathHistory.push(currentState.state_id)
    }

    // Assess risk
    const riskAssessment = assessRisk(predictedStates, sideEffects)

    const result: SimulationResult = {
      simulation_id: crypto.randomUUID(),
      initial_state: initialState,
      action_sequence: actions.map((a) => ({
        action_id: a.action_id,
        action_type: a.action_type,
        parameters: a.parameters,
      })),
      predicted_states: predictedStates,
      side_effects: sideEffects,
      risk_assessment: riskAssessment,
      computation_time_ms: performance.now() - startTime,
      created_at: new Date().toISOString(),
    }

    // Persist simulation result
    await persistSimulation(result)

    return result
  }

  // -----------------------------------------------------------------------------
  // Apply Action to State
  // -----------------------------------------------------------------------------

  function applyAction(
    action: ActionInput,
    state: WorldState,
    config: SimulationConfig
  ): {
    newState: WorldState
    effects: SimulationResult["side_effects"]
  } {
    const newState = structuredClone(state)
    newState.state_id = crypto.randomUUID()
    newState.timestamp = new Date().toISOString()

    const effects: SimulationResult["side_effects"] = []

    // Apply action based on type
    switch (action.action_type) {
      case "create_entity": {
        const entity: Entity = {
          entity_id: crypto.randomUUID(),
          type: action.parameters.type as string ?? "unknown",
          name: action.parameters.name as string ?? "Unnamed",
          properties: action.parameters.properties as Record<string, unknown> ?? {},
          relationships: [],
          last_observed: newState.timestamp,
          confidence: 0.9,
        }
        newState.entities.push(entity)
        break
      }

      case "modify_entity": {
        const targetId = action.target_entities?.[0]
        const entity = newState.entities.find((e) => e.entity_id === targetId)
        if (entity) {
          Object.assign(entity.properties, action.parameters.updates ?? {})
          entity.last_observed = newState.timestamp
          entity.confidence = Math.min(entity.confidence + 0.1, 1)
        }
        break
      }

      case "delete_entity": {
        const targetId = action.target_entities?.[0]
        newState.entities = newState.entities.filter((e) => e.entity_id !== targetId)

        // Remove relationships to deleted entity
        for (const entity of newState.entities) {
          entity.relationships = entity.relationships.filter(
            (r) => r.target_id !== targetId
          )
        }

        effects.push({
          effect_type: "entity_deletion",
          affected_entities: [targetId!],
          severity: "moderate",
          reversible: false,
        })
        break
      }

      case "create_relationship": {
        const sourceId = action.parameters.source_id as string
        const targetId = action.parameters.target_id as string
        const relationType = action.parameters.relation_type as string

        const source = newState.entities.find((e) => e.entity_id === sourceId)
        if (source) {
          source.relationships.push({
            target_id: targetId,
            relation_type: relationType,
            strength: 0.8,
          })
        }
        break
      }

      case "complete_goal": {
        const goalId = action.target_entities?.[0]
        newState.active_goals = newState.active_goals.filter((g) => g !== goalId)
        break
      }

      case "external_api_call": {
        // Simulate potential network effects
        effects.push({
          effect_type: "external_dependency",
          affected_entities: action.target_entities ?? [],
          severity: "minor",
          reversible: true,
        })
        break
      }

      case "file_write": {
        effects.push({
          effect_type: "filesystem_modification",
          affected_entities: action.target_entities ?? [],
          severity: "moderate",
          reversible: true,
        })
        break
      }

      case "database_mutation": {
        effects.push({
          effect_type: "data_mutation",
          affected_entities: action.target_entities ?? [],
          severity: "major",
          reversible: false,
        })
        break
      }
    }

    // Recalculate uncertainty
    newState.uncertainty_bounds.overall *= 1.05 // Slight increase per action

    return { newState, effects }
  }

  // -----------------------------------------------------------------------------
  // Generate Branches
  // -----------------------------------------------------------------------------

  function generateBranches(
    state: WorldState,
    action: ActionInput,
    config: SimulationConfig
  ): Array<{ state: WorldState; probability: number }> {
    const branches: Array<{ state: WorldState; probability: number }> = []

    // Primary outcome (most likely)
    branches.push({
      state: structuredClone(state),
      probability: 0.7,
    })

    // Generate alternative outcomes based on uncertainty
    if (state.uncertainty_bounds.overall > config.uncertainty_threshold) {
      // Partial success
      const partialState = structuredClone(state)
      partialState.state_id = crypto.randomUUID()
      partialState.uncertainty_bounds.overall *= 1.2
      branches.push({
        state: partialState,
        probability: 0.2,
      })

      // Failure case
      const failState = structuredClone(state)
      failState.state_id = crypto.randomUUID()
      failState.uncertainty_bounds.overall = Math.min(failState.uncertainty_bounds.overall * 1.5, 1)
      branches.push({
        state: failState,
        probability: 0.1,
      })
    }

    // Normalize probabilities
    const totalProb = branches.reduce((sum, b) => sum + b.probability, 0)
    for (const branch of branches) {
      branch.probability /= totalProb
    }

    return branches.slice(0, config.branch_factor)
  }

  // -----------------------------------------------------------------------------
  // Risk Assessment
  // -----------------------------------------------------------------------------

  function assessRisk(
    predictedStates: SimulationResult["predicted_states"],
    sideEffects: SimulationResult["side_effects"]
  ): SimulationResult["risk_assessment"] {
    // Calculate failure probability from low-probability states
    const failureProbability = predictedStates
      .filter((s) => s.state.uncertainty_bounds.overall > 0.6)
      .reduce((sum, s) => sum + s.probability, 0)

    // Calculate overall risk from side effects
    const severityWeights: Record<string, number> = {
      negligible: 0.1,
      minor: 0.3,
      moderate: 0.5,
      major: 0.8,
      critical: 1.0,
    }

    const effectRisk = sideEffects.length > 0
      ? sideEffects.reduce((sum, e) => sum + (severityWeights[e.severity] ?? 0), 0) / sideEffects.length
      : 0

    const overallRisk = Math.min((failureProbability + effectRisk) / 2, 1)

    // Find best and worst outcomes
    const sortedByUncertainty = [...predictedStates].sort(
      (a, b) => a.state.uncertainty_bounds.overall - b.state.uncertainty_bounds.overall
    )

    return {
      overall_risk: overallRisk,
      failure_probability: failureProbability,
      worst_case_outcome: sortedByUncertainty[sortedByUncertainty.length - 1]?.state.state_id ?? "unknown",
      best_case_outcome: sortedByUncertainty[0]?.state.state_id ?? "unknown",
    }
  }

  // -----------------------------------------------------------------------------
  // Compare Outcomes
  // -----------------------------------------------------------------------------

  function compareOutcomes(results: SimulationResult[]): OutcomeComparison {
    if (results.length === 0) {
      return {
        best_outcome_index: -1,
        worst_outcome_index: -1,
        risk_rankings: [],
        success_probability_rankings: [],
        recommendation: "No results to compare",
      }
    }

    const riskScores = results.map((r) => r.risk_assessment.overall_risk)
    const successProbs = results.map((r) => 1 - r.risk_assessment.failure_probability)

    const riskRankings = [...riskScores]
      .map((score, index) => ({ score, index }))
      .sort((a, b) => a.score - b.score)
      .map((item) => item.index)

    const successRankings = [...successProbs]
      .map((score, index) => ({ score, index }))
      .sort((a, b) => b.score - a.score)
      .map((item) => item.index)

    const bestIndex = riskRankings[0]
    const worstIndex = riskRankings[riskRankings.length - 1]

    const bestResult = results[bestIndex]
    const recommendation = `Option ${bestIndex + 1} is recommended with ${((1 - bestResult.risk_assessment.overall_risk) * 100).toFixed(1)}% expected success rate and ${bestResult.side_effects.length} potential side effects.`

    return {
      best_outcome_index: bestIndex,
      worst_outcome_index: worstIndex,
      risk_rankings: riskRankings,
      success_probability_rankings: successRankings,
      recommendation,
    }
  }

  // -----------------------------------------------------------------------------
  // Checkpointing
  // -----------------------------------------------------------------------------

  async function checkpoint(state: WorldState): Promise<string> {
    const checkpointId = crypto.randomUUID()
    checkpoints.set(checkpointId, structuredClone(state))

    // Persist to database
    await pool.query(
      `INSERT INTO world_model_states (
        state_id, identity_id, entities, active_goals, uncertainty_bounds, checksum, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        state.state_id,
        state.identity_id,
        JSON.stringify(state.entities),
        JSON.stringify(state.active_goals),
        JSON.stringify(state.uncertainty_bounds),
        state.checksum,
        state.timestamp,
      ]
    )

    return checkpointId
  }

  async function rollback(stateId: string): Promise<WorldState> {
    // Check in-memory first
    const cached = checkpoints.get(stateId)
    if (cached) {
      return structuredClone(cached)
    }

    // Load from database
    const result = await pool.query(
      `SELECT * FROM world_model_states WHERE state_id = $1`,
      [stateId]
    )

    if (result.rows.length === 0) {
      throw new Error(`State ${stateId} not found`)
    }

    const row = result.rows[0]
    return {
      state_id: row.state_id,
      identity_id: row.identity_id,
      timestamp: row.created_at,
      entities: row.entities,
      active_goals: row.active_goals,
      environmental_factors: {},
      uncertainty_bounds: row.uncertainty_bounds,
      checksum: row.checksum,
    }
  }

  // -----------------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------------

  async function persistSimulation(result: SimulationResult): Promise<void> {
    await pool.query(
      `INSERT INTO world_model_simulations (
        simulation_id, identity_id, action_sequence, predicted_states_count,
        overall_risk, computation_time_ms, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        result.simulation_id,
        result.initial_state.identity_id,
        JSON.stringify(result.action_sequence),
        result.predicted_states.length,
        result.risk_assessment.overall_risk,
        result.computation_time_ms,
        result.created_at,
      ]
    )
  }

  // -----------------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------------

  async function generateChecksum(state: Omit<WorldState, "checksum">): Promise<string> {
    const content = JSON.stringify({
      identity_id: state.identity_id,
      entities: state.entities.map((e) => e.entity_id).sort(),
      active_goals: [...state.active_goals].sort(),
    })

    const encoder = new TextEncoder()
    const data = encoder.encode(content)
    const hashBuffer = await crypto.subtle.digest("SHA-256", data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
  }

  return {
    captureState,
    simulateAction,
    simulateSequence,
    compareOutcomes,
    rollback,
    checkpoint,
  }
}
