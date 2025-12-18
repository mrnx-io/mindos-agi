// =============================================================================
// MindOS - Policy Engine
// =============================================================================

import { query, queryOne } from "./db.js"
import { env } from "./config.js"
import { createLogger } from "./logger.js"
import type {
  Action,
  PolicyDecision,
  PolicyProfile,
  RiskAssessment,
  PolicyVerdict,
  RiskLevel,
} from "./types.js"

const log = createLogger("policy")

// -----------------------------------------------------------------------------
// Hard-Stop Keywords (Immediate Block)
// -----------------------------------------------------------------------------

const HARD_STOP_PATTERNS = [
  // Destructive operations
  /\brm\s+-rf\s+\/\b/i,
  /\bdrop\s+database\b/i,
  /\btruncate\s+table\b/i,
  /\bformat\s+c:/i,
  /\bdel\s+\/s\s+\/q\b/i,

  // Credential exposure
  /\bpassword\s*[:=]\s*['"][^'"]+['"]/i,
  /\bapi[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,
  /\bsecret\s*[:=]\s*['"][^'"]+['"]/i,

  // Network attacks
  /\b(curl|wget)\s+.*\|\s*sh\b/i,
  /\beval\s*\(\s*(curl|wget)/i,

  // Privilege escalation
  /\bsudo\s+su\b/i,
  /\bchmod\s+777\b/i,
  /\bchown\s+root\b/i,
]

// -----------------------------------------------------------------------------
// Risk Categories
// -----------------------------------------------------------------------------

const RISK_WEIGHTS: Record<string, number> = {
  // Tool categories
  "tool:file:read": 0.1,
  "tool:file:write": 0.4,
  "tool:file:delete": 0.7,
  "tool:network:get": 0.2,
  "tool:network:post": 0.4,
  "tool:network:auth": 0.6,
  "tool:exec:sandbox": 0.3,
  "tool:exec:system": 0.8,
  "tool:db:read": 0.2,
  "tool:db:write": 0.5,
  "tool:db:admin": 0.9,

  // Data sensitivity
  "data:public": 0.0,
  "data:internal": 0.2,
  "data:confidential": 0.5,
  "data:pii": 0.7,
  "data:credentials": 0.9,

  // Action scope
  "scope:local": 0.1,
  "scope:project": 0.3,
  "scope:system": 0.6,
  "scope:external": 0.8,

  // Reversibility
  "reversible:instant": 0.0,
  "reversible:easy": 0.1,
  "reversible:difficult": 0.4,
  "reversible:impossible": 0.8,
}

// -----------------------------------------------------------------------------
// Policy Evaluation
// -----------------------------------------------------------------------------

export async function evaluatePolicy(
  action: Action,
  identityId: string
): Promise<PolicyDecision> {
  const startTime = Date.now()

  // Load policy profile for this identity
  const profile = await loadPolicyProfile(identityId)

  // Check hard stops first
  const hardStopResult = checkHardStops(action)
  if (hardStopResult.blocked) {
    log.warn({ action, reason: hardStopResult.reason }, "Action blocked by hard stop")
    return {
      verdict: "block",
      reason: hardStopResult.reason!,
      risk_level: "critical",
      risk_score: 1.0,
      requires_approval: false,
      mitigations: [],
      evaluated_at: new Date().toISOString(),
    }
  }

  // Calculate risk score
  const riskAssessment = assessRisk(action, profile)

  // Determine verdict based on thresholds
  const verdict = determineVerdict(riskAssessment.score, profile)

  // Generate mitigations if needed
  const mitigations =
    verdict !== "allow" ? generateMitigations(action, riskAssessment) : []

  const decision: PolicyDecision = {
    verdict,
    reason: riskAssessment.summary,
    risk_level: riskAssessment.level,
    risk_score: riskAssessment.score,
    requires_approval: verdict === "escalate",
    mitigations,
    evaluated_at: new Date().toISOString(),
  }

  log.info(
    {
      action: action.kind,
      verdict,
      risk_score: riskAssessment.score,
      duration_ms: Date.now() - startTime,
    },
    "Policy evaluated"
  )

  return decision
}

// -----------------------------------------------------------------------------
// Hard Stop Check
// -----------------------------------------------------------------------------

function checkHardStops(action: Action): { blocked: boolean; reason?: string } {
  // Check action content against hard stop patterns
  const content = JSON.stringify(action)

  for (const pattern of HARD_STOP_PATTERNS) {
    if (pattern.test(content)) {
      return {
        blocked: true,
        reason: `Hard stop triggered: ${pattern.source}`,
      }
    }
  }

  // Check specific high-risk tool calls
  if (action.kind === "tool_call" && action.tool) {
    const tool = action.tool.toLowerCase()

    // Block certain tools entirely
    const blockedTools = ["system_exec_privileged", "db_admin_drop", "network_proxy"]
    if (blockedTools.includes(tool)) {
      return {
        blocked: true,
        reason: `Blocked tool: ${tool}`,
      }
    }
  }

  return { blocked: false }
}

// -----------------------------------------------------------------------------
// Risk Assessment
// -----------------------------------------------------------------------------

function assessRisk(action: Action, profile: PolicyProfile): RiskAssessment {
  const factors: Array<{ factor: string; weight: number; score: number }> = []

  // Tool category risk
  if (action.kind === "tool_call" && action.tool) {
    const toolRisk = getToolRisk(action.tool)
    factors.push({ factor: "tool_category", weight: 0.3, score: toolRisk })
  }

  // Data sensitivity
  const dataSensitivity = assessDataSensitivity(action)
  factors.push({ factor: "data_sensitivity", weight: 0.25, score: dataSensitivity })

  // Scope assessment
  const scopeRisk = assessScope(action)
  factors.push({ factor: "scope", weight: 0.2, score: scopeRisk })

  // Reversibility
  const reversibilityRisk = assessReversibility(action)
  factors.push({ factor: "reversibility", weight: 0.15, score: reversibilityRisk })

  // Historical success rate (if available)
  const historicalRisk = profile.historical_success_rate
    ? 1 - profile.historical_success_rate
    : 0.5
  factors.push({ factor: "historical", weight: 0.1, score: historicalRisk })

  // Calculate weighted score
  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0)
  const weightedScore = factors.reduce((sum, f) => sum + f.weight * f.score, 0) / totalWeight

  // Apply profile modifiers
  const modifiedScore = applyProfileModifiers(weightedScore, profile)

  // Determine risk level
  const level = scoreToLevel(modifiedScore)

  return {
    score: modifiedScore,
    level,
    factors,
    summary: generateRiskSummary(action, factors, level),
  }
}

function getToolRisk(tool: string): number {
  // Map tool name to risk category
  const toolLower = tool.toLowerCase()

  if (toolLower.includes("read") || toolLower.includes("get") || toolLower.includes("list")) {
    return 0.1
  }
  if (toolLower.includes("write") || toolLower.includes("create") || toolLower.includes("update")) {
    return 0.4
  }
  if (toolLower.includes("delete") || toolLower.includes("remove")) {
    return 0.7
  }
  if (toolLower.includes("exec") || toolLower.includes("run") || toolLower.includes("shell")) {
    return 0.6
  }
  if (toolLower.includes("admin") || toolLower.includes("privileged")) {
    return 0.9
  }

  return 0.5 // Unknown tool, moderate risk
}

function assessDataSensitivity(action: Action): number {
  const content = JSON.stringify(action).toLowerCase()

  if (content.includes("password") || content.includes("secret") || content.includes("token")) {
    return RISK_WEIGHTS["data:credentials"]
  }
  if (content.includes("email") || content.includes("phone") || content.includes("ssn")) {
    return RISK_WEIGHTS["data:pii"]
  }
  if (content.includes("internal") || content.includes("private")) {
    return RISK_WEIGHTS["data:internal"]
  }

  return RISK_WEIGHTS["data:public"]
}

function assessScope(action: Action): number {
  // Determine the scope of the action
  if (action.kind === "tool_call") {
    const tool = action.tool?.toLowerCase() ?? ""

    if (tool.includes("external") || tool.includes("api") || tool.includes("http")) {
      return RISK_WEIGHTS["scope:external"]
    }
    if (tool.includes("system") || tool.includes("os")) {
      return RISK_WEIGHTS["scope:system"]
    }
    if (tool.includes("project") || tool.includes("repo")) {
      return RISK_WEIGHTS["scope:project"]
    }
  }

  return RISK_WEIGHTS["scope:local"]
}

function assessReversibility(action: Action): number {
  if (action.kind === "tool_call") {
    const tool = action.tool?.toLowerCase() ?? ""

    if (tool.includes("delete") || tool.includes("drop") || tool.includes("truncate")) {
      return RISK_WEIGHTS["reversible:impossible"]
    }
    if (tool.includes("update") || tool.includes("modify")) {
      return RISK_WEIGHTS["reversible:difficult"]
    }
    if (tool.includes("write") || tool.includes("create")) {
      return RISK_WEIGHTS["reversible:easy"]
    }
    if (tool.includes("read") || tool.includes("get")) {
      return RISK_WEIGHTS["reversible:instant"]
    }
  }

  return RISK_WEIGHTS["reversible:easy"]
}

function applyProfileModifiers(score: number, profile: PolicyProfile): number {
  let modified = score

  // Apply trust level modifier
  if (profile.trust_level === "high") {
    modified *= 0.8
  } else if (profile.trust_level === "low") {
    modified *= 1.2
  }

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, modified))
}

