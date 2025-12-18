// =============================================================================
// MindOS - Tracing Utilities
// =============================================================================

import { type Span, SpanStatusCode, trace } from "@opentelemetry/api"
import { type LLMCallMetrics, trackLLMCall } from "./langfuse.js"

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface TracedOptions<T> {
  name: string
  attributes?: Record<string, string | number | boolean>
  fn: (span: Span) => Promise<T>
}

// -----------------------------------------------------------------------------
// Traced Wrapper
// -----------------------------------------------------------------------------

export async function traced<T>(options: TracedOptions<T>): Promise<T> {
  const tracer = trace.getTracer("mindos")

  return tracer.startActiveSpan(options.name, async (span) => {
    try {
      // Set initial attributes
      if (options.attributes) {
        for (const [key, value] of Object.entries(options.attributes)) {
          span.setAttribute(key, value)
        }
      }

      // Execute the function
      const result = await options.fn(span)

      // Mark success
      span.setStatus({ code: SpanStatusCode.OK })

      return result
    } catch (err) {
      // Record error
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      })
      span.recordException(err as Error)
      throw err
    } finally {
      span.end()
    }
  })
}

// -----------------------------------------------------------------------------
// LLM Call Tracing
// -----------------------------------------------------------------------------

export function traceLLMCall(name: string, metrics: LLMCallMetrics, span?: Span): void {
  // Add to OpenTelemetry span
  if (span) {
    span.setAttribute("llm.model", metrics.model)
    span.setAttribute("llm.provider", metrics.provider)
    span.setAttribute("llm.tokens.prompt", metrics.promptTokens)
    span.setAttribute("llm.tokens.completion", metrics.completionTokens)
    span.setAttribute("llm.tokens.total", metrics.totalTokens)
    span.setAttribute("llm.latency_ms", metrics.latencyMs)
    span.setAttribute("llm.success", metrics.success)
    if (metrics.error) {
      span.setAttribute("llm.error", metrics.error)
    }
  }

  // Also track in Langfuse
  trackLLMCall(name, metrics)
}

// -----------------------------------------------------------------------------
// Context Propagation
// -----------------------------------------------------------------------------

export function getCurrentSpan(): Span | undefined {
  return trace.getActiveSpan()
}

export function setSpanAttribute(key: string, value: string | number | boolean): void {
  const span = getCurrentSpan()
  if (span) {
    span.setAttribute(key, value)
  }
}

export function addSpanEvent(
  name: string,
  attributes?: Record<string, string | number | boolean>
): void {
  const span = getCurrentSpan()
  if (span) {
    span.addEvent(name, attributes)
  }
}

// -----------------------------------------------------------------------------
// Span Helpers
// -----------------------------------------------------------------------------

export function createChildSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>
): Span {
  const tracer = trace.getTracer("mindos")
  const span = tracer.startSpan(name)

  if (attributes) {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value)
    }
  }

  return span
}

export function endSpan(span: Span, success: boolean, error?: Error): void {
  if (success) {
    span.setStatus({ code: SpanStatusCode.OK })
  } else {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error?.message ?? "Unknown error",
    })
    if (error) {
      span.recordException(error)
    }
  }
  span.end()
}
