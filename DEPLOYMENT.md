# MindOS Cloud Deployment Guide

Deploy MindOS to production using Restate Cloud + Supabase + Fly.io.

## Prerequisites

- [Fly CLI](https://fly.io/docs/flyctl/install/): `curl -L https://fly.io/install.sh | sh`
- [Restate Cloud account](https://cloud.restate.dev)
- [Supabase account](https://supabase.com)
- API keys for: OpenAI, Anthropic, Google AI, xAI

## Step 1: Supabase Setup

1. Create a new Supabase project at [supabase.com](https://supabase.com)
2. Enable pgvector extension:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. Run migrations:
   ```bash
   # Set your connection string
   export DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-us-west-1.pooler.supabase.com:5432/postgres"

   # Run migrations
   for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
   ```

## Step 2: Restate Cloud Setup

1. Sign up at [cloud.restate.dev](https://cloud.restate.dev)
2. Create a new environment (select US region)
3. Note your environment URLs:
   - Ingress URL: `https://[env].env.us.restate.cloud:8080`
   - Admin URL: `https://[env].env.us.restate.cloud:9070`
4. Generate an API key for deployments

## Step 3: Fly.io Setup

1. Sign up and install CLI:
   ```bash
   curl -L https://fly.io/install.sh | sh
   flyctl auth login
   ```

2. Create all apps:
   ```bash
   cd apps/mind-service && flyctl apps create mindos-agi-mind-service
   cd ../toolmesh && flyctl apps create mindos-agi-toolmesh
   cd ../executor && flyctl apps create mindos-agi-executor
   cd ../grounding-service && flyctl apps create mindos-agi-grounding-service
   cd ../drift-monitor && flyctl apps create mindos-agi-drift-monitor
   cd ../swarm-coordinator && flyctl apps create mindos-agi-swarm-coordinator
   ```

3. Set secrets for each app:
   ```bash
   # For mind-service (needs most secrets)
   cd apps/mind-service
   flyctl secrets set \
     DATABASE_URL="postgresql://..." \
     RESTATE_INGRESS_URL="https://..." \
     OPENAI_API_KEY="sk-..." \
     ANTHROPIC_API_KEY="sk-ant-..." \
     GOOGLE_AI_API_KEY="..." \
     XAI_API_KEY="xai-..." \
     TOOLMESH_URL="http://mindos-agi-toolmesh.internal:9000" \
     EXECUTOR_URL="http://mindos-agi-executor.internal:9100"

   # Repeat for other services with relevant secrets
   ```

## Step 4: Deploy Services

Deploy all services:
```bash
# From each app directory
cd apps/mind-service && flyctl deploy
cd ../toolmesh && flyctl deploy
cd ../executor && flyctl deploy
cd ../grounding-service && flyctl deploy
cd ../drift-monitor && flyctl deploy
cd ../swarm-coordinator && flyctl deploy
```

Or use GitHub Actions by setting these repository secrets:
- `FLY_API_TOKEN`: From `flyctl tokens create deploy`
- `RESTATE_CLOUD_API_KEY`: From Restate Cloud dashboard
- `RESTATE_ADMIN_URL`: Your Restate admin URL
- `DATABASE_URL_DIRECT`: Direct Supabase connection string

## Step 5: Register with Restate Cloud

After deploying mind-service, register it with Restate:
```bash
curl -X POST \
  -H "Authorization: Bearer $RESTATE_CLOUD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"uri": "https://mindos-agi-mind-service.fly.dev"}' \
  https://[env].env.us.restate.cloud:9070/deployments
```

## Architecture Overview

```
                    ┌─────────────────────────────┐
                    │      RESTATE CLOUD          │
                    │   (Durable Orchestration)   │
                    └─────────────┬───────────────┘
                                  │
         ┌────────────────────────┼────────────────────────┐
         │                        │                        │
         ▼                        ▼                        ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  mind-service   │◄──►│    toolmesh     │◄──►│    executor     │
│   (Fly.io)      │    │   (Fly.io)      │    │   (Fly.io)      │
└────────┬────────┘    └─────────────────┘    └─────────────────┘
         │
         ├──────────────────────┬──────────────────────┐
         ▼                      ▼                      ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   grounding     │    │  drift-monitor  │    │     swarm       │
│   (Fly.io)      │    │   (Fly.io)      │    │   (Fly.io)      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                  │
                    ┌─────────────┴───────────────┐
                    │      SUPABASE               │
                    │  PostgreSQL + pgvector      │
                    └─────────────────────────────┘
```

## Estimated Monthly Costs

| Service | Cost |
|---------|------|
| Restate Cloud (Business) | $300/mo |
| Supabase (Pro) | $25/mo |
| Fly.io (6 services) | ~$90/mo |
| **Total** | **~$415/mo** |

## Useful Commands

```bash
# Check status
flyctl status -a mindos-mind-service

# View logs
flyctl logs -a mindos-mind-service

# SSH into machine
flyctl ssh console -a mindos-mind-service

# Scale up
flyctl scale count 2 -a mindos-mind-service

# List all apps
flyctl apps list
```

## Troubleshooting

**Service not starting:**
```bash
flyctl logs -a mindos-agi-[service-name]
```

**Database connection issues:**
- Ensure pgbouncer connection string for runtime
- Use direct connection for migrations

**Restate registration fails:**
- Check mind-service is accessible at its public URL
- Verify RESTATE_CLOUD_API_KEY is valid

**Health checks failing:**
- Services need 30-60 seconds to start
- Check that health endpoints are implemented
