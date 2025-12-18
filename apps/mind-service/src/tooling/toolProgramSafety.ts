// =============================================================================
// MindOS - Tool Program Safety Validation
// =============================================================================

import { createLogger } from "../logger.js"
import type { ToolProgram, ToolProgramStep } from "../types.js"

const log = createLogger("tool-program-safety")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  riskScore: number
  requiresApproval: boolean
}

interface SafetyRule {
  id: string
  name: string
  severity: "error" | "warning"
  check: (program: ToolProgram, step?: ToolProgramStep) => string | null
}

// -----------------------------------------------------------------------------
// Safety Rules
// -----------------------------------------------------------------------------

const PROGRAM_RULES: SafetyRule[] = [
  {
    id: "max-steps",
    name: "Maximum steps limit",
    severity: "error",
    check: (program) => {
      if (program.steps.length > 50) {
        return `Program has ${program.steps.length} steps, maximum allowed is 50`
      }
      return null
    },
  },
  {
    id: "max-parallel",
    name: "Maximum parallel limit",
    severity: "error",
    check: (program) => {
      if (program.max_parallel > 10) {
        return `max_parallel of ${program.max_parallel} exceeds limit of 10`
      }
      return null
    },
  },
  {
    id: "unique-output-names",
    name: "Unique output names",
    severity: "error",
    check: (program) => {
      const outputNames = program.steps
        .filter((s) => s.output_as)
        .map((s) => s.output_as!)

      const duplicates = outputNames.filter(
        (name, index) => outputNames.indexOf(name) !== index
      )

      if (duplicates.length > 0) {
        return `Duplicate output names: ${duplicates.join(", ")}`
      }
      return null
    },
  },
  {
    id: "circular-references",
    name: "No circular references",
    severity: "error",
    check: (program) => {
      // Check for circular references in parameter templates
      for (const step of program.steps) {
        if (step.output_as) {
          const paramsStr = JSON.stringify(step.parameters)
          if (paramsStr.includes(`outputs.${step.output_as}`)) {
            return `Step "${step.description}" references its own output`
          }
        }
      }
      return null
    },
  },
  {
    id: "valid-conditions",
    name: "Valid condition expressions",
    severity: "error",
    check: (program) => {
      for (const step of program.steps) {
        if (step.condition) {
          // Check for dangerous patterns in conditions
          const dangerous = [
            "eval(",
            "Function(",
            "import(",
            "require(",
            "__proto__",
            "constructor",
          ]

          for (const pattern of dangerous) {
            if (step.condition.includes(pattern)) {
              return `Step "${step.description}" has dangerous condition pattern: ${pattern}`
            }
          }
        }
      }
      return null
    },
  },
]

