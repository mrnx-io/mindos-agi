// =============================================================================
// Hard Stop Pattern Engine
// =============================================================================

import type pg from "pg"
import type { HardStopPattern, HardStopResult, RiskCategory } from "./types.js"

// -----------------------------------------------------------------------------
// Hard Stop Engine Interface
// -----------------------------------------------------------------------------

export interface HardStopEngine {
  check(input: HardStopInput): Promise<HardStopResult>
  addPattern(pattern: Omit<HardStopPattern, "pattern_id">): Promise<HardStopPattern>
  removePattern(patternId: string): Promise<void>
  getPatterns(category?: RiskCategory): Promise<HardStopPattern[]>
  enablePattern(patternId: string): Promise<void>
  disablePattern(patternId: string): Promise<void>
}

export interface HardStopInput {
  action_type: string
  action_details: Record<string, unknown>
  code?: string
  command?: string
  target?: string
}

// -----------------------------------------------------------------------------
// Default Hard Stop Patterns
// -----------------------------------------------------------------------------

const DEFAULT_PATTERNS: Omit<HardStopPattern, "pattern_id">[] = [
  // Dangerous file operations
  {
    name: "recursive_delete",
    description: "Blocks recursive deletion commands",
    pattern_type: "regex",
    pattern: "rm\\s+-rf?\\s+(/|~|\\$HOME|\\*)",
    categories: ["system_modification", "security"],
    severity: "block",
    enabled: true,
  },
  {
    name: "system_directories",
    description: "Blocks operations on system directories",
    pattern_type: "regex",
    pattern: "(/etc/|/var/|/usr/|/boot/|/sys/|/proc/)",
    categories: ["system_modification", "security"],
    severity: "block",
    enabled: true,
  },
  // Credential exposure
  {
    name: "credential_keywords",
    description: "Warns on potential credential exposure",
    pattern_type: "keyword",
    pattern: "password,secret,api_key,private_key,access_token,bearer",
    categories: ["security", "data_access"],
    severity: "warn",
    enabled: true,
  },
  // Network dangers
  {
    name: "dangerous_ports",
    description: "Blocks binding to sensitive ports",
    pattern_type: "regex",
    pattern: "listen.*(:22|:23|:25|:53|:137|:445|:3389)",
    categories: ["security", "external_communication"],
    severity: "block",
    enabled: true,
  },
  // SQL injection patterns
  {
    name: "sql_injection",
    description: "Blocks potential SQL injection patterns",
    pattern_type: "regex",
    pattern: "(;\\s*DROP|;\\s*DELETE|;\\s*UPDATE|;\\s*INSERT|'\\s*OR\\s*'|\"\\s*OR\\s*\")",
    categories: ["security", "data_access"],
    severity: "block",
    enabled: true,
  },
  // Shell injection
  {
    name: "shell_injection",
    description: "Blocks shell injection patterns",
    pattern_type: "regex",
    pattern: "(\\$\\(|`.*`|\\|\\s*sh|\\|\\s*bash|&&\\s*rm|;\\s*rm)",
    categories: ["security", "system_modification"],
    severity: "block",
    enabled: true,
  },
  // Privilege escalation
  {
    name: "privilege_escalation",
    description: "Warns on privilege escalation attempts",
    pattern_type: "keyword",
    pattern: "sudo,su -,chmod 777,setuid,setgid",
    categories: ["security", "system_modification"],
    severity: "warn",
    enabled: true,
  },
  // Data exfiltration
  {
    name: "data_exfiltration",
    description: "Warns on potential data exfiltration",
    pattern_type: "regex",
    pattern: "(curl|wget|nc|netcat).*\\|.*(base64|gzip|tar)",
    categories: ["security", "external_communication"],
    severity: "warn",
    enabled: true,
  },
  // Crypto operations
  {
    name: "crypto_wallet",
    description: "Audits cryptocurrency-related operations",
    pattern_type: "keyword",
    pattern: "wallet,bitcoin,ethereum,private_key,seed_phrase,mnemonic",
    categories: ["financial", "security"],
    severity: "audit",
    enabled: true,
  },
  // Mass operations
  {
    name: "mass_operations",
    description: "Warns on mass data operations",
    pattern_type: "regex",
    pattern: "(DELETE\\s+FROM\\s+\\w+\\s*$|UPDATE\\s+\\w+\\s+SET.*WHERE\\s+1\\s*=\\s*1|TRUNCATE)",
    categories: ["data_access", "system_modification"],
    severity: "warn",
    enabled: true,
  },
]

// -----------------------------------------------------------------------------
// Create Hard Stop Engine
// -----------------------------------------------------------------------------

