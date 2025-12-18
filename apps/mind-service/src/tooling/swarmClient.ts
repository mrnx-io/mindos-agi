// =============================================================================
// Swarm Client - HTTP Client for Swarm Coordinator Service
// =============================================================================
// Enables mind-service to delegate tasks to and coordinate with the swarm.

import { env } from "../config.js"
import { createLogger } from "../logger.js"
import type { ExecutionPlan } from "../types.js"

const log = createLogger("swarm-client")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SwarmInstance {
  swarm_id: string
  name: string
  objective: string
  status: "forming" | "active" | "voting" | "dissolving" | "completed"
  leader_id?: string
  agents: SwarmAgent[]
  consensus_term: number
  pending_proposals: number
  created_at: string
}

export interface SwarmAgent {
  agent_id: string
  identity_id: string
  role: "leader" | "worker" | "observer"
  capabilities: string[]
  specialization?: string
  status: "active" | "busy" | "offline"
}

export interface DelegationRequest {
  task_id: string
  goal: string
  plan: ExecutionPlan
  required_capabilities: string[]
  priority: "low" | "medium" | "high" | "critical"
  estimated_duration_ms: number
  risk_level: number
}

export interface DelegationResponse {
  delegation_id: string
  swarm_id: string
  assigned_agent_id: string
  status: "pending" | "accepted" | "rejected"
  estimated_completion_at?: string
}

export interface DelegationResult {
  delegation_id: string
  status: "completed" | "failed"
  result?: unknown
  error?: string
  duration_ms: number
  agent_performance_score?: number
}

export interface ConsensusProposal {
  proposal_id: string
  proposer_id: string
  type: "task_delegation" | "role_assignment" | "evidence_reconciliation" | "swarm_dissolution"
  content: Record<string, unknown>
  votes_for: string[]
  votes_against: string[]
  status: "pending" | "accepted" | "rejected"
}

export interface ConsensusDecision {
  decision_id: string
  proposal_id: string
  outcome: "accepted" | "rejected"
  vote_count: { for: number; against: number; abstain: number }
}

export interface DelegationDecision {
  shouldDelegate: boolean
  reason: string
  suggestedSwarmSize?: number
  parallelizablePaths?: number
  requiredCapabilities?: string[]
}

// -----------------------------------------------------------------------------
// Swarm Client Interface
// -----------------------------------------------------------------------------

export interface SwarmClient {
  // Swarm management
  createSwarm(name: string, objective: string): Promise<SwarmInstance>
  getSwarm(swarmId: string): Promise<SwarmInstance | null>
  listSwarms(): Promise<SwarmInstance[]>

  // Agent operations
  joinSwarm(
    swarmId: string,
    agentId: string,
    identityId: string,
    capabilities: string[]
  ): Promise<SwarmAgent | null>
  leaveSwarm(swarmId: string, agentId: string): Promise<boolean>

  // Delegation
  requestDelegation(request: DelegationRequest): Promise<DelegationResponse>
  waitForDelegationResult(delegationId: string, timeoutMs?: number): Promise<DelegationResult>

  // Consensus
  proposeConsensus(
    swarmId: string,
    proposerId: string,
    type: ConsensusProposal["type"],
    content: Record<string, unknown>
  ): Promise<ConsensusProposal>
  voteOnProposal(
    swarmId: string,
    agentId: string,
    proposalId: string,
    vote: "for" | "against"
  ): Promise<boolean>

  // Decision helpers
  shouldDelegateToSwarm(plan: ExecutionPlan, identityId: string): Promise<DelegationDecision>
}

// -----------------------------------------------------------------------------
// Create Swarm Client
// -----------------------------------------------------------------------------

