// =============================================================================
// MindOS - Two-Phase Program Execution
// =============================================================================

import { env } from "../config.js"
import { createLogger } from "../logger.js"
import { evaluatePolicy } from "../policy.js"
import type { Action, PolicyDecision, ToolProgramStep } from "../types.js"
import {
  type ExecutionPermissions,
  executeCode,
  getPrivilegedPermissions,
  getReadOnlyPermissions,
  getWriteSafePermissions,
  preflightCode,
} from "./executorClient.js"
import {
  type ProgramContext,
  type StepBasedToolProgram,
  evaluateCondition,
  resolveParameters,
  stepToAction,
} from "./toolProgram.js"
import { callTool } from "./toolmeshClient.js"

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
  program: StepBasedToolProgram,
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
  program: StepBasedToolProgram,
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
    if (!step) continue // noUncheckedIndexedAccess guard
    context.currentStep = i

    // Check if step should be skipped due to condition
    const skipResult = checkStepCondition(step, context, phase)
    if (skipResult) {
      stepResults.push(skipResult)
      continue
    }

    // Execute step and handle result
    const result = await executeStep(step, context, phase, options)
    stepResults.push(result)
    handleStepResult(result, step, context)
  }

  return buildPhaseResult(phase, stepResults, context, Date.now() - startTime)
}

function checkStepCondition(
  step: ToolProgramStep,
  context: ProgramContext,
  phase: ExecutionPhase
): StepResult | null {
  if (!step.condition) {
    return null
  }

  if (evaluateCondition(step.condition, context)) {
    return null
  }

  return {
    stepId: step.step_id,
    description: step.description,
    phase,
    success: true,
    skipped: true,
    skipReason: "Condition not met",
    duration: 0,
  }
}

function handleStepResult(
  result: StepResult,
  step: ToolProgramStep,
  context: ProgramContext
): void {
  // Handle failure
  if (!result.success && step.on_error === "abort") {
    context.aborted = true
    if (result.error) {
      context.abortReason = result.error
    }
    return
  }

  // Store output on success
  if (result.success && step.output_as && result.output !== undefined) {
    context.outputs.set(step.output_as, result.output)
  }
}

function buildPhaseResult(
  phase: ExecutionPhase,
  stepResults: StepResult[],
  context: ProgramContext,
  totalDuration: number
): PhaseResult {
  const result: PhaseResult = {
    phase,
    success: !context.aborted && stepResults.every((r) => r.success || r.skipped),
    stepResults,
    totalDuration,
  }

  if (context.abortReason) {
    result.error = context.abortReason
  }

  return result
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

  // Check if policy blocks execution
  const policyError = checkPolicyApproval(policyDecision, options.approvedRisk)
  if (policyError) {
    return createStepResult(step, phase, false, startTime, policyDecision, policyError)
  }

  // Determine permissions based on phase
  const permissions = getPermissionsForPhase(phase, step.tool)

  // Execute with retries
  const output = await executeStepWithRetries(step, resolvedParams, phase, permissions, options)

  if (output.error) {
    return createStepResult(step, phase, false, startTime, policyDecision, output.error)
  }

  return createStepResult(step, phase, true, startTime, policyDecision, undefined, output.value)
}

function checkPolicyApproval(
  policyDecision: PolicyDecision,
  approvedRisk: number | undefined
): string | null {
  if (policyDecision.verdict === "block") {
    return `Blocked by policy: ${policyDecision.reason}`
  }

  if (policyDecision.verdict === "escalate") {
    const needsApproval = approvedRisk === undefined || policyDecision.risk_score > approvedRisk
    if (needsApproval) {
      return `Requires approval: ${policyDecision.reason}`
    }
  }

  return null
}

async function executeStepWithRetries(
  step: ToolProgramStep,
  resolvedParams: Record<string, unknown>,
  phase: ExecutionPhase,
  permissions: ExecutionPermissions,
  options: ExecutionOptions
): Promise<{ value?: unknown; error?: string }> {
  let lastError: string | undefined

  for (let attempt = 0; attempt <= step.max_retries; attempt++) {
    try {
      const output = isCodeExecutionTool(step.tool)
        ? await executeCodeStep(resolvedParams, phase, permissions)
        : await executeToolMeshStep(step, resolvedParams, phase, options, attempt)

      return { value: output }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      log.warn(
        { stepId: step.step_id, attempt, error: lastError },
        "Step execution failed, retrying"
      )

      // Wait before retry with exponential backoff
      if (attempt < step.max_retries) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 100))
      }
    }
  }

  // Build result object conditionally to satisfy exactOptionalPropertyTypes
  if (lastError !== undefined) {
    return { error: lastError }
  }
  return { error: "Unknown error occurred" }
}

async function executeCodeStep(
  resolvedParams: Record<string, unknown>,
  phase: ExecutionPhase,
  permissions: ExecutionPermissions
): Promise<unknown> {
  const code = resolvedParams.code as string
  const language = (resolvedParams.language as "typescript" | "javascript") ?? "typescript"

  if (phase === "preflight") {
    const preflight = await preflightCode(code, language)
    if (!preflight.valid) {
      throw new Error(`Code validation failed: ${preflight.errors.join(", ")}`)
    }
    return { validated: true, warnings: preflight.warnings }
  }

  const result = await executeCode({
    code,
    language,
    context: resolvedParams.context as Record<string, unknown>,
    permissions,
    timeout_ms: env.EXECUTOR_TIMEOUT_MS,
  })

  if (!result.success) {
    throw new Error(result.error || "Execution failed")
  }

  return result.output
}

async function executeToolMeshStep(
  step: ToolProgramStep,
  resolvedParams: Record<string, unknown>,
  phase: ExecutionPhase,
  options: ExecutionOptions,
  attempt: number
): Promise<unknown> {
  const result = await callTool({
    toolName: step.tool,
    arguments: {
      ...resolvedParams,
      __phase: phase,
      __read_only: phase === "preflight",
    },
    idempotencyKey: `${options.taskId}-${step.step_id}-${phase}-${attempt}`,
  })

  if (!result.ok) {
    throw new Error(result.error || "Tool call failed")
  }

  return result.structured
}

function createStepResult(
  step: ToolProgramStep,
  phase: ExecutionPhase,
  success: boolean,
  startTime: number,
  policyDecision?: PolicyDecision,
  error?: string,
  output?: unknown
): StepResult {
  const result: StepResult = {
    stepId: step.step_id,
    description: step.description,
    phase,
    success,
    duration: Date.now() - startTime,
  }

  if (policyDecision) {
    result.policyDecision = policyDecision
  }

  if (error) {
    result.error = error
  }

  if (output !== undefined) {
    result.output = output
  }

  return result
}

// -----------------------------------------------------------------------------
// Permission Helpers
// -----------------------------------------------------------------------------

function getPermissionsForPhase(phase: ExecutionPhase, tool: string): ExecutionPermissions {
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
  program: StepBasedToolProgram,
  executedSteps: StepResult[]
): RollbackPlan {
  const rollbackSteps: RollbackPlan["steps"] = []

  // Process in reverse order
  for (let i = executedSteps.length - 1; i >= 0; i--) {
    const result = executedSteps[i]
    if (!result || !result.success || result.skipped) {
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

function generateStepRollback(step: ToolProgramStep, output: unknown): Action | null {
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
        args: { id },
        expected: "Rollback: delete created resource",
        risk: 0.5,
        uncertainty: 0.5,
        name: "Rollback action",
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
  program: StepBasedToolProgram,
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
