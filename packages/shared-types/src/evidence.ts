// =============================================================================
// MindOS - Evidence Types
// =============================================================================

import { z } from "zod"
import { UUIDSchema, TimestampSchema, JSONSchema } from "./schemas.js"

// -----------------------------------------------------------------------------
// Evidence Kind
// -----------------------------------------------------------------------------

export const EvidenceKindSchema = z.enum([
  "tool_call",
  "model_output",
  "external_doc",
  "human_input",
  "grounding_check",
  "swarm_consensus",
])
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>

// -----------------------------------------------------------------------------
// Evidence Record
// -----------------------------------------------------------------------------

export const EvidenceRecordSchema = z.object({
  evidence_id: UUIDSchema,
  identity_id: UUIDSchema,
  kind: EvidenceKindSchema,
  ref: z.string(), // tool_call:<id>, model:<provider>:<model>, etc.
  hash: z.string(), // SHA256 of canonical JSON
  payload: JSONSchema,
  meta: JSONSchema.optional(),
  parent_hash: z.string().nullable().optional(),
  merkle_root: z.string().nullable().optional(),
  verified_at: TimestampSchema.nullable().optional(),
  verification_source: z.string().nullable().optional(),
  created_at: TimestampSchema,
})
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>

// -----------------------------------------------------------------------------
// Evidence Request
// -----------------------------------------------------------------------------

export const CreateEvidenceRequestSchema = z.object({
  identity_id: UUIDSchema,
  kind: EvidenceKindSchema,
  ref: z.string(),
  payload: JSONSchema,
  meta: JSONSchema.optional(),
  parent_hash: z.string().optional(),
})
export type CreateEvidenceRequest = z.infer<typeof CreateEvidenceRequestSchema>

// -----------------------------------------------------------------------------
// Evidence Chain
// -----------------------------------------------------------------------------

export const EvidenceChainSchema = z.object({
  chain_id: UUIDSchema,
  identity_id: UUIDSchema,
  name: z.string(),
  description: z.string().nullable().optional(),
  merkle_root: z.string().nullable().optional(),
  status: z.enum(["open", "finalized", "verified", "disputed"]),
  created_at: TimestampSchema,
  finalized_at: TimestampSchema.nullable().optional(),
})
export type EvidenceChain = z.infer<typeof EvidenceChainSchema>

// -----------------------------------------------------------------------------
// Grounding Verification
// -----------------------------------------------------------------------------

export const GroundingStatusSchema = z.enum([
  "verified",
  "contradicted",
  "uncertain",
  "unverifiable",
])
export type GroundingStatus = z.infer<typeof GroundingStatusSchema>

export const GroundingVerificationSchema = z.object({
  verification_id: UUIDSchema,
  evidence_id: UUIDSchema,
  source: z.string(), // wikipedia, authoritative_corpus, cross_tool, human
  source_url: z.string().nullable().optional(),
  status: GroundingStatusSchema,
  confidence: z.number().min(0).max(1),
  supporting_evidence: z.array(JSONSchema),
  contradicting_evidence: z.array(JSONSchema),
  notes: z.string().nullable().optional(),
  created_at: TimestampSchema,
})
export type GroundingVerification = z.infer<typeof GroundingVerificationSchema>

export const GroundingRequestSchema = z.object({
  evidence_id: UUIDSchema,
  claim: z.string(),
  context: z.string().optional(),
  sources_to_check: z.array(z.string()).optional(),
  min_confidence: z.number().min(0).max(1).optional(),
})
export type GroundingRequest = z.infer<typeof GroundingRequestSchema>

// -----------------------------------------------------------------------------
// Merkle Proof
// -----------------------------------------------------------------------------

export const MerkleProofSchema = z.object({
  leaf_hash: z.string(),
  proof: z.array(z.object({
    hash: z.string(),
    position: z.enum(["left", "right"]),
  })),
  root: z.string(),
})
export type MerkleProof = z.infer<typeof MerkleProofSchema>

export const VerifyProofResultSchema = z.object({
  valid: z.boolean(),
  leaf_hash: z.string(),
  computed_root: z.string(),
  expected_root: z.string(),
})
export type VerifyProofResult = z.infer<typeof VerifyProofResultSchema>
