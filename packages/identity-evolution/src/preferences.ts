// =============================================================================
// Preference Learning System
// =============================================================================

import type pg from "pg"
import type { Preference } from "./types.js"

// -----------------------------------------------------------------------------
// Preference Engine Interface
// -----------------------------------------------------------------------------

export interface PreferenceEngine {
  getPreferences(identityId: string, category?: Preference["category"]): Promise<Preference[]>
  getPreference(identityId: string, key: string): Promise<Preference | null>
  setPreference(preference: Omit<Preference, "preference_id" | "last_updated">): Promise<Preference>
  inferPreference(identityId: string, signal: PreferenceSignal): Promise<Preference | null>
  reconcilePreferences(identityId: string): Promise<ReconciliationResult>
}

export interface PreferenceSignal {
  signal_type: "explicit" | "implicit_positive" | "implicit_negative" | "behavioral"
  category: Preference["category"]
  key: string
  observed_value: unknown
  context: Record<string, unknown>
  confidence: number
}

export interface ReconciliationResult {
  conflicts_found: number
  conflicts_resolved: number
  preferences_updated: string[]
}

// -----------------------------------------------------------------------------
// Create Preference Engine
// -----------------------------------------------------------------------------

export function createPreferenceEngine(pool: pg.Pool): PreferenceEngine {
  async function getPreferences(
    identityId: string,
    category?: Preference["category"]
  ): Promise<Preference[]> {
    let query = "SELECT * FROM preferences WHERE identity_id = $1"
    const params: unknown[] = [identityId]

    if (category) {
      query += " AND category = $2"
      params.push(category)
    }

    query += " ORDER BY confidence DESC"

    const result = await pool.query(query, params)

    return result.rows.map((row) => ({
      preference_id: row.preference_id,
      identity_id: row.identity_id,
      category: row.category,
      key: row.key,
      value: row.value,
      confidence: row.confidence,
      source: row.source,
      evidence_count: row.evidence_count,
      last_updated: row.last_updated,
    }))
  }

  async function getPreference(identityId: string, key: string): Promise<Preference | null> {
    const result = await pool.query(
      "SELECT * FROM preferences WHERE identity_id = $1 AND key = $2",
      [identityId, key]
    )

    if (result.rows.length === 0) return null

    const row = result.rows[0]
    return {
      preference_id: row.preference_id,
      identity_id: row.identity_id,
      category: row.category,
      key: row.key,
      value: row.value,
      confidence: row.confidence,
      source: row.source,
      evidence_count: row.evidence_count,
      last_updated: row.last_updated,
    }
  }

  async function setPreference(
    preference: Omit<Preference, "preference_id" | "last_updated">
  ): Promise<Preference> {
    const fullPreference: Preference = {
      ...preference,
      preference_id: crypto.randomUUID(),
      last_updated: new Date().toISOString(),
    }

    await pool.query(
      `INSERT INTO preferences (
        preference_id, identity_id, category, key, value,
        confidence, source, evidence_count, last_updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (identity_id, key) DO UPDATE SET
        value = EXCLUDED.value,
        confidence = EXCLUDED.confidence,
        source = EXCLUDED.source,
        evidence_count = preferences.evidence_count + 1,
        last_updated = EXCLUDED.last_updated`,
      [
        fullPreference.preference_id,
        fullPreference.identity_id,
        fullPreference.category,
        fullPreference.key,
        JSON.stringify(fullPreference.value),
        fullPreference.confidence,
        fullPreference.source,
        fullPreference.evidence_count,
        fullPreference.last_updated,
      ]
    )

    return fullPreference
  }

  async function inferPreference(
    identityId: string,
    signal: PreferenceSignal
  ): Promise<Preference | null> {
    // Get existing preference if any
    const existing = await getPreference(identityId, signal.key)

    // Calculate new confidence based on signal type and existing evidence
    let newConfidence: number
    let newValue: unknown

    if (existing) {
      // Bayesian update of confidence
      const priorConfidence = existing.confidence
      const signalWeight = getSignalWeight(signal.signal_type)

      if (signal.signal_type === "explicit") {
        // Explicit signals override with high confidence
        newValue = signal.observed_value
        newConfidence = Math.max(signal.confidence, priorConfidence)
      } else if (signal.signal_type === "implicit_negative") {
        // Negative signals reduce confidence in current value
        newValue = existing.value
        newConfidence = priorConfidence * (1 - signalWeight * signal.confidence)
      } else {
        // Positive signals increase confidence
        if (JSON.stringify(existing.value) === JSON.stringify(signal.observed_value)) {
          newValue = existing.value
          newConfidence = Math.min(
            1,
            priorConfidence + signalWeight * signal.confidence * (1 - priorConfidence)
          )
        } else {
          // Conflicting evidence
          if (signal.confidence > priorConfidence) {
            newValue = signal.observed_value
            newConfidence = signal.confidence * signalWeight
          } else {
            newValue = existing.value
            newConfidence = priorConfidence * (1 - signalWeight * 0.2)
          }
        }
      }
    } else {
      // New preference
      newValue = signal.observed_value
      newConfidence = signal.confidence * getSignalWeight(signal.signal_type)
    }

    // Only persist if confidence is meaningful
    if (newConfidence < 0.3) return null

    return setPreference({
      identity_id: identityId,
      category: signal.category,
      key: signal.key,
      value: newValue,
      confidence: newConfidence,
      source: signal.signal_type === "explicit" ? "explicit" : "inferred",
      evidence_count: (existing?.evidence_count ?? 0) + 1,
    })
  }

  async function reconcilePreferences(identityId: string): Promise<ReconciliationResult> {
    const preferences = await getPreferences(identityId)

    let conflictsFound = 0
    let conflictsResolved = 0
    const preferencesUpdated: string[] = []

    // Group by category
    const byCategory = preferences.reduce(
      (acc, p) => {
        const category = p.category
        if (!acc[category]) acc[category] = []
        acc[category].push(p)
        return acc
      },
      {} as Record<string, Preference[]>
    )

    // Check for conflicts within categories
    for (const [_category, prefs] of Object.entries(byCategory)) {
      // Look for contradictory preferences
      for (let i = 0; i < prefs.length; i++) {
        for (let j = i + 1; j < prefs.length; j++) {
          if (arePreferencesConflicting(prefs[i], prefs[j])) {
            conflictsFound++

            // Resolve by keeping higher confidence
            const _winner = prefs[i].confidence > prefs[j].confidence ? prefs[i] : prefs[j]
            const loser = prefs[i].confidence > prefs[j].confidence ? prefs[j] : prefs[i]

            // Reduce loser's confidence
            await pool.query(
              "UPDATE preferences SET confidence = confidence * 0.5 WHERE preference_id = $1",
              [loser.preference_id]
            )

            preferencesUpdated.push(loser.key)
            conflictsResolved++
          }
        }
      }
    }

    return {
      conflicts_found: conflictsFound,
      conflicts_resolved: conflictsResolved,
      preferences_updated: preferencesUpdated,
    }
  }

  return {
    getPreferences,
    getPreference,
    setPreference,
    inferPreference,
    reconcilePreferences,
  }
}

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

