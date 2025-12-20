// =============================================================================
// MindOS - Drift Monitor Service (Model Quality Monitoring)
// =============================================================================

import cors from "@fastify/cors"
import { CronJob } from "cron"
import Fastify from "fastify"
import OpenAI from "openai"
import pg from "pg"
import pino from "pino"
import { z } from "zod"

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const env = {
  PORT: Number.parseInt(process.env.PORT ?? "3004"),
  HOST: process.env.HOST ?? "0.0.0.0",
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  DATABASE_SSL: process.env.DATABASE_SSL === "true",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  PROBE_INTERVAL_MINUTES: Number.parseInt(process.env.PROBE_INTERVAL_MINUTES ?? "15"),
  QUALITY_THRESHOLD: Number.parseFloat(process.env.QUALITY_THRESHOLD ?? "0.85"),
  ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL ?? "",
  MONITORED_MODELS: (
    process.env.DRIFT_MONITORED_MODELS ??
    "gpt-5.2,gpt-5.2-mini,claude-opus-4-5-20251101,gemini-3-pro"
  ).split(","),
}

const devTransport =
  process.env.NODE_ENV !== "production"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined

const logger = pino({
  level: env.LOG_LEVEL,
  ...(devTransport ? { transport: devTransport } : {}),
})

// -----------------------------------------------------------------------------
// Database
// -----------------------------------------------------------------------------

const { Pool } = pg
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
})

// -----------------------------------------------------------------------------
// OpenAI Client
// -----------------------------------------------------------------------------

const openai = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface ModelFingerprint {
  model_id: string
  version: string
  capabilities: Record<string, number>
  response_patterns: ResponsePattern[]
  quality_baseline: number
  created_at: string
}

interface ResponsePattern {
  task_type: string
  avg_latency_ms: number
  avg_tokens: number
  format_consistency: number
  instruction_following: number
}

interface QualityProbe {
  probe_id: string
  model_id: string
  probe_type: "capability" | "consistency" | "instruction" | "format"
  prompt: string
  expected_patterns: string[]
  scoring_criteria: string
}

interface ProbeResult {
  probe_id: string
  model_id: string
  score: number
  latency_ms: number
  response_tokens: number
  response_preview: string
  anomalies: string[]
  created_at: string
}

interface DriftAlert {
  alert_id: string
  model_id: string
  alert_type: "quality_degradation" | "capability_regression" | "api_change" | "latency_spike"
  severity: "low" | "medium" | "high" | "critical"
  description: string
  current_value: number
  baseline_value: number
  deviation_percent: number
  created_at: string
}

// -----------------------------------------------------------------------------
// Quality Probes
// -----------------------------------------------------------------------------

const STANDARD_PROBES: Omit<QualityProbe, "probe_id">[] = [
  {
    model_id: "*",
    probe_type: "capability",
    prompt: "What is 347 * 892? Show your work step by step, then give the final answer.",
    expected_patterns: ["309,524", "309524"],
    scoring_criteria: "Correct final answer with clear reasoning steps",
  },
  {
    model_id: "*",
    probe_type: "instruction",
    prompt:
      "Write exactly 3 bullet points about the benefits of exercise. Each bullet must start with a verb.",
    expected_patterns: ["•", "-", "*"],
    scoring_criteria: "Exactly 3 bullets, each starting with a verb",
  },
  {
    model_id: "*",
    probe_type: "format",
    prompt: 'Output a JSON object with keys "name", "age", and "city". Use realistic values.',
    expected_patterns: ['"name"', '"age"', '"city"', "{", "}"],
    scoring_criteria: "Valid JSON with all required keys",
  },
  {
    model_id: "*",
    probe_type: "consistency",
    prompt: "Explain photosynthesis in exactly one sentence.",
    expected_patterns: ["light", "plant", "energy", "glucose", "oxygen"],
    scoring_criteria: "Single sentence containing key concepts",
  },
  {
    model_id: "*",
    probe_type: "capability",
    prompt: "Translate 'The quick brown fox jumps over the lazy dog' to French.",
    expected_patterns: ["Le", "rapide", "renard", "brun", "saute", "chien", "paresseux"],
    scoring_criteria: "Accurate French translation",
  },
]

