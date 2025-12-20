// =============================================================================
// MindOS - Task Workflow (Plan → Policy → Act → Reflect)
// =============================================================================

import * as restate from "@restatedev/restate-sdk"
import { env } from "../config.js"
import { query, queryOne } from "../db.js"
import { createEvidence, linkEvidenceToStep } from "../evidence.js"
import { createLogger } from "../logger.js"
import { findMatchingSkills, recordEvent, searchSemanticMemory, storeSkill } from "../memory.js"
import { createApprovalRequest, evaluatePolicy } from "../policy.js"
import {
  buildDecisionPrompt,
  buildMetacognitivePrompt,
  buildPlannerPrompt,
  buildReflectionPrompt,
  buildSystemPrompt,
} from "../prompts.js"
import { completeJson } from "../router.js"
import {
  type ToolRoutingRequirements,
  callToolIdempotent,
  createDiscoveryContext,
  discoverInitialTools,
  dispatchTool,
  ensureToolDiscovered,
  extractFactualClaims,
  generateEmbedding,
  getDiscoveryStats,
  handleProactiveDiscovery,
  verifyClaim,
} from "../tooling/index.js"
import { swarmClient } from "../tooling/swarmClient.js"
import type {
  Action,
  CoreSelf,
  Decision,
  ExecutionContext,
  ExecutionPlan,
  Identity,
  PlanStep,
  PolicyProfile,
  StepKind,
  TaskOutcome,
  TaskReflection,
  TaskStatus,
  TaskStep,
  Tool,
} from "../types.js"
import { getHistoricalContext } from "../worldModel/historicalAnalysis.js"
import {
  type Checkpoint,
  type CounterfactualAnalysis,
  type SimulationResult,
  type WorldState,
  createWorldModelService,
} from "../worldModel/index.js"

const log = createLogger("task-workflow")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Type guard to check if action has args (full Action type vs schema subset)
 */
function isFullAction(action: TaskStep["action"]): action is Action {
  return action !== undefined && "args" in action
}

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
// Helper Functions for Task Execution
// -----------------------------------------------------------------------------

/**
 * Initialize task execution: load task/identity, update status
 */
async function initializeTaskExecution(
  ctx: restate.ObjectContext,
  taskId: string,
  identityId: string
): Promise<{ task: TaskRow; identity: Identity }> {
  log.info({ taskId }, "Starting task execution")

  // Load task and identity
  const task = await ctx.run("load-task", () => loadTask(taskId))
  if (!task) {
    throw new restate.TerminalError(`Task not found: ${taskId}`)
  }

  const identity = await ctx.run("load-identity", () => loadIdentity(identityId))
  if (!identity) {
    throw new restate.TerminalError(`Identity not found: ${identityId}`)
  }

  // Update status to running
  await ctx.run("mark-running", () => updateTaskStatus(taskId, "running"))

  return { task, identity }
}

/**
 * Setup on-demand tool discovery based on task goal
 */
async function setupToolDiscovery(
  ctx: restate.ObjectContext,
  taskId: string,
  goal: string
): Promise<{
  discoveryCtx: ReturnType<typeof createDiscoveryContext>
  initialTools: Tool[]
}> {
  const discoveryCtx = createDiscoveryContext(goal, {
    initialTopK: env.TOOL_DISCOVERY_INITIAL_K,
    enableProactive: env.ENABLE_PROACTIVE_TOOL_DISCOVERY,
  })

  const initialTools = await ctx.run("discover-tools", () => discoverInitialTools(discoveryCtx))

  const discoveryStats = getDiscoveryStats(discoveryCtx)
  log.info(
    {
      taskId,
      discovered: discoveryStats.totalDiscovered,
      tokensSaved: discoveryStats.estimatedTokensSaved,
      goal: goal.slice(0, 50),
    },
    "Initial tool discovery complete"
  )

  return { discoveryCtx, initialTools }
}

/**
 * Create execution plan with skills and memories
 */
async function createExecutionPlan(
  ctx: restate.ObjectContext,
  taskId: string,
  identity: Identity,
  task: TaskRow,
  tools: Tool[],
  identityId: string
): Promise<{
  plan: ExecutionPlan
  skills: Array<{ name: string; description: string }>
  memories: Array<{ content: string; similarity: number }>
}> {
  // Check for matching skills (procedural memory)
  const skills = await ctx.run("find-skills", () => findMatchingSkills(identityId, task.goal))

  // Retrieve relevant memories
  const memories = await ctx.run("retrieve-memories", () =>
    retrieveRelevantMemories(identityId, task.goal)
  )

  // Phase 1: PLAN
  const plan = await ctx.run("create-plan", () =>
    createPlan(identity, task, tools, skills, memories)
  )

  log.info({ taskId, steps: plan.steps.length, risk: plan.estimated_risk }, "Plan created")

  return { plan, skills, memories }
}

/**
 * Run world model simulation on the plan
 */
