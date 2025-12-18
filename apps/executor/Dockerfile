# =============================================================================
# MindOS - executor Dockerfile
# Deno Sandbox for Isolated Code Execution
# =============================================================================

# Using official Deno Alpine image for minimal footprint
FROM denoland/deno:alpine-2.6.0

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 mindos && \
    adduser -u 1001 -G mindos -s /bin/sh -D mindos

# Copy application code
COPY apps/executor/deno.json ./
COPY apps/executor/src/ ./src/

# Cache dependencies (Deno caches on first run)
RUN deno cache src/server.ts

# Set ownership
RUN chown -R mindos:mindos /app

USER mindos

# Environment
ENV PORT=9100
ENV HOST=0.0.0.0
ENV MAX_EXECUTION_TIME_MS=30000
ENV MAX_MEMORY_MB=128

# Expose executor port
EXPOSE 9100

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:9100/health || exit 1

# Start the service with minimal permissions
# The service itself spawns sandboxed subprocesses for user code
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read=/tmp", "--allow-write=/tmp", "--allow-run=deno", "src/server.ts"]
