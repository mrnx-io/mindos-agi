// =============================================================================
// MindOS - Swarm Coordinator Service (Multi-Agent Orchestration)
// =============================================================================

import Fastify from "fastify"
import websocket from "@fastify/websocket"
import cors from "@fastify/cors"
import { z } from "zod"
import pg from "pg"
import pino from "pino"
import { EventEmitter } from "eventemitter3"
import type { WebSocket } from "ws"

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const env = {
  PORT: parseInt(process.env.PORT ?? "3005"),
  HOST: process.env.HOST ?? "0.0.0.0",
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  CONSENSUS_TIMEOUT_MS: parseInt(process.env.CONSENSUS_TIMEOUT_MS ?? "30000"),
  MAX_SWARM_SIZE: parseInt(process.env.MAX_SWARM_SIZE ?? "10"),
  HEARTBEAT_INTERVAL_MS: parseInt(process.env.HEARTBEAT_INTERVAL_MS ?? "5000"),
}

const logger = pino({
  level: env.LOG_LEVEL,
  transport: process.env.NODE_ENV !== "production"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
})

// -----------------------------------------------------------------------------
// Database
// -----------------------------------------------------------------------------

const { Pool } = pg
const pool = new Pool({ connectionString: env.DATABASE_URL })

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface SwarmAgent {
  agent_id: string
  identity_id: string
  role: "leader" | "worker" | "observer"
  capabilities: string[]
  specialization?: string
  status: "active" | "busy" | "offline"
  current_task?: string
  socket?: WebSocket
  last_heartbeat: number
}

interface SwarmInstance {
  swarm_id: string
  name: string
  objective: string
  status: "forming" | "active" | "voting" | "dissolving" | "completed"
  leader_id?: string
  agents: SwarmAgent[]
  consensus_state: ConsensusState
  created_at: string
  completed_at?: string
}

interface ConsensusState {
  current_term: number
  votes: Map<string, string>
  pending_proposals: Proposal[]
  agreed_decisions: Decision[]
}

interface Proposal {
  proposal_id: string
  proposer_id: string
  type: "task_delegation" | "role_assignment" | "evidence_reconciliation" | "swarm_dissolution"
  content: Record<string, unknown>
  votes_for: string[]
  votes_against: string[]
  status: "pending" | "accepted" | "rejected"
  created_at: string
}

interface Decision {
  decision_id: string
  proposal_id: string
  outcome: "accepted" | "rejected"
  vote_count: { for: number; against: number; abstain: number }
  timestamp: string
}

interface TaskDelegation {
  delegation_id: string
  swarm_id: string
  task_id: string
  assigned_agent_id: string
  delegated_by: string
  priority: "low" | "medium" | "high" | "critical"
  constraints: Record<string, unknown>
  status: "pending" | "accepted" | "in_progress" | "completed" | "failed"
  created_at: string
}

interface EmergentBehavior {
  behavior_id: string
  swarm_id: string
  type: "specialization" | "collaboration_pattern" | "efficiency_gain" | "novel_strategy"
  description: string
  evidence: Record<string, unknown>[]
  significance: number
  detected_at: string
}

// -----------------------------------------------------------------------------
// Event System
// -----------------------------------------------------------------------------

const events = new EventEmitter()

// -----------------------------------------------------------------------------
// Swarm State Management
// -----------------------------------------------------------------------------

const activeSwarms = new Map<string, SwarmInstance>()
const agentConnections = new Map<string, SwarmAgent>()

function createSwarmInstance(
  name: string,
  objective: string
): SwarmInstance {
  const swarm: SwarmInstance = {
    swarm_id: crypto.randomUUID(),
    name,
    objective,
    status: "forming",
    agents: [],
    consensus_state: {
      current_term: 0,
      votes: new Map(),
      pending_proposals: [],
      agreed_decisions: [],
    },
    created_at: new Date().toISOString(),
  }

  activeSwarms.set(swarm.swarm_id, swarm)
  return swarm
}

