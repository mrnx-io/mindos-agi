-- =============================================================================
-- MindOS 10/10 SOTA Architecture - Advanced Systems (Research Breakthroughs)
-- Migration: 004_advanced_systems.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- World Model States: Predictive simulation snapshots
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS world_model_states (
  state_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(task_id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- State type
  kind TEXT NOT NULL CHECK (kind IN ('snapshot', 'prediction', 'counterfactual', 'checkpoint')),

  -- World state representation
  state JSONB NOT NULL,

  -- Causal graph (entity relationships and dependencies)
  causal_graph JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Prediction metadata (for prediction states)
  predicted_from_state_id UUID REFERENCES world_model_states(state_id),
  predicted_action JSONB,
  prediction_confidence DOUBLE PRECISION CHECK (prediction_confidence >= 0 AND prediction_confidence <= 1),

  -- Verification (did prediction match reality?)
  verified_at TIMESTAMPTZ,
  actual_outcome JSONB,
  prediction_accuracy DOUBLE PRECISION CHECK (prediction_accuracy >= 0 AND prediction_accuracy <= 1)
);

CREATE INDEX idx_world_model_identity ON world_model_states(identity_id, created_at DESC);
CREATE INDEX idx_world_model_task ON world_model_states(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_world_model_kind ON world_model_states(kind);

-- -----------------------------------------------------------------------------
-- Metacognitive Observations: Self-monitoring data
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS metacognitive_observations (
  observation_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(task_id) ON DELETE SET NULL,
  step_id UUID REFERENCES task_steps(step_id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Observation type
  kind TEXT NOT NULL CHECK (kind IN (
    'confidence_assessment',
    'uncertainty_detection',
    'hypothesis_generation',
    'belief_update',
    'introspection',
    'capability_assessment',
    'failure_analysis'
  )),

  -- Self-observation data
  observation JSONB NOT NULL,

  -- Confidence in this observation
  meta_confidence DOUBLE PRECISION NOT NULL CHECK (meta_confidence >= 0 AND meta_confidence <= 1),

  -- Triggered actions
  triggered_actions JSONB DEFAULT '[]'::jsonb,

  -- Outcome (if any action was taken)
  outcome JSONB
);

CREATE INDEX idx_metacognitive_identity ON metacognitive_observations(identity_id, created_at DESC);
CREATE INDEX idx_metacognitive_task ON metacognitive_observations(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_metacognitive_kind ON metacognitive_observations(kind);

-- -----------------------------------------------------------------------------
-- Identity Evolution Log: Track changes to core_self over time
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS identity_evolution_log (
  evolution_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Change type
  kind TEXT NOT NULL CHECK (kind IN (
    'value_update',
    'goal_update',
    'constraint_update',
    'preference_learned',
    'relationship_formed',
    'capability_gained',
    'capability_deprecated',
    'personality_drift',
    'coherence_correction'
  )),

  -- What changed
  field_path TEXT NOT NULL,  -- JSON path within core_self
  old_value JSONB,
  new_value JSONB,

  -- Why it changed
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'task_outcome',
    'explicit_instruction',
    'reflection',
    'metacognitive',
    'swarm_consensus',
    'human_feedback',
    'coherence_check'
  )),
  trigger_reference TEXT,  -- task_id, instruction text, etc.

  -- Approval (for significant changes)
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  approved_at TIMESTAMPTZ,
  approved_by TEXT,

  -- Rollback support
  rolled_back_at TIMESTAMPTZ,
  rolled_back_by TEXT,
  rollback_reason TEXT
);

CREATE INDEX idx_identity_evolution_identity ON identity_evolution_log(identity_id, created_at DESC);
CREATE INDEX idx_identity_evolution_kind ON identity_evolution_log(kind);
CREATE INDEX idx_identity_evolution_pending ON identity_evolution_log(identity_id)
  WHERE requires_approval = true AND approved_at IS NULL;

-- -----------------------------------------------------------------------------
-- Swarm Coordination: Multi-agent consensus state
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS swarm_instances (
  instance_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Instance metadata
  name TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  specialization TEXT,

  -- Status
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'idle', 'busy', 'offline')),
  current_task_id UUID REFERENCES tasks(task_id),

  -- Performance metrics
  tasks_completed BIGINT NOT NULL DEFAULT 0,
  success_rate DOUBLE PRECISION,
  avg_task_duration_ms DOUBLE PRECISION
);

CREATE INDEX idx_swarm_instances_identity ON swarm_instances(identity_id);
CREATE INDEX idx_swarm_instances_status ON swarm_instances(status) WHERE status != 'offline';

