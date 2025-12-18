// =============================================================================
// MindOS - Task Workflow (Plan → Policy → Act → Reflect)
// =============================================================================

import * as restate from "@restatedev/restate-sdk"
import { query, queryOne, withTransaction, type TransactionClient } from "../db.js"
import { createLogger } from "../logger.js"
import { recordEvent, searchSemanticMemory, findMatchingSkills, storeSkill } from "../memory.js"
import { complete, completeJson, completeWithTools, type ChatMessage, type ToolDefinition } from "../router.js"
import {
  buildSystemPrompt,
  buildPlannerPrompt,
  buildDecisionPrompt,
  buildReflectionPrompt,
  buildMetacognitivePrompt,
} from "../prompts.js"
import { evaluatePolicy, createApprovalRequest, checkApprovalStatus } from "../policy.js"
import { createEvidence, linkEvidenceToStep } from "../evidence.js"
import { env } from "../config.js"
import type {
  Identity,
  CoreSelf,
  PolicyProfile,
  Tool,
  Action,
  Decision,
  TaskStep,
  TaskOutcome,
  TaskReflection,
  ExecutionPlan,
  PlanStep,
} from "../types.js"
import { listTools, findToolByIntent, callToolIdempotent } from "../tooling/index.js"

const log = createLogger("task-workflow")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface TaskRow {
  task_id: string
  identity_id: string
  goal: string
  context: unknown
  status: string
  priority: number
  risk_score: number | null
  created_at: Date
  started_at: Date | null
  completed_at: Date | null
}

interface TaskStepRow {
  step_id: string
  task_id: string
  sequence: number
  description: string
  action: Action
  result: unknown | null
  evidence_ids: string[]
  started_at: Date | null
  completed_at: Date | null
}

// -----------------------------------------------------------------------------
// Restate Virtual Object: Task
// -----------------------------------------------------------------------------

