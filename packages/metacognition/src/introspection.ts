// =============================================================================
// Deep Introspection Module
// =============================================================================

import type { IntrospectionTrigger, SelfObservation } from "./types.js"

// -----------------------------------------------------------------------------
// Introspection Strategies
// -----------------------------------------------------------------------------

export type IntrospectionStrategy = "breadth_first" | "depth_first" | "targeted" | "adaptive"

export interface IntrospectionConfig {
  strategy: IntrospectionStrategy
  max_depth: number
  time_budget_ms: number
  focus_areas: string[]
}

export interface IntrospectionContext {
  recent_observations: SelfObservation[]
  current_goals: string[]
  active_constraints: string[]
  performance_history: PerformanceSnapshot[]
}

export interface PerformanceSnapshot {
  timestamp: string
  success_rate: number
  avg_task_duration_ms: number
  error_rate: number
  confidence_calibration: number
}

// -----------------------------------------------------------------------------
// Deep Analysis Functions
// -----------------------------------------------------------------------------

export function analyzePerformanceTrends(history: PerformanceSnapshot[]): PerformanceTrendAnalysis {
  if (history.length < 2) {
    return {
      success_rate_trend: "stable",
      duration_trend: "stable",
      error_rate_trend: "stable",
      overall_trajectory: "stable",
      anomalies: [],
      recommendations: [],
    }
  }

  // Calculate trends
  const successRates = history.map((h) => h.success_rate)
  const durations = history.map((h) => h.avg_task_duration_ms)
  const errorRates = history.map((h) => h.error_rate)

  const successTrend = calculateTrend(successRates)
  const durationTrend = calculateTrend(durations)
  const errorTrend = calculateTrend(errorRates)

  // Detect anomalies
  const anomalies = detectAnomalies(history)

  // Generate recommendations
  const recommendations: string[] = []

  if (successTrend === "decreasing") {
    recommendations.push("Investigate causes of declining success rate")
  }
  if (durationTrend === "increasing") {
    recommendations.push("Review task complexity or optimize processes")
  }
  if (errorTrend === "increasing") {
    recommendations.push("Implement additional error handling or validation")
  }

  // Determine overall trajectory
  let overallTrajectory: "improving" | "declining" | "stable"
  if (successTrend === "increasing" && errorTrend !== "increasing") {
    overallTrajectory = "improving"
  } else if (successTrend === "decreasing" || errorTrend === "increasing") {
    overallTrajectory = "declining"
  } else {
    overallTrajectory = "stable"
  }

  return {
    success_rate_trend: successTrend,
    duration_trend: durationTrend,
    error_rate_trend: errorTrend,
    overall_trajectory: overallTrajectory,
    anomalies,
    recommendations,
  }
}

export interface PerformanceTrendAnalysis {
  success_rate_trend: "increasing" | "decreasing" | "stable"
  duration_trend: "increasing" | "decreasing" | "stable"
  error_rate_trend: "increasing" | "decreasing" | "stable"
  overall_trajectory: "improving" | "declining" | "stable"
  anomalies: PerformanceAnomaly[]
  recommendations: string[]
}

export interface PerformanceAnomaly {
  timestamp: string
  metric: string
  expected_value: number
  actual_value: number
  deviation_sigma: number
}

function calculateTrend(values: number[]): "increasing" | "decreasing" | "stable" {
  if (values.length < 2) return "stable"

  // Simple linear regression
  const n = values.length
  const xMean = (n - 1) / 2
  const yMean = values.reduce((a, b) => a + b, 0) / n

  let numerator = 0
  let denominator = 0

  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (values[i] - yMean)
    denominator += (i - xMean) ** 2
  }

  const slope = denominator !== 0 ? numerator / denominator : 0

  // Threshold for trend detection
  const threshold = 0.01 * yMean

  if (slope > threshold) return "increasing"
  if (slope < -threshold) return "decreasing"
  return "stable"
}

