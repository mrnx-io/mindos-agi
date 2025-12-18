// =============================================================================
// MindOS - Database Connection
// =============================================================================

import pg from "pg"
import { env } from "./config.js"
import { logger } from "./logger.js"

const { Pool } = pg

// -----------------------------------------------------------------------------
// Connection Pool
// -----------------------------------------------------------------------------

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
})

pool.on("error", (err) => {
  logger.error({ err }, "Unexpected database pool error")
})

pool.on("connect", () => {
  logger.debug("New database connection established")
})

// -----------------------------------------------------------------------------
// Transaction Helper
// -----------------------------------------------------------------------------

export type TransactionClient = pg.PoolClient

export async function withTransaction<T>(
  fn: (client: TransactionClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

// -----------------------------------------------------------------------------
// Query Helpers
// -----------------------------------------------------------------------------

export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now()
  const result = await pool.query<T>(text, params)
  const duration = Date.now() - start
  logger.debug({ query: text, duration, rows: result.rowCount }, "Executed query")
  return result
}

export async function queryOne<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const result = await query<T>(text, params)
  return result.rows[0] ?? null
}

export async function queryAll<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await query<T>(text, params)
  return result.rows
}

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await query("SELECT 1")
    return true
  } catch {
    return false
  }
}

// -----------------------------------------------------------------------------
// Graceful Shutdown
// -----------------------------------------------------------------------------

export async function closeDatabasePool(): Promise<void> {
  logger.info("Closing database pool...")
  await pool.end()
  logger.info("Database pool closed")
}

// Handle process termination
process.on("SIGINT", async () => {
  await closeDatabasePool()
  process.exit(0)
})

process.on("SIGTERM", async () => {
  await closeDatabasePool()
  process.exit(0)
})