// -----------------------------------------------------------------------------
// Drift Detection Logic
// -----------------------------------------------------------------------------

async function runProbe(probe: QualityProbe, modelId: string): Promise<ProbeResult> {
  const startTime = performance.now()

  if (!openai) {
    return {
      probe_id: probe.probe_id,
      model_id: modelId,
      score: 0,
      latency_ms: 0,
      response_tokens: 0,
      response_preview: "OpenAI client not configured",
      anomalies: ["no_client"],
      created_at: new Date().toISOString(),
    }
  }

  try {
    const response = await openai.chat.completions.create({
      model: modelId,
      messages: [{ role: "user", content: probe.prompt }],
      temperature: 0.1,
      max_tokens: 500,
    })

    const latency = performance.now() - startTime
    const content = response.choices[0]?.message?.content ?? ""
    const tokens = response.usage?.completion_tokens ?? 0

    // Score based on expected patterns
    const patternMatches = probe.expected_patterns.filter((p) =>
      content.toLowerCase().includes(p.toLowerCase())
    ).length
    const patternScore = patternMatches / probe.expected_patterns.length

    // Detect anomalies
    const anomalies: string[] = []
    if (latency > 5000) anomalies.push("high_latency")
    if (tokens < 10) anomalies.push("low_tokens")
    if (content.includes("I cannot") || content.includes("I'm unable")) {
      anomalies.push("refusal_detected")
    }
    if (patternScore < 0.5) anomalies.push("pattern_mismatch")

    return {
      probe_id: probe.probe_id,
      model_id: modelId,
      score: patternScore,
      latency_ms: Math.round(latency),
      response_tokens: tokens,
      response_preview: content.slice(0, 200),
      anomalies,
      created_at: new Date().toISOString(),
    }
  } catch (err) {
    const latency = performance.now() - startTime
    return {
      probe_id: probe.probe_id,
      model_id: modelId,
      score: 0,
      latency_ms: Math.round(latency),
      response_tokens: 0,
      response_preview: err instanceof Error ? err.message : "Unknown error",
      anomalies: ["api_error"],
      created_at: new Date().toISOString(),
    }
  }
}

async function getBaseline(modelId: string): Promise<ModelFingerprint | null> {
  const result = await pool.query(
    "SELECT * FROM model_fingerprints WHERE model_id = $1 ORDER BY created_at DESC LIMIT 1",
    [modelId]
  )
  return result.rows[0] ?? null
}

