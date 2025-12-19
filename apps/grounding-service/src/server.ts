// =============================================================================
// MindOS - Grounding Service (External Fact Verification)
// =============================================================================

import cors from "@fastify/cors"
import Fastify from "fastify"
import OpenAI from "openai"
import pg from "pg"
import pino from "pino"
import { request } from "undici"
import { z } from "zod"

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const env = {
  PORT: Number.parseInt(process.env.PORT ?? "3003"),
  HOST: process.env.HOST ?? "0.0.0.0",
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  WIKIPEDIA_API_URL: process.env.WIKIPEDIA_API_URL ?? "https://en.wikipedia.org/api/rest_v1",
  BRAVE_API_KEY: process.env.BRAVE_API_KEY ?? "",
  GROUNDING_MODEL: process.env.GROUNDING_MODEL ?? "gpt-5.2-mini",
  GROUNDING_CONFIDENCE_THRESHOLD: Number.parseFloat(
    process.env.GROUNDING_CONFIDENCE_THRESHOLD ?? "0.7"
  ),
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
}

const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
})

// -----------------------------------------------------------------------------
// Database
// -----------------------------------------------------------------------------

const { Pool } = pg
const pool = new Pool({ connectionString: env.DATABASE_URL })

// -----------------------------------------------------------------------------
// OpenAI Client
// -----------------------------------------------------------------------------

const openai = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface VerificationRequest {
  claim: string
  context?: string
  sources?: string[]
  min_confidence?: number
}

interface VerificationResult {
  verification_id: string
  claim: string
  status: "verified" | "contradicted" | "uncertain" | "unverifiable"
  confidence: number
  sources: Array<{
    name: string
    url?: string
    relevance: number
    supports: boolean
    excerpt: string
  }>
  analysis: string
  created_at: string
}

// -----------------------------------------------------------------------------
// Request Schemas
// -----------------------------------------------------------------------------

const VerifyClaimSchema = z.object({
  claim: z.string().min(1),
  context: z.string().optional(),
  sources: z.array(z.string()).optional(),
  min_confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(env.GROUNDING_CONFIDENCE_THRESHOLD),
})

// -----------------------------------------------------------------------------
// Verification Logic
// -----------------------------------------------------------------------------

async function verifyWithWikipedia(claim: string): Promise<{
  found: boolean
  excerpt?: string
  url?: string
  relevance: number
}> {
  try {
    // Search Wikipedia for relevant articles
    const searchUrl = `${env.WIKIPEDIA_API_URL}/page/summary/${encodeURIComponent(claim.split(" ").slice(0, 5).join("_"))}`

    const response = await request(searchUrl, {
      headers: { "User-Agent": "MindOS-Grounding/1.0" },
    })

    if (response.statusCode !== 200) {
      return { found: false, relevance: 0 }
    }

    const data = (await response.body.json()) as {
      extract?: string
      content_urls?: { desktop?: { page?: string } }
    }

    return {
      found: true,
      excerpt: data.extract?.slice(0, 500),
      url: data.content_urls?.desktop?.page,
      relevance: 0.7, // Would calculate based on content match
    }
  } catch {
    return { found: false, relevance: 0 }
  }
}

async function verifyWithBraveSearch(claim: string): Promise<{
  results: Array<{ title: string; url: string; description: string }>
}> {
  if (!env.BRAVE_API_KEY) {
    return { results: [] }
  }

  try {
    const response = await request("https://api.search.brave.com/res/v1/web/search", {
      method: "GET",
      headers: {
        "X-Subscription-Token": env.BRAVE_API_KEY,
        Accept: "application/json",
      },
      query: { q: claim, count: "5" },
    })

    const data = (await response.body.json()) as {
      web?: { results?: Array<{ title: string; url: string; description: string }> }
    }

    return {
      results: data.web?.results?.slice(0, 5) ?? [],
    }
  } catch {
    return { results: [] }
  }
}

