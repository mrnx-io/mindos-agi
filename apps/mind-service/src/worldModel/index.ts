// =============================================================================
// World Model Service - Predictive Simulation & Causal Reasoning
// =============================================================================
// Unified interface for world state capture, action simulation, plan validation,
// lookahead, and counterfactual analysis.

import { env } from "../config.js"
import { query, queryOne } from "../db.js"
import { createLogger } from "../logger.js"

const log = createLogger("world-model")

// -----------------------------------------------------------------------------
// Database Row Interfaces
// -----------------------------------------------------------------------------

interface TaskRow {
  task_id: string
  goal: string
  status: string
  context: unknown
  priority?: number
}

interface SemanticMemoryRow {
  content: unknown
  kind: string
  created_at: string
}

interface BeliefRow {
  statement: string
  confidence: number
  category: string
}

interface IdentityRow {
  identity_id: string
  core_self: unknown
  metadata: unknown
}

interface WorldModelStateRow {
  state_id: string
  identity_id: string
  task_id: string | null
  kind: string
  state: unknown
  causal_graph: unknown
  created_at: string
}

interface WorldModelCheckpointRow {
  checkpoint_id: string
  identity_id: string
  task_id: string
  step_id: string | null
  state_snapshot: unknown
  causal_graph_snapshot: unknown
  step_index: number
  risk_level: number
  is_irreversible_next: boolean
  recovery_actions: unknown
  expires_at: string | null
  created_at: string
  used_for_rollback?: boolean
  rolled_back_at?: string | null
}

interface WorldModelPredictionRow {
  prediction_id: string
  identity_id: string
  simulation_id: string
  predicted_outcome: unknown
  confidence: number
  created_at: string
  verified_at?: string | null
  actual_outcome?: unknown
  accuracy_score?: number
}

interface SkillUsageRow {
  total: number
  successful: number
}

interface TaskIdentityRow {
  identity_id: string
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface WorldState {
  state_id: string
  identity_id: string
  task_id?: string
  kind: "snapshot" | "prediction" | "counterfactual" | "checkpoint"
  state: Record<string, unknown>
  causal_graph: CausalGraph
  created_at: string
}

export interface CausalGraph {
  nodes: CausalNode[]
  edges: CausalEdge[]
}

export interface CausalNode {
  node_id: string
  type: "entity" | "action" | "state" | "outcome"
  label: string
  properties: Record<string, unknown>
}

export interface CausalEdge {
  source_id: string
  target_id: string
  relationship: "causes" | "enables" | "prevents" | "requires" | "modifies"
  strength: number // 0-1
  confidence: number // 0-1
}

export interface SimulationResult {
  simulation_id: string
  initial_state_id: string
  simulated_actions: ActionSimulation[]
  predicted_outcomes: PredictedOutcome[]
  overall_confidence: number
  identified_risks: RiskAssessment[]
  failure_scenarios: FailureScenario[]
  recommended_checkpoints: number[]
}

export interface ActionSimulation {
  action_index: number
  action: PlanAction
  predicted_state: Record<string, unknown>
  confidence: number
  side_effects: SideEffect[]
}

export interface PredictedOutcome {
  outcome_id: string
  description: string
  probability: number
  impact: "positive" | "neutral" | "negative"
  affected_entities: string[]
}

export interface RiskAssessment {
  risk_id: string
  description: string
  probability: number
  severity: number
  step_index: number
  mitigation: string
}

export interface FailureScenario {
  scenario_id: string
  trigger: string
  step_index: number
  cascading_effects: string[]
  recovery_strategy?: string
}

export interface SideEffect {
  type: "state_change" | "resource_consumption" | "external_call" | "data_modification"
  description: string
  reversible: boolean
}

export interface PlanAction {
  description: string
  tool?: string
  parameters?: Record<string, unknown>
  risk_factors?: string[]
}

export interface LookaheadResult {
  current_step: number
  lookahead_depth: number
  predicted_blockers: PredictedBlocker[]
  recommended_actions: RecommendedAction[]
  checkpoint_recommended: boolean
  checkpoint_reason?: string
}

export interface PredictedBlocker {
  step_index: number
  description: string
  probability: number
  prevention_possible: boolean
  prevention_action?: string
}

export interface RecommendedAction {
  action_type: "prepare" | "verify" | "checkpoint" | "alternative"
  description: string
  urgency: "low" | "medium" | "high"
}

export interface CounterfactualAnalysis {
  analysis_id: string
  failed_action: PlanAction
  actual_outcome: Record<string, unknown>
  alternative_actions: AlternativeAction[]
  best_alternative?: AlternativeAction
  root_cause_hypothesis?: string
  preventability_score: number
  lessons_learned: string[]
}

export interface AlternativeAction {
  action: PlanAction
  simulated_outcome: Record<string, unknown>
  success_probability: number
  cost_comparison: "lower" | "same" | "higher"
}

export interface Checkpoint {
  checkpoint_id: string
  task_id: string
  step_index: number
  state_snapshot: Record<string, unknown>
  causal_graph_snapshot: CausalGraph
  risk_level: number
  is_irreversible_next: boolean
  recovery_actions: RecoveryAction[]
  created_at: string
  expires_at?: string
}

export interface RecoveryAction {
  action_type: "rollback" | "compensate" | "retry" | "escalate"
  description: string
  target_state_id?: string
}

// -----------------------------------------------------------------------------
// World Model Service Interface
// -----------------------------------------------------------------------------

export interface WorldModelService {
  // State capture
  captureCurrentState(identityId: string, taskId?: string): Promise<WorldState>
  getState(stateId: string): Promise<WorldState | null>

