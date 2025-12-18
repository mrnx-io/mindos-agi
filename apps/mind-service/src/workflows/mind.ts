// =============================================================================
// MindOS - Mind Workflow (Event Ingestion & Task Creation)
// =============================================================================

import * as restate from "@restatedev/restate-sdk"
import { query, queryOne, withTransaction } from "../db.js"
import { createLogger } from "../logger.js"
import { recordEvent } from "../memory.js"
import { complete, completeJson } from "../router.js"
import { buildSystemPrompt } from "../prompts.js"
import type {
  EventEnvelope,
  GoalRequest,
  Identity,
  CoreSelf,
  PolicyProfile,
  Tool,
} from "../types.js"
import { listTools } from "../tooling/toolmeshClient.js"

const log = createLogger("mind-workflow")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface IdentityRow {
  identity_id: string
  display_name: string
  core_self: CoreSelf
  policy_profile: PolicyProfile
  metadata: unknown
  created_at: Date
  updated_at: Date
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

// -----------------------------------------------------------------------------
// Restate Virtual Object: Mind
// -----------------------------------------------------------------------------

export const mindObject = restate.object({
  name: "mind",
  handlers: {
    /**
     * Ingest an event and potentially create tasks
     */
    ingestEvent: async (
      ctx: restate.ObjectContext,
      event: EventEnvelope
    ): Promise<{ processed: boolean; taskIds: string[] }> => {
      const identityId = ctx.key

      log.info({ identityId, eventKind: event.kind }, "Ingesting event")

      // Load identity
      const identity = await ctx.run("load-identity", () => loadIdentity(identityId))

      if (!identity) {
        log.error({ identityId }, "Identity not found")
        return { processed: false, taskIds: [] }
      }

      // Record the event
      const eventId = await ctx.run("record-event", () =>
        recordEvent(identityId, event.kind, event.payload)
      )

      // Analyze event to determine if tasks should be created
      const analysis = await ctx.run("analyze-event", () =>
        analyzeEvent(identity, event)
      )

      const taskIds: string[] = []

      // Create tasks from analysis
      for (const goal of analysis.suggestedGoals) {
        const taskId = await ctx.run(`create-task-${goal.priority}`, () =>
          createTask(identityId, {
            goal: goal.description,
            context: {
              source_event_id: eventId,
              source_kind: event.kind,
              ...goal.context,
            },
            priority: goal.priority,
          })
        )

        taskIds.push(taskId)

        // Kick off task execution
        ctx.objectSendClient({ name: "task" }, taskId).execute({
          identityId,
        })
      }

      log.info({ identityId, eventId, taskCount: taskIds.length }, "Event processed")

      return { processed: true, taskIds }
    },

    /**
     * Submit a goal directly (human-initiated)
     */
    submitGoal: async (
      ctx: restate.ObjectContext,
      request: GoalRequest
    ): Promise<{ taskId: string }> => {
      const identityId = ctx.key

      log.info({ identityId, goal: request.goal }, "Goal submitted")

      // Validate identity exists
      const identity = await ctx.run("validate-identity", () => loadIdentity(identityId))

      if (!identity) {
        throw new restate.TerminalError(`Identity not found: ${identityId}`)
      }

      // Create the task
      const taskId = await ctx.run("create-task", () =>
        createTask(identityId, {
          goal: request.goal,
          context: request.context ?? {},
          priority: request.priority ?? 5,
        })
      )

      // Record the goal submission event
      await ctx.run("record-goal-event", () =>
        recordEvent(identityId, "goal_submitted", {
          task_id: taskId,
          goal: request.goal,
        })
      )

      // Start task execution
      ctx.objectSendClient({ name: "task" }, taskId).execute({
        identityId,
      })

      return { taskId }
    },

    /**
     * Get current identity state
     */
    getState: async (
      ctx: restate.ObjectContext
    ): Promise<{ identity: Identity | null; activeTasks: number }> => {
      const identityId = ctx.key

      const identity = await ctx.run("load-identity", () => loadIdentity(identityId))
      const activeTasks = await ctx.run("count-tasks", () => countActiveTasks(identityId))

      return { identity, activeTasks }
    },

    /**
     * Update identity core self
     */
    updateCoreSelf: async (
      ctx: restate.ObjectContext,
      updates: Partial<CoreSelf>
    ): Promise<{ success: boolean }> => {
      const identityId = ctx.key

      await ctx.run("update-core-self", () => updateCoreSelf(identityId, updates))

      // Record the update
      await ctx.run("record-update", () =>
        recordEvent(identityId, "core_self_updated", updates)
      )

      return { success: true }
    },
  },
})

// -----------------------------------------------------------------------------
// Event Analysis
// -----------------------------------------------------------------------------

interface EventAnalysis {
  suggestedGoals: Array<{
    description: string
    priority: number
    context: Record<string, unknown>
  }>
  shouldIgnore: boolean
  reasoning: string
}

async function analyzeEvent(
  identity: Identity,
  event: EventEnvelope
): Promise<EventAnalysis> {
  // Get available tools for context
  const tools = await listTools()

  const systemPrompt = buildSystemPrompt(identity.core_self, identity.policy_profile, tools)

  const { data } = await completeJson<EventAnalysis>({
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `An event has occurred. Analyze it and determine if any tasks should be created.

Event Type: ${event.kind}
Event Payload: ${JSON.stringify(event.payload, null, 2)}
Timestamp: ${event.timestamp}

Consider:
1. Does this event require action based on my values and goals?
2. Is this urgent or can it wait?
3. What specific task(s) would address this event?

Respond with JSON:
{
  "suggestedGoals": [
    {
      "description": "string - clear goal statement",
      "priority": 1-10,
      "context": {}
    }
  ],
  "shouldIgnore": boolean,
  "reasoning": "string"
}`,
      },
    ],
  })

  return data
}

