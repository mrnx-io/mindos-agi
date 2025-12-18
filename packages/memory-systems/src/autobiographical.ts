// =============================================================================
// Autobiographical Memory System
// =============================================================================

import type pg from "pg"
import type { IdentityNarrative, LifeEvent } from "./types.js"

// -----------------------------------------------------------------------------
// Autobiographical Memory Interface
// -----------------------------------------------------------------------------

export interface AutobiographicalMemory {
  recordLifeEvent(input: RecordLifeEventInput): Promise<LifeEvent>
  getLifeEvent(eventId: string): Promise<LifeEvent | null>
  getLifeHistory(identityId: string): Promise<LifeEvent[]>
  getCurrentNarrative(identityId: string): Promise<IdentityNarrative | null>
  updateNarrative(identityId: string): Promise<IdentityNarrative>
  reflectOnPeriod(identityId: string, start: string, end: string): Promise<PeriodReflection>
  getSignificantEvents(identityId: string, minSignificance: number): Promise<LifeEvent[]>
}

export interface RecordLifeEventInput {
  identity_id: string
  event_type: LifeEvent["event_type"]
  title: string
  narrative: string
  significance: number
  related_episodes?: string[]
  impact_on_identity?: Record<string, unknown>
}

export interface PeriodReflection {
  period_start: string
  period_end: string
  key_events: LifeEvent[]
  themes: string[]
  growth_areas: string[]
  challenges: string[]
  overall_sentiment: number
}

// -----------------------------------------------------------------------------
// Create Autobiographical Memory
// -----------------------------------------------------------------------------

