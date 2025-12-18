// =============================================================================
// MindOS - Observability Package
// =============================================================================

// OpenTelemetry
export { initOpenTelemetry, shutdownOpenTelemetry } from "./otel.js"
export type { OtelConfig } from "./otel.js"

// Langfuse
export {
  initLangfuse,
  shutdownLangfuse,
  trackLLMCall,
  createTrace,
  createSpan,
  getLangfuseClient,
} from "./langfuse.js"
export type { LangfuseConfig, LLMCallMetrics } from "./langfuse.js"

// Tracing utilities
export {
  traced,
  traceLLMCall,
  getCurrentSpan,
  setSpanAttribute,
  addSpanEvent,
  createChildSpan,
  endSpan,
} from "./tracing.js"
export type { TracedOptions } from "./tracing.js"

// Re-export OpenTelemetry types for convenience
export type { Span } from "@opentelemetry/api"
export { SpanStatusCode } from "@opentelemetry/api"
