// =============================================================================
// MindOS - Executor Service (Deno Sandbox)
// =============================================================================

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const PORT = parseInt(Deno.env.get("PORT") ?? "3002");
const HOST = Deno.env.get("HOST") ?? "0.0.0.0";
const MAX_EXECUTION_TIME_MS = parseInt(Deno.env.get("MAX_EXECUTION_TIME_MS") ?? "30000");
const MAX_MEMORY_MB = parseInt(Deno.env.get("MAX_MEMORY_MB") ?? "128");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface ExecutionRequest {
  code: string;
  language: "typescript" | "javascript";
  context?: Record<string, unknown>;
  permissions?: ExecutionPermissions;
  timeout_ms?: number;
  memory_limit_mb?: number;
}

interface ExecutionPermissions {
  net?: boolean | string[];
  read?: boolean | string[];
  write?: boolean | string[];
  env?: boolean | string[];
  run?: boolean | string[];
}

interface ExecutionResult {
  success: boolean;
  output: unknown;
  stdout: string;
  stderr: string;
  error?: string;
  duration_ms: number;
  memory_used_mb: number;
  timed_out: boolean;
}

interface PreflightResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  requiredPermissions: ExecutionPermissions;
}

// -----------------------------------------------------------------------------
// Code Execution
// -----------------------------------------------------------------------------