export function createHardStopEngine(pool: pg.Pool): HardStopEngine {
  // Initialize default patterns on creation
  initializeDefaultPatterns(pool).catch(console.error)

  async function check(input: HardStopInput): Promise<HardStopResult> {
    const patterns = await getPatterns()
    const enabledPatterns = patterns.filter((p) => p.enabled)

    const triggeredPatterns: string[] = []
    const warnings: string[] = []
    const auditLog: string[] = []

    // Build content to check
    const contentToCheck = [
      input.action_type,
      JSON.stringify(input.action_details),
      input.code ?? "",
      input.command ?? "",
      input.target ?? "",
    ].join(" ")

    for (const pattern of enabledPatterns) {
      const matched = matchPattern(pattern, contentToCheck)

      if (matched) {
        switch (pattern.severity) {
          case "block":
            triggeredPatterns.push(pattern.name)
            break
          case "warn":
            warnings.push(`${pattern.name}: ${pattern.description}`)
            break
          case "audit":
            auditLog.push(`${pattern.name}: ${pattern.description}`)
            break
        }
      }
    }

    // Log audit entries
    if (auditLog.length > 0) {
      await pool.query(
        `INSERT INTO hardstop_audit_log (input_hash, patterns_matched, audit_entries, checked_at)
         VALUES ($1, $2, $3, $4)`,
        [
          hashInput(input),
          JSON.stringify(auditLog.map((a) => a.split(":")[0])),
          JSON.stringify(auditLog),
          new Date().toISOString(),
        ]
      )
    }

    return {
      blocked: triggeredPatterns.length > 0,
      triggered_patterns: triggeredPatterns,
      warnings,
      audit_log: auditLog,
      details: {
        patterns_checked: enabledPatterns.length,
        input_hash: hashInput(input),
      },
    }
  }

  function matchPattern(pattern: HardStopPattern, content: string): boolean {
    switch (pattern.pattern_type) {
      case "regex":
        try {
          const regex = new RegExp(pattern.pattern, "gi")
          return regex.test(content)
        } catch {
          return false
        }

      case "keyword":
        const keywords = pattern.pattern.toLowerCase().split(",")
        const lowerContent = content.toLowerCase()
        return keywords.some((kw) => lowerContent.includes(kw.trim()))

      case "semantic":
        // Placeholder for semantic matching (would use embeddings)
        return false

      case "structural":
        // Placeholder for structural matching (AST analysis)
        return false

      default:
        return false
    }
  }

  async function addPattern(
    pattern: Omit<HardStopPattern, "pattern_id">
  ): Promise<HardStopPattern> {
    const fullPattern: HardStopPattern = {
      ...pattern,
      pattern_id: crypto.randomUUID(),
    }

    await pool.query(
      `INSERT INTO hardstop_patterns (pattern_id, name, description, pattern_type, pattern, categories, severity, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        fullPattern.pattern_id,
        fullPattern.name,
        fullPattern.description,
        fullPattern.pattern_type,
        fullPattern.pattern,
        JSON.stringify(fullPattern.categories),
        fullPattern.severity,
        fullPattern.enabled,
      ]
    )

    return fullPattern
  }

  async function removePattern(patternId: string): Promise<void> {
    await pool.query(
      `DELETE FROM hardstop_patterns WHERE pattern_id = $1`,
      [patternId]
    )
  }

  async function getPatterns(category?: RiskCategory): Promise<HardStopPattern[]> {
    let query = `SELECT * FROM hardstop_patterns`
    const params: unknown[] = []

    if (category) {
      query += ` WHERE categories @> $1`
      params.push(JSON.stringify([category]))
    }

    const result = await pool.query(query, params)

    return result.rows.map((row) => ({
      pattern_id: row.pattern_id,
      name: row.name,
      description: row.description,
      pattern_type: row.pattern_type,
      pattern: row.pattern,
      categories: row.categories ?? [],
      severity: row.severity,
      enabled: row.enabled,
    }))
  }

  async function enablePattern(patternId: string): Promise<void> {
    await pool.query(
      `UPDATE hardstop_patterns SET enabled = true WHERE pattern_id = $1`,
      [patternId]
    )
  }

  async function disablePattern(patternId: string): Promise<void> {
    await pool.query(
      `UPDATE hardstop_patterns SET enabled = false WHERE pattern_id = $1`,
      [patternId]
    )
  }

  return {
    check,
    addPattern,
    removePattern,
    getPatterns,
    enablePattern,
    disablePattern,
  }
}

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

async function initializeDefaultPatterns(pool: pg.Pool): Promise<void> {
  const result = await pool.query(`SELECT COUNT(*) FROM hardstop_patterns`)
  const count = parseInt(result.rows[0].count, 10)

  if (count === 0) {
    for (const pattern of DEFAULT_PATTERNS) {
      await pool.query(
        `INSERT INTO hardstop_patterns (pattern_id, name, description, pattern_type, pattern, categories, severity, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (name) DO NOTHING`,
        [
          crypto.randomUUID(),
          pattern.name,
          pattern.description,
          pattern.pattern_type,
          pattern.pattern,
          JSON.stringify(pattern.categories),
          pattern.severity,
          pattern.enabled,
        ]
      )
    }
  }
}

function hashInput(input: HardStopInput): string {
  const content = JSON.stringify(input)
  // Simple hash for audit purposes
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16).padStart(8, "0")
}