async function analyzeWithLLM(
  claim: string,
  sources: Array<{ name: string; content: string }>
): Promise<{
  status: "verified" | "contradicted" | "uncertain" | "unverifiable"
  confidence: number
  analysis: string
}> {
  if (!openai) {
    return {
      status: "unverifiable",
      confidence: 0,
      analysis: "LLM analysis not available - no OpenAI API key configured",
    }
  }

  const sourcesText = sources
    .map((s, i) => `Source ${i + 1} (${s.name}):\n${s.content}`)
    .join("\n\n")

  const response = await openai.chat.completions.create({
    model: env.GROUNDING_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a fact-checking assistant. Analyze claims against provided sources and determine if they are verified, contradicted, uncertain, or unverifiable.

Respond with JSON:
{
  "status": "verified" | "contradicted" | "uncertain" | "unverifiable",
  "confidence": 0.0-1.0,
  "analysis": "Detailed explanation of your reasoning"
}`,
      },
      {
        role: "user",
        content: `Claim to verify: "${claim}"

Available sources:
${sourcesText || "No sources available"}

Analyze whether the claim is supported or contradicted by these sources.`,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
  })

  try {
    const result = JSON.parse(response.choices[0].message.content ?? "{}")
    return {
      status: result.status ?? "uncertain",
      confidence: result.confidence ?? 0.5,
      analysis: result.analysis ?? "Analysis failed",
    }
  } catch {
    return {
      status: "uncertain",
      confidence: 0.5,
      analysis: "Failed to parse LLM response",
    }
  }
}

async function verifyClaim(req: VerificationRequest): Promise<VerificationResult> {
  const verificationId = crypto.randomUUID()
  const sources: VerificationResult["sources"] = []

  // Check Wikipedia
  const wikiResult = await verifyWithWikipedia(req.claim)
  if (wikiResult.found) {
    sources.push({
      name: "Wikipedia",
      url: wikiResult.url,
      relevance: wikiResult.relevance,
      supports: true, // Will be refined by LLM
      excerpt: wikiResult.excerpt ?? "",
    })
  }

  // Check Brave Search
  const braveResults = await verifyWithBraveSearch(req.claim)
  for (const result of braveResults.results) {
    sources.push({
      name: result.title,
      url: result.url,
      relevance: 0.5,
      supports: true,
      excerpt: result.description,
    })
  }

  // Analyze with LLM
  const llmSources = sources.map((s) => ({ name: s.name, content: s.excerpt }))
  const analysis = await analyzeWithLLM(req.claim, llmSources)

  // Update source support based on analysis
  // (In production, would parse LLM output to update individual source assessments)

  // Store verification result
  await pool.query(
    `INSERT INTO grounding_verifications (
      verification_id, evidence_id, source, status, confidence, supporting_evidence, contradicting_evidence
    ) VALUES ($1, NULL, 'grounding-service', $2, $3, $4, $5)`,
    [
      verificationId,
      analysis.status,
      analysis.confidence,
      JSON.stringify(sources.filter((s) => s.supports)),
      JSON.stringify(sources.filter((s) => !s.supports)),
    ]
  )

  return {
    verification_id: verificationId,
    claim: req.claim,
    status: analysis.status,
    confidence: analysis.confidence,
    sources,
    analysis: analysis.analysis,
    created_at: new Date().toISOString(),
  }
}

// -----------------------------------------------------------------------------
// Cross-Tool Verification
// -----------------------------------------------------------------------------

async function crossVerifyToolOutput(
  _toolName: string,
  _output: unknown,
  _expectedBehavior: string
): Promise<{
  consistent: boolean
  discrepancies: string[]
  confidence: number
}> {
  // Would implement cross-verification logic here
  // For now, return placeholder
  return {
    consistent: true,
    discrepancies: [],
    confidence: 0.8,
  }
}

// -----------------------------------------------------------------------------
// Server Setup
// -----------------------------------------------------------------------------

const app = Fastify({ logger: false })

await app.register(cors, { origin: true })

// Health check
app.get("/health", async () => ({
  status: "healthy",
  sources: {
    wikipedia: true,
    brave: !!env.BRAVE_API_KEY,
    llm: !!env.OPENAI_API_KEY,
  },
}))

// Verify claim
app.post("/verify", async (request, _reply) => {
  const body = VerifyClaimSchema.parse(request.body)

  logger.info({ claim: body.claim }, "Verification request received")

  const result = await verifyClaim(body)

  logger.info(
    {
      verificationId: result.verification_id,
      status: result.status,
      confidence: result.confidence,
    },
    "Verification completed"
  )

  return result
})

// Get verification result
app.get("/verifications/:id", async (request, reply) => {
  const { id } = request.params as { id: string }

  const result = await pool.query(
    "SELECT * FROM grounding_verifications WHERE verification_id = $1",
    [id]
  )

  if (result.rows.length === 0) {
    reply.code(404)
    return { error: "Verification not found" }
  }

  return result.rows[0]
})

// Cross-verify tool output
app.post("/cross-verify", async (request, _reply) => {
  const body = z
    .object({
      tool_name: z.string(),
      output: z.unknown(),
      expected_behavior: z.string(),
    })
    .parse(request.body)

  const result = await crossVerifyToolOutput(body.tool_name, body.output, body.expected_behavior)
  return result
})

// -----------------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------------

async function main() {
  logger.info({ port: env.PORT }, "Starting Grounding Service")

  // Check database
  try {
    await pool.query("SELECT 1")
    logger.info("Database connection verified")
  } catch (err) {
    logger.error({ err }, "Database connection failed")
    process.exit(1)
  }

  await app.listen({ port: env.PORT, host: env.HOST })
  logger.info({ port: env.PORT }, "Grounding Service started")

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...")
    await pool.end()
    await app.close()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  logger.error({ err }, "Fatal error")
  process.exit(1)
})
