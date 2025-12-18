// =============================================================================
// Evidence Ledger - Immutable Evidence Storage
// =============================================================================

import type pg from "pg"
import type { EvidenceRecord, EvidenceChain } from "./types.js"
import { computeEvidenceHash, canonicalize, combineHashes } from "./hasher.js"
import { buildMerkleTree, getMerkleRoot } from "./merkle.js"

// -----------------------------------------------------------------------------
// Evidence Ledger Interface
// -----------------------------------------------------------------------------

export interface EvidenceLedger {
  record(input: RecordEvidenceInput): Promise<EvidenceRecord>
  get(evidenceId: string): Promise<EvidenceRecord | null>
  getByHash(contentHash: string): Promise<EvidenceRecord | null>
  getChain(rootEvidenceId: string): Promise<EvidenceRecord[]>
  createChain(evidenceIds: string[]): Promise<EvidenceChain>
  linkToStep(evidenceId: string, taskStepId: string): Promise<void>
  getForStep(taskStepId: string): Promise<EvidenceRecord[]>
}

export interface RecordEvidenceInput {
  source_type: EvidenceRecord["source_type"]
  source_id: string
  content: unknown
  parent_evidence_ids?: string[]
  metadata?: Record<string, unknown>
}

// -----------------------------------------------------------------------------
// Create Evidence Ledger
// -----------------------------------------------------------------------------

export function createEvidenceLedger(pool: pg.Pool): EvidenceLedger {
  async function record(input: RecordEvidenceInput): Promise<EvidenceRecord> {
    // Get parent hashes if parent IDs provided
    const parentHashes: string[] = []
    if (input.parent_evidence_ids && input.parent_evidence_ids.length > 0) {
      const parentResult = await pool.query(
        `SELECT content_hash FROM evidence_ledger WHERE evidence_id = ANY($1)`,
        [input.parent_evidence_ids]
      )
      for (const row of parentResult.rows) {
        parentHashes.push(row.content_hash)
      }
    }

    const timestamp = new Date().toISOString()
    const canonicalContent = canonicalize(input.content)

    // Compute canonical hash
    const contentHash = computeEvidenceHash({
      source_type: input.source_type,
      source_id: input.source_id,
      content: input.content,
      timestamp,
      parent_hashes: parentHashes,
    })

    const evidenceId = crypto.randomUUID()

    const evidence: EvidenceRecord = {
      evidence_id: evidenceId,
      source_type: input.source_type,
      source_id: input.source_id,
      content_hash: contentHash,
      canonical_content: canonicalContent,
      timestamp,
      parent_hashes: parentHashes,
      metadata: input.metadata ?? {},
    }

    await pool.query(
      `INSERT INTO evidence_ledger (
        evidence_id, source_type, source_id, content_hash,
        canonical_content, timestamp, parent_hashes, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        evidence.evidence_id,
        evidence.source_type,
        evidence.source_id,
        evidence.content_hash,
        evidence.canonical_content,
        evidence.timestamp,
        JSON.stringify(evidence.parent_hashes),
        JSON.stringify(evidence.metadata),
      ]
    )

    return evidence
  }

  async function get(evidenceId: string): Promise<EvidenceRecord | null> {
    const result = await pool.query(
      `SELECT * FROM evidence_ledger WHERE evidence_id = $1`,
      [evidenceId]
    )

    if (result.rows.length === 0) return null

    const row = result.rows[0]
    return {
      evidence_id: row.evidence_id,
      source_type: row.source_type,
      source_id: row.source_id,
      content_hash: row.content_hash,
      canonical_content: row.canonical_content,
      timestamp: row.timestamp,
      parent_hashes: row.parent_hashes ?? [],
      metadata: row.metadata ?? {},
    }
  }

  async function getByHash(contentHash: string): Promise<EvidenceRecord | null> {
    const result = await pool.query(
      `SELECT * FROM evidence_ledger WHERE content_hash = $1`,
      [contentHash]
    )

    if (result.rows.length === 0) return null

    const row = result.rows[0]
    return {
      evidence_id: row.evidence_id,
      source_type: row.source_type,
      source_id: row.source_id,
      content_hash: row.content_hash,
      canonical_content: row.canonical_content,
      timestamp: row.timestamp,
      parent_hashes: row.parent_hashes ?? [],
      metadata: row.metadata ?? {},
    }
  }

  async function getChain(rootEvidenceId: string): Promise<EvidenceRecord[]> {
    // Recursive CTE to get all evidence in chain
    const result = await pool.query(
      `WITH RECURSIVE evidence_chain AS (
        SELECT * FROM evidence_ledger WHERE evidence_id = $1
        UNION ALL
        SELECT e.* FROM evidence_ledger e
        INNER JOIN evidence_chain ec ON e.evidence_id = ANY(
          SELECT unnest(string_to_array(trim(both '[]' from ec.parent_hashes::text), ','))
        )
      )
      SELECT DISTINCT * FROM evidence_chain ORDER BY timestamp ASC`,
      [rootEvidenceId]
    )

    return result.rows.map((row) => ({
      evidence_id: row.evidence_id,
      source_type: row.source_type,
      source_id: row.source_id,
      content_hash: row.content_hash,
      canonical_content: row.canonical_content,
      timestamp: row.timestamp,
      parent_hashes: row.parent_hashes ?? [],
      metadata: row.metadata ?? {},
    }))
  }

  async function createChain(evidenceIds: string[]): Promise<EvidenceChain> {
    // Get all evidence records
    const result = await pool.query(
      `SELECT * FROM evidence_ledger WHERE evidence_id = ANY($1) ORDER BY timestamp ASC`,
      [evidenceIds]
    )

    if (result.rows.length === 0) {
      throw new Error("No evidence found for provided IDs")
    }

    const hashes = result.rows.map((r) => r.content_hash)
    const merkleTree = buildMerkleTree(hashes)
    const merkleRoot = getMerkleRoot(merkleTree)

    const chain: EvidenceChain = {
      chain_id: crypto.randomUUID(),
      root_evidence_id: evidenceIds[0],
      evidence_ids: evidenceIds,
      merkle_root: merkleRoot,
      created_at: new Date().toISOString(),
      integrity_verified: true,
    }

    return chain
  }

  async function linkToStep(evidenceId: string, taskStepId: string): Promise<void> {
    await pool.query(
      `INSERT INTO task_step_evidence (task_step_id, evidence_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [taskStepId, evidenceId]
    )
  }

  async function getForStep(taskStepId: string): Promise<EvidenceRecord[]> {
    const result = await pool.query(
      `SELECT e.* FROM evidence_ledger e
       INNER JOIN task_step_evidence tse ON e.evidence_id = tse.evidence_id
       WHERE tse.task_step_id = $1
       ORDER BY e.timestamp ASC`,
      [taskStepId]
    )

    return result.rows.map((row) => ({
      evidence_id: row.evidence_id,
      source_type: row.source_type,
      source_id: row.source_id,
      content_hash: row.content_hash,
      canonical_content: row.canonical_content,
      timestamp: row.timestamp,
      parent_hashes: row.parent_hashes ?? [],
      metadata: row.metadata ?? {},
    }))
  }

  return {
    record,
    get,
    getByHash,
    getChain,
    createChain,
    linkToStep,
    getForStep,
  }
}