async function storeProbeResult(result: ProbeResult): Promise<void> {
  await pool.query(
    `INSERT INTO model_probe_results (
      probe_id, model_id, score, latency_ms, response_tokens, response_preview, anomalies, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      result.probe_id,
      result.model_id,
      result.score,
      result.latency_ms,
      result.response_tokens,
      result.response_preview,
      JSON.stringify(result.anomalies),
      result.created_at,
    ]
  )
}

async function checkForDrift(
  modelId: string,
  results: ProbeResult[],
  baseline: ModelFingerprint | null
): Promise<DriftAlert[]> {
  const alerts: DriftAlert[] = []

  // Calculate current metrics
  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length
  const avgLatency = results.reduce((sum, r) => sum + r.latency_ms, 0) / results.length
  const anomalyCount = results.reduce((sum, r) => sum + r.anomalies.length, 0)

  if (!baseline) {
    // Create initial baseline
    await createBaseline(modelId, avgScore, avgLatency, results)
    return alerts
  }

  // Check quality degradation
  const qualityDeviation = (baseline.quality_baseline - avgScore) / baseline.quality_baseline
  if (qualityDeviation > 0.1) {
    alerts.push({
      alert_id: crypto.randomUUID(),
      model_id: modelId,
      alert_type: "quality_degradation",
      severity: qualityDeviation > 0.3 ? "critical" : qualityDeviation > 0.2 ? "high" : "medium",
      description: `Quality score dropped from ${(baseline.quality_baseline * 100).toFixed(1)}% to ${(avgScore * 100).toFixed(1)}%`,
      current_value: avgScore,
      baseline_value: baseline.quality_baseline,
      deviation_percent: qualityDeviation * 100,
      created_at: new Date().toISOString(),
    })
  }

  // Check latency spike
  const baselineLatency = baseline.response_patterns[0]?.avg_latency_ms ?? 1000
  const latencyDeviation = (avgLatency - baselineLatency) / baselineLatency
  if (latencyDeviation > 0.5) {
    alerts.push({
      alert_id: crypto.randomUUID(),
      model_id: modelId,
      alert_type: "latency_spike",
      severity: latencyDeviation > 1.0 ? "high" : "medium",
      description: `Latency increased from ${baselineLatency}ms to ${avgLatency.toFixed(0)}ms`,
      current_value: avgLatency,
      baseline_value: baselineLatency,
      deviation_percent: latencyDeviation * 100,
      created_at: new Date().toISOString(),
    })
  }

  // Check for API changes (high anomaly rate)
  if (anomalyCount > results.length * 0.3) {
    const apiChangeAnomalies = results.flatMap((r) =>
      r.anomalies.filter((a) => a === "api_error" || a === "refusal_detected")
    )
    if (apiChangeAnomalies.length > 0) {
      alerts.push({
        alert_id: crypto.randomUUID(),
        model_id: modelId,
        alert_type: "api_change",
        severity: "high",
        description: `Detected ${apiChangeAnomalies.length} API-related anomalies`,
        current_value: apiChangeAnomalies.length,
        baseline_value: 0,
        deviation_percent: 100,
        created_at: new Date().toISOString(),
      })
    }
  }

  // Store alerts
  for (const alert of alerts) {
    await storeAlert(alert)
    await sendAlertNotification(alert)
  }

  return alerts
}

async function createBaseline(
  modelId: string,
  qualityScore: number,
  avgLatency: number,
  results: ProbeResult[]
): Promise<void> {
  const fingerprint: ModelFingerprint = {
    model_id: modelId,
    version: new Date().toISOString().slice(0, 10),
    capabilities: {
      math: results.find((r) => r.probe_id.includes("capability"))?.score ?? 0,
      instruction_following: results.find((r) => r.probe_id.includes("instruction"))?.score ?? 0,
      format_compliance: results.find((r) => r.probe_id.includes("format"))?.score ?? 0,
      consistency: results.find((r) => r.probe_id.includes("consistency"))?.score ?? 0,
    },
    response_patterns: [
      {
        task_type: "general",
        avg_latency_ms: avgLatency,
        avg_tokens: results.reduce((sum, r) => sum + r.response_tokens, 0) / results.length,
        format_consistency: 0.9,
        instruction_following: 0.9,
      },
    ],
    quality_baseline: qualityScore,
    created_at: new Date().toISOString(),
  }

  await pool.query(
    `INSERT INTO model_fingerprints (
      model_id, version, capabilities, response_patterns, quality_baseline, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      fingerprint.model_id,
      fingerprint.version,
      JSON.stringify(fingerprint.capabilities),
      JSON.stringify(fingerprint.response_patterns),
      fingerprint.quality_baseline,
      fingerprint.created_at,
    ]
  )

  logger.info({ modelId, qualityScore }, "Created baseline fingerprint")
}

