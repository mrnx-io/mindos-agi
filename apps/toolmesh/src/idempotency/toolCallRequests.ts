// =============================================================================
// MindOS - Idempotent Tool Call Requests (Single-Flight)
// =============================================================================

import { query, queryOne } from "../db.js"
import { createLogger } from "../logger.js"

const log = createLogger("idempotency")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ToolCallRequest {
  requestId: string
  idempotencyKey: string
  toolName: string
  parameters: Record<string, unknown>
  identityId: string
  status: "pending" | "in_flight" | "completed" | "failed"
  result?: unknown
  error?: string
  createdAt: string
  completedAt?: string
}

interface RequestRow {
  request_id: string
  idempotency_key: string
  tool_name: string
  parameters: unknown
  identity_id: string
  status: string
  result: unknown | null
  error: string | null
  created_at: Date
  completed_at: Date | null
}

// -----------------------------------------------------------------------------
// Single-Flight Coordination
// -----------------------------------------------------------------------------

/**
 * Acquire a lock for an idempotent tool call.
 * Returns existing result if already completed, or null if this caller should execute.
 */
export async function acquireOrWait(
  idempotencyKey: string,
  toolName: string,
  parameters: Record<string, unknown>,
  identityId: string
): Promise<{ shouldExecute: boolean; existingResult?: ToolCallRequest }> {
  // Try to insert a new pending request
  // If key already exists, return existing
  const result = await query<RequestRow>(
    `INSERT INTO tool_call_requests (idempotency_key, tool_name, parameters, identity_id, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (idempotency_key) DO UPDATE
     SET updated_at = NOW()
     RETURNING *`,
    [idempotencyKey, toolName, JSON.stringify(parameters), identityId]
  )

  const row = result.rows[0]

  // Check if this was an existing request
  if (row.status === "completed") {
    log.info({ idempotencyKey }, "Returning cached result")
    return {
      shouldExecute: false,
      existingResult: rowToRequest(row),
    }
  }

  if (row.status === "failed") {
    log.info({ idempotencyKey }, "Previous attempt failed, allowing retry")
    // Allow retry of failed requests
    await query(`UPDATE tool_call_requests SET status = 'pending' WHERE idempotency_key = $1`, [
      idempotencyKey,
    ])
    return { shouldExecute: true }
  }

  if (row.status === "in_flight") {
    // Another process is executing - wait for it
    log.info({ idempotencyKey }, "Request in flight, waiting")
    const completed = await waitForCompletion(idempotencyKey, 30000) // 30s timeout
    if (completed) {
      return {
        shouldExecute: false,
        existingResult: completed,
      }
    }
    // Timeout - take over
    log.warn({ idempotencyKey }, "Timeout waiting for in-flight request, taking over")
  }

  // Mark as in-flight
  await query(`UPDATE tool_call_requests SET status = 'in_flight' WHERE idempotency_key = $1`, [
    idempotencyKey,
  ])

  return { shouldExecute: true }
}

/**
 * Mark a request as completed with result.
 */
export async function markCompleted(idempotencyKey: string, result: unknown): Promise<void> {
  await query(
    `UPDATE tool_call_requests
     SET status = 'completed', result = $2, completed_at = NOW()
     WHERE idempotency_key = $1`,
    [idempotencyKey, JSON.stringify(result)]
  )

  log.info({ idempotencyKey }, "Request marked completed")
}

/**
 * Mark a request as failed.
 */
export async function markFailed(idempotencyKey: string, error: string): Promise<void> {
  await query(
    `UPDATE tool_call_requests
     SET status = 'failed', error = $2, completed_at = NOW()
     WHERE idempotency_key = $1`,
    [idempotencyKey, error]
  )

  log.info({ idempotencyKey, error }, "Request marked failed")
}

/**
 * Get request by idempotency key.
 */
export async function getRequest(idempotencyKey: string): Promise<ToolCallRequest | null> {
  const row = await queryOne<RequestRow>(
    "SELECT * FROM tool_call_requests WHERE idempotency_key = $1",
    [idempotencyKey]
  )

  return row ? rowToRequest(row) : null
}

// -----------------------------------------------------------------------------
// Wait for Completion
// -----------------------------------------------------------------------------

async function waitForCompletion(
  idempotencyKey: string,
  timeoutMs: number
): Promise<ToolCallRequest | null> {
  const startTime = Date.now()
  const pollInterval = 100 // 100ms

  while (Date.now() - startTime < timeoutMs) {
    const request = await getRequest(idempotencyKey)

    if (request?.status === "completed" || request?.status === "failed") {
      return request
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval))
  }

  return null
}

// -----------------------------------------------------------------------------
// Cleanup
// -----------------------------------------------------------------------------

/**
 * Clean up old completed requests.
 */
export async function cleanupOldRequests(olderThanHours = 24): Promise<number> {
  const result = await query(
    `DELETE FROM tool_call_requests
     WHERE status IN ('completed', 'failed')
       AND completed_at < NOW() - INTERVAL '${olderThanHours} hours'`
  )

  const deleted = result.rowCount ?? 0
  if (deleted > 0) {
    log.info({ deleted }, "Cleaned up old requests")
  }

  return deleted
}

/**
 * Reset stuck in-flight requests.
 */
export async function resetStuckRequests(olderThanMinutes = 5): Promise<number> {
  const result = await query(
    `UPDATE tool_call_requests
     SET status = 'pending'
     WHERE status = 'in_flight'
       AND created_at < NOW() - INTERVAL '${olderThanMinutes} minutes'`
  )

  const reset = result.rowCount ?? 0
  if (reset > 0) {
    log.warn({ reset }, "Reset stuck in-flight requests")
  }

  return reset
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function rowToRequest(row: RequestRow): ToolCallRequest {
  return {
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    toolName: row.tool_name,
    parameters: row.parameters as Record<string, unknown>,
    identityId: row.identity_id,
    status: row.status as ToolCallRequest["status"],
    result: row.result,
    error: row.error ?? undefined,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
  }
}
