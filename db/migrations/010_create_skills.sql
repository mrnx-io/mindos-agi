-- -----------------------------------------------------------------------------
-- Skills table required by memory subsystem
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS skills (
  skill_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  trigger_patterns TEXT[] NOT NULL DEFAULT '{}'::text[],
  tool_sequence JSONB NOT NULL DEFAULT '[]'::jsonb,
  preconditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  postconditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  success_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  execution_count INT NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_skills_identity_name ON skills(identity_id, name);
CREATE INDEX IF NOT EXISTS idx_skills_identity ON skills(identity_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'skills_updated_at'
  ) THEN
    EXECUTE 'CREATE TRIGGER skills_updated_at BEFORE UPDATE ON skills FOR EACH ROW EXECUTE FUNCTION update_updated_at()';
  END IF;
END $$;