function scoreToLevel(score: number): RiskLevel {
  if (score >= 0.9) return "critical"
  if (score >= 0.7) return "high"
  if (score >= 0.4) return "medium"
  if (score >= 0.2) return "low"
  return "minimal"
}

function generateRiskSummary(
  action: Action,
  factors: Array<{ factor: string; weight: number; score: number }>,
  level: RiskLevel
): string {
  const topFactors = factors
    .sort((a, b) => b.score * b.weight - a.score * a.weight)
    .slice(0, 2)
    .map((f) => f.factor)
    .join(", ")

  return `${level} risk action (${action.kind}). Top risk factors: ${topFactors}`
}

// -----------------------------------------------------------------------------
// Verdict Determination
// -----------------------------------------------------------------------------

function determineVerdict(score: number, profile: PolicyProfile): PolicyVerdict {
  const autoThreshold = profile.auto_approve_threshold ?? env.RISK_THRESHOLD_AUTO
  const approvalThreshold = profile.approval_threshold ?? env.RISK_THRESHOLD_APPROVAL
  const blockThreshold = profile.block_threshold ?? env.RISK_THRESHOLD_BLOCK

  if (score >= blockThreshold) return "block"
  if (score >= approvalThreshold) return "escalate"
  if (score >= autoThreshold) return "allow_with_logging"
  return "allow"
}

