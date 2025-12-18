-- =============================================================================
-- MindOS 10/10 SOTA Architecture - ToolMesh & Idempotency
-- Migration: 003_toolmesh_idempotency.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tool Registry: MCP tool storage with semantic embeddings
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tool_registry (
  namespaced_name TEXT PRIMARY KEY,  -- mcp__server__tool format
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Tool metadata
  description TEXT,
  input_schema JSONB,
  output_schema JSONB,
  annotations JSONB,

  -- Schema versioning
  schema_hash TEXT NOT NULL,

  -- Semantic search embedding
  embedding vector(3072),

  -- Tool hints (from MCP annotations)
  read_only_hint BOOLEAN DEFAULT false,
  destructive_hint BOOLEAN DEFAULT false,
  idempotent_hint BOOLEAN DEFAULT false,
  cost_hint TEXT,  -- 'low', 'medium', 'high'

  -- Usage statistics
  call_count BIGINT NOT NULL DEFAULT 0,
  success_count BIGINT NOT NULL DEFAULT 0,
  failure_count BIGINT NOT NULL DEFAULT 0,
  avg_latency_ms DOUBLE PRECISION,

  -- Health status
  last_health_check_at TIMESTAMPTZ,
  health_status TEXT DEFAULT 'unknown' CHECK (health_status IN ('healthy', 'degraded', 'unhealthy', 'unknown'))
);

CREATE INDEX idx_tool_registry_server ON tool_registry(server_id);
CREATE INDEX idx_tool_registry_embedding ON tool_registry
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_tool_registry_health ON tool_registry(health_status);

-- -----------------------------------------------------------------------------
-- Tool Call Log: Immutable history of all tool invocations
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tool_call_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Call identification
  trace_id TEXT,
  idempotency_key TEXT,

  -- Tool info
  namespaced_name TEXT NOT NULL,
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,

  -- Call data
  arguments JSONB,
  result JSONB,

  -- Execution metadata
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('running', 'done', 'failed', 'timeout')),
  attempts INT NOT NULL DEFAULT 1,
  duration_ms INT,
  error TEXT,

  -- Policy enforcement
  mode TEXT CHECK (mode IN ('read_only', 'write_safe', 'privileged')),
  policy_evaluation JSONB
);

