// =============================================================================
// Hypothesis Action Engine - Self-Improvement via Hypothesis Confirmation
// =============================================================================
// Triggers skill creation/update, belief updates, and learning records when
// hypotheses are confirmed or rejected.

import type pg from "pg"
import type { Hypothesis } from "./types.js"

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface HypothesisAction {
  action_id: string
  hypothesis_id: string
  identity_id: string
  hypothesis_status: "confirmed" | "rejected"
  hypothesis_type: string
  hypothesis_statement: string
  action_type: HypothesisActionType
  action_details: Record<string, unknown>
  skill_id?: string
  created_at: string
  effectiveness_measured_at?: string
  effectiveness_score?: number
}

export type HypothesisActionType =
  | "skill_created"
  | "skill_updated"
  | "belief_updated"
  | "threshold_adjusted"
  | "learning_recorded"
  | "no_action"

export interface SkillCandidate {
  name: string
  description: string
  pattern: string
  applicability: string[]
  confidence: number
}

export interface NotificationPayload {
  type: "skill_created" | "learning_recorded" | "threshold_adjusted"
  identity_id: string
  details: Record<string, unknown>
  timestamp: string
}

// -----------------------------------------------------------------------------
// Configuration (from environment)
// -----------------------------------------------------------------------------

interface HypothesisActionsConfig {
  enableSkillCreation: boolean
  enableThresholdAdjustment: boolean
  notificationWebhookUrl?: string
  slackWebhookUrl?: string
  notifyOnSkillCreation: boolean
}

// -----------------------------------------------------------------------------
// Hypothesis Action Engine
// -----------------------------------------------------------------------------

export interface HypothesisActionEngine {
  onHypothesisConfirmed(hypothesis: Hypothesis): Promise<HypothesisAction>
  onHypothesisRejected(hypothesis: Hypothesis): Promise<HypothesisAction>
  getActionsForHypothesis(hypothesisId: string): Promise<HypothesisAction[]>
  measureActionEffectiveness(actionId: string): Promise<number | null>
}

