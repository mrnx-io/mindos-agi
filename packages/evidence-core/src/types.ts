// =============================================================================
// Evidence Core Types
// =============================================================================

import { z } from "zod"

// -----------------------------------------------------------------------------
// Evidence Record Schema
// -----------------------------------------------------------------------------

export const EvidenceRecordSchema = z.object({
  evidence_id: z.string().uuid(),
  source_type: z.enum(["observation", "inference", "tool_output", "external", "user_input"]),
  source_id: z.string(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  canonical_content: z.string(),
  timestamp: z.string().datetime(),
  parent_hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).default([]),
  metadata: z.record(z.unknown()).default({}),
})

export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>

// -----------------------------------------------------------------------------
// Merkle Tree Types
// -----------------------------------------------------------------------------

export const MerkleNodeSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  left: z.string().nullable(),
  right: z.string().nullable(),
  data: z.string().nullable(),
  level: z.number().int().nonnegative(),
})

export type MerkleNode = z.infer<typeof MerkleNodeSchema>

export const MerkleProofSchema = z.object({
  root: z.string().regex(/^[a-f0-9]{64}$/),
  leaf: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.array(
    z.object({
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      position: z.enum(["left", "right"]),
    })
  ),
})

export type MerkleProof = z.infer<typeof MerkleProofSchema>

// -----------------------------------------------------------------------------
// Verification Types
// -----------------------------------------------------------------------------

export const VerificationResultSchema = z.object({
  verified: z.boolean(),
  evidence_id: z.string().uuid(),
  computed_hash: z.string().regex(/^[a-f0-9]{64}$/),
  stored_hash: z.string().regex(/^[a-f0-9]{64}$/),
  parent_verification: z.array(
    z.object({
      parent_hash: z.string(),
      verified: z.boolean(),
    })
  ),
  merkle_proof_valid: z.boolean().optional(),
  timestamp: z.string().datetime(),
})

export type VerificationResult = z.infer<typeof VerificationResultSchema>

// -----------------------------------------------------------------------------
// Evidence Chain Types
// -----------------------------------------------------------------------------

export const EvidenceChainSchema = z.object({
  chain_id: z.string().uuid(),
  root_evidence_id: z.string().uuid(),
  evidence_ids: z.array(z.string().uuid()),
  merkle_root: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.string().datetime(),
  integrity_verified: z.boolean(),
})

export type EvidenceChain = z.infer<typeof EvidenceChainSchema>

// -----------------------------------------------------------------------------
// Provenance Types
// -----------------------------------------------------------------------------

export const ProvenanceRecordSchema = z.object({
  provenance_id: z.string().uuid(),
  entity_type: z.string(),
  entity_id: z.string(),
  evidence_chain_id: z.string().uuid(),
  claim: z.string(),
  confidence: z.number().min(0).max(1),
  sources: z.array(z.string()),
  verified_at: z.string().datetime().optional(),
})

export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>
