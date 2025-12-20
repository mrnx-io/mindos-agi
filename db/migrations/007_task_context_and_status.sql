-- -----------------------------------------------------------------------------
-- Task context + status constraint alignment (code expects context + pending)
-- -----------------------------------------------------------------------------

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS context JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
  WHERE t.relname = 'tasks'
    AND c.contype = 'c'
    AND a.attname = 'status'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tasks DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (status IN (
    'queued',
    'pending',
    'running',
    'waiting_approval',
    'paused',
    'done',
    'completed',
    'failed',
    'cancelled',
    'blocked',
    'rejected'
  ));
