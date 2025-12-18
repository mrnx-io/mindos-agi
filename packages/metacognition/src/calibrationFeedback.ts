// =============================================================================
// Calibration Feedback Service - Confidence Calibration & Threshold Adjustment
// =============================================================================
// Analyzes prediction accuracy and automatically adjusts confidence thresholds
// within safety bounds.

import type pg from "pg"
import type { CalibrationResult } from "./engine.js"

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CalibrationAdjustment {
  calibration_id: string
  identity_id: string
  calibration_type: CalibrationTypes
  target_component: string
  previous_value: Record<string, unknown>
  new_value: Record<string, unknown>
  adjustment_magnitude: number
  cumulative_drift: number
  drift_since_reset: number
  auto_applied: boolean
  requires_notification: boolean
  trigger_reason: string
  calibration_metrics: Record<string, unknown>
  created_at: string
}

export type CalibrationTypes =
  | "threshold_adjustment"
  | "confidence_factor"
  | "bias_correction"
  | "sample_size_update"

export interface CalibrationConfig {
  maxSingleAdjustment: number // Max 5% per adjustment
  maxCumulativeDrift: number // Max 20% total drift
  cooldownMs: number // 24h between adjustments
  notifyOnSignificant: boolean
  significantThreshold: number // 10% = significant
  slackWebhookUrl?: string
  webhookUrl?: string
}

export interface DriftStatus {
  identity_id: string
  current_drift: number
  drift_status: "normal" | "warning" | "critical"
  last_adjustment_at?: string
  cooldown_remaining_ms: number
  can_adjust: boolean
}

// -----------------------------------------------------------------------------
// Calibration Feedback Service
// -----------------------------------------------------------------------------

export interface CalibrationFeedbackService {
  analyzeCalibration(identityId: string): Promise<CalibrationResult>
  generateThresholdAdjustments(
    identityId: string,
    calibrationResult: CalibrationResult
  ): Promise<CalibrationAdjustment[]>
  applyAdjustment(adjustment: CalibrationAdjustment): Promise<boolean>
  getDriftStatus(identityId: string): Promise<DriftStatus>
  resetDrift(identityId: string, reason: string): Promise<void>
  runCalibrationCycle(identityId: string): Promise<{
    analyzed: boolean
    adjustments_proposed: number
    adjustments_applied: number
    notifications_sent: number
  }>
}

