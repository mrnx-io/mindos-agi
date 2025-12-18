# =============================================================================
# MindOS - swarm-coordinator Dockerfile
# Multi-Agent Consensus and Delegation
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Builder (Bun for package management)
# -----------------------------------------------------------------------------
FROM oven/bun:1.3.5-alpine AS builder

WORKDIR /app

# Copy package files for dependency caching
COPY package.json bun.lockb* ./
COPY apps/swarm-coordinator/package.json ./apps/swarm-coordinator/
COPY packages/shared-types/package.json ./packages/shared-types/

# Copy other workspace packages
COPY packages/evidence-core/package.json ./packages/evidence-core/
COPY packages/policy-engine/package.json ./packages/policy-engine/
COPY packages/memory-systems/package.json ./packages/memory-systems/
COPY packages/world-model/package.json ./packages/world-model/
COPY packages/metacognition/package.json ./packages/metacognition/
COPY packages/identity-evolution/package.json ./packages/identity-evolution/
COPY packages/observability/package.json ./packages/observability/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY packages/ ./packages/
COPY apps/swarm-coordinator/ ./apps/swarm-coordinator/
COPY tsconfig.json ./

# Build shared-types first, then the service
RUN cd packages/shared-types && bun run build
RUN cd apps/swarm-coordinator && bun run build

# -----------------------------------------------------------------------------
# Stage 2: Production (Node.js runtime)
# -----------------------------------------------------------------------------
FROM node:24-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 mindos && \
    adduser -u 1001 -G mindos -s /bin/sh -D mindos

# Copy built artifacts
COPY --from=builder /app/apps/swarm-coordinator/dist ./dist
COPY --from=builder /app/apps/swarm-coordinator/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared-types/dist ./node_modules/@mindos/shared-types/dist
COPY --from=builder /app/packages/shared-types/package.json ./node_modules/@mindos/shared-types/

# Set ownership
RUN chown -R mindos:mindos /app

USER mindos

# Environment
ENV NODE_ENV=production
ENV PORT=9400

# Expose swarm coordinator port
EXPOSE 9400

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:9400/health || exit 1

# Start the service
CMD ["node", "dist/server.js"]
