// =============================================================================
// Historical Analysis - Memory-Based Pattern Discovery
// =============================================================================
// Replaces hardcoded historical patterns with actual memory queries.

import { env } from "../config.js"
import { query } from "../db.js"
import { createLogger } from "../logger.js"
import { searchSemanticMemory } from "../memory.js"
import { generateEmbedding } from "../tooling/embeddingClient.js"

const log = createLogger("historical-analysis")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface HistoricalPattern {
  pattern_id: string
  pattern_type: "trend" | "cycle" | "anomaly" | "correlation" | "causal"
  subject: string
  description: string
  confidence: number
  evidence_count: number
  first_observed: string
  last_observed: string
  metadata: Record<string, unknown>
}

export interface TrendAnalysis {
  subject: string
  direction: "increasing" | "decreasing" | "stable" | "volatile"
  magnitude: number // -1 to 1
  volatility: number // 0 to 1
  confidence: number
  data_points: number
  time_span_days: number
}

export interface PatternMatch {
  pattern: HistoricalPattern
  relevance: number
  applicable_insights: string[]
}

export interface HistoricalContext {
  similar_tasks: Array<{
    task_id: string
    goal: string
    outcome: "success" | "failure" | "partial"
    similarity: number
    lessons: string[]
  }>
  relevant_patterns: PatternMatch[]
  trends: TrendAnalysis[]
  warnings: string[]
}

// -----------------------------------------------------------------------------
// Historical Pattern Analysis
// -----------------------------------------------------------------------------

/**
 * Analyze historical patterns from actual memory data
 * Replaces hardcoded `analyzeHistoricalPatterns()` with memory queries
 */
export async function analyzeHistoricalPatternsFromMemory(
  identityId: string,
  subject: string,
  options: {
    lookbackDays?: number
    minConfidence?: number
    maxPatterns?: number
  } = {}
): Promise<HistoricalPattern[]> {
  const lookbackDays = options.lookbackDays ?? env.WORLD_MODEL_HISTORY_LOOKBACK_DAYS
  const minConfidence = options.minConfidence ?? 0.6
  const maxPatterns = options.maxPatterns ?? 10

  log.debug({ identityId, subject, lookbackDays }, "Analyzing historical patterns")

  const patterns: HistoricalPattern[] = []

  // 1. Detect trends from event frequencies
  const trendPatterns = await detectTrendPatterns(identityId, subject, lookbackDays, minConfidence)
  patterns.push(...trendPatterns)

  // 2. Query procedural memory for similar task patterns
  const proceduralPatterns = await detectProceduralPatterns(identityId, subject)
  patterns.push(...proceduralPatterns)

  // 3. Detect anomalies from world model predictions
  const accuracyAnomalies = await detectAccuracyAnomalies(identityId, lookbackDays)
  patterns.push(...accuracyAnomalies)

  // 4. Check for causal patterns in counterfactual analyses
  const causalPatterns = await detectCausalPatterns(identityId, lookbackDays)
  patterns.push(...causalPatterns)

  log.info(
    { identityId, subject, patternCount: patterns.length },
    "Historical pattern analysis complete"
  )

  return patterns.slice(0, maxPatterns)
}

/**
 * Get historical context for a task goal
 */
