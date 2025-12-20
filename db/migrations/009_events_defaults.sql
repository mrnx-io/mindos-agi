-- -----------------------------------------------------------------------------
-- Provide defaults for legacy event columns so inserts from code succeed
-- -----------------------------------------------------------------------------

ALTER TABLE events
  ALTER COLUMN source SET DEFAULT 'internal',
  ALTER COLUMN type SET DEFAULT 'event';