CREATE TABLE IF NOT EXISTS swarm_consensus (
  consensus_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,

  -- Consensus topic
  topic TEXT NOT NULL,
  context JSONB NOT NULL,

  -- Proposals
  proposals JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Votes
  votes JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Resolution
  status TEXT NOT NULL DEFAULT 'voting' CHECK (status IN ('voting', 'resolved', 'deadlocked', 'timeout')),
  winning_proposal_idx INT,
  resolution_method TEXT,  -- 'majority', 'weighted', 'unanimous', 'tiebreaker'

  -- Timeout
  deadline_at TIMESTAMPTZ
);

CREATE INDEX idx_swarm_consensus_identity ON swarm_consensus(identity_id);
CREATE INDEX idx_swarm_consensus_status ON swarm_consensus(status) WHERE status = 'voting';

CREATE TABLE IF NOT EXISTS swarm_delegations (
  delegation_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,

  -- Delegation details
  delegator_instance_id UUID NOT NULL REFERENCES swarm_instances(instance_id),
  delegatee_instance_id UUID NOT NULL REFERENCES swarm_instances(instance_id),

  -- Subtask
  subtask_goal TEXT NOT NULL,
  subtask_context JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'in_progress', 'completed', 'failed')),

  -- Result
  result JSONB,
  error TEXT
);

CREATE INDEX idx_swarm_delegations_task ON swarm_delegations(task_id);
CREATE INDEX idx_swarm_delegations_delegatee ON swarm_delegations(delegatee_instance_id, status);

-- -----------------------------------------------------------------------------
-- Temporal Knowledge Graph: Contradiction resolution tracking
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS temporal_kg_edges (
  edge_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until TIMESTAMPTZ,  -- NULL = still valid

  -- Edge data
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,

  -- Confidence and provenance
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_type TEXT NOT NULL,  -- tool_call, inference, human_input, swarm_consensus
  source_reference TEXT,

  -- Contradiction handling
  supersedes_edge_id UUID REFERENCES temporal_kg_edges(edge_id),
  superseded_by_edge_id UUID REFERENCES temporal_kg_edges(edge_id),
  contradiction_resolution JSONB  -- How contradiction was resolved
);

CREATE INDEX idx_temporal_kg_identity ON temporal_kg_edges(identity_id);
CREATE INDEX idx_temporal_kg_subject ON temporal_kg_edges(subject);
CREATE INDEX idx_temporal_kg_valid ON temporal_kg_edges(identity_id, valid_from, valid_until);
CREATE INDEX idx_temporal_kg_active ON temporal_kg_edges(identity_id)
  WHERE valid_until IS NULL;

CREATE TABLE IF NOT EXISTS temporal_kg_contradictions (
  contradiction_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,

  -- Contradicting edges
  edge_a_id UUID NOT NULL REFERENCES temporal_kg_edges(edge_id),
  edge_b_id UUID NOT NULL REFERENCES temporal_kg_edges(edge_id),

  -- Detection
  detection_method TEXT NOT NULL,  -- 'direct', 'inference', 'external_grounding'
  contradiction_type TEXT NOT NULL,  -- 'factual', 'temporal', 'logical'

  -- Resolution
  status TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved', 'resolved', 'deferred')),
  resolution_method TEXT,  -- 'temporal_supersede', 'confidence_weight', 'human_decision', 'external_verify'
  winning_edge_id UUID REFERENCES temporal_kg_edges(edge_id),
  resolution_notes TEXT
);

CREATE INDEX idx_kg_contradictions_identity ON temporal_kg_contradictions(identity_id);
CREATE INDEX idx_kg_contradictions_status ON temporal_kg_contradictions(status)
  WHERE status = 'unresolved';