export const taskObject = restate.object({
  name: "task",
  handlers: {
    /**
     * Execute a task through the Plan→Policy→Act→Reflect loop
     */
    execute: async (
      ctx: restate.ObjectContext,
      params: { identityId: string }
    ): Promise<TaskOutcome> => {
      const taskId = ctx.key

      log.info({ taskId }, "Starting task execution")

      // Load task and identity
      const task = await ctx.run("load-task", () => loadTask(taskId))
      if (!task) {
        throw new restate.TerminalError(`Task not found: ${taskId}`)
      }

      const identity = await ctx.run("load-identity", () => loadIdentity(params.identityId))
      if (!identity) {
        throw new restate.TerminalError(`Identity not found: ${params.identityId}`)
      }

      // Update status to running
      await ctx.run("mark-running", () => updateTaskStatus(taskId, "running"))

      // Get available tools
      const tools = await ctx.run("load-tools", () => listTools())

      // Check for matching skills (procedural memory)
      const matchingSkills = await ctx.run("find-skills", () =>
        findMatchingSkills(params.identityId, task.goal)
      )

      // Retrieve relevant memories
      const memories = await ctx.run("retrieve-memories", () =>
        retrieveRelevantMemories(params.identityId, task.goal)
      )

      // Phase 1: PLAN
      const plan = await ctx.run("create-plan", () =>
        createPlan(identity, task, tools, matchingSkills, memories)
      )

      log.info({ taskId, steps: plan.steps.length, risk: plan.estimated_risk }, "Plan created")

      // Record plan creation
      await ctx.run("record-plan", () =>
        recordEvent(params.identityId, "plan_created", { task_id: taskId, plan })
      )

      // Phase 2: POLICY (pre-check entire plan)
      const planRisk = await ctx.run("assess-plan-risk", () =>
        assessPlanRisk(plan, params.identityId)
      )

      if (planRisk.blocked) {
        log.warn({ taskId, reason: planRisk.reason }, "Plan blocked by policy")
        await ctx.run("mark-blocked", () => updateTaskStatus(taskId, "blocked"))
        return {
          task_id: taskId,
          success: false,
          result: null,
          error: `Plan blocked: ${planRisk.reason}`,
          steps_completed: 0,
          steps_total: plan.steps.length,
        }
      }

      if (planRisk.requiresApproval) {
        log.info({ taskId, risk: planRisk.riskScore }, "Plan requires approval")
        const approvalId = await ctx.run("create-approval", () =>
          createApprovalRequest(taskId, "plan", { kind: "plan", plan } as Action, {
            verdict: "escalate",
            reason: "Plan risk exceeds threshold",
            risk_level: planRisk.riskScore > 0.7 ? "high" : "medium",
            risk_score: planRisk.riskScore,
            requires_approval: true,
            mitigations: [],
            evaluated_at: new Date().toISOString(),
          })
        )

        // Wait for approval using awakeable
        const approval = await ctx.awakeable<{ approved: boolean; approvedBy: string }>()

        // Store approval ID for external resolution
        await ctx.run("store-awakeable", () =>
          storeAwakeableId(taskId, approvalId, approval.id)
        )

        const result = await approval.promise

        if (!result.approved) {
          await ctx.run("mark-rejected", () => updateTaskStatus(taskId, "rejected"))
          return {
            task_id: taskId,
            success: false,
            result: null,
            error: "Plan rejected by human approver",
            steps_completed: 0,
            steps_total: plan.steps.length,
          }
        }
      }

      // Phase 3: ACT (execute steps)
      const executedSteps: TaskStep[] = []
      let stepIndex = 0

      while (stepIndex < plan.steps.length) {
        const planStep = plan.steps[stepIndex]

        // Metacognitive check (every 3 steps or on high-risk actions)
        if (env.ENABLE_METACOGNITION && (stepIndex % 3 === 0 || planStep.risk_factors?.length)) {
          const metacog = await ctx.run(`metacog-${stepIndex}`, () =>
            performMetacognitiveCheck(identity, task.goal, stepIndex, executedSteps)
          )

          if (metacog.recommendedAction === "pause" || metacog.recommendedAction === "ask_human") {
            log.info({ taskId, stepIndex, recommendation: metacog.recommendedAction }, "Metacognitive pause")
            // Could implement pause/resume here
          }

          if (metacog.recommendedAction === "reconsider") {
            log.info({ taskId, stepIndex }, "Reconsidering plan")
            // Could regenerate remaining steps
          }
        }

        // Create step record
        const step = await ctx.run(`create-step-${stepIndex}`, () =>
          createTaskStep(taskId, stepIndex, planStep)
        )

        // Get decision on how to proceed
        const decision = await ctx.run(`decide-${stepIndex}`, () =>
          makeDecision(identity, task.goal, step, executedSteps, tools)
        )

        if (decision.done) {
          // Task complete early
          log.info({ taskId, stepIndex }, "Task completed early")
          await ctx.run(`complete-step-${stepIndex}`, () =>
            completeTaskStep(step.step_id, { success: true, output: decision.final_report })
          )
          executedSteps.push({ ...step, result: { success: true, output: decision.final_report } })
          break
        }

        if (decision.next) {
          // Execute the action
          const action = decision.next

          // Policy check for this specific action
          const actionPolicy = await ctx.run(`policy-${stepIndex}`, () =>
            evaluatePolicy(action, params.identityId)
          )

          if (actionPolicy.verdict === "block") {
            await ctx.run(`fail-step-${stepIndex}`, () =>
              completeTaskStep(step.step_id, {
                success: false,
                error: `Blocked: ${actionPolicy.reason}`,
              })
            )
            executedSteps.push({ ...step, result: { success: false, error: actionPolicy.reason } })
            stepIndex++
            continue
          }

          // Execute the action
          const result = await ctx.run(`execute-${stepIndex}`, () =>
            executeAction(action, params.identityId, taskId, step.step_id)
          )

          // Record evidence
          const evidenceId = await ctx.run(`evidence-${stepIndex}`, () =>
            createEvidence({
              identity_id: params.identityId,
              kind: "tool_call",
              ref: `tool:${action.tool}:${step.step_id}`,
              payload: { action, result },
            })
          )

          // Link evidence to step
          await ctx.run(`link-evidence-${stepIndex}`, () =>
            linkEvidenceToStep(step.step_id, evidenceId)
          )

          // Update step
          await ctx.run(`complete-step-${stepIndex}`, () =>
            completeTaskStep(step.step_id, result)
          )

          executedSteps.push({ ...step, result, evidence_ids: [evidenceId] })
        }

        stepIndex++
      }

      // Phase 4: REFLECT
      const taskSuccess = executedSteps.every((s) => s.result?.success !== false)

      const reflection = await ctx.run("reflect", () =>
        reflect(task.goal, executedSteps, { success: taskSuccess, result: executedSteps })
      )

      // Store learnings
      if (reflection.skill_candidates.length > 0) {
        for (const skillCandidate of reflection.skill_candidates) {
          await ctx.run(`store-skill-${skillCandidate.name}`, () =>
            storeSkill(params.identityId, skillCandidate)
          )
        }
      }

      // Update task status
      await ctx.run("mark-complete", () =>
        updateTaskStatus(taskId, taskSuccess ? "completed" : "failed")
      )

      // Record completion
      await ctx.run("record-completion", () =>
        recordEvent(params.identityId, "task_completed", {
          task_id: taskId,
          success: taskSuccess,
          steps_completed: executedSteps.length,
          reflection: reflection.self_assessment,
        })
      )

      log.info(
        { taskId, success: taskSuccess, steps: executedSteps.length },
        "Task execution complete"
      )

      return {
        task_id: taskId,
        success: taskSuccess,
        result: reflection,
        steps_completed: executedSteps.length,
        steps_total: plan.steps.length,
      }
    },

    /**
     * Get task status and progress
     */
    getStatus: async (
      ctx: restate.ObjectContext
    ): Promise<{ status: string; steps: TaskStep[] }> => {
      const taskId = ctx.key

      const task = await ctx.run("load-task", () => loadTask(taskId))
      const steps = await ctx.run("load-steps", () => loadTaskSteps(taskId))

      return {
        status: task?.status ?? "unknown",
        steps,
      }
    },

    /**
     * Cancel a running task
     */
    cancel: async (
      ctx: restate.ObjectContext,
      params: { reason: string }
    ): Promise<{ cancelled: boolean }> => {
      const taskId = ctx.key

      const task = await ctx.run("load-task", () => loadTask(taskId))

      if (!task || task.status !== "running") {
        return { cancelled: false }
      }

      await ctx.run("mark-cancelled", () => updateTaskStatus(taskId, "cancelled"))

      log.info({ taskId, reason: params.reason }, "Task cancelled")

      return { cancelled: true }
    },
  },
})

