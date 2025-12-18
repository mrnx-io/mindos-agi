// =============================================================================
// Risk Scoring Engine
// =============================================================================

import type pg from "pg"
import type { RiskAssessment, RiskCategory, RiskLevel, PolicyProfile } from "./types.js"

// -----------------------------------------------------------------------------
// Risk Scorer Interface
// -----------------------------------------------------------------------------

export interface RiskScorer {
  assessRisk(input: RiskAssessmentInput): Promise<RiskAssessment>
  getProfile(identityId: string): Promise<PolicyProfile | null>
  updateProfile(identityId: string, updates: Partial<PolicyProfile>): Promise<PolicyProfile>
  learnFromOutcome(assessmentId: string, outcome: ActionOutcome): Promise<void>
}

export interface RiskAssessmentInput {
  identity_id: string
  action_type: string
  action_details: Record<string, unknown>
  context?: Record<string, unknown>
}

export interface ActionOutcome {
  success: boolean
  error?: string
  actual_impact?: string
  user_feedback?: "positive" | "negative" | "neutral"
}

// -----------------------------------------------------------------------------
// Risk Factors
// -----------------------------------------------------------------------------

interface RiskFactor {
  name: string
  weight: number
  evaluate: (input: RiskAssessmentInput) => number
  description: (score: number) => string
}

const RISK_FACTORS: RiskFactor[] = [
  {
    name: "data_sensitivity",
    weight: 0.25,
    evaluate: (input) => {
      const details = JSON.stringify(input.action_details).toLowerCase()
      if (details.includes("password") || details.includes("secret") || details.includes("credential")) return 1.0
      if (details.includes("personal") || details.includes("pii") || details.includes("private")) return 0.8
      if (details.includes("internal") || details.includes("confidential")) return 0.6
      return 0.2
    },
    description: (score) => score > 0.7 ? "Involves sensitive data" : score > 0.4 ? "May involve private data" : "Low data sensitivity",
  },
  {
    name: "reversibility",
    weight: 0.2,
    evaluate: (input) => {
      const actionType = input.action_type.toLowerCase()
      if (actionType.includes("delete") || actionType.includes("drop") || actionType.includes("remove")) return 1.0
      if (actionType.includes("modify") || actionType.includes("update") || actionType.includes("change")) return 0.6
      if (actionType.includes("create") || actionType.includes("add") || actionType.includes("insert")) return 0.3
      if (actionType.includes("read") || actionType.includes("get") || actionType.includes("list")) return 0.1
      return 0.5
    },
    description: (score) => score > 0.7 ? "Irreversible action" : score > 0.4 ? "Partially reversible" : "Easily reversible",
  },
  {
    name: "scope",
    weight: 0.2,
    evaluate: (input) => {
      const details = JSON.stringify(input.action_details).toLowerCase()
      if (details.includes("all") || details.includes("*") || details.includes("global")) return 0.9
      if (details.includes("batch") || details.includes("bulk") || details.includes("multiple")) return 0.7
      return 0.3
    },
    description: (score) => score > 0.7 ? "Wide scope of impact" : score > 0.4 ? "Moderate scope" : "Limited scope",
  },
  {
    name: "external_interaction",
    weight: 0.15,
    evaluate: (input) => {
      const details = JSON.stringify(input.action_details).toLowerCase()
      if (details.includes("external") || details.includes("api") || details.includes("http")) return 0.8
      if (details.includes("email") || details.includes("notification") || details.includes("webhook")) return 0.9
      if (details.includes("payment") || details.includes("transaction")) return 1.0
      return 0.1
    },
    description: (score) => score > 0.7 ? "External system interaction" : score > 0.3 ? "Limited external interaction" : "Internal only",
  },
  {
    name: "authentication_context",
    weight: 0.1,
    evaluate: (input) => {
      const context = input.context ?? {}
      if (context.elevated_privileges) return 0.9
      if (context.service_account) return 0.6
      if (context.verified_user) return 0.3
      return 0.5
    },
    description: (score) => score > 0.7 ? "Elevated privileges" : score > 0.4 ? "Standard privileges" : "Limited privileges",
  },
  {
    name: "historical_risk",
    weight: 0.1,
    evaluate: (input) => {
      // This would typically query historical data
      // Placeholder returns moderate risk
      return 0.5
    },
    description: (score) => score > 0.7 ? "High historical risk" : score > 0.4 ? "Moderate historical risk" : "Low historical risk",
  },
]