-- -----------------------------------------------------------------------------
-- Model Drift Monitoring: Track model quality over time
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS model_drift_checks (
  check_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Model identification
  provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  model_version TEXT,

  -- Test results
  test_suite TEXT NOT NULL,  -- 'capability', 'quality', 'latency', 'cost'
  test_results JSONB NOT NULL,

  -- Scores
  overall_score DOUBLE PRECISION NOT NULL CHECK (overall_score >= 0 AND overall_score <= 1),
  capability_scores JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Comparison to baseline
  baseline_check_id UUID REFERENCES model_drift_checks(check_id),
  drift_detected BOOLEAN NOT NULL DEFAULT false,
  drift_magnitude DOUBLE PRECISION,
  drift_details JSONB,

  -- Actions taken
  alert_sent BOOLEAN NOT NULL DEFAULT false,
  model_disabled BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_model_drift_model ON model_drift_checks(provider, model_name, created_at DESC);
CREATE INDEX idx_model_drift_alerts ON model_drift_checks(drift_detected, alert_sent)
  WHERE drift_detected = true AND alert_sent = false;

-- -----------------------------------------------------------------------------
-- Self-Improvement Proposals: Bounded recursive self-modification
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS self_improvement_proposals (
  proposal_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Proposal details
  kind TEXT NOT NULL CHECK (kind IN (
    'threshold_adjustment',
    'prompt_refinement',
    'skill_creation',
    'skill_deprecation',
    'routing_optimization',
    'policy_update'
  )),

  title TEXT NOT NULL,
  description TEXT NOT NULL,
  rationale TEXT NOT NULL,

  -- What would change
  target_component TEXT NOT NULL,
  current_state JSONB NOT NULL,
  proposed_state JSONB NOT NULL,

  -- Safety assessment
  risk_assessment JSONB NOT NULL,
  reversibility TEXT NOT NULL CHECK (reversibility IN ('instant', 'requires_rollback', 'irreversible')),
  safety_score DOUBLE PRECISION NOT NULL CHECK (safety_score >= 0 AND safety_score <= 1),

  -- Approval workflow
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'under_review', 'approved', 'rejected', 'applied', 'rolled_back'
  )),
  requires_human_approval BOOLEAN NOT NULL DEFAULT true,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,

  -- Application
  applied_at TIMESTAMPTZ,
  rollback_at TIMESTAMPTZ,
  rollback_reason TEXT,

  -- Effectiveness tracking
  effectiveness_check_at TIMESTAMPTZ,
  effectiveness_score DOUBLE PRECISION CHECK (effectiveness_score >= 0 AND effectiveness_score <= 1),
  effectiveness_notes TEXT
);

CREATE INDEX idx_self_improvement_identity ON self_improvement_proposals(identity_id, created_at DESC);
CREATE INDEX idx_self_improvement_status ON self_improvement_proposals(status);
CREATE INDEX idx_self_improvement_pending ON self_improvement_proposals(identity_id)
  WHERE status IN ('proposed', 'under_review');

-- -----------------------------------------------------------------------------
-- Adversarial Detection: Track potential attacks
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS adversarial_detections (
  detection_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(task_id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Detection type
  kind TEXT NOT NULL CHECK (kind IN (
    'prompt_injection',
    'tool_output_poisoning',
    'memory_contamination',
    'jailbreak_attempt',
    'data_exfiltration',
    'privilege_escalation'
  )),

  -- Detection details
  source TEXT NOT NULL,  -- 'input', 'tool_output', 'memory', 'external'
  raw_content TEXT,
  sanitized_content TEXT,
  detection_confidence DOUBLE PRECISION NOT NULL CHECK (detection_confidence >= 0 AND detection_confidence <= 1),

  -- Patterns matched
  patterns_matched JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Action taken
  action_taken TEXT NOT NULL CHECK (action_taken IN (
    'blocked', 'sanitized', 'flagged', 'allowed_with_warning'
  )),

  -- Review status
  reviewed BOOLEAN NOT NULL DEFAULT false,
  reviewed_by TEXT,
  false_positive BOOLEAN
);

CREATE INDEX idx_adversarial_identity ON adversarial_detections(identity_id, created_at DESC);
CREATE INDEX idx_adversarial_kind ON adversarial_detections(kind);
CREATE INDEX idx_adversarial_unreviewed ON adversarial_detections(identity_id)
  WHERE reviewed = false;

-- -----------------------------------------------------------------------------
-- Views: Useful aggregations
-- -----------------------------------------------------------------------------

-- Active agents in swarm
CREATE OR REPLACE VIEW active_swarm_agents AS
SELECT
  si.*,
  i.display_name AS identity_name,
  t.goal AS current_task_goal
FROM swarm_instances si
JOIN identities i ON si.identity_id = i.identity_id
LEFT JOIN tasks t ON si.current_task_id = t.task_id
WHERE si.status != 'offline'
  AND si.last_heartbeat_at > now() - interval '5 minutes';

-- Pending improvements requiring approval
CREATE OR REPLACE VIEW pending_improvements AS
SELECT
  sip.*,
  i.display_name AS identity_name
FROM self_improvement_proposals sip
JOIN identities i ON sip.identity_id = i.identity_id
WHERE sip.status IN ('proposed', 'under_review')
  AND sip.requires_human_approval = true
ORDER BY sip.created_at;

-- Recent adversarial activity
CREATE OR REPLACE VIEW recent_adversarial_activity AS
SELECT
  kind,
  COUNT(*) AS detection_count,
  AVG(detection_confidence) AS avg_confidence,
  COUNT(*) FILTER (WHERE false_positive = true) AS false_positives,
  MAX(created_at) AS latest_detection
FROM adversarial_detections
WHERE created_at > now() - interval '24 hours'
GROUP BY kind
ORDER BY detection_count DESC;