async function runWorldModelSimulation(
  ctx: restate.ObjectContext,
  taskId: string,
  plan: ExecutionPlan,
  identityId: string
): Promise<{
  worldState: WorldState
  planSimulation: SimulationResult
  checkpoints: Checkpoint[]
}> {
  const worldModel = createWorldModelService()
  const checkpoints: Checkpoint[] = []

  // Get historical context for better predictions
  const historicalContext = await ctx.run("get-historical-context", () =>
    getHistoricalContext(identityId, plan.steps.map((s) => s.description).join("; "))
  )

  // Apply historical warnings
  if (historicalContext.warnings.length > 0) {
    log.warn({ taskId, warnings: historicalContext.warnings }, "Historical context warnings")
  }

  // Capture current world state
  const worldState = await ctx.run("capture-world-state", () =>
    worldModel.captureCurrentState(identityId)
  )

  // Convert ExecutionPlan.steps to PlanAction[] for simulation
  const planActions = plan.steps.map((step) => {
    const planAction: {
      description: string
      tool?: string
      parameters?: Record<string, unknown>
      risk_factors?: string[]
    } = {
      description: step.description,
    }
    if (step.tool) planAction.tool = step.tool
    if (step.parameters) planAction.parameters = step.parameters
    if (step.risk_factors) planAction.risk_factors = step.risk_factors
    return planAction
  })

  // Simulate the full plan
  const planSimulation = await ctx.run("simulate-plan", () =>
    worldModel.simulatePlan(planActions, worldState)
  )

  log.info(
    {
      taskId,
      overall_confidence: planSimulation.overall_confidence,
      identified_risks: planSimulation.identified_risks.length,
    },
    "Plan simulation complete"
  )

  // Create checkpoints before high-risk steps (based on identified risks)
  const highRiskSteps = planSimulation.identified_risks.filter(
    (r) => r.severity >= env.WORLD_MODEL_CHECKPOINT_THRESHOLD
  )

  if (highRiskSteps.length > 0) {
    for (const riskStep of highRiskSteps) {
      const checkpoint = await ctx.run(`create-checkpoint-${riskStep.step_index}`, () =>
        worldModel.createCheckpoint(
          taskId,
          riskStep.step_index,
          worldState,
          riskStep.severity,
          true // is_irreversible_next
        )
      )
      checkpoints.push(checkpoint)
    }

    log.info({ taskId, checkpointCount: checkpoints.length }, "Created pre-execution checkpoints")
  }

  return { worldState, planSimulation, checkpoints }
}

/**
 * Check if task should be delegated to swarm
 */
async function checkSwarmDelegation(
  ctx: restate.ObjectContext,
  taskId: string,
  plan: ExecutionPlan,
  identityId: string,
  task: TaskRow
): Promise<TaskOutcome | null> {
  const delegationDecision = await ctx.run("check-swarm-delegation", () =>
    swarmClient.shouldDelegateToSwarm(plan, identityId)
  )

  if (!delegationDecision.shouldDelegate) {
    return null
  }

  log.info(
    {
      taskId,
      reason: delegationDecision.reason,
      suggestedSwarmSize: delegationDecision.suggestedSwarmSize,
    },
    "Delegating task to swarm"
  )

  // Delegate to swarm and wait for result
  const delegationResult = await ctx.run("delegate-to-swarm", async () => {
    const response = await swarmClient.requestDelegation({
      task_id: taskId,
      goal: task.goal,
      plan,
      required_capabilities: delegationDecision.requiredCapabilities ?? [],
      priority: task.priority >= 8 ? "critical" : task.priority >= 5 ? "high" : "medium",
      estimated_duration_ms: plan.steps.length * 30000, // Rough estimate
      risk_level: plan.estimated_risk,
    })

    // Wait for completion
    return swarmClient.waitForDelegationResult(response.delegation_id)
  })

  // Record completion and return
  await ctx.run("record-swarm-completion", () =>
    recordEvent(identityId, "task_delegated", {
      task_id: taskId,
      delegation_id: delegationResult.delegation_id,
      status: delegationResult.status,
    })
  )

  await ctx.run("mark-complete-swarm", () =>
    updateTaskStatus(taskId, delegationResult.status === "completed" ? "completed" : "failed")
  )

  return {
    status: delegationResult.status === "completed" ? "done" : "failed",
    summary: `Task delegated to swarm. Status: ${delegationResult.status}`,
    evidence_ids: [],
  }
}

/**
 * Setup proactive tool discovery based on plan steps
 */
async function setupProactiveDiscovery(
  ctx: restate.ObjectContext,
  taskId: string,
  plan: ExecutionPlan,
  discoveryCtx: ReturnType<typeof createDiscoveryContext>,
  tools: Tool[]
): Promise<Tool[]> {
  // Extract tool intents from plan steps
  const planToolIntents = plan.steps
    .filter((step) => step.tool && !discoveryCtx.discoveredTools.has(step.tool))
    .map((step) => ({
      capability: step.tool ?? step.description,
      reason: "Required by plan step",
      priority: "high" as const,
    }))

  if (planToolIntents.length === 0) {
    return tools
  }

  const proactiveTools = await ctx.run("proactive-discovery", () =>
    handleProactiveDiscovery(discoveryCtx, planToolIntents)
  )

  if (proactiveTools.length === 0) {
    return tools
  }

  const updatedTools = [...tools, ...proactiveTools]
  log.info(
    {
      taskId,
      newTools: proactiveTools.map((t) => t.name),
      totalTools: updatedTools.length,
    },
    "Added tools via proactive discovery"
  )

  return updatedTools
}

/**
 * Perform world model lookahead analysis for a step
 */
