// =============================================================================
// Approval Workflow System
// =============================================================================

import type pg from "pg"
import type { ApprovalRequest, ApprovalStatus, RiskAssessment, RiskCategory } from "./types.js"

// -----------------------------------------------------------------------------
// Approval Manager Interface
// -----------------------------------------------------------------------------

export interface ApprovalManager {
  requestApproval(input: ApprovalRequestInput): Promise<ApprovalRequest>
  getApproval(approvalId: string): Promise<ApprovalRequest | null>
  getPendingApprovals(taskId?: string): Promise<ApprovalRequest[]>
  approve(approvalId: string, responderId: string, reason?: string): Promise<ApprovalRequest>
  reject(approvalId: string, responderId: string, reason: string): Promise<ApprovalRequest>
  checkExpired(): Promise<string[]>
  waitForApproval(approvalId: string, timeoutMs?: number): Promise<ApprovalRequest>
}

export interface ApprovalRequestInput {
  task_id: string
  step_id?: string
  action_type: string
  action_details: Record<string, unknown>
  risk_assessment: RiskAssessment
  expires_in_ms?: number
}

// -----------------------------------------------------------------------------
// Create Approval Manager
// -----------------------------------------------------------------------------

export function createApprovalManager(pool: pg.Pool): ApprovalManager {
  const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000 // 24 hours

  async function requestApproval(input: ApprovalRequestInput): Promise<ApprovalRequest> {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + (input.expires_in_ms ?? DEFAULT_EXPIRY_MS))

    const request: ApprovalRequest = {
      approval_id: crypto.randomUUID(),
      task_id: input.task_id,
      step_id: input.step_id,
      action_type: input.action_type,
      action_details: input.action_details,
      risk_assessment_id: input.risk_assessment.assessment_id,
      status: "pending",
      requested_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    }

    await pool.query(
      `INSERT INTO approvals (
        approval_id, task_id, step_id, action_type, action_details,
        risk_assessment_id, status, requested_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        request.approval_id,
        request.task_id,
        request.step_id,
        request.action_type,
        JSON.stringify(request.action_details),
        request.risk_assessment_id,
        request.status,
        request.requested_at,
        request.expires_at,
      ]
    )

    // Emit approval request event
    await pool.query(
      `INSERT INTO events (event_id, identity_id, event_type, payload, timestamp)
       SELECT $1, identity_id, 'approval_requested', $2, $3
       FROM tasks WHERE task_id = $4`,
      [
        crypto.randomUUID(),
        JSON.stringify({
          approval_id: request.approval_id,
          action_type: request.action_type,
          risk_level: input.risk_assessment.risk_level,
          expires_at: request.expires_at,
        }),
        now.toISOString(),
        request.task_id,
      ]
    )

    return request
  }

  async function getApproval(approvalId: string): Promise<ApprovalRequest | null> {
    const result = await pool.query("SELECT * FROM approvals WHERE approval_id = $1", [approvalId])

    if (result.rows.length === 0) return null

    return rowToApproval(result.rows[0])
  }

  async function getPendingApprovals(taskId?: string): Promise<ApprovalRequest[]> {
    let query = `SELECT * FROM approvals WHERE status = 'pending'`
    const params: unknown[] = []

    if (taskId) {
      query += " AND task_id = $1"
      params.push(taskId)
    }

    query += " ORDER BY requested_at ASC"

    const result = await pool.query(query, params)
    return result.rows.map(rowToApproval)
  }

  async function approve(
    approvalId: string,
    responderId: string,
    reason?: string
  ): Promise<ApprovalRequest> {
    return updateApprovalStatus(approvalId, "approved", responderId, reason)
  }

  async function reject(
    approvalId: string,
    responderId: string,
    reason: string
  ): Promise<ApprovalRequest> {
    return updateApprovalStatus(approvalId, "rejected", responderId, reason)
  }

  async function updateApprovalStatus(
    approvalId: string,
    status: ApprovalStatus,
    responderId: string,
    reason?: string
  ): Promise<ApprovalRequest> {
    const now = new Date().toISOString()

    await pool.query(
      `UPDATE approvals SET
        status = $1,
        responded_at = $2,
        responder_id = $3,
        response_reason = $4
       WHERE approval_id = $5`,
      [status, now, responderId, reason, approvalId]
    )

    const result = await pool.query("SELECT * FROM approvals WHERE approval_id = $1", [approvalId])

    if (result.rows.length === 0) {
      throw new Error(`Approval ${approvalId} not found`)
    }

    const approval = rowToApproval(result.rows[0])

    // Emit approval response event
    await pool.query(
      `INSERT INTO events (event_id, identity_id, event_type, payload, timestamp)
       SELECT $1, identity_id, $2, $3, $4
       FROM tasks WHERE task_id = $5`,
      [
        crypto.randomUUID(),
        status === "approved" ? "approval_granted" : "approval_denied",
        JSON.stringify({
          approval_id: approvalId,
          status,
          responder_id: responderId,
          reason,
        }),
        now,
        approval.task_id,
      ]
    )

    return approval
  }

  async function checkExpired(): Promise<string[]> {
    const now = new Date().toISOString()

    // Find and update expired approvals
    const result = await pool.query(
      `UPDATE approvals SET status = 'expired'
       WHERE status = 'pending' AND expires_at < $1
       RETURNING approval_id`,
      [now]
    )

    const expiredIds = result.rows.map((r) => r.approval_id)

    // Emit expiry events
    for (const approvalId of expiredIds) {
      const approval = await getApproval(approvalId)
      if (approval) {
        await pool.query(
          `INSERT INTO events (event_id, identity_id, event_type, payload, timestamp)
           SELECT $1, identity_id, 'approval_expired', $2, $3
           FROM tasks WHERE task_id = $4`,
          [crypto.randomUUID(), JSON.stringify({ approval_id: approvalId }), now, approval.task_id]
        )
      }
    }

    return expiredIds
  }

  async function waitForApproval(approvalId: string, timeoutMs = 60000): Promise<ApprovalRequest> {
    const startTime = Date.now()
    const pollInterval = 1000

    while (Date.now() - startTime < timeoutMs) {
      const approval = await getApproval(approvalId)

      if (!approval) {
        throw new Error(`Approval ${approvalId} not found`)
      }

      if (approval.status !== "pending") {
        return approval
      }

      // Check if expired
      if (new Date(approval.expires_at) < new Date()) {
        await pool.query(`UPDATE approvals SET status = 'expired' WHERE approval_id = $1`, [
          approvalId,
        ])
        return { ...approval, status: "expired" }
      }

      // Poll wait
      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    }

    throw new Error(`Timeout waiting for approval ${approvalId}`)
  }

  function rowToApproval(row: Record<string, unknown>): ApprovalRequest {
    return {
      approval_id: row.approval_id as string,
      task_id: row.task_id as string,
      step_id: row.step_id as string | undefined,
      action_type: row.action_type as string,
      action_details: row.action_details as Record<string, unknown>,
      risk_assessment_id: row.risk_assessment_id as string,
      status: row.status as ApprovalStatus,
      requested_at: row.requested_at as string,
      responded_at: row.responded_at as string | undefined,
      responder_id: row.responder_id as string | undefined,
      response_reason: row.response_reason as string | undefined,
      expires_at: row.expires_at as string,
    }
  }

  return {
    requestApproval,
    getApproval,
    getPendingApprovals,
    approve,
    reject,
    checkExpired,
    waitForApproval,
  }
}

// -----------------------------------------------------------------------------
// Auto-Approval Rules
// -----------------------------------------------------------------------------

export interface AutoApprovalRule {
  rule_id: string
  name: string
  condition: AutoApprovalCondition
  enabled: boolean
}

export interface AutoApprovalCondition {
  max_risk_score?: number
  allowed_action_types?: string[]
  allowed_categories?: string[]
  time_window?: { start: number; end: number }
}

export function createAutoApprovalEvaluator(rules: AutoApprovalRule[]) {
  return function shouldAutoApprove(assessment: RiskAssessment, actionType: string): boolean {
    for (const rule of rules) {
      if (!rule.enabled) continue

      const condition = rule.condition

      // Check risk score
      if (condition.max_risk_score !== undefined) {
        if (assessment.risk_score > condition.max_risk_score) continue
      }

      // Check action type
      if (condition.allowed_action_types && condition.allowed_action_types.length > 0) {
        if (!condition.allowed_action_types.includes(actionType)) continue
      }

      // Check categories
      if (condition.allowed_categories && condition.allowed_categories.length > 0) {
        const hasMatchingCategory = assessment.categories.some((c: RiskCategory) =>
          condition.allowed_categories?.includes(c)
        )
        if (!hasMatchingCategory) continue
      }

      // Check time window (hour of day)
      if (condition.time_window) {
        const currentHour = new Date().getHours()
        if (currentHour < condition.time_window.start || currentHour >= condition.time_window.end) {
          continue
        }
      }

      // All conditions passed - auto-approve
      return true
    }

    return false
  }
}
