// =============================================================================
// Canonical Hashing for Evidence
// =============================================================================

import { createHash } from "node:crypto"

// -----------------------------------------------------------------------------
// Canonical Content Generation
// -----------------------------------------------------------------------------

/**
 * Creates a canonical string representation of any value for hashing.
 * Ensures deterministic ordering of object keys and consistent formatting.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"

  if (typeof value === "boolean") return value.toString()
  if (typeof value === "number") return value.toString()
  if (typeof value === "string") return JSON.stringify(value)

  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalize(v))
    return `[${items.join(",")}]`
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    const pairs = keys.map((key) => {
      const v = (value as Record<string, unknown>)[key]
      return `${JSON.stringify(key)}:${canonicalize(v)}`
    })
    return `{${pairs.join(",")}}`
  }

  return String(value)
}

// -----------------------------------------------------------------------------
// SHA-256 Hashing
// -----------------------------------------------------------------------------

/**
 * Computes SHA-256 hash of the input string.
 */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

/**
 * Computes canonical hash of any value.
 * First canonicalizes the value, then computes SHA-256.
 */
export function computeCanonicalHash(value: unknown): string {
  const canonical = canonicalize(value)
  return sha256(canonical)
}

// -----------------------------------------------------------------------------
// Evidence Hashing
// -----------------------------------------------------------------------------

export interface EvidenceHashInput {
  source_type: string
  source_id: string
  content: unknown
  timestamp: string
  parent_hashes: string[]
}

/**
 * Computes the canonical hash for an evidence record.
 * Includes all relevant fields in deterministic order.
 */
export function computeEvidenceHash(input: EvidenceHashInput): string {
  const canonical = canonicalize({
    content: input.content,
    parent_hashes: input.parent_hashes.slice().sort(),
    source_id: input.source_id,
    source_type: input.source_type,
    timestamp: input.timestamp,
  })

  return sha256(canonical)
}

/**
 * Computes hash of multiple evidence hashes combined.
 * Used for creating chain hashes and Merkle nodes.
 */
export function combineHashes(hashes: string[]): string {
  const sorted = hashes.slice().sort()
  const combined = sorted.join("")
  return sha256(combined)
}

// -----------------------------------------------------------------------------
// Content Fingerprinting
// -----------------------------------------------------------------------------

/**
 * Creates a short fingerprint of content for quick comparison.
 * Uses first 16 characters of the full hash.
 */
export function fingerprint(value: unknown): string {
  return computeCanonicalHash(value).substring(0, 16)
}

/**
 * Checks if two values have the same canonical hash.
 */
export function hashEquals(a: unknown, b: unknown): boolean {
  return computeCanonicalHash(a) === computeCanonicalHash(b)
}
