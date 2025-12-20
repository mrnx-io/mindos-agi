-- -----------------------------------------------------------------------------
-- Align database schema with current mind-service expectations
-- -----------------------------------------------------------------------------

-- Tasks: add runtime timestamps + default status
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE tasks
  ALTER COLUMN status SET DEFAULT 'pending';

-- Events: add task linkage + kind + created_at defaults
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES tasks(task_id) ON DELETE SET NULL;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS kind TEXT;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE events
  ALTER COLUMN occurred_at SET DEFAULT now();

UPDATE events SET kind = type WHERE kind IS NULL AND type IS NOT NULL;
UPDATE events SET kind = 'event' WHERE kind IS NULL;
ALTER TABLE events ALTER COLUMN kind SET NOT NULL;

-- Approvals: align columns with policy/task usage
ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS step_id UUID,
  ADD COLUMN IF NOT EXISTS action JSONB,
  ADD COLUMN IF NOT EXISTS risk_score DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS approved_by TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE approvals
  ALTER COLUMN request DROP NOT NULL,
  ALTER COLUMN request SET DEFAULT '{}'::jsonb;

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
  WHERE t.relname = 'approvals'
    AND c.contype = 'c'
    AND a.attname = 'status'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE approvals DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_status_check
  CHECK (status IN ('pending', 'approved', 'denied', 'rejected', 'timeout', 'escalated'));

-- Task steps: align columns used by task workflow
ALTER TABLE task_steps
  ADD COLUMN IF NOT EXISTS sequence INT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS action JSONB,
  ADD COLUMN IF NOT EXISTS result JSONB,
  ADD COLUMN IF NOT EXISTS evidence_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

UPDATE task_steps SET sequence = step_idx WHERE sequence IS NULL AND step_idx IS NOT NULL;
ALTER TABLE task_steps ALTER COLUMN sequence SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_steps_task_sequence ON task_steps(task_id, sequence);

-- Semantic memories: align columns used by memory subsystem
ALTER TABLE semantic_memories
  ADD COLUMN IF NOT EXISTS content TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB,
  ADD COLUMN IF NOT EXISTS source_event_id UUID,
  ADD COLUMN IF NOT EXISTS accessed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decay_factor DOUBLE PRECISION NOT NULL DEFAULT 1.0;

UPDATE semantic_memories SET content = text WHERE content IS NULL AND text IS NOT NULL;
UPDATE semantic_memories SET metadata = meta WHERE metadata IS NULL AND meta IS NOT NULL;
UPDATE semantic_memories SET accessed_at = last_accessed_at
  WHERE accessed_at IS NULL AND last_accessed_at IS NOT NULL;
UPDATE semantic_memories SET metadata = '{}'::jsonb WHERE metadata IS NULL;
ALTER TABLE semantic_memories ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;
