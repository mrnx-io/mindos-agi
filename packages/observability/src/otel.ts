// =============================================================================
// MindOS - OpenTelemetry Initialization
// =============================================================================

import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { Resource } from "@opentelemetry/resources"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface OtelConfig {
  serviceName: string
  serviceVersion?: string
  otlpEndpoint?: string
  enabled?: boolean
}

// -----------------------------------------------------------------------------
// SDK Instance
// -----------------------------------------------------------------------------

let sdk: NodeSDK | null = null

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

export function initOpenTelemetry(config: OtelConfig): void {
  // Skip if disabled or no endpoint
  if (config.enabled === false) {
    console.log("[otel] OpenTelemetry disabled")
    return
  }

  if (!config.otlpEndpoint) {
    console.log("[otel] No OTLP endpoint configured, skipping initialization")
    return
  }

  if (sdk) {
    console.log("[otel] OpenTelemetry already initialized")
    return
  }

  const exporter = new OTLPTraceExporter({
    url: config.otlpEndpoint,
  })

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? "1.0.0",
  })

  sdk = new NodeSDK({
    resource,
    traceExporter: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable noisy instrumentations
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
      }),
    ],
  })

  sdk.start()
  console.log(`[otel] OpenTelemetry initialized for ${config.serviceName}`)

  // Graceful shutdown
  process.on("SIGTERM", () => {
    sdk
      ?.shutdown()
      .then(() => console.log("[otel] OpenTelemetry shut down"))
      .catch((err) => console.error("[otel] Error shutting down:", err))
  })
}

// -----------------------------------------------------------------------------
// Shutdown
// -----------------------------------------------------------------------------

export async function shutdownOpenTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown()
    sdk = null
    console.log("[otel] OpenTelemetry shut down")
  }
}
