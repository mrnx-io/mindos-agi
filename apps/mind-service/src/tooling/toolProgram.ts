// =============================================================================
// MindOS - Tool Program Compiler
// =============================================================================

import { createLogger } from "../logger.js"
import type { Action, Tool, ToolProgram, ToolProgramStep } from "../types.js"
import { validateToolProgram } from "./toolProgramSafety.js"

const log = createLogger("tool-program")

// -----------------------------------------------------------------------------
// Step-Based Tool Program (with required fields)
// -----------------------------------------------------------------------------

/** A ToolProgram that has step-based execution (not code-based) */
export interface StepBasedToolProgram extends ToolProgram {
  program_id: string
  name: string
  description: string
  steps: ToolProgramStep[]
  requires_approval: boolean
  max_parallel: number
  created_at: string
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CompilationResult {
  success: boolean
  program?: StepBasedToolProgram
  errors: string[]
  warnings: string[]
}

export interface ProgramContext {
  variables: Map<string, unknown>
  outputs: Map<string, unknown>
  currentStep: number
  aborted: boolean
  abortReason?: string
}

// -----------------------------------------------------------------------------
// Program Compilation
// -----------------------------------------------------------------------------

/** Validates a single step and returns any errors or warnings */
function validateStep(
  step: {
    description: string
    tool: string
    condition?: string
    maxRetries?: number
  },
  stepIndex: number
): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const stepNum = stepIndex + 1

  if (!step.description) {
    errors.push(`Step ${stepNum}: Missing description`)
  }

  if (!step.tool) {
    errors.push(`Step ${stepNum}: Missing tool`)
  }

  if (step.condition) {
    const conditionError = validateConditionSyntax(step.condition, stepNum)
    if (conditionError) {
      errors.push(conditionError)
    }
  }

  if (step.maxRetries && step.maxRetries > 5) {
    warnings.push(`Step ${stepNum}: High retry count (${step.maxRetries}), consider reducing`)
  }

  return { errors, warnings }
}

/** Validates condition syntax and returns error message if invalid */
function validateConditionSyntax(condition: string, stepNum: number): string | null {
  try {
    new Function("ctx", `return ${condition}`)
    return null
  } catch {
    return `Step ${stepNum}: Invalid condition expression: ${condition}`
  }
}

/** Builds a StepBasedToolProgram from validated steps */
function buildProgram(
  steps: Array<{
    description: string
    tool: string
    parameters: Record<string, unknown>
    condition?: string
    onError?: "abort" | "skip" | "retry"
    maxRetries?: number
    outputAs?: string
  }>,
  options: {
    name: string
    description: string
    requiresApproval?: boolean
    maxParallel?: number
  }
): StepBasedToolProgram {
  return {
    // Required base fields
    objective: options.description,
    input: {},
    code: "", // Step-based programs don't use code
    // Step-based program fields
    program_id: crypto.randomUUID(),
    name: options.name,
    description: options.description,
    steps: steps.map((step, index) => ({
      step_id: crypto.randomUUID(),
      sequence: index,
      description: step.description,
      tool: step.tool,
      parameters: step.parameters,
      condition: step.condition,
      on_error: step.onError ?? "abort",
      max_retries: step.maxRetries ?? 0,
      output_as: step.outputAs,
    })),
    requires_approval: options.requiresApproval ?? false,
    max_parallel: options.maxParallel ?? 1,
    created_at: new Date().toISOString(),
  }
}

export function compileToolProgram(
  steps: Array<{
    description: string
    tool: string
    parameters: Record<string, unknown>
    condition?: string
    onError?: "abort" | "skip" | "retry"
    maxRetries?: number
    outputAs?: string
  }>,
  options: {
    name: string
    description: string
    requiresApproval?: boolean
    maxParallel?: number
  }
): CompilationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Validate all steps
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (!step) continue // Should never happen, but satisfies noUncheckedIndexedAccess

    const validation = validateStep(step, i)
    errors.push(...validation.errors)
    warnings.push(...validation.warnings)
  }

  // Early return if validation failed
  if (errors.length > 0) {
    return { success: false, errors, warnings }
  }

  // Build program
  const program = buildProgram(steps, options)

  // Safety validation
  const validation = validateToolProgram(program)
  if (!validation.valid) {
    return {
      success: false,
      errors: validation.errors,
      warnings: [...warnings, ...validation.warnings],
    }
  }

  return {
    success: true,
    program,
    errors: [],
    warnings: [...warnings, ...validation.warnings],
  }
}

// -----------------------------------------------------------------------------
// Program Execution Planning
// -----------------------------------------------------------------------------

export function planExecution(
  program: StepBasedToolProgram,
  availableTools: Tool[]
): {
  executable: boolean
  missingTools: string[]
  executionOrder: number[][]
  estimatedDuration: number
} {
  const missingTools: string[] = []
  // Use tool_name as the key, falling back to name for compatibility
  const toolMap = new Map(availableTools.map((t) => [t.name ?? t.tool_name, t]))

  // Check tool availability
  for (const step of program.steps) {
    if (!toolMap.has(step.tool)) {
      missingTools.push(step.tool)
    }
  }

  if (missingTools.length > 0) {
    return {
      executable: false,
      missingTools,
      executionOrder: [],
      estimatedDuration: 0,
    }
  }

  // Determine execution order (respecting dependencies)
  const executionOrder = computeExecutionOrder(program)

  // Estimate duration
  const estimatedDuration = estimateExecutionDuration(program, toolMap)

  return {
    executable: true,
    missingTools: [],
    executionOrder,
    estimatedDuration,
  }
}

