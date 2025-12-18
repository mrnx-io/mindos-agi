// =============================================================================
// Predictive Engine
// =============================================================================

import type pg from "pg"
import type { Prediction, WorldState } from "./types.js"

// -----------------------------------------------------------------------------
// Predictor Interface
// -----------------------------------------------------------------------------

export interface PredictionEngine {
  predictStateChange(
    currentState: WorldState,
    targetProperty: string,
    options?: PredictionOptions
  ): Promise<Prediction>

  predictEventOccurrence(
    eventType: string,
    context: Record<string, unknown>,
    options?: PredictionOptions
  ): Promise<Prediction>

  predictGoalOutcome(
    goalId: string,
    currentState: WorldState,
    options?: PredictionOptions
  ): Promise<Prediction>

  validatePrediction(
    predictionId: string,
    actualOutcome: Record<string, unknown>
  ): Promise<PredictionValidation>

  getPredictionAccuracy(identityId: string): Promise<AccuracyMetrics>
}

export interface PredictionOptions {
  confidence_threshold?: number
  time_horizon_hours?: number
  include_assumptions?: boolean
}

export interface PredictionValidation {
  prediction_id: string
  was_accurate: boolean
  accuracy_score: number
  deviation_analysis: string
}

export interface AccuracyMetrics {
  total_predictions: number
  validated_predictions: number
  average_accuracy: number
  accuracy_by_type: Record<string, number>
  calibration_score: number
}

// -----------------------------------------------------------------------------
// Create Prediction Engine
// -----------------------------------------------------------------------------

