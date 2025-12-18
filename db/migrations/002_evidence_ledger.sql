-- =============================================================================
-- MindOS 10/10 SOTA Architecture - Evidence Ledger
-- Migration: 002_evidence_ledger.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Evidence Ledger: Immutable provenance tracking with cryptographic hashing
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evidence_ledger (
  evidence_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Evidence classification
  kind TEXT NOT NULL CHECK (kind IN (
    'tool_call',
    'model_output',
    'external_doc',
    'human_input',
    'grounding_check',
    'swarm_consensus'
  )),

  -- Reference (tool_call:<id>, model:<provider>:<model>, doc:<url>, etc.)
  ref TEXT NOT NULL,

  -- Cryptographic hash of canonical JSON payload
  hash TEXT NOT NULL,

  -- Full payload (for replay/audit)
  payload JSONB NOT NULL,

  -- Additional metadata
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Merkle tree support for chain verification
  parent_hash TEXT,
  merkle_root TEXT,

  -- Verification status
  verified_at TIMESTAMPTZ,
  verification_source TEXT
);

CREATE UNIQUE INDEX uq_evidence_hash ON evidence_ledger(identity_id, kind, ref);
CREATE INDEX idx_evidence_identity ON evidence_ledger(identity_id, created_at DESC);
CREATE INDEX idx_evidence_kind ON evidence_ledger(kind);
CREATE INDEX idx_evidence_parent ON evidence_ledger(parent_hash) WHERE parent_hash IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Task Step Evidence: Many-to-many linking between steps and evidence
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task_step_evidence (
  step_id UUID NOT NULL REFERENCES task_steps(step_id) ON DELETE CASCADE,
  evidence_id UUID NOT NULL REFERENCES evidence_ledger(evidence_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'supporting', 'contradicting')),

  PRIMARY KEY (step_id, evidence_id)
);

CREATE INDEX idx_step_evidence_step ON task_step_evidence(step_id);
CREATE INDEX idx_step_evidence_evidence ON task_step_evidence(evidence_id);

-- -----------------------------------------------------------------------------
-- Evidence Chain: For cryptographic verification
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evidence_chains (
  chain_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  identity_id UUID NOT NULL REFERENCES identities(identity_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ,

  -- Chain metadata
  name TEXT NOT NULL,
  description TEXT,

  -- Merkle root of all evidence in this chain
  merkle_root TEXT,

  -- Chain status
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finalized', 'verified', 'disputed'))
);

CREATE INDEX idx_evidence_chains_identity ON evidence_chains(identity_id);

CREATE TABLE IF NOT EXISTS evidence_chain_members (
  chain_id UUID NOT NULL REFERENCES evidence_chains(chain_id) ON DELETE CASCADE,
  evidence_id UUID NOT NULL REFERENCES evidence_ledger(evidence_id) ON DELETE CASCADE,
  sequence_num INT NOT NULL,

  PRIMARY KEY (chain_id, evidence_id)
);

CREATE UNIQUE INDEX uq_chain_sequence ON evidence_chain_members(chain_id, sequence_num);

-- -----------------------------------------------------------------------------
-- Grounding Verifications: External fact-checking records
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS grounding_verifications (
  verification_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  evidence_id UUID NOT NULL REFERENCES evidence_ledger(evidence_id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Verification source
  source TEXT NOT NULL,  -- wikipedia, authoritative_corpus, cross_tool, human
  source_url TEXT,

  -- Verification result
  status TEXT NOT NULL CHECK (status IN ('verified', 'contradicted', 'uncertain', 'unverifiable')),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  -- Details
  supporting_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  contradicting_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT
);

CREATE INDEX idx_grounding_evidence ON grounding_verifications(evidence_id);
CREATE INDEX idx_grounding_status ON grounding_verifications(status);

-- -----------------------------------------------------------------------------
-- Functions: Canonical JSON hashing
-- -----------------------------------------------------------------------------

-- Helper function to create stable JSON representation
CREATE OR REPLACE FUNCTION canonical_json(data JSONB)
RETURNS TEXT AS $$
  SELECT jsonb_strip_nulls(data)::text;
$$ LANGUAGE sql IMMUTABLE;

-- Function to compute evidence hash
CREATE OR REPLACE FUNCTION compute_evidence_hash(payload JSONB)
RETURNS TEXT AS $$
  SELECT encode(sha256(canonical_json(payload)::bytea), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- Trigger to auto-compute hash on insert
CREATE OR REPLACE FUNCTION set_evidence_hash()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.hash IS NULL OR NEW.hash = '' THEN
    NEW.hash = compute_evidence_hash(NEW.payload);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_hash_trigger
  BEFORE INSERT ON evidence_ledger
  FOR EACH ROW EXECUTE FUNCTION set_evidence_hash();