async function executeCode(request: ExecutionRequest): Promise<ExecutionResult> {
  const startTime = performance.now();
  const timeout = request.timeout_ms ?? MAX_EXECUTION_TIME_MS;

  // Build permission flags
  const permFlags = buildPermissionFlags(request.permissions ?? getDefaultPermissions());

  // Create temp file for code
  const tempDir = await Deno.makeTempDir();
  const codeFile = `${tempDir}/code.${request.language === "typescript" ? "ts" : "js"}`;

  // Wrap code with context injection and output capture
  const wrappedCode = wrapCode(request.code, request.context ?? {});
  await Deno.writeTextFile(codeFile, wrappedCode);

  try {
    // Execute in subprocess with limited permissions
    const cmd = new Deno.Command("deno", {
      args: ["run", ...permFlags, codeFile],
      stdout: "piped",
      stderr: "piped",
      env: {
        DENO_NO_PROMPT: "1",
        // Limit V8 heap
        DENO_V8_FLAGS: `--max-old-space-size=${request.memory_limit_mb ?? MAX_MEMORY_MB}`,
      },
    });

    // Create abort controller for timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    try {
      const child = cmd.spawn();

      // Wait for completion or timeout
      const result = await Promise.race([
        child.output(),
        new Promise<never>((_, reject) =>
          abortController.signal.addEventListener("abort", () =>
            reject(new Error("Execution timed out"))
          )
        ),
      ]);

      clearTimeout(timeoutId);

      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);

      // Parse output
      const output = parseOutput(stdout);
      const duration = performance.now() - startTime;

      return {
        success: result.code === 0,
        output,
        stdout,
        stderr,
        error: result.code !== 0 ? stderr : undefined,
        duration_ms: Math.round(duration),
        memory_used_mb: 0, // Would need runtime metrics
        timed_out: false,
      };
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof Error && err.message === "Execution timed out") {
        return {
          success: false,
          output: null,
          stdout: "",
          stderr: "",
          error: "Execution timed out",
          duration_ms: timeout,
          memory_used_mb: 0,
          timed_out: true,
        };
      }
      throw err;
    }
  } finally {
    // Cleanup temp files
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

// -----------------------------------------------------------------------------
// Preflight Validation
// -----------------------------------------------------------------------------

async function preflightCode(
  code: string,
  language: "typescript" | "javascript"
): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const requiredPermissions: ExecutionPermissions = {};

  // Check for dangerous patterns
  const dangerousPatterns = [
    { pattern: /\beval\s*\(/, message: "Use of eval() is discouraged" },
    { pattern: /\bFunction\s*\(/, message: "Use of Function constructor is discouraged" },
    { pattern: /\b__proto__\b/, message: "Direct __proto__ access is not allowed" },
    { pattern: /\bconstructor\s*\[/, message: "Constructor access via brackets is not allowed" },
  ];

  for (const { pattern, message } of dangerousPatterns) {
    if (pattern.test(code)) {
      warnings.push(message);
    }
  }

  // Detect required permissions
  if (/\bfetch\s*\(|\bDeno\.connect\b/.test(code)) {
    requiredPermissions.net = true;
  }
  if (/\bDeno\.readTextFile\b|\bDeno\.readFile\b|\bDeno\.open\b/.test(code)) {
    requiredPermissions.read = true;
  }
  if (/\bDeno\.writeTextFile\b|\bDeno\.writeFile\b/.test(code)) {
    requiredPermissions.write = true;
  }
  if (/\bDeno\.env\b/.test(code)) {
    requiredPermissions.env = true;
  }
  if (/\bDeno\.run\b|\bDeno\.Command\b/.test(code)) {
    requiredPermissions.run = true;
    warnings.push("Code uses subprocess execution, which requires elevated permissions");
  }

  // TypeScript syntax check
  if (language === "typescript") {
    const tempDir = await Deno.makeTempDir();
    const tempFile = `${tempDir}/check.ts`;
    await Deno.writeTextFile(tempFile, code);

    try {
      const cmd = new Deno.Command("deno", {
        args: ["check", tempFile],
        stdout: "piped",
        stderr: "piped",
      });

      const result = await cmd.output();

      if (result.code !== 0) {
        const stderr = new TextDecoder().decode(result.stderr);
        errors.push(`TypeScript errors: ${stderr}`);
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    requiredPermissions,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function buildPermissionFlags(permissions: ExecutionPermissions): string[] {
  const flags: string[] = [];

  // Network
  if (permissions.net === true) {
    flags.push("--allow-net");
  } else if (Array.isArray(permissions.net)) {
    flags.push(`--allow-net=${permissions.net.join(",")}`);
  }

  // Read
  if (permissions.read === true) {
    flags.push("--allow-read");
  } else if (Array.isArray(permissions.read)) {
    flags.push(`--allow-read=${permissions.read.join(",")}`);
  }

  // Write
  if (permissions.write === true) {
    flags.push("--allow-write");
  } else if (Array.isArray(permissions.write)) {
    flags.push(`--allow-write=${permissions.write.join(",")}`);
  }

  // Env
  if (permissions.env === true) {
    flags.push("--allow-env");
  } else if (Array.isArray(permissions.env)) {
    flags.push(`--allow-env=${permissions.env.join(",")}`);
  }

  // Run
  if (permissions.run === true) {
    flags.push("--allow-run");
  } else if (Array.isArray(permissions.run)) {
    flags.push(`--allow-run=${permissions.run.join(",")}`);
  }

  // If no permissions specified, run with no permissions (fully sandboxed)
  if (flags.length === 0) {
    flags.push("--no-prompt");
  }

  return flags;
}

function getDefaultPermissions(): ExecutionPermissions {
  return {
    net: false,
    read: false,
    write: false,
    env: false,
    run: false,
  };
}

function wrapCode(code: string, context: Record<string, unknown>): string {
  const contextSetup = Object.entries(context)
    .map(([key, value]) => `const ${key} = ${JSON.stringify(value)};`)
    .join("\n");

  return `
// Context injection
${contextSetup}

// Output wrapper
const __output__ = { result: undefined, error: undefined };

try {
  // User code
  const __result__ = await (async () => {
    ${code}
  })();
  __output__.result = __result__;
} catch (e) {
  __output__.error = e instanceof Error ? e.message : String(e);
}

// Output result as JSON
console.log("__MINDOS_OUTPUT__" + JSON.stringify(__output__));
`;
}

function parseOutput(stdout: string): unknown {
  const marker = "__MINDOS_OUTPUT__";
  const markerIndex = stdout.lastIndexOf(marker);

  if (markerIndex === -1) {
    return stdout; // Return raw output if no marker
  }

  try {
    const jsonStr = stdout.slice(markerIndex + marker.length).trim();
    const output = JSON.parse(jsonStr);

    if (output.error) {
      throw new Error(output.error);
    }

    return output.result;
  } catch {
    return stdout;
  }
}

// -----------------------------------------------------------------------------
// HTTP Server
// -----------------------------------------------------------------------------

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  // Handle preflight
  if (method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Health check
  if (path === "/health" && method === "GET") {
    return Response.json(
      { status: "ok", maxTimeoutMs: MAX_EXECUTION_TIME_MS, maxMemoryMb: MAX_MEMORY_MB },
      { headers: corsHeaders }
    );
  }

  // Execute code
  if (path === "/execute" && method === "POST") {
    try {
      const body = (await request.json()) as ExecutionRequest;
      const result = await executeCode(body);
      return Response.json(result, { headers: corsHeaders });
    } catch (err) {
      return Response.json(
        {
          success: false,
          output: null,
          stdout: "",
          stderr: "",
          error: err instanceof Error ? err.message : String(err),
          duration_ms: 0,
          memory_used_mb: 0,
          timed_out: false,
        },
        { status: 500, headers: corsHeaders }
      );
    }
  }

  // Preflight check
  if (path === "/preflight" && method === "POST") {
    try {
      const body = (await request.json()) as { code: string; language: "typescript" | "javascript" };
      const result = await preflightCode(body.code, body.language);
      return Response.json(result, { headers: corsHeaders });
    } catch (err) {
      return Response.json(
        { valid: false, errors: [err instanceof Error ? err.message : String(err)], warnings: [], requiredPermissions: {} },
        { status: 500, headers: corsHeaders }
      );
    }
  }

  // Stats
  if (path === "/stats" && method === "GET") {
    return Response.json(
      {
        activeExecutions: 0, // Would track in production
        queuedExecutions: 0,
        avgExecutionTime: 0,
        memoryUsage: Deno.memoryUsage().heapUsed / 1024 / 1024,
        cpuUsage: 0,
      },
      { headers: corsHeaders }
    );
  }

  return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

console.log(`🚀 Executor service starting on ${HOST}:${PORT}`);
console.log(`   Max execution time: ${MAX_EXECUTION_TIME_MS}ms`);
console.log(`   Max memory: ${MAX_MEMORY_MB}MB`);

Deno.serve({ port: PORT, hostname: HOST }, handleRequest);
