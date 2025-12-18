// =============================================================================
// MindOS - Grounding Client (Fact Verification)
// =============================================================================

import { request } from "undici"
import { env } from "../config.js"
import { createLogger } from "../logger.js"
import type { RequestContext } from "./toolmeshClient.js"

const log = createLogger("grounding-client")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface VerificationSource {
  name: string
  url?: string
  relevance: number
  supports: boolean
  excerpt: string
}

export interface VerificationResult {
  verification_id: string
  claim: string
  status: "verified" | "contradicted" | "uncertain" | "unverifiable"
  confidence: number
  sources: VerificationSource[]
  analysis: string
  created_at: string
}

export interface CrossVerificationResult {
  consistent: boolean
  discrepancies: string[]
  confidence: number
}

// -----------------------------------------------------------------------------
// HTTP Client
// -----------------------------------------------------------------------------

async function groundingRequest<T>(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
  context?: RequestContext
): Promise<T> {
  const url = `${env.GROUNDING_SERVICE_URL}${path}`

  // Build headers with authentication and context propagation
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  }

  // Add authorization header if token is configured
  if (env.GROUNDING_TOKEN) {
    headers.Authorization = `Bearer ${env.GROUNDING_TOKEN}`
  }

  // Add correlation ID for distributed tracing
  if (context?.correlationId) {
    headers["x-correlation-id"] = context.correlationId
  }

  // Add identity context
  if (context?.identityId) {
    headers["x-identity-id"] = context.identityId
  }

  try {
    // Build request options conditionally to satisfy exactOptionalPropertyTypes
    const requestOptions: Parameters<typeof request>[1] = {
      method,
      headers,
    }
    if (body) {
      requestOptions.body = JSON.stringify(body)
    }

    const response = await request(url, requestOptions)

    const data = (await response.body.json()) as T
    return data
  } catch (err) {
    log.error({ url, error: err }, "Grounding request failed")
    throw err
  }
}

// -----------------------------------------------------------------------------
// Claim Verification
// -----------------------------------------------------------------------------

export async function verifyClaim(
  claim: string,
  options: {
    context?: string
    minConfidence?: number
    sources?: string[]
  } = {},
  requestContext?: RequestContext
): Promise<VerificationResult> {
  // Check if grounding is enabled
  if (!env.ENABLE_GROUNDING) {
    log.debug({ claim: claim.slice(0, 50) }, "Grounding disabled, returning unverifiable")
    return {
      verification_id: crypto.randomUUID(),
      claim,
      status: "unverifiable",
      confidence: 0,
      sources: [],
      analysis: "Grounding is disabled",
      created_at: new Date().toISOString(),
    }
  }

  log.info({ claim: claim.slice(0, 100) }, "Verifying claim")

  const result = await groundingRequest<VerificationResult>(
    "/verify",
    "POST",
    {
      claim,
      context: options.context,
      min_confidence: options.minConfidence ?? 0.7,
      sources: options.sources,
    },
    requestContext
  )

  log.info(
    {
      verificationId: result.verification_id,
      status: result.status,
      confidence: result.confidence,
    },
    "Claim verification completed"
  )

  return result
}

// -----------------------------------------------------------------------------
// Batch Verification
// -----------------------------------------------------------------------------

export async function verifyMultipleClaims(
  claims: string[],
  options: {
    context?: string
    minConfidence?: number
  } = {},
  requestContext?: RequestContext
): Promise<VerificationResult[]> {
  if (!env.ENABLE_GROUNDING || claims.length === 0) {
    return claims.map((claim) => ({
      verification_id: crypto.randomUUID(),
      claim,
      status: "unverifiable" as const,
      confidence: 0,
      sources: [],
      analysis: "Grounding is disabled",
      created_at: new Date().toISOString(),
    }))
  }

  // Process in parallel with concurrency limit
  const results: VerificationResult[] = []
  const concurrency = 3

  for (let i = 0; i < claims.length; i += concurrency) {
    const batch = claims.slice(i, i + concurrency)
    const batchResults = await Promise.all(
      batch.map((claim) => verifyClaim(claim, options, requestContext))
    )
    results.push(...batchResults)
  }

  return results
}