export function createPredictionEngine(pool: pg.Pool): PredictionEngine {
  // Historical predictions for learning
  const predictionHistory: Prediction[] = []

  // -----------------------------------------------------------------------------
  // Predict State Change
  // -----------------------------------------------------------------------------

  async function predictStateChange(
    currentState: WorldState,
    targetProperty: string,
    options: PredictionOptions = {}
  ): Promise<Prediction> {
    const timeHorizon = options.time_horizon_hours ?? 24

    // Analyze historical patterns for this property
    const patterns = await analyzeHistoricalPatterns(currentState.identity_id, targetProperty)

    // Generate prediction based on patterns
    const prediction: Prediction = {
      prediction_id: crypto.randomUUID(),
      identity_id: currentState.identity_id,
      prediction_type: "state_change",
      target_description: `Change in ${targetProperty}`,
      predicted_outcome: generateOutcomePrediction(patterns, currentState),
      confidence: calculateConfidence(patterns, currentState),
      time_horizon: {
        earliest: new Date(Date.now() + timeHorizon * 0.5 * 3600000).toISOString(),
        most_likely: new Date(Date.now() + timeHorizon * 3600000).toISOString(),
        latest: new Date(Date.now() + timeHorizon * 1.5 * 3600000).toISOString(),
      },
      supporting_evidence: patterns.evidence,
      assumptions: options.include_assumptions ? patterns.assumptions : [],
      created_at: new Date().toISOString(),
    }

    // Persist prediction
    await persistPrediction(prediction)
    predictionHistory.push(prediction)

    return prediction
  }

  // -----------------------------------------------------------------------------
  // Predict Event Occurrence
  // -----------------------------------------------------------------------------

  async function predictEventOccurrence(
    eventType: string,
    context: Record<string, unknown>,
    options: PredictionOptions = {}
  ): Promise<Prediction> {
    const _timeHorizon = options.time_horizon_hours ?? 24
    const identityId = (context.identity_id as string) ?? "system"

    // Analyze event frequency and patterns
    const eventPatterns = await analyzeEventPatterns(identityId, eventType)

    // Calculate probability based on patterns
    const probability = calculateEventProbability(eventPatterns, context)

    const prediction: Prediction = {
      prediction_id: crypto.randomUUID(),
      identity_id: identityId,
      prediction_type: "event_occurrence",
      target_description: `Occurrence of ${eventType}`,
      predicted_outcome: {
        will_occur: probability > (options.confidence_threshold ?? 0.5),
        probability,
        expected_context: eventPatterns.typical_context,
      },
      confidence: Math.min(probability + 0.2, 1),
      time_horizon: {
        earliest: new Date(Date.now() + eventPatterns.avg_interval_ms * 0.5).toISOString(),
        most_likely: new Date(Date.now() + eventPatterns.avg_interval_ms).toISOString(),
        latest: new Date(Date.now() + eventPatterns.avg_interval_ms * 2).toISOString(),
      },
      supporting_evidence: eventPatterns.evidence,
      assumptions: ["Historical patterns continue", "No major external disruptions"],
      created_at: new Date().toISOString(),
    }

    await persistPrediction(prediction)
    return prediction
  }

  // -----------------------------------------------------------------------------
  // Predict Goal Outcome
  // -----------------------------------------------------------------------------

  async function predictGoalOutcome(
    goalId: string,
    currentState: WorldState,
    _options: PredictionOptions = {}
  ): Promise<Prediction> {
    // Fetch goal details
    const goalResult = await pool.query("SELECT * FROM tasks WHERE task_id = $1", [goalId])

    if (goalResult.rows.length === 0) {
      throw new Error(`Goal ${goalId} not found`)
    }

    const goal = goalResult.rows[0]

    // Analyze similar completed goals
    const similarGoals = await findSimilarGoals(goal, currentState.identity_id)

    // Calculate success probability
    const successRate =
      similarGoals.length > 0
        ? similarGoals.filter((g) => g.status === "completed").length / similarGoals.length
        : 0.5

    // Estimate completion time
    const avgDuration =
      similarGoals.length > 0
        ? similarGoals
            .filter((g) => g.completed_at)
            .reduce(
              (sum, g) =>
                sum + (new Date(g.completed_at).getTime() - new Date(g.created_at).getTime()),
              0
            ) / similarGoals.filter((g) => g.completed_at).length
        : 3600000 // Default 1 hour

    const prediction: Prediction = {
      prediction_id: crypto.randomUUID(),
      identity_id: currentState.identity_id,
      prediction_type: "goal_outcome",
      target_description: `Outcome of goal: ${goal.goal}`,
      predicted_outcome: {
        will_succeed: successRate > 0.5,
        success_probability: successRate,
        estimated_steps_remaining: goal.progress ? Math.ceil((1 - goal.progress) * 10) : 5,
        potential_blockers: identifyBlockers(goal, currentState),
      },
      confidence: calculateGoalConfidence(similarGoals.length, successRate),
      time_horizon: {
        earliest: new Date(Date.now() + avgDuration * 0.5).toISOString(),
        most_likely: new Date(Date.now() + avgDuration).toISOString(),
        latest: new Date(Date.now() + avgDuration * 2).toISOString(),
      },
      supporting_evidence: similarGoals.slice(0, 5).map((g) => g.task_id),
      assumptions: [
        "Current progress rate continues",
        "No new blockers emerge",
        "Resources remain available",
      ],
      created_at: new Date().toISOString(),
    }

    await persistPrediction(prediction)
    return prediction
  }

  // -----------------------------------------------------------------------------
  // Validate Prediction
  // -----------------------------------------------------------------------------

  async function validatePrediction(
    predictionId: string,
    actualOutcome: Record<string, unknown>
  ): Promise<PredictionValidation> {
    // Fetch prediction
    const result = await pool.query("SELECT * FROM predictions WHERE prediction_id = $1", [
      predictionId,
    ])

    if (result.rows.length === 0) {
      throw new Error(`Prediction ${predictionId} not found`)
    }

    const prediction = result.rows[0]
    const predictedOutcome = prediction.predicted_outcome

    // Calculate accuracy score
    const accuracyScore = calculateAccuracyScore(predictedOutcome, actualOutcome)
    const wasAccurate = accuracyScore > 0.7

    // Generate deviation analysis
    const deviationAnalysis = analyzeDeviation(predictedOutcome, actualOutcome)

    // Update prediction record
    await pool.query(
      `UPDATE predictions SET
        validated_at = $1,
        actual_outcome = $2,
        accuracy_score = $3
      WHERE prediction_id = $4`,
      [new Date().toISOString(), JSON.stringify(actualOutcome), accuracyScore, predictionId]
    )

    return {
      prediction_id: predictionId,
      was_accurate: wasAccurate,
      accuracy_score: accuracyScore,
      deviation_analysis: deviationAnalysis,
    }
  }

  // -----------------------------------------------------------------------------
  // Get Accuracy Metrics
  // -----------------------------------------------------------------------------

  async function getPredictionAccuracy(identityId: string): Promise<AccuracyMetrics> {
    const result = await pool.query(
      `SELECT
        COUNT(*) as total,
        COUNT(validated_at) as validated,
        AVG(accuracy_score) FILTER (WHERE validated_at IS NOT NULL) as avg_accuracy,
        prediction_type,
        AVG(accuracy_score) FILTER (WHERE validated_at IS NOT NULL) as type_accuracy
      FROM predictions
      WHERE identity_id = $1
      GROUP BY prediction_type`,
      [identityId]
    )

    const accuracyByType: Record<string, number> = {}
    let totalPredictions = 0
    let validatedPredictions = 0
    let totalAccuracy = 0

    for (const row of result.rows) {
      totalPredictions += Number.parseInt(row.total)
      validatedPredictions += Number.parseInt(row.validated)
      if (row.type_accuracy) {
        accuracyByType[row.prediction_type] = Number.parseFloat(row.type_accuracy)
        totalAccuracy += Number.parseFloat(row.type_accuracy)
      }
    }

    const averageAccuracy = result.rows.length > 0 ? totalAccuracy / result.rows.length : 0

    // Calculate calibration score
    const calibrationScore = await calculateCalibrationScore(identityId)

    return {
      total_predictions: totalPredictions,
      validated_predictions: validatedPredictions,
      average_accuracy: averageAccuracy,
      accuracy_by_type: accuracyByType,
      calibration_score: calibrationScore,
    }
  }

  // -----------------------------------------------------------------------------
  // Helper Functions
  // -----------------------------------------------------------------------------

  async function analyzeHistoricalPatterns(
    _identityId: string,
    _property: string
  ): Promise<{
    trend: "increasing" | "decreasing" | "stable"
    volatility: number
    evidence: string[]
    assumptions: string[]
  }> {
    // Would analyze actual historical data in production
    return {
      trend: "stable",
      volatility: 0.2,
      evidence: ["Historical pattern analysis"],
      assumptions: ["Past patterns continue"],
    }
  }

  async function analyzeEventPatterns(
    identityId: string,
    eventType: string
  ): Promise<{
    frequency: number
    avg_interval_ms: number
    typical_context: Record<string, unknown>
    evidence: string[]
  }> {
    const result = await pool.query(
      `SELECT created_at FROM events
       WHERE identity_id = $1 AND event_type = $2
       ORDER BY created_at DESC LIMIT 100`,
      [identityId, eventType]
    )

    if (result.rows.length < 2) {
      return {
        frequency: 0,
        avg_interval_ms: 3600000,
        typical_context: {},
        evidence: [],
      }
    }

    // Calculate average interval
    let totalInterval = 0
    for (let i = 0; i < result.rows.length - 1; i++) {
      const interval =
        new Date(result.rows[i].created_at).getTime() -
        new Date(result.rows[i + 1].created_at).getTime()
      totalInterval += interval
    }

    const avgInterval = totalInterval / (result.rows.length - 1)

    return {
      frequency: result.rows.length,
      avg_interval_ms: avgInterval,
      typical_context: {},
      evidence: result.rows.slice(0, 5).map((r) => r.created_at),
    }
  }

  function generateOutcomePrediction(
    patterns: { trend: string; volatility: number },
    state: WorldState
  ): Record<string, unknown> {
    return {
      expected_direction: patterns.trend,
      confidence_interval: {
        lower: 1 - patterns.volatility,
        upper: 1 + patterns.volatility,
      },
      uncertainty: state.uncertainty_bounds.overall,
    }
  }

  function calculateConfidence(patterns: { volatility: number }, state: WorldState): number {
    const baseConfidence = 0.7
    const volatilityPenalty = patterns.volatility * 0.3
    const uncertaintyPenalty = state.uncertainty_bounds.overall * 0.2

    return Math.max(0.1, baseConfidence - volatilityPenalty - uncertaintyPenalty)
  }

  function calculateEventProbability(
    patterns: { frequency: number; avg_interval_ms: number },
    _context: Record<string, unknown>
  ): number {
    if (patterns.frequency === 0) return 0.3

    // Higher frequency = higher probability
    const frequencyFactor = Math.min(patterns.frequency / 100, 1)

    // Recent events increase probability
    const timeFactor = patterns.avg_interval_ms < 3600000 ? 0.8 : 0.5

    return frequencyFactor * timeFactor
  }

  async function findSimilarGoals(
    goal: { goal: string; identity_id: string },
    identityId: string
  ): Promise<
    Array<{ task_id: string; status: string; created_at: string; completed_at?: string }>
  > {
    const result = await pool.query(
      `SELECT task_id, status, created_at, completed_at
       FROM tasks
       WHERE identity_id = $1 AND task_id != $2
       ORDER BY created_at DESC LIMIT 20`,
      [identityId, goal.goal]
    )

    return result.rows
  }

  function identifyBlockers(_goal: Record<string, unknown>, state: WorldState): string[] {
    const blockers: string[] = []

    if (state.uncertainty_bounds.overall > 0.5) {
      blockers.push("High state uncertainty")
    }

    if (state.active_goals.length > 5) {
      blockers.push("Many competing goals")
    }

    return blockers
  }

  function calculateGoalConfidence(sampleSize: number, successRate: number): number {
    // More samples = higher confidence
    const sampleFactor = Math.min(sampleSize / 10, 1)

    // Success rate near 0.5 = lower confidence
    const successFactor = Math.abs(successRate - 0.5) * 2

    return 0.3 + sampleFactor * 0.4 + successFactor * 0.3
  }

  function calculateAccuracyScore(
    predicted: Record<string, unknown>,
    actual: Record<string, unknown>
  ): number {
    let matches = 0
    let total = 0

    for (const key of Object.keys(predicted)) {
      total++
      if (JSON.stringify(predicted[key]) === JSON.stringify(actual[key])) {
        matches++
      } else if (typeof predicted[key] === "number" && typeof actual[key] === "number") {
        // Partial credit for numeric values
        const diff = Math.abs((predicted[key] as number) - (actual[key] as number))
        const maxVal = Math.max(Math.abs(predicted[key] as number), Math.abs(actual[key] as number))
        matches += maxVal > 0 ? Math.max(0, 1 - diff / maxVal) : 1
      }
    }

    return total > 0 ? matches / total : 0
  }

  function analyzeDeviation(
    predicted: Record<string, unknown>,
    actual: Record<string, unknown>
  ): string {
    const deviations: string[] = []

    for (const key of Object.keys(predicted)) {
      if (JSON.stringify(predicted[key]) !== JSON.stringify(actual[key])) {
        deviations.push(
          `${key}: predicted ${JSON.stringify(predicted[key])}, actual ${JSON.stringify(actual[key])}`
        )
      }
    }

    return deviations.length > 0
      ? `Deviations found: ${deviations.join("; ")}`
      : "Prediction matched actual outcome"
  }

  async function calculateCalibrationScore(identityId: string): Promise<number> {
    // Calibration: how well confidence matches actual accuracy
    const result = await pool.query(
      `SELECT confidence, accuracy_score
       FROM predictions
       WHERE identity_id = $1 AND validated_at IS NOT NULL`,
      [identityId]
    )

    if (result.rows.length < 5) return 0.5

    // Group by confidence bins and compare to actual accuracy
    const bins: Record<string, { total: number; accurate: number }> = {}

    for (const row of result.rows) {
      const bin = Math.floor(row.confidence * 10) / 10
      const binKey = bin.toFixed(1)

      if (!bins[binKey]) {
        bins[binKey] = { total: 0, accurate: 0 }
      }

      bins[binKey].total++
      if (row.accuracy_score > 0.7) {
        bins[binKey].accurate++
      }
    }

    // Calculate calibration error
    let totalError = 0
    let binCount = 0

    for (const [confidence, data] of Object.entries(bins)) {
      const expectedAccuracy = Number.parseFloat(confidence)
      const actualAccuracy = data.total > 0 ? data.accurate / data.total : 0
      totalError += Math.abs(expectedAccuracy - actualAccuracy)
      binCount++
    }

    const avgError = binCount > 0 ? totalError / binCount : 0.5
    return 1 - avgError
  }

  async function persistPrediction(prediction: Prediction): Promise<void> {
    await pool.query(
      `INSERT INTO predictions (
        prediction_id, identity_id, prediction_type, target_description,
        predicted_outcome, confidence, time_horizon, supporting_evidence,
        assumptions, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        prediction.prediction_id,
        prediction.identity_id,
        prediction.prediction_type,
        prediction.target_description,
        JSON.stringify(prediction.predicted_outcome),
        prediction.confidence,
        JSON.stringify(prediction.time_horizon),
        JSON.stringify(prediction.supporting_evidence),
        JSON.stringify(prediction.assumptions),
        prediction.created_at,
      ]
    )
  }

  return {
    predictStateChange,
    predictEventOccurrence,
    predictGoalOutcome,
    validatePrediction,
    getPredictionAccuracy,
  }
}
