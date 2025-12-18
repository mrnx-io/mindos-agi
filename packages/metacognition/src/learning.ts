// =============================================================================
// Learning System
// =============================================================================

import type pg from "pg"
import type { Hypothesis, LearningRecord } from "./types.js"

// -----------------------------------------------------------------------------
// Learning Engine Interface
// -----------------------------------------------------------------------------

export interface LearningEngine {
  recordLearning(record: Omit<LearningRecord, "record_id" | "created_at">): Promise<LearningRecord>
  applyLearning(recordId: string, context: LearningContext): Promise<LearningApplication>
  findRelevantLearnings(context: LearningContext): Promise<LearningRecord[]>
  measureEffectiveness(recordId: string): Promise<EffectivenessMeasurement>
  consolidateLearnings(identityId: string): Promise<ConsolidationResult>
}

export interface LearningContext {
  task_type: string
  domain: string
  constraints: string[]
  similar_past_tasks: string[]
}

export interface LearningApplication {
  record_id: string
  applied_successfully: boolean
  modifications_made: string[]
  outcome_improvement: number
}

export interface EffectivenessMeasurement {
  record_id: string
  application_count: number
  success_rate: number
  avg_improvement: number
  generalization_success: number
}

export interface ConsolidationResult {
  records_analyzed: number
  records_merged: number
  generalizations_created: number
  redundant_removed: number
}

// -----------------------------------------------------------------------------
// Create Learning Engine
// -----------------------------------------------------------------------------

export function createLearningEngine(pool: pg.Pool): LearningEngine {
  async function recordLearning(
    record: Omit<LearningRecord, "record_id" | "created_at">
  ): Promise<LearningRecord> {
    const fullRecord: LearningRecord = {
      ...record,
      record_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    }

    await pool.query(
      `INSERT INTO learning_records (
        record_id, identity_id, learning_type, source_event,
        lesson_learned, generalization_level, application_contexts, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        fullRecord.record_id,
        fullRecord.identity_id,
        fullRecord.learning_type,
        fullRecord.source_event,
        fullRecord.lesson_learned,
        fullRecord.generalization_level,
        JSON.stringify(fullRecord.application_contexts),
        fullRecord.created_at,
      ]
    )

    return fullRecord
  }

  async function applyLearning(
    recordId: string,
    context: LearningContext
  ): Promise<LearningApplication> {
    // Fetch learning record
    const result = await pool.query("SELECT * FROM learning_records WHERE record_id = $1", [
      recordId,
    ])

    if (result.rows.length === 0) {
      throw new Error(`Learning record ${recordId} not found`)
    }

    const record = result.rows[0]

    // Check if context matches application contexts
    const applicationContexts = record.application_contexts as string[]
    const contextMatches = applicationContexts.some(
      (ac) => context.task_type.includes(ac) || context.domain.includes(ac)
    )

    const appliedSuccessfully = contextMatches
    const modifications: string[] = []

    if (appliedSuccessfully) {
      modifications.push(`Applied lesson: ${record.lesson_learned}`)

      // Record application
      await pool.query(
        `INSERT INTO learning_applications (
          application_id, record_id, context, applied_at, successful
        ) VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), recordId, JSON.stringify(context), new Date().toISOString(), true]
      )
    }

    return {
      record_id: recordId,
      applied_successfully: appliedSuccessfully,
      modifications_made: modifications,
      outcome_improvement: appliedSuccessfully ? 0.1 : 0,
    }
  }

  async function findRelevantLearnings(context: LearningContext): Promise<LearningRecord[]> {
    // Search for learnings that match the context
    const result = await pool.query(
      `SELECT * FROM learning_records
       WHERE $1 = ANY(application_contexts)
          OR $2 = ANY(application_contexts)
       ORDER BY created_at DESC
       LIMIT 20`,
      [context.task_type, context.domain]
    )

    return result.rows.map((row) => ({
      record_id: row.record_id,
      identity_id: row.identity_id,
      learning_type: row.learning_type,
      source_event: row.source_event,
      lesson_learned: row.lesson_learned,
      generalization_level: row.generalization_level,
      application_contexts: row.application_contexts,
      effectiveness_score: row.effectiveness_score,
      created_at: row.created_at,
    }))
  }

  async function measureEffectiveness(recordId: string): Promise<EffectivenessMeasurement> {
    // Get application history
    const applications = await pool.query(
      "SELECT * FROM learning_applications WHERE record_id = $1",
      [recordId]
    )

    const successfulApplications = applications.rows.filter((a) => a.successful)

    // Calculate generalization success (applications in different contexts)
    const uniqueContexts = new Set(applications.rows.map((a) => JSON.stringify(a.context)))

    const measurement: EffectivenessMeasurement = {
      record_id: recordId,
      application_count: applications.rows.length,
      success_rate:
        applications.rows.length > 0 ? successfulApplications.length / applications.rows.length : 0,
      avg_improvement: 0.1, // Would calculate from actual outcome data
      generalization_success: uniqueContexts.size / Math.max(applications.rows.length, 1),
    }

    // Update record with effectiveness score
    await pool.query("UPDATE learning_records SET effectiveness_score = $1 WHERE record_id = $2", [
      measurement.success_rate,
      recordId,
    ])

    return measurement
  }

  async function consolidateLearnings(identityId: string): Promise<ConsolidationResult> {
    // Fetch all learnings for identity
    const learnings = await pool.query("SELECT * FROM learning_records WHERE identity_id = $1", [
      identityId,
    ])

    let recordsMerged = 0
    let generalizationsCreated = 0
    let redundantRemoved = 0

    // Group by similar lessons
    const lessonGroups = new Map<string, typeof learnings.rows>()

    for (const learning of learnings.rows) {
      const key = simplifyLesson(learning.lesson_learned)
      const existing = lessonGroups.get(key) ?? []
      existing.push(learning)
      lessonGroups.set(key, existing)
    }

    // Process each group
    for (const [_key, group] of lessonGroups) {
      if (group.length > 1) {
        // Merge similar learnings
        const merged = mergeLearnings(group)

        if (merged) {
          recordsMerged += group.length - 1
          redundantRemoved += group.length - 1

          // Create generalized learning if appropriate
          if (group.length >= 3) {
            await createGeneralizedLearning(pool, identityId, group)
            generalizationsCreated++
          }
        }
      }
    }

    return {
      records_analyzed: learnings.rows.length,
      records_merged: recordsMerged,
      generalizations_created: generalizationsCreated,
      redundant_removed: redundantRemoved,
    }
  }

  return {
    recordLearning,
    applyLearning,
    findRelevantLearnings,
    measureEffectiveness,
    consolidateLearnings,
  }
}

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