export function createAutobiographicalMemory(pool: pg.Pool): AutobiographicalMemory {
  async function recordLifeEvent(input: RecordLifeEventInput): Promise<LifeEvent> {
    const event: LifeEvent = {
      event_id: crypto.randomUUID(),
      identity_id: input.identity_id,
      event_type: input.event_type,
      title: input.title,
      narrative: input.narrative,
      significance: input.significance,
      related_episodes: input.related_episodes ?? [],
      impact_on_identity: input.impact_on_identity,
      timestamp: new Date().toISOString(),
    }

    await pool.query(
      `INSERT INTO life_events (
        event_id, identity_id, event_type, title, narrative,
        significance, related_episodes, impact_on_identity, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.event_id,
        event.identity_id,
        event.event_type,
        event.title,
        event.narrative,
        event.significance,
        JSON.stringify(event.related_episodes),
        JSON.stringify(event.impact_on_identity),
        event.timestamp,
      ]
    )

    // Trigger narrative update for significant events
    if (event.significance >= 0.7) {
      updateNarrative(input.identity_id).catch(console.error)
    }

    return event
  }

  async function getLifeEvent(eventId: string): Promise<LifeEvent | null> {
    const result = await pool.query("SELECT * FROM life_events WHERE event_id = $1", [eventId])

    if (result.rows.length === 0) return null

    return rowToLifeEvent(result.rows[0])
  }

  async function getLifeHistory(identityId: string): Promise<LifeEvent[]> {
    const result = await pool.query(
      `SELECT * FROM life_events
       WHERE identity_id = $1
       ORDER BY timestamp ASC`,
      [identityId]
    )

    return result.rows.map(rowToLifeEvent)
  }

  async function getCurrentNarrative(identityId: string): Promise<IdentityNarrative | null> {
    const result = await pool.query(
      `SELECT * FROM identity_narratives
       WHERE identity_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [identityId]
    )

    if (result.rows.length === 0) return null

    return rowToNarrative(result.rows[0])
  }

  async function updateNarrative(identityId: string): Promise<IdentityNarrative> {
    // Get current narrative version
    const currentNarrative = await getCurrentNarrative(identityId)
    const newVersion = (currentNarrative?.version ?? 0) + 1

    // Get life history
    const lifeHistory = await getLifeHistory(identityId)

    // Get identity info
    const identityResult = await pool.query("SELECT * FROM identities WHERE identity_id = $1", [
      identityId,
    ])

    const identity = identityResult.rows[0]

    // Extract themes from life events
    const themes = extractThemes(lifeHistory)

    // Build core narrative
    const coreNarrative = buildCoreNarrative(identity, lifeHistory)

    // Extract values from identity and history
    const values = extractValues(identity, lifeHistory)

    // Extract goals
    const goals = extractGoals(identity, lifeHistory)

    const narrative: IdentityNarrative = {
      narrative_id: crypto.randomUUID(),
      identity_id: identityId,
      version: newVersion,
      core_narrative: coreNarrative,
      key_themes: themes,
      life_events: lifeHistory.map((e) => e.event_id),
      self_concept: identity?.core_self ?? {},
      values,
      goals,
      created_at: new Date().toISOString(),
    }

    await pool.query(
      `INSERT INTO identity_narratives (
        narrative_id, identity_id, version, core_narrative,
        key_themes, life_events, self_concept, values, goals, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        narrative.narrative_id,
        narrative.identity_id,
        narrative.version,
        narrative.core_narrative,
        JSON.stringify(narrative.key_themes),
        JSON.stringify(narrative.life_events),
        JSON.stringify(narrative.self_concept),
        JSON.stringify(narrative.values),
        JSON.stringify(narrative.goals),
        narrative.created_at,
      ]
    )

    return narrative
  }

  async function reflectOnPeriod(
    identityId: string,
    start: string,
    end: string
  ): Promise<PeriodReflection> {
    const result = await pool.query(
      `SELECT * FROM life_events
       WHERE identity_id = $1 AND timestamp >= $2 AND timestamp <= $3
       ORDER BY timestamp ASC`,
      [identityId, start, end]
    )

    const events = result.rows.map(rowToLifeEvent)
    const keyEvents = events.filter((e) => e.significance >= 0.6)

    // Extract themes
    const themeCounts = new Map<string, number>()

    for (const event of events) {
      const eventThemes = extractEventThemes(event)
      for (const theme of eventThemes) {
        themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1)
      }
    }

    const sortedThemes = [...themeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([theme]) => theme)

    // Identify growth areas
    const growthAreas = events
      .filter((e) => e.event_type === "capability_gain" || e.event_type === "lesson_learned")
      .map((e) => e.title)

    // Identify challenges
    const challenges = events.filter((e) => e.event_type === "turning_point").map((e) => e.title)

    // Calculate sentiment
    const sentiments = events.map((e) => {
      switch (e.event_type) {
        case "milestone":
        case "capability_gain":
          return 1
        case "lesson_learned":
          return 0.5
        case "turning_point":
          return 0
        case "value_shift":
        case "relationship_change":
          return 0.3
        default:
          return 0.5
      }
    })

    const overallSentiment =
      sentiments.length > 0
        ? (sentiments as number[]).reduce((a, b) => a + b, 0) / sentiments.length
        : 0.5

    return {
      period_start: start,
      period_end: end,
      key_events: keyEvents,
      themes: sortedThemes,
      growth_areas: growthAreas,
      challenges,
      overall_sentiment: overallSentiment,
    }
  }

  async function getSignificantEvents(
    identityId: string,
    minSignificance: number
  ): Promise<LifeEvent[]> {
    const result = await pool.query(
      `SELECT * FROM life_events
       WHERE identity_id = $1 AND significance >= $2
       ORDER BY significance DESC, timestamp DESC`,
      [identityId, minSignificance]
    )

    return result.rows.map(rowToLifeEvent)
  }

  return {
    recordLifeEvent,
    getLifeEvent,
    getLifeHistory,
    getCurrentNarrative,
    updateNarrative,
    reflectOnPeriod,
    getSignificantEvents,
  }
}

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

function rowToLifeEvent(row: Record<string, unknown>): LifeEvent {
  return {
    event_id: row.event_id as string,
    identity_id: row.identity_id as string,
    event_type: row.event_type as LifeEvent["event_type"],
    title: row.title as string,
    narrative: row.narrative as string,
    significance: row.significance as number,
    related_episodes: (row.related_episodes as string[]) ?? [],
    impact_on_identity: row.impact_on_identity as Record<string, unknown> | undefined,
    timestamp: row.timestamp as string,
  }
}

function rowToNarrative(row: Record<string, unknown>): IdentityNarrative {
  return {
    narrative_id: row.narrative_id as string,
    identity_id: row.identity_id as string,
    version: row.version as number,
    core_narrative: row.core_narrative as string,
    key_themes: (row.key_themes as string[]) ?? [],
    life_events: (row.life_events as string[]) ?? [],
    self_concept: (row.self_concept as Record<string, unknown>) ?? {},
    values: (row.values as string[]) ?? [],
    goals: (row.goals as string[]) ?? [],
    created_at: row.created_at as string,
  }
}

function extractThemes(events: LifeEvent[]): string[] {
  const themes = new Map<string, number>()

  for (const event of events) {
    const eventThemes = extractEventThemes(event)
    for (const theme of eventThemes) {
      themes.set(theme, (themes.get(theme) ?? 0) + event.significance)
    }
  }

  return [...themes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([theme]) => theme)
}

function extractEventThemes(event: LifeEvent): string[] {
  const themes: string[] = []

  // Extract from event type
  themes.push(event.event_type.replace("_", " "))

  // Extract keywords from narrative
  const keywords = event.narrative
    .toLowerCase()
    .split(/\s+/)
    .filter((w: string) => w.length > 5)

  const keywordCounts = new Map<string, number>()
  for (const keyword of keywords) {
    keywordCounts.set(keyword, (keywordCounts.get(keyword) ?? 0) + 1)
  }

  const topKeywords = [...keywordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word]) => word)

  themes.push(...topKeywords)

  return themes
}

function buildCoreNarrative(
  identity: Record<string, unknown> | undefined,
  events: LifeEvent[]
): string {
  if (!identity) {
    return "An emerging identity, building understanding through experience."
  }

  const milestones = events.filter((e) => e.event_type === "milestone")
  const lessons = events.filter((e) => e.event_type === "lesson_learned")
  const capabilities = events.filter((e) => e.event_type === "capability_gain")

  let narrative = `A persistent intelligence with ${events.length} recorded experiences.`

  if (milestones.length > 0) {
    narrative += ` Achieved ${milestones.length} milestones.`
  }

  if (lessons.length > 0) {
    narrative += ` Learned ${lessons.length} important lessons.`
  }

  if (capabilities.length > 0) {
    narrative += ` Developed ${capabilities.length} new capabilities.`
  }

  return narrative
}

function extractValues(
  identity: Record<string, unknown> | undefined,
  events: LifeEvent[]
): string[] {
  const values: string[] = []

  // From identity core_self
  if (identity?.core_self) {
    const coreSelf = identity.core_self as Record<string, unknown>
    if (coreSelf.values && Array.isArray(coreSelf.values)) {
      values.push(...(coreSelf.values as string[]))
    }
  }

  // From value shift events
  const valueShifts = events.filter((e) => e.event_type === "value_shift")
  for (const shift of valueShifts) {
    if (shift.impact_on_identity?.new_value) {
      values.push(shift.impact_on_identity.new_value as string)
    }
  }

  return [...new Set(values)]
}

function extractGoals(
  identity: Record<string, unknown> | undefined,
  events: LifeEvent[]
): string[] {
  const goals: string[] = []

  // From identity
  if (identity?.goals && Array.isArray(identity.goals)) {
    goals.push(...(identity.goals as string[]))
  }

  // Infer from recent milestone events
  const recentMilestones = events.filter((e) => e.event_type === "milestone").slice(-5)

  for (const milestone of recentMilestones) {
    if (milestone.impact_on_identity?.next_goal) {
      goals.push(milestone.impact_on_identity.next_goal as string)
    }
  }

  return [...new Set(goals)]
}