export async function getHistoricalContext(
  identityId: string,
  goal: string
): Promise<HistoricalContext> {
  log.debug({ identityId, goal: goal.slice(0, 50) }, "Building historical context")

  // 1. Find similar past tasks using semantic search
  const goalEmbedding = await generateEmbedding(goal)
  const semanticResults = await searchSemanticMemory(identityId, goalEmbedding, { limit: 10 })
  const similarTasks = await findSimilarTasks(semanticResults)

  // 2. Get relevant patterns
  const patterns = await analyzeHistoricalPatternsFromMemory(identityId, goal)
  const relevantPatterns: PatternMatch[] = patterns.map((p) => ({
    pattern: p,
    relevance: p.confidence,
    applicable_insights: generateInsightsFromPattern(p, goal),
  }))

  // 3. Analyze trends for key subjects
  const keySubjects = extractKeySubjects(goal)
  const trends: TrendAnalysis[] = []

  for (const subject of keySubjects.slice(0, 3)) {
    const subjectEvents = await query<{
      event_type: string
      created_at: Date
    }>(
      `SELECT COALESCE(kind, type) as event_type, created_at
       FROM events
       WHERE identity_id = $1
         AND (COALESCE(kind, type) ILIKE $2 OR payload::text ILIKE $2)
         AND created_at > NOW() - '30 days'::interval
       ORDER BY created_at DESC
       LIMIT 50`,
      [identityId, `%${subject}%`]
    )

    if (subjectEvents.rows.length >= 5) {
      const trend = calculateTrend(subjectEvents.rows)
      trends.push({
        subject,
        direction: trend.direction,
        magnitude: trend.magnitude,
        volatility: trend.volatility,
        confidence: trend.confidence,
        data_points: subjectEvents.rows.length,
        time_span_days: 30,
      })
    }
  }

  // 4. Generate warnings based on historical failures
  const warnings = generateWarnings(similarTasks, patterns)

  return {
    similar_tasks: similarTasks,
    relevant_patterns: relevantPatterns,
    trends,
    warnings,
  }
}

// -----------------------------------------------------------------------------
// Helper Functions for analyzeHistoricalPatternsFromMemory
// -----------------------------------------------------------------------------

async function detectTrendPatterns(
  identityId: string,
  subject: string,
  lookbackDays: number,
  minConfidence: number
): Promise<HistoricalPattern[]> {
  const patterns: HistoricalPattern[] = []

  // Query episodic memory for similar past events
  const episodicEvents = await query<{
    event_id: string
    event_type: string
    payload: Record<string, unknown>
    created_at: Date
  }>(
    `SELECT event_id, COALESCE(kind, type) as event_type, payload, created_at
     FROM events
     WHERE identity_id = $1
       AND created_at > NOW() - $2::interval
       AND (
         payload::text ILIKE $3
         OR COALESCE(kind, type) ILIKE $3
       )
     ORDER BY created_at DESC
     LIMIT 100`,
    [identityId, `${lookbackDays} days`, `%${subject}%`]
  )

  if (episodicEvents.rows.length < 5) {
    return patterns
  }

  const eventsByType = groupEventsByType(episodicEvents.rows)

  for (const [eventType, events] of Object.entries(eventsByType)) {
    if (events.length === 0) continue

    const trend = calculateTrend(events)
    if (trend.confidence < minConfidence) continue

    const firstEvent = events[events.length - 1]
    const lastEvent = events[0]
    if (!firstEvent || !lastEvent) continue

    patterns.push({
      pattern_id: crypto.randomUUID(),
      pattern_type: "trend",
      subject: eventType,
      description: `${eventType} is ${trend.direction} over the past ${lookbackDays} days`,
      confidence: trend.confidence,
      evidence_count: events.length,
      first_observed: firstEvent.created_at.toISOString(),
      last_observed: lastEvent.created_at.toISOString(),
      metadata: {
        direction: trend.direction,
        magnitude: trend.magnitude,
        volatility: trend.volatility,
      },
    })
  }

  return patterns
}