async function joinSwarm(
  swarmId: string,
  agentId: string,
  identityId: string,
  capabilities: string[]
): Promise<SwarmAgent | null> {
  const swarm = activeSwarms.get(swarmId)
  if (!swarm) return null

  if (swarm.agents.length >= env.MAX_SWARM_SIZE) {
    return null
  }

  const agent: SwarmAgent = {
    agent_id: agentId,
    identity_id: identityId,
    role: swarm.agents.length === 0 ? "leader" : "worker",
    capabilities,
    status: "active",
    last_heartbeat: Date.now(),
  }

  swarm.agents.push(agent)
  agentConnections.set(agentId, agent)

  // First agent becomes leader
  if (swarm.agents.length === 1) {
    swarm.leader_id = agentId
    swarm.status = "active"
  }

  // Detect specialization
  detectSpecialization(swarm)

  await persistSwarmState(swarm)

  events.emit("agent_joined", { swarmId, agentId })
  broadcastToSwarm(swarmId, {
    type: "agent_joined",
    agent_id: agentId,
    role: agent.role,
  })

  return agent
}

function leaveSwarm(swarmId: string, agentId: string): boolean {
  const swarm = activeSwarms.get(swarmId)
  if (!swarm) return false

  const agentIndex = swarm.agents.findIndex((a) => a.agent_id === agentId)
  if (agentIndex === -1) return false

  swarm.agents.splice(agentIndex, 1)
  agentConnections.delete(agentId)

  // If leader left, elect new one
  if (swarm.leader_id === agentId && swarm.agents.length > 0) {
    initiateLeaderElection(swarm)
  }

  // Dissolve if empty
  if (swarm.agents.length === 0) {
    swarm.status = "completed"
    activeSwarms.delete(swarmId)
  }

  events.emit("agent_left", { swarmId, agentId })
  broadcastToSwarm(swarmId, {
    type: "agent_left",
    agent_id: agentId,
  })

  return true
}

// -----------------------------------------------------------------------------
// Consensus Protocol (Raft-inspired)
// -----------------------------------------------------------------------------

async function initiateLeaderElection(swarm: SwarmInstance): Promise<void> {
  swarm.status = "voting"
  swarm.consensus_state.current_term++
  swarm.consensus_state.votes.clear()

  logger.info({ swarmId: swarm.swarm_id, term: swarm.consensus_state.current_term }, "Leader election started")

  broadcastToSwarm(swarm.swarm_id, {
    type: "election_started",
    term: swarm.consensus_state.current_term,
  })

  // Simplified: highest capability score wins
  let bestCandidate: SwarmAgent | null = null
  let bestScore = -1

  for (const agent of swarm.agents) {
    const score = agent.capabilities.length + (agent.specialization ? 2 : 0)
    if (score > bestScore) {
      bestScore = score
      bestCandidate = agent
    }
  }

  if (bestCandidate) {
    swarm.leader_id = bestCandidate.agent_id
    bestCandidate.role = "leader"
    swarm.status = "active"

    // Update other agents to worker role
    for (const agent of swarm.agents) {
      if (agent.agent_id !== bestCandidate.agent_id) {
        agent.role = "worker"
      }
    }

    broadcastToSwarm(swarm.swarm_id, {
      type: "leader_elected",
      leader_id: bestCandidate.agent_id,
      term: swarm.consensus_state.current_term,
    })

    logger.info({ swarmId: swarm.swarm_id, leaderId: bestCandidate.agent_id }, "Leader elected")
  }
}

async function proposeAction(
  swarmId: string,
  proposerId: string,
  type: Proposal["type"],
  content: Record<string, unknown>
): Promise<Proposal | null> {
  const swarm = activeSwarms.get(swarmId)
  if (!swarm) return null

  const proposal: Proposal = {
    proposal_id: crypto.randomUUID(),
    proposer_id: proposerId,
    type,
    content,
    votes_for: [proposerId], // Proposer votes for
    votes_against: [],
    status: "pending",
    created_at: new Date().toISOString(),
  }

  swarm.consensus_state.pending_proposals.push(proposal)

  broadcastToSwarm(swarmId, {
    type: "proposal_created",
    proposal,
  })

  // Auto-accept if single agent or leader proposes
  if (swarm.agents.length === 1 || proposerId === swarm.leader_id) {
    await resolveProposal(swarm, proposal.proposal_id, "accepted")
  } else {
    // Set timeout for voting
    setTimeout(async () => {
      const p = swarm.consensus_state.pending_proposals.find((pr) => pr.proposal_id === proposal.proposal_id)
      if (p && p.status === "pending") {
        await resolveProposal(swarm, proposal.proposal_id, p.votes_for.length >= p.votes_against.length ? "accepted" : "rejected")
      }
    }, env.CONSENSUS_TIMEOUT_MS)
  }

  return proposal
}