// -----------------------------------------------------------------------------
// Cross-Tool Verification
// -----------------------------------------------------------------------------

export async function crossVerifyToolOutput(
  toolName: string,
  output: unknown,
  expectedBehavior: string,
  requestContext?: RequestContext
): Promise<CrossVerificationResult> {
  if (!env.ENABLE_GROUNDING) {
    return {
      consistent: true,
      discrepancies: [],
      confidence: 0,
    }
  }

  return groundingRequest<CrossVerificationResult>(
    "/cross-verify",
    "POST",
    {
      tool_name: toolName,
      output,
      expected_behavior: expectedBehavior,
    },
    requestContext
  )
}

// -----------------------------------------------------------------------------
// Get Verification Result
// -----------------------------------------------------------------------------

export async function getVerification(
  verificationId: string,
  requestContext?: RequestContext
): Promise<VerificationResult | null> {
  try {
    return await groundingRequest<VerificationResult>(
      `/verifications/${encodeURIComponent(verificationId)}`,
      "GET",
      undefined,
      requestContext
    )
  } catch {
    return null
  }
}

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------

export async function checkGroundingHealth(): Promise<boolean> {
  try {
    const result = await groundingRequest<{ status: string }>("/health")
    return result.status === "healthy"
  } catch {
    return false
  }
}

// -----------------------------------------------------------------------------
// Claim Extraction Helper
// -----------------------------------------------------------------------------

export function extractFactualClaims(text: string): string[] {
  // Simple heuristic extraction - in production would use NLP
  // Look for statements that could be verified
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 20)

  // Filter to likely factual claims (exclude questions, commands, opinions)
  return sentences
    .filter((s) => {
      const lower = s.toLowerCase().trim()
      // Exclude questions
      if (lower.includes("?") || lower.startsWith("what") || lower.startsWith("how")) {
        return false
      }
      // Exclude commands/instructions
      if (lower.startsWith("please") || lower.startsWith("try") || lower.startsWith("let")) {
        return false
      }
      // Exclude obvious opinions
      if (lower.includes("i think") || lower.includes("i believe") || lower.includes("might")) {
        return false
      }
      return true
    })
    .map((s) => s.trim())
    .slice(0, 10) // Limit to 10 claims max
}

// -----------------------------------------------------------------------------
// Cross-Provider Verification Pipeline
// -----------------------------------------------------------------------------

export interface ProviderResult {
  provider: "openai" | "anthropic" | "google" | "xai" | "toolmesh"
  output: unknown
  claims: string[]
  timestamp: string
}

export interface CrossProviderVerificationResult {
  verification_id: string
  provider_results: ProviderResult[]
  overlapping_claims: Array<{
    claim: string
    providers_supporting: string[]
    verification: VerificationResult | null
  }>
  discrepancies: Array<{
    claim: string
    provider_a: string
    provider_b: string
    severity: "minor" | "major" | "critical"
    description: string
  }>
  preferred_provider: string
  preference_reason: string
  aggregate_confidence: number
  created_at: string
}

// -----------------------------------------------------------------------------
// Cross-Verification Helper Functions
// -----------------------------------------------------------------------------

/**
 * Extract claims from all provider results
 */
function extractAndNormalizeClaims(providerResults: ProviderResult[]): void {
  for (const result of providerResults) {
    if (result.claims.length === 0 && typeof result.output === "string") {
      result.claims = extractFactualClaims(result.output)
    }
  }
}

/**
 * Find overlapping claims across providers and verify them
 */