// -----------------------------------------------------------------------------
// Planning
// -----------------------------------------------------------------------------

async function createPlan(
  identity: Identity,
  task: TaskRow,
  tools: Tool[],
  skills: Array<{ name: string; description: string }>,
  memories: Array<{ content: string; similarity: number }>
): Promise<ExecutionPlan> {
  const systemPrompt = buildSystemPrompt(identity.core_self, identity.policy_profile, tools)

  // Build context from skills and memories
  const context: Record<string, unknown> = {
    background: task.context,
    available_skills: skills.map((s) => s.name),
    relevant_memories: memories.slice(0, 5).map((m) => m.content),
  }

  const plannerPrompt = buildPlannerPrompt(task.goal, context as any, tools)

  const { data } = await completeJson<ExecutionPlan>({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: plannerPrompt },
    ],
  })

  return data
}

// -----------------------------------------------------------------------------
// Policy Assessment
// -----------------------------------------------------------------------------

async function assessPlanRisk(
  plan: ExecutionPlan,
  identityId: string
): Promise<{ blocked: boolean; requiresApproval: boolean; riskScore: number; reason?: string }> {
  let maxRisk = plan.estimated_risk
  let blocked = false
  let blockReason: string | undefined

  // Assess each step
  for (const step of plan.steps) {
    if (step.tool) {
      const action: Action = {
        kind: "tool_call",
        tool: step.tool,
        parameters: step.parameters ?? {},
        reason: step.description,
      }

      const decision = await evaluatePolicy(action, identityId)

      if (decision.verdict === "block") {
        blocked = true
        blockReason = decision.reason
        break
      }

      maxRisk = Math.max(maxRisk, decision.risk_score)
    }
  }

  return {
    blocked,
    requiresApproval: maxRisk > env.RISK_THRESHOLD_APPROVAL,
    riskScore: maxRisk,
    reason: blockReason,
  }
}

// -----------------------------------------------------------------------------
// Decision Making
// -----------------------------------------------------------------------------

async function makeDecision(
  identity: Identity,
  goal: string,
  currentStep: TaskStep,
  history: TaskStep[],
  tools: Tool[]
): Promise<Decision> {
  const systemPrompt = buildSystemPrompt(identity.core_self, identity.policy_profile, tools)
  const decisionPrompt = buildDecisionPrompt(currentStep, history, goal)

  const { data } = await completeJson<Decision>({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: decisionPrompt },
    ],
  })

  return data
}

// -----------------------------------------------------------------------------
// Action Execution
// -----------------------------------------------------------------------------