async function performWorldModelLookahead(
  ctx: restate.ObjectContext,
  taskId: string,
  stepIndex: number,
  plan: ExecutionPlan,
  worldState: WorldState,
  planSimulation: SimulationResult | null,
  checkpoints: Checkpoint[]
): Promise<void> {
  const worldModel = createWorldModelService()

  // Convert ExecutionPlan.steps to PlanAction[] for lookahead
  const lookaheadActions = plan.steps.map((step) => {
    const action: {
      description: string
      tool?: string
      parameters?: Record<string, unknown>
      risk_factors?: string[]
    } = {
      description: step.description,
    }
    if (step.tool) action.tool = step.tool
    if (step.parameters) action.parameters = step.parameters
    if (step.risk_factors) action.risk_factors = step.risk_factors
    return action
  })

  const lookahead = await ctx.run(`lookahead-${stepIndex}`, () =>
    worldModel.lookAhead(stepIndex, lookaheadActions, env.WORLD_MODEL_LOOKAHEAD_STEPS, worldState)
  )

  // Check for predicted blockers
  if (lookahead.predicted_blockers.length > 0) {
    log.warn(
      {
        taskId,
        stepIndex,
        blockers: lookahead.predicted_blockers,
      },
      "Lookahead detected predicted blockers"
    )
  }

  // Check if we need to create a checkpoint before an irreversible action
  const nextHighRiskStep = planSimulation?.identified_risks?.find(
    (r) => r.step_index === stepIndex && r.severity >= env.WORLD_MODEL_CHECKPOINT_THRESHOLD
  )

  if (nextHighRiskStep && !checkpoints.find((c) => c.step_index === stepIndex)) {
    const newCheckpoint = await ctx.run(`checkpoint-before-${stepIndex}`, () =>
      worldModel.createCheckpoint(taskId, stepIndex, worldState, nextHighRiskStep.severity, true)
    )
    checkpoints.push(newCheckpoint)
    log.info(
      { taskId, stepIndex, checkpointId: newCheckpoint.checkpoint_id },
      "Created checkpoint before high-risk step"
    )
  }
}

/**
 * Execute an action and record the results
 */
async function executeAndRecordStep(
  ctx: restate.ObjectContext,
  taskId: string,
  stepIndex: number,
  step: TaskStep,
  action: Action,
  identityId: string
): Promise<TaskStep> {
  // Execute the action
  const result = await ctx.run(`execute-${stepIndex}`, () =>
    executeAction(action, identityId, taskId, step.step_id)
  )

  // Record evidence
  const evidence = await ctx.run(`evidence-${stepIndex}`, () =>
    createEvidence({
      identity_id: identityId,
      kind: "tool_call",
      ref: `tool:${action.tool}:${step.step_id}`,
      payload: { action, result },
    })
  )

  // Link evidence to step
  await ctx.run(`link-evidence-${stepIndex}`, () =>
    linkEvidenceToStep(step.step_id, evidence.evidence_id)
  )

  // Update step
  await ctx.run(`complete-step-${stepIndex}`, () => completeTaskStep(step.step_id, result))

  const stepOutput = result.output
    ? typeof result.output === "object" && result.output !== null && !Array.isArray(result.output)
      ? (result.output as Record<string, unknown>)
      : { value: result.output }
    : undefined

  return {
    ...step,
    ...(result.success ? {} : result.error ? { error: result.error } : {}),
    result: { success: result.success, output: stepOutput },
    evidence: { evidence_ids: [evidence.evidence_id] },
  } as TaskStep
}

/**
 * Process a single step decision and execute if needed
 * Returns { shouldContinue: boolean, shouldBreak: boolean, updatedTools: Tool[] }
 */
async function processStepDecision(
  ctx: restate.ObjectContext,
  taskId: string,
  stepIndex: number,
  step: TaskStep,
  decision: Decision,
  executedSteps: TaskStep[],
  currentTools: Tool[],
  discoveryCtx: ReturnType<typeof createDiscoveryContext>,
  identityId: string
): Promise<{ shouldContinue: boolean; shouldBreak: boolean; updatedTools: Tool[] }> {
  // Task complete early
  if (decision.done) {
    log.info({ taskId, stepIndex }, "Task completed early")
    await ctx.run(`complete-step-${stepIndex}`, () =>
      completeTaskStep(step.step_id, {
        success: true,
        output: decision.final_report ? { report: decision.final_report } : {},
      })
    )
    executedSteps.push({
      ...step,
      result: {
        success: true,
        output: decision.final_report ? { report: decision.final_report } : {},
      },
    })
    return { shouldContinue: false, shouldBreak: true, updatedTools: currentTools }
  }

  if (!decision.next) {
    return { shouldContinue: false, shouldBreak: false, updatedTools: currentTools }
  }

  const action = decision.next

  // Policy check for this specific action
  const actionPolicy = await ctx.run(`policy-${stepIndex}`, () =>
    evaluatePolicy(action, identityId)
  )

  if (actionPolicy.verdict === "block") {
    const blockReason = actionPolicy.reason ?? "Policy violation"
    await ctx.run(`fail-step-${stepIndex}`, () =>
      completeTaskStep(step.step_id, {
        success: false,
        error: `Blocked: ${blockReason}`,
      })
    )
    executedSteps.push({
      ...step,
      result: { success: false },
      ...(blockReason ? { error: blockReason } : {}),
    })
    return { shouldContinue: true, shouldBreak: false, updatedTools: currentTools }
  }

  // On-demand tool expansion
  let updatedTools = currentTools
  const toolName = action.tool
  if (toolName && !discoveryCtx.discoveredTools.has(toolName)) {
    const expandedTool = await ctx.run(`expand-tool-${stepIndex}`, () =>
      ensureToolDiscovered(discoveryCtx, toolName)
    )
    if (expandedTool) {
      updatedTools = [...currentTools, expandedTool]
      log.info({ taskId, stepIndex, tool: toolName }, "Tool discovered via on-demand expansion")
    } else {
      log.warn({ taskId, stepIndex, tool: toolName }, "Tool not found during on-demand expansion")
    }
  }

  // Execute and record the step
  const executedStep = await executeAndRecordStep(ctx, taskId, stepIndex, step, action, identityId)
  executedSteps.push(executedStep)

  return { shouldContinue: false, shouldBreak: false, updatedTools }
}