async function voteOnProposal(
  swarmId: string,
  agentId: string,
  proposalId: string,
  vote: "for" | "against"
): Promise<boolean> {
  const swarm = activeSwarms.get(swarmId)
  if (!swarm) return false

  const proposal = swarm.consensus_state.pending_proposals.find((p) => p.proposal_id === proposalId)
  if (!proposal || proposal.status !== "pending") return false

  // Remove any existing vote
  proposal.votes_for = proposal.votes_for.filter((v) => v !== agentId)
  proposal.votes_against = proposal.votes_against.filter((v) => v !== agentId)

  if (vote === "for") {
    proposal.votes_for.push(agentId)
  } else {
    proposal.votes_against.push(agentId)
  }

  broadcastToSwarm(swarmId, {
    type: "vote_cast",
    proposal_id: proposalId,
    agent_id: agentId,
    vote,
  })

  // Check if we have quorum (majority)
  const totalAgents = swarm.agents.length
  const quorum = Math.ceil(totalAgents / 2)

  if (proposal.votes_for.length >= quorum) {
    await resolveProposal(swarm, proposalId, "accepted")
  } else if (proposal.votes_against.length >= quorum) {
    await resolveProposal(swarm, proposalId, "rejected")
  }

  return true
}

async function resolveProposal(
  swarm: SwarmInstance,
  proposalId: string,
  outcome: "accepted" | "rejected"
): Promise<void> {
  const proposal = swarm.consensus_state.pending_proposals.find((p) => p.proposal_id === proposalId)
  if (!proposal) return

  proposal.status = outcome

  const decision: Decision = {
    decision_id: crypto.randomUUID(),
    proposal_id: proposalId,
    outcome,
    vote_count: {
      for: proposal.votes_for.length,
      against: proposal.votes_against.length,
      abstain: swarm.agents.length - proposal.votes_for.length - proposal.votes_against.length,
    },
    timestamp: new Date().toISOString(),
  }

  swarm.consensus_state.agreed_decisions.push(decision)

  // Execute the decision
  if (outcome === "accepted") {
    await executeDecision(swarm, proposal)
  }

  broadcastToSwarm(swarm.swarm_id, {
    type: "proposal_resolved",
    proposal_id: proposalId,
    outcome,
    decision,
  })

  // Remove from pending
  swarm.consensus_state.pending_proposals = swarm.consensus_state.pending_proposals.filter(
    (p) => p.proposal_id !== proposalId
  )

  await persistSwarmState(swarm)
}

async function executeDecision(swarm: SwarmInstance, proposal: Proposal): Promise<void> {
  switch (proposal.type) {
    case "task_delegation": {
      const { task_id, target_agent_id, priority } = proposal.content as {
        task_id: string
        target_agent_id: string
        priority: string
      }
      await delegateTask(swarm.swarm_id, task_id, target_agent_id, proposal.proposer_id, priority as TaskDelegation["priority"])
      break
    }
    case "role_assignment": {
      const { agent_id, new_role } = proposal.content as { agent_id: string; new_role: SwarmAgent["role"] }
      const agent = swarm.agents.find((a) => a.agent_id === agent_id)
      if (agent) {
        agent.role = new_role
      }
      break
    }
    case "swarm_dissolution": {
      swarm.status = "dissolving"
      broadcastToSwarm(swarm.swarm_id, { type: "swarm_dissolving" })
      // Grace period before actual dissolution
      setTimeout(() => {
        swarm.status = "completed"
        swarm.completed_at = new Date().toISOString()
        persistSwarmState(swarm)
      }, 5000)
      break
    }
    case "evidence_reconciliation": {
      // Handled by evidence reconciliation system
      events.emit("evidence_reconciliation", {
        swarmId: swarm.swarm_id,
        evidence: proposal.content,
      })
      break
    }
  }
}

// -----------------------------------------------------------------------------
// Task Delegation
// -----------------------------------------------------------------------------