async function findOverlappingClaims(
  providerResults: ProviderResult[],
  verifyAllClaims: boolean,
  requestContext?: RequestContext
): Promise<CrossProviderVerificationResult["overlapping_claims"]> {
  const claimOccurrences = new Map<string, Set<string>>()

  // Build claim occurrence map
  for (const result of providerResults) {
    for (const claim of result.claims) {
      const normalizedClaim = normalizeClaim(claim)
      if (!claimOccurrences.has(normalizedClaim)) {
        claimOccurrences.set(normalizedClaim, new Set())
      }
      claimOccurrences.get(normalizedClaim)?.add(result.provider)
    }
  }

  // Identify overlapping claims (appear in 2+ providers)
  const overlappingClaims: CrossProviderVerificationResult["overlapping_claims"] = []

  for (const [claim, providers] of claimOccurrences) {
    if (providers.size >= 2) {
      let verification: VerificationResult | null = null

      // Verify via grounding service if enabled
      if (verifyAllClaims && env.ENABLE_GROUNDING) {
        verification = await verifyClaim(claim, {}, requestContext)
      }

      overlappingClaims.push({
        claim,
        providers_supporting: Array.from(providers),
        verification,
      })
    }
  }

  return overlappingClaims
}

/**
 * Find contradictions between two provider claim sets
 */
function findContradictionsInPair(
  providerA: ProviderResult,
  providerB: ProviderResult
): CrossProviderVerificationResult["discrepancies"] {
  const contradictions: CrossProviderVerificationResult["discrepancies"] = []
  const claimsA = new Set(providerA.claims.map(normalizeClaim))
  const claimsB = new Set(providerB.claims.map(normalizeClaim))

  for (const claimA of claimsA) {
    for (const claimB of claimsB) {
      if (areClaimsContradictory(claimA, claimB)) {
        contradictions.push({
          claim: `"${claimA}" vs "${claimB}"`,
          provider_a: providerA.provider,
          provider_b: providerB.provider,
          severity: determineDiscrepancySeverity(claimA, claimB),
          description: `Provider ${providerA.provider} claims "${claimA}" while ${providerB.provider} claims "${claimB}"`,
        })
      }
    }
  }

  return contradictions
}

/**
 * Detect discrepancies between provider pairs
 */
function detectProviderDiscrepancies(
  providerResults: ProviderResult[]
): CrossProviderVerificationResult["discrepancies"] {
  const discrepancies: CrossProviderVerificationResult["discrepancies"] = []

  // Compare each pair of providers
  for (let i = 0; i < providerResults.length; i++) {
    for (let j = i + 1; j < providerResults.length; j++) {
      const providerA = providerResults[i]
      const providerB = providerResults[j]

      // Safety check for undefined (noUncheckedIndexedAccess)
      if (!providerA || !providerB) continue

      const pairDiscrepancies = findContradictionsInPair(providerA, providerB)
      discrepancies.push(...pairDiscrepancies)
    }
  }

  return discrepancies
}

/**
 * Calculate score from verification results
 */
function scoreFromVerifications(
  provider: string,
  overlappingClaims: CrossProviderVerificationResult["overlapping_claims"]
): number {
  let score = 0

  for (const overlap of overlappingClaims) {
    if (!overlap.providers_supporting.includes(provider)) {
      continue
    }

    const verificationStatus = overlap.verification?.status
    if (verificationStatus === "verified") {
      score += 2
    } else if (verificationStatus === "uncertain") {
      score += 0.5
    } else if (verificationStatus === "contradicted") {
      score -= 1
    } else {
      score += 1 // Agreement bonus even without verification
    }
  }

  return score
}

/**
 * Calculate penalty from discrepancies
 */
function penaltyFromDiscrepancies(
  provider: string,
  discrepancies: CrossProviderVerificationResult["discrepancies"]
): number {
  let penalty = 0

  for (const disc of discrepancies) {
    if (disc.provider_a === provider || disc.provider_b === provider) {
      if (disc.severity === "critical") {
        penalty += 2
      } else if (disc.severity === "major") {
        penalty += 1
      } else {
        penalty += 0.5
      }
    }
  }

  return penalty
}

