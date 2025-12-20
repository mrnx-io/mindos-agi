# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MindOS is an AGI agentic architecture with evidence-based reasoning, metacognitive learning, and multi-model resilience. Built as a Bun/TypeScript monorepo using Turbo, with Restate for durable execution and PostgreSQL+pgvector for persistence.

## Commands

```bash
# Development
bun run dev                # Start all services in watch mode
bun run build              # Build all packages
bun run check              # Type check all packages
bun run test               # Run tests

# Code quality
bun run lint               # Check with Biome
bun run lint:fix           # Auto-fix linting issues
bun run format             # Format code

# Infrastructure
bun run docker:up          # Start PostgreSQL + Restate
bun run docker:down        # Stop infrastructure
bun run db:migrate         # Run SQL migrations
```

## Architecture

**Services** (`apps/`):
- `mind-service` - Restate virtual object, core agent orchestration (port 8080)
- `toolmesh` - MCP gateway with semantic tool discovery (port 9000)
- `executor` - Deno sandbox for isolated code execution (port 9100)
- `grounding-service` - Fact verification via Wikipedia/Brave Search (port 9200)
- `drift-monitor` - Model quality monitoring and failover (port 9300)
- `swarm-coordinator` - Multi-agent consensus and delegation (port 9400)

**Packages** (`packages/`):
- `shared-types` - Zod schemas for all domain objects
- `evidence-core` - SHA-256 hashing and Merkle verification
- `policy-engine` - Risk scoring and approval workflows
- `memory-systems` - 4-tier memory (episodic/semantic/procedural/autobiographical)
- `world-model` - Predictive simulation and causal graphs
- `metacognition` - Self-monitoring and hypothesis generation
- `identity-evolution` - Preference learning and value drift detection

## Key Patterns

**Restate Virtual Objects** (mind-service):
```typescript
// Stateful actors with durable execution
restate.object({
  name: "mind",
  handlers: {
    ingestEvent: async (ctx, event) => { /* durably execute */ }
  }
})
// All side effects must use ctx.run() for determinism
const result = await ctx.run("operation-name", () => sideEffect())
```

**Multi-Model Routing**: Primary model with 2 fallback chains. Circuit breakers per model. Configure via `MODEL_PRIMARY`, `MODEL_FALLBACK_1`, `MODEL_FALLBACK_2` env vars.

**Risk Thresholds**: Auto-execute if risk ≤0.35, require approval if ≥0.60. Hard-stop patterns block dangerous operations. Two-phase execution (dry-run + commit) for the executor.

**Evidence Chain**: Every claim backed by SHA-256 hashed provenance in `evidence_records` table. Merkle tree verification for integrity.

## Code Style

- TypeScript strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- Biome for linting/formatting: 2-space indents, double quotes, semicolons as-needed
- Zod schemas for all validation (defined in `shared-types`)
- Pino for structured logging

## Database

PostgreSQL 16+ with pgvector. Migrations in `db/migrations/`. Key tables: `identities`, `events`, `evidence_records`, `semantic_memories`, `tool_call_requests`.

## Environment

Copy `.env.example` to `.env`. Required: `DATABASE_URL`, model API keys (OPENAI, ANTHROPIC, GOOGLE, XAI). Feature flags control optional subsystems (metacognition, world-model, swarm, grounding, drift-monitoring, identity-evolution).