function detectAnomalies(history: PerformanceSnapshot[]): PerformanceAnomaly[] {
  const anomalies: PerformanceAnomaly[] = []

  if (history.length < 3) return anomalies

  // Calculate statistics for each metric
  const metrics: Array<{ name: string; values: number[] }> = [
    { name: "success_rate", values: history.map((h) => h.success_rate) },
    { name: "avg_task_duration_ms", values: history.map((h) => h.avg_task_duration_ms) },
    { name: "error_rate", values: history.map((h) => h.error_rate) },
  ]

  for (const metric of metrics) {
    const mean = metric.values.reduce((a, b) => a + b, 0) / metric.values.length
    const variance =
      metric.values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / metric.values.length
    const stdDev = Math.sqrt(variance)

    for (let i = 0; i < metric.values.length; i++) {
      const deviation = Math.abs(metric.values[i] - mean) / (stdDev || 1)

      if (deviation > 2) {
        anomalies.push({
          timestamp: history[i].timestamp,
          metric: metric.name,
          expected_value: mean,
          actual_value: metric.values[i],
          deviation_sigma: deviation,
        })
      }
    }
  }

  return anomalies
}

// -----------------------------------------------------------------------------
// Self-Model Analysis
// -----------------------------------------------------------------------------

export interface SelfModel {
  capabilities: CapabilityAssessment[]
  limitations: Limitation[]
  biases: CognitiveBias[]
  strengths: string[]
  growth_areas: string[]
}

export interface CapabilityAssessment {
  capability: string
  proficiency: number
  confidence: number
  evidence_count: number
  recent_trend: "improving" | "declining" | "stable"
}

export interface Limitation {
  description: string
  category: "resource" | "knowledge" | "capability" | "environmental"
  severity: number
  mitigations: string[]
}

export interface CognitiveBias {
  bias_type: string
  description: string
  evidence: string[]
  impact: "low" | "medium" | "high"
  debiasing_strategies: string[]
}

export function buildSelfModel(
  observations: SelfObservation[],
  performanceHistory: PerformanceSnapshot[]
): SelfModel {
  // Analyze capabilities from observations
  const capabilities = analyzeCapabilities(observations)

  // Identify limitations
  const limitations = identifyLimitations(observations, performanceHistory)

  // Detect cognitive biases
  const biases = detectBiases(observations)

  // Extract strengths and growth areas
  const strengths = capabilities.filter((c) => c.proficiency > 0.7).map((c) => c.capability)

  const growthAreas = capabilities
    .filter((c) => c.proficiency < 0.5 || c.recent_trend === "declining")
    .map((c) => c.capability)

  return {
    capabilities,
    limitations,
    biases,
    strengths,
    growth_areas: growthAreas,
  }
}

function analyzeCapabilities(observations: SelfObservation[]): CapabilityAssessment[] {
  const capabilityMap = new Map<string, { successes: number; total: number; recent: number[] }>()

  for (const obs of observations) {
    if (obs.observation_type === "performance_metric") {
      const content = obs.content as Record<string, unknown>
      const capability = (content.capability as string) ?? "general"
      const success = (content.success as boolean) ?? false

      const existing = capabilityMap.get(capability) ?? { successes: 0, total: 0, recent: [] }
      existing.total++
      if (success) existing.successes++
      existing.recent.push(success ? 1 : 0)

      if (existing.recent.length > 10) existing.recent.shift()

      capabilityMap.set(capability, existing)
    }
  }

  return Array.from(capabilityMap.entries()).map(([capability, data]) => {
    const proficiency = data.total > 0 ? data.successes / data.total : 0.5
    const recentTrend = calculateTrend(data.recent)

    return {
      capability,
      proficiency,
      confidence: Math.min(data.total / 10, 1),
      evidence_count: data.total,
      recent_trend: recentTrend,
    }
  })
}

function identifyLimitations(
  observations: SelfObservation[],
  history: PerformanceSnapshot[]
): Limitation[] {
  const limitations: Limitation[] = []

  // Check for resource limitations
  const resourceObs = observations.filter((o) => o.observation_type === "resource_usage")
  for (const obs of resourceObs) {
    const content = obs.content as Record<string, number>
    if ((content.memory_usage ?? 0) > 0.8) {
      limitations.push({
        description: "High memory usage observed",
        category: "resource",
        severity: 0.7,
        mitigations: ["Optimize memory usage", "Increase available resources"],
      })
    }
    if ((content.cpu_usage ?? 0) > 0.9) {
      limitations.push({
        description: "CPU utilization near capacity",
        category: "resource",
        severity: 0.8,
        mitigations: ["Optimize algorithms", "Parallelize operations"],
      })
    }
  }

  // Check for knowledge gaps
  const lowPerformanceAreas = history.filter((h) => h.success_rate < 0.5).map((h) => h.timestamp)

  if (lowPerformanceAreas.length > 3) {
    limitations.push({
      description: "Consistent low performance in certain areas",
      category: "knowledge",
      severity: 0.6,
      mitigations: ["Acquire additional training", "Seek expert guidance"],
    })
  }

  return limitations
}