async function detectProceduralPatterns(
  identityId: string,
  subject: string
): Promise<HistoricalPattern[]> {
  const patterns: HistoricalPattern[] = []

  const proceduralPatterns = await query<{
    skill_name: string
    description: string
    success_rate: number
    usage_count: number
    last_used: Date
  }>(
    `SELECT
       pm.name as skill_name,
       pm.description,
       COALESCE(
         (SELECT COUNT(*) FILTER (WHERE sur.outcome = 'success')::float / NULLIF(COUNT(*), 0)
          FROM skill_usage_records sur WHERE sur.skill_name = pm.name),
         0.5
       ) as success_rate,
       pm.execution_count as usage_count,
       pm.updated_at as last_used
     FROM skills pm
     WHERE pm.identity_id = $1
       AND pm.description ILIKE $2
     ORDER BY pm.execution_count DESC
     LIMIT 20`,
    [identityId, `%${subject}%`]
  )

  for (const skill of proceduralPatterns.rows) {
    if (skill.usage_count < 3) continue

    patterns.push({
      pattern_id: crypto.randomUUID(),
      pattern_type: "correlation",
      subject: skill.skill_name,
      description: `Skill "${skill.skill_name}" has ${Math.round(skill.success_rate * 100)}% success rate for similar tasks`,
      confidence: Math.min(0.95, 0.5 + skill.usage_count * 0.05),
      evidence_count: skill.usage_count,
      first_observed: skill.last_used.toISOString(),
      last_observed: skill.last_used.toISOString(),
      metadata: {
        success_rate: skill.success_rate,
        skill_description: skill.description,
      },
    })
  }

  return patterns
}

async function detectAccuracyAnomalies(
  identityId: string,
  lookbackDays: number
): Promise<HistoricalPattern[]> {
  const patterns: HistoricalPattern[] = []

  const predictionAccuracy = await query<{
    prediction_type: string
    avg_accuracy: number
    total_predictions: number
    recent_accuracy: number
  }>(
    `SELECT
       prediction_type,
       AVG(actual_outcome_match) as avg_accuracy,
       COUNT(*) as total_predictions,
       AVG(CASE WHEN created_at > NOW() - '7 days'::interval THEN actual_outcome_match ELSE NULL END) as recent_accuracy
     FROM world_model_predictions
     WHERE identity_id = $1
       AND created_at > NOW() - $2::interval
     GROUP BY prediction_type
     HAVING COUNT(*) >= 5`,
    [identityId, `${lookbackDays} days`]
  )

  for (const pred of predictionAccuracy.rows) {
    if (pred.recent_accuracy === null) continue
    if (Math.abs(pred.avg_accuracy - pred.recent_accuracy) <= 0.15) continue

    patterns.push({
      pattern_id: crypto.randomUUID(),
      pattern_type: "anomaly",
      subject: `prediction_accuracy_${pred.prediction_type}`,
      description: `Prediction accuracy for ${pred.prediction_type} has ${pred.recent_accuracy > pred.avg_accuracy ? "improved" : "degraded"} recently`,
      confidence: Math.min(0.9, pred.total_predictions / 50 + 0.5),
      evidence_count: pred.total_predictions,
      first_observed: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString(),
      last_observed: new Date().toISOString(),
      metadata: {
        average_accuracy: pred.avg_accuracy,
        recent_accuracy: pred.recent_accuracy,
        drift: pred.recent_accuracy - pred.avg_accuracy,
      },
    })
  }

  return patterns
}

async function detectCausalPatterns(
  identityId: string,
  lookbackDays: number
): Promise<HistoricalPattern[]> {
  const patterns: HistoricalPattern[] = []

  const causalPatterns = await query<{
    original_action: string
    better_alternative: string
    confidence: number
    occurrences: number
  }>(
    `SELECT
       original_action,
       alternatives->0->>'action' as better_alternative,
       AVG(confidence) as confidence,
       COUNT(*) as occurrences
     FROM counterfactual_analyses
     WHERE identity_id = $1
       AND created_at > NOW() - $2::interval
       AND cardinality(alternatives) > 0
     GROUP BY original_action, alternatives->0->>'action'
     HAVING COUNT(*) >= 2
     ORDER BY COUNT(*) DESC
     LIMIT 5`,
    [identityId, `${lookbackDays} days`]
  )

  for (const causal of causalPatterns.rows) {
    patterns.push({
      pattern_id: crypto.randomUUID(),
      pattern_type: "causal",
      subject: causal.original_action,
      description: `When "${causal.original_action}" fails, "${causal.better_alternative}" often works better`,
      confidence: causal.confidence,
      evidence_count: causal.occurrences,
      first_observed: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString(),
      last_observed: new Date().toISOString(),
      metadata: {
        original_action: causal.original_action,
        better_alternative: causal.better_alternative,
      },
    })
  }

  return patterns
}

