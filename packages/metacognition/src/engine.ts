// =============================================================================
// Metacognitive Engine
// =============================================================================

import type pg from "pg"
import type {
  Belief,
  BeliefUpdate,
  ConfidenceInterval,
  Hypothesis,
  IntrospectionResult,
  IntrospectionTrigger,
  SelfObservation,
} from "./types.js"

// -----------------------------------------------------------------------------
// Engine Interface
// -----------------------------------------------------------------------------

export interface MetacognitiveEngine {
  // Self-observation
  observeSelf(identityId: string, context: ExecutionContext): Promise<SelfObservation>
  getRecentObservations(identityId: string, limit?: number): Promise<SelfObservation[]>

  // Confidence assessment
  assessConfidence(subject: string, evidence: Evidence[]): Promise<ConfidenceInterval>
  calibrateConfidence(identityId: string): Promise<CalibrationResult>

  // Hypothesis generation
  generateHypotheses(failure: FailureEvent): Promise<Hypothesis[]>
  testHypothesis(hypothesisId: string, testResult: TestResult): Promise<Hypothesis>
  getActiveHypotheses(identityId: string): Promise<Hypothesis[]>

  // Belief management
  updateBeliefs(evidence: Evidence[]): Promise<BeliefUpdate[]>
  detectBeliefConflicts(identityId: string): Promise<BeliefConflict[]>
  resolveConflict(conflictId: string, resolution: ConflictResolution): Promise<Belief[]>

  // Introspection
  triggerIntrospection(
    trigger: IntrospectionTrigger,
    identityId: string
  ): Promise<IntrospectionResult>
  scheduleIntrospection(identityId: string, intervalMs: number): void
}

export interface ExecutionContext {
  current_task?: string
  recent_actions: string[]
  environmental_factors: Record<string, unknown>
  performance_metrics?: Record<string, number>
}

export interface Evidence {
  evidence_id: string
  type: "observation" | "outcome" | "external" | "inference"
  content: Record<string, unknown>
  reliability: number
  timestamp: string
}

export interface FailureEvent {
  failure_id: string
  identity_id: string
  task_id?: string
  failure_type: string
  description: string
  context: Record<string, unknown>
  timestamp: string
}

export interface TestResult {
  hypothesis_id: string
  test_description: string
  outcome: "confirmed" | "rejected" | "inconclusive"
  evidence: Evidence[]
}

export interface CalibrationResult {
  identity_id: string
  overall_calibration: number
  overconfidence_bias: number
  underconfidence_bias: number
  recommendations: string[]
}

export interface BeliefConflict {
  conflict_id: string
  beliefs: Belief[]
  conflict_type: "direct_contradiction" | "implication_conflict" | "evidence_mismatch"
  severity: number
  detected_at: string
}

export interface ConflictResolution {
  resolution_type: "accept_newer" | "accept_stronger" | "merge" | "invalidate_all" | "custom"
  custom_resolution?: Record<string, unknown>
  reasoning: string
}

// -----------------------------------------------------------------------------
// Create Engine
// -----------------------------------------------------------------------------

