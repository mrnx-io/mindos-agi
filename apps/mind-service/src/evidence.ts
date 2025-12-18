// =============================================================================
// MindOS - Evidence Hashing & Provenance
// =============================================================================

import { createHash } from "node:crypto"
import { query, queryOne, withTransaction, type TransactionClient } from "./db.js"
import { createLogger } from "./logger.js"
import type { EvidenceKind, EvidenceRecord, CreateEvidenceRequest } from "./types.js"

const log = createLogger("evidence")

// -----------------------------------------------------------------------------
// Canonical JSON
// -----------------------------------------------------------------------------

/**
 * Produces deterministic JSON for hashing.
 * Keys are sorted alphabetically, no whitespace.
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return "null"
  }

  if (typeof obj === "boolean" || typeof obj === "number") {
    return JSON.stringify(obj)
  }

  if (typeof obj === "string") {
    return JSON.stringify(obj)
  }

  if (Array.isArray(obj)) {
    const items = obj.map((item) => canonicalJson(item))
    return `[${items.join(",")}]`
  }

  if (typeof obj === "object") {
    const keys = Object.keys(obj).sort()
    const pairs = keys.map((key) => {
      const value = (obj as Record<string, unknown>)[key]
      return `${JSON.stringify(key)}:${canonicalJson(value)}`
    })
    return `{${pairs.join(",")}}`
  }

  throw new Error(`Cannot canonicalize type: ${typeof obj}`)
}

// -----------------------------------------------------------------------------
// SHA256 Hashing
// -----------------------------------------------------------------------------

export function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex")
}

export function hashEvidence(payload: unknown, parentHash?: string): string {
  const canonical = canonicalJson(payload)
  const input = parentHash ? `${parentHash}:${canonical}` : canonical
  return sha256(input)
}

// -----------------------------------------------------------------------------
// Evidence Storage
// -----------------------------------------------------------------------------

interface EvidenceRow {
  evidence_id: string
  identity_id: string
  kind: EvidenceKind
  ref: string
  hash: string
  payload: unknown
  meta: unknown
  parent_hash: string | null
  merkle_root: string | null
  verified_at: Date | null
  verification_source: string | null
  created_at: Date
}

export async function createEvidence(
  request: CreateEvidenceRequest,
  client?: TransactionClient
): Promise<EvidenceRecord> {
  const hash = hashEvidence(request.payload, request.parent_hash)

  const sql = `
    INSERT INTO evidence_ledger (
      identity_id, kind, ref, hash, payload, meta, parent_hash
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `

  const params = [
    request.identity_id,
    request.kind,
    request.ref,
    hash,
    JSON.stringify(request.payload),
    request.meta ? JSON.stringify(request.meta) : null,
    request.parent_hash ?? null,
  ]

  const result = client
    ? await client.query<EvidenceRow>(sql, params)
    : await query<EvidenceRow>(sql, params)

  const row = result.rows[0]
  log.info({ evidenceId: row.evidence_id, kind: row.kind, hash: row.hash }, "Evidence created")

  return rowToEvidence(row)
}

export async function getEvidence(evidenceId: string): Promise<EvidenceRecord | null> {
  const row = await queryOne<EvidenceRow>(
    "SELECT * FROM evidence_ledger WHERE evidence_id = $1",
    [evidenceId]
  )
  return row ? rowToEvidence(row) : null
}

export async function getEvidenceByHash(hash: string): Promise<EvidenceRecord | null> {
  const row = await queryOne<EvidenceRow>(
    "SELECT * FROM evidence_ledger WHERE hash = $1",
    [hash]
  )
  return row ? rowToEvidence(row) : null
}

export async function getEvidenceChain(evidenceId: string): Promise<EvidenceRecord[]> {
  // Walk up the parent chain
  const chain: EvidenceRecord[] = []
  let currentId: string | null = evidenceId

  while (currentId) {
    const evidence = await getEvidence(currentId)
    if (!evidence) break

    chain.unshift(evidence) // Add to beginning

    // Find parent by hash
    if (evidence.parent_hash) {
      const parent = await getEvidenceByHash(evidence.parent_hash)
      currentId = parent?.evidence_id ?? null
    } else {
      currentId = null
    }
  }

  return chain
}

export async function verifyEvidence(
  evidenceId: string,
  source: string
): Promise<{ valid: boolean; expectedHash: string; actualHash: string }> {
  const evidence = await getEvidence(evidenceId)
  if (!evidence) {
    throw new Error(`Evidence not found: ${evidenceId}`)
  }

  const actualHash = hashEvidence(evidence.payload, evidence.parent_hash ?? undefined)
  const valid = actualHash === evidence.hash

  if (valid) {
    await query(
      `UPDATE evidence_ledger
       SET verified_at = NOW(), verification_source = $2
       WHERE evidence_id = $1`,
      [evidenceId, source]
    )
    log.info({ evidenceId, source }, "Evidence verified")
  } else {
    log.warn({ evidenceId, expectedHash: evidence.hash, actualHash }, "Evidence verification failed")
  }

  return {
    valid,
    expectedHash: evidence.hash,
    actualHash,
  }
}

// -----------------------------------------------------------------------------
// Link Evidence to Task Steps
// -----------------------------------------------------------------------------

export async function linkEvidenceToStep(
  stepId: string,
  evidenceId: string,
  client?: TransactionClient
): Promise<void> {
  const sql = `
    INSERT INTO task_step_evidence (step_id, evidence_id)
    VALUES ($1, $2)
    ON CONFLICT DO NOTHING
  `
  if (client) {
    await client.query(sql, [stepId, evidenceId])
  } else {
    await query(sql, [stepId, evidenceId])
  }
}

export async function getStepEvidence(stepId: string): Promise<EvidenceRecord[]> {
  const rows = await query<EvidenceRow>(
    `SELECT el.* FROM evidence_ledger el
     JOIN task_step_evidence tse ON el.evidence_id = tse.evidence_id
     WHERE tse.step_id = $1
     ORDER BY el.created_at ASC`,
    [stepId]
  )
  return rows.rows.map(rowToEvidence)
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function rowToEvidence(row: EvidenceRow): EvidenceRecord {
  return {
    evidence_id: row.evidence_id,
    identity_id: row.identity_id,
    kind: row.kind,
    ref: row.ref,
    hash: row.hash,
    payload: row.payload,
    meta: row.meta,
    parent_hash: row.parent_hash,
    merkle_root: row.merkle_root,
    verified_at: row.verified_at?.toISOString() ?? null,
    verification_source: row.verification_source,
    created_at: row.created_at.toISOString(),
  }
}