// -----------------------------------------------------------------------------
// Create Risk Scorer
// -----------------------------------------------------------------------------

export function createRiskScorer(pool: pg.Pool): RiskScorer {
  function determineCategories(input: RiskAssessmentInput): RiskCategory[] {
    const categories: RiskCategory[] = []
    const details = JSON.stringify(input.action_details).toLowerCase()
    const actionType = input.action_type.toLowerCase()

    if (details.includes("data") || details.includes("record") || actionType.includes("read") || actionType.includes("query")) {
      categories.push("data_access")
    }
    if (details.includes("http") || details.includes("api") || details.includes("external")) {
      categories.push("external_communication")
    }
    if (actionType.includes("modify") || actionType.includes("delete") || actionType.includes("create")) {
      categories.push("system_modification")
    }
    if (details.includes("payment") || details.includes("transaction") || details.includes("money")) {
      categories.push("financial")
    }
    if (details.includes("user") || details.includes("identity") || details.includes("profile")) {
      categories.push("identity")
    }
    if (details.includes("auth") || details.includes("permission") || details.includes("access")) {
      categories.push("security")
    }

    return categories.length > 0 ? categories : ["data_access"]
  }

  function calculateRiskLevel(score: number): RiskLevel {
    if (score >= 0.8) return "critical"
    if (score >= 0.6) return "high"
    if (score >= 0.4) return "medium"
    return "low"
  }

  async function assessRisk(input: RiskAssessmentInput): Promise<RiskAssessment> {
    // Get policy profile for adjustments
    const profile = await getProfile(input.identity_id)

    // Evaluate all risk factors
    const factorResults = RISK_FACTORS.map((factor) => {
      const score = factor.evaluate(input)
      return {
        factor: factor.name,
        weight: factor.weight,
        score,
        description: factor.description(score),
      }
    })

    // Calculate weighted risk score
    let riskScore = factorResults.reduce((sum, f) => sum + f.score * f.weight, 0)

    // Apply profile adjustments
    if (profile) {
      const categories = determineCategories(input)
      for (const category of categories) {
        const override = profile.category_overrides?.[category]
        if (override !== undefined) {
          riskScore = riskScore * (1 + (override - 0.5))
        }
      }

      // Check blocked/allowed actions
      if (profile.blocked_actions.includes(input.action_type)) {
        riskScore = 1.0
      }
      if (profile.allowed_actions.includes(input.action_type)) {
        riskScore = Math.min(riskScore, profile.auto_approve_threshold)
      }
    }

    // Clamp to [0, 1]
    riskScore = Math.max(0, Math.min(1, riskScore))

    const assessment: RiskAssessment = {
      assessment_id: crypto.randomUUID(),
      action_type: input.action_type,
      action_details: input.action_details,
      risk_score: riskScore,
      risk_level: calculateRiskLevel(riskScore),
      categories: determineCategories(input),
      factors: factorResults,
      requires_approval: profile
        ? riskScore >= profile.require_approval_threshold
        : riskScore >= 0.7,
      timestamp: new Date().toISOString(),
    }

    // Store assessment
    await pool.query(
      `INSERT INTO risk_assessments (assessment_id, action_type, action_details, risk_score, risk_level, categories, factors, requires_approval, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        assessment.assessment_id,
        assessment.action_type,
        JSON.stringify(assessment.action_details),
        assessment.risk_score,
        assessment.risk_level,
        JSON.stringify(assessment.categories),
        JSON.stringify(assessment.factors),
        assessment.requires_approval,
        assessment.timestamp,
      ]
    )

    return assessment
  }

  async function getProfile(identityId: string): Promise<PolicyProfile | null> {
    const result = await pool.query(
      `SELECT * FROM policy_profiles WHERE identity_id = $1`,
      [identityId]
    )

    if (result.rows.length === 0) return null

    const row = result.rows[0]
    return {
      profile_id: row.profile_id,
      identity_id: row.identity_id,
      risk_tolerance: row.risk_tolerance,
      auto_approve_threshold: row.auto_approve_threshold,
      require_approval_threshold: row.require_approval_threshold,
      category_overrides: row.category_overrides,
      blocked_actions: row.blocked_actions ?? [],
      allowed_actions: row.allowed_actions ?? [],
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  async function updateProfile(
    identityId: string,
    updates: Partial<PolicyProfile>
  ): Promise<PolicyProfile> {
    const existing = await getProfile(identityId)
    const now = new Date().toISOString()

    if (!existing) {
      // Create new profile
      const newProfile: PolicyProfile = {
        profile_id: crypto.randomUUID(),
        identity_id: identityId,
        risk_tolerance: updates.risk_tolerance ?? 0.5,
        auto_approve_threshold: updates.auto_approve_threshold ?? 0.3,
        require_approval_threshold: updates.require_approval_threshold ?? 0.7,
        category_overrides: updates.category_overrides,
        blocked_actions: updates.blocked_actions ?? [],
        allowed_actions: updates.allowed_actions ?? [],
        created_at: now,
        updated_at: now,
      }

      await pool.query(
        `INSERT INTO policy_profiles (profile_id, identity_id, risk_tolerance, auto_approve_threshold, require_approval_threshold, category_overrides, blocked_actions, allowed_actions, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          newProfile.profile_id,
          newProfile.identity_id,
          newProfile.risk_tolerance,
          newProfile.auto_approve_threshold,
          newProfile.require_approval_threshold,
          JSON.stringify(newProfile.category_overrides),
          JSON.stringify(newProfile.blocked_actions),
          JSON.stringify(newProfile.allowed_actions),
          newProfile.created_at,
          newProfile.updated_at,
        ]
      )

      return newProfile
    }

    // Update existing
    const updated: PolicyProfile = {
      ...existing,
      ...updates,
      updated_at: now,
    }

    await pool.query(
      `UPDATE policy_profiles SET
        risk_tolerance = $1,
        auto_approve_threshold = $2,
        require_approval_threshold = $3,
        category_overrides = $4,
        blocked_actions = $5,
        allowed_actions = $6,
        updated_at = $7
       WHERE identity_id = $8`,
      [
        updated.risk_tolerance,
        updated.auto_approve_threshold,
        updated.require_approval_threshold,
        JSON.stringify(updated.category_overrides),
        JSON.stringify(updated.blocked_actions),
        JSON.stringify(updated.allowed_actions),
        updated.updated_at,
        identityId,
      ]
    )

    return updated
  }

  async function learnFromOutcome(assessmentId: string, outcome: ActionOutcome): Promise<void> {
    // Store outcome for learning
    await pool.query(
      `INSERT INTO risk_outcomes (assessment_id, success, error, actual_impact, user_feedback, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        assessmentId,
        outcome.success,
        outcome.error,
        outcome.actual_impact,
        outcome.user_feedback,
        new Date().toISOString(),
      ]
    )

    // Get assessment details
    const assessmentResult = await pool.query(
      `SELECT * FROM risk_assessments WHERE assessment_id = $1`,
      [assessmentId]
    )

    if (assessmentResult.rows.length === 0) return

    const assessment = assessmentResult.rows[0]

    // Adjust factor weights based on outcome
    // This is a simplified learning mechanism
    if (outcome.user_feedback === "negative" && assessment.risk_score < 0.5) {
      // We underestimated risk - log for analysis
      await pool.query(
        `INSERT INTO risk_learning_events (assessment_id, event_type, details, created_at)
         VALUES ($1, 'underestimate', $2, $3)`,
        [
          assessmentId,
          JSON.stringify({ predicted: assessment.risk_score, feedback: outcome.user_feedback }),
          new Date().toISOString(),
        ]
      )
    } else if (outcome.user_feedback === "positive" && assessment.risk_score > 0.7) {
      // We overestimated risk - log for analysis
      await pool.query(
        `INSERT INTO risk_learning_events (assessment_id, event_type, details, created_at)
         VALUES ($1, 'overestimate', $2, $3)`,
        [
          assessmentId,
          JSON.stringify({ predicted: assessment.risk_score, feedback: outcome.user_feedback }),
          new Date().toISOString(),
        ]
      )
    }
  }

  return {
    assessRisk,
    getProfile,
    updateProfile,
    learnFromOutcome,
  }
}