const activeDelegations = new Map<string, TaskDelegation>()

async function delegateTask(
  swarmId: string,
  taskId: string,
  targetAgentId: string,
  delegatedBy: string,
  priority: TaskDelegation["priority"]
): Promise<TaskDelegation | null> {
  const swarm = activeSwarms.get(swarmId)
  if (!swarm) return null

  const targetAgent = swarm.agents.find((a) => a.agent_id === targetAgentId)
  if (!targetAgent || targetAgent.status !== "active") return null

  const delegation: TaskDelegation = {
    delegation_id: crypto.randomUUID(),
    swarm_id: swarmId,
    task_id: taskId,
    assigned_agent_id: targetAgentId,
    delegated_by: delegatedBy,
    priority,
    constraints: {},
    status: "pending",
    created_at: new Date().toISOString(),
  }

  activeDelegations.set(delegation.delegation_id, delegation)
  targetAgent.status = "busy"
  targetAgent.current_task = taskId

  await persistDelegation(delegation)

  // Notify the target agent
  const agentSocket = targetAgent.socket
  if (agentSocket) {
    agentSocket.send(JSON.stringify({
      type: "task_delegated",
      delegation,
    }))
  }

  return delegation
}

async function updateDelegationStatus(
  delegationId: string,
  status: TaskDelegation["status"]
): Promise<boolean> {
  const delegation = activeDelegations.get(delegationId)
  if (!delegation) return false

  delegation.status = status

  const swarm = activeSwarms.get(delegation.swarm_id)
  if (swarm) {
    const agent = swarm.agents.find((a) => a.agent_id === delegation.assigned_agent_id)
    if (agent) {
      if (status === "completed" || status === "failed") {
        agent.status = "active"
        agent.current_task = undefined
      }
    }
  }

  await persistDelegation(delegation)

  broadcastToSwarm(delegation.swarm_id, {
    type: "delegation_updated",
    delegation_id: delegationId,
    status,
  })

  return true
}

function selectBestAgent(swarm: SwarmInstance, taskCapabilities: string[]): SwarmAgent | null {
  let bestAgent: SwarmAgent | null = null
  let bestScore = -1

  for (const agent of swarm.agents) {
    if (agent.status !== "active") continue

    // Score based on capability overlap
    const overlap = agent.capabilities.filter((c) => taskCapabilities.includes(c)).length
    const specializationBonus = agent.specialization && taskCapabilities.includes(agent.specialization) ? 3 : 0
    const score = overlap + specializationBonus

    if (score > bestScore) {
      bestScore = score
      bestAgent = agent
    }
  }

  return bestAgent
}

// -----------------------------------------------------------------------------
// Emergent Behavior Detection
// -----------------------------------------------------------------------------

function detectSpecialization(swarm: SwarmInstance): void {
  // Analyze task history to detect emergent specializations
  const taskCounts = new Map<string, Map<string, number>>()

  for (const delegation of activeDelegations.values()) {
    if (delegation.swarm_id !== swarm.swarm_id) continue
    if (delegation.status !== "completed") continue

    const agentId = delegation.assigned_agent_id
    if (!taskCounts.has(agentId)) {
      taskCounts.set(agentId, new Map())
    }

    // Simplified: would analyze task type in production
    const taskType = "general"
    const counts = taskCounts.get(agentId)!
    counts.set(taskType, (counts.get(taskType) ?? 0) + 1)
  }

  // Detect if any agent is doing 70%+ of a task type
  for (const [agentId, counts] of taskCounts) {
    const total = Array.from(counts.values()).reduce((a, b) => a + b, 0)
    for (const [taskType, count] of counts) {
      if (count / total >= 0.7 && total >= 3) {
        const agent = swarm.agents.find((a) => a.agent_id === agentId)
        if (agent && !agent.specialization) {
          agent.specialization = taskType

          const behavior: EmergentBehavior = {
            behavior_id: crypto.randomUUID(),
            swarm_id: swarm.swarm_id,
            type: "specialization",
            description: `Agent ${agentId} has emerged as a ${taskType} specialist`,
            evidence: [{ taskType, completionRate: count / total, totalTasks: total }],
            significance: 0.8,
            detected_at: new Date().toISOString(),
          }

          persistEmergentBehavior(behavior)
          events.emit("emergent_behavior", behavior)
        }
      }
    }
  }
}

