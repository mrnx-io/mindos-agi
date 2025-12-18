# MindOS

**10/10 State-of-the-Art AGI Agentic Architecture**

A persistent, autonomous, multi-model intelligence system with evidence-based reasoning, metacognitive learning, and continuous identity evolution.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MindOS Core                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │mind-service │  │  toolmesh   │  │  executor   │  │ grounding-service   │ │
│  │ (Restate)   │←→│ (MCP Hub)   │←→│ (Deno)      │  │ (Fact Verification) │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│         ↑               ↑               ↑                    ↑              │
│         │               │               │                    │              │
│  ┌──────┴───────────────┴───────────────┴────────────────────┴──────────┐   │
│  │                        PostgreSQL + pgvector                          │   │
│  │  • Identities & Events  • Evidence Ledger  • Semantic Memory         │   │
│  │  • Tool Registry        • World Model States  • Swarm Coordination   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────────────┐ │
│  │drift-monitor│  │   swarm-    │  │           Packages                  │ │
│  │ (Quality)   │  │ coordinator │  │  • shared-types  • evidence-core    │ │
│  └─────────────┘  └─────────────┘  │  • policy-engine • world-model      │ │
│                                     │  • metacognition • identity-evol   │ │
│                                     └─────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Features

### Core Agent Runtime (mind-service)
- **Restate Durable Execution**: Workflow orchestration with automatic replay
- **Multi-Model Routing**: GPT-4o, Claude, Gemini with circuit breakers and fallback chains
- **Four-Tier Memory**: Episodic, Semantic (pgvector), Procedural, Autobiographical
- **Evidence-Based Reasoning**: SHA-256 hashed provenance with Merkle verification

### Tool Orchestration (toolmesh)
- **MCP Gateway**: Streamable HTTP, SSE, stdio transports
- **Semantic Tool Discovery**: pgvector-powered tool search
- **Single-Flight Coordination**: Idempotent tool execution
- **Retry Budgets**: Circuit breakers with exponential backoff

### Sandboxed Execution (executor)
- **Deno Runtime**: Hardened sandbox with permission flags
- **Resource Limits**: CPU, memory, and network isolation
- **Preflight Validation**: Static analysis before execution
- **Two-Phase Execution**: Dry-run before commit

### External Grounding (grounding-service)
- **Wikipedia Integration**: Authoritative source verification
- **Brave Search API**: Web-wide fact checking
- **LLM Analysis**: Confidence-scored claim assessment
- **Cross-Tool Verification**: Multi-source consistency checks

### Model Quality Monitoring (drift-monitor)
- **Capability Fingerprinting**: Baseline quality metrics
- **Scheduled Probing**: Automated quality assessment
- **Drift Detection**: Quality degradation alerts
- **Model Replacement**: Automatic failover triggers

### Multi-Agent Orchestration (swarm-coordinator)
- **Consensus Protocols**: Raft-inspired leader election
- **Task Delegation**: Capability-based routing
- **Emergent Behavior Detection**: Specialization tracking
- **WebSocket Communication**: Real-time agent coordination

### Advanced Packages

| Package | Purpose |
|---------|---------|
| `shared-types` | Zod schemas for all domain objects |
| `evidence-core` | Cryptographic provenance and verification |
| `policy-engine` | Risk scoring and approval workflows |
| `world-model` | Predictive simulation and causal graphs |
| `metacognition` | Self-monitoring and learning |
| `identity-evolution` | Preference learning and value drift detection |

## Getting Started

### Prerequisites

- Node.js >= 22.0.0 or Bun >= 1.1.0
- Docker & Docker Compose
- Deno (for executor service)
- PostgreSQL 16+ with pgvector

### Installation

```bash
# Clone and install
cd mindos
bun install

# Start infrastructure
docker compose up -d

# Run database migrations
bun run db:migrate

# Start all services in development
bun run dev
```

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Database
DATABASE_URL=postgresql://mindos:mindos@localhost:5432/mindos

# AI Models
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_AI_API_KEY=...
XAI_API_KEY=...

# External Services
BRAVE_API_KEY=...

# Restate
RESTATE_RUNTIME_ENDPOINT=http://localhost:8080
```

## Service Ports

| Service | Port | Description |
|---------|------|-------------|
| mind-service | 9080 | Restate endpoint |
| toolmesh | 3001 | MCP gateway |
| executor | 3002 | Deno sandbox |
| grounding-service | 3003 | Fact verification |
| drift-monitor | 3004 | Quality monitoring |
| swarm-coordinator | 3005 | Multi-agent |
| Restate Admin | 9070 | Workflow management |
| PostgreSQL | 5432 | Database |
| Graphiti | 8000 | Knowledge graph |

## Architecture Principles

### Evidence-Based Reasoning
Every claim, decision, and action is backed by cryptographically verified evidence. The evidence ledger maintains SHA-256 hashed provenance chains with Merkle tree verification.

### Metacognitive Learning
The system continuously monitors its own performance, generates hypotheses about failures, and learns from outcomes. Confidence calibration ensures accurate self-assessment.

### Identity Evolution
Agent identity persists across sessions with continuous preference learning, value drift detection, and relationship memory. Core values are protected by coherence checking.

### Multi-Model Resilience
Circuit breakers, health probes, and fallback chains ensure continuous operation even when primary models are unavailable. Model quality is continuously monitored.

### Safety First
- Hard-stop patterns block dangerous operations
- Risk scoring gates high-stakes actions
- Two-phase execution with dry-run validation
- Human-in-the-loop approvals for elevated risk

## Development

```bash
# Build all packages
bun run build

# Lint and format
bun run lint:fix

# Run tests
bun run test

# Type check
bun run check
```

## Project Structure

```
mindos/
├── apps/
│   ├── mind-service/      # Core agent runtime (Restate)
│   ├── toolmesh/          # MCP gateway
│   ├── executor/          # Deno sandbox
│   ├── grounding-service/ # Fact verification
│   ├── drift-monitor/     # Model quality
│   └── swarm-coordinator/ # Multi-agent
├── packages/
│   ├── shared-types/      # Zod schemas
│   ├── evidence-core/     # Provenance
│   ├── policy-engine/     # Risk scoring
│   ├── world-model/       # Simulation
│   ├── metacognition/     # Self-monitoring
│   └── identity-evolution/# Identity persistence
├── db/
│   └── migrations/        # SQL migrations
├── docker-compose.yml     # Service orchestration
├── turbo.json            # Build configuration
└── biome.json            # Linting rules
```

## License

Proprietary - All rights reserved.