/**
 * Calculate bonus for claim coverage
 */
function bonusFromCoverage(
  providerResult: ProviderResult,
  providerResults: ProviderResult[]
): number {
  const maxClaims = Math.max(...providerResults.map((r) => r.claims.length))
  return providerResult.claims.length / maxClaims
}

/**
 * Score providers based on verification results and discrepancies
 */
function scoreProviders(
  providerResults: ProviderResult[],
  overlappingClaims: CrossProviderVerificationResult["overlapping_claims"],
  discrepancies: CrossProviderVerificationResult["discrepancies"]
): Map<string, number> {
  const providerScores = new Map<string, number>()

  for (const result of providerResults) {
    const verificationScore = scoreFromVerifications(result.provider, overlappingClaims)
    const discrepancyPenalty = penaltyFromDiscrepancies(result.provider, discrepancies)
    const coverageBonus = bonusFromCoverage(result, providerResults)

    const totalScore = verificationScore - discrepancyPenalty + coverageBonus
    providerScores.set(result.provider, totalScore)
  }

  return providerScores
}

/**
 * Calculate aggregate confidence from verification results
 */
function calculateAggregateConfidence(
  providerResults: ProviderResult[],
  overlappingClaims: CrossProviderVerificationResult["overlapping_claims"],
  discrepancies: CrossProviderVerificationResult["discrepancies"]
): number {
  const verifiedCount = overlappingClaims.filter(
    (c) => c.verification?.status === "verified"
  ).length
  const contradictedCount = overlappingClaims.filter(
    (c) => c.verification?.status === "contradicted"
  ).length
  const totalOverlapping = overlappingClaims.length

  let aggregateConfidence = 0.5 // Base confidence

  if (totalOverlapping > 0) {
    const overlapRatio = totalOverlapping / Math.max(...providerResults.map((r) => r.claims.length))
    const verificationRatio = verifiedCount / totalOverlapping
    const contradictionPenalty = contradictedCount / totalOverlapping

    aggregateConfidence = Math.min(
      0.95,
      0.5 + overlapRatio * 0.2 + verificationRatio * 0.25 - contradictionPenalty * 0.3
    )
  }

  // Penalty for critical discrepancies
  const criticalDiscrepancies = discrepancies.filter((d) => d.severity === "critical").length
  aggregateConfidence -= criticalDiscrepancies * 0.1

  // Ensure bounds
  return Math.max(0.1, Math.min(0.95, aggregateConfidence))
}

/**
 * Build preference reason string
 */
function buildPreferenceReason(
  discrepancies: CrossProviderVerificationResult["discrepancies"],
  overlappingClaims: CrossProviderVerificationResult["overlapping_claims"],
  preferredProvider: string,
  providerScores: Map<string, number>
): string {
  const verifiedCount = overlappingClaims.filter(
    (c) => c.verification?.status === "verified"
  ).length
  const contradictedCount = overlappingClaims.filter(
    (c) => c.verification?.status === "contradicted"
  ).length

  if (discrepancies.length === 0 && overlappingClaims.length > 0) {
    return `All providers agree on ${overlappingClaims.length} claims`
  }

  if (verifiedCount > contradictedCount) {
    return `${preferredProvider} has highest verified claim count (${verifiedCount} verified)`
  }

  const providerScore = providerScores.get(preferredProvider) ?? 0
  if (providerScore > 0) {
    return `${preferredProvider} scored highest in cross-verification (score: ${providerScore.toFixed(2)})`
  }

  return `${preferredProvider} selected as least conflicting source`
}

/**
 * Cross-verify results from multiple AI providers
 * Implements the cross-verification pipeline from Workstream D
 */