CREATE INDEX idx_tool_call_log_trace ON tool_call_log(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX idx_tool_call_log_idempotency ON tool_call_log(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_tool_call_log_tool ON tool_call_log(namespaced_name, created_at DESC);
CREATE INDEX idx_tool_call_log_status ON tool_call_log(status) WHERE status = 'running';

-- -----------------------------------------------------------------------------
-- Tool Call Requests: Single-flight coordination for idempotency
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tool_call_requests (
  idempotency_key TEXT PRIMARY KEY,
  namespaced_name TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Request state
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  mode TEXT CHECK (mode IN ('read_only', 'write_safe', 'privileged')),

  -- Linking
  tool_call_id UUID REFERENCES tool_call_log(id),

  -- Error tracking
  error JSONB,

  -- Heartbeat for stale detection
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  owner_id TEXT  -- Instance ID that owns this request
);

CREATE INDEX idx_tool_call_requests_status ON tool_call_requests(status) WHERE status = 'running';
CREATE INDEX idx_tool_call_requests_stale ON tool_call_requests(heartbeat_at)
  WHERE status = 'running';

-- -----------------------------------------------------------------------------
-- MCP Server Registry: Track connected MCP servers
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mcp_servers (
  server_id TEXT PRIMARY KEY,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Connection config (stored encrypted in production)
  transport_type TEXT NOT NULL CHECK (transport_type IN ('stdio', 'http', 'sse')),
  config JSONB NOT NULL,

  -- Status
  connected BOOLEAN NOT NULL DEFAULT false,
  last_connected_at TIMESTAMPTZ,
  last_error TEXT,
  last_tool_refresh_at TIMESTAMPTZ,

  -- Tool count
  tool_count INT NOT NULL DEFAULT 0
);

-- -----------------------------------------------------------------------------
-- Retry Budgets: Per-tool retry configuration
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS retry_budgets (
  namespaced_name TEXT PRIMARY KEY REFERENCES tool_registry(namespaced_name) ON DELETE CASCADE,

  -- Budget configuration
  max_retries INT NOT NULL DEFAULT 3,
  initial_delay_ms INT NOT NULL DEFAULT 1000,
  max_delay_ms INT NOT NULL DEFAULT 30000,
  backoff_multiplier DOUBLE PRECISION NOT NULL DEFAULT 2.0,

  -- Current budget state (reset periodically)
  remaining_retries INT NOT NULL DEFAULT 3,
  budget_reset_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 hour',

  -- Circuit breaker
  circuit_state TEXT NOT NULL DEFAULT 'closed' CHECK (circuit_state IN ('closed', 'open', 'half_open')),
  circuit_opened_at TIMESTAMPTZ,
  failure_count INT NOT NULL DEFAULT 0,
  failure_threshold INT NOT NULL DEFAULT 5
);

-- -----------------------------------------------------------------------------
-- Functions: Idempotency helpers
-- -----------------------------------------------------------------------------

-- Acquire a request slot (single-flight pattern)
CREATE OR REPLACE FUNCTION acquire_tool_call_request(
  p_idempotency_key TEXT,
  p_namespaced_name TEXT,
  p_mode TEXT,
  p_owner_id TEXT
)
RETURNS TABLE (
  acquired BOOLEAN,
  existing_status TEXT,
  existing_tool_call_id UUID
) AS $$
DECLARE
  v_existing RECORD;
BEGIN
  -- Try to insert new request
  INSERT INTO tool_call_requests (idempotency_key, namespaced_name, mode, owner_id, status)
  VALUES (p_idempotency_key, p_namespaced_name, p_mode, p_owner_id, 'running')
  ON CONFLICT (idempotency_key) DO NOTHING;

  -- Check if we got it or someone else has it
  SELECT status, tool_call_id INTO v_existing
  FROM tool_call_requests
  WHERE idempotency_key = p_idempotency_key;

  IF v_existing.status = 'running' THEN
    -- Check if it's ours (we just inserted) or stale
    PERFORM 1 FROM tool_call_requests
    WHERE idempotency_key = p_idempotency_key
      AND owner_id = p_owner_id;

    IF FOUND THEN
      RETURN QUERY SELECT true, v_existing.status, v_existing.tool_call_id;
    ELSE
      -- Someone else has it, check for staleness
      PERFORM 1 FROM tool_call_requests
      WHERE idempotency_key = p_idempotency_key
        AND heartbeat_at < now() - interval '30 seconds';

      IF FOUND THEN
        -- Take over stale request
        UPDATE tool_call_requests
        SET owner_id = p_owner_id, heartbeat_at = now()
        WHERE idempotency_key = p_idempotency_key;

        RETURN QUERY SELECT true, v_existing.status, v_existing.tool_call_id;
      ELSE
        RETURN QUERY SELECT false, v_existing.status, v_existing.tool_call_id;
      END IF;
    END IF;
  ELSE
    -- Already completed (done or failed)
    RETURN QUERY SELECT false, v_existing.status, v_existing.tool_call_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Update heartbeat
CREATE OR REPLACE FUNCTION heartbeat_tool_call_request(
  p_idempotency_key TEXT,
  p_owner_id TEXT
)
RETURNS BOOLEAN AS $$
BEGIN
  UPDATE tool_call_requests
  SET heartbeat_at = now()
  WHERE idempotency_key = p_idempotency_key
    AND owner_id = p_owner_id
    AND status = 'running';

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Complete a request
CREATE OR REPLACE FUNCTION complete_tool_call_request(
  p_idempotency_key TEXT,
  p_tool_call_id UUID,
  p_success BOOLEAN,
  p_error JSONB DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  UPDATE tool_call_requests
  SET status = CASE WHEN p_success THEN 'done' ELSE 'failed' END,
      tool_call_id = p_tool_call_id,
      error = p_error,
      updated_at = now()
  WHERE idempotency_key = p_idempotency_key;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update tool_registry statistics
CREATE OR REPLACE FUNCTION update_tool_stats()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE tool_registry
  SET call_count = call_count + 1,
      success_count = success_count + CASE WHEN NEW.status = 'done' THEN 1 ELSE 0 END,
      failure_count = failure_count + CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
      avg_latency_ms = COALESCE(
        (avg_latency_ms * (call_count - 1) + COALESCE(NEW.duration_ms, 0)) / call_count,
        NEW.duration_ms
      ),
      updated_at = now()
  WHERE namespaced_name = NEW.namespaced_name;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tool_call_stats_trigger
  AFTER INSERT ON tool_call_log
  FOR EACH ROW
  WHEN (NEW.status IN ('done', 'failed'))
  EXECUTE FUNCTION update_tool_stats();
