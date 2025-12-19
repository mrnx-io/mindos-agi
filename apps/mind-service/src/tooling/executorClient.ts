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

export interface RequestContext {
  correlationId?: string
  identityId?: string
}

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
  body?: unknown,
  context?: RequestContext
): Promise<T> {
  const url = `${env.EXECUTOR_URL}${path}`

  // Build headers with authentication and context propagation
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  }

  // Add authorization header if token is configured
  if (env.EXECUTOR_TOKEN) {
    headers.Authorization = `Bearer ${env.EXECUTOR_TOKEN}`
  }

  // Add correlation ID for distributed tracing
  if (context?.correlationId) {
    headers["x-correlation-id"] = context.correlationId
  }

  // Add identity context
  if (context?.identityId) {
    headers["x-identity-id"] = context.identityId
  }

  try {
    // Build request options conditionally to satisfy exactOptionalPropertyTypes
    const requestOptions: Parameters<typeof request>[1] = {
      method,
      headers,
    }
    if (body) {
      requestOptions.body = JSON.stringify(body)
    }

    const response = await request(url, requestOptions)

    return (await response.body.json()) as T
  } catch (err) {
    log.error({ url, error: err }, "Executor request failed")
    throw err
  }
}

// -----------------------------------------------------------------------------
// Code Execution
// -----------------------------------------------------------------------------

export async function executeCode(
  request: ExecutionRequest,
  context?: RequestContext
): Promise<ExecutionResult> {
  log.info(
    {
      language: request.language,
      codeLength: request.code.length,
      timeout: request.timeout_ms,
      correlationId: context?.correlationId,
    },
    "Executing code in sandbox"
  )

  const result = await executorRequest<ExecutionResult>(
    "/execute",
    "POST",
    {
      code: request.code,
      language: request.language,
      context: request.context ?? {},
      permissions: request.permissions ?? getDefaultPermissions(),
      timeout_ms: request.timeout_ms ?? env.EXECUTOR_TIMEOUT_MS,
      memory_limit_mb: request.memory_limit_mb ?? 128,
    },
    context
  )

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
  language: "typescript" | "javascript",
  context?: RequestContext
): Promise<{
  valid: boolean
  errors: string[]
  warnings: string[]
  requiredPermissions: ExecutionPermissions
}> {
  return executorRequest("/preflight", "POST", { code, language }, context)
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

export function wrapCodeWithContext(code: string, context: Record<string, unknown>): string {
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
