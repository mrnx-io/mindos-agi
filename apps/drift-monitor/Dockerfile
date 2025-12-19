# =============================================================================
# MindOS - drift-monitor Dockerfile
# Model Quality Monitoring and Failover
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Builder (Bun for package management)
# -----------------------------------------------------------------------------
FROM oven/bun:1.3.5-alpine AS builder

WORKDIR /app

# Copy package files for dependency caching
COPY package.json bun.lock* ./
COPY apps/drift-monitor/package.json ./apps/drift-monitor/
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
RUN bun install
RUN bun install --cwd apps/drift-monitor

# Copy source code
COPY packages/ ./packages/
COPY apps/drift-monitor/ ./apps/drift-monitor/
COPY tsconfig.base.json ./

# Build shared-types first, then the service
RUN cd packages/shared-types && bun run build
RUN cd apps/drift-monitor && bun run build

# -----------------------------------------------------------------------------
# Stage 2: Production (Node.js runtime)
# -----------------------------------------------------------------------------
FROM node:24-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 mindos && \
    adduser -u 1001 -G mindos -s /bin/sh -D mindos

# Copy built artifacts
COPY --from=builder /app/apps/drift-monitor/dist ./dist
COPY --from=builder /app/apps/drift-monitor/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared-types/dist ./node_modules/@mindos/shared-types/dist
COPY --from=builder /app/packages/shared-types/package.json ./node_modules/@mindos/shared-types/

# Set ownership
RUN chown -R mindos:mindos /app

USER mindos

# Environment
ENV NODE_ENV=production
ENV PORT=9300

# Expose drift monitor port
EXPOSE 9300

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:9300/health || exit 1

# Start the service
CMD ["node", "dist/server.js"]