// -----------------------------------------------------------------------------
// Database Operations
// -----------------------------------------------------------------------------

async function loadIdentity(identityId: string): Promise<Identity | null> {
  const row = await queryOne<IdentityRow>(
    "SELECT * FROM identities WHERE identity_id = $1",
    [identityId]
  )

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

async function createTask(
  identityId: string,
  params: {
    goal: string
    context: Record<string, unknown>
    priority: number
  }
): Promise<string> {
  const result = await query<{ task_id: string }>(
    `INSERT INTO tasks (identity_id, goal, context, priority, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING task_id`,
    [identityId, params.goal, JSON.stringify(params.context), params.priority]
  )

  return result.rows[0].task_id
}

async function countActiveTasks(identityId: string): Promise<number> {
  const result = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM tasks
     WHERE identity_id = $1 AND status IN ('pending', 'running')`,
    [identityId]
  )

  return parseInt(result?.count ?? "0", 10)
}

async function updateCoreSelf(
  identityId: string,
  updates: Partial<CoreSelf>
): Promise<void> {
  await query(
    `UPDATE identities
     SET core_self = core_self || $2::jsonb,
         updated_at = NOW()
     WHERE identity_id = $1`,
    [identityId, JSON.stringify(updates)]
  )
}

// -----------------------------------------------------------------------------
// Identity Creation
// -----------------------------------------------------------------------------

export async function createIdentity(params: {
  displayName: string
  coreSelf?: Partial<CoreSelf>
  policyProfile?: Partial<PolicyProfile>
}): Promise<string> {
  const defaultCoreSelf: CoreSelf = {
    values: [],
    goals: [],
    constraints: [],
    personality_traits: {},
    trust_defaults: {
      new_tools: 0.5,
      external_data: 0.7,
      human_input: 0.9,
      swarm_agents: 0.8,
    },
  }

  const defaultPolicy: PolicyProfile = {
    trust_level: "medium",
    auto_approve_threshold: 0.3,
    approval_threshold: 0.7,
    block_threshold: 0.9,
    allowed_tools: [],
    blocked_tools: [],
  }

  const result = await query<{ identity_id: string }>(
    `INSERT INTO identities (display_name, core_self, policy_profile, metadata)
     VALUES ($1, $2, $3, $4)
     RETURNING identity_id`,
    [
      params.displayName,
      JSON.stringify({ ...defaultCoreSelf, ...params.coreSelf }),
      JSON.stringify({ ...defaultPolicy, ...params.policyProfile }),
      JSON.stringify({}),
    ]
  )

  log.info({ identityId: result.rows[0].identity_id }, "Identity created")
  return result.rows[0].identity_id
}
