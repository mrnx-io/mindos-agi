// =============================================================================
// MindOS - Swarm Coordination Types
// =============================================================================

import { z } from "zod"
import { UUIDSchema, TimestampSchema, JSONSchema } from "./schemas.js"

// -----------------------------------------------------------------------------
// Swarm Instance (Agent)
// -----------------------------------------------------------------------------

export const SwarmStatusSchema = z.enum(["active", "idle", "busy", "offline"])
export type SwarmStatus = z.infer<typeof SwarmStatusSchema>

export const SwarmInstanceSchema = z.object({
  instance_id: UUIDSchema,
  identity_id: UUIDSchema,
  name: z.string(),
  capabilities: z.array(z.string()),
  specialization: z.string().nullable().optional(),
  status: SwarmStatusSchema,
  current_task_id: UUIDSchema.nullable().optional(),
  tasks_completed: z.number().int().min(0),
  success_rate: z.number().min(0).max(1).nullable().optional(),
  avg_task_duration_ms: z.number().nullable().optional(),
  last_heartbeat_at: TimestampSchema,
  created_at: TimestampSchema,
})
export type SwarmInstance = z.infer<typeof SwarmInstanceSchema>

// -----------------------------------------------------------------------------
// Swarm Registration
// -----------------------------------------------------------------------------

export const RegisterAgentRequestSchema = z.object({
  identity_id: UUIDSchema,
  name: z.string(),
  capabilities: z.array(z.string()),
  specialization: z.string().optional(),
})
export type RegisterAgentRequest = z.infer<typeof RegisterAgentRequestSchema>

export const HeartbeatRequestSchema = z.object({
  instance_id: UUIDSchema,
  status: SwarmStatusSchema,
  current_task_id: UUIDSchema.nullable().optional(),
  metrics: z.object({
    cpu_usage: z.number().min(0).max(1).optional(),
    memory_usage: z.number().min(0).max(1).optional(),
    queue_depth: z.number().int().min(0).optional(),
  }).optional(),
})
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>

// -----------------------------------------------------------------------------
// Consensus
// -----------------------------------------------------------------------------

export const ConsensusStatusSchema = z.enum([
  "voting",
  "resolved",
  "deadlocked",
  "timeout",
])
export type ConsensusStatus = z.infer<typeof ConsensusStatusSchema>

export const ConsensusProposalSchema = z.object({
  proposal_idx: z.number().int().min(0),
  proposer_id: UUIDSchema,
  content: JSONSchema,
  rationale: z.string(),
})
export type ConsensusProposal = z.infer<typeof ConsensusProposalSchema>

export const ConsensusVoteSchema = z.object({
  voter_id: UUIDSchema,
  proposal_idx: z.number().int().min(0),
  weight: z.number().min(0).max(1).optional().default(1),
  confidence: z.number().min(0).max(1),
  rationale: z.string().optional(),
  timestamp: TimestampSchema,
})
export type ConsensusVote = z.infer<typeof ConsensusVoteSchema>

export const ConsensusSchema = z.object({
  consensus_id: UUIDSchema,
  identity_id: UUIDSchema,
  topic: z.string(),
  context: JSONSchema,
  proposals: z.array(ConsensusProposalSchema),
  votes: z.record(z.array(ConsensusVoteSchema)), // keyed by instance_id
  status: ConsensusStatusSchema,
  winning_proposal_idx: z.number().int().nullable().optional(),
  resolution_method: z.enum(["majority", "weighted", "unanimous", "tiebreaker"]).nullable().optional(),
  deadline_at: TimestampSchema.nullable().optional(),
  created_at: TimestampSchema,
  resolved_at: TimestampSchema.nullable().optional(),
})
export type Consensus = z.infer<typeof ConsensusSchema>

// -----------------------------------------------------------------------------
// Consensus Request/Response
// -----------------------------------------------------------------------------

