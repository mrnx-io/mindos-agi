// =============================================================================
// xAI Agent Tools Router - Hybrid Execution with Cross-Verification
// =============================================================================

import { env } from "../config.js"
import { createEvidence } from "../evidence.js"
import { createLogger } from "../logger.js"
import { type ChatMessage, completeWithXaiAgentTools } from "../router.js"
import type { HybridToolResult, ToolProvider, ToolRoutingDecision } from "../types.js"
import { type ExecutionResult, type RequestContext, executeCode } from "./executorClient.js"
import { extractFactualClaims, verifyClaim, verifyMultipleClaims } from "./groundingClient.js"

const log = createLogger("xai-tool-router")

// Re-export types for backwards compatibility
export type { HybridToolResult, ToolProvider, ToolRoutingDecision }

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ToolRoutingRequirements {
  needsEvidence?: boolean
  needsPolicy?: boolean
  needsSandbox?: boolean
  preferSpeed?: boolean
  isHighRisk?: boolean
}

// -----------------------------------------------------------------------------
// Tool Provider Decision Logic
// -----------------------------------------------------------------------------

/**
 * Determine which provider(s) should handle a tool request based on requirements.
 *
 * Routing Rules:
 * 1. x_search → Always xAI (exclusive capability)
 * 2. web_search + needsEvidence → Both (cross-verify)
 * 3. High-risk/needsPolicy → MindOS (governance)
 * 4. Simple/speed-preferred → xAI (fast)
 * 5. TypeScript/JavaScript code → MindOS Executor
 * 6. Python code → xAI code_execution (if not high-risk)
 */
export function decideToolProvider(
  intent: string,
  requirements: ToolRoutingRequirements
): ToolRoutingDecision {
  const intentLower = intent.toLowerCase()

  // X/Twitter search is xAI exclusive
  if (
    intentLower.includes("twitter") ||
    intentLower.includes("x.com") ||
    intentLower.includes("@") ||
    intent === "x_search"
  ) {
    return {
      provider: "xai",
      reason: "X/Twitter search exclusive to xAI",
      xaiTool: "x_search",
    }
  }

  // High-risk operations require MindOS governance
  if (requirements.isHighRisk || requirements.needsPolicy) {
    return {
      provider: "mindos",
      reason: "High-risk requires MindOS policy enforcement",
      mindosTool: "toolmesh",
    }
  }

  // Evidence-required uses BOTH for cross-verification
  if (requirements.needsEvidence) {
    return {
      provider: "both",
      reason: "Cross-verification for evidence chain",
      xaiTool: "web_search",
      mindosTool: "grounding",
    }
  }

  // Sandbox-required code uses MindOS Executor
  if (requirements.needsSandbox) {
    return {
      provider: "mindos",
      reason: "Sandbox required for code execution",
      mindosTool: "executor",
    }
  }

  // Default based on preference
  if (env.XAI_PREFER_AGENT_TOOLS) {
    return {
      provider: "xai",
      reason: "Default to xAI Agent Tools (preference enabled)",
      xaiTool: "web_search",
    }
  }

  return {
    provider: "mindos",
    reason: "Default to MindOS services",
    mindosTool: "toolmesh",
  }
}

// -----------------------------------------------------------------------------
// Web Search (Hybrid with Cross-Verification)
// -----------------------------------------------------------------------------

export interface WebSearchOptions {
  needsEvidence?: boolean
  identityId?: string
  context?: RequestContext
}

/**
 * Calculate aggregate confidence from verification results.
 */
function calculateAggregateConfidence(
  verifiedCount: number,
  contradictedCount: number,
  totalVerifiable: number
): number {
  if (totalVerifiable === 0) {
    return 0.5 // Base confidence
  }

  return Math.min(
    0.95,
    0.5 + (verifiedCount / totalVerifiable) * 0.4 - (contradictedCount / totalVerifiable) * 0.3
  )
}

/**
 * Create evidence record for search verification.
 */