export function createMetacognitiveEngine(pool: pg.Pool): MetacognitiveEngine {
  const introspectionSchedules = new Map<string, NodeJS.Timeout>()

  // -----------------------------------------------------------------------------
  // Self-Observation
  // -----------------------------------------------------------------------------

  async function observeSelf(
    identityId: string,
    context: ExecutionContext
  ): Promise<SelfObservation> {
    // Gather cognitive metrics
    const cognitiveState = await assessCognitiveState(identityId, context)

    const observation: SelfObservation = {
      observation_id: crypto.randomUUID(),
      identity_id: identityId,
      observation_type: "cognitive_state",
      content: cognitiveState,
      timestamp: new Date().toISOString(),
      context: {
        current_task: context.current_task,
        recent_actions: context.recent_actions,
        environmental_factors: context.environmental_factors,
      },
    }

    // Persist observation
    await pool.query(
      `INSERT INTO metacognitive_observations (
        observation_id, identity_id, observation_type, content, context, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        observation.observation_id,
        observation.identity_id,
        observation.observation_type,
        JSON.stringify(observation.content),
        JSON.stringify(observation.context),
        observation.timestamp,
      ]
    )

    return observation
  }

  async function getRecentObservations(identityId: string, limit = 50): Promise<SelfObservation[]> {
    const result = await pool.query(
      `SELECT * FROM metacognitive_observations
       WHERE identity_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [identityId, limit]
    )

    return result.rows.map((row) => ({
      observation_id: row.observation_id,
      identity_id: row.identity_id,
      observation_type: row.observation_type,
      content: row.content,
      timestamp: row.created_at,
      context: row.context,
    }))
  }

  async function assessCognitiveState(
    identityId: string,
    context: ExecutionContext
  ): Promise<Record<string, unknown>> {
    // Analyze recent performance
    const recentTasks = await pool.query(
      `SELECT status, created_at, completed_at
       FROM tasks WHERE identity_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [identityId]
    )

    const successRate =
      recentTasks.rows.length > 0
        ? recentTasks.rows.filter((t) => t.status === "completed").length / recentTasks.rows.length
        : 0.5

    // Calculate cognitive load
    const activeTasks = recentTasks.rows.filter((t) => t.status === "in_progress").length
    const cognitiveLoad = Math.min(activeTasks / 5, 1)

    // Analyze action patterns
    const actionDiversity =
      new Set(context.recent_actions).size / Math.max(context.recent_actions.length, 1)

    return {
      success_rate: successRate,
      cognitive_load: cognitiveLoad,
      action_diversity: actionDiversity,
      focus_score: context.current_task ? 0.8 : 0.4,
      adaptation_rate: await calculateAdaptationRate(identityId),
    }
  }

  async function calculateAdaptationRate(identityId: string): Promise<number> {
    // Measure how quickly the agent adapts to failures
    const failureRecoveries = await pool.query(
      `SELECT created_at, resolved_at FROM failures
       WHERE identity_id = $1 AND resolved_at IS NOT NULL
       ORDER BY created_at DESC LIMIT 10`,
      [identityId]
    )

    if (failureRecoveries.rows.length === 0) return 0.5

    const avgRecoveryTime =
      failureRecoveries.rows.reduce((sum, row) => {
        return sum + (new Date(row.resolved_at).getTime() - new Date(row.created_at).getTime())
      }, 0) / failureRecoveries.rows.length

    // Normalize: faster recovery = higher adaptation rate
    const maxRecoveryTime = 3600000 // 1 hour
    return Math.max(0, 1 - avgRecoveryTime / maxRecoveryTime)
  }

  // -----------------------------------------------------------------------------
  // Confidence Assessment
  // -----------------------------------------------------------------------------

  async function assessConfidence(
    subject: string,
    evidence: Evidence[]
  ): Promise<ConfidenceInterval> {
    // Calculate point estimate from evidence
    const reliabilities = evidence.map((e) => e.reliability)
    const avgReliability =
      reliabilities.length > 0
        ? reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length
        : 0.5

    // Calculate uncertainty based on evidence diversity
    const evidenceTypes = new Set(evidence.map((e) => e.type))
    const diversityFactor = evidenceTypes.size / 4 // 4 possible types

    // Wider interval with less evidence
    const sampleFactor = Math.min(evidence.length / 10, 1)
    const intervalWidth = 0.3 * (1 - sampleFactor) * (1 - diversityFactor)

    const pointEstimate = avgReliability
    const lowerBound = Math.max(0, pointEstimate - intervalWidth)
    const upperBound = Math.min(1, pointEstimate + intervalWidth)

    return {
      assessment_id: crypto.randomUUID(),
      subject,
      point_estimate: pointEstimate,
      lower_bound: lowerBound,
      upper_bound: upperBound,
      distribution_type: evidence.length > 10 ? "normal" : "beta",
      sample_size: evidence.length,
      calibration_factor: 1.0, // Would be adjusted based on historical accuracy
      reasoning: `Based on ${evidence.length} pieces of evidence with average reliability ${avgReliability.toFixed(2)}`,
      created_at: new Date().toISOString(),
    }
  }

  async function calibrateConfidence(identityId: string): Promise<CalibrationResult> {
    // Fetch historical predictions and outcomes
    const predictions = await pool.query(
      `SELECT confidence, accuracy_score
       FROM predictions
       WHERE identity_id = $1 AND validated_at IS NOT NULL`,
      [identityId]
    )

    if (predictions.rows.length < 10) {
      return {
        identity_id: identityId,
        overall_calibration: 0.5,
        overconfidence_bias: 0,
        underconfidence_bias: 0,
        recommendations: ["Need more validated predictions for calibration"],
      }
    }

    // Group by confidence bins
    const bins: Record<number, { count: number; accurate: number }> = {}

    for (const row of predictions.rows) {
      const bin = Math.floor(row.confidence * 10)
      if (!bins[bin]) bins[bin] = { count: 0, accurate: 0 }
      bins[bin].count++
      if (row.accuracy_score > 0.7) bins[bin].accurate++
    }

    // Calculate calibration error
    let totalError = 0
    let overconfidenceSum = 0
    let underconfidenceSum = 0

    for (const [binStr, data] of Object.entries(bins)) {
      const expectedAccuracy = Number.parseInt(binStr) / 10 + 0.05
      const actualAccuracy = data.count > 0 ? data.accurate / data.count : 0
      const error = actualAccuracy - expectedAccuracy

      totalError += Math.abs(error)

      if (error < 0) overconfidenceSum += Math.abs(error)
      else underconfidenceSum += error
    }

    const avgError = totalError / Object.keys(bins).length
    const overconfidenceBias = overconfidenceSum / Object.keys(bins).length
    const underconfidenceBias = underconfidenceSum / Object.keys(bins).length

    const recommendations: string[] = []
    if (overconfidenceBias > 0.1) {
      recommendations.push("Consider lowering confidence estimates by ~10-15%")
    }
    if (underconfidenceBias > 0.1) {
      recommendations.push("Consider raising confidence estimates by ~10-15%")
    }
    if (avgError < 0.1) {
      recommendations.push("Confidence calibration is good, maintain current approach")
    }

    return {
      identity_id: identityId,
      overall_calibration: 1 - avgError,
      overconfidence_bias: overconfidenceBias,
      underconfidence_bias: underconfidenceBias,
      recommendations,
    }
  }

  // -----------------------------------------------------------------------------
  // Hypothesis Generation
  // -----------------------------------------------------------------------------

  async function generateHypotheses(failure: FailureEvent): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = []

    // Root cause hypothesis
    hypotheses.push({
      hypothesis_id: crypto.randomUUID(),
      identity_id: failure.identity_id,
      triggered_by: failure.failure_id,
      hypothesis_type: "root_cause",
      statement: `Failure caused by: ${inferRootCause(failure)}`,
      supporting_evidence: [],
      contradicting_evidence: [],
      prior_probability: 0.6,
      testable_predictions: generateTestPredictions(failure, "root_cause"),
      status: "proposed",
      created_at: new Date().toISOString(),
    })

    // Missing capability hypothesis
    if (failure.failure_type === "capability_not_found") {
      hypotheses.push({
        hypothesis_id: crypto.randomUUID(),
        identity_id: failure.identity_id,
        triggered_by: failure.failure_id,
        hypothesis_type: "missing_capability",
        statement: `Need to acquire capability: ${failure.context.required_capability ?? "unknown"}`,
        supporting_evidence: [failure.failure_id],
        contradicting_evidence: [],
        prior_probability: 0.7,
        testable_predictions: ["Acquiring capability will prevent similar failures"],
        status: "proposed",
        created_at: new Date().toISOString(),
      })
    }

    // Alternative approach hypothesis
    hypotheses.push({
      hypothesis_id: crypto.randomUUID(),
      identity_id: failure.identity_id,
      triggered_by: failure.failure_id,
      hypothesis_type: "alternative_approach",
      statement: `Alternative approach may succeed: ${suggestAlternative(failure)}`,
      supporting_evidence: [],
      contradicting_evidence: [],
      prior_probability: 0.5,
      testable_predictions: ["Alternative approach achieves goal without failure"],
      status: "proposed",
      created_at: new Date().toISOString(),
    })

    // Persist hypotheses
    for (const h of hypotheses) {
      await pool.query(
        `INSERT INTO hypotheses (
          hypothesis_id, identity_id, triggered_by, hypothesis_type, statement,
          supporting_evidence, contradicting_evidence, prior_probability,
          testable_predictions, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          h.hypothesis_id,
          h.identity_id,
          h.triggered_by,
          h.hypothesis_type,
          h.statement,
          JSON.stringify(h.supporting_evidence),
          JSON.stringify(h.contradicting_evidence),
          h.prior_probability,
          JSON.stringify(h.testable_predictions),
          h.status,
          h.created_at,
        ]
      )
    }

    return hypotheses
  }

  async function testHypothesis(hypothesisId: string, testResult: TestResult): Promise<Hypothesis> {
    const result = await pool.query("SELECT * FROM hypotheses WHERE hypothesis_id = $1", [
      hypothesisId,
    ])

    if (result.rows.length === 0) {
      throw new Error(`Hypothesis ${hypothesisId} not found`)
    }

    const hypothesis = result.rows[0]

    // Update evidence
    const supportingEvidence = hypothesis.supporting_evidence ?? []
    const contradictingEvidence = hypothesis.contradicting_evidence ?? []

    for (const e of testResult.evidence) {
      if (testResult.outcome === "confirmed") {
        supportingEvidence.push(e.evidence_id)
      } else if (testResult.outcome === "rejected") {
        contradictingEvidence.push(e.evidence_id)
      }
    }

    // Update posterior probability using Bayesian update
    const priorProb = hypothesis.prior_probability
    const likelihoodConfirmed = 0.9
    const likelihoodRejected = 0.1
    const _likelihoodInconclusive = 0.5

    let posteriorProb: number
    switch (testResult.outcome) {
      case "confirmed":
        posteriorProb =
          (priorProb * likelihoodConfirmed) /
          (priorProb * likelihoodConfirmed + (1 - priorProb) * (1 - likelihoodConfirmed))
        break
      case "rejected":
        posteriorProb =
          (priorProb * likelihoodRejected) /
          (priorProb * likelihoodRejected + (1 - priorProb) * (1 - likelihoodRejected))
        break
      default:
        posteriorProb = priorProb
    }

    // Update status
    let newStatus: Hypothesis["status"]
    if (posteriorProb > 0.8) {
      newStatus = "confirmed"
    } else if (posteriorProb < 0.2) {
      newStatus = "rejected"
    } else if (testResult.outcome === "inconclusive") {
      newStatus = "inconclusive"
    } else {
      newStatus = "testing"
    }

    // Update database
    await pool.query(
      `UPDATE hypotheses SET
        supporting_evidence = $1,
        contradicting_evidence = $2,
        posterior_probability = $3,
        status = $4,
        resolved_at = $5
      WHERE hypothesis_id = $6`,
      [
        JSON.stringify(supportingEvidence),
        JSON.stringify(contradictingEvidence),
        posteriorProb,
        newStatus,
        newStatus === "confirmed" || newStatus === "rejected" ? new Date().toISOString() : null,
        hypothesisId,
      ]
    )

    return {
      ...hypothesis,
      supporting_evidence: supportingEvidence,
      contradicting_evidence: contradictingEvidence,
      posterior_probability: posteriorProb,
      status: newStatus,
    }
  }

  async function getActiveHypotheses(identityId: string): Promise<Hypothesis[]> {
    const result = await pool.query(
      `SELECT * FROM hypotheses
       WHERE identity_id = $1 AND status IN ('proposed', 'testing')
       ORDER BY created_at DESC`,
      [identityId]
    )

    return result.rows.map((row) => ({
      hypothesis_id: row.hypothesis_id,
      identity_id: row.identity_id,
      triggered_by: row.triggered_by,
      hypothesis_type: row.hypothesis_type,
      statement: row.statement,
      supporting_evidence: row.supporting_evidence ?? [],
      contradicting_evidence: row.contradicting_evidence ?? [],
      prior_probability: row.prior_probability,
      posterior_probability: row.posterior_probability,
      testable_predictions: row.testable_predictions ?? [],
      status: row.status,
      created_at: row.created_at,
      resolved_at: row.resolved_at,
    }))
  }

  // -----------------------------------------------------------------------------
  // Belief Management
  // -----------------------------------------------------------------------------

  async function updateBeliefs(evidence: Evidence[]): Promise<BeliefUpdate[]> {
    const updates: BeliefUpdate[] = []

    for (const e of evidence) {
      // Find related beliefs
      const relatedBeliefs = await pool.query(
        `SELECT * FROM beliefs
         WHERE $1 = ANY(evidence_ids) OR statement ILIKE $2`,
        [e.evidence_id, `%${extractKeywords(e)}%`]
      )

      for (const belief of relatedBeliefs.rows) {
        const previousConfidence = belief.confidence

        // Calculate new confidence based on evidence
        const evidenceImpact = e.reliability * 0.1 // 10% max change per evidence
        const newConfidence = Math.min(1, Math.max(0, previousConfidence + evidenceImpact))

        if (Math.abs(newConfidence - previousConfidence) > 0.01) {
          const update: BeliefUpdate = {
            update_id: crypto.randomUUID(),
            belief_id: belief.belief_id,
            update_type: "evidence_added",
            previous_confidence: previousConfidence,
            new_confidence: newConfidence,
            reason: `New evidence: ${e.evidence_id}`,
            evidence_id: e.evidence_id,
            created_at: new Date().toISOString(),
          }

          updates.push(update)

          // Persist update
          await pool.query(
            `UPDATE beliefs SET
              confidence = $1,
              evidence_ids = array_append(evidence_ids, $2),
              updated_at = $3
            WHERE belief_id = $4`,
            [newConfidence, e.evidence_id, update.created_at, belief.belief_id]
          )
        }
      }
    }

    return updates
  }

  async function detectBeliefConflicts(identityId: string): Promise<BeliefConflict[]> {
    const beliefs = await pool.query("SELECT * FROM beliefs WHERE identity_id = $1", [identityId])

    const conflicts: BeliefConflict[] = []

    // Simple pairwise conflict detection
    for (let i = 0; i < beliefs.rows.length; i++) {
      for (let j = i + 1; j < beliefs.rows.length; j++) {
        const beliefA = beliefs.rows[i]
        const beliefB = beliefs.rows[j]

        if (areContradictory(beliefA, beliefB)) {
          conflicts.push({
            conflict_id: crypto.randomUUID(),
            beliefs: [beliefA, beliefB],
            conflict_type: "direct_contradiction",
            severity: (beliefA.confidence + beliefB.confidence) / 2,
            detected_at: new Date().toISOString(),
          })
        }
      }
    }

    return conflicts
  }

  async function resolveConflict(
    conflictId: string,
    resolution: ConflictResolution
  ): Promise<Belief[]> {
    // Fetch the conflict
    const conflictResult = await db.query<{
      conflict_id: string
      belief_ids: string[]
      conflict_type: string
      severity: number
      detected_at: string
    }>("SELECT * FROM belief_conflicts WHERE conflict_id = $1 AND resolved_at IS NULL", [
      conflictId,
    ])

    if (conflictResult.rows.length === 0) {
      log.warn({ conflictId }, "Conflict not found or already resolved")
      return []
    }

    const conflict = conflictResult.rows[0]
    const beliefIds = conflict.belief_ids

    // Fetch the conflicting beliefs
    const beliefsResult = await db.query<{
      belief_id: string
      identity_id: string
      subject: string
      proposition: string
      confidence: number
      evidence_ids: string[]
      last_updated: string
      created_at: string
    }>("SELECT * FROM beliefs WHERE belief_id = ANY($1::uuid[])", [beliefIds])

    const beliefs = beliefsResult.rows
    if (beliefs.length < 2) {
      log.warn(
        { conflictId, beliefCount: beliefs.length },
        "Insufficient beliefs for conflict resolution"
      )
      return []
    }

    let resolvedBeliefs: typeof beliefs = []

    switch (resolution.resolution_type) {
      case "accept_newer": {
        // Keep the most recently updated belief
        const sorted = [...beliefs].sort(
          (a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime()
        )
        resolvedBeliefs = [sorted[0]]

        // Invalidate older beliefs
        for (let i = 1; i < sorted.length; i++) {
          await db.query(
            `UPDATE beliefs SET confidence = 0, invalidated_at = NOW(), invalidation_reason = $1
             WHERE belief_id = $2`,
            [`Superseded by newer belief: ${resolution.reasoning}`, sorted[i].belief_id]
          )
        }
        break
      }

      case "accept_stronger": {
        // Keep the belief with highest confidence
        const sorted = [...beliefs].sort((a, b) => b.confidence - a.confidence)
        resolvedBeliefs = [sorted[0]]

        // Reduce confidence of weaker beliefs
        for (let i = 1; i < sorted.length; i++) {
          const newConfidence = sorted[i].confidence * 0.3 // Significantly reduce
          await db.query(
            `UPDATE beliefs SET confidence = $1, last_updated = NOW()
             WHERE belief_id = $2`,
            [newConfidence, sorted[i].belief_id]
          )
        }
        break
      }

      case "merge": {
        // Create a merged belief with combined evidence
        const allEvidenceIds = beliefs.flatMap((b) => b.evidence_ids)
        const avgConfidence = beliefs.reduce((sum, b) => sum + b.confidence, 0) / beliefs.length

        // Create merged proposition
        const mergedProposition = `[Merged from ${beliefs.length} beliefs]: ${beliefs[0].proposition}`

        const insertResult = await db.query<{ belief_id: string }>(
          `INSERT INTO beliefs (belief_id, identity_id, subject, proposition, confidence, evidence_ids, created_at, last_updated)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
           RETURNING belief_id`,
          [
            crypto.randomUUID(),
            beliefs[0].identity_id,
            beliefs[0].subject,
            mergedProposition,
            avgConfidence,
            allEvidenceIds,
          ]
        )

        // Invalidate original beliefs
        for (const belief of beliefs) {
          await db.query(
            `UPDATE beliefs SET confidence = 0, invalidated_at = NOW(), invalidation_reason = $1
             WHERE belief_id = $2`,
            [`Merged into: ${insertResult.rows[0].belief_id}`, belief.belief_id]
          )
        }

        // Fetch the newly created belief
        const newBeliefResult = await db.query<(typeof beliefs)[0]>(
          "SELECT * FROM beliefs WHERE belief_id = $1",
          [insertResult.rows[0].belief_id]
        )
        resolvedBeliefs = newBeliefResult.rows
        break
      }

      case "invalidate_all": {
        // Mark all conflicting beliefs as invalid
        for (const belief of beliefs) {
          await db.query(
            `UPDATE beliefs SET confidence = 0, invalidated_at = NOW(), invalidation_reason = $1
             WHERE belief_id = $2`,
            [`Invalidated due to unresolvable conflict: ${resolution.reasoning}`, belief.belief_id]
          )
        }
        resolvedBeliefs = []
        break
      }

      case "custom": {
        // Apply custom resolution from the resolution.custom_resolution object
        if (resolution.custom_resolution?.accept_belief_ids) {
          const acceptIds = resolution.custom_resolution.accept_belief_ids as string[]
          resolvedBeliefs = beliefs.filter((b) => acceptIds.includes(b.belief_id))

          // Adjust confidence of non-accepted beliefs
          const rejectIds = beliefs
            .filter((b) => !acceptIds.includes(b.belief_id))
            .map((b) => b.belief_id)

          if (rejectIds.length > 0) {
            await db.query(
              `UPDATE beliefs SET confidence = confidence * 0.5, last_updated = NOW()
               WHERE belief_id = ANY($1::uuid[])`,
              [rejectIds]
            )
          }
        }
        break
      }
    }

    // Mark conflict as resolved
    await db.query(
      `UPDATE belief_conflicts SET resolved_at = NOW(), resolution_type = $1, resolution_reasoning = $2
       WHERE conflict_id = $3`,
      [resolution.resolution_type, resolution.reasoning, conflictId]
    )

    // Record the resolution in calibration history for learning
    await db.query(
      `INSERT INTO belief_conflict_resolutions (resolution_id, conflict_id, resolution_type, reasoning, resolved_belief_ids, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        crypto.randomUUID(),
        conflictId,
        resolution.resolution_type,
        resolution.reasoning,
        resolvedBeliefs.map((b) => b.belief_id),
      ]
    )

    log.info(
      {
        conflictId,
        resolutionType: resolution.resolution_type,
        resolvedCount: resolvedBeliefs.length,
      },
      "Belief conflict resolved"
    )

    return resolvedBeliefs as Belief[]
  }

  // -----------------------------------------------------------------------------
  // Introspection
  // -----------------------------------------------------------------------------

  async function triggerIntrospection(
    trigger: IntrospectionTrigger,
    identityId: string
  ): Promise<IntrospectionResult> {
    const startTime = performance.now()

    // Gather observations
    const observations = await gatherIntrospectionObservations(identityId, trigger)

    // Generate insights
    const insights = analyzeForInsights(observations)

    // Generate hypotheses if failure-triggered
    const hypothesesGenerated: string[] = []
    if (trigger.trigger_type === "failure_detected" && trigger.context.failure_id) {
      const failureEvent: FailureEvent = {
        failure_id: trigger.context.failure_id as string,
        identity_id: identityId,
        failure_type: (trigger.context.failure_type as string) ?? "unknown",
        description: (trigger.context.description as string) ?? "",
        context: trigger.context,
        timestamp: new Date().toISOString(),
      }

      const hypotheses = await generateHypotheses(failureEvent)
      hypothesesGenerated.push(...hypotheses.map((h) => h.hypothesis_id))
    }

    // Update beliefs based on observations
    const beliefUpdates = await processIntrospectionBeliefUpdates(observations, identityId)

    const duration = performance.now() - startTime

    const result: IntrospectionResult = {
      introspection_id: crypto.randomUUID(),
      identity_id: identityId,
      trigger,
      observations,
      insights,
      hypotheses_generated: hypothesesGenerated,
      belief_updates: beliefUpdates,
      duration_ms: duration,
      created_at: new Date().toISOString(),
    }

    // Persist result
    await pool.query(
      `INSERT INTO introspection_results (
        introspection_id, identity_id, trigger_type, observations_count,
        insights_count, hypotheses_count, duration_ms, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        result.introspection_id,
        result.identity_id,
        trigger.trigger_type,
        observations.length,
        insights.length,
        hypothesesGenerated.length,
        duration,
        result.created_at,
      ]
    )

    return result
  }

  function scheduleIntrospection(identityId: string, intervalMs: number): void {
    // Clear existing schedule
    const existingSchedule = introspectionSchedules.get(identityId)
    if (existingSchedule) {
      clearInterval(existingSchedule)
    }

    // Set new schedule
    const schedule = setInterval(async () => {
      await triggerIntrospection(
        {
          trigger_type: "scheduled",
          trigger_source: "automatic_schedule",
          urgency: "low",
          context: {},
        },
        identityId
      )
    }, intervalMs)

    introspectionSchedules.set(identityId, schedule)
  }

  // -----------------------------------------------------------------------------
  // Helper Functions
  // -----------------------------------------------------------------------------

  function inferRootCause(failure: FailureEvent): string {
    // Simple heuristic-based root cause inference
    if (failure.failure_type.includes("timeout")) {
      return "Resource constraint or external service delay"
    }
    if (failure.failure_type.includes("permission")) {
      return "Insufficient permissions for required action"
    }
    if (failure.failure_type.includes("not_found")) {
      return "Required resource or capability unavailable"
    }
    return "Unknown cause requiring investigation"
  }

  function suggestAlternative(failure: FailureEvent): string {
    // Simple alternative suggestion
    if (failure.failure_type.includes("timeout")) {
      return "Retry with longer timeout or break into smaller operations"
    }
    if (failure.failure_type.includes("permission")) {
      return "Request elevated permissions or use alternative approach"
    }
    return "Decompose task into simpler steps"
  }

  function generateTestPredictions(_failure: FailureEvent, hypothesisType: string): string[] {
    const predictions: string[] = []

    if (hypothesisType === "root_cause") {
      predictions.push("Addressing root cause prevents recurrence")
      predictions.push("Similar tasks without this factor succeed")
    }

    return predictions
  }

  function extractKeywords(evidence: Evidence): string {
    // Extract keywords from evidence content
    const content = JSON.stringify(evidence.content)
    return content.slice(0, 50)
  }

  function areContradictory(beliefA: Belief, beliefB: Belief): boolean {
    // Simple contradiction detection
    const statementA = beliefA.statement.toLowerCase()
    const statementB = beliefB.statement.toLowerCase()

    // Check for negation patterns
    const negationPatterns = [
      [" is ", " is not "],
      [" can ", " cannot "],
      [" will ", " will not "],
      [" should ", " should not "],
    ]

    for (const [positive, negative] of negationPatterns) {
      if (
        (statementA.includes(positive) && statementB.includes(negative)) ||
        (statementA.includes(negative) && statementB.includes(positive))
      ) {
        // Check if same subject
        const subjectA = statementA.split(positive)[0] || statementA.split(negative)[0]
        const subjectB = statementB.split(positive)[0] || statementB.split(negative)[0]

        if (subjectA === subjectB) return true
      }
    }

    return false
  }

  async function gatherIntrospectionObservations(
    identityId: string,
    trigger: IntrospectionTrigger
  ): Promise<SelfObservation[]> {
    const observations: SelfObservation[] = []

    // Get recent observations from database
    const recentObs = await getRecentObservations(identityId, 20)
    observations.push(...recentObs)

    // Generate new observation based on trigger
    const newObs = await observeSelf(identityId, {
      recent_actions: [],
      environmental_factors: trigger.context,
    })
    observations.push(newObs)

    return observations
  }

  function analyzeForInsights(observations: SelfObservation[]): IntrospectionResult["insights"] {
    const insights: IntrospectionResult["insights"] = []

    // Analyze performance trends
    const performanceObs = observations.filter((o) => o.observation_type === "performance_metric")
    if (performanceObs.length > 0) {
      const avgPerformance =
        performanceObs.reduce((sum, o) => {
          const perf = (o.content as Record<string, number>).performance ?? 0.5
          return sum + perf
        }, 0) / performanceObs.length

      if (avgPerformance < 0.5) {
        insights.push({
          insight_id: crypto.randomUUID(),
          category: "weakness",
          description: "Performance has been below average recently",
          confidence: 0.7,
          actionable: true,
          suggested_actions: ["Review recent failures", "Identify capability gaps"],
        })
      } else if (avgPerformance > 0.8) {
        insights.push({
          insight_id: crypto.randomUUID(),
          category: "strength",
          description: "Performance has been consistently strong",
          confidence: 0.8,
          actionable: false,
          suggested_actions: [],
        })
      }
    }

    // Look for patterns
    const actionPatterns = observations
      .flatMap((o) => o.context.recent_actions)
      .reduce(
        (acc, action) => {
          acc[action] = (acc[action] ?? 0) + 1
          return acc
        },
        {} as Record<string, number>
      )

    const frequentActions = Object.entries(actionPatterns)
      .filter(([, count]) => count > 3)
      .map(([action]) => action)

    if (frequentActions.length > 0) {
      insights.push({
        insight_id: crypto.randomUUID(),
        category: "pattern",
        description: `Frequently performed actions: ${frequentActions.join(", ")}`,
        confidence: 0.9,
        actionable: true,
        suggested_actions: ["Consider automating frequent patterns"],
      })
    }

    return insights
  }

  async function processIntrospectionBeliefUpdates(
    observations: SelfObservation[],
    _identityId: string
  ): Promise<IntrospectionResult["belief_updates"]> {
    // Convert observations to evidence and update beliefs
    const evidence: Evidence[] = observations.map((o) => ({
      evidence_id: o.observation_id,
      type: "observation" as const,
      content: o.content,
      reliability: 0.8,
      timestamp: o.timestamp,
    }))

    const updates = await updateBeliefs(evidence)

    return updates.map((u) => ({
      belief_id: u.belief_id,
      previous_value: u.previous_confidence,
      new_value: u.new_confidence,
      reason: u.reason,
    }))
  }

  return {
    observeSelf,
    getRecentObservations,
    assessConfidence,
    calibrateConfidence,
    generateHypotheses,
    testHypothesis,
    getActiveHypotheses,
    updateBeliefs,
    detectBeliefConflicts,
    resolveConflict,
    triggerIntrospection,
    scheduleIntrospection,
  }
}