// -----------------------------------------------------------------------------
// Helper Functions for getHistoricalContext
// -----------------------------------------------------------------------------

async function findSimilarTasks(
  semanticResults: Array<{
    memory: { metadata: unknown }
    similarity: number
  }>
): Promise<
  Array<{
    task_id: string
    goal: string
    outcome: "success" | "failure" | "partial"
    similarity: number
    lessons: string[]
  }>
> {
  const similarTasks: Array<{
    task_id: string
    goal: string
    outcome: "success" | "failure" | "partial"
    similarity: number
    lessons: string[]
  }> = []

  for (const result of semanticResults) {
    const metadata = result.memory.metadata as Record<string, unknown> | undefined
    if (!metadata?.task_id) continue

    const taskResult = await query<{
      task_id: string
      goal: string
      status: string
      reflection_data: Record<string, unknown>
    }>(
      `SELECT t.task_id, t.goal, t.status, e.payload as reflection_data
       FROM tasks t
       LEFT JOIN events e ON e.identity_id = t.identity_id
         AND COALESCE(e.kind, e.type) = 'task_completed'
         AND (e.payload->>'task_id')::uuid = t.task_id
       WHERE t.task_id = $1`,
      [metadata.task_id]
    )

    const task = taskResult.rows[0]
    if (!task) continue

    similarTasks.push({
      task_id: task.task_id,
      goal: task.goal,
      outcome:
        task.status === "completed" ? "success" : task.status === "failed" ? "failure" : "partial",
      similarity: result.similarity,
      lessons: Array.isArray(task.reflection_data?.lessons_learned)
        ? (task.reflection_data.lessons_learned as string[])
        : [],
    })
  }

  return similarTasks
}

function generateWarnings(
  similarTasks: Array<{
    outcome: "success" | "failure" | "partial"
    similarity: number
  }>,
  patterns: HistoricalPattern[]
): string[] {
  const warnings: string[] = []

  const recentFailures = similarTasks.filter((t) => t.outcome === "failure" && t.similarity > 0.7)
  if (recentFailures.length > 0) {
    warnings.push(
      `Similar tasks have failed recently (${recentFailures.length} failures). Review lessons learned.`
    )
  }

  const accuracyAnomalies = patterns.filter(
    (p) => p.pattern_type === "anomaly" && (p.metadata.drift as number) < -0.1
  )
  if (accuracyAnomalies.length > 0) {
    warnings.push("Prediction accuracy has degraded recently. Consider extra validation.")
  }

  return warnings
}

// -----------------------------------------------------------------------------
// Helper Functions for calculateTrend
// -----------------------------------------------------------------------------

function calculateIntervals(timestamps: number[]): number[] {
  const intervals: number[] = []

  for (let i = 1; i < timestamps.length; i++) {
    const curr = timestamps[i]
    const prev = timestamps[i - 1]
    if (curr !== undefined && prev !== undefined) {
      intervals.push(curr - prev)
    }
  }

  return intervals
}

function calculateVolatility(intervals: number[]): number {
  if (intervals.length === 0) return 0

  const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length
  const variance = intervals.reduce((sum, i) => sum + (i - avgInterval) ** 2, 0) / intervals.length

  return avgInterval > 0 ? Math.min(1, Math.sqrt(variance) / avgInterval) : 0
}

function determineDirection(
  avgFirstHalf: number,
  avgSecondHalf: number,
  volatility: number
): {
  direction: "increasing" | "decreasing" | "stable" | "volatile"
  magnitude: number
} {
  if (volatility > 0.7) {
    return { direction: "volatile", magnitude: 0 }
  }

  const change = avgFirstHalf > 0 ? (avgFirstHalf - avgSecondHalf) / avgFirstHalf : 0
  const magnitude = Math.min(1, Math.max(-1, change))

  if (Math.abs(magnitude) < 0.1) {
    return { direction: "stable", magnitude }
  }

  if (magnitude > 0) {
    return { direction: "increasing", magnitude }
  }

  return { direction: "decreasing", magnitude }
}

