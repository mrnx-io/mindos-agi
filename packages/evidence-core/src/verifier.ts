// =============================================================================
// Evidence Verification System
// =============================================================================

import type pg from "pg"
import type { EvidenceRecord, VerificationResult, MerkleProof } from "./types.js"
import { computeEvidenceHash, canonicalize } from "./hasher.js"
import { buildMerkleTree, generateMerkleProof, verifyMerkleProof } from "./merkle.js"

// -----------------------------------------------------------------------------
// Evidence Verifier Interface
// -----------------------------------------------------------------------------

export interface EvidenceVerifier {
  verify(evidenceId: string): Promise<VerificationResult>
  verifyChain(evidenceIds: string[]): Promise<ChainVerificationResult>
  verifyWithMerkleProof(evidenceId: string, proof: MerkleProof): Promise<boolean>
  detectTampering(evidenceId: string): Promise<TamperingReport>
}

export interface ChainVerificationResult {
  chain_verified: boolean
  evidence_count: number
  verified_count: number
  failed_verifications: string[]
  merkle_root: string
  timestamp: string
}

export interface TamperingReport {
  evidence_id: string
  tampered: boolean
  issues: TamperingIssue[]
  checked_at: string
}

export interface TamperingIssue {
  issue_type: "hash_mismatch" | "parent_missing" | "timestamp_anomaly" | "content_modified"
  description: string
  severity: "critical" | "warning" | "info"
}

// -----------------------------------------------------------------------------
// Create Evidence Verifier
// -----------------------------------------------------------------------------

export function createEvidenceVerifier(pool: pg.Pool): EvidenceVerifier {
  async function verify(evidenceId: string): Promise<VerificationResult> {
    const result = await pool.query(
      `SELECT * FROM evidence_ledger WHERE evidence_id = $1`,
      [evidenceId]
    )

    if (result.rows.length === 0) {
      throw new Error(`Evidence ${evidenceId} not found`)
    }

    const evidence = result.rows[0] as EvidenceRecord

    // Recompute hash from stored canonical content
    const content = JSON.parse(evidence.canonical_content)
    const computedHash = computeEvidenceHash({
      source_type: evidence.source_type,
      source_id: evidence.source_id,
      content,
      timestamp: evidence.timestamp,
      parent_hashes: evidence.parent_hashes ?? [],
    })

    // Verify parent hashes exist
    const parentVerification: VerificationResult["parent_verification"] = []

    for (const parentHash of evidence.parent_hashes ?? []) {
      const parentResult = await pool.query(
        `SELECT evidence_id FROM evidence_ledger WHERE content_hash = $1`,
        [parentHash]
      )

      parentVerification.push({
        parent_hash: parentHash,
        verified: parentResult.rows.length > 0,
      })
    }

    return {
      verified: computedHash === evidence.content_hash,
      evidence_id: evidenceId,
      computed_hash: computedHash,
      stored_hash: evidence.content_hash,
      parent_verification: parentVerification,
      timestamp: new Date().toISOString(),
    }
  }

  async function verifyChain(evidenceIds: string[]): Promise<ChainVerificationResult> {
    const failedVerifications: string[] = []
    let verifiedCount = 0

    for (const evidenceId of evidenceIds) {
      try {
        const result = await verify(evidenceId)
        if (result.verified) {
          verifiedCount++
        } else {
          failedVerifications.push(evidenceId)
        }
      } catch {
        failedVerifications.push(evidenceId)
      }
    }

    // Get all hashes for Merkle tree
    const hashResult = await pool.query(
      `SELECT content_hash FROM evidence_ledger WHERE evidence_id = ANY($1) ORDER BY timestamp ASC`,
      [evidenceIds]
    )

    const hashes = hashResult.rows.map((r) => r.content_hash)
    let merkleRoot = ""

    if (hashes.length > 0) {
      const tree = buildMerkleTree(hashes)
      merkleRoot = tree[tree.length - 1][0].hash
    }

    return {
      chain_verified: failedVerifications.length === 0,
      evidence_count: evidenceIds.length,
      verified_count: verifiedCount,
      failed_verifications: failedVerifications,
      merkle_root: merkleRoot,
      timestamp: new Date().toISOString(),
    }
  }

  async function verifyWithMerkleProof(evidenceId: string, proof: MerkleProof): Promise<boolean> {
    const result = await pool.query(
      `SELECT content_hash FROM evidence_ledger WHERE evidence_id = $1`,
      [evidenceId]
    )

    if (result.rows.length === 0) return false

    const contentHash = result.rows[0].content_hash

    // Verify the evidence hash matches the proof leaf
    if (contentHash !== proof.leaf) return false

    // Verify the Merkle proof
    return verifyMerkleProof(proof)
  }

  async function detectTampering(evidenceId: string): Promise<TamperingReport> {
    const issues: TamperingIssue[] = []

    const result = await pool.query(
      `SELECT * FROM evidence_ledger WHERE evidence_id = $1`,
      [evidenceId]
    )

    if (result.rows.length === 0) {
      return {
        evidence_id: evidenceId,
        tampered: true,
        issues: [{
          issue_type: "content_modified",
          description: "Evidence record not found",
          severity: "critical",
        }],
        checked_at: new Date().toISOString(),
      }
    }

    const evidence = result.rows[0]

    // Check 1: Hash integrity
    try {
      const content = JSON.parse(evidence.canonical_content)
      const computedHash = computeEvidenceHash({
        source_type: evidence.source_type,
        source_id: evidence.source_id,
        content,
        timestamp: evidence.timestamp,
        parent_hashes: evidence.parent_hashes ?? [],
      })

      if (computedHash !== evidence.content_hash) {
        issues.push({
          issue_type: "hash_mismatch",
          description: `Computed hash ${computedHash.substring(0, 16)}... does not match stored hash ${evidence.content_hash.substring(0, 16)}...`,
          severity: "critical",
        })
      }
    } catch {
      issues.push({
        issue_type: "content_modified",
        description: "Failed to parse canonical content",
        severity: "critical",
      })
    }

    // Check 2: Parent existence
    for (const parentHash of evidence.parent_hashes ?? []) {
      const parentResult = await pool.query(
        `SELECT evidence_id FROM evidence_ledger WHERE content_hash = $1`,
        [parentHash]
      )

      if (parentResult.rows.length === 0) {
        issues.push({
          issue_type: "parent_missing",
          description: `Parent evidence with hash ${parentHash.substring(0, 16)}... not found`,
          severity: "warning",
        })
      }
    }

    // Check 3: Timestamp ordering (parents should be before children)
    for (const parentHash of evidence.parent_hashes ?? []) {
      const parentResult = await pool.query(
        `SELECT timestamp FROM evidence_ledger WHERE content_hash = $1`,
        [parentHash]
      )

      if (parentResult.rows.length > 0) {
        const parentTimestamp = new Date(parentResult.rows[0].timestamp)
        const childTimestamp = new Date(evidence.timestamp)

        if (parentTimestamp >= childTimestamp) {
          issues.push({
            issue_type: "timestamp_anomaly",
            description: `Parent timestamp ${parentTimestamp.toISOString()} is not before child timestamp ${childTimestamp.toISOString()}`,
            severity: "warning",
          })
        }
      }
    }

    return {
      evidence_id: evidenceId,
      tampered: issues.some((i) => i.severity === "critical"),
      issues,
      checked_at: new Date().toISOString(),
    }
  }

  return {
    verify,
    verifyChain,
    verifyWithMerkleProof,
    detectTampering,
  }
}

