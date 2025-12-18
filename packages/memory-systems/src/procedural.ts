// =============================================================================
// Procedural Memory System
// =============================================================================

import type pg from "pg"
import type { Procedure } from "./types.js"

// -----------------------------------------------------------------------------
// Procedural Memory Interface
// -----------------------------------------------------------------------------

export interface ProceduralMemory {
  learn(input: LearnProcedureInput): Promise<Procedure>
  recall(procedureId: string): Promise<Procedure | null>
  findByTrigger(identityId: string, context: string): Promise<Procedure[]>
  execute(procedureId: string): Promise<ExecutionResult>
  recordOutcome(procedureId: string, success: boolean): Promise<void>
  refine(procedureId: string, refinement: ProcedureRefinement): Promise<Procedure>
  deprecate(procedureId: string): Promise<void>
  getBySuccessRate(identityId: string, minRate: number): Promise<Procedure[]>
}

export interface LearnProcedureInput {
  identity_id: string
  name: string
  description: string
  trigger_conditions: string[]
  steps: Procedure["steps"]
}

export interface ExecutionResult {
  procedure_id: string
  started_at: string
  completed_at: string
  success: boolean
  steps_completed: number
  error?: string
  outputs: Record<string, unknown>
}

export interface ProcedureRefinement {
  updated_steps?: Procedure["steps"]
  additional_triggers?: string[]
  removed_triggers?: string[]
}

// -----------------------------------------------------------------------------
// Create Procedural Memory
// -----------------------------------------------------------------------------