// -----------------------------------------------------------------------------
// Mitigations
// -----------------------------------------------------------------------------

function generateMitigations(
  action: Action,
  assessment: RiskAssessment
): string[] {
  const mitigations: string[] = []

  if (assessment.score >= 0.7) {
    mitigations.push("Request explicit human approval before execution")
    mitigations.push("Create checkpoint/backup before proceeding")
  }

  if (action.kind === "tool_call") {
    mitigations.push("Execute in sandbox with limited permissions")
    mitigations.push("Enable detailed audit logging")
  }

  if (assessment.factors.some((f) => f.factor === "data_sensitivity" && f.score >= 0.5)) {
    mitigations.push("Mask or redact sensitive data in logs")
  }

  if (assessment.factors.some((f) => f.factor === "reversibility" && f.score >= 0.6)) {
    mitigations.push("Prepare rollback plan before execution")
  }

  return mitigations
}

// -----------------------------------------------------------------------------
// Policy Profile Loading
// -----------------------------------------------------------------------------

async function loadPolicyProfile(identityId: string): Promise<PolicyProfile> {
  const row = await queryOne<{ policy_profile: PolicyProfile }>(
    "SELECT policy_profile FROM identities WHERE identity_id = $1",
    [identityId]
  )

  if (!row) {
    // Return default profile
    return {
      trust_level: "medium",
      auto_approve_threshold: env.RISK_THRESHOLD_AUTO,
      approval_threshold: env.RISK_THRESHOLD_APPROVAL,
      block_threshold: env.RISK_THRESHOLD_BLOCK,
      allowed_tools: [],
      blocked_tools: [],
    }
  }

  return row.policy_profile
}

// -----------------------------------------------------------------------------
// Approval Management
// -----------------------------------------------------------------------------

export async function createApprovalRequest(
  taskId: string,
  stepId: string,
  action: Action,
  decision: PolicyDecision
): Promise<string> {
  const result = await query<{ approval_id: string }>(
    `INSERT INTO approvals (task_id, step_id, action, risk_score, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING approval_id`,
    [taskId, stepId, JSON.stringify(action), decision.risk_score]
  )

  log.info({ approvalId: result.rows[0].approval_id, taskId, stepId }, "Approval request created")
  return result.rows[0].approval_id
}

export async function checkApprovalStatus(
  approvalId: string
): Promise<{ status: "pending" | "approved" | "rejected"; approved_by?: string }> {
  const row = await queryOne<{
    status: "pending" | "approved" | "rejected"
    approved_by: string | null
  }>("SELECT status, approved_by FROM approvals WHERE approval_id = $1", [approvalId])

  if (!row) {
    throw new Error(`Approval not found: ${approvalId}`)
  }

  return {
    status: row.status,
    approved_by: row.approved_by ?? undefined,
  }
}

export async function processApproval(
  approvalId: string,
  approved: boolean,
  approvedBy: string
): Promise<void> {
  await query(
    `UPDATE approvals
     SET status = $2, approved_by = $3, resolved_at = NOW()
     WHERE approval_id = $1`,
    [approvalId, approved ? "approved" : "rejected", approvedBy]
  )

  log.info({ approvalId, approved, approvedBy }, "Approval processed")
}
