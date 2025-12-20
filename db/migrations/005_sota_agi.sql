-- =============================================================================
-- MindOS SOTA AGI Architecture - Self-Improvement & World Model Integration
-- Migration: 005_sota_agi.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Skill Usage Records: Track skill effectiveness for self-improvement
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS skill_usage_records (
  record_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  task_id UUID REFERENCES tasks(task_id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,

  -- Execution metrics
  success BOOLEAN,
  duration_ms DOUBLE PRECISION,
  error_message TEXT,

  -- Context
  invocation_context JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Effectiveness tracking
  outcome_quality DOUBLE PRECISION CHECK (outcome_quality >= 0 AND outcome_quality <= 1),
  user_feedback TEXT,

  -- Linked evidence
  evidence_ids TEXT[] DEFAULT '{}'
);

CREATE INDEX idx_skill_usage_identity ON skill_usage_records(identity_id, created_at DESC);
CREATE INDEX idx_skill_usage_skill ON skill_usage_records(skill_name, created_at DESC);
CREATE INDEX idx_skill_usage_success ON skill_usage_records(skill_name, success);

-- -----------------------------------------------------------------------------
-- Calibration History: Track confidence calibration adjustments
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS calibration_history (
  calibration_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Calibration type
  calibration_type TEXT NOT NULL CHECK (calibration_type IN (
    'threshold_adjustment',
    'confidence_factor',
    'bias_correction',
    'sample_size_update'
  )),

  -- What was adjusted
  target_component TEXT NOT NULL,
  previous_value JSONB NOT NULL,
  new_value JSONB NOT NULL,
  adjustment_magnitude DOUBLE PRECISION NOT NULL,

  -- Safety tracking
  cumulative_drift DOUBLE PRECISION NOT NULL DEFAULT 0,
  drift_since_reset DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_reset_at TIMESTAMPTZ,

  -- Approval (for significant changes)
  auto_applied BOOLEAN NOT NULL DEFAULT true,
  requires_notification BOOLEAN NOT NULL DEFAULT false,
  notification_sent BOOLEAN NOT NULL DEFAULT false,

  -- Rationale
  trigger_reason TEXT NOT NULL,
  calibration_metrics JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_calibration_identity ON calibration_history(identity_id, created_at DESC);
CREATE INDEX idx_calibration_type ON calibration_history(calibration_type);
CREATE INDEX idx_calibration_drift ON calibration_history(identity_id, cumulative_drift);

-- -----------------------------------------------------------------------------
-- Belief Conflicts: Track detected and resolved conflicts
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS belief_conflicts (
  conflict_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,

  -- Conflicting beliefs
  belief_a_id UUID NOT NULL,
  belief_b_id UUID NOT NULL,
  belief_a_statement TEXT NOT NULL,
  belief_b_statement TEXT NOT NULL,

  -- Conflict details
  conflict_type TEXT NOT NULL CHECK (conflict_type IN (
    'direct_contradiction',
    'implication_conflict',
    'evidence_mismatch',
    'temporal_inconsistency'
  )),
  severity DOUBLE PRECISION NOT NULL CHECK (severity >= 0 AND severity <= 1),

  -- Resolution
  status TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN (
    'unresolved', 'auto_resolved', 'escalated', 'human_resolved', 'deferred'
  )),
  resolution_type TEXT CHECK (resolution_type IN (
    'accept_newer', 'accept_stronger', 'merge', 'invalidate_all', 'custom'
  )),
  resolution_reasoning TEXT,
  winning_belief_id UUID,

  -- Human escalation
  escalated_at TIMESTAMPTZ,
  resolved_by TEXT
);

CREATE INDEX idx_belief_conflicts_identity ON belief_conflicts(identity_id, created_at DESC);
CREATE INDEX idx_belief_conflicts_status ON belief_conflicts(status) WHERE status = 'unresolved';
CREATE INDEX idx_belief_conflicts_severity ON belief_conflicts(identity_id, severity DESC);

-- -----------------------------------------------------------------------------
-- World Model Simulations: Store simulation results for predictions
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS world_model_simulations (
  simulation_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(task_id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Simulation type
  simulation_type TEXT NOT NULL CHECK (simulation_type IN (
    'action_prediction',
    'plan_validation',
    'lookahead',
    'counterfactual',
    'rollback_planning'
  )),

  -- Input state
  initial_state_id UUID REFERENCES world_model_states(state_id),
  simulated_actions JSONB NOT NULL,

  -- Results
  predicted_outcomes JSONB NOT NULL,
  predicted_states JSONB NOT NULL DEFAULT '[]'::jsonb,
  overall_confidence DOUBLE PRECISION NOT NULL CHECK (overall_confidence >= 0 AND overall_confidence <= 1),

  -- Risk analysis
  identified_risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_scenarios JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_checkpoints JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Verification (after execution)
  verified_at TIMESTAMPTZ,
  actual_outcomes JSONB,
  prediction_accuracy DOUBLE PRECISION CHECK (prediction_accuracy >= 0 AND prediction_accuracy <= 1)
);

CREATE INDEX idx_world_sim_identity ON world_model_simulations(identity_id, created_at DESC);
CREATE INDEX idx_world_sim_task ON world_model_simulations(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_world_sim_type ON world_model_simulations(simulation_type);

-- -----------------------------------------------------------------------------
-- World Model Checkpoints: Recovery points for rollback
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS world_model_checkpoints (
  checkpoint_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  step_id UUID REFERENCES task_steps(step_id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,

  -- Checkpoint data
  state_snapshot JSONB NOT NULL,
  causal_graph_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Context
  step_index INT NOT NULL,
  risk_level DOUBLE PRECISION NOT NULL CHECK (risk_level >= 0 AND risk_level <= 1),
  is_irreversible_next BOOLEAN NOT NULL DEFAULT false,

  -- Recovery metadata
  recovery_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  used_for_rollback BOOLEAN NOT NULL DEFAULT false,
  rolled_back_at TIMESTAMPTZ
);

CREATE INDEX idx_checkpoint_task ON world_model_checkpoints(task_id, step_index);
CREATE INDEX idx_checkpoint_identity ON world_model_checkpoints(identity_id, created_at DESC);
CREATE INDEX idx_checkpoint_active ON world_model_checkpoints(task_id, expires_at)
  WHERE used_for_rollback = false;

-- -----------------------------------------------------------------------------
-- World Model Predictions: Track prediction accuracy for calibration
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS world_model_predictions (
  prediction_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,
  simulation_id UUID REFERENCES world_model_simulations(simulation_id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(task_id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,

  -- Prediction content
  predicted_outcome JSONB NOT NULL,
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  -- Verification
  actual_outcome JSONB,
  accuracy_score DOUBLE PRECISION CHECK (accuracy_score >= 0 AND accuracy_score <= 1),

  -- Calibration contribution
  contributed_to_calibration BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_prediction_identity ON world_model_predictions(identity_id, created_at DESC);
CREATE INDEX idx_prediction_calibration ON world_model_predictions(identity_id, contributed_to_calibration, verified_at)
  WHERE verified_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Counterfactual Analyses: What-if analysis for learning
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS counterfactual_analyses (
  analysis_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  step_id UUID REFERENCES task_steps(step_id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Failed action context
  failed_action JSONB NOT NULL,
  actual_outcome JSONB NOT NULL,

  -- Counterfactual analysis
  alternative_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  simulated_outcomes JSONB NOT NULL DEFAULT '[]'::jsonb,
  best_alternative JSONB,

  -- Insights
  root_cause_hypothesis TEXT,
  preventability_score DOUBLE PRECISION CHECK (preventability_score >= 0 AND preventability_score <= 1),
  lessons_learned JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Applied learnings
  skill_created BOOLEAN NOT NULL DEFAULT false,
  skill_id UUID
);

CREATE INDEX idx_counterfactual_identity ON counterfactual_analyses(identity_id, created_at DESC);
CREATE INDEX idx_counterfactual_task ON counterfactual_analyses(task_id);

-- -----------------------------------------------------------------------------
-- Swarm Task Delegations: Extended delegation tracking
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS swarm_task_delegations (
  delegation_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  swarm_id UUID NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,

  -- Delegation details
  delegator_id UUID NOT NULL,
  delegatee_id UUID NOT NULL,

  -- Subtask
  subtask_goal TEXT NOT NULL,
  subtask_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_capabilities TEXT[] NOT NULL DEFAULT '{}',

  -- Decision process
  delegation_reason TEXT NOT NULL,
  alternative_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Execution
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'accepted', 'rejected', 'in_progress', 'completed', 'failed'
  )),

  -- Result
  result JSONB,
  error TEXT,
  duration_ms DOUBLE PRECISION,

  -- Performance tracking
  delegatee_performance_score DOUBLE PRECISION CHECK (delegatee_performance_score >= 0 AND delegatee_performance_score <= 1)
);

CREATE INDEX idx_swarm_delegation_task ON swarm_task_delegations(task_id);
CREATE INDEX idx_swarm_delegation_delegatee ON swarm_task_delegations(delegatee_id, status);
CREATE INDEX idx_swarm_delegation_swarm ON swarm_task_delegations(swarm_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Provider Verifications: Cross-provider verification results
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS provider_verifications (
  verification_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID REFERENCES identities(identity_id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(task_id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Verification context
  claim TEXT NOT NULL,
  claim_source TEXT NOT NULL,  -- 'xai_web_search', 'grounding_service', 'model_response'

  -- Provider results
  primary_provider TEXT NOT NULL,
  primary_result JSONB NOT NULL,
  primary_confidence DOUBLE PRECISION NOT NULL CHECK (primary_confidence >= 0 AND primary_confidence <= 1),

  secondary_provider TEXT,
  secondary_result JSONB,
  secondary_confidence DOUBLE PRECISION CHECK (secondary_confidence >= 0 AND secondary_confidence <= 1),

  -- Cross-verification
  verification_status TEXT NOT NULL CHECK (verification_status IN (
    'single_source', 'corroborated', 'contradicted', 'inconclusive'
  )),
  combined_confidence DOUBLE PRECISION NOT NULL CHECK (combined_confidence >= 0 AND combined_confidence <= 1),

  -- Resolution
  preferred_source TEXT,
  resolution_reasoning TEXT
);

CREATE INDEX idx_provider_verification_identity ON provider_verifications(identity_id, created_at DESC);
CREATE INDEX idx_provider_verification_status ON provider_verifications(verification_status);

-- -----------------------------------------------------------------------------
-- Hypothesis Actions: Track actions taken on confirmed/rejected hypotheses
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS hypothesis_actions (
  action_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hypothesis_id UUID NOT NULL,
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Trigger
  hypothesis_status TEXT NOT NULL CHECK (hypothesis_status IN ('confirmed', 'rejected')),
  hypothesis_type TEXT NOT NULL,
  hypothesis_statement TEXT NOT NULL,

  -- Action taken
  action_type TEXT NOT NULL CHECK (action_type IN (
    'skill_created',
    'skill_updated',
    'belief_updated',
    'threshold_adjusted',
    'learning_recorded',
    'no_action'
  )),

  -- Action details
  action_details JSONB NOT NULL,
  skill_id UUID,

  -- Effectiveness
  effectiveness_measured_at TIMESTAMPTZ,
  effectiveness_score DOUBLE PRECISION CHECK (effectiveness_score >= 0 AND effectiveness_score <= 1)
);

CREATE INDEX idx_hypothesis_actions_identity ON hypothesis_actions(identity_id, created_at DESC);
CREATE INDEX idx_hypothesis_actions_hypothesis ON hypothesis_actions(hypothesis_id);

-- -----------------------------------------------------------------------------
-- Collaboration Patterns: Detected multi-agent collaboration patterns
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collaboration_patterns (
  pattern_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  swarm_id UUID NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Pattern type
  pattern_type TEXT NOT NULL CHECK (pattern_type IN (
    'handoff_chain',
    'parallel_execution',
    'consensus_building',
    'specialization_emergence',
    'load_balancing',
    'novel_strategy'
  )),

  -- Pattern details
  description TEXT NOT NULL,
  participating_agents TEXT[] NOT NULL DEFAULT '{}',

  -- Evidence
  observation_count INT NOT NULL DEFAULT 1,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Metrics
  efficiency_gain DOUBLE PRECISION,  -- Compared to single-agent baseline
  success_rate DOUBLE PRECISION CHECK (success_rate >= 0 AND success_rate <= 1),
  significance DOUBLE PRECISION NOT NULL CHECK (significance >= 0 AND significance <= 1)
);

CREATE INDEX idx_collab_patterns_swarm ON collaboration_patterns(swarm_id, created_at DESC);
CREATE INDEX idx_collab_patterns_type ON collaboration_patterns(pattern_type);

-- -----------------------------------------------------------------------------
-- Views: Useful aggregations for SOTA features
-- -----------------------------------------------------------------------------

-- Skill effectiveness summary
CREATE OR REPLACE VIEW skill_effectiveness_summary AS
SELECT
  identity_id,
  skill_name,
  COUNT(*) AS total_uses,
  COUNT(*) FILTER (WHERE success = true) AS successful_uses,
  ROUND(AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END)::numeric, 3) AS success_rate,
  ROUND(AVG(duration_ms)::numeric, 2) AS avg_duration_ms,
  ROUND(AVG(outcome_quality)::numeric, 3) AS avg_quality,
  MAX(created_at) AS last_used_at
FROM skill_usage_records
GROUP BY identity_id, skill_name;

-- Calibration drift monitor
CREATE OR REPLACE VIEW calibration_drift_monitor AS
SELECT
  identity_id,
  calibration_type,
  SUM(adjustment_magnitude) AS total_adjustment,
  MAX(cumulative_drift) AS current_drift,
  COUNT(*) AS adjustment_count,
  MAX(created_at) AS last_adjustment_at,
  CASE
    WHEN MAX(cumulative_drift) > 0.20 THEN 'critical'
    WHEN MAX(cumulative_drift) > 0.15 THEN 'warning'
    ELSE 'normal'
  END AS drift_status
FROM calibration_history
WHERE created_at > now() - interval '7 days'
GROUP BY identity_id, calibration_type;

-- Prediction accuracy trends
CREATE OR REPLACE VIEW prediction_accuracy_trends AS
SELECT
  identity_id,
  DATE_TRUNC('day', created_at) AS date,
  COUNT(*) AS predictions_made,
  COUNT(*) FILTER (WHERE verified_at IS NOT NULL) AS predictions_verified,
  ROUND(AVG(confidence)::numeric, 3) AS avg_confidence,
  ROUND(AVG(accuracy_score)::numeric, 3) AS avg_accuracy,
  ROUND(ABS(AVG(confidence) - AVG(accuracy_score))::numeric, 3) AS calibration_error
FROM world_model_predictions
WHERE created_at > now() - interval '30 days'
GROUP BY identity_id, DATE_TRUNC('day', created_at)
ORDER BY identity_id, date DESC;

-- Unresolved belief conflicts
CREATE OR REPLACE VIEW unresolved_belief_conflicts AS
SELECT
  bc.*,
  i.display_name AS identity_name
FROM belief_conflicts bc
JOIN identities i ON bc.identity_id = i.identity_id
WHERE bc.status = 'unresolved'
ORDER BY bc.severity DESC, bc.created_at;

-- Swarm delegation performance
CREATE OR REPLACE VIEW swarm_delegation_performance AS
SELECT
  swarm_id,
  delegatee_id,
  COUNT(*) AS total_delegations,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
  ROUND(AVG(CASE WHEN status = 'completed' THEN 1.0 ELSE 0.0 END)::numeric, 3) AS completion_rate,
  ROUND(AVG(duration_ms)::numeric, 2) AS avg_duration_ms,
  ROUND(AVG(delegatee_performance_score)::numeric, 3) AS avg_performance
FROM swarm_task_delegations
WHERE completed_at IS NOT NULL
GROUP BY swarm_id, delegatee_id;