export const StartConsensusRequestSchema = z.object({
  identity_id: UUIDSchema,
  topic: z.string(),
  context: JSONSchema,
  initial_proposals: z.array(z.object({
    content: JSONSchema,
    rationale: z.string(),
  })).optional(),
  deadline_seconds: z.number().int().min(10).max(3600).optional(),
  resolution_method: z.enum(["majority", "weighted", "unanimous"]).optional(),
})
export type StartConsensusRequest = z.infer<typeof StartConsensusRequestSchema>

export const SubmitVoteRequestSchema = z.object({
  consensus_id: UUIDSchema,
  voter_id: UUIDSchema,
  proposal_idx: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
  rationale: z.string().optional(),
})
export type SubmitVoteRequest = z.infer<typeof SubmitVoteRequestSchema>

// -----------------------------------------------------------------------------
// Delegation
// -----------------------------------------------------------------------------

export const DelegationStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "in_progress",
  "completed",
  "failed",
])
export type DelegationStatus = z.infer<typeof DelegationStatusSchema>

export const SwarmDelegationSchema = z.object({
  delegation_id: UUIDSchema,
  task_id: UUIDSchema,
  delegator_instance_id: UUIDSchema,
  delegatee_instance_id: UUIDSchema,
  subtask_goal: z.string(),
  subtask_context: JSONSchema,
  status: DelegationStatusSchema,
  result: JSONSchema.nullable().optional(),
  error: z.string().nullable().optional(),
  created_at: TimestampSchema,
  completed_at: TimestampSchema.nullable().optional(),
})
export type SwarmDelegation = z.infer<typeof SwarmDelegationSchema>

export const DelegateTaskRequestSchema = z.object({
  delegator_instance_id: UUIDSchema,
  task_id: UUIDSchema,
  subtask_goal: z.string(),
  subtask_context: JSONSchema,
  required_capabilities: z.array(z.string()).optional(),
  preferred_delegatee_id: UUIDSchema.optional(),
  deadline: TimestampSchema.optional(),
})
export type DelegateTaskRequest = z.infer<typeof DelegateTaskRequestSchema>

// -----------------------------------------------------------------------------
// Agent Discovery
// -----------------------------------------------------------------------------

export const FindAgentsRequestSchema = z.object({
  identity_id: UUIDSchema,
  required_capabilities: z.array(z.string()).optional(),
  specialization: z.string().optional(),
  status: SwarmStatusSchema.optional(),
  min_success_rate: z.number().min(0).max(1).optional(),
  limit: z.number().int().min(1).max(100).optional().default(10),
})
export type FindAgentsRequest = z.infer<typeof FindAgentsRequestSchema>

// -----------------------------------------------------------------------------
// Emergent Behavior Detection
// -----------------------------------------------------------------------------

export const EmergentBehaviorSchema = z.object({
  behavior_id: UUIDSchema,
  identity_id: UUIDSchema,
  description: z.string(),
  first_observed: TimestampSchema,
  occurrence_count: z.number().int().min(1),
  participating_agents: z.array(UUIDSchema),
  pattern: JSONSchema,
  beneficial: z.boolean().nullable(), // null = unknown
  requires_review: z.boolean(),
  reviewed_at: TimestampSchema.nullable().optional(),
  review_notes: z.string().nullable().optional(),
})
export type EmergentBehavior = z.infer<typeof EmergentBehaviorSchema>

// -----------------------------------------------------------------------------
// Collective Intelligence Metrics
// -----------------------------------------------------------------------------

export const CollectiveMetricsSchema = z.object({
  identity_id: UUIDSchema,
  period_start: TimestampSchema,
  period_end: TimestampSchema,
  active_agents: z.number().int(),
  total_tasks: z.number().int(),
  collaborative_tasks: z.number().int(),
  consensus_rounds: z.number().int(),
  delegations: z.number().int(),
  avg_consensus_time_ms: z.number(),
  swarm_efficiency: z.number().min(0).max(1), // Tasks completed / resources used
  specialization_diversity: z.number().min(0).max(1), // Variety of specializations
  emergent_behaviors_detected: z.number().int(),
})
export type CollectiveMetrics = z.infer<typeof CollectiveMetricsSchema>