function getSignalWeight(signalType: PreferenceSignal["signal_type"]): number {
  switch (signalType) {
    case "explicit":
      return 1.0
    case "implicit_positive":
      return 0.6
    case "implicit_negative":
      return 0.5
    case "behavioral":
      return 0.4
    default:
      return 0.3
  }
}

function arePreferencesConflicting(pref1: Preference, pref2: Preference): boolean {
  // Check for direct conflicts in related preference keys
  const conflictingPairs = [
    ["verbose_output", "concise_output"],
    ["proactive_suggestions", "wait_for_instructions"],
    ["detailed_explanations", "brief_responses"],
    ["high_autonomy", "low_autonomy"],
    ["risk_averse", "risk_tolerant"],
  ]

  for (const [a, b] of conflictingPairs) {
    if (
      (pref1.key.includes(a) && pref2.key.includes(b)) ||
      (pref1.key.includes(b) && pref2.key.includes(a))
    ) {
      return true
    }
  }

  return false
}

// -----------------------------------------------------------------------------
// Preference Learning Patterns
// -----------------------------------------------------------------------------

export interface LearningPattern {
  pattern_id: string
  pattern_type: "correction" | "acceptance" | "modification" | "rejection"
  signals: PreferenceSignal[]
  inferred_preference: Partial<Preference>
  confidence: number
}

export function detectLearningPatterns(signals: PreferenceSignal[]): LearningPattern[] {
  const patterns: LearningPattern[] = []

  // Group signals by key
  const signalsByKey = signals.reduce(
    (acc, s) => {
      if (!acc[s.key]) acc[s.key] = []
      acc[s.key].push(s)
      return acc
    },
    {} as Record<string, PreferenceSignal[]>
  )

  for (const [key, keySignals] of Object.entries(signalsByKey)) {
    if (keySignals.length < 2) continue

    // Look for correction patterns (negative followed by explicit)
    for (let i = 0; i < keySignals.length - 1; i++) {
      if (
        keySignals[i].signal_type === "implicit_negative" &&
        keySignals[i + 1].signal_type === "explicit"
      ) {
        patterns.push({
          pattern_id: crypto.randomUUID(),
          pattern_type: "correction",
          signals: [keySignals[i], keySignals[i + 1]],
          inferred_preference: {
            key,
            value: keySignals[i + 1].observed_value,
            source: "explicit",
          },
          confidence: 0.9,
        })
      }
    }

    // Look for consistency patterns (multiple positive signals)
    const positiveSignals = keySignals.filter((s) => s.signal_type === "implicit_positive")
    if (positiveSignals.length >= 3) {
      const mostCommonValue = getMostCommonValue(positiveSignals.map((s) => s.observed_value))
      patterns.push({
        pattern_id: crypto.randomUUID(),
        pattern_type: "acceptance",
        signals: positiveSignals,
        inferred_preference: {
          key,
          value: mostCommonValue,
          source: "inferred",
        },
        confidence: Math.min(positiveSignals.length * 0.2, 0.8),
      })
    }
  }

  return patterns
}

function getMostCommonValue(values: unknown[]): unknown {
  const counts = new Map<string, { value: unknown; count: number }>()

  for (const value of values) {
    const key = JSON.stringify(value)
    const existing = counts.get(key)
    if (existing) {
      existing.count++
    } else {
      counts.set(key, { value, count: 1 })
    }
  }

  let maxCount = 0
  let mostCommon: unknown = values[0]

  for (const { value, count } of counts.values()) {
    if (count > maxCount) {
      maxCount = count
      mostCommon = value
    }
  }

  return mostCommon
}