// -----------------------------------------------------------------------------
// Batch Verification
// -----------------------------------------------------------------------------

export interface BatchVerificationOptions {
  parallel?: boolean
  maxConcurrency?: number
  stopOnFirstFailure?: boolean
}

export async function batchVerify(
  verifier: EvidenceVerifier,
  evidenceIds: string[],
  options: BatchVerificationOptions = {}
): Promise<Map<string, VerificationResult>> {
  const results = new Map<string, VerificationResult>()
  const { parallel = true, maxConcurrency = 10, stopOnFirstFailure = false } = options

  if (parallel) {
    // Process in batches
    for (let i = 0; i < evidenceIds.length; i += maxConcurrency) {
      const batch = evidenceIds.slice(i, i + maxConcurrency)
      const batchResults = await Promise.all(
        batch.map(async (id) => {
          try {
            return { id, result: await verifier.verify(id) }
          } catch (error) {
            return {
              id,
              result: {
                verified: false,
                evidence_id: id,
                computed_hash: "",
                stored_hash: "",
                parent_verification: [],
                timestamp: new Date().toISOString(),
              } as VerificationResult,
            }
          }
        })
      )

      for (const { id, result } of batchResults) {
        results.set(id, result)

        if (stopOnFirstFailure && !result.verified) {
          return results
        }
      }
    }
  } else {
    // Sequential processing
    for (const id of evidenceIds) {
      try {
        const result = await verifier.verify(id)
        results.set(id, result)

        if (stopOnFirstFailure && !result.verified) {
          return results
        }
      } catch {
        results.set(id, {
          verified: false,
          evidence_id: id,
          computed_hash: "",
          stored_hash: "",
          parent_verification: [],
          timestamp: new Date().toISOString(),
        })

        if (stopOnFirstFailure) {
          return results
        }
      }
    }
  }

  return results
}