async function analyzeCollaborationPatterns(swarm: SwarmInstance): Promise<EmergentBehavior[]> {
  const behaviors: EmergentBehavior[] = []

  // Detect collaboration chains
  // Would analyze task dependencies and handoffs in production

  return behaviors
}

// -----------------------------------------------------------------------------
// WebSocket Communication
// -----------------------------------------------------------------------------

function broadcastToSwarm(swarmId: string, message: Record<string, unknown>): void {
  const swarm = activeSwarms.get(swarmId)
  if (!swarm) return

  const payload = JSON.stringify(message)

  for (const agent of swarm.agents) {
    if (agent.socket && agent.socket.readyState === 1) {
      agent.socket.send(payload)
    }
  }
}

function handleAgentMessage(agentId: string, message: Record<string, unknown>): void {
  const agent = agentConnections.get(agentId)
  if (!agent) return

  switch (message.type) {
    case "heartbeat":
      agent.last_heartbeat = Date.now()
      break

    case "status_update":
      agent.status = message.status as SwarmAgent["status"]
      break

    case "vote":
      if (message.swarm_id && message.proposal_id && message.vote) {
        voteOnProposal(
          message.swarm_id as string,
          agentId,
          message.proposal_id as string,
          message.vote as "for" | "against"
        )
      }
      break

    case "delegation_update":
      if (message.delegation_id && message.status) {
        updateDelegationStatus(
          message.delegation_id as string,
          message.status as TaskDelegation["status"]
        )
      }
      break
  }
}

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

async function persistSwarmState(swarm: SwarmInstance): Promise<void> {
  await pool.query(
    `INSERT INTO swarm_coordination (
      swarm_id, status, leader_id, agent_ids, consensus_term, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (swarm_id) DO UPDATE SET
      status = EXCLUDED.status,
      leader_id = EXCLUDED.leader_id,
      agent_ids = EXCLUDED.agent_ids,
      consensus_term = EXCLUDED.consensus_term`,
    [
      swarm.swarm_id,
      swarm.status,
      swarm.leader_id,
      JSON.stringify(swarm.agents.map((a) => a.agent_id)),
      swarm.consensus_state.current_term,
      swarm.created_at,
    ]
  )
}

async function persistDelegation(delegation: TaskDelegation): Promise<void> {
  await pool.query(
    `INSERT INTO task_delegations (
      delegation_id, swarm_id, task_id, assigned_agent_id, delegated_by, priority, status, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (delegation_id) DO UPDATE SET
      status = EXCLUDED.status`,
    [
      delegation.delegation_id,
      delegation.swarm_id,
      delegation.task_id,
      delegation.assigned_agent_id,
      delegation.delegated_by,
      delegation.priority,
      delegation.status,
      delegation.created_at,
    ]
  )
}

