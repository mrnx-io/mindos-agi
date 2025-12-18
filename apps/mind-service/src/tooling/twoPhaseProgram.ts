// =============================================================================
// MindOS - Two-Phase Program Execution
// =============================================================================

import { createLogger } from "../logger.js"
import type { ToolProgram, ToolProgramStep, Action, PolicyDecision } from "../types.js"
import { evaluatePolicy } from "../policy.js"
import { callTool, type ToolCallResult } from "./toolmeshClient.js"
import {
  executeCode,
  preflightCode,
  getReadOnlyPermissions,
  getWriteSafePermissions,
  getPrivilegedPermissions,
  type ExecutionPermissions,
} from "./executorClient.js"
import {
  resolveParameters,
  evaluateCondition,
  stepToAction,
  type ProgramContext,
} from "./toolProgram.js"

const log = createLogger("two-phase")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type ExecutionPhase = "preflight" | "execute"

export interface PhaseResult {
  phase: ExecutionPhase
  success: boolean
  stepResults: StepResult[]
  totalDuration: number
  error?: string
}

export interface StepResult {
  stepId: string
  description: string
  phase: ExecutionPhase
  success: boolean
  output?: unknown
  error?: string
  duration: number
  policyDecision?: PolicyDecision
  skipped?: boolean
  skipReason?: string
}

export interface ExecutionOptions {
  identityId: string
  taskId: string
  dryRun?: boolean
  skipPreflight?: boolean
  approvedRisk?: number
}

// -----------------------------------------------------------------------------
// Two-Phase Execution
// -----------------------------------------------------------------------------

export async function executeTwoPhase(
  program: ToolProgram,
  options: ExecutionOptions
): Promise<{ preflight: PhaseResult; execute?: PhaseResult }> {
  const context: ProgramContext = {
    variables: new Map(),
    outputs: new Map(),
    currentStep: 0,
    aborted: false,
  }

  // Phase 1: Preflight (Read-Only)
  log.info({ programId: program.program_id, name: program.name }, "Starting preflight phase")
  const preflightResult = await executePhase(program, context, "preflight", options)

  if (!preflightResult.success) {
    log.warn({ programId: program.program_id }, "Preflight failed, aborting execution")
    return { preflight: preflightResult }
  }

  if (options.dryRun) {
    log.info({ programId: program.program_id }, "Dry run complete, skipping execute phase")
    return { preflight: preflightResult }
  }

  // Reset context for execution phase (but keep variable values)
  context.currentStep = 0
  context.aborted = false

  // Phase 2: Execute (Write Operations)
  log.info({ programId: program.program_id, name: program.name }, "Starting execute phase")
  const executeResult = await executePhase(program, context, "execute", options)

  return {
    preflight: preflightResult,
    execute: executeResult,
  }
}

// -----------------------------------------------------------------------------
// Phase Execution
// -----------------------------------------------------------------------------

async function executePhase(
  program: ToolProgram,
  context: ProgramContext,
  phase: ExecutionPhase,
  options: ExecutionOptions
): Promise<PhaseResult> {
  const startTime = Date.now()
  const stepResults: StepResult[] = []

  for (let i = 0; i < program.steps.length; i++) {
    if (context.aborted) {
      break
    }

    const step = program.steps[i]
    context.currentStep = i

    // Check condition
    if (step.condition && !evaluateCondition(step.condition, context)) {
      stepResults.push({
        stepId: step.step_id,
        description: step.description,
        phase,
        success: true,
        skipped: true,
        skipReason: "Condition not met",
        duration: 0,
      })
      continue
    }

    // Execute step
    const result = await executeStep(step, context, phase, options)
    stepResults.push(result)

    // Handle failure
    if (!result.success) {
      if (step.on_error === "abort") {
        context.aborted = true
        context.abortReason = result.error
      }
      // "skip" continues to next step
      // "retry" is handled within executeStep
    }

    // Store output
    if (result.success && step.output_as && result.output !== undefined) {
      context.outputs.set(step.output_as, result.output)
    }
  }

  return {
    phase,
    success: !context.aborted && stepResults.every((r) => r.success || r.skipped),
    stepResults,
    totalDuration: Date.now() - startTime,
    error: context.abortReason,
  }
}

// -----------------------------------------------------------------------------
// Step Execution
// -----------------------------------------------------------------------------