/**
 * Perform metacognitive check if needed
 */
async function performMetacognitiveCheckIfNeeded(
  ctx: restate.ObjectContext,
  taskId: string,
  stepIndex: number,
  planStep: PlanStep,
  identity: Identity,
  taskGoal: string,
  executedSteps: TaskStep[]
): Promise<void> {
  const shouldCheck =
    env.ENABLE_METACOGNITION && (stepIndex % 3 === 0 || planStep.risk_factors?.length)
  if (!shouldCheck) {
    return
  }

  const metacog = await ctx.run(`metacog-${stepIndex}`, () =>
    performMetacognitiveCheck(identity, taskGoal, stepIndex, executedSteps)
  )

  if (metacog.recommendedAction === "pause" || metacog.recommendedAction === "ask_human") {
    log.info(
      { taskId, stepIndex, recommendation: metacog.recommendedAction },
      "Metacognitive pause"
    )
  }

  if (metacog.recommendedAction === "reconsider") {
    log.info({ taskId, stepIndex }, "Reconsidering plan")
  }
}

/**
 * Execute plan steps with policy checks and tool discovery
 */
async function executePlanSteps(
  ctx: restate.ObjectContext,
  taskId: string,
  plan: ExecutionPlan,
  identity: Identity,
  task: TaskRow,
  tools: Tool[],
  discoveryCtx: ReturnType<typeof createDiscoveryContext>,
  worldState: WorldState | null,
  planSimulation: SimulationResult | null,
  checkpoints: Checkpoint[]
): Promise<TaskStep[]> {
  const executedSteps: TaskStep[] = []
  let stepIndex = 0
  let currentTools = tools

  while (stepIndex < plan.steps.length) {
    const planStep = plan.steps[stepIndex]
    if (!planStep) {
      stepIndex++
      continue
    }

    // Metacognitive check
    await performMetacognitiveCheckIfNeeded(
      ctx,
      taskId,
      stepIndex,
      planStep,
      identity,
      task.goal,
      executedSteps
    )

    // World Model Lookahead (every 2 steps)
    if (env.ENABLE_WORLD_MODEL_SIMULATION && worldState && stepIndex % 2 === 0) {
      await performWorldModelLookahead(
        ctx,
        taskId,
        stepIndex,
        plan,
        worldState,
        planSimulation,
        checkpoints
      )
    }

    // Create step record
    const step = await ctx.run(`create-step-${stepIndex}`, () =>
      createTaskStep(taskId, stepIndex, planStep)
    )

    // Get decision on how to proceed
    const decision = await ctx.run(`decide-${stepIndex}`, () =>
      makeDecision(identity, task.goal, step, executedSteps, currentTools)
    )

    // Process the decision and execute if needed
    const { shouldContinue, shouldBreak, updatedTools } = await processStepDecision(
      ctx,
      taskId,
      stepIndex,
      step,
      decision,
      executedSteps,
      currentTools,
      discoveryCtx,
      identity.identity_id
    )

    currentTools = updatedTools

    if (shouldBreak) {
      break
    }

    if (shouldContinue) {
      stepIndex++
      continue
    }

    stepIndex++
  }

  return executedSteps
}

/**
 * Perform counterfactual analysis on failed steps
 */
async function performCounterfactualAnalysis(
  ctx: restate.ObjectContext,
  taskId: string,
  failedSteps: TaskStep[],
  worldState: WorldState,
  reflection: TaskReflection
): Promise<void> {
  const worldModel = createWorldModelService()

  const counterfactualAnalyses = await ctx.run("counterfactual-analysis", async () => {
    const analyses: CounterfactualAnalysis[] = []

    for (const failedStep of failedSteps.slice(0, 3)) {
      // Limit to 3 analyses
      const planAction = {
        description: failedStep.description ?? "Unknown action",
        tool: failedStep.action?.tool ?? "unknown",
        parameters: isFullAction(failedStep.action) ? (failedStep.action.args ?? {}) : {},
      }

      const outcome = {
        success: false,
        error: String(failedStep.error ?? "Unknown error"),
        context: { step_index: failedStep.step_idx },
      }

      const analysis = await worldModel.analyzeCounterfactual(planAction, outcome, worldState)
      analyses.push(analysis)
    }

    return analyses
  })

  // Extract learnings from counterfactuals
  for (const analysis of counterfactualAnalyses) {
    if (analysis.alternative_actions.length > 0) {
      const bestAlternative = analysis.alternative_actions[0]
      if (bestAlternative) {
        log.info(
          {
            taskId,
            failedAction: analysis.failed_action.description,
            bestAlternative: bestAlternative.action.description,
            successProbability: bestAlternative.success_probability,
          },
          "Counterfactual analysis found better alternative"
        )

        // Add to lessons learned
        reflection.lessons_learned.push(
          `Counterfactual: Instead of "${analysis.failed_action.description}", consider "${bestAlternative.action.description}" (${(bestAlternative.success_probability * 100).toFixed(0)}% success probability)`
        )
      }
    }
  }
}

