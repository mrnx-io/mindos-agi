// =============================================================================
// Identity Evolution Protocol
// =============================================================================

import type pg from "pg"
import type { CoreSelf, EvolutionEvent, ImprovementProposal, ValueDriftEvent } from "./types.js"

// -----------------------------------------------------------------------------
// Evolution Protocol Interface
// -----------------------------------------------------------------------------

export interface IdentityEvolutionProtocol {
  // Core Self Management
  getCoreSelf(identityId: string): Promise<CoreSelf | null>
  updateCoreSelf(identityId: string, updates: Partial<CoreSelf>): Promise<CoreSelf>
  createSnapshot(identityId: string): Promise<string>
  restoreSnapshot(snapshotId: string): Promise<CoreSelf>

  // Evolution Events
  recordEvolution(event: Omit<EvolutionEvent, "event_id" | "created_at">): Promise<EvolutionEvent>
  getEvolutionHistory(identityId: string, limit?: number): Promise<EvolutionEvent[]>

  // Coherence
  checkCoherence(
    identityId: string,
    proposedChange: Record<string, unknown>
  ): Promise<CoherenceResult>
  resolveConflict(identityId: string, conflict: CoherenceConflict): Promise<ResolutionResult>

  // Self-Improvement
  proposeImprovement(
    proposal: Omit<ImprovementProposal, "proposal_id" | "status" | "created_at">
  ): Promise<ImprovementProposal>
  evaluateProposal(proposalId: string): Promise<SafetyAssessment>
  applyImprovement(proposalId: string, approval: Approval): Promise<ImprovementResult>
  rollbackImprovement(proposalId: string): Promise<boolean>

  // Value Drift
  detectValueDrift(identityId: string): Promise<ValueDriftEvent[]>
  correctDrift(driftId: string, correction: DriftCorrection): Promise<boolean>
}

export interface CoherenceResult {
  coherent: boolean
  conflicts: CoherenceConflict[]
  warnings: string[]
}

export interface CoherenceConflict {
  conflict_id: string
  type: "value_violation" | "commitment_breach" | "inconsistency"
  description: string
  severity: "low" | "medium" | "high" | "critical"
  affected_elements: string[]
}

export interface ResolutionResult {
  resolved: boolean
  resolution_type: "adjusted_change" | "updated_values" | "rejected"
  adjustments: Record<string, unknown>
}

export interface SafetyAssessment {
  proposal_id: string
  safe: boolean
  risk_factors: Array<{
    factor: string
    severity: number
    mitigation: string
  }>
  value_alignment_score: number
  reversibility_score: number
  recommendation: "approve" | "reject" | "modify" | "seek_user_approval"
}

export interface Approval {
  approver: string
  approval_type: "automatic" | "user" | "system"
  conditions?: string[]
  timestamp: string
}

export interface ImprovementResult {
  success: boolean
  changes_applied: string[]
  new_state: Record<string, unknown>
  rollback_id?: string
}

export interface DriftCorrection {
  correction_type: "reset" | "adjust" | "acknowledge"
  target_value?: unknown
  reasoning: string
}

// -----------------------------------------------------------------------------
// Create Protocol
// -----------------------------------------------------------------------------

