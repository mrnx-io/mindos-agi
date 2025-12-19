// =============================================================================
// MindOS - Retry Logic with Budgets
// =============================================================================

import { env } from "../config.js"
import { query, queryOne } from "../db.js"
import { createLogger } from "../logger.js"

const log = createLogger("retry")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface RetryConfig {
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
  backoffMultiplier: number
  jitterFactor: number
}

export interface RetryBudget {
  serverName: string
  remainingAttempts: number
  resetAt: Date
  cooldownUntil: Date | null
}

const DEFAULT_CONFIG: RetryConfig = {
  maxAttempts: env.DEFAULT_RETRY_BUDGET,
  initialDelayMs: env.DEFAULT_RETRY_DELAY_MS,
  maxDelayMs: env.MAX_RETRY_DELAY_MS,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
}

// -----------------------------------------------------------------------------
// Retry Budget Management
// -----------------------------------------------------------------------------

export async function checkRetryBudget(serverName: string): Promise<boolean> {
  const budget = await getRetryBudget(serverName)

  // Check if in cooldown
  if (budget.cooldownUntil && budget.cooldownUntil > new Date()) {
    log.warn({ serverName, cooldownUntil: budget.cooldownUntil }, "Server in cooldown")
    return false
  }

  // Check if budget exhausted
  if (budget.remainingAttempts <= 0) {
    log.warn({ serverName }, "Retry budget exhausted")
    return false
  }

  return true
}

export async function consumeRetryBudget(serverName: string): Promise<void> {
  await query(
    `UPDATE retry_budgets
     SET remaining_attempts = remaining_attempts - 1,
         last_attempt_at = NOW()
     WHERE server_name = $1`,
    [serverName]
  )
}

export async function resetRetryBudget(serverName: string): Promise<void> {
  await query(
    `UPDATE retry_budgets
     SET remaining_attempts = max_attempts,
         cooldown_until = NULL,
         reset_at = NOW() + INTERVAL '1 hour'
     WHERE server_name = $1`,
    [serverName]
  )
}

export async function setCooldown(serverName: string, durationMs: number): Promise<void> {
  const cooldownUntil = new Date(Date.now() + durationMs)

  await query(
    `UPDATE retry_budgets
     SET cooldown_until = $2
     WHERE server_name = $1`,
    [serverName, cooldownUntil]
  )

  log.info({ serverName, cooldownUntil }, "Server cooldown set")
}

async function getRetryBudget(serverName: string): Promise<RetryBudget> {
  // Try to get existing budget
  let budget = await queryOne<{
    server_name: string
    remaining_attempts: number
    reset_at: Date
    cooldown_until: Date | null
  }>("SELECT * FROM retry_budgets WHERE server_name = $1", [serverName])

  // Create if doesn't exist
  if (!budget) {
    const result = await query<{
      server_name: string
      remaining_attempts: number
      reset_at: Date
      cooldown_until: Date | null
    }>(
      `INSERT INTO retry_budgets (server_name, max_attempts, remaining_attempts)
       VALUES ($1, $2, $2)
       RETURNING *`,
      [serverName, DEFAULT_CONFIG.maxAttempts]
    )
    const created = result.rows[0]
    if (!created) {
      throw new Error(`Failed to initialize retry budget for ${serverName}`)
    }
    budget = created
  }

  if (!budget) {
    throw new Error(`Retry budget missing for ${serverName}`)
  }

  // Check if budget should reset
  if (budget.reset_at <= new Date()) {
    await resetRetryBudget(serverName)
    budget.remaining_attempts = DEFAULT_CONFIG.maxAttempts
  }

  return {
    serverName: budget.server_name,
    remainingAttempts: budget.remaining_attempts,
    resetAt: budget.reset_at,
    cooldownUntil: budget.cooldown_until,
  }
}

// -----------------------------------------------------------------------------
// Retry Execution
// -----------------------------------------------------------------------------

export async function withRetry<T>(
  serverName: string,
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }

  let lastError: Error | null = null
  let delay = fullConfig.initialDelayMs

  for (let attempt = 1; attempt <= fullConfig.maxAttempts; attempt++) {
    // Check budget
    const hasbudget = await checkRetryBudget(serverName)
    if (!hasbudget) {
      throw new Error(`Retry budget exhausted for ${serverName}`)
    }

    try {
      const result = await operation()
      // Success - reset budget
      await resetRetryBudget(serverName)
      return result
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      log.warn(
        { serverName, attempt, maxAttempts: fullConfig.maxAttempts, error: lastError.message },
        "Operation failed, retrying"
      )

      // Consume budget
      await consumeRetryBudget(serverName)

      // Check if we should continue
      if (attempt >= fullConfig.maxAttempts) {
        break
      }

      // Wait before retry
      const jitter = delay * fullConfig.jitterFactor * (Math.random() - 0.5)
      const actualDelay = Math.min(delay + jitter, fullConfig.maxDelayMs)

      await sleep(actualDelay)

      // Increase delay for next attempt
      delay = Math.min(delay * fullConfig.backoffMultiplier, fullConfig.maxDelayMs)
    }
  }

  // All attempts failed - set cooldown
  await setCooldown(serverName, 60000) // 1 minute cooldown

  throw lastError ?? new Error("All retry attempts failed")
}

// -----------------------------------------------------------------------------
// Circuit Breaker Integration
// -----------------------------------------------------------------------------

interface CircuitState {
  failures: number
  successes: number
  state: "closed" | "open" | "half-open"
  lastFailure: Date | null
  openedAt: Date | null
}

const circuitBreakers = new Map<string, CircuitState>()

const CIRCUIT_THRESHOLD = 5
const CIRCUIT_RESET_MS = 30000

export function getCircuitState(serverName: string): CircuitState {
  if (!circuitBreakers.has(serverName)) {
    circuitBreakers.set(serverName, {
      failures: 0,
      successes: 0,
      state: "closed",
      lastFailure: null,
      openedAt: null,
    })
  }
  return circuitBreakers.get(serverName)!
}

export function recordSuccess(serverName: string): void {
  const state = getCircuitState(serverName)

  if (state.state === "half-open") {
    state.successes++
    if (state.successes >= 2) {
      // Close circuit after 2 successes in half-open
      state.state = "closed"
      state.failures = 0
      state.successes = 0
      state.openedAt = null
      log.info({ serverName }, "Circuit closed")
    }
  } else {
    state.failures = 0
    state.successes++
  }
}

export function recordFailure(serverName: string): void {
  const state = getCircuitState(serverName)
  state.failures++
  state.lastFailure = new Date()

  if (state.state === "half-open") {
    // Failure in half-open reopens circuit
    state.state = "open"
    state.openedAt = new Date()
    log.warn({ serverName }, "Circuit reopened")
  } else if (state.failures >= CIRCUIT_THRESHOLD) {
    state.state = "open"
    state.openedAt = new Date()
    log.warn({ serverName, failures: state.failures }, "Circuit opened")
  }
}

export function isCircuitOpen(serverName: string): boolean {
  const state = getCircuitState(serverName)

  if (state.state === "closed") {
    return false
  }

  if (state.state === "open" && state.openedAt) {
    // Check if we should try half-open
    if (Date.now() - state.openedAt.getTime() >= CIRCUIT_RESET_MS) {
      state.state = "half-open"
      state.successes = 0
      log.info({ serverName }, "Circuit half-open")
      return false
    }
    return true
  }

  return false
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
