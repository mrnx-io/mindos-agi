-- =============================================================================
-- MindOS 10/10 SOTA Architecture - Core Schema
-- Migration: 001_init.sql
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- -----------------------------------------------------------------------------
-- Identities: Persistent agent self-models
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS identities (
  identity_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  display_name TEXT NOT NULL,

  -- Autobiographical core: values, goals, constraints, personality
  core_self JSONB NOT NULL DEFAULT '{
    "values": [],
    "goals": [],
    "constraints": [],
    "personality_traits": {},
    "trust_defaults": {}
  }'::jsonb,

  -- Policy profile: trust boundaries, approval modes
  policy_profile JSONB NOT NULL DEFAULT '{
    "mode": "human_gated",
    "risk_threshold": 0.35,
    "approval_threshold": 0.60,
    "allowed_tool_globs": ["*"],
    "denied_tool_globs": [],
    "max_iterations": 20
  }'::jsonb,

  -- Metadata
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_identities_display_name ON identities(display_name);

-- -----------------------------------------------------------------------------
-- Events: Immutable episodic log (episodic truth)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS events (
  event_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Event classification
  source TEXT NOT NULL,  -- gmail, slack, api, monitor, webhook, etc.
  type TEXT NOT NULL,    -- email.received, goal.submitted, calendar.changed, etc.

  -- Event data
  payload JSONB NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_events_identity_time ON events(identity_id, occurred_at DESC);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_source ON events(source);

-- -----------------------------------------------------------------------------
-- Tasks: Goal tracking with risk scoring
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tasks (
  task_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,
  parent_task_id UUID REFERENCES tasks(task_id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Task state
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'waiting_approval', 'paused', 'done', 'failed', 'cancelled')),

  priority INT NOT NULL DEFAULT 5 CHECK (priority >= 0 AND priority <= 10),
  goal TEXT NOT NULL,

  -- Risk assessment
  risk_score DOUBLE PRECISION NOT NULL DEFAULT 0.0 CHECK (risk_score >= 0 AND risk_score <= 1),
  confidence_score DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (confidence_score >= 0 AND confidence_score <= 1),

  -- Execution metadata
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  error TEXT
);

CREATE INDEX idx_tasks_identity_status ON tasks(identity_id, status);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX idx_tasks_created ON tasks(created_at DESC);

-- -----------------------------------------------------------------------------
-- Task Steps: Fine-grained workflow steps
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task_steps (
  step_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  step_idx INT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Step classification
  kind TEXT NOT NULL CHECK (kind IN ('plan', 'tool', 'decision', 'note', 'report', 'reflection', 'metacognition')),
  name TEXT NOT NULL,

  -- Step data
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,

  -- Evidence tracking
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Timing
  duration_ms INT,
  model_used TEXT
);

CREATE UNIQUE INDEX uq_task_steps ON task_steps(task_id, step_idx);
CREATE INDEX idx_task_steps_kind ON task_steps(kind);

-- -----------------------------------------------------------------------------
-- Approvals: Human-in-loop gates
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,

  -- Approval state
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'timeout', 'escalated')),

  -- Request details
  request JSONB NOT NULL,  -- { action, reason, risk_score, context }
  resolution JSONB,        -- { level, note, approved_by }

  -- Notification tracking
  notified_at TIMESTAMPTZ,
  reminder_count INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_approvals_task ON approvals(task_id);
CREATE INDEX idx_approvals_status ON approvals(status) WHERE status = 'pending';

-- -----------------------------------------------------------------------------
-- Semantic Memories: Vector embeddings for RAG
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS semantic_memories (
  memory_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Memory classification
  kind TEXT NOT NULL CHECK (kind IN ('semantic', 'procedural', 'constraint', 'preference', 'relationship')),

  -- Content
  text TEXT NOT NULL,
  embedding vector(1536) NOT NULL,

  -- Metadata
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Confidence and decay
  confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  access_count INT NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ
);

CREATE INDEX idx_semantic_identity_kind ON semantic_memories(identity_id, kind);
CREATE INDEX idx_semantic_embedding ON semantic_memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 200);
CREATE INDEX idx_semantic_confidence ON semantic_memories(identity_id, confidence DESC);

-- -----------------------------------------------------------------------------
-- Functions: Auto-update timestamps
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER identities_updated_at
  BEFORE UPDATE ON identities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER semantic_memories_updated_at
  BEFORE UPDATE ON semantic_memories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