async function executeStep(
  step: ToolProgramStep,
  context: ProgramContext,
  phase: ExecutionPhase,
  options: ExecutionOptions
): Promise<StepResult> {
  const startTime = Date.now()

  // Resolve parameters with context
  const resolvedParams = resolveParameters(step.parameters, context)

  // Create action for policy check
  const action = stepToAction({ ...step, parameters: resolvedParams })

  // Policy check
  const policyDecision = await evaluatePolicy(action, options.identityId)

  if (policyDecision.verdict === "block") {
    return {
      stepId: step.step_id,
      description: step.description,
      phase,
      success: false,
      error: `Blocked by policy: ${policyDecision.reason}`,
      duration: Date.now() - startTime,
      policyDecision,
    }
  }

  if (policyDecision.verdict === "escalate") {
    // Check if we have pre-approved risk level
    if (options.approvedRisk === undefined || policyDecision.risk_score > options.approvedRisk) {
      return {
        stepId: step.step_id,
        description: step.description,
        phase,
        success: false,
        error: `Requires approval: ${policyDecision.reason}`,
        duration: Date.now() - startTime,
        policyDecision,
      }
    }
  }

  // Determine permissions based on phase
  const permissions = getPermissionsForPhase(phase, step.tool)

  // Execute with retries
  let lastError: string | undefined
  let output: unknown

  for (let attempt = 0; attempt <= step.max_retries; attempt++) {
    try {
      if (isCodeExecutionTool(step.tool)) {
        // Execute via Deno sandbox
        const code = resolvedParams.code as string
        const language = (resolvedParams.language as "typescript" | "javascript") ?? "typescript"

        if (phase === "preflight") {
          // Dry run - just validate
          const preflight = await preflightCode(code, language)
          if (!preflight.valid) {
            throw new Error(`Code validation failed: ${preflight.errors.join(", ")}`)
          }
          output = { validated: true, warnings: preflight.warnings }
        } else {
          // Actual execution
          const result = await executeCode({
            code,
            language,
            context: resolvedParams.context as Record<string, unknown>,
            permissions,
            timeout_ms: 30000,
          })

          if (!result.success) {
            throw new Error(result.error || "Execution failed")
          }
          output = result.output
        }
      } else {
        // Execute via ToolMesh
        const result = await callTool({
          tool_name: step.tool,
          parameters: {
            ...resolvedParams,
            __phase: phase,
            __read_only: phase === "preflight",
          },
          idempotency_key: `${options.taskId}-${step.step_id}-${phase}-${attempt}`,
          identity_id: options.identityId,
          timeout_ms: 30000,
        })

        if (!result.success) {
          throw new Error(result.error || "Tool call failed")
        }
        output = result.output
      }

      // Success
      return {
        stepId: step.step_id,
        description: step.description,
        phase,
        success: true,
        output,
        duration: Date.now() - startTime,
        policyDecision,
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      log.warn(
        { stepId: step.step_id, attempt, error: lastError },
        "Step execution failed, retrying"
      )

      // Wait before retry with exponential backoff
      if (attempt < step.max_retries) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 100))
      }
    }
  }

  return {
    stepId: step.step_id,
    description: step.description,
    phase,
    success: false,
    error: lastError,
    duration: Date.now() - startTime,
    policyDecision,
  }
}

// -----------------------------------------------------------------------------
// Permission Helpers
// -----------------------------------------------------------------------------

function getPermissionsForPhase(
  phase: ExecutionPhase,
  tool: string
): ExecutionPermissions {
  if (phase === "preflight") {
    return getReadOnlyPermissions()
  }

  // Execute phase - determine based on tool type
  if (isPrivilegedTool(tool)) {
    return getPrivilegedPermissions()
  }

  return getWriteSafePermissions()
}

function isCodeExecutionTool(tool: string): boolean {
  const execTools = ["exec_code", "run_script", "evaluate", "sandbox_exec"]
  return execTools.some((t) => tool.toLowerCase().includes(t))
}

function isPrivilegedTool(tool: string): boolean {
  const privilegedTools = ["system_", "admin_", "privileged_", "root_"]
  return privilegedTools.some((p) => tool.toLowerCase().startsWith(p))
}

// -----------------------------------------------------------------------------
// Rollback Support
// -----------------------------------------------------------------------------

export interface RollbackPlan {
  steps: Array<{
    stepId: string
    rollbackAction: Action
  }>
}

export function generateRollbackPlan(
  program: ToolProgram,
  executedSteps: StepResult[]
): RollbackPlan {
  const rollbackSteps: RollbackPlan["steps"] = []

  // Process in reverse order
  for (let i = executedSteps.length - 1; i >= 0; i--) {
    const result = executedSteps[i]
    if (!result.success || result.skipped) {
      continue
    }

    const step = program.steps.find((s) => s.step_id === result.stepId)
    if (!step) continue

    const rollback = generateStepRollback(step, result.output)
    if (rollback) {
      rollbackSteps.push({
        stepId: step.step_id,
        rollbackAction: rollback,
      })
    }
  }

  return { steps: rollbackSteps }
}

function generateStepRollback(
  step: ToolProgramStep,
  output: unknown
): Action | null {
  const tool = step.tool.toLowerCase()

  // Generate inverse actions where possible
  if (tool.includes("create") || tool.includes("write")) {
    // Try to generate a delete action
    const id = (output as Record<string, unknown>)?.id ?? step.parameters.id
    if (id) {
      const deleteTool = tool.replace("create", "delete").replace("write", "delete")
      return {
        kind: "tool_call",
        tool: deleteTool,
        parameters: { id },
        reason: `Rollback: delete created resource`,
      }
    }
  }

  if (tool.includes("update")) {
    // Would need to store original values to rollback properly
    log.warn({ stepId: step.step_id }, "Update operations require stored state for rollback")
  }

  return null
}

// -----------------------------------------------------------------------------
// Checkpoint Support
// -----------------------------------------------------------------------------

export interface Checkpoint {
  checkpointId: string
  programId: string
  stepIndex: number
  context: {
    variables: Record<string, unknown>
    outputs: Record<string, unknown>
  }
  createdAt: string
}

export function createCheckpoint(
  program: ToolProgram,
  context: ProgramContext
): Checkpoint {
  return {
    checkpointId: crypto.randomUUID(),
    programId: program.program_id,
    stepIndex: context.currentStep,
    context: {
      variables: Object.fromEntries(context.variables),
      outputs: Object.fromEntries(context.outputs),
    },
    createdAt: new Date().toISOString(),
  }
}

export function restoreFromCheckpoint(checkpoint: Checkpoint): ProgramContext {
  return {
    variables: new Map(Object.entries(checkpoint.context.variables)),
    outputs: new Map(Object.entries(checkpoint.context.outputs)),
    currentStep: checkpoint.stepIndex,
    aborted: false,
  }
}