  // Simulation
  simulateAction(action: PlanAction, state: WorldState): Promise<SimulationResult>
  simulatePlan(plan: PlanAction[], state: WorldState): Promise<SimulationResult>

  // Lookahead
  lookAhead(
    currentStep: number,
    plan: PlanAction[],
    depth: number,
    state: WorldState
  ): Promise<LookaheadResult>

  // Counterfactual
  analyzeCounterfactual(
    failedAction: PlanAction,
    actualOutcome: Record<string, unknown>,
    state: WorldState
  ): Promise<CounterfactualAnalysis>

  // Checkpoints
  createCheckpoint(
    taskId: string,
    stepIndex: number,
    state: WorldState,
    riskLevel: number,
    isIrreversibleNext: boolean
  ): Promise<Checkpoint>
  getCheckpoint(checkpointId: string): Promise<Checkpoint | null>
  listCheckpoints(taskId: string): Promise<Checkpoint[]>
  rollbackToCheckpoint(checkpointId: string): Promise<WorldState>

  // Predictions
  recordPrediction(
    identityId: string,
    simulationId: string,
    predicted: Record<string, unknown>,
    confidence: number
  ): Promise<string>
  verifyPrediction(predictionId: string, actual: Record<string, unknown>): Promise<number>
}

// -----------------------------------------------------------------------------
// Create World Model Service
// -----------------------------------------------------------------------------

export function createWorldModelService(): WorldModelService {
  // ---------------------------------------------------------------------------
  // State Capture
  // ---------------------------------------------------------------------------

  async function captureCurrentState(identityId: string, taskId?: string): Promise<WorldState> {
    log.debug({ identityId, taskId }, "Capturing current world state")

    // Gather state from various sources
    const [activeTasksResult, recentMemoriesResult, currentBeliefsResult, environmentResult] =
      await Promise.all([
        query<TaskRow>(
          `SELECT task_id, goal, status, context FROM tasks
         WHERE identity_id = $1 AND status IN ('running', 'pending')
         ORDER BY priority DESC LIMIT 10`,
          [identityId]
        ),
        query<SemanticMemoryRow>(
          `SELECT content, kind, created_at FROM semantic_memories
         WHERE identity_id = $1
         ORDER BY created_at DESC LIMIT 20`,
          [identityId]
        ),
        query<BeliefRow>(
          `SELECT statement, confidence, category FROM beliefs
         WHERE identity_id = $1 AND confidence > 0.5
         ORDER BY confidence DESC LIMIT 20`,
          [identityId]
        ),
        queryOne<IdentityRow>("SELECT core_self, metadata FROM identities WHERE identity_id = $1", [
          identityId,
        ]),
      ])

    const state: Record<string, unknown> = {
      active_tasks: activeTasksResult.rows,
      recent_memories: recentMemoriesResult.rows.map((r) => ({
        content: r.content,
        kind: r.kind,
      })),
      beliefs: currentBeliefsResult.rows,
      environment: {
        core_self: environmentResult?.core_self,
        timestamp: new Date().toISOString(),
      },
    }

    // Build causal graph from current state
    const causalGraph = buildCausalGraphFromState(state, activeTasksResult.rows)

    const stateId = crypto.randomUUID()

    // Persist state
    await query(
      `INSERT INTO world_model_states (
        state_id, identity_id, task_id, kind, state, causal_graph, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [stateId, identityId, taskId, "snapshot", JSON.stringify(state), JSON.stringify(causalGraph)]
    )

    return {
      state_id: stateId,
      identity_id: identityId,
      ...(taskId && { task_id: taskId }),
      kind: "snapshot",
      state,
      causal_graph: causalGraph,
      created_at: new Date().toISOString(),
    }
  }

  async function getState(stateId: string): Promise<WorldState | null> {
    const result = await queryOne<WorldModelStateRow>(
      "SELECT * FROM world_model_states WHERE state_id = $1",
      [stateId]
    )

    if (!result) return null

    return {
      state_id: result.state_id,
      identity_id: result.identity_id,
      ...(result.task_id && { task_id: result.task_id }),
      kind: result.kind as "snapshot" | "prediction" | "counterfactual" | "checkpoint",
      state: result.state as Record<string, unknown>,
      causal_graph: result.causal_graph as CausalGraph,
      created_at: result.created_at,
    }
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  async function simulateAction(action: PlanAction, state: WorldState): Promise<SimulationResult> {
    const simulationId = crypto.randomUUID()

    log.debug({ action: action.description, stateId: state.state_id }, "Simulating action")

    // Analyze action for potential effects
    const sideEffects = analyzeSideEffects(action)
    const risks = assessActionRisks(action, state)

    // Predict state changes
    const predictedState = predictStateChange(action, state.state)

    // Calculate confidence based on similar past actions
    const confidence = await calculateActionConfidence(action, state.identity_id)

    const actionSimulation: ActionSimulation = {
      action_index: 0,
      action,
      predicted_state: predictedState,
      confidence,
      side_effects: sideEffects,
    }

    const result: SimulationResult = {
      simulation_id: simulationId,
      initial_state_id: state.state_id,
      simulated_actions: [actionSimulation],
      predicted_outcomes: generatePredictedOutcomes(action, predictedState),
      overall_confidence: confidence,
      identified_risks: risks,
      failure_scenarios: generateFailureScenarios(action, risks),
      recommended_checkpoints: risks.some((r) => r.severity > 0.6) ? [0] : [],
    }

    // Persist simulation
    await query(
      `INSERT INTO world_model_simulations (
        simulation_id, identity_id, task_id, simulation_type, initial_state_id,
        simulated_actions, predicted_outcomes, overall_confidence,
        identified_risks, failure_scenarios, recommended_checkpoints, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
      [
        simulationId,
        state.identity_id,
        state.task_id,
        "action_prediction",
        state.state_id,
        JSON.stringify([action]),
        JSON.stringify(result.predicted_outcomes),
        result.overall_confidence,
        JSON.stringify(result.identified_risks),
        JSON.stringify(result.failure_scenarios),
        JSON.stringify(result.recommended_checkpoints),
      ]
    )

    return result
  }

  async function simulatePlan(plan: PlanAction[], state: WorldState): Promise<SimulationResult> {
    const simulationId = crypto.randomUUID()

    log.debug({ planLength: plan.length, stateId: state.state_id }, "Simulating full plan")

    const simulations: ActionSimulation[] = []
    const allRisks: RiskAssessment[] = []
    const allFailures: FailureScenario[] = []
    const checkpoints: number[] = []

    let currentState = { ...state.state }
    let overallConfidence = 1.0

    for (let i = 0; i < plan.length; i++) {
      const action = plan[i]
      if (!action) continue

      const sideEffects = analyzeSideEffects(action)
      const risks = assessActionRisks(action, { ...state, state: currentState })

      // Check if checkpoint recommended before this step
      const needsCheckpoint =
        risks.some((r) => r.severity > env.WORLD_MODEL_CHECKPOINT_THRESHOLD) ||
        sideEffects.some((e) => !e.reversible)

      if (needsCheckpoint) {
        checkpoints.push(i)
      }

      const predictedState = predictStateChange(action, currentState)
      const confidence = await calculateActionConfidence(action, state.identity_id)

      simulations.push({
        action_index: i,
        action,
        predicted_state: predictedState,
        confidence,
        side_effects: sideEffects,
      })

      allRisks.push(...risks.map((r) => ({ ...r, step_index: i })))

      allFailures.push(
        ...generateFailureScenarios(action, risks).map((f) => ({
          ...f,
          step_index: i,
        }))
      )

      currentState = predictedState
      overallConfidence *= confidence
    }

    const result: SimulationResult = {
      simulation_id: simulationId,
      initial_state_id: state.state_id,
      simulated_actions: simulations,
      predicted_outcomes: generatePlanOutcomes(plan, currentState),
      overall_confidence: overallConfidence ** (1 / plan.length), // Geometric mean
      identified_risks: allRisks,
      failure_scenarios: allFailures,
      recommended_checkpoints: checkpoints,
    }

    // Persist simulation
    await query(
      `INSERT INTO world_model_simulations (
        simulation_id, identity_id, task_id, simulation_type, initial_state_id,
        simulated_actions, predicted_outcomes, overall_confidence,
        identified_risks, failure_scenarios, recommended_checkpoints, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
      [
        simulationId,
        state.identity_id,
        state.task_id,
        "plan_validation",
        state.state_id,
        JSON.stringify(plan),
        JSON.stringify(result.predicted_outcomes),
        result.overall_confidence,
        JSON.stringify(result.identified_risks),
        JSON.stringify(result.failure_scenarios),
        JSON.stringify(result.recommended_checkpoints),
      ]
    )

    return result
  }

  // ---------------------------------------------------------------------------
  // Lookahead
  // ---------------------------------------------------------------------------

  async function lookAhead(
    currentStep: number,
    plan: PlanAction[],
    depth: number,
    state: WorldState
  ): Promise<LookaheadResult> {
    log.debug({ currentStep, depth, planLength: plan.length }, "Performing lookahead")

    const lookaheadSteps = plan.slice(currentStep, currentStep + depth)
    const { blockers, recommendations } = processLookaheadSteps(
      lookaheadSteps,
      currentStep,
      state.state
    )

    const checkpointDecision = determineCheckpointNeed(blockers, lookaheadSteps)

    return {
      current_step: currentStep,
      lookahead_depth: depth,
      predicted_blockers: blockers,
      recommended_actions: recommendations,
      checkpoint_recommended: checkpointDecision.recommended,
      ...(checkpointDecision.reason && { checkpoint_reason: checkpointDecision.reason }),
    }
  }

  function processLookaheadSteps(
    lookaheadSteps: PlanAction[],
    currentStep: number,
    initialState: Record<string, unknown>
  ): {
    blockers: PredictedBlocker[]
    recommendations: RecommendedAction[]
    simulatedState: Record<string, unknown>
  } {
    const blockers: PredictedBlocker[] = []
    const recommendations: RecommendedAction[] = []
    let simulatedState = { ...initialState }

    for (let i = 0; i < lookaheadSteps.length; i++) {
      const action = lookaheadSteps[i]
      if (!action) continue

      const stepIndex = currentStep + i
      const potentialBlockers = detectPotentialBlockers(action, simulatedState)

      processBlockersForStep(potentialBlockers, stepIndex, blockers, recommendations)
      simulatedState = predictStateChange(action, simulatedState)
    }

    return { blockers, recommendations, simulatedState }
  }

  function processBlockersForStep(
    potentialBlockers: Array<{
      description: string
      probability: number
      prevention_possible: boolean
      prevention_action?: string
    }>,
    stepIndex: number,
    blockers: PredictedBlocker[],
    recommendations: RecommendedAction[]
  ): void {
    for (const blocker of potentialBlockers) {
      blockers.push({
        step_index: stepIndex,
        description: blocker.description,
        probability: blocker.probability,
        prevention_possible: blocker.prevention_possible,
        ...(blocker.prevention_action && { prevention_action: blocker.prevention_action }),
      })

      if (shouldAddPreventionRecommendation(blocker)) {
        recommendations.push(createPreventionRecommendation(blocker))
      }
    }
  }

  function shouldAddPreventionRecommendation(blocker: {
    prevention_possible: boolean
    probability: number
  }): boolean {
    return blocker.prevention_possible && blocker.probability > 0.5
  }

  function createPreventionRecommendation(blocker: {
    prevention_action?: string
    probability: number
  }): RecommendedAction {
    return {
      action_type: "prepare",
      description: blocker.prevention_action ?? "Take preventive action",
      urgency: blocker.probability > 0.7 ? "high" : "medium",
    }
  }

  function determineCheckpointNeed(
    blockers: PredictedBlocker[],
    lookaheadSteps: PlanAction[]
  ): { recommended: boolean; reason: string | null } {
    const highRiskAhead = blockers.some((b) => b.probability > 0.6)
    const irreversibleAhead = hasIrreversibleActions(lookaheadSteps)

    const reason = getCheckpointReason(highRiskAhead, irreversibleAhead)

    return {
      recommended: highRiskAhead || irreversibleAhead,
      reason,
    }
  }

  function hasIrreversibleActions(actions: PlanAction[]): boolean {
    return actions.some((a) => analyzeSideEffects(a).some((e) => !e.reversible))
  }

  function getCheckpointReason(highRiskAhead: boolean, irreversibleAhead: boolean): string | null {
    if (highRiskAhead) {
      return "High-probability blocker detected ahead"
    }
    if (irreversibleAhead) {
      return "Irreversible action upcoming"
    }
    return null
  }

  // ---------------------------------------------------------------------------
  // Counterfactual Analysis
  // ---------------------------------------------------------------------------

  async function analyzeCounterfactual(
    failedAction: PlanAction,
    actualOutcome: Record<string, unknown>,
    state: WorldState
  ): Promise<CounterfactualAnalysis> {
    const analysisId = crypto.randomUUID()

    log.debug({ action: failedAction.description }, "Performing counterfactual analysis")

    // Generate alternative actions
    const alternatives = generateAlternativeActions(failedAction, state)

    // Simulate each alternative
    const simulatedAlternatives: AlternativeAction[] = []
    for (const alt of alternatives) {
      const predicted = predictStateChange(alt, state.state)
      const confidence = await calculateActionConfidence(alt, state.identity_id)

      simulatedAlternatives.push({
        action: alt,
        simulated_outcome: predicted,
        success_probability: confidence,
        cost_comparison: compareActionCost(failedAction, alt),
      })
    }

    // Find best alternative
    const bestAlternative = simulatedAlternatives
      .filter((a) => a.success_probability > 0.5)
      .sort((a, b) => b.success_probability - a.success_probability)[0]

    // Analyze root cause
    const rootCauseHypothesis = inferRootCause(failedAction, actualOutcome, state)

    // Calculate preventability
    const preventabilityScore = bestAlternative
      ? Math.min(1, bestAlternative.success_probability * 1.2)
      : 0.2

    // Extract lessons
    const lessons = extractLessons(failedAction, actualOutcome, bestAlternative)

    const analysis: CounterfactualAnalysis = {
      analysis_id: analysisId,
      failed_action: failedAction,
      actual_outcome: actualOutcome,
      alternative_actions: simulatedAlternatives,
      ...(bestAlternative && { best_alternative: bestAlternative }),
      ...(rootCauseHypothesis && { root_cause_hypothesis: rootCauseHypothesis }),
      preventability_score: preventabilityScore,
      lessons_learned: lessons,
    }

    // Persist analysis
    await query(
      `INSERT INTO counterfactual_analyses (
        analysis_id, identity_id, task_id, failed_action, actual_outcome,
        alternative_actions, simulated_outcomes, best_alternative,
        root_cause_hypothesis, preventability_score, lessons_learned, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
      [
        analysisId,
        state.identity_id,
        state.task_id,
        JSON.stringify(failedAction),
        JSON.stringify(actualOutcome),
        JSON.stringify(simulatedAlternatives.map((a) => a.action)),
        JSON.stringify(simulatedAlternatives.map((a) => a.simulated_outcome)),
        JSON.stringify(bestAlternative),
        rootCauseHypothesis,
        preventabilityScore,
        JSON.stringify(lessons),
      ]
    )

    return analysis
  }

  // ---------------------------------------------------------------------------
  // Checkpoints
  // ---------------------------------------------------------------------------

  async function createCheckpoint(
    taskId: string,
    stepIndex: number,
    state: WorldState,
    riskLevel: number,
    isIrreversibleNext: boolean
  ): Promise<Checkpoint> {
    const checkpointId = crypto.randomUUID()

    log.debug({ taskId, stepIndex, riskLevel }, "Creating checkpoint")

    const recoveryActions = generateRecoveryActions(state, stepIndex)
    const expiresAt = new Date(Date.now() + env.WORLD_MODEL_CHECKPOINT_TTL_MS)

    await query(
      `INSERT INTO world_model_checkpoints (
        checkpoint_id, identity_id, task_id, step_id, state_snapshot,
        causal_graph_snapshot, step_index, risk_level, is_irreversible_next,
        recovery_actions, expires_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
      [
        checkpointId,
        state.identity_id,
        taskId,
        null, // step_id can be added if available
        JSON.stringify(state.state),
        JSON.stringify(state.causal_graph),
        stepIndex,
        riskLevel,
        isIrreversibleNext,
        JSON.stringify(recoveryActions),
        expiresAt.toISOString(),
      ]
    )

    return {
      checkpoint_id: checkpointId,
      task_id: taskId,
      step_index: stepIndex,
      state_snapshot: state.state,
      causal_graph_snapshot: state.causal_graph,
      risk_level: riskLevel,
      is_irreversible_next: isIrreversibleNext,
      recovery_actions: recoveryActions,
      created_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
    }
  }

  async function getCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
    const result = await queryOne<WorldModelCheckpointRow>(
      "SELECT * FROM world_model_checkpoints WHERE checkpoint_id = $1",
      [checkpointId]
    )

    if (!result) return null

    return mapRowToCheckpoint(result)
  }

  async function listCheckpoints(taskId: string): Promise<Checkpoint[]> {
    const result = await query<WorldModelCheckpointRow>(
      `SELECT * FROM world_model_checkpoints
       WHERE task_id = $1 AND used_for_rollback = false
       AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY step_index DESC`,
      [taskId]
    )

    return result.rows.map(mapRowToCheckpoint)
  }

  async function rollbackToCheckpoint(checkpointId: string): Promise<WorldState> {
    const checkpoint = await getCheckpoint(checkpointId)
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`)
    }

    log.info({ checkpointId, stepIndex: checkpoint.step_index }, "Rolling back to checkpoint")

    // Mark checkpoint as used
    await query(
      `UPDATE world_model_checkpoints
       SET used_for_rollback = true, rolled_back_at = NOW()
       WHERE checkpoint_id = $1`,
      [checkpointId]
    )

    // Create a new state from the checkpoint
    const stateId = crypto.randomUUID()
    const taskResult = await queryOne<TaskIdentityRow>(
      "SELECT identity_id FROM tasks WHERE task_id = $1",
      [checkpoint.task_id]
    )

    await query(
      `INSERT INTO world_model_states (
        state_id, identity_id, task_id, kind, state, causal_graph, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        stateId,
        taskResult?.identity_id,
        checkpoint.task_id,
        "checkpoint",
        JSON.stringify(checkpoint.state_snapshot),
        JSON.stringify(checkpoint.causal_graph_snapshot),
      ]
    )

    return {
      state_id: stateId,
      identity_id: taskResult?.identity_id ?? "",
      task_id: checkpoint.task_id,
      kind: "checkpoint",
      state: checkpoint.state_snapshot,
      causal_graph: checkpoint.causal_graph_snapshot,
      created_at: new Date().toISOString(),
    }
  }

  // ---------------------------------------------------------------------------
  // Predictions
  // ---------------------------------------------------------------------------

  async function recordPrediction(
    identityId: string,
    simulationId: string,
    predicted: Record<string, unknown>,
    confidence: number
  ): Promise<string> {
    const predictionId = crypto.randomUUID()

    await query(
      `INSERT INTO world_model_predictions (
        prediction_id, identity_id, simulation_id, predicted_outcome, confidence, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())`,
      [predictionId, identityId, simulationId, JSON.stringify(predicted), confidence]
    )

    return predictionId
  }

  async function verifyPrediction(
    predictionId: string,
    actual: Record<string, unknown>
  ): Promise<number> {
    const result = await queryOne<WorldModelPredictionRow>(
      "SELECT predicted_outcome, confidence FROM world_model_predictions WHERE prediction_id = $1",
      [predictionId]
    )

    if (!result) {
      throw new Error(`Prediction not found: ${predictionId}`)
    }

    const predicted = result.predicted_outcome as Record<string, unknown>
    const accuracy = calculatePredictionAccuracy(predicted, actual)

    await query(
      `UPDATE world_model_predictions
       SET verified_at = NOW(), actual_outcome = $2, accuracy_score = $3
       WHERE prediction_id = $1`,
      [predictionId, JSON.stringify(actual), accuracy]
    )

    return accuracy
  }

  // ---------------------------------------------------------------------------
  // Helper Functions
  // ---------------------------------------------------------------------------

  function buildCausalGraphFromState(
    state: Record<string, unknown>,
    tasks: Array<{ task_id: string; goal: string }>
  ): CausalGraph {
    const nodes: CausalNode[] = []
    const edges: CausalEdge[] = []

    // Add task nodes
    for (const task of tasks) {
      nodes.push({
        node_id: task.task_id,
        type: "entity",
        label: task.goal,
        properties: { status: "active" },
      })
    }

    // Add state node
    nodes.push({
      node_id: "current_state",
      type: "state",
      label: "Current World State",
      properties: state,
    })

    // Connect tasks to state
    for (const task of tasks) {
      edges.push({
        source_id: task.task_id,
        target_id: "current_state",
        relationship: "modifies",
        strength: 0.7,
        confidence: 0.8,
      })
    }

    return { nodes, edges }
  }

  function analyzeSideEffects(action: PlanAction): SideEffect[] {
    if (!action.tool) {
      return []
    }

    const tool = action.tool.toLowerCase()
    const effects: SideEffect[] = []

    const detectedEffects = detectToolEffects(tool, action.tool)
    effects.push(...detectedEffects)

    return effects
  }

  function detectToolEffects(toolLower: string, toolOriginal: string): SideEffect[] {
    const effectDetectors = [
      createDataModificationDetector(),
      createDeletionDetector(),
      createExternalCallDetector(),
      createExecutionDetector(),
    ]

    const effects: SideEffect[] = []
    for (const detector of effectDetectors) {
      const effect = detector(toolLower, toolOriginal)
      if (effect) {
        effects.push(effect)
      }
    }

    return effects
  }

  function createDataModificationDetector(): (
    toolLower: string,
    toolOriginal: string
  ) => SideEffect | null {
    return (toolLower, toolOriginal) => {
      const modificationPatterns = ["write", "create", "edit"]
      if (modificationPatterns.some((pattern) => toolLower.includes(pattern))) {
        return {
          type: "data_modification",
          description: `File/data modification via ${toolOriginal}`,
          reversible: true,
        }
      }
      return null
    }
  }

  function createDeletionDetector(): (
    toolLower: string,
    toolOriginal: string
  ) => SideEffect | null {
    return (toolLower, toolOriginal) => {
      const deletionPatterns = ["delete", "remove"]
      if (deletionPatterns.some((pattern) => toolLower.includes(pattern))) {
        return {
          type: "data_modification",
          description: `Deletion via ${toolOriginal}`,
          reversible: false,
        }
      }
      return null
    }
  }

  function createExternalCallDetector(): (
    toolLower: string,
    toolOriginal: string
  ) => SideEffect | null {
    return (toolLower, toolOriginal) => {
      const externalPatterns = ["api", "http", "fetch"]
      if (externalPatterns.some((pattern) => toolLower.includes(pattern))) {
        return {
          type: "external_call",
          description: `External API call via ${toolOriginal}`,
          reversible: false,
        }
      }
      return null
    }
  }

  function createExecutionDetector(): (
    toolLower: string,
    toolOriginal: string
  ) => SideEffect | null {
    return (toolLower, toolOriginal) => {
      const executionPatterns = ["execute", "run"]
      if (executionPatterns.some((pattern) => toolLower.includes(pattern))) {
        return {
          type: "state_change",
          description: `Code execution via ${toolOriginal}`,
          reversible: false,
        }
      }
      return null
    }
  }

  function assessActionRisks(action: PlanAction, _state: WorldState): RiskAssessment[] {
    const risks: RiskAssessment[] = []

    // Check predefined risk factors
    if (action.risk_factors) {
      for (const factor of action.risk_factors) {
        risks.push({
          risk_id: crypto.randomUUID(),
          description: factor,
          probability: 0.5,
          severity: 0.6,
          step_index: 0,
          mitigation: "Review before proceeding",
        })
      }
    }

    // Analyze tool-specific risks
    if (action.tool) {
      const tool = action.tool.toLowerCase()

      if (tool.includes("delete")) {
        risks.push({
          risk_id: crypto.randomUUID(),
          description: "Irreversible deletion operation",
          probability: 0.9,
          severity: 0.8,
          step_index: 0,
          mitigation: "Create backup before deletion",
        })
      }

      if (tool.includes("deploy") || tool.includes("publish")) {
        risks.push({
          risk_id: crypto.randomUUID(),
          description: "Production deployment",
          probability: 0.7,
          severity: 0.7,
          step_index: 0,
          mitigation: "Verify in staging first",
        })
      }
    }

    return risks
  }

  function predictStateChange(
    action: PlanAction,
    currentState: Record<string, unknown>
  ): Record<string, unknown> {
    // Simple state prediction - in production, this would use ML models
    const newState = { ...currentState }

    if (action.tool) {
      newState.last_action = {
        tool: action.tool,
        description: action.description,
        timestamp: new Date().toISOString(),
      }

      // Track resource changes
      if (action.tool.includes("create") || action.tool.includes("write")) {
        newState.resources_created = ((currentState.resources_created as number) ?? 0) + 1
      }
      if (action.tool.includes("delete")) {
        newState.resources_deleted = ((currentState.resources_deleted as number) ?? 0) + 1
      }
    }

    return newState
  }

  async function calculateActionConfidence(
    action: PlanAction,
    identityId: string
  ): Promise<number> {
    if (!action.tool) return 0.7

    // Check historical success rate for this tool
    const result = await queryOne<SkillUsageRow>(
      `SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE success = true) AS successful
       FROM skill_usage_records
       WHERE identity_id = $1 AND skill_name = $2`,
      [identityId, action.tool]
    )

    if (!result || result.total === 0) return 0.6 // Default for unknown tools

    return (result.successful / result.total) * 0.8 + 0.2 // Floor at 0.2
  }

  function generatePredictedOutcomes(
    action: PlanAction,
    _predictedState: Record<string, unknown>
  ): PredictedOutcome[] {
    return [
      {
        outcome_id: crypto.randomUUID(),
        description: `Action "${action.description}" completes successfully`,
        probability: 0.7,
        impact: "positive",
        affected_entities: [action.tool ?? "unknown"],
      },
    ]
  }

  function generatePlanOutcomes(
    plan: PlanAction[],
    _finalState: Record<string, unknown>
  ): PredictedOutcome[] {
    return [
      {
        outcome_id: crypto.randomUUID(),
        description: `Plan with ${plan.length} steps completes successfully`,
        probability: 0.6,
        impact: "positive",
        affected_entities: plan.map((a) => a.tool ?? "unknown"),
      },
    ]
  }

  function generateFailureScenarios(
    action: PlanAction,
    risks: RiskAssessment[]
  ): FailureScenario[] {
    return risks
      .filter((r) => r.severity > 0.5)
      .map((r) => ({
        scenario_id: crypto.randomUUID(),
        trigger: r.description,
        step_index: r.step_index,
        cascading_effects: [`Failure in ${action.description}`],
        recovery_strategy: r.mitigation,
      }))
  }

  function detectPotentialBlockers(
    action: PlanAction,
    _state: Record<string, unknown>
  ): Array<{
    description: string
    probability: number
    prevention_possible: boolean
    prevention_action?: string
  }> {
    const blockers: Array<{
      description: string
      probability: number
      prevention_possible: boolean
      prevention_action?: string
    }> = []

    // Check for common blockers based on action type
    if (action.tool?.includes("api") || action.tool?.includes("fetch")) {
      blockers.push({
        description: "API rate limiting or timeout",
        probability: 0.3,
        prevention_possible: true,
        prevention_action: "Add retry logic with exponential backoff",
      })
    }

    if (action.tool?.includes("file") || action.tool?.includes("write")) {
      blockers.push({
        description: "File permission or disk space issue",
        probability: 0.2,
        prevention_possible: true,
        prevention_action: "Verify permissions and disk space before write",
      })
    }

    return blockers
  }

  function generateAlternativeActions(failedAction: PlanAction, _state: WorldState): PlanAction[] {
    const alternatives: PlanAction[] = []

    // Generate alternatives based on the failed action type
    if (failedAction.tool) {
      // Try with different parameters
      alternatives.push({
        ...failedAction,
        description: `${failedAction.description} (with timeout increase)`,
        parameters: { ...failedAction.parameters, timeout: 60000 },
      })

      // Try with retry logic
      alternatives.push({
        ...failedAction,
        description: `${failedAction.description} (with retry)`,
        parameters: { ...failedAction.parameters, retry: 3 },
      })
    }

    return alternatives
  }

  function compareActionCost(
    _original: PlanAction,
    alternative: PlanAction
  ): "lower" | "same" | "higher" {
    // Simple heuristic - alternatives with retries cost more
    if (alternative.parameters?.retry) return "higher"
    if (alternative.parameters?.timeout) return "same"
    return "same"
  }

  function inferRootCause(
    _failedAction: PlanAction,
    actualOutcome: Record<string, unknown>,
    _state: WorldState
  ): string {
    const error = actualOutcome.error ?? actualOutcome.message ?? ""

    if (String(error).includes("timeout")) {
      return "Operation exceeded time limit - possible resource constraint"
    }
    if (String(error).includes("permission")) {
      return "Insufficient permissions for the requested operation"
    }
    if (String(error).includes("not found")) {
      return "Required resource or dependency not available"
    }

    return "Unknown root cause - requires investigation"
  }

  function extractLessons(
    failedAction: PlanAction,
    actualOutcome: Record<string, unknown>,
    bestAlternative?: AlternativeAction
  ): string[] {
    const lessons: string[] = []

    lessons.push(
      `Action "${failedAction.description}" failed with outcome: ${JSON.stringify(actualOutcome).slice(0, 100)}`
    )

    if (bestAlternative) {
      lessons.push(
        `Alternative approach "${bestAlternative.action.description}" has ${(bestAlternative.success_probability * 100).toFixed(0)}% success probability`
      )
    }

    return lessons
  }

  function generateRecoveryActions(state: WorldState, stepIndex: number): RecoveryAction[] {
    return [
      {
        action_type: "rollback",
        description: `Restore state from checkpoint at step ${stepIndex}`,
        target_state_id: state.state_id,
      },
      {
        action_type: "retry",
        description: "Retry the failed action with adjusted parameters",
      },
      {
        action_type: "escalate",
        description: "Escalate to human review",
      },
    ]
  }

  function mapRowToCheckpoint(row: WorldModelCheckpointRow): Checkpoint {
    return {
      checkpoint_id: row.checkpoint_id,
      task_id: row.task_id,
      step_index: row.step_index,
      state_snapshot: row.state_snapshot as Record<string, unknown>,
      causal_graph_snapshot: row.causal_graph_snapshot as CausalGraph,
      risk_level: row.risk_level,
      is_irreversible_next: row.is_irreversible_next,
      recovery_actions: row.recovery_actions as RecoveryAction[],
      created_at: row.created_at,
      ...(row.expires_at && { expires_at: row.expires_at }),
    }
  }

  function calculatePredictionAccuracy(
    predicted: Record<string, unknown>,
    actual: Record<string, unknown>
  ): number {
    // Simple accuracy calculation - compare key overlap and value similarity
    const predictedKeys = Object.keys(predicted)
    const actualKeys = Object.keys(actual)

    if (predictedKeys.length === 0 && actualKeys.length === 0) return 1.0
    if (predictedKeys.length === 0 || actualKeys.length === 0) return 0.0

    const commonKeys = predictedKeys.filter((k) => actualKeys.includes(k))
    const keyOverlap = commonKeys.length / Math.max(predictedKeys.length, actualKeys.length)

    let valueSimilarity = 0
    for (const key of commonKeys) {
      if (JSON.stringify(predicted[key]) === JSON.stringify(actual[key])) {
        valueSimilarity += 1
      }
    }
    valueSimilarity = commonKeys.length > 0 ? valueSimilarity / commonKeys.length : 0

    return keyOverlap * 0.4 + valueSimilarity * 0.6
  }

  return {
    captureCurrentState,
    getState,
    simulateAction,
    simulatePlan,
    lookAhead,
    analyzeCounterfactual,
    createCheckpoint,
    getCheckpoint,
    listCheckpoints,
    rollbackToCheckpoint,
    recordPrediction,
    verifyPrediction,
  }
}