async function executeAction(
  action: Action,
  identityId: string,
  taskId: string,
  stepId: string
): Promise<{ success: boolean; output?: unknown; error?: string }> {
  if (action.kind !== "tool_call" || !action.tool) {
    return { success: false, error: "Invalid action type" }
  }

  try {
    const result = await callToolIdempotent(
      action.tool,
      action.parameters ?? {},
      `${taskId}-${stepId}`,
      identityId
    )

    return {
      success: result.success,
      output: result.output,
      error: result.error,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// -----------------------------------------------------------------------------
// Metacognition
// -----------------------------------------------------------------------------

async function performMetacognitiveCheck(
  identity: Identity,
  goal: string,
  stepIndex: number,
  executedSteps: TaskStep[]
): Promise<{
  confidence: number
  recommendedAction: "continue" | "pause" | "reconsider" | "ask_human"
  rationale: string
}> {
  const recentDecisions = executedSteps.slice(-3).map((s) => s.description)
  const concerns = executedSteps
    .filter((s) => s.result?.success === false)
    .map((s) => s.result?.error ?? "Unknown error")

  const metacogPrompt = buildMetacognitivePrompt({
    goal,
    step: stepIndex,
    recentDecisions,
    concerns,
  })

  const { data } = await completeJson<{
    confidence: { score: number }
    recommended_action: "continue" | "pause" | "reconsider" | "ask_human"
    rationale: string
  }>({
    messages: [{ role: "user", content: metacogPrompt }],
  })

  return {
    confidence: data.confidence.score,
    recommendedAction: data.recommended_action,
    rationale: data.rationale,
  }
}

// -----------------------------------------------------------------------------
// Reflection
// -----------------------------------------------------------------------------

async function reflect(
  goal: string,
  steps: TaskStep[],
  outcome: { success: boolean; result: unknown }
): Promise<TaskReflection> {
  const reflectionPrompt = buildReflectionPrompt(goal, steps, outcome)

  const { data } = await completeJson<TaskReflection>({
    messages: [{ role: "user", content: reflectionPrompt }],
  })

  return data
}

// -----------------------------------------------------------------------------
// Database Operations
// -----------------------------------------------------------------------------

async function loadTask(taskId: string): Promise<TaskRow | null> {
  return queryOne<TaskRow>("SELECT * FROM tasks WHERE task_id = $1", [taskId])
}

async function loadIdentity(identityId: string): Promise<Identity | null> {
  const row = await queryOne<{
    identity_id: string
    display_name: string
    core_self: CoreSelf
    policy_profile: PolicyProfile
    metadata: unknown
    created_at: Date
    updated_at: Date
  }>("SELECT * FROM identities WHERE identity_id = $1", [identityId])

  if (!row) return null

  return {
    identity_id: row.identity_id,
    display_name: row.display_name,
    core_self: row.core_self,
    policy_profile: row.policy_profile,
    metadata: row.metadata,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

async function updateTaskStatus(
  taskId: string,
  status: string
): Promise<void> {
  const timestamp = status === "running" ? "started_at" : "completed_at"
  await query(
    `UPDATE tasks SET status = $2, ${timestamp} = NOW() WHERE task_id = $1`,
    [taskId, status]
  )
}

async function createTaskStep(
  taskId: string,
  sequence: number,
  planStep: PlanStep
): Promise<TaskStep> {
  const action: Action = {
    kind: "tool_call",
    tool: planStep.tool,
    parameters: planStep.parameters,
    reason: planStep.description,
  }

  const result = await query<{ step_id: string }>(
    `INSERT INTO task_steps (task_id, sequence, description, action)
     VALUES ($1, $2, $3, $4)
     RETURNING step_id`,
    [taskId, sequence, planStep.description, JSON.stringify(action)]
  )

  return {
    step_id: result.rows[0].step_id,
    task_id: taskId,
    sequence,
    description: planStep.description,
    action,
    result: null,
    evidence_ids: [],
    started_at: new Date().toISOString(),
    completed_at: null,
  }
}

async function completeTaskStep(
  stepId: string,
  result: { success: boolean; output?: unknown; error?: string }
): Promise<void> {
  await query(
    `UPDATE task_steps SET result = $2, completed_at = NOW() WHERE step_id = $1`,
    [stepId, JSON.stringify(result)]
  )
}

async function loadTaskSteps(taskId: string): Promise<TaskStep[]> {
  const rows = await query<TaskStepRow>(
    `SELECT * FROM task_steps WHERE task_id = $1 ORDER BY sequence`,
    [taskId]
  )

  return rows.rows.map((row) => ({
    step_id: row.step_id,
    task_id: row.task_id,
    sequence: row.sequence,
    description: row.description,
    action: row.action,
    result: row.result,
    evidence_ids: row.evidence_ids,
    started_at: row.started_at?.toISOString() ?? null,
    completed_at: row.completed_at?.toISOString() ?? null,
  }))
}

async function storeAwakeableId(
  taskId: string,
  approvalId: string,
  awakeableId: string
): Promise<void> {
  await query(
    `UPDATE approvals SET metadata = metadata || $2::jsonb WHERE approval_id = $1`,
    [approvalId, JSON.stringify({ awakeable_id: awakeableId })]
  )
}

async function retrieveRelevantMemories(
  identityId: string,
  goal: string
): Promise<Array<{ content: string; similarity: number }>> {
  // Would need embedding for the goal - simplified version
  // In production, would call embedding API first
  return []
}
