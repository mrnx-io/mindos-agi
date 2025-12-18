// =============================================================================
// MindOS - ToolMesh Database
// =============================================================================

import pg from "pg"
import { env } from "./config.js"
import { logger } from "./logger.js"

const { Pool } = pg

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
})

pool.on("error", (err) => {
  logger.error({ err }, "Database pool error")
})

export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params)
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

export async function checkHealth(): Promise<boolean> {
  try {
    await query("SELECT 1")
    return true
  } catch {
    return false
  }
}

export async function closePool(): Promise<void> {
  await pool.end()
}