async function persistEmergentBehavior(behavior: EmergentBehavior): Promise<void> {
  await pool.query(
    `INSERT INTO emergent_behaviors (
      behavior_id, swarm_id, type, description, evidence, significance, detected_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      behavior.behavior_id,
      behavior.swarm_id,
      behavior.type,
      behavior.description,
      JSON.stringify(behavior.evidence),
      behavior.significance,
      behavior.detected_at,
    ]
  )
}

// -----------------------------------------------------------------------------
// Request Schemas
// -----------------------------------------------------------------------------

const CreateSwarmSchema = z.object({
  name: z.string().min(1),
  objective: z.string().min(1),
})

const JoinSwarmSchema = z.object({
  agent_id: z.string().uuid(),
  identity_id: z.string().uuid(),
  capabilities: z.array(z.string()),
})

const ProposeActionSchema = z.object({
  proposer_id: z.string().uuid(),
  type: z.enum(["task_delegation", "role_assignment", "evidence_reconciliation", "swarm_dissolution"]),
  content: z.record(z.unknown()),
})

const DelegateTaskSchema = z.object({
  task_id: z.string().uuid(),
  target_agent_id: z.string().uuid().optional(),
  capabilities_needed: z.array(z.string()).optional(),
  delegated_by: z.string().uuid(),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
})

// -----------------------------------------------------------------------------
// Server Setup
// -----------------------------------------------------------------------------

const app = Fastify({ logger: false })

await app.register(cors, { origin: true })
await app.register(websocket)

// Health check
app.get("/health", async () => ({
  status: "healthy",
  active_swarms: activeSwarms.size,
  connected_agents: agentConnections.size,
  max_swarm_size: env.MAX_SWARM_SIZE,
}))

// Create swarm
app.post("/swarms", async (request, reply) => {
  const body = CreateSwarmSchema.parse(request.body)

  const swarm = createSwarmInstance(body.name, body.objective)

  logger.info({ swarmId: swarm.swarm_id, name: body.name }, "Swarm created")

  return {
    swarm_id: swarm.swarm_id,
    name: swarm.name,
    objective: swarm.objective,
    status: swarm.status,
    created_at: swarm.created_at,
  }
})

// Get swarm
app.get("/swarms/:swarmId", async (request, reply) => {
  const { swarmId } = request.params as { swarmId: string }

  const swarm = activeSwarms.get(swarmId)
  if (!swarm) {
    reply.code(404)
    return { error: "Swarm not found" }
  }

  return {
    swarm_id: swarm.swarm_id,
    name: swarm.name,
    objective: swarm.objective,
    status: swarm.status,
    leader_id: swarm.leader_id,
    agents: swarm.agents.map((a) => ({
      agent_id: a.agent_id,
      role: a.role,
      status: a.status,
      specialization: a.specialization,
    })),
    consensus_term: swarm.consensus_state.current_term,
    pending_proposals: swarm.consensus_state.pending_proposals.length,
    created_at: swarm.created_at,
  }
})

// Join swarm
app.post("/swarms/:swarmId/join", async (request, reply) => {
  const { swarmId } = request.params as { swarmId: string }
  const body = JoinSwarmSchema.parse(request.body)

  const agent = await joinSwarm(swarmId, body.agent_id, body.identity_id, body.capabilities)

  if (!agent) {
    reply.code(400)
    return { error: "Failed to join swarm" }
  }

  return {
    agent_id: agent.agent_id,
    role: agent.role,
    swarm_id: swarmId,
  }
})

// Leave swarm
app.post("/swarms/:swarmId/leave", async (request, reply) => {
  const { swarmId } = request.params as { swarmId: string }
  const body = z.object({ agent_id: z.string().uuid() }).parse(request.body)

  const success = leaveSwarm(swarmId, body.agent_id)

  if (!success) {
    reply.code(400)
    return { error: "Failed to leave swarm" }
  }

  return { success: true }
})

// Propose action
app.post("/swarms/:swarmId/propose", async (request, reply) => {
  const { swarmId } = request.params as { swarmId: string }
  const body = ProposeActionSchema.parse(request.body)

  const proposal = await proposeAction(swarmId, body.proposer_id, body.type, body.content)

  if (!proposal) {
    reply.code(400)
    return { error: "Failed to create proposal" }
  }

  return proposal
})

// Vote on proposal
app.post("/swarms/:swarmId/vote", async (request, reply) => {
  const { swarmId } = request.params as { swarmId: string }
  const body = z.object({
    agent_id: z.string().uuid(),
    proposal_id: z.string().uuid(),
    vote: z.enum(["for", "against"]),
  }).parse(request.body)

  const success = await voteOnProposal(swarmId, body.agent_id, body.proposal_id, body.vote)

  if (!success) {
    reply.code(400)
    return { error: "Failed to cast vote" }
  }

  return { success: true }
})

// Delegate task
app.post("/swarms/:swarmId/delegate", async (request, reply) => {
  const { swarmId } = request.params as { swarmId: string }
  const body = DelegateTaskSchema.parse(request.body)

  const swarm = activeSwarms.get(swarmId)
  if (!swarm) {
    reply.code(404)
    return { error: "Swarm not found" }
  }

  // Auto-select agent if not specified
  let targetAgentId = body.target_agent_id
  if (!targetAgentId && body.capabilities_needed) {
    const bestAgent = selectBestAgent(swarm, body.capabilities_needed)
    if (bestAgent) {
      targetAgentId = bestAgent.agent_id
    }
  }

  if (!targetAgentId) {
    reply.code(400)
    return { error: "No suitable agent found" }
  }

  const delegation = await delegateTask(
    swarmId,
    body.task_id,
    targetAgentId,
    body.delegated_by,
    body.priority
  )

  if (!delegation) {
    reply.code(400)
    return { error: "Failed to delegate task" }
  }

  return delegation
})

// Get emergent behaviors
app.get("/swarms/:swarmId/behaviors", async (request, reply) => {
  const { swarmId } = request.params as { swarmId: string }

  const result = await pool.query(
    `SELECT * FROM emergent_behaviors WHERE swarm_id = $1 ORDER BY detected_at DESC LIMIT 50`,
    [swarmId]
  )

  return { behaviors: result.rows }
})

// List all swarms
app.get("/swarms", async () => {
  const swarms = Array.from(activeSwarms.values()).map((s) => ({
    swarm_id: s.swarm_id,
    name: s.name,
    status: s.status,
    agent_count: s.agents.length,
    created_at: s.created_at,
  }))

  return { swarms }
})

// WebSocket endpoint for real-time communication
app.register(async (fastify) => {
  fastify.get("/ws/:agentId", { websocket: true }, (socket, req) => {
    const { agentId } = req.params as { agentId: string }

    const agent = agentConnections.get(agentId)
    if (agent) {
      agent.socket = socket
    }

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString())
        handleAgentMessage(agentId, message)
      } catch {
        logger.warn({ agentId }, "Invalid WebSocket message")
      }
    })

    socket.on("close", () => {
      const agent = agentConnections.get(agentId)
      if (agent) {
        agent.socket = undefined
        agent.status = "offline"
      }
    })
  })
})

// -----------------------------------------------------------------------------
// Heartbeat Monitor
// -----------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now()
  const timeout = env.HEARTBEAT_INTERVAL_MS * 3

  for (const [agentId, agent] of agentConnections) {
    if (now - agent.last_heartbeat > timeout && agent.status !== "offline") {
      agent.status = "offline"
      logger.warn({ agentId }, "Agent heartbeat timeout")

      // Find and notify swarm
      for (const swarm of activeSwarms.values()) {
        const swarmAgent = swarm.agents.find((a) => a.agent_id === agentId)
        if (swarmAgent) {
          broadcastToSwarm(swarm.swarm_id, {
            type: "agent_offline",
            agent_id: agentId,
          })
        }
      }
    }
  }
}, env.HEARTBEAT_INTERVAL_MS)

// -----------------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------------

async function main() {
  logger.info({ port: env.PORT }, "Starting Swarm Coordinator Service")

  // Check database
  try {
    await pool.query("SELECT 1")
    logger.info("Database connection verified")
  } catch (err) {
    logger.error({ err }, "Database connection failed")
    process.exit(1)
  }

  // Ensure tables exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS swarm_coordination (
      id SERIAL PRIMARY KEY,
      swarm_id TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL,
      leader_id TEXT,
      agent_ids JSONB NOT NULL,
      consensus_term INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_delegations (
      id SERIAL PRIMARY KEY,
      delegation_id TEXT UNIQUE NOT NULL,
      swarm_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      assigned_agent_id TEXT NOT NULL,
      delegated_by TEXT NOT NULL,
      priority TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS emergent_behaviors (
      id SERIAL PRIMARY KEY,
      behavior_id TEXT UNIQUE NOT NULL,
      swarm_id TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      evidence JSONB NOT NULL,
      significance REAL NOT NULL,
      detected_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_swarm_status ON swarm_coordination(status);
    CREATE INDEX IF NOT EXISTS idx_delegation_swarm ON task_delegations(swarm_id);
    CREATE INDEX IF NOT EXISTS idx_delegation_agent ON task_delegations(assigned_agent_id);
    CREATE INDEX IF NOT EXISTS idx_behavior_swarm ON emergent_behaviors(swarm_id);
  `)

  await app.listen({ port: env.PORT, host: env.HOST })
  logger.info({ port: env.PORT }, "Swarm Coordinator Service started")

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...")

    // Notify all connected agents
    for (const swarm of activeSwarms.values()) {
      broadcastToSwarm(swarm.swarm_id, { type: "coordinator_shutdown" })
    }

    await pool.end()
    await app.close()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  logger.error({ err }, "Fatal error")
  process.exit(1)
})