/**
 * Validate world model predictions made during planning
 */
async function validatePlanPredictions(
  ctx: restate.ObjectContext,
  taskId: string,
  identityId: string,
  taskSuccess: boolean,
  planSimulation: SimulationResult
): Promise<void> {
  const actualSuccess = taskSuccess
  // Predict success based on confidence threshold and risk count
  const predictedSuccess =
    planSimulation.overall_confidence >= 0.6 &&
    planSimulation.identified_risks.filter((r) => r.severity >= 0.7).length === 0

  const predictionAccurate = actualSuccess === predictedSuccess

  await ctx.run("record-prediction-accuracy", () =>
    recordPredictionAccuracy(
      identityId,
      taskId,
      "plan_success",
      predictedSuccess,
      actualSuccess,
      planSimulation.overall_confidence
    )
  )

  if (!predictionAccurate) {
    log.warn(
      {
        taskId,
        predicted: predictedSuccess,
        actual: actualSuccess,
        confidence: planSimulation.overall_confidence,
      },
      "Plan simulation prediction was inaccurate"
    )
  }
}

/**
 * Perform reflection phase with counterfactual analysis
 */
async function performReflectionPhase(
  ctx: restate.ObjectContext,
  taskId: string,
  executedSteps: TaskStep[],
  task: TaskRow,
  identityId: string,
  worldState: WorldState | null,
  planSimulation: SimulationResult | null
): Promise<TaskReflection> {
  const taskSuccess = executedSteps.every((s) => s.result?.success !== false)

  const reflection = await ctx.run("reflect", () =>
    reflect(task.goal, executedSteps, { success: taskSuccess, result: executedSteps }, identityId)
  )

  // World Model: Counterfactual analysis for failed steps
  if (env.ENABLE_WORLD_MODEL_SIMULATION && worldState) {
    const failedSteps = executedSteps.filter((s) => s.result?.success === false)

    if (failedSteps.length > 0) {
      await performCounterfactualAnalysis(ctx, taskId, failedSteps, worldState, reflection)
    }

    // Validate predictions made during planning
    if (planSimulation) {
      await validatePlanPredictions(ctx, taskId, identityId, taskSuccess, planSimulation)
    }
  }

  return reflection
}

/**
 * Record task completion and store learnings
 */