export function createSwarmClient(): SwarmClient {
  const baseUrl = env.SWARM_COORDINATOR_URL

  async function fetchWithTimeout<T>(
    path: string,
    options: RequestInit = {},
    timeoutMs = 30000
  ): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Unknown error" }))
        const errorMessage =
          typeof errorData === "object" &&
          errorData !== null &&
          "error" in errorData &&
          typeof errorData.error === "string"
            ? errorData.error
            : `HTTP ${response.status}`
        throw new Error(errorMessage)
      }

      return response.json() as Promise<T>
    } finally {
      clearTimeout(timeout)
    }
  }

  // ---------------------------------------------------------------------------
  // Swarm Management
  // ---------------------------------------------------------------------------

  async function createSwarm(name: string, objective: string): Promise<SwarmInstance> {
    log.info({ name, objective }, "Creating swarm")

    const result = await fetchWithTimeout<SwarmInstance>("/swarms", {
      method: "POST",
      body: JSON.stringify({ name, objective }),
    })

    log.info({ swarmId: result.swarm_id }, "Swarm created")
    return result
  }

  async function getSwarm(swarmId: string): Promise<SwarmInstance | null> {
    try {
      return await fetchWithTimeout<SwarmInstance>(`/swarms/${swarmId}`)
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        return null
      }
      throw error
    }
  }

  async function listSwarms(): Promise<SwarmInstance[]> {
    const result = await fetchWithTimeout<{ swarms: SwarmInstance[] }>("/swarms")
    return result.swarms
  }

  // ---------------------------------------------------------------------------
  // Agent Operations
  // ---------------------------------------------------------------------------

  async function joinSwarm(
    swarmId: string,
    agentId: string,
    identityId: string,
    capabilities: string[]
  ): Promise<SwarmAgent | null> {
    log.info({ swarmId, agentId, capabilities }, "Joining swarm")

    try {
      const result = await fetchWithTimeout<SwarmAgent>(`/swarms/${swarmId}/join`, {
        method: "POST",
        body: JSON.stringify({ agent_id: agentId, identity_id: identityId, capabilities }),
      })

      log.info({ swarmId, agentId, role: result.role }, "Joined swarm")
      return result
    } catch (error) {
      log.warn({ swarmId, agentId, error }, "Failed to join swarm")
      return null
    }
  }

  async function leaveSwarm(swarmId: string, agentId: string): Promise<boolean> {
    log.info({ swarmId, agentId }, "Leaving swarm")

    try {
      await fetchWithTimeout<{ success: boolean }>(`/swarms/${swarmId}/leave`, {
        method: "POST",
        body: JSON.stringify({ agent_id: agentId }),
      })
      return true
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Delegation
  // ---------------------------------------------------------------------------

  async function requestDelegation(request: DelegationRequest): Promise<DelegationResponse> {
    log.info(
      {
        taskId: request.task_id,
        goal: request.goal.slice(0, 50),
        priority: request.priority,
      },
      "Requesting task delegation"
    )

    // Find or create an appropriate swarm
    const swarms = await listSwarms()
    let targetSwarm = swarms.find(
      (s) => s.status === "active" && s.agents.length < env.MAX_SWARM_SIZE
    )

    if (!targetSwarm) {
      targetSwarm = await createSwarm(`task-${request.task_id.slice(0, 8)}`, request.goal)
    }

    // Request delegation
    const result = await fetchWithTimeout<DelegationResponse>(
      `/swarms/${targetSwarm.swarm_id}/delegate`,
      {
        method: "POST",
        body: JSON.stringify({
          task_id: request.task_id,
          capabilities_needed: request.required_capabilities,
          delegated_by: "mind-service",
          priority: request.priority,
        }),
      }
    )

    log.info(
      { delegationId: result.delegation_id, assignedAgent: result.assigned_agent_id },
      "Delegation request submitted"
    )

    return result
  }

  async function waitForDelegationResult(
    delegationId: string,
    timeoutMs = 300000
  ): Promise<DelegationResult> {
    const startTime = Date.now()
    const pollInterval = 2000

    while (Date.now() - startTime < timeoutMs) {
      // Poll for result
      try {
        const swarms = await listSwarms()

        for (const swarm of swarms) {
          // Check delegation status via swarm's behaviors endpoint
          const behaviors = await fetchWithTimeout<{
            behaviors: Array<{ delegation_id?: string; status?: string; result?: unknown }>
          }>(`/swarms/${swarm.swarm_id}/behaviors`)

          const delegation = behaviors.behaviors.find((b) => b.delegation_id === delegationId)
          if (delegation && (delegation.status === "completed" || delegation.status === "failed")) {
            return {
              delegation_id: delegationId,
              status: delegation.status as "completed" | "failed",
              result: delegation.result,
              duration_ms: Date.now() - startTime,
            }
          }
        }
      } catch {
        // Continue polling
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    }

    throw new Error(`Delegation ${delegationId} timed out after ${timeoutMs}ms`)
  }

  // ---------------------------------------------------------------------------
  // Consensus
  // ---------------------------------------------------------------------------

  async function proposeConsensus(
    swarmId: string,
    proposerId: string,
    type: ConsensusProposal["type"],
    content: Record<string, unknown>
  ): Promise<ConsensusProposal> {
    log.info({ swarmId, proposerId, type }, "Proposing consensus")

    return fetchWithTimeout<ConsensusProposal>(`/swarms/${swarmId}/propose`, {
      method: "POST",
      body: JSON.stringify({ proposer_id: proposerId, type, content }),
    })
  }

  async function voteOnProposal(
    swarmId: string,
    agentId: string,
    proposalId: string,
    vote: "for" | "against"
  ): Promise<boolean> {
    log.info({ swarmId, agentId, proposalId, vote }, "Voting on proposal")

    try {
      await fetchWithTimeout<{ success: boolean }>(`/swarms/${swarmId}/vote`, {
        method: "POST",
        body: JSON.stringify({ agent_id: agentId, proposal_id: proposalId, vote }),
      })
      return true
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Decision Helpers
  // ---------------------------------------------------------------------------

  async function shouldDelegateToSwarm(
    plan: ExecutionPlan,
    _identityId: string
  ): Promise<DelegationDecision> {
    // Check if swarm is enabled
    if (!env.ENABLE_SWARM) {
      return {
        shouldDelegate: false,
        reason: "Swarm collaboration is disabled",
      }
    }

    const stepCount = plan.steps.length
    const estimatedDuration = estimatePlanDuration(plan)
    const riskLevel = plan.estimated_risk

    // Rule 1: Plan has many steps
    if (stepCount >= env.SWARM_DELEGATION_MIN_STEPS) {
      const parallelPaths = detectParallelizablePaths(plan)
      if (parallelPaths > 1) {
        return {
          shouldDelegate: true,
          reason: `Plan has ${stepCount} steps with ${parallelPaths} parallelizable paths`,
          suggestedSwarmSize: Math.min(parallelPaths + 1, 5),
          parallelizablePaths: parallelPaths,
          requiredCapabilities: extractRequiredCapabilities(plan),
        }
      }
    }

    // Rule 2: Estimated duration is long
    if (estimatedDuration >= env.SWARM_DELEGATION_MIN_DURATION_MS) {
      return {
        shouldDelegate: true,
        reason: `Plan estimated duration (${Math.round(estimatedDuration / 60000)}min) exceeds threshold`,
        suggestedSwarmSize: 3,
        requiredCapabilities: extractRequiredCapabilities(plan),
      }
    }

    // Rule 3: High risk requiring consensus validation
    if (riskLevel >= env.SWARM_DELEGATION_RISK_THRESHOLD) {
      return {
        shouldDelegate: true,
        reason: `Plan risk level (${(riskLevel * 100).toFixed(0)}%) requires consensus validation`,
        suggestedSwarmSize: 3,
        requiredCapabilities: extractRequiredCapabilities(plan),
      }
    }

    // Rule 4: Multiple distinct capability domains
    const capabilities = extractRequiredCapabilities(plan)
    const capabilityDomains = categorizeCapabilities(capabilities)
    if (Object.keys(capabilityDomains).length >= 3) {
      return {
        shouldDelegate: true,
        reason: `Plan requires ${Object.keys(capabilityDomains).length} distinct capability domains`,
        suggestedSwarmSize: Object.keys(capabilityDomains).length,
        requiredCapabilities: capabilities,
      }
    }

    return {
      shouldDelegate: false,
      reason: "Plan is simple enough for single-agent execution",
    }
  }

  // ---------------------------------------------------------------------------
  // Helper Functions
  // ---------------------------------------------------------------------------

  function estimatePlanDuration(plan: ExecutionPlan): number {
    // Estimate based on step count and tool types
    return plan.steps.reduce((totalMs, step) => totalMs + estimateStepDuration(step), 0)
  }

  function estimateStepDuration(step: ExecutionPlan["steps"][0]): number {
    if (!step.tool) {
      return 1000 // Planning/reasoning ~1s
    }

    const tool = step.tool.toLowerCase()

    if (tool.includes("api") || tool.includes("fetch") || tool.includes("search")) {
      return 5000 // API calls ~5s
    }
    if (tool.includes("execute") || tool.includes("run")) {
      return 30000 // Code execution ~30s
    }
    if (tool.includes("write") || tool.includes("edit")) {
      return 2000 // File operations ~2s
    }

    return 3000 // Default ~3s
  }

  function detectParallelizablePaths(plan: ExecutionPlan): number {
    // Simple heuristic: count independent step groups
    // Steps that don't reference each other's outputs can run in parallel
    const stepDependencies = buildStepDependencies(plan)
    return countIndependentStarts(stepDependencies)
  }

  function buildStepDependencies(plan: ExecutionPlan): Map<number, Set<number>> {
    const dependencies: Map<number, Set<number>> = new Map()

    for (let i = 0; i < plan.steps.length; i++) {
      dependencies.set(i, findDependenciesForStep(plan, i))
    }

    return dependencies
  }

  function findDependenciesForStep(plan: ExecutionPlan, stepIndex: number): Set<number> {
    const deps = new Set<number>()
    const step = plan.steps[stepIndex]

    if (!step) return deps

    const stepDesc = step.description.toLowerCase()

    for (let j = 0; j < stepIndex; j++) {
      const prevStep = plan.steps[j]
      if (prevStep?.tool && stepDesc.includes(prevStep.tool.toLowerCase())) {
        deps.add(j)
      }
    }

    return deps
  }

  function countIndependentStarts(stepDependencies: Map<number, Set<number>>): number {
    let independentStarts = 0

    for (const [step, deps] of stepDependencies.entries()) {
      if (deps.size === 0 && step > 0) {
        independentStarts++
      }
    }

    return Math.max(1, independentStarts)
  }

  function extractRequiredCapabilities(plan: ExecutionPlan): string[] {
    const capabilities = new Set<string>()

    for (const step of plan.steps) {
      addCapabilitiesFromStep(step, capabilities)
    }

    return Array.from(capabilities)
  }

  function addCapabilitiesFromStep(
    step: ExecutionPlan["steps"][0],
    capabilities: Set<string>
  ): void {
    if (step.tool) {
      capabilities.add(step.tool)
    }

    addImplicitCapabilities(step.description, capabilities)
  }

  function addImplicitCapabilities(description: string, capabilities: Set<string>): void {
    const desc = description.toLowerCase()

    if (desc.includes("code") || desc.includes("program")) {
      capabilities.add("code_execution")
    }
    if (desc.includes("search") || desc.includes("find")) {
      capabilities.add("web_search")
    }
    if (desc.includes("file") || desc.includes("read") || desc.includes("write")) {
      capabilities.add("file_operations")
    }
    if (desc.includes("api") || desc.includes("request")) {
      capabilities.add("api_calls")
    }
  }

  function categorizeCapabilities(capabilities: string[]): Record<string, string[]> {
    const categories: Record<string, string[]> = {}

    for (const cap of capabilities) {
      const category = determineCapabilityCategory(cap)
      categories[category] = categories[category] ?? []
      categories[category].push(cap)
    }

    return categories
  }

  function determineCapabilityCategory(capability: string): string {
    const capLower = capability.toLowerCase()

    if (capLower.includes("search") || capLower.includes("web")) {
      return "web"
    }
    if (capLower.includes("code") || capLower.includes("execute")) {
      return "compute"
    }
    if (capLower.includes("file") || capLower.includes("read") || capLower.includes("write")) {
      return "storage"
    }
    if (capLower.includes("api") || capLower.includes("http")) {
      return "integration"
    }

    return "general"
  }

  return {
    createSwarm,
    getSwarm,
    listSwarms,
    joinSwarm,
    leaveSwarm,
    requestDelegation,
    waitForDelegationResult,
    proposeConsensus,
    voteOnProposal,
    shouldDelegateToSwarm,
  }
}

// Export singleton
export const swarmClient = createSwarmClient()
