-- =============================================================================
-- MindOS - Unify embedding dimensions to 3072 (text-embedding-3-large)
-- Migration: 006_unify_embedding_dimensions.sql
-- =============================================================================

-- Ensure pgvector is available
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Semantic memories (was 1536, now 3072)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  dims INT;
BEGIN
  SELECT vector_dims(embedding) INTO dims
  FROM semantic_memories
  LIMIT 1;

  IF dims IS NOT NULL AND dims <> 3072 THEN
    RAISE NOTICE 'Clearing semantic_memories embeddings (dimension % -> 3072)', dims;
    DELETE FROM semantic_memories;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_semantic_embedding;
ALTER TABLE IF EXISTS semantic_memories
  ALTER COLUMN embedding TYPE vector(3072);
CREATE INDEX IF NOT EXISTS idx_semantic_embedding ON semantic_memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 200);

-- ---------------------------------------------------------------------------
-- Tool registry embeddings (ensure 3072)
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_tool_registry_embedding;
ALTER TABLE IF EXISTS tool_registry
  ALTER COLUMN embedding TYPE vector(3072);
CREATE INDEX IF NOT EXISTS idx_tool_registry_embedding ON tool_registry
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