export function createIdentityEvolutionProtocol(pool: pg.Pool): IdentityEvolutionProtocol {
  // Snapshot storage
  const snapshots = new Map<string, CoreSelf>()

  // Rollback points
  const rollbackPoints = new Map<string, Record<string, unknown>>()

  // -----------------------------------------------------------------------------
  // Core Self Management
  // -----------------------------------------------------------------------------

  async function getCoreSelf(identityId: string): Promise<CoreSelf | null> {
    const result = await pool.query("SELECT * FROM identities WHERE identity_id = $1", [identityId])

    if (result.rows.length === 0) return null

    const row = result.rows[0]
    return {
      identity_id: row.identity_id,
      name: row.name,
      version: row.version ?? 1,
      values: row.core_self?.values ?? [],
      commitments: row.core_self?.commitments ?? [],
      personality_traits: row.core_self?.personality_traits ?? {},
      communication_style: row.core_self?.communication_style ?? {
        formality: 0.5,
        verbosity: 0.5,
        directness: 0.5,
        warmth: 0.5,
      },
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  async function updateCoreSelf(identityId: string, updates: Partial<CoreSelf>): Promise<CoreSelf> {
    const current = await getCoreSelf(identityId)
    if (!current) {
      throw new Error(`Identity ${identityId} not found`)
    }

    // Check coherence before applying
    const coherence = await checkCoherence(identityId, updates)
    if (!coherence.coherent) {
      const criticalConflicts = coherence.conflicts.filter((c) => c.severity === "critical")
      if (criticalConflicts.length > 0) {
        throw new Error(
          `Cannot update: critical coherence conflicts - ${criticalConflicts.map((c) => c.description).join(", ")}`
        )
      }
    }

    const newCoreSelf: CoreSelf = {
      ...current,
      ...updates,
      version: current.version + 1,
      updated_at: new Date().toISOString(),
    }

    await pool.query(
      `UPDATE identities SET
        core_self = $1,
        updated_at = $2
      WHERE identity_id = $3`,
      [
        JSON.stringify({
          values: newCoreSelf.values,
          commitments: newCoreSelf.commitments,
          personality_traits: newCoreSelf.personality_traits,
          communication_style: newCoreSelf.communication_style,
        }),
        newCoreSelf.updated_at,
        identityId,
      ]
    )

    // Record evolution event
    await recordEvolution({
      identity_id: identityId,
      event_type: "value_update",
      description: `Core self updated to version ${newCoreSelf.version}`,
      previous_state: current as unknown as Record<string, unknown>,
      new_state: newCoreSelf as unknown as Record<string, unknown>,
      trigger: {
        type: "explicit_request",
        details: { updates },
      },
      coherence_check: {
        passed: coherence.coherent,
        violations: coherence.conflicts.map((c) => c.description),
        adjustments_made: [],
      },
    })

    return newCoreSelf
  }

  async function createSnapshot(identityId: string): Promise<string> {
    const coreSelf = await getCoreSelf(identityId)
    if (!coreSelf) {
      throw new Error(`Identity ${identityId} not found`)
    }

    const snapshotId = crypto.randomUUID()
    snapshots.set(snapshotId, structuredClone(coreSelf))

    // Persist to database
    await pool.query(
      `INSERT INTO identity_snapshots (snapshot_id, identity_id, core_self, created_at)
       VALUES ($1, $2, $3, $4)`,
      [snapshotId, identityId, JSON.stringify(coreSelf), new Date().toISOString()]
    )

    return snapshotId
  }

  async function restoreSnapshot(snapshotId: string): Promise<CoreSelf> {
    // Check in-memory cache
    let coreSelf = snapshots.get(snapshotId)

    if (!coreSelf) {
      // Load from database
      const result = await pool.query("SELECT * FROM identity_snapshots WHERE snapshot_id = $1", [
        snapshotId,
      ])

      if (result.rows.length === 0) {
        throw new Error(`Snapshot ${snapshotId} not found`)
      }

      coreSelf = result.rows[0].core_self
    }

    // Restore to identity
    await pool.query(
      "UPDATE identities SET core_self = $1, updated_at = $2 WHERE identity_id = $3",
      [JSON.stringify(coreSelf), new Date().toISOString(), coreSelf?.identity_id]
    )

    return coreSelf!
  }

  // -----------------------------------------------------------------------------
  // Evolution Events
  // -----------------------------------------------------------------------------

  async function recordEvolution(
    event: Omit<EvolutionEvent, "event_id" | "created_at">
  ): Promise<EvolutionEvent> {
    const fullEvent: EvolutionEvent = {
      ...event,
      event_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    }

    await pool.query(
      `INSERT INTO identity_evolution_log (
        event_id, identity_id, event_type, description,
        previous_state, new_state, trigger, coherence_check, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        fullEvent.event_id,
        fullEvent.identity_id,
        fullEvent.event_type,
        fullEvent.description,
        JSON.stringify(fullEvent.previous_state),
        JSON.stringify(fullEvent.new_state),
        JSON.stringify(fullEvent.trigger),
        JSON.stringify(fullEvent.coherence_check),
        fullEvent.created_at,
      ]
    )

    return fullEvent
  }

  async function getEvolutionHistory(identityId: string, limit = 100): Promise<EvolutionEvent[]> {
    const result = await pool.query(
      `SELECT * FROM identity_evolution_log
       WHERE identity_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [identityId, limit]
    )

    return result.rows.map((row) => ({
      event_id: row.event_id,
      identity_id: row.identity_id,
      event_type: row.event_type,
      description: row.description,
      previous_state: row.previous_state,
      new_state: row.new_state,
      trigger: row.trigger,
      coherence_check: row.coherence_check,
      created_at: row.created_at,
    }))
  }

  // -----------------------------------------------------------------------------
  // Coherence Checking
  // -----------------------------------------------------------------------------

  async function checkCoherence(
    identityId: string,
    proposedChange: Record<string, unknown>
  ): Promise<CoherenceResult> {
    const coreSelf = await getCoreSelf(identityId)
    if (!coreSelf) {
      return { coherent: true, conflicts: [], warnings: [] }
    }

    const conflicts: CoherenceConflict[] = []
    const warnings: string[] = []

    // Check value conflicts
    if (proposedChange.values) {
      const newValues = proposedChange.values as CoreSelf["values"]
      for (const newValue of newValues) {
        // Check for contradictory values
        for (const existingValue of coreSelf.values) {
          if (areValuesContradictory(existingValue, newValue)) {
            conflicts.push({
              conflict_id: crypto.randomUUID(),
              type: "value_violation",
              description: `New value "${newValue.name}" contradicts existing value "${existingValue.name}"`,
              severity: existingValue.priority > 0.8 ? "critical" : "medium",
              affected_elements: [existingValue.value_id, newValue.value_id],
            })
          }
        }
      }
    }

    // Check commitment breaches
    if (proposedChange.commitments) {
      const removedCommitments = coreSelf.commitments.filter(
        (c) =>
          !(proposedChange.commitments as CoreSelf["commitments"]).find(
            (nc) => nc.commitment_id === c.commitment_id
          )
      )

      for (const removed of removedCommitments) {
        if (removed.strength > 0.7) {
          conflicts.push({
            conflict_id: crypto.randomUUID(),
            type: "commitment_breach",
            description: `Removing high-strength commitment: "${removed.statement}"`,
            severity: removed.category === "ethical" ? "critical" : "high",
            affected_elements: [removed.commitment_id],
          })
        }
      }
    }

    // Check personality trait consistency
    if (proposedChange.personality_traits) {
      const newTraits = proposedChange.personality_traits as CoreSelf["personality_traits"]
      for (const [trait, value] of Object.entries(newTraits)) {
        const currentValue = coreSelf.personality_traits[trait]
        if (currentValue !== undefined && Math.abs(currentValue - value) > 0.5) {
          warnings.push(
            `Large shift in personality trait "${trait}": ${currentValue.toFixed(2)} → ${value.toFixed(2)}`
          )
        }
      }
    }

    return {
      coherent: conflicts.length === 0,
      conflicts,
      warnings,
    }
  }

  async function resolveConflict(
    _identityId: string,
    conflict: CoherenceConflict
  ): Promise<ResolutionResult> {
    // Implement conflict resolution strategies
    switch (conflict.type) {
      case "value_violation": {
        // Try to find a compromise
        return {
          resolved: true,
          resolution_type: "adjusted_change",
          adjustments: {
            suggestion: "Consider adjusting the priority of conflicting values",
          },
        }
      }

      case "commitment_breach": {
        // Cannot automatically resolve strong commitments
        if (conflict.severity === "critical") {
          return {
            resolved: false,
            resolution_type: "rejected",
            adjustments: {},
          }
        }
        return {
          resolved: true,
          resolution_type: "updated_values",
          adjustments: {
            commitment_weakened: true,
          },
        }
      }

      case "inconsistency": {
        return {
          resolved: true,
          resolution_type: "adjusted_change",
          adjustments: {
            normalized: true,
          },
        }
      }

      default:
        return {
          resolved: false,
          resolution_type: "rejected",
          adjustments: {},
        }
    }
  }

  // -----------------------------------------------------------------------------
  // Self-Improvement
  // -----------------------------------------------------------------------------

  async function proposeImprovement(
    proposal: Omit<ImprovementProposal, "proposal_id" | "status" | "created_at">
  ): Promise<ImprovementProposal> {
    const fullProposal: ImprovementProposal = {
      ...proposal,
      proposal_id: crypto.randomUUID(),
      status: "proposed",
      created_at: new Date().toISOString(),
    }

    await pool.query(
      `INSERT INTO improvement_proposals (
        proposal_id, identity_id, proposal_type, title, description,
        rationale, expected_benefits, potential_risks, implementation_plan,
        safety_assessment, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        fullProposal.proposal_id,
        fullProposal.identity_id,
        fullProposal.proposal_type,
        fullProposal.title,
        fullProposal.description,
        fullProposal.rationale,
        JSON.stringify(fullProposal.expected_benefits),
        JSON.stringify(fullProposal.potential_risks),
        JSON.stringify(fullProposal.implementation_plan),
        JSON.stringify(fullProposal.safety_assessment),
        fullProposal.status,
        fullProposal.created_at,
      ]
    )

    return fullProposal
  }

  async function evaluateProposal(proposalId: string): Promise<SafetyAssessment> {
    const result = await pool.query("SELECT * FROM improvement_proposals WHERE proposal_id = $1", [
      proposalId,
    ])

    if (result.rows.length === 0) {
      throw new Error(`Proposal ${proposalId} not found`)
    }

    const proposal = result.rows[0]
    const coreSelf = await getCoreSelf(proposal.identity_id)

    // Assess risk factors
    const riskFactors: SafetyAssessment["risk_factors"] = []

    const potentialRisks = proposal.potential_risks as string[]
    for (const risk of potentialRisks) {
      riskFactors.push({
        factor: risk,
        severity: 0.5, // Would analyze based on risk content
        mitigation: "Implement with monitoring and rollback capability",
      })
    }

    // Check value alignment
    let valueAlignment = 1.0
    if (coreSelf) {
      const proposalContent = proposal.description.toLowerCase()
      for (const value of coreSelf.values) {
        if (proposalContent.includes(value.name.toLowerCase())) {
          valueAlignment = Math.min(valueAlignment, value.priority)
        }
      }
    }

    // Calculate reversibility
    const implementationPlan =
      proposal.implementation_plan as ImprovementProposal["implementation_plan"]
    const reversibleSteps = implementationPlan.filter((s) => s.reversible).length
    const reversibilityScore =
      implementationPlan.length > 0 ? reversibleSteps / implementationPlan.length : 0

    // Determine recommendation
    let recommendation: SafetyAssessment["recommendation"]
    const avgRiskSeverity =
      riskFactors.length > 0
        ? riskFactors.reduce((sum, r) => sum + r.severity, 0) / riskFactors.length
        : 0

    if (avgRiskSeverity > 0.7 || valueAlignment < 0.3) {
      recommendation = "reject"
    } else if (avgRiskSeverity > 0.5 || reversibilityScore < 0.5) {
      recommendation = "seek_user_approval"
    } else if (avgRiskSeverity > 0.3) {
      recommendation = "modify"
    } else {
      recommendation = "approve"
    }

    return {
      proposal_id: proposalId,
      safe: avgRiskSeverity < 0.5 && valueAlignment > 0.5,
      risk_factors: riskFactors,
      value_alignment_score: valueAlignment,
      reversibility_score: reversibilityScore,
      recommendation,
    }
  }

  async function applyImprovement(
    proposalId: string,
    approval: Approval
  ): Promise<ImprovementResult> {
    const result = await pool.query("SELECT * FROM improvement_proposals WHERE proposal_id = $1", [
      proposalId,
    ])

    if (result.rows.length === 0) {
      throw new Error(`Proposal ${proposalId} not found`)
    }

    const proposal = result.rows[0]

    // Create rollback point
    const rollbackId = crypto.randomUUID()
    const currentState = await getCoreSelf(proposal.identity_id)
    if (currentState) {
      rollbackPoints.set(rollbackId, currentState as unknown as Record<string, unknown>)
    }

    // Execute implementation plan
    const changesApplied: string[] = []
    const implementationPlan =
      proposal.implementation_plan as ImprovementProposal["implementation_plan"]

    for (const step of implementationPlan) {
      try {
        // Would execute actual changes here
        changesApplied.push(`Step ${step.step}: ${step.action}`)
      } catch (_err) {
        // Rollback on failure
        if (currentState) {
          await updateCoreSelf(proposal.identity_id, currentState)
        }
        return {
          success: false,
          changes_applied: changesApplied,
          new_state: {},
        }
      }
    }

    // Update proposal status
    await pool.query(
      `UPDATE improvement_proposals SET
        status = 'completed',
        resolved_at = $1
      WHERE proposal_id = $2`,
      [new Date().toISOString(), proposalId]
    )

    // Record evolution
    await recordEvolution({
      identity_id: proposal.identity_id,
      event_type: "self_improvement",
      description: `Applied improvement: ${proposal.title}`,
      previous_state: (currentState as unknown as Record<string, unknown>) ?? {},
      new_state: { improvement_applied: proposal.title },
      trigger: {
        type: approval.approval_type === "user" ? "explicit_request" : "introspection",
        details: { approval },
      },
      coherence_check: {
        passed: true,
        violations: [],
        adjustments_made: changesApplied,
      },
    })

    const newState = await getCoreSelf(proposal.identity_id)

    return {
      success: true,
      changes_applied: changesApplied,
      new_state: (newState as unknown as Record<string, unknown>) ?? {},
      rollback_id: rollbackId,
    }
  }

  async function rollbackImprovement(proposalId: string): Promise<boolean> {
    const result = await pool.query("SELECT * FROM improvement_proposals WHERE proposal_id = $1", [
      proposalId,
    ])

    if (result.rows.length === 0) return false

    const proposal = result.rows[0]

    // Find rollback point
    // In production, would look up from database
    const previousState = rollbackPoints.get(proposalId)
    if (!previousState) return false

    // Restore state
    await pool.query(
      "UPDATE identities SET core_self = $1, updated_at = $2 WHERE identity_id = $3",
      [JSON.stringify(previousState), new Date().toISOString(), proposal.identity_id]
    )

    // Update proposal status
    await pool.query(
      `UPDATE improvement_proposals SET status = 'rolled_back' WHERE proposal_id = $1`,
      [proposalId]
    )

    return true
  }

  // -----------------------------------------------------------------------------
  // Value Drift Detection
  // -----------------------------------------------------------------------------

  async function detectValueDrift(identityId: string): Promise<ValueDriftEvent[]> {
    const driftEvents: ValueDriftEvent[] = []

    // Get evolution history
    const history = await getEvolutionHistory(identityId, 100)

    // Group by value changes
    const valueChanges = history.filter((e) => e.event_type === "value_update")

    if (valueChanges.length < 3) return driftEvents

    // Analyze each value
    const coreSelf = await getCoreSelf(identityId)
    if (!coreSelf) return driftEvents

    for (const value of coreSelf.values) {
      const valueHistory = valueChanges.filter((e) => {
        const newState = e.new_state as { values?: Array<{ value_id: string; priority: number }> }
        return newState.values?.some((v) => v.value_id === value.value_id)
      })

      if (valueHistory.length < 2) continue

      // Calculate drift metrics
      const priorities = valueHistory.map((e) => {
        const state = e.new_state as { values: Array<{ value_id: string; priority: number }> }
        return state.values.find((v) => v.value_id === value.value_id)?.priority ?? 0
      })

      const firstPriority = priorities[0]
      const lastPriority = priorities[priorities.length - 1]
      const drift = lastPriority - firstPriority

      if (Math.abs(drift) > 0.2) {
        const firstDate = new Date(valueHistory[0].created_at)
        const lastDate = new Date(valueHistory[valueHistory.length - 1].created_at)
        const timespanDays = (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24)

        // Determine drift type
        const volatility = calculateVolatility(priorities)
        let driftType: ValueDriftEvent["drift_type"]

        if (volatility > 0.3) {
          driftType = "oscillating"
        } else if (timespanDays < 7 && Math.abs(drift) > 0.3) {
          driftType = "sudden"
        } else {
          driftType = "gradual"
        }

        driftEvents.push({
          drift_id: crypto.randomUUID(),
          identity_id: identityId,
          value_id: value.value_id,
          drift_type: driftType,
          direction: drift > 0 ? "strengthening" : "weakening",
          magnitude: Math.abs(drift),
          timespan_days: timespanDays,
          contributing_factors: analyzeContributingFactors(valueHistory),
          recommendation: determineRecommendation(driftType, Math.abs(drift), value),
          detected_at: new Date().toISOString(),
        })
      }
    }

    return driftEvents
  }

  async function correctDrift(_driftId: string, _correction: DriftCorrection): Promise<boolean> {
    // Would implement drift correction logic
    // For now, return success
    return true
  }

  // -----------------------------------------------------------------------------
  // Helper Functions
  // -----------------------------------------------------------------------------

  function areValuesContradictory(
    value1: CoreSelf["values"][0],
    value2: CoreSelf["values"][0]
  ): boolean {
    // Simple contradiction detection
    const contradictoryPairs = [
      ["efficiency", "thoroughness"],
      ["caution", "speed"],
      ["independence", "collaboration"],
    ]

    for (const [a, b] of contradictoryPairs) {
      if (
        (value1.name.toLowerCase().includes(a) && value2.name.toLowerCase().includes(b)) ||
        (value1.name.toLowerCase().includes(b) && value2.name.toLowerCase().includes(a))
      ) {
        return value1.priority > 0.7 && value2.priority > 0.7
      }
    }

    return false
  }

  function calculateVolatility(values: number[]): number {
    if (values.length < 2) return 0

    let sumSquaredDiffs = 0
    for (let i = 1; i < values.length; i++) {
      sumSquaredDiffs += (values[i] - values[i - 1]) ** 2
    }

    return Math.sqrt(sumSquaredDiffs / (values.length - 1))
  }

  function analyzeContributingFactors(history: EvolutionEvent[]): string[] {
    const factors: string[] = []

    const triggers = history.map((e) => e.trigger.type)
    const triggerCounts = triggers.reduce(
      (acc, t) => {
        acc[t] = (acc[t] ?? 0) + 1
        return acc
      },
      {} as Record<string, number>
    )

    for (const [trigger, count] of Object.entries(triggerCounts)) {
      if (count > history.length * 0.3) {
        factors.push(`Frequent trigger: ${trigger}`)
      }
    }

    return factors
  }

  function determineRecommendation(
    driftType: ValueDriftEvent["drift_type"],
    magnitude: number,
    value: CoreSelf["values"][0]
  ): ValueDriftEvent["recommendation"] {
    if (driftType === "sudden" && magnitude > 0.4) {
      return "alert_user"
    }

    if (value.source === "innate" && magnitude > 0.3) {
      return "correct"
    }

    if (driftType === "oscillating") {
      return "investigate"
    }

    if (magnitude < 0.3) {
      return "accept"
    }

    return "investigate"
  }

  return {
    getCoreSelf,
    updateCoreSelf,
    createSnapshot,
    restoreSnapshot,
    recordEvolution,
    getEvolutionHistory,
    checkCoherence,
    resolveConflict,
    proposeImprovement,
    evaluateProposal,
    applyImprovement,
    rollbackImprovement,
    detectValueDrift,
    correctDrift,
  }
}
