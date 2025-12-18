// =============================================================================
// MindOS - Tool Program Compiler
// =============================================================================

import { createLogger } from "../logger.js"
import type { ToolProgram, ToolProgramStep, Tool, Action } from "../types.js"
import { validateToolProgram, type ValidationResult } from "./toolProgramSafety.js"

const log = createLogger("tool-program")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CompilationResult {
  success: boolean
  program?: ToolProgram
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

  // Validate step structure
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]

    if (!step.description) {
      errors.push(`Step ${i + 1}: Missing description`)
    }

    if (!step.tool) {
      errors.push(`Step ${i + 1}: Missing tool`)
    }

    if (step.condition) {
      try {
        // Basic syntax check for condition expression
        new Function("ctx", `return ${step.condition}`)
      } catch {
        errors.push(`Step ${i + 1}: Invalid condition expression: ${step.condition}`)
      }
    }

    if (step.maxRetries && step.maxRetries > 5) {
      warnings.push(`Step ${i + 1}: High retry count (${step.maxRetries}), consider reducing`)
    }
  }

  if (errors.length > 0) {
    return { success: false, errors, warnings }
  }

  // Build program
  const program: ToolProgram = {
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
  program: ToolProgram,
  availableTools: Tool[]
): {
  executable: boolean
  missingTools: string[]
  executionOrder: number[][]
  estimatedDuration: number
} {
  const missingTools: string[] = []
  const toolMap = new Map(availableTools.map((t) => [t.name, t]))

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

function computeExecutionOrder(program: ToolProgram): number[][] {
  // For now, simple sequential execution
  // Could be enhanced with dependency analysis for parallelization
  const order: number[][] = []

  if (program.max_parallel === 1) {
    // Sequential
    for (let i = 0; i < program.steps.length; i++) {
      order.push([i])
    }
  } else {
    // Group steps that can run in parallel
    // This is a simplified version - real implementation would analyze dependencies
    let batch: number[] = []
    for (let i = 0; i < program.steps.length; i++) {
      const step = program.steps[i]

      // Steps with conditions must be sequential
      if (step.condition || batch.length >= program.max_parallel) {
        if (batch.length > 0) {
          order.push(batch)
          batch = []
        }
      }

      batch.push(i)
    }

    if (batch.length > 0) {
      order.push(batch)
    }
  }

  return order
}

function estimateExecutionDuration(
  program: ToolProgram,
  toolMap: Map<string, Tool>
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
    let value: unknown = context.outputs.get(path[0])

    for (let i = 1; i < path.length && value != null; i++) {
      value = (value as Record<string, unknown>)[path[i]]
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

export function evaluateCondition(
  condition: string,
  context: ProgramContext
): boolean {
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
    parameters: step.parameters,
    reason: step.description,
  }
}