/** Computes sequential execution order (one step at a time) */
function computeSequentialOrder(stepCount: number): number[][] {
  const order: number[][] = []
  for (let i = 0; i < stepCount; i++) {
    order.push([i])
  }
  return order
}

/** Checks if a step should start a new batch */
function shouldStartNewBatch(
  step: ToolProgramStep | undefined,
  batchSize: number,
  maxParallel: number
): boolean {
  if (!step) return false
  // Steps with conditions must be sequential
  if (step.condition) return true
  // Batch is full
  if (batchSize >= maxParallel) return true
  return false
}

/** Adds a batch to the order if it's not empty */
function flushBatch(order: number[][], batch: number[]): number[] {
  if (batch.length > 0) {
    order.push(batch)
  }
  return []
}

/** Computes parallel execution order (batches of steps) */
function computeParallelOrder(program: StepBasedToolProgram): number[][] {
  const order: number[][] = []
  let batch: number[] = []

  for (let i = 0; i < program.steps.length; i++) {
    const step = program.steps[i]
    if (!step) continue // Should never happen, but satisfies noUncheckedIndexedAccess

    if (shouldStartNewBatch(step, batch.length, program.max_parallel)) {
      batch = flushBatch(order, batch)
    }

    batch.push(i)
  }

  flushBatch(order, batch)
  return order
}

function computeExecutionOrder(program: StepBasedToolProgram): number[][] {
  // For now, simple sequential execution
  // Could be enhanced with dependency analysis for parallelization
  if (program.max_parallel === 1) {
    return computeSequentialOrder(program.steps.length)
  }

  // Group steps that can run in parallel
  // This is a simplified version - real implementation would analyze dependencies
  return computeParallelOrder(program)
}

function estimateExecutionDuration(
  program: StepBasedToolProgram,
  toolMap: Map<string | undefined, Tool>
): number {
  let totalMs = 0

  for (const step of program.steps) {
    const tool = toolMap.get(step.tool)
    // Default estimate: 5 seconds per tool call
    const stepDuration = tool?.estimated_duration_ms ?? 5000
    totalMs += stepDuration * (1 + step.max_retries)
  }

  // Account for parallelization
  if (program.max_parallel > 1) {
    totalMs = Math.ceil(totalMs / program.max_parallel)
  }

  return totalMs
}

// -----------------------------------------------------------------------------
// Parameter Resolution
// -----------------------------------------------------------------------------

export function resolveParameters(
  parameters: Record<string, unknown>,
  context: ProgramContext
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(parameters)) {
    resolved[key] = resolveValue(value, context)
  }

  return resolved
}

function resolveValue(value: unknown, context: ProgramContext): unknown {
  if (typeof value === "string") {
    // Check for variable references like {{variableName}} or {{outputs.stepName}}
    return value.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
      const result = evaluateExpression(expr.trim(), context)
      return String(result)
    })
  }

  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, context))
  }

  if (typeof value === "object" && value !== null) {
    const resolved: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveValue(v, context)
    }
    return resolved
  }

  return value
}

function evaluateExpression(expr: string, context: ProgramContext): unknown {
  // Handle outputs.stepName.property
  if (expr.startsWith("outputs.")) {
    const path = expr.slice(8).split(".")
    const firstPathSegment = path[0]
    if (!firstPathSegment) return undefined

    let value: unknown = context.outputs.get(firstPathSegment)

    for (let i = 1; i < path.length && value != null; i++) {
      const segment = path[i]
      if (!segment) break
      value = (value as Record<string, unknown>)[segment]
    }

    return value
  }

  // Handle variables.name
  if (expr.startsWith("variables.")) {
    return context.variables.get(expr.slice(10))
  }

  // Direct variable lookup
  if (context.variables.has(expr)) {
    return context.variables.get(expr)
  }

  log.warn({ expr }, "Unknown expression reference")
  return undefined
}

// -----------------------------------------------------------------------------
// Condition Evaluation
// -----------------------------------------------------------------------------

export function evaluateCondition(condition: string, context: ProgramContext): boolean {
  try {
    // Create a safe evaluation context
    const ctx = {
      outputs: Object.fromEntries(context.outputs),
      variables: Object.fromEntries(context.variables),
      currentStep: context.currentStep,
    }

    // Evaluate the condition
    const fn = new Function("ctx", `with(ctx) { return ${condition} }`)
    return Boolean(fn(ctx))
  } catch (err) {
    log.error({ condition, error: err }, "Failed to evaluate condition")
    return false
  }
}

// -----------------------------------------------------------------------------
// Program Serialization
// -----------------------------------------------------------------------------

export function serializeProgram(program: ToolProgram): string {
  return JSON.stringify(program, null, 2)
}

export function deserializeProgram(json: string): ToolProgram {
  return JSON.parse(json) as ToolProgram
}

// -----------------------------------------------------------------------------
// Action Conversion
// -----------------------------------------------------------------------------

export function stepToAction(step: ToolProgramStep): Action {
  return {
    kind: "tool_call",
    tool: step.tool,
    args: step.parameters,
    expected: step.description,
    risk: 0.5,
    uncertainty: 0.5,
    name: step.description,
  }
}