export function createCalibrationFeedbackService(
  pool: pg.Pool,
  config: CalibrationConfig
): CalibrationFeedbackService {
  // ---------------------------------------------------------------------------
  // Analyze Calibration (Enhanced)
  // ---------------------------------------------------------------------------

  async function analyzeCalibration(identityId: string): Promise<CalibrationResult> {
    // Fetch historical predictions and outcomes
    const predictions = await pool.query(
      `SELECT confidence, accuracy_score, created_at
       FROM world_model_predictions
       WHERE identity_id = $1 AND verified_at IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1000`,
      [identityId]
    )

    if (predictions.rows.length < 10) {
      return {
        identity_id: identityId,
        overall_calibration: 0.5,
        overconfidence_bias: 0,
        underconfidence_bias: 0,
        recommendations: ["Need more validated predictions for calibration (minimum 10)"],
      }
    }

    // Group by confidence bins (10 bins: 0-10%, 10-20%, etc.)
    const bins: Record<number, { count: number; accurate: number; sumAccuracy: number }> = {}

    for (const row of predictions.rows) {
      const bin = Math.floor(row.confidence * 10)
      if (!bins[bin]) bins[bin] = { count: 0, accurate: 0, sumAccuracy: 0 }
      bins[bin].count++
      bins[bin].sumAccuracy += row.accuracy_score ?? 0
      if (row.accuracy_score > 0.7) bins[bin].accurate++
    }

    // Calculate calibration error
    let totalError = 0
    let overconfidenceSum = 0
    let underconfidenceSum = 0
    let binCount = 0

    for (const [binStr, data] of Object.entries(bins)) {
      const expectedAccuracy = Number.parseInt(binStr, 10) / 10 + 0.05 // Bin center
      const actualAccuracy = data.count > 0 ? data.sumAccuracy / data.count : 0
      const error = actualAccuracy - expectedAccuracy

      totalError += Math.abs(error)
      binCount++

      if (error < 0) {
        overconfidenceSum += Math.abs(error)
      } else {
        underconfidenceSum += error
      }
    }

    const avgError = binCount > 0 ? totalError / binCount : 0.5
    const overconfidenceBias = binCount > 0 ? overconfidenceSum / binCount : 0
    const underconfidenceBias = binCount > 0 ? underconfidenceSum / binCount : 0

    const recommendations: string[] = []

    if (overconfidenceBias > 0.15) {
      recommendations.push(
        `Critical: Reduce confidence estimates by ${Math.round(overconfidenceBias * 100)}%`
      )
    } else if (overconfidenceBias > 0.1) {
      recommendations.push(
        `Warning: Consider lowering confidence estimates by ~${Math.round(overconfidenceBias * 100)}%`
      )
    }

    if (underconfidenceBias > 0.15) {
      recommendations.push(
        `Critical: Increase confidence estimates by ${Math.round(underconfidenceBias * 100)}%`
      )
    } else if (underconfidenceBias > 0.1) {
      recommendations.push(
        `Warning: Consider raising confidence estimates by ~${Math.round(underconfidenceBias * 100)}%`
      )
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

  // ---------------------------------------------------------------------------
  // Generate Threshold Adjustments
  // ---------------------------------------------------------------------------

  async function generateThresholdAdjustments(
    identityId: string,
    calibrationResult: CalibrationResult
  ): Promise<CalibrationAdjustment[]> {
    const adjustments: CalibrationAdjustment[] = []
    const driftStatus = await getDriftStatus(identityId)

    if (!driftStatus.can_adjust) {
      return [] // Cooldown or drift limit reached
    }

    const remainingDriftBudget = config.maxCumulativeDrift - driftStatus.current_drift

    // Generate overconfidence correction
    if (calibrationResult.overconfidence_bias > 0.05) {
      const magnitude = Math.min(
        calibrationResult.overconfidence_bias,
        config.maxSingleAdjustment,
        remainingDriftBudget
      )

      if (magnitude > 0.01) {
        adjustments.push({
          calibration_id: crypto.randomUUID(),
          identity_id: identityId,
          calibration_type: "confidence_factor",
          target_component: "confidence_multiplier",
          previous_value: { factor: 1.0 },
          new_value: { factor: 1.0 - magnitude },
          adjustment_magnitude: magnitude,
          cumulative_drift: driftStatus.current_drift + magnitude,
          drift_since_reset: driftStatus.current_drift + magnitude,
          auto_applied: magnitude < config.significantThreshold,
          requires_notification: magnitude >= config.significantThreshold,
          trigger_reason: `Overconfidence bias detected: ${(calibrationResult.overconfidence_bias * 100).toFixed(1)}%`,
          calibration_metrics: {
            overall_calibration: calibrationResult.overall_calibration,
            overconfidence_bias: calibrationResult.overconfidence_bias,
          },
          created_at: new Date().toISOString(),
        })
      }
    }

    // Generate underconfidence correction
    if (calibrationResult.underconfidence_bias > 0.05) {
      const usedBudget = adjustments.reduce((sum, a) => sum + a.adjustment_magnitude, 0)
      const magnitude = Math.min(
        calibrationResult.underconfidence_bias,
        config.maxSingleAdjustment,
        remainingDriftBudget - usedBudget
      )

      if (magnitude > 0.01) {
        adjustments.push({
          calibration_id: crypto.randomUUID(),
          identity_id: identityId,
          calibration_type: "confidence_factor",
          target_component: "confidence_boost",
          previous_value: { factor: 1.0 },
          new_value: { factor: 1.0 + magnitude },
          adjustment_magnitude: magnitude,
          cumulative_drift: driftStatus.current_drift + usedBudget + magnitude,
          drift_since_reset: driftStatus.current_drift + usedBudget + magnitude,
          auto_applied: magnitude < config.significantThreshold,
          requires_notification: magnitude >= config.significantThreshold,
          trigger_reason: `Underconfidence bias detected: ${(calibrationResult.underconfidence_bias * 100).toFixed(1)}%`,
          calibration_metrics: {
            overall_calibration: calibrationResult.overall_calibration,
            underconfidence_bias: calibrationResult.underconfidence_bias,
          },
          created_at: new Date().toISOString(),
        })
      }
    }

    // Generate bias correction if both biases are present (asymmetric calibration)
    if (
      calibrationResult.overconfidence_bias > 0.03 &&
      calibrationResult.underconfidence_bias > 0.03
    ) {
      const usedBudget = adjustments.reduce((sum, a) => sum + a.adjustment_magnitude, 0)
      const magnitude = Math.min(0.02, remainingDriftBudget - usedBudget)

      if (magnitude > 0.005) {
        adjustments.push({
          calibration_id: crypto.randomUUID(),
          identity_id: identityId,
          calibration_type: "bias_correction",
          target_component: "calibration_curve",
          previous_value: { curve: "linear" },
          new_value: {
            curve: "sigmoid",
            parameters: {
              scale:
                1.0 -
                (calibrationResult.overconfidence_bias - calibrationResult.underconfidence_bias),
            },
          },
          adjustment_magnitude: magnitude,
          cumulative_drift: driftStatus.current_drift + usedBudget + magnitude,
          drift_since_reset: driftStatus.current_drift + usedBudget + magnitude,
          auto_applied: true,
          requires_notification: false,
          trigger_reason: "Asymmetric calibration detected",
          calibration_metrics: calibrationResult,
          created_at: new Date().toISOString(),
        })
      }
    }

    return adjustments
  }

  // ---------------------------------------------------------------------------
  // Apply Adjustment
  // ---------------------------------------------------------------------------

  async function applyAdjustment(adjustment: CalibrationAdjustment): Promise<boolean> {
    // Safety check: verify we're within bounds
    if (adjustment.adjustment_magnitude > config.maxSingleAdjustment) {
      return false
    }

    const _driftStatus = await getDriftStatus(adjustment.identity_id)
    if (adjustment.cumulative_drift > config.maxCumulativeDrift) {
      return false
    }

    // Persist the adjustment
    await pool.query(
      `INSERT INTO calibration_history (
        calibration_id, identity_id, calibration_type, target_component,
        previous_value, new_value, adjustment_magnitude, cumulative_drift,
        drift_since_reset, auto_applied, requires_notification, notification_sent,
        trigger_reason, calibration_metrics, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        adjustment.calibration_id,
        adjustment.identity_id,
        adjustment.calibration_type,
        adjustment.target_component,
        JSON.stringify(adjustment.previous_value),
        JSON.stringify(adjustment.new_value),
        adjustment.adjustment_magnitude,
        adjustment.cumulative_drift,
        adjustment.drift_since_reset,
        adjustment.auto_applied,
        adjustment.requires_notification,
        false, // notification_sent starts false
        adjustment.trigger_reason,
        JSON.stringify(adjustment.calibration_metrics),
        adjustment.created_at,
      ]
    )

    // Send notification if required
    if (adjustment.requires_notification && config.notifyOnSignificant) {
      await sendCalibrationNotification(adjustment)
    }

    return true
  }

  // ---------------------------------------------------------------------------
  // Drift Status
  // ---------------------------------------------------------------------------

  async function getDriftStatus(identityId: string): Promise<DriftStatus> {
    const result = await pool.query(
      `SELECT
        MAX(cumulative_drift) AS current_drift,
        MAX(created_at) AS last_adjustment_at,
        MAX(last_reset_at) AS last_reset_at
       FROM calibration_history
       WHERE identity_id = $1`,
      [identityId]
    )

    const row = result.rows[0]
    const currentDrift = row?.current_drift ?? 0
    const lastAdjustmentAt = row?.last_adjustment_at
    const _lastResetAt = row?.last_reset_at

    // Calculate cooldown
    const cooldownEndTime = lastAdjustmentAt
      ? new Date(lastAdjustmentAt).getTime() + config.cooldownMs
      : 0
    const now = Date.now()
    const cooldownRemainingMs = Math.max(0, cooldownEndTime - now)

    // Determine status
    let driftStatus: "normal" | "warning" | "critical" = "normal"
    if (currentDrift >= config.maxCumulativeDrift) {
      driftStatus = "critical"
    } else if (currentDrift >= config.maxCumulativeDrift * 0.75) {
      driftStatus = "warning"
    }

    return {
      identity_id: identityId,
      current_drift: currentDrift,
      drift_status: driftStatus,
      last_adjustment_at: lastAdjustmentAt?.toISOString(),
      cooldown_remaining_ms: cooldownRemainingMs,
      can_adjust: cooldownRemainingMs === 0 && currentDrift < config.maxCumulativeDrift,
    }
  }

  // ---------------------------------------------------------------------------
  // Reset Drift
  // ---------------------------------------------------------------------------

  async function resetDrift(identityId: string, reason: string): Promise<void> {
    // Record the reset
    await pool.query(
      `INSERT INTO calibration_history (
        calibration_id, identity_id, calibration_type, target_component,
        previous_value, new_value, adjustment_magnitude, cumulative_drift,
        drift_since_reset, last_reset_at, auto_applied, requires_notification,
        trigger_reason, calibration_metrics, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11, $12, $13, NOW())`,
      [
        crypto.randomUUID(),
        identityId,
        "threshold_adjustment",
        "drift_reset",
        JSON.stringify({ drift: "previous" }),
        JSON.stringify({ drift: 0 }),
        0,
        0,
        0,
        true,
        true,
        `Drift reset: ${reason}`,
        JSON.stringify({ reason }),
      ]
    )

    // Notify about drift reset
    await sendCalibrationNotification({
      calibration_id: crypto.randomUUID(),
      identity_id: identityId,
      calibration_type: "threshold_adjustment",
      target_component: "drift_reset",
      previous_value: {},
      new_value: { drift: 0 },
      adjustment_magnitude: 0,
      cumulative_drift: 0,
      drift_since_reset: 0,
      auto_applied: false,
      requires_notification: true,
      trigger_reason: `Drift reset: ${reason}`,
      calibration_metrics: {},
      created_at: new Date().toISOString(),
    })
  }

  // ---------------------------------------------------------------------------
  // Calibration Cycle (Scheduled)
  // ---------------------------------------------------------------------------

  async function runCalibrationCycle(identityId: string): Promise<{
    analyzed: boolean
    adjustments_proposed: number
    adjustments_applied: number
    notifications_sent: number
  }> {
    const stats = {
      analyzed: false,
      adjustments_proposed: 0,
      adjustments_applied: 0,
      notifications_sent: 0,
    }

    // Check cooldown
    const driftStatus = await getDriftStatus(identityId)
    if (!driftStatus.can_adjust) {
      return stats
    }

    // Analyze calibration
    const calibrationResult = await analyzeCalibration(identityId)
    stats.analyzed = true

    // Generate adjustments
    const adjustments = await generateThresholdAdjustments(identityId, calibrationResult)
    stats.adjustments_proposed = adjustments.length

    // Apply auto-applied adjustments
    for (const adjustment of adjustments) {
      if (adjustment.auto_applied) {
        const applied = await applyAdjustment(adjustment)
        if (applied) {
          stats.adjustments_applied++
          if (adjustment.requires_notification) {
            stats.notifications_sent++
          }
        }
      } else {
        // Significant adjustments require notification (but not auto-apply)
        await sendCalibrationNotification(adjustment)
        stats.notifications_sent++
      }
    }

    return stats
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  async function sendCalibrationNotification(adjustment: CalibrationAdjustment): Promise<void> {
    const message = {
      type: "calibration_adjustment",
      identity_id: adjustment.identity_id,
      adjustment_type: adjustment.calibration_type,
      magnitude: `${(adjustment.adjustment_magnitude * 100).toFixed(1)}%`,
      cumulative_drift: `${(adjustment.cumulative_drift * 100).toFixed(1)}%`,
      trigger: adjustment.trigger_reason,
      auto_applied: adjustment.auto_applied,
      timestamp: adjustment.created_at,
    }

    if (config.slackWebhookUrl) {
      try {
        await fetch(config.slackWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `MindOS Calibration ${adjustment.auto_applied ? "(Auto-Applied)" : "(Pending Review)"}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: [
                    `*${adjustment.calibration_type}* for \`${adjustment.identity_id}\``,
                    `• Adjustment: ${(adjustment.adjustment_magnitude * 100).toFixed(1)}%`,
                    `• Cumulative Drift: ${(adjustment.cumulative_drift * 100).toFixed(1)}%`,
                    `• Reason: ${adjustment.trigger_reason}`,
                    adjustment.auto_applied ? "✅ Auto-applied" : "⚠️ Requires review",
                  ].join("\n"),
                },
              },
            ],
          }),
        })

        // Mark notification as sent
        await pool.query(
          "UPDATE calibration_history SET notification_sent = true WHERE calibration_id = $1",
          [adjustment.calibration_id]
        )
      } catch {
        // Silently fail
      }
    }

    if (config.webhookUrl) {
      try {
        await fetch(config.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
        })
      } catch {
        // Silently fail
      }
    }
  }

  return {
    analyzeCalibration,
    generateThresholdAdjustments,
    applyAdjustment,
    getDriftStatus,
    resetDrift,
    runCalibrationCycle,
  }
}