export async function crossVerifyProviderResults(
  providerResults: ProviderResult[],
  options: {
    verifyAllClaims?: boolean
    minOverlapForTrust?: number
    requestContext?: RequestContext
  } = {}
): Promise<CrossProviderVerificationResult> {
  const verifyAllClaims = options.verifyAllClaims ?? env.CROSS_VERIFY_ALL_WEB_SEARCH
  // minOverlapForTrust is reserved for future use when implementing confidence thresholds
  void options.minOverlapForTrust

  log.info(
    { providerCount: providerResults.length, verifyAllClaims },
    "Starting cross-provider verification"
  )

  const verificationId = crypto.randomUUID()

  // 1. Extract and normalize claims
  extractAndNormalizeClaims(providerResults)

  // 2. Find overlapping claims and verify
  const overlappingClaims = await findOverlappingClaims(
    providerResults,
    verifyAllClaims,
    options.requestContext
  )

  // 3. Detect discrepancies between providers
  const discrepancies = detectProviderDiscrepancies(providerResults)

  // 4. Score each provider
  const providerScores = scoreProviders(providerResults, overlappingClaims, discrepancies)

  // 5. Determine preferred provider
  let preferredProvider = providerResults[0]?.provider ?? "unknown"
  let maxScore = Number.NEGATIVE_INFINITY

  for (const [provider, score] of providerScores) {
    if (score > maxScore) {
      maxScore = score
      preferredProvider = provider
    }
  }

  // 6. Calculate aggregate confidence
  const aggregateConfidence = calculateAggregateConfidence(
    providerResults,
    overlappingClaims,
    discrepancies
  )

  // 7. Build preference reason
  const preferenceReason = buildPreferenceReason(
    discrepancies,
    overlappingClaims,
    preferredProvider,
    providerScores
  )

  const result: CrossProviderVerificationResult = {
    verification_id: verificationId,
    provider_results: providerResults,
    overlapping_claims: overlappingClaims,
    discrepancies,
    preferred_provider: preferredProvider,
    preference_reason: preferenceReason,
    aggregate_confidence: aggregateConfidence,
    created_at: new Date().toISOString(),
  }

  // Persist to database if enabled
  if (env.ENABLE_GROUNDING) {
    await persistProviderVerification(result)
  }

  log.info(
    {
      verificationId,
      overlappingClaims: overlappingClaims.length,
      discrepancies: discrepancies.length,
      preferredProvider,
      confidence: aggregateConfidence,
    },
    "Cross-provider verification complete"
  )

  return result
}

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Extract key terms from a claim for overlap analysis
 */
function extractKeyTerms(claim: string, minLength: number): Set<string> {
  return new Set(claim.split(/\s+/).filter((w) => w.length >= minLength))
}

/**
 * Calculate term overlap between two claims
 */
function calculateTermOverlap(termsA: Set<string>, termsB: Set<string>): number {
  return [...termsA].filter((t) => termsB.has(t)).length
}

/**
 * Check if claims contradict via negation patterns
 */
