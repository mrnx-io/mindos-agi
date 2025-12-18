// =============================================================================
// MindOS - MCP Hub (Server Connection Manager)
// =============================================================================

import { type ChildProcess, spawn } from "node:child_process"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { type McpServerConfig, loadMcpServers } from "../config.js"
import { createLogger } from "../logger.js"
import { deleteTool, registerTool } from "../registry/toolRegistry.js"

const log = createLogger("mcp-hub")

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface McpConnection {
  config: McpServerConfig
  client: Client
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport
  process?: ChildProcess
  healthy: boolean
  lastHealthCheck: number
  tools: string[]
}

interface ToolCallResult {
  success: boolean
  output: unknown
  error?: string
  isError?: boolean
}

// -----------------------------------------------------------------------------
// Hub State
// -----------------------------------------------------------------------------

const connections = new Map<string, McpConnection>()
let initialized = false

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

export async function initializeHub(): Promise<void> {
  if (initialized) return

  const configs = loadMcpServers()
  log.info({ serverCount: configs.length }, "Initializing MCP Hub")

  for (const config of configs) {
    if (!config.enabled) {
      log.debug({ server: config.name }, "Server disabled, skipping")
      continue
    }

    try {
      await connectServer(config)
    } catch (err) {
      log.error({ server: config.name, error: err }, "Failed to connect to MCP server")
    }
  }

  initialized = true
  log.info({ connectedServers: connections.size }, "MCP Hub initialized")
}

// -----------------------------------------------------------------------------
// Server Connection
// -----------------------------------------------------------------------------

async function connectServer(config: McpServerConfig): Promise<void> {
  log.info({ server: config.name, transport: config.transport }, "Connecting to MCP server")

  const client = new Client({
    name: "mindos-toolmesh",
    version: "0.1.0",
  })

  let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport
  let childProcess: ChildProcess | undefined

  switch (config.transport) {
    case "stdio": {
      if (!config.command) {
        throw new Error(`stdio transport requires command for server ${config.name}`)
      }

      childProcess = spawn(config.command, config.args ?? [], {
        env: { ...process.env, ...config.env },
        stdio: ["pipe", "pipe", "pipe"],
      })

      childProcess.on("error", (err) => {
        log.error({ server: config.name, error: err }, "MCP process error")
        markUnhealthy(config.name)
      })

      childProcess.on("exit", (code) => {
        log.warn({ server: config.name, code }, "MCP process exited")
        markUnhealthy(config.name)
      })

      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      })
      break
    }

    case "sse": {
      if (!config.url) {
        throw new Error(`sse transport requires url for server ${config.name}`)
      }
      transport = new SSEClientTransport(new URL(config.url))
      break
    }

    case "streamable-http": {
      if (!config.url) {
        throw new Error(`streamable-http transport requires url for server ${config.name}`)
      }
      transport = new StreamableHTTPClientTransport(new URL(config.url))
      break
    }

    default:
      throw new Error(`Unknown transport: ${config.transport}`)
  }

  await client.connect(transport)

  // Discover tools
  const toolsResult = await client.listTools()
  const tools = toolsResult.tools.map((t) => t.name)

  log.info({ server: config.name, tools: tools.length }, "Connected and discovered tools")

  // Register tools in registry
  for (const tool of toolsResult.tools) {
    await registerTool({
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema as Record<string, unknown>,
      serverName: config.name,
    })
  }

  // Store connection
  connections.set(config.name, {
    config,
    client,
    transport,
    process: childProcess,
    healthy: true,
    lastHealthCheck: Date.now(),
    tools,
  })
}

// -----------------------------------------------------------------------------
// Tool Execution
// -----------------------------------------------------------------------------

export async function callTool(
  toolName: string,
  parameters: Record<string, unknown>
): Promise<ToolCallResult> {
  // Find which server has this tool
  const connection = findToolServer(toolName)

  if (!connection) {
    return {
      success: false,
      output: null,
      error: `Tool not found: ${toolName}`,
    }
  }

  if (!connection.healthy) {
    return {
      success: false,
      output: null,
      error: `Server ${connection.config.name} is unhealthy`,
    }
  }

  try {
    const result = await connection.client.callTool({
      name: toolName,
      arguments: parameters,
    })

    // Check if result indicates error
    const isError = result.isError ?? false

    return {
      success: !isError,
      output: result.content,
      isError,
      error: isError ? extractErrorMessage(result.content) : undefined,
    }
  } catch (err) {
    log.error({ tool: toolName, server: connection.config.name, error: err }, "Tool call failed")
    return {
      success: false,
      output: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function findToolServer(toolName: string): McpConnection | null {
  for (const connection of connections.values()) {
    if (connection.tools.includes(toolName)) {
      return connection
    }
  }
  return null
}

function extractErrorMessage(content: unknown): string {
  if (Array.isArray(content)) {
    const textContent = content.find(
      (c: unknown) =>
        typeof c === "object" &&
        c !== null &&
        "type" in c &&
        (c as Record<string, unknown>).type === "text"
    )
    if (textContent && typeof textContent === "object" && "text" in textContent) {
      return String((textContent as Record<string, unknown>).text)
    }
  }
  return "Unknown error"
}

// -----------------------------------------------------------------------------
// Health Management
// -----------------------------------------------------------------------------

function markUnhealthy(serverName: string): void {
  const connection = connections.get(serverName)
  if (connection) {
    connection.healthy = false
  }
}

export async function checkHealth(serverName: string): Promise<boolean> {
  const connection = connections.get(serverName)
  if (!connection) {
    return false
  }

  try {
    // Try to list tools as health check
    await connection.client.listTools()
    connection.healthy = true
    connection.lastHealthCheck = Date.now()
    return true
  } catch {
    connection.healthy = false
    return false
  }
}

export async function checkAllHealth(): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {}

  for (const [name] of connections) {
    results[name] = await checkHealth(name)
  }

  return results
}

// -----------------------------------------------------------------------------
// Reconnection
// -----------------------------------------------------------------------------

export async function reconnectServer(serverName: string): Promise<boolean> {
  const connection = connections.get(serverName)
  if (!connection) {
    return false
  }

  try {
    // Disconnect existing
    await disconnectServer(serverName)

    // Reconnect
    await connectServer(connection.config)
    return true
  } catch (err) {
    log.error({ server: serverName, error: err }, "Failed to reconnect server")
    return false
  }
}

async function disconnectServer(serverName: string): Promise<void> {
  const connection = connections.get(serverName)
  if (!connection) return

  try {
    await connection.client.close()
    connection.process?.kill()
  } catch {
    // Ignore disconnect errors
  }

  // Remove tools from registry
  for (const toolName of connection.tools) {
    await deleteTool(toolName)
  }

  connections.delete(serverName)
}

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

export function getHubStatus(): {
  initialized: boolean
  servers: Array<{
    name: string
    transport: string
    healthy: boolean
    tools: number
    lastHealthCheck: number
  }>
} {
  return {
    initialized,
    servers: Array.from(connections.values()).map((c) => ({
      name: c.config.name,
      transport: c.config.transport,
      healthy: c.healthy,
      tools: c.tools.length,
      lastHealthCheck: c.lastHealthCheck,
    })),
  }
}

// -----------------------------------------------------------------------------
// Shutdown
// -----------------------------------------------------------------------------

export async function shutdownHub(): Promise<void> {
  log.info("Shutting down MCP Hub")

  for (const [name] of connections) {
    await disconnectServer(name)
  }

  initialized = false
  log.info("MCP Hub shutdown complete")
}