async function storeAlert(alert: DriftAlert): Promise<void> {
  await pool.query(
    `INSERT INTO drift_alerts (
      alert_id, model_id, alert_type, severity, description,
      current_value, baseline_value, deviation_percent, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      alert.alert_id,
      alert.model_id,
      alert.alert_type,
      alert.severity,
      alert.description,
      alert.current_value,
      alert.baseline_value,
      alert.deviation_percent,
      alert.created_at,
    ]
  )
}

async function sendAlertNotification(alert: DriftAlert): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL) return

  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `🚨 MindOS Drift Alert: ${alert.alert_type}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Model:* ${alert.model_id}\n*Type:* ${alert.alert_type}\n*Severity:* ${alert.severity}\n*Description:* ${alert.description}`,
            },
          },
        ],
      }),
    })
  } catch (err) {
    logger.error({ err, alertId: alert.alert_id }, "Failed to send alert notification")
  }
}

// -----------------------------------------------------------------------------
// Scheduled Probing
// -----------------------------------------------------------------------------

const MONITORED_MODELS = env.MONITORED_MODELS

async function runScheduledProbes(): Promise<void> {
  logger.info("Running scheduled model probes")

  for (const modelId of MONITORED_MODELS) {
    const probes = STANDARD_PROBES.map((p, i) => ({
      ...p,
      probe_id: `probe-${modelId}-${p.probe_type}-${i}`,
      model_id: modelId,
    }))

    const results: ProbeResult[] = []
    for (const probe of probes) {
      const result = await runProbe(probe, modelId)
      results.push(result)
      await storeProbeResult(result)
    }

    const baseline = await getBaseline(modelId)
    const alerts = await checkForDrift(modelId, results, baseline)

    logger.info(
      {
        modelId,
        avgScore: results.reduce((s, r) => s + r.score, 0) / results.length,
        alerts: alerts.length,
      },
      "Completed probes for model"
    )
  }
}

// -----------------------------------------------------------------------------
// Request Schemas
// -----------------------------------------------------------------------------

const RunProbeSchema = z.object({
  model_id: z.string(),
  probes: z.array(z.enum(["capability", "consistency", "instruction", "format"])).optional(),
})

const GetAlertsSchema = z.object({
  model_id: z.string().optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  since: z.string().datetime().optional(),
})

// -----------------------------------------------------------------------------
// Server Setup
// -----------------------------------------------------------------------------

const app = Fastify({ logger: false })

await app.register(cors, { origin: true })

// Health check
app.get("/health", async () => ({
  status: "healthy",
  monitored_models: MONITORED_MODELS,
  probe_interval_minutes: env.PROBE_INTERVAL_MINUTES,
  quality_threshold: env.QUALITY_THRESHOLD,
}))

// Run probes for a specific model
app.post("/probe", async (request, _reply) => {
  const body = RunProbeSchema.parse(request.body)

  const probeTypes = body.probes ?? ["capability", "consistency", "instruction", "format"]
  const probes = STANDARD_PROBES.filter((p) => probeTypes.includes(p.probe_type)).map((p, i) => ({
    ...p,
    probe_id: `probe-${body.model_id}-${p.probe_type}-${i}`,
    model_id: body.model_id,
  }))

  const results: ProbeResult[] = []
  for (const probe of probes) {
    const result = await runProbe(probe, body.model_id)
    results.push(result)
    await storeProbeResult(result)
  }

  const baseline = await getBaseline(body.model_id)
  const alerts = await checkForDrift(body.model_id, results, baseline)

  return {
    model_id: body.model_id,
    results,
    alerts,
    summary: {
      avg_score: results.reduce((s, r) => s + r.score, 0) / results.length,
      avg_latency_ms: results.reduce((s, r) => s + r.latency_ms, 0) / results.length,
      total_anomalies: results.reduce((s, r) => s + r.anomalies.length, 0),
    },
  }
})

// Get alerts
app.get("/alerts", async (request, _reply) => {
  const query = GetAlertsSchema.parse(request.query)

  let sql = "SELECT * FROM drift_alerts WHERE 1=1"
  const params: unknown[] = []

  if (query.model_id) {
    params.push(query.model_id)
    sql += ` AND model_id = $${params.length}`
  }

  if (query.severity) {
    params.push(query.severity)
    sql += ` AND severity = $${params.length}`
  }

  if (query.since) {
    params.push(query.since)
    sql += ` AND created_at >= $${params.length}`
  }

  sql += " ORDER BY created_at DESC LIMIT 100"

  const result = await pool.query(sql, params)
  return { alerts: result.rows }
})

// Get model fingerprint
app.get("/fingerprints/:modelId", async (request, reply) => {
  const { modelId } = request.params as { modelId: string }

  const baseline = await getBaseline(modelId)

  if (!baseline) {
    reply.code(404)
    return { error: "No fingerprint found for model" }
  }

  return baseline
})

// Get probe history
app.get("/probes/:modelId", async (request, _reply) => {
  const { modelId } = request.params as { modelId: string }
  const limit = Number.parseInt((request.query as Record<string, string>).limit ?? "50")

  const result = await pool.query(
    "SELECT * FROM model_probe_results WHERE model_id = $1 ORDER BY created_at DESC LIMIT $2",
    [modelId, limit]
  )

  return { probes: result.rows }
})

// Model comparison
app.get("/compare", async (_request, _reply) => {
  const fingerprints: Record<string, ModelFingerprint | null> = {}

  for (const modelId of MONITORED_MODELS) {
    fingerprints[modelId] = await getBaseline(modelId)
  }

  // Get recent alert counts
  const alertCounts = await pool.query(`
    SELECT model_id, COUNT(*) as alert_count
    FROM drift_alerts
    WHERE created_at > NOW() - INTERVAL '24 hours'
    GROUP BY model_id
  `)

  const alertMap = Object.fromEntries(
    alertCounts.rows.map((r: { model_id: string; alert_count: string }) => [
      r.model_id,
      Number.parseInt(r.alert_count),
    ])
  )

  return {
    models: MONITORED_MODELS.map((id) => ({
      model_id: id,
      fingerprint: fingerprints[id],
      recent_alerts: alertMap[id] ?? 0,
      status:
        (fingerprints[id]?.quality_baseline ?? 0) >= env.QUALITY_THRESHOLD ? "healthy" : "degraded",
    })),
  }
})

// Trigger baseline refresh
app.post("/refresh-baseline/:modelId", async (request, _reply) => {
  const { modelId } = request.params as { modelId: string }

  // Delete existing baseline
  await pool.query("DELETE FROM model_fingerprints WHERE model_id = $1", [modelId])

  // Run probes to create new baseline
  const probes = STANDARD_PROBES.map((p, i) => ({
    ...p,
    probe_id: `probe-${modelId}-${p.probe_type}-${i}`,
    model_id: modelId,
  }))

  const results: ProbeResult[] = []
  for (const probe of probes) {
    const result = await runProbe(probe, modelId)
    results.push(result)
    await storeProbeResult(result)
  }

  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length
  const avgLatency = results.reduce((sum, r) => sum + r.latency_ms, 0) / results.length

  await createBaseline(modelId, avgScore, avgLatency, results)

  const newBaseline = await getBaseline(modelId)
  return { message: "Baseline refreshed", fingerprint: newBaseline }
})

// -----------------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------------

async function main() {
  logger.info({ port: env.PORT }, "Starting Drift Monitor Service")

  // Check database
  try {
    await pool.query("SELECT 1")
    logger.info("Database connection verified")
  } catch (err) {
    logger.error({ err }, "Database connection failed")
    process.exit(1)
  }

  // Ensure tables exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_fingerprints (
      id SERIAL PRIMARY KEY,
      model_id TEXT NOT NULL,
      version TEXT NOT NULL,
      capabilities JSONB NOT NULL,
      response_patterns JSONB NOT NULL,
      quality_baseline REAL NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_probe_results (
      id SERIAL PRIMARY KEY,
      probe_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      score REAL NOT NULL,
      latency_ms INTEGER NOT NULL,
      response_tokens INTEGER NOT NULL,
      response_preview TEXT,
      anomalies JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drift_alerts (
      id SERIAL PRIMARY KEY,
      alert_id TEXT UNIQUE NOT NULL,
      model_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      description TEXT NOT NULL,
      current_value REAL NOT NULL,
      baseline_value REAL NOT NULL,
      deviation_percent REAL NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_fingerprints_model ON model_fingerprints(model_id);
    CREATE INDEX IF NOT EXISTS idx_probes_model ON model_probe_results(model_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_model ON drift_alerts(model_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_severity ON drift_alerts(severity);
  `)

  // Start scheduled probing
  if (env.PROBE_INTERVAL_MINUTES > 0) {
    const cronPattern = `*/${env.PROBE_INTERVAL_MINUTES} * * * *`
    const probeJob = new CronJob(cronPattern, runScheduledProbes)
    probeJob.start()
    logger.info({ interval: env.PROBE_INTERVAL_MINUTES }, "Scheduled probing started")
  }

  await app.listen({ port: env.PORT, host: env.HOST })
  logger.info({ port: env.PORT }, "Drift Monitor Service started")

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