async function createSearchEvidence(
  identityId: string,
  searchQuery: string,
  xaiContent: string,
  claims: string[],
  verifiedCount: number,
  contradictedCount: number,
  aggregateConfidence: number,
  verificationResults: Array<{ claim: string; status: string; confidence: number }>
): Promise<string> {
  const evidence = await createEvidence({
    identity_id: identityId,
    kind: "grounding_check",
    ref: `web_search:${crypto.randomUUID()}`,
    payload: {
      query: searchQuery,
      xai_response_preview: xaiContent.slice(0, 500),
      claims_extracted: claims.length,
      claims_verified: verifiedCount,
      claims_contradicted: contradictedCount,
      aggregate_confidence: aggregateConfidence,
      verification_results: verificationResults.map((r) => ({
        claim: r.claim.slice(0, 100),
        status: r.status,
        confidence: r.confidence,
      })),
    },
  })
  return evidence.evidence_id
}

/**
 * Verify search claims and create hybrid result.
 */
async function verifySearchClaims(
  searchQuery: string,
  xaiContent: string,
  claims: string[],
  options: WebSearchOptions
): Promise<HybridToolResult> {
  log.info(
    { claimCount: claims.length, query: searchQuery.slice(0, 50) },
    "Extracted claims for cross-verification"
  )

  // Verify each claim against grounding service
  const verificationResults = await verifyMultipleClaims(
    claims,
    { context: searchQuery, minConfidence: 0.6 },
    options.context
  )

  // Calculate aggregate confidence
  const verifiedCount = verificationResults.filter((r) => r.status === "verified").length
  const contradictedCount = verificationResults.filter((r) => r.status === "contradicted").length
  const totalVerifiable = verificationResults.filter((r) => r.status !== "unverifiable").length

  const aggregateConfidence = calculateAggregateConfidence(
    verifiedCount,
    contradictedCount,
    totalVerifiable
  )

  log.info(
    {
      verified: verifiedCount,
      contradicted: contradictedCount,
      total: claims.length,
      aggregateConfidence,
    },
    "Claim-level cross-verification completed"
  )

  // Create evidence record for the verification
  let evidenceId: string | undefined
  if (options.identityId) {
    evidenceId = await createSearchEvidence(
      options.identityId,
      searchQuery,
      xaiContent,
      claims,
      verifiedCount,
      contradictedCount,
      aggregateConfidence,
      verificationResults
    )
  }

  // Return warnings if contradicted claims found
  const contradictedClaims = verificationResults
    .filter((r) => r.status === "contradicted")
    .map((r) => r.claim)

  return {
    provider: "both",
    xaiContent:
      contradictedClaims.length > 0
        ? `${xaiContent}\n\n⚠️ Note: ${contradictedClaims.length} claim(s) could not be verified and may be inaccurate.`
        : xaiContent,
    mindosOutput: {
      verification_summary: {
        claims_total: claims.length,
        claims_verified: verifiedCount,
        claims_contradicted: contradictedCount,
        confidence: aggregateConfidence,
      },
      contradicted_claims: contradictedClaims,
    },
    evidenceId,
    crossVerified: true,
    confidence: aggregateConfidence,
  }
}

export async function executeWebSearch(
  searchQuery: string,
  options: WebSearchOptions = {}
): Promise<HybridToolResult> {
  const decision = decideToolProvider("web_search", {
    needsEvidence: options.needsEvidence ?? env.ENABLE_GROUNDING,
    preferSpeed: !options.needsEvidence,
  })

  log.info({ query: searchQuery.slice(0, 100), decision }, "Web search routing decision")

  // xAI-only or cross-verify path
  if (decision.provider === "xai" || decision.provider === "both") {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: `Search the web for: ${searchQuery}`,
      },
    ]

    const xaiResult = await completeWithXaiAgentTools({ messages }, ["web_search"])

    // If cross-verification is enabled, extract and verify all factual claims
    if (decision.provider === "both" && env.CROSS_VERIFY_ALL_WEB_SEARCH && xaiResult.content) {
      const claims = extractFactualClaims(xaiResult.content)

      if (claims.length > 0) {
        return await verifySearchClaims(searchQuery, xaiResult.content, claims, options)
      }

      // No claims extracted - fall back to query-level verification
      const groundingResult = await verifyClaim(
        searchQuery,
        { context: xaiResult.content },
        options.context
      )

      return {
        provider: "both",
        xaiContent: xaiResult.content,
        mindosOutput: groundingResult as unknown as Record<string, unknown>,
        evidenceId: groundingResult.verification_id,
        crossVerified: true,
        confidence: groundingResult.confidence,
      }
    }

    return { provider: "xai", xaiContent: xaiResult.content }
  }

  // MindOS-only path
  const groundingResult = await verifyClaim(searchQuery, {}, options.context)

  return {
    provider: "mindos",
    mindosOutput: groundingResult as unknown as Record<string, unknown>,
    evidenceId: groundingResult.verification_id,
    confidence: groundingResult.confidence,
  }
}

