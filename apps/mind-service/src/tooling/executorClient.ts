// =============================================================================
// MindOS - Executor Client (Deno Sandbox)
// =============================================================================

import { request } from "undici"
import { env } from "../config.js"
import { createLogger } from "../logger.js"

const log = createLogger("executor-client")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ExecutionRequest {
  code: string
  language: "typescript" | "javascript"
  context?: Record<string, unknown>
  permissions?: ExecutionPermissions
  timeout_ms?: number
  memory_limit_mb?: number
}

export interface ExecutionPermissions {
  net?: boolean | string[] // true, false, or list of allowed hosts
  read?: boolean | string[] // true, false, or list of paths
  write?: boolean | string[] // true, false, or list of paths
  env?: boolean | string[] // true, false, or list of env vars
  run?: boolean | string[] // true, false, or list of executables
}

export interface ExecutionResult {
  success: boolean
  output: unknown
  stdout: string
  stderr: string
  error?: string
  duration_ms: number
  memory_used_mb: number
  timed_out: boolean
}

// -----------------------------------------------------------------------------
// Executor Client
// -----------------------------------------------------------------------------

async function executorRequest<T>(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown
): Promise<T> {
  const url = `${env.EXECUTOR_URL}${path}`

  try {
    const response = await request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    return (await response.body.json()) as T
  } catch (err) {
    log.error({ url, error: err }, "Executor request failed")
    throw err
  }
}

// -----------------------------------------------------------------------------
// Code Execution
// -----------------------------------------------------------------------------

export async function executeCode(request: ExecutionRequest): Promise<ExecutionResult> {
  const start = Date.now()

  log.info(
    {
      language: request.language,
      codeLength: request.code.length,
      timeout: request.timeout_ms,
    },
    "Executing code in sandbox"
  )

  const result = await executorRequest<ExecutionResult>("/execute", "POST", {
    code: request.code,
    language: request.language,
    context: request.context ?? {},
    permissions: request.permissions ?? getDefaultPermissions(),
    timeout_ms: request.timeout_ms ?? 30000,
    memory_limit_mb: request.memory_limit_mb ?? 128,
  })

  log.info(
    {
      success: result.success,
      duration_ms: result.duration_ms,
      memory_mb: result.memory_used_mb,
      timed_out: result.timed_out,
    },
    "Code execution completed"
  )

  return result
}

// -----------------------------------------------------------------------------
// Preflight (Dry Run)
// -----------------------------------------------------------------------------

export async function preflightCode(
  code: string,
  language: "typescript" | "javascript"
): Promise<{
  valid: boolean
  errors: string[]
  warnings: string[]
  requiredPermissions: ExecutionPermissions
}> {
  return executorRequest("/preflight", "POST", { code, language })
}

// -----------------------------------------------------------------------------
// Permission Helpers
// -----------------------------------------------------------------------------

export function getDefaultPermissions(): ExecutionPermissions {
  return {
    net: false,
    read: false,
    write: false,
    env: false,
    run: false,
  }
}

export function getReadOnlyPermissions(): ExecutionPermissions {
  return {
    net: ["api.openai.com", "api.anthropic.com"],
    read: ["/tmp"],
    write: false,
    env: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    run: false,
  }
}

export function getWriteSafePermissions(): ExecutionPermissions {
  return {
    net: true,
    read: true,
    write: ["/tmp", "/workspace"],
    env: true,
    run: false,
  }
}

export function getPrivilegedPermissions(): ExecutionPermissions {
  // WARNING: Only use with explicit human approval
  return {
    net: true,
    read: true,
    write: true,
    env: true,
    run: true,
  }
}

// -----------------------------------------------------------------------------
// Code Templates
// -----------------------------------------------------------------------------

export function wrapCodeWithContext(
  code: string,
  context: Record<string, unknown>
): string {
  const contextSetup = Object.entries(context)
    .map(([key, value]) => `const ${key} = ${JSON.stringify(value)};`)
    .join("\n")

  return `
// Context setup
${contextSetup}

// User code
${code}
`
}

export function wrapCodeWithErrorHandling(code: string): string {
  return `
try {
  ${code}
} catch (error) {
  console.error("Execution error:", error.message);
  throw error;
}
`
}

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------

export async function checkExecutorHealth(): Promise<boolean> {
  try {
    const result = await executorRequest<{ status: string }>("/health")
    return result.status === "ok"
  } catch {
    return false
  }
}

// -----------------------------------------------------------------------------
// Resource Monitoring
// -----------------------------------------------------------------------------

export async function getExecutorStats(): Promise<{
  activeExecutions: number
  queuedExecutions: number
  avgExecutionTime: number
  memoryUsage: number
  cpuUsage: number
}> {
  return executorRequest("/stats")
}