export function createProceduralMemory(pool: pg.Pool): ProceduralMemory {
  async function learn(input: LearnProcedureInput): Promise<Procedure> {
    const now = new Date().toISOString()

    const procedure: Procedure = {
      procedure_id: crypto.randomUUID(),
      identity_id: input.identity_id,
      name: input.name,
      description: input.description,
      trigger_conditions: input.trigger_conditions,
      steps: input.steps,
      success_rate: 0.5,
      execution_count: 0,
      created_at: now,
      updated_at: now,
    }

    await pool.query(
      `INSERT INTO procedures (
        procedure_id, identity_id, name, description,
        trigger_conditions, steps, success_rate,
        execution_count, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        procedure.procedure_id,
        procedure.identity_id,
        procedure.name,
        procedure.description,
        JSON.stringify(procedure.trigger_conditions),
        JSON.stringify(procedure.steps),
        procedure.success_rate,
        procedure.execution_count,
        procedure.created_at,
        procedure.updated_at,
      ]
    )

    return procedure
  }

  async function recall(procedureId: string): Promise<Procedure | null> {
    const result = await pool.query(
      `SELECT * FROM procedures WHERE procedure_id = $1 AND deprecated = false`,
      [procedureId]
    )

    if (result.rows.length === 0) return null

    return rowToProcedure(result.rows[0])
  }

  async function findByTrigger(
    identityId: string,
    context: string
  ): Promise<Procedure[]> {
    // Get all procedures for identity
    const result = await pool.query(
      `SELECT * FROM procedures
       WHERE identity_id = $1 AND deprecated = false
       ORDER BY success_rate DESC`,
      [identityId]
    )

    const contextLower = context.toLowerCase()

    // Filter by trigger conditions
    const matching = result.rows.filter((row) => {
      const triggers = row.trigger_conditions as string[]
      return triggers.some((trigger) =>
        contextLower.includes(trigger.toLowerCase())
      )
    })

    return matching.map(rowToProcedure)
  }

  async function execute(procedureId: string): Promise<ExecutionResult> {
    const procedure = await recall(procedureId)
    if (!procedure) {
      throw new Error(`Procedure ${procedureId} not found`)
    }

    const startedAt = new Date().toISOString()
    const outputs: Record<string, unknown> = {}
    let stepsCompleted = 0
    let success = true
    let error: string | undefined

    // Simulate step execution (actual execution would be external)
    for (const step of procedure.steps) {
      try {
        // In real implementation, this would dispatch to executor
        outputs[`step_${step.step_number}`] = {
          action: step.action,
          status: "completed",
        }
        stepsCompleted++
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
        success = false
        break
      }
    }

    const completedAt = new Date().toISOString()

    // Update execution stats
    await pool.query(
      `UPDATE procedures SET
        execution_count = execution_count + 1,
        last_executed = $1
       WHERE procedure_id = $2`,
      [completedAt, procedureId]
    )

    return {
      procedure_id: procedureId,
      started_at: startedAt,
      completed_at: completedAt,
      success,
      steps_completed: stepsCompleted,
      error,
      outputs,
    }
  }

  async function recordOutcome(
    procedureId: string,
    success: boolean
  ): Promise<void> {
    // Get current stats
    const result = await pool.query(
      `SELECT success_rate, execution_count FROM procedures WHERE procedure_id = $1`,
      [procedureId]
    )

    if (result.rows.length === 0) return

    const { success_rate, execution_count } = result.rows[0]

    // Exponential moving average for success rate
    const alpha = 0.1
    const newSuccessRate = success_rate * (1 - alpha) + (success ? 1 : 0) * alpha

    await pool.query(
      `UPDATE procedures SET
        success_rate = $1,
        updated_at = $2
       WHERE procedure_id = $3`,
      [newSuccessRate, new Date().toISOString(), procedureId]
    )
  }

  async function refine(
    procedureId: string,
    refinement: ProcedureRefinement
  ): Promise<Procedure> {
    const existing = await recall(procedureId)
    if (!existing) {
      throw new Error(`Procedure ${procedureId} not found`)
    }

    const updated: Procedure = {
      ...existing,
      updated_at: new Date().toISOString(),
    }

    if (refinement.updated_steps) {
      updated.steps = refinement.updated_steps
    }

    if (refinement.additional_triggers) {
      updated.trigger_conditions = [
        ...existing.trigger_conditions,
        ...refinement.additional_triggers,
      ]
    }

    if (refinement.removed_triggers) {
      updated.trigger_conditions = existing.trigger_conditions.filter(
        (t) => !refinement.removed_triggers!.includes(t)
      )
    }

    await pool.query(
      `UPDATE procedures SET
        trigger_conditions = $1,
        steps = $2,
        updated_at = $3
       WHERE procedure_id = $4`,
      [
        JSON.stringify(updated.trigger_conditions),
        JSON.stringify(updated.steps),
        updated.updated_at,
        procedureId,
      ]
    )

    return updated
  }

  async function deprecate(procedureId: string): Promise<void> {
    await pool.query(
      `UPDATE procedures SET deprecated = true, updated_at = $1 WHERE procedure_id = $2`,
      [new Date().toISOString(), procedureId]
    )
  }

  async function getBySuccessRate(
    identityId: string,
    minRate: number
  ): Promise<Procedure[]> {
    const result = await pool.query(
      `SELECT * FROM procedures
       WHERE identity_id = $1 AND deprecated = false AND success_rate >= $2
       ORDER BY success_rate DESC`,
      [identityId, minRate]
    )

    return result.rows.map(rowToProcedure)
  }

  return {
    learn,
    recall,
    findByTrigger,
    execute,
    recordOutcome,
    refine,
    deprecate,
    getBySuccessRate,
  }
}

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

function rowToProcedure(row: Record<string, unknown>): Procedure {
  return {
    procedure_id: row.procedure_id as string,
    identity_id: row.identity_id as string,
    name: row.name as string,
    description: row.description as string,
    trigger_conditions: (row.trigger_conditions as string[]) ?? [],
    steps: (row.steps as Procedure["steps"]) ?? [],
    success_rate: (row.success_rate as number) ?? 0.5,
    execution_count: (row.execution_count as number) ?? 0,
    last_executed: row.last_executed as string | undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

// -----------------------------------------------------------------------------
// Skill Pack Integration
// -----------------------------------------------------------------------------

export interface SkillPack {
  pack_id: string
  name: string
  version: string
  procedures: Procedure[]
  dependencies: string[]
  created_at: string
}

export async function importSkillPack(
  memory: ProceduralMemory,
  pool: pg.Pool,
  identityId: string,
  pack: SkillPack
): Promise<Procedure[]> {
  const imported: Procedure[] = []

  for (const procedure of pack.procedures) {
    const learned = await memory.learn({
      identity_id: identityId,
      name: `${pack.name}/${procedure.name}`,
      description: procedure.description,
      trigger_conditions: procedure.trigger_conditions,
      steps: procedure.steps,
    })

    imported.push(learned)
  }

  // Record pack import
  await pool.query(
    `INSERT INTO skill_pack_imports (import_id, identity_id, pack_id, pack_version, imported_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [crypto.randomUUID(), identityId, pack.pack_id, pack.version, new Date().toISOString()]
  )

  return imported
}