// -----------------------------------------------------------------------------
// X/Twitter Search (xAI Exclusive)
// -----------------------------------------------------------------------------

export interface XSearchOptions {
  identityId?: string
  createEvidence?: boolean
  context?: RequestContext
}

interface ParsedXPost {
  url: string
  username: string
  postId: string
  content: string | undefined
  timestamp: string | undefined
}

/**
 * Parse X/Twitter post URLs from response content.
 * Handles formats like:
 * - https://x.com/username/status/1234567890
 * - https://twitter.com/username/status/1234567890
 */
function parseXPostUrls(content: string): ParsedXPost[] {
  const posts: ParsedXPost[] = []

  // Match X/Twitter URLs
  const urlPattern = /https?:\/\/(?:x\.com|twitter\.com)\/([^/\s]+)\/status\/(\d+)/gi
  let match = urlPattern.exec(content)

  while (match !== null) {
    posts.push({
      url: match[0],
      username: match[1] ?? "",
      postId: match[2] ?? "",
      content: undefined,
      timestamp: undefined,
    })
    match = urlPattern.exec(content)
  }

  // Try to extract content snippets near each URL
  for (const post of posts) {
    // Look for quoted content near the URL
    const urlIndex = content.indexOf(post.url)
    if (urlIndex !== -1) {
      // Check for quoted text before or after the URL (within 500 chars)
      const contextStart = Math.max(0, urlIndex - 300)
      const contextEnd = Math.min(content.length, urlIndex + post.url.length + 300)
      const context = content.slice(contextStart, contextEnd)

      // Extract quoted text
      const quoteMatch = context.match(/"([^"]{10,500})"|'([^']{10,500})'|"([^"]{10,500})"/)
      if (quoteMatch) {
        const matched = quoteMatch[1] || quoteMatch[2] || quoteMatch[3]
        if (matched) {
          post.content = matched
        }
      }
    }
  }

  return posts
}

export async function executeXSearch(
  searchQuery: string,
  options: XSearchOptions = {}
): Promise<HybridToolResult> {
  log.info({ query: searchQuery.slice(0, 100) }, "X/Twitter search via xAI (exclusive)")

  const messages: ChatMessage[] = [
    {
      role: "user",
      content: `Search X/Twitter for: ${searchQuery}`,
    },
  ]

  const xaiResult = await completeWithXaiAgentTools({ messages }, ["x_search"])

  // Parse post URLs and create evidence records if enabled
  if (xaiResult.content && (options.createEvidence ?? true) && options.identityId) {
    const posts = parseXPostUrls(xaiResult.content)

    log.info(
      { postCount: posts.length, query: searchQuery.slice(0, 50) },
      "Parsed X posts from search results"
    )

    if (posts.length > 0 && options.identityId) {
      const identityId = options.identityId
      // Create evidence records for each post
      const evidencePromises = posts.slice(0, 10).map(async (post, index) => {
        try {
          const evidence = await createEvidence({
            identity_id: identityId,
            kind: "external_doc",
            ref: `x_search:${post.postId}`,
            payload: {
              search_query: searchQuery,
              post_url: post.url,
              username: post.username,
              post_id: post.postId,
              ...(post.content && { content_preview: post.content.slice(0, 200) }),
              retrieved_at: new Date().toISOString(),
              result_index: index,
            },
          })
          return { post, evidenceId: evidence.evidence_id }
        } catch (error) {
          log.warn({ post, error }, "Failed to create evidence for X post")
          return null
        }
      })

      const evidenceResults = await Promise.all(evidencePromises)
      const successfulEvidence = evidenceResults.filter(Boolean)

      log.info(
        { created: successfulEvidence.length, total: posts.length },
        "Created evidence records for X posts"
      )

      // Add evidence metadata to result
      return {
        provider: "xai",
        xaiContent: xaiResult.content,
        mindosOutput: {
          posts_found: posts.length,
          evidence_records_created: successfulEvidence.length,
          posts: posts.map((p) => ({
            url: p.url,
            username: p.username,
            post_id: p.postId,
          })),
        },
        confidence: 0.85, // X posts are authoritative sources
      }
    }
  }

  return { provider: "xai", xaiContent: xaiResult.content }
}