function detectBiases(observations: SelfObservation[]): CognitiveBias[] {
  const biases: CognitiveBias[] = []

  // Check for confirmation bias
  const decisionObs = observations.filter((o) => o.observation_type === "decision_quality")
  const confirmatoryDecisions = decisionObs.filter((o) => {
    const content = o.content as Record<string, unknown>
    return content.considered_alternatives === false
  })

  if (confirmatoryDecisions.length > decisionObs.length * 0.3) {
    biases.push({
      bias_type: "confirmation_bias",
      description: "Tendency to not consider alternative hypotheses",
      evidence: confirmatoryDecisions.map((o) => o.observation_id),
      impact: "medium",
      debiasing_strategies: [
        "Actively seek contradicting evidence",
        "Consider at least 2 alternatives before deciding",
      ],
    })
  }

  // Check for overconfidence
  const confidenceObs = observations.filter((o) => {
    const content = o.content as Record<string, number>
    return content.stated_confidence !== undefined && content.actual_accuracy !== undefined
  })

  const overconfidentCount = confidenceObs.filter((o) => {
    const content = o.content as Record<string, number>
    return content.stated_confidence - content.actual_accuracy > 0.2
  }).length

  if (overconfidentCount > confidenceObs.length * 0.4) {
    biases.push({
      bias_type: "overconfidence_bias",
      description: "Systematic overestimation of prediction accuracy",
      evidence: [],
      impact: "high",
      debiasing_strategies: [
        "Apply confidence calibration factor",
        "Seek external validation for high-stakes decisions",
      ],
    })
  }

  return biases
}

// -----------------------------------------------------------------------------
// Introspection Triggers
// -----------------------------------------------------------------------------

export function shouldTriggerIntrospection(
  observations: SelfObservation[],
  lastIntrospection: Date | null,
  config: {
    min_interval_ms: number
    uncertainty_threshold: number
    performance_drop_threshold: number
  }
): { shouldTrigger: boolean; trigger?: IntrospectionTrigger } {
  const now = Date.now()

  // Check minimum interval
  if (lastIntrospection && now - lastIntrospection.getTime() < config.min_interval_ms) {
    return { shouldTrigger: false }
  }

  // Check for high uncertainty
  const uncertaintyObs = observations.filter((o) => {
    const content = o.content as Record<string, number>
    return (content.uncertainty ?? 0) > config.uncertainty_threshold
  })

  if (uncertaintyObs.length > observations.length * 0.3) {
    return {
      shouldTrigger: true,
      trigger: {
        trigger_type: "uncertainty_threshold",
        trigger_source: "automatic",
        urgency: "medium",
        context: { uncertainty_observations: uncertaintyObs.length },
      },
    }
  }

  // Check for performance degradation
  const performanceObs = observations
    .filter((o) => o.observation_type === "performance_metric")
    .slice(-10)

  if (performanceObs.length >= 5) {
    const recentPerf = performanceObs.slice(-5)
    const olderPerf = performanceObs.slice(0, 5)

    const recentAvg =
      recentPerf.reduce((sum, o) => {
        return sum + ((o.content as Record<string, number>).performance ?? 0.5)
      }, 0) / recentPerf.length

    const olderAvg =
      olderPerf.reduce((sum, o) => {
        return sum + ((o.content as Record<string, number>).performance ?? 0.5)
      }, 0) / olderPerf.length

    if (olderAvg - recentAvg > config.performance_drop_threshold) {
      return {
        shouldTrigger: true,
        trigger: {
          trigger_type: "performance_degradation",
          trigger_source: "automatic",
          urgency: "high",
          context: {
            recent_performance: recentAvg,
            previous_performance: olderAvg,
            drop: olderAvg - recentAvg,
          },
        },
      }
    }
  }

  return { shouldTrigger: false }
}