// -----------------------------------------------------------------------------
// General Helper Functions
// -----------------------------------------------------------------------------

function groupEventsByType(
  events: Array<{ event_type: string; created_at: Date }>
): Record<string, Array<{ event_type: string; created_at: Date }>> {
  const grouped: Record<string, Array<{ event_type: string; created_at: Date }>> = {}

  for (const event of events) {
    const existing = grouped[event.event_type]
    if (existing) {
      existing.push(event)
    } else {
      grouped[event.event_type] = [event]
    }
  }

  return grouped
}

function calculateTrend(events: Array<{ created_at: Date }>): {
  direction: "increasing" | "decreasing" | "stable" | "volatile"
  magnitude: number
  volatility: number
  confidence: number
} {
  if (events.length < 3) {
    return { direction: "stable", magnitude: 0, volatility: 0, confidence: 0.3 }
  }

  // Calculate time-based frequency
  const timestamps = events.map((e) => e.created_at.getTime()).sort()
  const intervals = calculateIntervals(timestamps)

  if (intervals.length === 0) {
    return { direction: "stable", magnitude: 0, volatility: 0, confidence: 0.3 }
  }

  // Calculate average interval and its change over time
  const firstHalfIntervals = intervals.slice(0, Math.floor(intervals.length / 2))
  const secondHalfIntervals = intervals.slice(Math.floor(intervals.length / 2))

  const avgFirstHalf =
    firstHalfIntervals.length > 0
      ? firstHalfIntervals.reduce((a, b) => a + b, 0) / firstHalfIntervals.length
      : 0
  const avgSecondHalf =
    secondHalfIntervals.length > 0
      ? secondHalfIntervals.reduce((a, b) => a + b, 0) / secondHalfIntervals.length
      : 0

  // Calculate volatility
  const volatility = calculateVolatility(intervals)

  // Determine direction
  const { direction, magnitude } = determineDirection(avgFirstHalf, avgSecondHalf, volatility)

  const confidence = Math.min(0.95, 0.5 + events.length * 0.03)

  return { direction, magnitude, volatility, confidence }
}

function generateInsightsFromPattern(pattern: HistoricalPattern, _goal: string): string[] {
  const insights: string[] = []

  switch (pattern.pattern_type) {
    case "trend":
      if (pattern.metadata.direction === "increasing") {
        insights.push(`${pattern.subject} frequency is increasing - may require more resources`)
      } else if (pattern.metadata.direction === "decreasing") {
        insights.push(`${pattern.subject} frequency is decreasing - may be becoming obsolete`)
      }
      break

    case "correlation":
      insights.push(
        `Consider using skill "${pattern.subject}" based on ${Math.round(pattern.confidence * 100)}% historical success`
      )
      break

    case "anomaly":
      insights.push(`Anomaly detected: ${pattern.description}`)
      break

    case "causal":
      insights.push(
        `If "${pattern.metadata.original_action}" fails, try "${pattern.metadata.better_alternative}"`
      )
      break

    case "cycle":
      insights.push("Pattern shows cyclical behavior - timing may be important")
      break
  }

  return insights
}

function extractKeySubjects(goal: string): string[] {
  // Extract key nouns/verbs from the goal
  const words = goal.toLowerCase().split(/\s+/)
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "can",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "under",
    "again",
    "further",
    "then",
    "once",
    "here",
    "there",
    "when",
    "where",
    "why",
    "how",
    "all",
    "each",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "nor",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "just",
    "and",
    "but",
    "if",
    "or",
    "because",
    "until",
    "while",
    "about",
    "against",
    "both",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "i",
    "me",
    "my",
    "we",
    "our",
  ])

  return words.filter((w) => w.length > 3 && !stopWords.has(w)).slice(0, 10)
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

export const historicalAnalysis = {
  analyzeHistoricalPatternsFromMemory,
  getHistoricalContext,
}