export function createHypothesisActionEngine(
  pool: pg.Pool,
  config: HypothesisActionsConfig
): HypothesisActionEngine {
  // ---------------------------------------------------------------------------
  // Hypothesis Confirmed → Create/Update Skill or Record Learning
  // ---------------------------------------------------------------------------

  async function onHypothesisConfirmed(hypothesis: Hypothesis): Promise<HypothesisAction> {
    const actionId = crypto.randomUUID()

    // Determine action based on hypothesis type
    let actionType: HypothesisActionType
    let actionDetails: Record<string, unknown> = {}
    let skillId: string | undefined

    switch (hypothesis.hypothesis_type) {
      case "root_cause": {
        // Root cause confirmed → Create prevention skill
        if (config.enableSkillCreation) {
          const skill = await createPreventionSkill(hypothesis)
          actionType = "skill_created"
          skillId = skill.skill_id
          actionDetails = {
            skill_name: skill.name,
            prevention_strategy: skill.pattern,
            applicability: skill.applicability,
          }

          // Send notification if enabled
          if (config.notifyOnSkillCreation) {
            await sendNotification({
              type: "skill_created",
              identity_id: hypothesis.identity_id,
              details: {
                skill_name: skill.name,
                trigger: "hypothesis_confirmed",
                hypothesis_statement: hypothesis.statement,
              },
              timestamp: new Date().toISOString(),
            })
          }
        } else {
          actionType = "learning_recorded"
          actionDetails = {
            lesson: `Root cause identified: ${hypothesis.statement}`,
            prevention_needed: true,
          }
        }
        break
      }

      case "missing_capability": {
        // Missing capability confirmed → Create acquisition skill
        if (config.enableSkillCreation) {
          const skill = await createAcquisitionSkill(hypothesis)
          actionType = "skill_created"
          skillId = skill.skill_id
          actionDetails = {
            skill_name: skill.name,
            capability_needed: extractCapability(hypothesis.statement),
            acquisition_strategy: skill.pattern,
          }

          if (config.notifyOnSkillCreation) {
            await sendNotification({
              type: "skill_created",
              identity_id: hypothesis.identity_id,
              details: {
                skill_name: skill.name,
                trigger: "capability_gap",
                capability: extractCapability(hypothesis.statement),
              },
              timestamp: new Date().toISOString(),
            })
          }
        } else {
          actionType = "learning_recorded"
          actionDetails = {
            lesson: `Capability gap identified: ${extractCapability(hypothesis.statement)}`,
            acquisition_needed: true,
          }
        }
        break
      }

      case "alternative_approach": {
        // Alternative approach confirmed → Update existing skill or create new
        const existingSkill = await findRelatedSkill(hypothesis)
        if (existingSkill && config.enableSkillCreation) {
          await updateSkillWithAlternative(existingSkill.skill_id, hypothesis)
          actionType = "skill_updated"
          skillId = existingSkill.skill_id
          actionDetails = {
            skill_name: existingSkill.name,
            alternative_added: hypothesis.statement,
          }
        } else if (config.enableSkillCreation) {
          const skill = await createAlternativeSkill(hypothesis)
          actionType = "skill_created"
          skillId = skill.skill_id
          actionDetails = {
            skill_name: skill.name,
            alternative_approach: hypothesis.statement,
          }
        } else {
          actionType = "learning_recorded"
          actionDetails = {
            lesson: `Alternative approach validated: ${hypothesis.statement}`,
          }
        }
        break
      }

      case "environmental_factor": {
        // Environmental factor confirmed → Adjust thresholds or record
        if (config.enableThresholdAdjustment) {
          const adjustment = await adjustEnvironmentalThresholds(hypothesis)
          actionType = "threshold_adjusted"
          actionDetails = {
            factor: extractEnvironmentalFactor(hypothesis.statement),
            adjustments: adjustment,
          }

          await sendNotification({
            type: "threshold_adjusted",
            identity_id: hypothesis.identity_id,
            details: {
              trigger: "environmental_factor",
              adjustments: adjustment,
            },
            timestamp: new Date().toISOString(),
          })
        } else {
          actionType = "learning_recorded"
          actionDetails = {
            lesson: `Environmental factor identified: ${hypothesis.statement}`,
          }
        }
        break
      }

      default: {
        // Unknown hypothesis type → Record learning
        actionType = "learning_recorded"
        actionDetails = {
          lesson: `Hypothesis confirmed: ${hypothesis.statement}`,
          hypothesis_type: hypothesis.hypothesis_type,
        }
      }
    }

    // Persist action
    const action: HypothesisAction = {
      action_id: actionId,
      hypothesis_id: hypothesis.hypothesis_id,
      identity_id: hypothesis.identity_id,
      hypothesis_status: "confirmed",
      hypothesis_type: hypothesis.hypothesis_type,
      hypothesis_statement: hypothesis.statement,
      action_type: actionType,
      action_details: actionDetails,
      skill_id: skillId,
      created_at: new Date().toISOString(),
    }

    await persistAction(action)
    await recordLearning(hypothesis, actionType, actionDetails)

    return action
  }

  // ---------------------------------------------------------------------------
  // Hypothesis Rejected → Update Beliefs and Record Learning
  // ---------------------------------------------------------------------------

  async function onHypothesisRejected(hypothesis: Hypothesis): Promise<HypothesisAction> {
    const actionId = crypto.randomUUID()

    // Rejected hypotheses contribute to learning about what doesn't work
    const actionDetails: Record<string, unknown> = {
      rejected_hypothesis: hypothesis.statement,
      evidence_against: hypothesis.contradicting_evidence,
      lesson: `Hypothesis disproven: ${hypothesis.statement}`,
      avoid_in_future: true,
    }

    // Update beliefs to reduce confidence in related beliefs
    await updateRelatedBeliefs(hypothesis, "decrease")

    const action: HypothesisAction = {
      action_id: actionId,
      hypothesis_id: hypothesis.hypothesis_id,
      identity_id: hypothesis.identity_id,
      hypothesis_status: "rejected",
      hypothesis_type: hypothesis.hypothesis_type,
      hypothesis_statement: hypothesis.statement,
      action_type: "belief_updated",
      action_details: actionDetails,
      created_at: new Date().toISOString(),
    }

    await persistAction(action)
    await recordLearning(hypothesis, "belief_updated", actionDetails)

    return action
  }

  // ---------------------------------------------------------------------------
  // Query Actions
  // ---------------------------------------------------------------------------

  async function getActionsForHypothesis(hypothesisId: string): Promise<HypothesisAction[]> {
    const result = await pool.query(
      "SELECT * FROM hypothesis_actions WHERE hypothesis_id = $1 ORDER BY created_at DESC",
      [hypothesisId]
    )

    return result.rows.map(mapRowToAction)
  }

  async function measureActionEffectiveness(actionId: string): Promise<number | null> {
    const result = await pool.query("SELECT * FROM hypothesis_actions WHERE action_id = $1", [
      actionId,
    ])

    if (result.rows.length === 0) return null

    const action = mapRowToAction(result.rows[0])

    // Measure effectiveness based on action type
    let effectivenessScore: number | null = null

    switch (action.action_type) {
      case "skill_created":
      case "skill_updated": {
        if (action.skill_id) {
          effectivenessScore = await measureSkillEffectiveness(action.skill_id)
        }
        break
      }
      case "threshold_adjusted": {
        effectivenessScore = await measureThresholdAdjustmentEffectiveness(action)
        break
      }
      case "learning_recorded":
      case "belief_updated": {
        // Check if similar failures have occurred since
        effectivenessScore = await measureLearningEffectiveness(action)
        break
      }
    }

    if (effectivenessScore !== null) {
      await pool.query(
        `UPDATE hypothesis_actions
         SET effectiveness_measured_at = NOW(), effectiveness_score = $2
         WHERE action_id = $1`,
        [actionId, effectivenessScore]
      )
    }

    return effectivenessScore
  }

  // ---------------------------------------------------------------------------
  // Skill Creation Helpers
  // ---------------------------------------------------------------------------

  async function createPreventionSkill(
    hypothesis: Hypothesis
  ): Promise<{ skill_id: string; name: string; pattern: string; applicability: string[] }> {
    const skillId = crypto.randomUUID()
    const rootCause = extractRootCause(hypothesis.statement)

    const skill = {
      skill_id: skillId,
      name: `prevent_${sanitizeForName(rootCause)}`,
      description: `Prevention skill for: ${hypothesis.statement}`,
      pattern: JSON.stringify({
        type: "prevention",
        trigger: rootCause,
        action: "Check and mitigate before proceeding",
        evidence: hypothesis.supporting_evidence,
      }),
      applicability: extractApplicabilityContexts(hypothesis),
      confidence: hypothesis.posterior_probability ?? hypothesis.prior_probability,
    }

    await pool.query(
      `INSERT INTO skills (skill_id, identity_id, name, description, pattern, applicability, confidence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        skill.skill_id,
        hypothesis.identity_id,
        skill.name,
        skill.description,
        skill.pattern,
        JSON.stringify(skill.applicability),
        skill.confidence,
      ]
    )

    return skill
  }

  async function createAcquisitionSkill(
    hypothesis: Hypothesis
  ): Promise<{ skill_id: string; name: string; pattern: string; applicability: string[] }> {
    const skillId = crypto.randomUUID()
    const capability = extractCapability(hypothesis.statement)

    const skill = {
      skill_id: skillId,
      name: `acquire_${sanitizeForName(capability)}`,
      description: `Capability acquisition skill for: ${capability}`,
      pattern: JSON.stringify({
        type: "acquisition",
        capability_needed: capability,
        acquisition_steps: ["Identify capability provider", "Request or install", "Verify access"],
        evidence: hypothesis.supporting_evidence,
      }),
      applicability: extractApplicabilityContexts(hypothesis),
      confidence: hypothesis.posterior_probability ?? hypothesis.prior_probability,
    }

    await pool.query(
      `INSERT INTO skills (skill_id, identity_id, name, description, pattern, applicability, confidence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        skill.skill_id,
        hypothesis.identity_id,
        skill.name,
        skill.description,
        skill.pattern,
        JSON.stringify(skill.applicability),
        skill.confidence,
      ]
    )

    return skill
  }

  async function createAlternativeSkill(
    hypothesis: Hypothesis
  ): Promise<{ skill_id: string; name: string; pattern: string; applicability: string[] }> {
    const skillId = crypto.randomUUID()

    const skill = {
      skill_id: skillId,
      name: `alternative_${sanitizeForName(hypothesis.statement.slice(0, 30))}`,
      description: `Alternative approach: ${hypothesis.statement}`,
      pattern: JSON.stringify({
        type: "alternative",
        approach: hypothesis.statement,
        evidence: hypothesis.supporting_evidence,
      }),
      applicability: extractApplicabilityContexts(hypothesis),
      confidence: hypothesis.posterior_probability ?? hypothesis.prior_probability,
    }

    await pool.query(
      `INSERT INTO skills (skill_id, identity_id, name, description, pattern, applicability, confidence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        skill.skill_id,
        hypothesis.identity_id,
        skill.name,
        skill.description,
        skill.pattern,
        JSON.stringify(skill.applicability),
        skill.confidence,
      ]
    )

    return skill
  }

  async function findRelatedSkill(
    hypothesis: Hypothesis
  ): Promise<{ skill_id: string; name: string } | null> {
    // Find skills that might be related to this hypothesis
    const result = await pool.query(
      `SELECT skill_id, name FROM skills
       WHERE identity_id = $1
       AND (description ILIKE $2 OR pattern::text ILIKE $2)
       LIMIT 1`,
      [hypothesis.identity_id, `%${hypothesis.statement.slice(0, 50)}%`]
    )

    return result.rows[0] ?? null
  }

  async function updateSkillWithAlternative(
    skillId: string,
    hypothesis: Hypothesis
  ): Promise<void> {
    const result = await pool.query("SELECT pattern FROM skills WHERE skill_id = $1", [skillId])

    if (result.rows.length === 0) return

    const currentPattern = JSON.parse(result.rows[0].pattern)
    const updatedPattern = {
      ...currentPattern,
      alternatives: [...(currentPattern.alternatives ?? []), hypothesis.statement],
      last_updated_evidence: hypothesis.supporting_evidence,
    }

    await pool.query("UPDATE skills SET pattern = $2, updated_at = NOW() WHERE skill_id = $1", [
      skillId,
      JSON.stringify(updatedPattern),
    ])
  }

  // ---------------------------------------------------------------------------
  // Threshold Adjustment
  // ---------------------------------------------------------------------------

  async function adjustEnvironmentalThresholds(
    hypothesis: Hypothesis
  ): Promise<Record<string, unknown>> {
    const factor = extractEnvironmentalFactor(hypothesis.statement)

    // Record the adjustment in calibration_history
    const adjustment = {
      factor,
      adjustment_type: "environmental_sensitivity",
      adjustment_value: 0.05, // Conservative 5% adjustment
      hypothesis_evidence: hypothesis.supporting_evidence,
    }

    await pool.query(
      `INSERT INTO calibration_history (
        calibration_id, identity_id, calibration_type, target_component,
        previous_value, new_value, adjustment_magnitude, trigger_reason, calibration_metrics
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        crypto.randomUUID(),
        hypothesis.identity_id,
        "threshold_adjustment",
        factor,
        JSON.stringify({ sensitivity: 1.0 }),
        JSON.stringify({ sensitivity: 1.05 }),
        0.05,
        `Environmental factor confirmed: ${hypothesis.statement}`,
        JSON.stringify(adjustment),
      ]
    )

    return adjustment
  }

  // ---------------------------------------------------------------------------
  // Belief Updates
  // ---------------------------------------------------------------------------

  async function updateRelatedBeliefs(
    hypothesis: Hypothesis,
    direction: "increase" | "decrease"
  ): Promise<void> {
    // Find beliefs related to the hypothesis
    const result = await pool.query(
      `SELECT belief_id, confidence FROM beliefs
       WHERE identity_id = $1 AND statement ILIKE $2`,
      [hypothesis.identity_id, `%${hypothesis.statement.slice(0, 30)}%`]
    )

    const adjustmentFactor = direction === "increase" ? 0.1 : -0.1

    for (const row of result.rows) {
      const newConfidence = Math.max(0, Math.min(1, row.confidence + adjustmentFactor))

      await pool.query(
        "UPDATE beliefs SET confidence = $2, updated_at = NOW() WHERE belief_id = $1",
        [row.belief_id, newConfidence]
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Learning Records
  // ---------------------------------------------------------------------------

  async function recordLearning(
    hypothesis: Hypothesis,
    actionType: HypothesisActionType,
    details: Record<string, unknown>
  ): Promise<void> {
    await pool.query(
      `INSERT INTO learning_records (
        record_id, identity_id, learning_type, source_event, lesson_learned,
        generalization_level, application_contexts, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        crypto.randomUUID(),
        hypothesis.identity_id,
        mapActionTypeToLearningType(actionType),
        hypothesis.triggered_by,
        details.lesson ??
          `Action taken: ${actionType} based on hypothesis: ${hypothesis.statement}`,
        "domain",
        JSON.stringify(extractApplicabilityContexts(hypothesis)),
      ]
    )
  }

  // ---------------------------------------------------------------------------
  // Effectiveness Measurement
  // ---------------------------------------------------------------------------

  async function measureSkillEffectiveness(skillId: string): Promise<number> {
    const result = await pool.query(
      `SELECT
        COUNT(*) AS total_uses,
        COUNT(*) FILTER (WHERE success = true) AS successful_uses,
        AVG(outcome_quality) AS avg_quality
       FROM skill_usage_records
       WHERE skill_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
      [skillId]
    )

    if (result.rows[0].total_uses === 0) return 0.5 // No data yet

    const successRate = result.rows[0].successful_uses / result.rows[0].total_uses
    const avgQuality = result.rows[0].avg_quality ?? 0.5

    return successRate * 0.6 + avgQuality * 0.4
  }

  async function measureThresholdAdjustmentEffectiveness(
    action: HypothesisAction
  ): Promise<number> {
    // Check if fewer similar failures have occurred since adjustment
    const result = await pool.query(
      `SELECT COUNT(*) AS failure_count
       FROM failures
       WHERE identity_id = $1
       AND created_at > $2
       AND description ILIKE $3`,
      [action.identity_id, action.created_at, `%${action.action_details.factor ?? "unknown"}%`]
    )

    // Fewer failures = higher effectiveness
    const failureCount = Number.parseInt(result.rows[0].failure_count, 10)
    return Math.max(0, 1 - failureCount * 0.2)
  }

  async function measureLearningEffectiveness(action: HypothesisAction): Promise<number> {
    // Check if the learning has been applied in subsequent tasks
    const result = await pool.query(
      `SELECT COUNT(*) AS task_count
       FROM tasks
       WHERE identity_id = $1
       AND created_at > $2
       AND status = 'completed'`,
      [action.identity_id, action.created_at]
    )

    const taskCount = Number.parseInt(result.rows[0].task_count, 10)
    // More successful tasks = learning applied effectively
    return Math.min(1, taskCount * 0.1 + 0.5)
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  async function sendNotification(payload: NotificationPayload): Promise<void> {
    if (config.slackWebhookUrl) {
      try {
        await fetch(config.slackWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `MindOS Self-Improvement: ${payload.type}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*${payload.type}* for identity \`${payload.identity_id}\`\n${JSON.stringify(payload.details, null, 2)}`,
                },
              },
            ],
          }),
        })
      } catch {
        // Silently fail notifications
      }
    }

    if (config.notificationWebhookUrl) {
      try {
        await fetch(config.notificationWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      } catch {
        // Silently fail notifications
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  async function persistAction(action: HypothesisAction): Promise<void> {
    await pool.query(
      `INSERT INTO hypothesis_actions (
        action_id, hypothesis_id, identity_id, hypothesis_status, hypothesis_type,
        hypothesis_statement, action_type, action_details, skill_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        action.action_id,
        action.hypothesis_id,
        action.identity_id,
        action.hypothesis_status,
        action.hypothesis_type,
        action.hypothesis_statement,
        action.action_type,
        JSON.stringify(action.action_details),
        action.skill_id,
        action.created_at,
      ]
    )
  }

  function mapRowToAction(row: Record<string, unknown>): HypothesisAction {
    return {
      action_id: row.action_id as string,
      hypothesis_id: row.hypothesis_id as string,
      identity_id: row.identity_id as string,
      hypothesis_status: row.hypothesis_status as "confirmed" | "rejected",
      hypothesis_type: row.hypothesis_type as string,
      hypothesis_statement: row.hypothesis_statement as string,
      action_type: row.action_type as HypothesisActionType,
      action_details: row.action_details as Record<string, unknown>,
      skill_id: row.skill_id as string | undefined,
      created_at: row.created_at as string,
      effectiveness_measured_at: row.effectiveness_measured_at as string | undefined,
      effectiveness_score: row.effectiveness_score as number | undefined,
    }
  }

  // ---------------------------------------------------------------------------
  // Utility Functions
  // ---------------------------------------------------------------------------

  function extractRootCause(statement: string): string {
    const match = statement.match(/caused by:?\s*(.+)/i)
    return match?.[1] ?? statement.slice(0, 50)
  }

  function extractCapability(statement: string): string {
    const match = statement.match(/capability:?\s*(.+)/i) ?? statement.match(/acquire:?\s*(.+)/i)
    return match?.[1] ?? statement.slice(0, 50)
  }

  function extractEnvironmentalFactor(statement: string): string {
    const match = statement.match(/factor:?\s*(.+)/i) ?? statement.match(/environment:?\s*(.+)/i)
    return match?.[1] ?? statement.slice(0, 50)
  }

  function extractApplicabilityContexts(hypothesis: Hypothesis): string[] {
    // Extract contexts from hypothesis content
    const contexts: string[] = []

    if (hypothesis.hypothesis_type === "root_cause") {
      contexts.push("failure_prevention", "risk_mitigation")
    }
    if (hypothesis.hypothesis_type === "missing_capability") {
      contexts.push("capability_acquisition", "tool_discovery")
    }
    if (hypothesis.hypothesis_type === "alternative_approach") {
      contexts.push("task_execution", "problem_solving")
    }
    if (hypothesis.hypothesis_type === "environmental_factor") {
      contexts.push("environmental_adaptation", "context_awareness")
    }

    return contexts
  }

  function sanitizeForName(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .slice(0, 30)
  }

  function mapActionTypeToLearningType(actionType: HypothesisActionType): string {
    const mapping: Record<HypothesisActionType, string> = {
      skill_created: "skill_acquisition",
      skill_updated: "strategy_refinement",
      belief_updated: "knowledge_integration",
      threshold_adjusted: "behavior_modification",
      learning_recorded: "knowledge_integration",
      no_action: "knowledge_integration",
    }
    return mapping[actionType]
  }

  return {
    onHypothesisConfirmed,
    onHypothesisRejected,
    getActionsForHypothesis,
    measureActionEffectiveness,
  }
}