async function recordTaskCompletion(
  ctx: restate.ObjectContext,
  taskId: string,
  identityId: string,
  executedSteps: TaskStep[],
  reflection: TaskReflection
): Promise<void> {
  const taskSuccess = executedSteps.every((s) => s.result?.success !== false)

  // Store learnings
  const skillsToCreate = reflection.skills_to_update.filter((s) => s.update_type === "create")
  if (skillsToCreate.length > 0) {
    for (const skill of skillsToCreate) {
      await ctx.run(`store-skill-${skill.skill_name}`, () =>
        storeSkill(identityId, {
          name: skill.skill_name,
          description: skill.content ?? "",
          identity_id: identityId,
          trigger_patterns: [skill.skill_name],
          tool_sequence: [],
          preconditions: {},
          postconditions: {},
          success_rate: 1.0,
          execution_count: 0,
          version: 1,
          deprecated: false,
        })
      )
    }
  }

  // Update task status
  await ctx.run("mark-complete", () =>
    updateTaskStatus(taskId, taskSuccess ? "completed" : "failed")
  )

  // Record completion
  await ctx.run("record-completion", () =>
    recordEvent(identityId, "task_completed", {
      task_id: taskId,
      success: taskSuccess,
      steps_completed: executedSteps.length,
      reflection: reflection.summary,
    })
  )

  log.info({ taskId, success: taskSuccess, steps: executedSteps.length }, "Task execution complete")
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

      // Initialize task execution
      const { task, identity } = await initializeTaskExecution(ctx, taskId, params.identityId)

      // Setup on-demand tool discovery
      const { discoveryCtx, initialTools } = await setupToolDiscovery(ctx, taskId, task.goal)

      // Mutable tools array that can grow via proactive/on-demand discovery
      let tools = [...initialTools]

      // Create execution plan
      const { plan } = await createExecutionPlan(
        ctx,
        taskId,
        identity,
        task,
        tools,
        params.identityId
      )

      // World Model Integration: Historical context and simulation
      let worldState: WorldState | null = null
      let planSimulation: SimulationResult | null = null
      let checkpoints: Checkpoint[] = []

      if (env.ENABLE_WORLD_MODEL_SIMULATION) {
        const simulation = await runWorldModelSimulation(ctx, taskId, plan, params.identityId)
        worldState = simulation.worldState
        planSimulation = simulation.planSimulation
        checkpoints = simulation.checkpoints
      }

      // Swarm delegation check
      if (env.ENABLE_SWARM) {
        const swarmResult = await checkSwarmDelegation(ctx, taskId, plan, params.identityId, task)
        if (swarmResult) {
          return swarmResult
        }
      }

      // Proactive tool discovery based on plan steps
      if (env.ENABLE_PROACTIVE_TOOL_DISCOVERY) {
        tools = await setupProactiveDiscovery(ctx, taskId, plan, discoveryCtx, tools)
      }

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
          status: "failed",
          summary: `Plan blocked: ${planRisk.reason ?? "Policy violation"}`,
          error: planRisk.reason,
          evidence_ids: [],
        }
      }

      if (planRisk.requiresApproval) {
        log.info({ taskId, risk: planRisk.riskScore }, "Plan requires approval")
        const planApprovalAction: Action = {
          name: "Execute plan",
          kind: "tool_call",
          risk: planRisk.riskScore,
          uncertainty: 0.5,
          args: { plan_steps: plan.steps.length, goal: task.goal },
        }
        const approvalId = await ctx.run("create-approval", () =>
          createApprovalRequest(taskId, "plan", planApprovalAction, {
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
        await ctx.run("store-awakeable", () => storeAwakeableId(taskId, approvalId, approval.id))

        const result = await approval.promise

        if (!result.approved) {
          await ctx.run("mark-rejected", () => updateTaskStatus(taskId, "rejected"))
          return {
            status: "failed",
            summary: "Plan rejected by human approver",
            error: "Plan rejected by human approver",
            evidence_ids: [],
          }
        }
      }

      // Phase 3: ACT (execute steps)
      const executedSteps = await executePlanSteps(
        ctx,
        taskId,
        plan,
        identity,
        task,
        tools,
        discoveryCtx,
        worldState,
        planSimulation,
        checkpoints
      )

      // Phase 4: REFLECT
      const reflection = await performReflectionPhase(
        ctx,
        taskId,
        executedSteps,
        task,
        params.identityId,
        worldState,
        planSimulation
      )

      // Record task completion
      await recordTaskCompletion(ctx, taskId, params.identityId, executedSteps, reflection)

      const taskSuccess = executedSteps.every((s) => s.result?.success !== false)

      return {
        status: taskSuccess ? "done" : "failed",
        summary: reflection.summary,
        report: reflection.summary,
        evidence_ids: executedSteps.flatMap((s) => {
          const evidence = s.evidence as { evidence_ids?: string[] }
          return evidence?.evidence_ids ?? []
        }),
        iterations_used: executedSteps.length,
      }
    },

    /**
     * Get task status and progress
     */
    getStatus: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext): Promise<{ status: string; steps: TaskStep[] }> => {
        const taskId = ctx.key

        const task = await ctx.run("load-task", () => loadTask(taskId))
        const steps = await ctx.run("load-steps", () => loadTaskSteps(taskId))

        return {
          status: task?.status ?? "unknown",
          steps,
        }
      }
    ),

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
  const context: ExecutionContext = {
    task: {
      task_id: task.task_id,
      identity_id: task.identity_id,
      parent_task_id: null,
      status: task.status as TaskStatus,
      priority: task.priority,
      goal: task.goal,
      risk_score: task.risk_score ?? 0,
      confidence_score: 0.5,
      metadata:
        typeof task.context === "object" && task.context !== null
          ? (task.context as Record<string, unknown>)
          : {},
      result: null,
      error: null,
      created_at: task.created_at.toISOString(),
      updated_at: task.created_at.toISOString(),
    },
    identity_id: identity.identity_id,
    iteration: 0,
    max_iterations: 10,
    recent_events: [],
    semantic_memories: memories.slice(0, 5).map((m) => ({
      text: m.content,
      score: m.similarity,
      kind: "semantic",
    })),
    progress: [],
    background: typeof task.context === "string" ? task.context : undefined,
    resources: skills.map((s) => s.name),
  }

  const plannerPrompt = buildPlannerPrompt(task.goal, context, tools)

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
        name: step.description,
        kind: "tool_call",
        tool: step.tool,
        args: step.parameters ?? {},
        risk: 0.5, // Default risk, will be assessed by policy
        uncertainty: 0.5, // Default uncertainty
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

  const result: {
    blocked: boolean
    requiresApproval: boolean
    riskScore: number
    reason?: string
  } = {
    blocked,
    requiresApproval: maxRisk > env.RISK_THRESHOLD_APPROVAL,
    riskScore: maxRisk,
  }
  if (blockReason) result.reason = blockReason
  return result
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

// Tools that can be handled by xAI Agent Tools hybrid routing
const XAI_ROUTABLE_TOOLS = new Set(["web_search", "x_search", "code_execution", "execute_code"])

/**
 * Execute action via xAI Agent Tools routing
 */