function checkNegationContradiction(claimA: string, claimB: string): boolean {
  const negationPatterns = [
    { positive: /\bis\b/, negative: /\bis not\b|\bisn't\b/ },
    { positive: /\bwill\b/, negative: /\bwill not\b|\bwon't\b/ },
    { positive: /\bcan\b/, negative: /\bcannot\b|\bcan't\b/ },
    { positive: /\bhas\b/, negative: /\bhas not\b|\bhasn't\b/ },
    { positive: /\bdoes\b/, negative: /\bdoes not\b|\bdoesn't\b/ },
  ]

  for (const pattern of negationPatterns) {
    const aHasPositive = pattern.positive.test(claimA) && !pattern.negative.test(claimA)
    const bHasNegative = pattern.negative.test(claimB)
    const aHasNegative = pattern.negative.test(claimA)
    const bHasPositive = pattern.positive.test(claimB) && !pattern.negative.test(claimB)

    // Check if same subject but opposite assertion
    if ((aHasPositive && bHasNegative) || (aHasNegative && bHasPositive)) {
      const termsA = extractKeyTerms(claimA, 3)
      const termsB = extractKeyTerms(claimB, 3)
      const overlap = calculateTermOverlap(termsA, termsB)

      if (overlap >= 2) {
        return true
      }
    }
  }

  return false
}

/**
 * Check if claims contradict via conflicting numbers
 */
function checkNumericContradiction(claimA: string, claimB: string): boolean {
  const numbersA = claimA.match(/\b\d+(?:\.\d+)?(?:%|percent|million|billion|thousand)?\b/g) ?? []
  const numbersB = claimB.match(/\b\d+(?:\.\d+)?(?:%|percent|million|billion|thousand)?\b/g) ?? []

  const firstNumberA = numbersA[0]
  const firstNumberB = numbersB[0]

  // Early return if no numbers
  if (!firstNumberA || !firstNumberB) {
    return false
  }

  // Check if claims share the same topic
  const termsA = extractKeyTerms(claimA, 4)
  const termsB = extractKeyTerms(claimB, 4)
  const overlap = calculateTermOverlap(termsA, termsB)

  if (overlap < 2) {
    return false
  }

  // Parse and compare numbers
  const numA = Number.parseFloat(firstNumberA.replace(/[^0-9.]/g, ""))
  const numB = Number.parseFloat(firstNumberB.replace(/[^0-9.]/g, ""))

  if (Number.isNaN(numA) || Number.isNaN(numB)) {
    return false
  }

  const ratio = Math.max(numA, numB) / Math.min(numA, numB)
  return ratio > 1.5 // Numbers differ by more than 50%
}

/**
 * Check if two claims are contradictory using heuristic patterns
 */
function areClaimsContradictory(claimA: string, claimB: string): boolean {
  // Check for negation-based contradictions
  if (checkNegationContradiction(claimA, claimB)) {
    return true
  }

  // Check for numeric contradictions
  if (checkNumericContradiction(claimA, claimB)) {
    return true
  }

  return false
}

function determineDiscrepancySeverity(
  claimA: string,
  claimB: string
): "minor" | "major" | "critical" {
  // Critical: factual numbers that differ significantly
  const numbersA = claimA.match(/\b\d+(?:\.\d+)?(?:%|percent|million|billion|thousand)?\b/g) ?? []
  const numbersB = claimB.match(/\b\d+(?:\.\d+)?(?:%|percent|million|billion|thousand)?\b/g) ?? []

  const firstNumberA = numbersA[0]
  const firstNumberB = numbersB[0]
  if (firstNumberA && firstNumberB) {
    const numA = Number.parseFloat(firstNumberA.replace(/[^0-9.]/g, ""))
    const numB = Number.parseFloat(firstNumberB.replace(/[^0-9.]/g, ""))

    if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
      const ratio = Math.max(numA, numB) / Math.min(numA, numB)
      if (ratio > 3) return "critical"
      if (ratio > 1.5) return "major"
    }
  }

  // Major: explicit negation
  const negationWords = ["not", "never", "no", "cannot", "won't", "isn't", "doesn't", "hasn't"]
  const aHasNegation = negationWords.some((w) => claimA.includes(w))
  const bHasNegation = negationWords.some((w) => claimB.includes(w))

  if (aHasNegation !== bHasNegation) {
    return "major"
  }

  return "minor"
}

async function persistProviderVerification(result: CrossProviderVerificationResult): Promise<void> {
  try {
    await groundingRequest("/provider-verifications", "POST", {
      verification_id: result.verification_id,
      provider_results: result.provider_results.map((r) => ({
        provider: r.provider,
        claim_count: r.claims.length,
        timestamp: r.timestamp,
      })),
      overlapping_claims_count: result.overlapping_claims.length,
      discrepancies_count: result.discrepancies.length,
      preferred_provider: result.preferred_provider,
      preference_reason: result.preference_reason,
      aggregate_confidence: result.aggregate_confidence,
      created_at: result.created_at,
    })
  } catch (error) {
    log.warn({ error }, "Failed to persist provider verification")
  }
}