function simplifyLesson(lesson: string): string {
  // Extract key concepts from lesson
  return lesson
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .sort()
    .slice(0, 5)
    .join("-")
}

function mergeLearnings(group: Array<Record<string, unknown>>): Record<string, unknown> | null {
  if (group.length < 2) return null

  // Combine application contexts
  const allContexts = group.flatMap((l) => l.application_contexts as string[])
  const uniqueContexts = [...new Set(allContexts)]

  // Use most recent lesson text
  const sortedByDate = [...group].sort(
    (a, b) =>
      new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime()
  )

  return {
    ...sortedByDate[0],
    application_contexts: uniqueContexts,
    generalization_level: "domain",
  }
}

async function createGeneralizedLearning(
  pool: pg.Pool,
  identityId: string,
  specificLearnings: Array<Record<string, unknown>>
): Promise<void> {
  // Extract common patterns
  const lessons = specificLearnings.map((l) => l.lesson_learned as string)
  const generalizedLesson = extractCommonPattern(lessons)

  const allContexts = specificLearnings.flatMap((l) => l.application_contexts as string[])
  const uniqueContexts = [...new Set(allContexts)]

  await pool.query(
    `INSERT INTO learning_records (
      record_id, identity_id, learning_type, source_event,
      lesson_learned, generalization_level, application_contexts, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      crypto.randomUUID(),
      identityId,
      "strategy_refinement",
      specificLearnings[0].source_event,
      generalizedLesson,
      "general",
      JSON.stringify(uniqueContexts),
      new Date().toISOString(),
    ]
  )
}

function extractCommonPattern(lessons: string[]): string {
  // Simple common word extraction
  const wordCounts = new Map<string, number>()

  for (const lesson of lessons) {
    const words = lesson.toLowerCase().split(/\s+/)
    for (const word of words) {
      if (word.length > 3) {
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1)
      }
    }
  }

  const commonWords = Array.from(wordCounts.entries())
    .filter(([, count]) => count >= lessons.length * 0.5)
    .map(([word]) => word)
    .slice(0, 10)

  return `General principle: Focus on ${commonWords.join(", ")}`
}

// -----------------------------------------------------------------------------
// Learning from Hypotheses
// -----------------------------------------------------------------------------

export async function learnFromHypothesisResolution(
  _pool: pg.Pool,
  hypothesis: Hypothesis,
  learningEngine: LearningEngine
): Promise<LearningRecord | null> {
  if (hypothesis.status !== "confirmed" && hypothesis.status !== "rejected") {
    return null
  }

  const lessonLearned =
    hypothesis.status === "confirmed"
      ? `Confirmed: ${hypothesis.statement}`
      : `Rejected hypothesis: ${hypothesis.statement} - alternative explanations needed`

  const learningType =
    hypothesis.hypothesis_type === "root_cause"
      ? "error_correction"
      : hypothesis.hypothesis_type === "improvement"
        ? "strategy_refinement"
        : "knowledge_integration"

  return learningEngine.recordLearning({
    identity_id: hypothesis.identity_id,
    learning_type: learningType,
    source_event: hypothesis.triggered_by,
    lesson_learned: lessonLearned,
    generalization_level: "specific",
    application_contexts: [hypothesis.hypothesis_type],
  })
}

// -----------------------------------------------------------------------------
// Transfer Learning
// -----------------------------------------------------------------------------

export interface TransferLearningResult {
  source_domain: string
  target_domain: string
  transferable_learnings: LearningRecord[]
  adaptation_suggestions: string[]
  expected_transfer_success: number
}

export async function analyzeTransferPotential(
  pool: pg.Pool,
  sourceDomain: string,
  targetDomain: string
): Promise<TransferLearningResult> {
  // Find learnings from source domain
  const sourceLearnings = await pool.query(
    `SELECT * FROM learning_records
     WHERE $1 = ANY(application_contexts)
       AND generalization_level IN ('domain', 'general')`,
    [sourceDomain]
  )

  // Analyze domain similarity
  const domainSimilarity = calculateDomainSimilarity(sourceDomain, targetDomain)

  // Filter transferable learnings
  const transferable = sourceLearnings.rows.filter((l) => {
    const generalizationLevel = l.generalization_level
    const effectiveness = l.effectiveness_score ?? 0.5

    // General learnings transfer better
    if (generalizationLevel === "general" && effectiveness > 0.5) return true

    // Domain learnings transfer if domains are similar
    if (generalizationLevel === "domain" && domainSimilarity > 0.5) return true

    return false
  })

  // Generate adaptation suggestions
  const adaptations: string[] = []

  if (domainSimilarity < 0.7) {
    adaptations.push("Validate assumptions from source domain in target context")
  }
  if (transferable.length > 0) {
    adaptations.push("Start with most general learnings before domain-specific ones")
  }

  return {
    source_domain: sourceDomain,
    target_domain: targetDomain,
    transferable_learnings: transferable.map((row) => ({
      record_id: row.record_id,
      identity_id: row.identity_id,
      learning_type: row.learning_type,
      source_event: row.source_event,
      lesson_learned: row.lesson_learned,
      generalization_level: row.generalization_level,
      application_contexts: row.application_contexts,
      effectiveness_score: row.effectiveness_score,
      created_at: row.created_at,
    })),
    adaptation_suggestions: adaptations,
    expected_transfer_success: domainSimilarity * 0.8,
  }
}

function calculateDomainSimilarity(domain1: string, domain2: string): number {
  // Simple word overlap similarity
  const words1 = new Set(domain1.toLowerCase().split(/[_\-\s]+/))
  const words2 = new Set(domain2.toLowerCase().split(/[_\-\s]+/))

  const intersection = new Set([...words1].filter((w) => words2.has(w)))
  const union = new Set([...words1, ...words2])

  return intersection.size / union.size
}
