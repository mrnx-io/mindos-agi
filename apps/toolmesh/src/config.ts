// =============================================================================
// MindOS - ToolMesh Configuration
// =============================================================================

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

// -----------------------------------------------------------------------------
// Environment Schema
// -----------------------------------------------------------------------------

const EnvSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Embeddings
  OPENAI_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-large"),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(3072),

  // Server
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),

  // Auth
  TOOLMESH_TOKEN: z.string().optional(),

  // MCP
  MCP_SERVERS_PATH: z.string().default("./mcp.servers.json"),

  // Retry
  DEFAULT_RETRY_BUDGET: z.coerce.number().default(3),
  DEFAULT_RETRY_DELAY_MS: z.coerce.number().default(1000),
  MAX_RETRY_DELAY_MS: z.coerce.number().default(30000),

  // Logging
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
})

export type Env = z.infer<typeof EnvSchema>

function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env)
  if (!result.success) {
    console.error("Invalid environment configuration:")
    console.error(result.error.format())
    process.exit(1)
  }
  return result.data
}

export const env = loadEnv()

// -----------------------------------------------------------------------------
// MCP Server Configuration
// -----------------------------------------------------------------------------

export interface McpServerConfig {
  name: string
  description: string
  transport: "stdio" | "sse" | "streamable-http"
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  tools?: string[] // Explicit tool list, or discover dynamically
  enabled: boolean
  retryBudget?: number
}

export function loadMcpServers(): McpServerConfig[] {
  const configPath = env.MCP_SERVERS_PATH
  const absolutePath = configPath.startsWith("/") ? configPath : join(process.cwd(), configPath)

  if (!existsSync(absolutePath)) {
    console.warn(`MCP servers config not found at ${absolutePath}, using empty list`)
    return []
  }

  try {
    const content = readFileSync(absolutePath, "utf-8")
    const config = JSON.parse(content)

    // Expand environment variables in the config
    return expandEnvVars(config.servers || [])
  } catch (err) {
    console.error(`Failed to load MCP servers config: ${err}`)
    return []
  }
}

function expandEnvVars(servers: McpServerConfig[]): McpServerConfig[] {
  return servers.map((server) => {
    const command = expandString(server.command)
    const args = server.args?.map((arg) => expandString(arg) ?? "")
    const url = expandString(server.url)
    const envVars = server.env
      ? Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, expandString(v) ?? ""]))
      : undefined

    return {
      ...server,
      ...(command ? { command } : {}),
      ...(args ? { args } : {}),
      ...(url ? { url } : {}),
      ...(envVars ? { env: envVars } : {}),
    }
  })
}

function expandString(value?: string): string | undefined {
  if (!value) return value

  return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    return process.env[key] ?? ""
  })
}