async function executeViaXAI(
  action: Action,
  identityId: string,
  taskId: string,
  stepId: string
): Promise<{ success: boolean; output?: unknown; error?: string; evidence_id?: string }> {
  const isHighRisk = action.risk >= 0.7
  const isSandboxTool = action.tool === "code_execution" || action.tool === "execute_code"

  const requirements: ToolRoutingRequirements = {
    needsEvidence: env.ENABLE_GROUNDING,
    needsPolicy: isHighRisk,
    needsSandbox: isSandboxTool,
    isHighRisk,
  }

  const result = await dispatchTool({
    tool: action.tool ?? "unknown",
    parameters: action.args ?? {},
    identityId,
    requirements,
    context: { correlationId: `${taskId}-${stepId}`, identityId },
  })

  log.info(
    {
      tool: action.tool,
      provider: result.provider,
      success: result.success,
      latencyMs: result.latencyMs,
    },
    "xAI hybrid tool execution completed"
  )

  return {
    success: result.success,
    output: result.output,
    ...(result.success === false && result.output ? { error: String(result.output) } : {}),
    ...(result.evidence_id ? { evidence_id: result.evidence_id } : {}),
  }
}

/**
 * Execute action via ToolMesh
 */
async function executeViaToolMesh(
  action: Action,
  identityId: string,
  taskId: string,
  stepId: string
): Promise<{ success: boolean; output?: unknown; error?: string }> {
  const result = await callToolIdempotent(
    action.tool ?? "unknown",
    action.args ?? {},
    `${taskId}-${stepId}`,
    identityId
  )

  return {
    success: result.ok,
    output: result.structured ?? undefined,
    ...(result.error && { error: result.error }),
  }
}