// -----------------------------------------------------------------------------
// Code Execution (Hybrid Routing)
// -----------------------------------------------------------------------------

export type SupportedLanguage = "typescript" | "javascript" | "python"

export interface CodeExecutionOptions {
  needsSandbox?: boolean
  needsAudit?: boolean
  timeout_ms?: number
  context?: RequestContext
  identityId?: string
  expectedBehavior?: string // Description of expected behavior for validation
}

interface CodeSafetyAudit {
  safe: boolean
  risk_level: "low" | "medium" | "high" | "critical"
  issues: Array<{
    pattern: string
    description: string
    severity: "warning" | "medium" | "error" | "critical"
    line: number | undefined
  }>
  requires_sandbox: boolean
}

// Dangerous patterns by language
const DANGEROUS_PATTERNS: Record<
  SupportedLanguage,
  Array<{
    pattern: RegExp
    description: string
    severity: "warning" | "medium" | "error" | "critical"
  }>
> = {
  python: [
    {
      pattern: /\bos\.system\b/,
      description: "System command execution",
      severity: "critical" as const,
    },
    {
      pattern: /\bsubprocess\b/,
      description: "Subprocess execution",
      severity: "critical" as const,
    },
    { pattern: /\beval\s*\(/, description: "Dynamic code evaluation", severity: "error" as const },
    { pattern: /\bexec\s*\(/, description: "Dynamic code execution", severity: "error" as const },
    { pattern: /\b__import__\b/, description: "Dynamic import", severity: "error" as const },
    {
      pattern: /\bopen\s*\([^)]*['"][wa]/,
      description: "File write operation",
      severity: "medium" as const,
    },
    {
      pattern: /\brequests\.(?:post|put|delete|patch)\b/,
      description: "HTTP mutation",
      severity: "medium" as const,
    },
    { pattern: /\bsocket\b/, description: "Network socket access", severity: "medium" as const },
    {
      pattern: /\bpickle\b/,
      description: "Pickle deserialization (unsafe)",
      severity: "error" as const,
    },
    { pattern: /\bctypes\b/, description: "C-level memory access", severity: "error" as const },
  ],
  javascript: [],
  typescript: [],
}

// Fill typescript patterns after object is created
DANGEROUS_PATTERNS.typescript = [
  {
    pattern: /\beval\s*\(/,
    description: "Dynamic code evaluation",
    severity: "critical" as const,
  },
  {
    pattern: /new\s+Function\s*\(/,
    description: "Dynamic function creation",
    severity: "critical" as const,
  },
  {
    pattern: /\bexec(?:Sync)?\s*\(/,
    description: "Shell command execution",
    severity: "critical" as const,
  },
  {
    pattern: /\bspawn(?:Sync)?\s*\(/,
    description: "Process spawning",
    severity: "critical" as const,
  },
  {
    pattern: /\bfs\.(?:write|unlink|rmdir|rm)/,
    description: "File system mutation",
    severity: "error" as const,
  },
  {
    pattern: /\bchild_process\b/,
    description: "Child process module",
    severity: "critical" as const,
  },
  {
    pattern: /\bprocess\.env\b/,
    description: "Environment access",
    severity: "warning" as const,
  },
  {
    pattern: /\bfetch\s*\([^)]*{[^}]*method:\s*['"](?:POST|PUT|DELETE|PATCH)/,
    description: "HTTP mutation",
    severity: "medium" as const,
  },
  { pattern: /\bdangerouslySetInnerHTML\b/, description: "XSS risk", severity: "error" as const },
]

DANGEROUS_PATTERNS.javascript = [...DANGEROUS_PATTERNS.typescript]

/**
 * Perform pre-execution safety audit on code.
 * Detects dangerous patterns and determines if sandbox is required.
 */
function auditCodeSafety(code: string, language: SupportedLanguage): CodeSafetyAudit {
  const patterns = DANGEROUS_PATTERNS[language]
  if (!patterns) {
    throw new Error(`Unsupported language: ${language}`)
  }
  const issues: CodeSafetyAudit["issues"] = []

  for (const { pattern, description, severity } of patterns) {
    const lines = code.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line && pattern.test(line)) {
        issues.push({
          pattern: pattern.source,
          description,
          severity,
          line: i + 1,
        })
      }
    }
  }

  // Determine overall risk level
  const hasCritical = issues.some((i) => i.severity === "critical")
  const hasError = issues.some((i) => i.severity === "error")
  const hasMedium = issues.some((i) => i.severity === "medium" || i.severity === "warning")

  const risk_level: CodeSafetyAudit["risk_level"] = hasCritical
    ? "critical"
    : hasError
      ? "high"
      : hasMedium
        ? "medium"
        : "low"

  return {
    safe: !hasCritical,
    risk_level,
    issues,
    requires_sandbox: risk_level !== "low",
  }
}

/**
 * Check if output contains error indicators.
 */
function hasErrorIndicators(outputLower: string): boolean {
  const errorIndicators = ["error", "exception", "failed", "traceback", "undefined", "null"]
  return errorIndicators.some((ind) => outputLower.includes(ind))
}

/**
 * Check if output is empty or null.
 */
function isEmptyOutput(outputStr: string): boolean {
  return outputStr.length === 0 || outputStr === "undefined" || outputStr === "null"
}

/**
 * Validate expected output type patterns.
 */
function validateExpectedType(
  expectedLower: string,
  outputStr: string
): { valid: boolean; confidence: number; reason: string } | null {
  if (expectedLower.includes("number")) {
    const hasNumber = /\d+/.test(outputStr)
    if (!hasNumber) {
      return { valid: false, confidence: 0.3, reason: "Expected numeric output not found" }
    }
  }

  if (expectedLower.includes("array") || expectedLower.includes("list")) {
    const hasArray = outputStr.includes("[")
    if (!hasArray) {
      return { valid: false, confidence: 0.3, reason: "Expected array/list output not found" }
    }
  }

  if (expectedLower.includes("object") || expectedLower.includes("dict")) {
    const hasObject = outputStr.includes("{")
    if (!hasObject) {
      return { valid: false, confidence: 0.3, reason: "Expected object/dict output not found" }
    }
  }

  return null
}

/**
 * Validate execution output against expected behavior.
 * Returns a confidence score for how well the output matches expectations.
 */
function validateOutputBehavior(
  output: unknown,
  expectedBehavior?: string
): { valid: boolean; confidence: number; reason: string } {
  if (!expectedBehavior) {
    return { valid: true, confidence: 0.5, reason: "No expected behavior specified" }
  }

  const outputStr = typeof output === "string" ? output : JSON.stringify(output)
  const expectedLower = expectedBehavior.toLowerCase()
  const outputLower = outputStr.toLowerCase()

  // Check for error indicators when success was expected
  const hasError = hasErrorIndicators(outputLower)
  if (expectedLower.includes("success") || expectedLower.includes("return")) {
    if (hasError) {
      return { valid: false, confidence: 0.2, reason: "Output contains error indicators" }
    }
  }

  // Check for expected output patterns
  const typeValidation = validateExpectedType(expectedLower, outputStr)
  if (typeValidation) {
    return typeValidation
  }

  // Check output size (empty output is often unexpected)
  if (isEmptyOutput(outputStr)) {
    return { valid: false, confidence: 0.3, reason: "Empty or null output" }
  }

  return { valid: true, confidence: 0.8, reason: "Output appears to match expected behavior" }
}

/**
 * Create evidence for code execution.
 */
async function createCodeExecutionEvidence(
  identityId: string,
  code: string,
  language: SupportedLanguage,
  safetyAudit: CodeSafetyAudit,
  executionTime: number,
  validation: { valid: boolean; confidence: number; reason: string },
  provider: "xai" | "mindos",
  output?: string,
  success?: boolean
): Promise<string | undefined> {
  try {
    const evidence = await createEvidence({
      identity_id: identityId,
      kind: "tool_call",
      ref: `code_exec:${crypto.randomUUID()}`,
      payload: {
        language,
        code_preview: code.slice(0, 500),
        code_hash: await hashCode(code),
        provider,
        safety_audit: {
          risk_level: safetyAudit.risk_level,
          issues_count: safetyAudit.issues.length,
        },
        execution_time_ms: executionTime,
        ...(output && { output_preview: output.slice(0, 500) }),
        ...(success !== undefined && { success }),
        validation: validation,
        executed_at: new Date().toISOString(),
      },
    })
    return evidence.evidence_id
  } catch (error) {
    log.warn({ error }, "Failed to create evidence for code execution")
    return undefined
  }
}

/**
 * Execute Python code using xAI code_execution tool.
 */
async function executeWithXai(
  code: string,
  language: SupportedLanguage,
  safetyAudit: CodeSafetyAudit,
  options: CodeExecutionOptions,
  startTime: number
): Promise<HybridToolResult> {
  log.info("Routing Python code to xAI code_execution")

  const messages: ChatMessage[] = [
    {
      role: "user",
      content: `Execute this Python code and return the result:\n\`\`\`python\n${code}\n\`\`\``,
    },
  ]

  const xaiResult = await completeWithXaiAgentTools({ messages }, ["code_execution"])
  const executionTime = Date.now() - startTime
  const validation = validateOutputBehavior(xaiResult.content, options.expectedBehavior)

  // Create evidence record if identity provided
  let evidenceId: string | undefined
  if (options.identityId) {
    evidenceId = await createCodeExecutionEvidence(
      options.identityId,
      code,
      language,
      safetyAudit,
      executionTime,
      validation,
      "xai",
      xaiResult.content ?? undefined
    )
  }

  return {
    provider: "xai",
    xaiContent: xaiResult.content,
    ...(evidenceId && {
      mindosOutput: {
        safety_audit: safetyAudit,
        validation,
        execution_time_ms: executionTime,
      },
      evidenceId,
    }),
    confidence: validation.confidence,
  }
}

/**
 * Execute TypeScript/JavaScript code using MindOS Executor.
 */
async function executeWithMindOS(
  code: string,
  language: SupportedLanguage,
  safetyAudit: CodeSafetyAudit,
  options: CodeExecutionOptions,
  startTime: number
): Promise<HybridToolResult> {
  log.info("Routing code to MindOS Executor (sandbox)")

  const executorResult: ExecutionResult = await executeCode(
    {
      code,
      language: language as "typescript" | "javascript",
      timeout_ms: options.timeout_ms ?? env.EXECUTOR_TIMEOUT_MS,
    },
    options.context
  )

  const executionTime = Date.now() - startTime
  const validation = validateOutputBehavior(executorResult.output, options.expectedBehavior)

  // Create evidence record if identity provided
  let evidenceId: string | undefined
  if (options.identityId) {
    const outputStr = typeof executorResult.output === "string" ? executorResult.output : undefined
    evidenceId = await createCodeExecutionEvidence(
      options.identityId,
      code,
      language,
      safetyAudit,
      executionTime,
      validation,
      "mindos",
      outputStr,
      executorResult.success
    )
  }

  return {
    provider: "mindos",
    mindosOutput:
      typeof executorResult.output === "object" && executorResult.output !== null
        ? (executorResult.output as Record<string, unknown>)
        : { result: executorResult.output },
    evidenceId,
    confidence: executorResult.success ? validation.confidence : 0.2,
  }
}

/**
 * Handle Python fallback when MindOS Executor doesn't support it.
 */
async function handlePythonFallback(
  code: string,
  safetyAudit: CodeSafetyAudit,
  options: CodeExecutionOptions
): Promise<HybridToolResult> {
  log.warn("Python requested but MindOS Executor only supports TS/JS, attempting xAI fallback")

  // Try xAI anyway if enabled (critical risk already filtered above)
  if (env.XAI_ENABLE_AGENT_TOOLS) {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: `Execute this Python code and return the result:\n\`\`\`python\n${code}\n\`\`\``,
      },
    ]
    const xaiResult = await completeWithXaiAgentTools({ messages }, ["code_execution"])
    const validation = validateOutputBehavior(xaiResult.content, options.expectedBehavior)

    return {
      provider: "xai",
      xaiContent: xaiResult.content,
      confidence: validation.confidence,
    }
  }

  return {
    provider: "mindos",
    mindosOutput: {
      error: "Python execution not available (xAI Agent Tools disabled or code blocked)",
      safety_audit: safetyAudit,
    },
    confidence: 0,
  }
}

export async function executeCodeHybrid(
  code: string,
  language: SupportedLanguage,
  options: CodeExecutionOptions = {}
): Promise<HybridToolResult> {
  // Pre-execution safety audit
  const safetyAudit = auditCodeSafety(code, language)

  log.info(
    {
      language,
      codeLength: code.length,
      risk_level: safetyAudit.risk_level,
      issues: safetyAudit.issues.length,
    },
    "Code safety audit completed"
  )

  // Block critical risk code - never allow critical patterns regardless of sandbox setting
  if (safetyAudit.risk_level === "critical") {
    log.warn({ issues: safetyAudit.issues }, "Blocking critical-risk code execution")
    return {
      provider: "mindos",
      mindosOutput: {
        error: "Code execution blocked due to critical safety concerns",
        audit: safetyAudit,
      },
      confidence: 0,
    }
  }

  // Force sandbox for high-risk code
  const effectiveNeedsSandbox = options.needsSandbox || safetyAudit.requires_sandbox

  const decision = decideToolProvider("code_execution", {
    needsSandbox: effectiveNeedsSandbox,
    ...(options.needsAudit !== undefined && { needsPolicy: options.needsAudit }),
    preferSpeed: !effectiveNeedsSandbox && !options.needsAudit,
  })

  log.info({ language, codeLength: code.length, decision }, "Code execution routing decision")

  // xAI code_execution only supports Python (critical risk already filtered above)
  const canUseXai =
    language === "python" && decision.provider !== "mindos" && env.XAI_ENABLE_AGENT_TOOLS

  const startTime = Date.now()

  if (canUseXai) {
    return await executeWithXai(code, language, safetyAudit, options, startTime)
  }

  // MindOS Executor for TypeScript/JavaScript or when sandbox is required
  // Note: MindOS executor only supports typescript/javascript
  if (language === "python") {
    return await handlePythonFallback(code, safetyAudit, options)
  }

  return await executeWithMindOS(code, language, safetyAudit, options, startTime)
}

/**
 * Simple code hash for tracking executions.
 */
async function hashCode(code: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(code)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// -----------------------------------------------------------------------------
// Unified Tool Dispatcher
// -----------------------------------------------------------------------------

export interface ToolDispatchRequest {
  tool: string
  parameters: Record<string, unknown>
  identityId?: string
  requirements?: ToolRoutingRequirements
  context?: RequestContext
}

export interface ToolDispatchResult {
  success: boolean
  output: unknown
  provider: ToolProvider
  evidence_id?: string
  latencyMs: number
}

/**
 * Handle web search tool dispatch.
 */
async function handleWebSearch(
  parameters: Record<string, unknown>,
  identityId: string | undefined,
  requirements: ToolRoutingRequirements,
  context: RequestContext | undefined
): Promise<HybridToolResult> {
  const options: WebSearchOptions = {
    ...(requirements.needsEvidence !== undefined && {
      needsEvidence: requirements.needsEvidence,
    }),
    ...(identityId && { identityId }),
    ...(context && { context }),
  }
  return await executeWebSearch(parameters.query as string, options)
}

/**
 * Handle X/Twitter search tool dispatch.
 */
async function handleXSearch(
  parameters: Record<string, unknown>,
  identityId: string | undefined,
  requirements: ToolRoutingRequirements,
  context: RequestContext | undefined
): Promise<HybridToolResult> {
  const options: XSearchOptions = {
    ...(identityId && { identityId }),
    ...(requirements.needsEvidence !== undefined && {
      createEvidence: requirements.needsEvidence,
    }),
    ...(context && { context }),
  }
  return await executeXSearch(parameters.query as string, options)
}

/**
 * Handle code execution tool dispatch.
 */
async function handleCodeExecution(
  parameters: Record<string, unknown>,
  identityId: string | undefined,
  requirements: ToolRoutingRequirements,
  context: RequestContext | undefined
): Promise<HybridToolResult> {
  const options: CodeExecutionOptions = {
    ...(requirements.needsSandbox !== undefined && {
      needsSandbox: requirements.needsSandbox,
    }),
    ...(requirements.needsPolicy !== undefined && { needsAudit: requirements.needsPolicy }),
    ...(parameters.timeout_ms !== undefined && {
      timeout_ms: parameters.timeout_ms as number,
    }),
    ...(context && { context }),
    ...(identityId && { identityId }),
    ...(parameters.expected_behavior !== undefined && {
      expectedBehavior: parameters.expected_behavior as string,
    }),
  }
  return await executeCodeHybrid(
    parameters.code as string,
    (parameters.language as SupportedLanguage) ?? "typescript",
    options
  )
}

/**
 * Convert hybrid tool result to dispatch result.
 */
function createDispatchResult(result: HybridToolResult, startTime: number): ToolDispatchResult {
  const output = result.xaiContent ?? result.mindosOutput
  const success = !!(result.xaiContent || result.mindosOutput)

  return {
    success,
    output,
    provider: result.provider,
    ...(result.evidenceId && { evidence_id: result.evidenceId }),
    latencyMs: Date.now() - startTime,
  }
}

export async function dispatchTool(request: ToolDispatchRequest): Promise<ToolDispatchResult> {
  const start = Date.now()
  const { tool, parameters, identityId, requirements = {}, context } = request

  log.info({ tool, parameters }, "Dispatching tool request")

  try {
    let result: HybridToolResult

    switch (tool) {
      case "web_search":
        result = await handleWebSearch(parameters, identityId, requirements, context)
        break

      case "x_search":
        result = await handleXSearch(parameters, identityId, requirements, context)
        break

      case "code_execution":
      case "execute_code":
        result = await handleCodeExecution(parameters, identityId, requirements, context)
        break

      default:
        // Unknown tool - route to MindOS
        log.warn({ tool }, "Unknown tool, defaulting to MindOS handling")
        return {
          success: false,
          output: { error: `Unknown tool: ${tool}` },
          provider: "mindos",
          latencyMs: Date.now() - start,
        }
    }

    return createDispatchResult(result, start)
  } catch (error) {
    log.error({ tool, error }, "Tool dispatch failed")
    return {
      success: false,
      output: { error: error instanceof Error ? error.message : String(error) },
      provider: "mindos",
      latencyMs: Date.now() - start,
    }
  }
}

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------

export async function checkXaiAgentToolsHealth(): Promise<{
  available: boolean
  enabledTools: string[]
}> {
  if (!env.XAI_ENABLE_AGENT_TOOLS) {
    return { available: false, enabledTools: [] }
  }

  const enabledTools = env.XAI_AGENT_TOOLS_ENABLED.split(",")

  // Try a simple web search to verify connectivity
  try {
    const messages: ChatMessage[] = [{ role: "user", content: "What is 2+2?" }]
    await completeWithXaiAgentTools({ messages }, [])
    return { available: true, enabledTools }
  } catch {
    return { available: false, enabledTools }
  }
}