const STEP_RULES: SafetyRule[] = [
  {
    id: "dangerous-tools",
    name: "No dangerous tools",
    severity: "error",
    check: (_, step) => {
      if (!step) return null

      const dangerousTools = [
        "system_exec_privileged",
        "db_admin_drop",
        "file_delete_recursive",
        "network_proxy",
      ]

      if (dangerousTools.includes(step.tool)) {
        return `Step uses dangerous tool: ${step.tool}`
      }
      return null
    },
  },
  {
    id: "parameter-injection",
    name: "No parameter injection",
    severity: "error",
    check: (_, step) => {
      if (!step) return null

      const paramsStr = JSON.stringify(step.parameters)

      // Check for shell injection patterns
      const injectionPatterns = [
        /;\s*rm\s/i,
        /\|\s*sh\b/i,
        /`[^`]+`/,
        /\$\([^)]+\)/,
        /\beval\b/i,
      ]

      for (const pattern of injectionPatterns) {
        if (pattern.test(paramsStr)) {
          return `Step "${step.description}" has potential injection vulnerability`
        }
      }
      return null
    },
  },
  {
    id: "excessive-retries",
    name: "Reasonable retry count",
    severity: "warning",
    check: (_, step) => {
      if (!step) return null

      if (step.max_retries > 5) {
        return `Step "${step.description}" has excessive retries (${step.max_retries})`
      }
      return null
    },
  },
  {
    id: "missing-error-handler",
    name: "Error handling defined",
    severity: "warning",
    check: (_, step) => {
      if (!step) return null

      // High-risk tools should have explicit error handling
      const highRiskTools = ["file_write", "db_write", "http_post", "exec_code"]

      if (highRiskTools.some((t) => step.tool.includes(t)) && !step.on_error) {
        return `Step "${step.description}" uses high-risk tool without explicit error handling`
      }
      return null
    },
  },
]

// -----------------------------------------------------------------------------
// Risk Assessment
// -----------------------------------------------------------------------------

interface RiskFactor {
  name: string
  weight: number
  check: (program: ToolProgram) => number // Returns 0-1
}

const RISK_FACTORS: RiskFactor[] = [
  {
    name: "step_count",
    weight: 0.1,
    check: (program) => Math.min(program.steps.length / 50, 1),
  },
  {
    name: "destructive_tools",
    weight: 0.3,
    check: (program) => {
      const destructive = ["delete", "drop", "remove", "truncate"]
      const count = program.steps.filter((s) =>
        destructive.some((d) => s.tool.toLowerCase().includes(d))
      ).length
      return Math.min(count / program.steps.length, 1)
    },
  },
  {
    name: "external_calls",
    weight: 0.2,
    check: (program) => {
      const external = ["http", "api", "network", "external"]
      const count = program.steps.filter((s) =>
        external.some((e) => s.tool.toLowerCase().includes(e))
      ).length
      return Math.min(count / program.steps.length, 1)
    },
  },
  {
    name: "code_execution",
    weight: 0.25,
    check: (program) => {
      const execTools = ["exec", "run", "eval", "shell"]
      const count = program.steps.filter((s) =>
        execTools.some((e) => s.tool.toLowerCase().includes(e))
      ).length
      return Math.min(count * 0.5, 1)
    },
  },
  {
    name: "data_sensitivity",
    weight: 0.15,
    check: (program) => {
      const sensitive = ["password", "secret", "token", "key", "credential"]
      let score = 0

      for (const step of program.steps) {
        const paramsStr = JSON.stringify(step.parameters).toLowerCase()
        if (sensitive.some((s) => paramsStr.includes(s))) {
          score += 0.3
        }
      }

      return Math.min(score, 1)
    },
  },
]

function calculateRiskScore(program: ToolProgram): number {
  let totalWeight = 0
  let weightedScore = 0

  for (const factor of RISK_FACTORS) {
    const score = factor.check(program)
    weightedScore += factor.weight * score
    totalWeight += factor.weight
  }

  return weightedScore / totalWeight
}

// -----------------------------------------------------------------------------
// Main Validation
// -----------------------------------------------------------------------------

export function validateToolProgram(program: ToolProgram): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Run program-level rules
  for (const rule of PROGRAM_RULES) {
    const result = rule.check(program)
    if (result) {
      if (rule.severity === "error") {
        errors.push(result)
      } else {
        warnings.push(result)
      }
    }
  }

  // Run step-level rules
  for (const step of program.steps) {
    for (const rule of STEP_RULES) {
      const result = rule.check(program, step)
      if (result) {
        if (rule.severity === "error") {
          errors.push(result)
        } else {
          warnings.push(result)
        }
      }
    }
  }

  // Calculate risk score
  const riskScore = calculateRiskScore(program)

  // Determine if approval is required
  const requiresApproval = riskScore > 0.5 || program.requires_approval

  log.info(
    {
      programName: program.name,
      valid: errors.length === 0,
      errorCount: errors.length,
      warningCount: warnings.length,
      riskScore,
      requiresApproval,
    },
    "Tool program validation completed"
  )

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    riskScore,
    requiresApproval,
  }
}

// -----------------------------------------------------------------------------
// Static Analysis Helpers
// -----------------------------------------------------------------------------

export function analyzeDataFlow(program: ToolProgram): {
  inputs: Set<string>
  outputs: Set<string>
  dependencies: Map<string, string[]>
} {
  const inputs = new Set<string>()
  const outputs = new Set<string>()
  const dependencies = new Map<string, string[]>()

  for (const step of program.steps) {
    // Track outputs
    if (step.output_as) {
      outputs.add(step.output_as)
    }

    // Find references in parameters
    const paramsStr = JSON.stringify(step.parameters)
    const refs = paramsStr.match(/\{\{outputs\.([^}]+)\}\}/g)

    if (refs) {
      const deps: string[] = []
      for (const ref of refs) {
        const name = ref.slice(10, -2).split(".")[0]
        deps.push(name)
        inputs.add(name)
      }
      dependencies.set(step.step_id, deps)
    }
  }

  return { inputs, outputs, dependencies }
}

export function detectUnreachableSteps(program: ToolProgram): string[] {
  const unreachable: string[] = []

  for (let i = 1; i < program.steps.length; i++) {
    const step = program.steps[i]
    const prevStep = program.steps[i - 1]

    // If previous step always aborts on error and has no error handling
    if (prevStep.on_error === "abort") {
      // Check if this step has a condition that depends on previous success
      if (step.condition?.includes("outputs.") && !step.condition.includes("||")) {
        unreachable.push(step.step_id)
      }
    }
  }

  return unreachable
}

// -----------------------------------------------------------------------------
// Sanitization
// -----------------------------------------------------------------------------

export function sanitizeParameters(
  parameters: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(parameters)) {
    sanitized[key] = sanitizeValue(value)
  }

  return sanitized
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    // Remove potential shell injection
    return value
      .replace(/[;&|`$(){}]/g, "")
      .replace(/\.\.\//g, "")
      .slice(0, 10000) // Limit string length
  }

  if (Array.isArray(value)) {
    return value.slice(0, 100).map(sanitizeValue)
  }

  if (typeof value === "object" && value !== null) {
    const sanitized: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      sanitized[k] = sanitizeValue(v)
    }
    return sanitized
  }

  return value
}