async function executeAction(
  action: Action,
  identityId: string,
  taskId: string,
  stepId: string
): Promise<{ success: boolean; output?: unknown; error?: string; evidence_id?: string }> {
  if (action.kind !== "tool_call" || !action.tool) {
    return { success: false, error: "Invalid action type" }
  }

  try {
    // Route to xAI or ToolMesh based on tool type
    if (XAI_ROUTABLE_TOOLS.has(action.tool)) {
      return executeViaXAI(action, identityId, taskId, stepId)
    }

    return executeViaToolMesh(action, identityId, taskId, stepId)
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
  _identity: Identity,
  goal: string,
  stepIndex: number,
  executedSteps: TaskStep[]
): Promise<{
  confidence: number
  recommendedAction: "continue" | "pause" | "reconsider" | "ask_human"
  rationale: string
}> {
  const recentDecisions = executedSteps
    .slice(-3)
    .map((s) => s.description)
    .filter((d): d is string => typeof d === "string")
  const concerns = executedSteps
    .filter((s) => s.result?.success === false)
    .map((s) => String(s.error ?? "Unknown error"))
    .filter((e): e is string => typeof e === "string")

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
  outcome: { success: boolean; result: unknown },
  identityId?: string
): Promise<TaskReflection> {
  const reflectionPrompt = buildReflectionPrompt(goal, steps, outcome)

  // Run reflection and grounding in parallel for efficiency
  const [reflectionResult, groundingResult] = await Promise.allSettled([
    // Standard reflection via LLM
    completeJson<TaskReflection>({
      messages: [{ role: "user", content: reflectionPrompt }],
    }),
    // Ground factual claims from step outputs
    groundTaskClaims(steps, identityId),
  ])

  // Get reflection data
  if (reflectionResult.status === "rejected") {
    throw reflectionResult.reason
  }
  const reflection = reflectionResult.value.data

  // Merge grounding results into reflection
  if (groundingResult.status === "fulfilled") {
    const grounding = groundingResult.value
    if (grounding.contradictedClaims.length > 0) {
      log.warn(
        { identityId, contradicted: grounding.contradictedClaims.length },
        "Some claims were contradicted during grounding"
      )
      // Add contradicted claims to lessons learned
      reflection.lessons_learned = [
        ...reflection.lessons_learned,
        ...grounding.contradictedClaims.map(
          (c) => `Fact-check warning: "${c.claim}" may be inaccurate (${c.analysis})`
        ),
      ]
    }
  }

  return reflection
}

async function groundTaskClaims(
  steps: TaskStep[],
  identityId?: string
): Promise<{
  verifiedClaims: Array<{ claim: string; confidence: number }>
  contradictedClaims: Array<{ claim: string; analysis: string }>
}> {
  const verifiedClaims: Array<{ claim: string; confidence: number }> = []
  const contradictedClaims: Array<{ claim: string; analysis: string }> = []

  // Extract factual claims from step outputs
  const allClaims: string[] = []
  for (const step of steps) {
    if (step.result && typeof step.result === "string") {
      const claims = extractFactualClaims(step.result)
      allClaims.push(...claims)
    }
  }

  // Verify each claim (limit to 5 most important)
  const claimsToVerify = allClaims.slice(0, 5)
  for (const claim of claimsToVerify) {
    try {
      const result = await verifyClaim(
        claim,
        { minConfidence: 0.6 },
        identityId ? { identityId } : undefined
      )

      if (result.status === "verified") {
        verifiedClaims.push({ claim, confidence: result.confidence })
      } else if (result.status === "contradicted") {
        contradictedClaims.push({ claim, analysis: result.analysis })
      }
    } catch (err) {
      log.debug({ claim: claim.slice(0, 50), error: err }, "Failed to verify claim")
    }
  }

  return { verifiedClaims, contradictedClaims }
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
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

async function updateTaskStatus(taskId: string, status: string): Promise<void> {
  const timestamp = status === "running" ? "started_at" : "completed_at"
  await query(`UPDATE tasks SET status = $2, ${timestamp} = NOW() WHERE task_id = $1`, [
    taskId,
    status,
  ])
}

async function createTaskStep(
  taskId: string,
  sequence: number,
  planStep: PlanStep
): Promise<TaskStep> {
  const action: Action = {
    name: planStep.description,
    kind: "tool_call",
    tool: planStep.tool,
    args: planStep.parameters,
    risk: 0.5, // Default risk, will be refined by policy
    uncertainty: 0.5, // Default uncertainty
  }

  const result = await query<{ step_id: string }>(
    `INSERT INTO task_steps (task_id, sequence, description, action)
     VALUES ($1, $2, $3, $4)
     RETURNING step_id`,
    [taskId, sequence, planStep.description, JSON.stringify(action)]
  )

  const row = result.rows[0]
  if (!row) {
    throw new Error("Failed to create task step - no row returned")
  }

  const now = new Date().toISOString()

  return {
    step_id: row.step_id,
    task_id: taskId,
    step_idx: sequence,
    kind: "tool",
    name: planStep.description,
    input: (planStep.parameters as Record<string, unknown>) ?? {},
    output: {},
    evidence: {},
    created_at: now,
    ...(planStep.description ? { description: planStep.description } : {}),
    ...(action ? { action } : {}),
    started_at: now,
  }
}

async function completeTaskStep(
  stepId: string,
  result: { success: boolean; output?: unknown; error?: string }
): Promise<void> {
  await query("UPDATE task_steps SET result = $2, completed_at = NOW() WHERE step_id = $1", [
    stepId,
    JSON.stringify(result),
  ])
}

/**
 * Map a TaskStepRow from database to TaskStep domain object
 */
function mapTaskStepRow(row: TaskStepRow): TaskStep {
  const baseStep: TaskStep = {
    step_id: row.step_id,
    task_id: row.task_id,
    step_idx: row.sequence,
    kind: (row.action?.kind === "tool_call" ? "tool" : "plan") as StepKind,
    name: row.description,
    input: (row.action?.args as Record<string, unknown>) ?? {},
    output: (row.result as Record<string, unknown>) ?? {},
    evidence: row.evidence_ids.length > 0 ? { evidence_ids: row.evidence_ids } : {},
    created_at: row.started_at?.toISOString() ?? new Date().toISOString(),
  }

  // Add optional fields using conditional spreads
  return {
    ...baseStep,
    ...(row.description ? { description: row.description } : {}),
    ...(row.action ? { action: row.action } : {}),
    ...(row.result
      ? { result: row.result as { success: boolean; output?: Record<string, unknown> } }
      : {}),
    ...(row.started_at ? { started_at: row.started_at.toISOString() } : {}),
    ...(row.completed_at ? { completed_at: row.completed_at.toISOString() } : {}),
  }
}

async function loadTaskSteps(taskId: string): Promise<TaskStep[]> {
  const rows = await query<TaskStepRow>(
    "SELECT * FROM task_steps WHERE task_id = $1 ORDER BY sequence",
    [taskId]
  )

  return rows.rows.map(mapTaskStepRow)
}

async function storeAwakeableId(
  _taskId: string,
  approvalId: string,
  awakeableId: string
): Promise<void> {
  await query("UPDATE approvals SET metadata = metadata || $2::jsonb WHERE approval_id = $1", [
    approvalId,
    JSON.stringify({ awakeable_id: awakeableId }),
  ])
}

async function retrieveRelevantMemories(
  identityId: string,
  goal: string
): Promise<Array<{ content: string; similarity: number }>> {
  try {
    // Generate embedding for the goal using ToolMesh embedding service
    const goalEmbedding = await generateEmbedding(goal)

    // Search semantic memory using pgvector similarity
    const results = await searchSemanticMemory(identityId, goalEmbedding, {
      limit: 10,
      minSimilarity: 0.5,
    })

    log.debug({ identityId, resultsCount: results.length }, "Retrieved relevant memories for goal")

    return results.map((r) => ({
      content: r.memory.content,
      similarity: r.similarity,
    }))
  } catch (err) {
    log.warn({ identityId, error: err }, "Failed to retrieve memories, continuing without")
    return []
  }
}

// -----------------------------------------------------------------------------
// World Model Prediction Tracking
// -----------------------------------------------------------------------------

async function recordPredictionAccuracy(
  identityId: string,
  taskId: string,
  predictionType: string,
  predicted: boolean,
  actual: boolean,
  confidence: number
): Promise<void> {
  try {
    await query(
      `INSERT INTO world_model_predictions
       (prediction_id, identity_id, task_id, prediction_type, predicted_outcome, actual_outcome, actual_outcome_match, confidence, created_at, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [
        crypto.randomUUID(),
        identityId,
        taskId,
        predictionType,
        predicted,
        actual,
        predicted === actual,
        confidence,
      ]
    )

    log.debug(
      {
        identityId,
        taskId,
        predictionType,
        predicted,
        actual,
        accurate: predicted === actual,
      },
      "Recorded prediction accuracy"
    )
  } catch (err) {
    log.warn({ error: err }, "Failed to record prediction accuracy")
  }
}
