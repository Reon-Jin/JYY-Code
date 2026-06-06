/**
 * Observability module — provides LLM tracing, performance monitoring,
 * and error tracking. Integrates with Langfuse for LLM observability.
 *
 * Ported from claudecode's src/services/langfuse/ infrastructure.
 */
import { Effect, Context, Layer } from "effect"
import * as Log from "@jyycode-ai/core/util/log"

const log = Log.create({ service: "observability" })

export interface TraceSpan {
  traceId: string
  spanId: string
  name: string
  startTime: number
  endTime?: number
  attributes: Record<string, unknown>
  events: TraceEvent[]
  status: "ok" | "error" | "unset"
}

export interface TraceEvent {
  name: string
  timestamp: number
  attributes: Record<string, unknown>
}

export interface LLMCallMetadata {
  modelId: string
  providerId: string
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost: number
  durationMs: number
  requestId?: string
  error?: string
}

export interface Interface {
  /** Start a new trace span. */
  readonly startSpan: (name: string, attributes?: Record<string, unknown>) => Effect.Effect<TraceSpan>
  /** End a trace span. */
  readonly endSpan: (span: TraceSpan, status?: "ok" | "error") => Effect.Effect<void>
  /** Add an event to a span. */
  readonly addEvent: (span: TraceSpan, name: string, attributes?: Record<string, unknown>) => Effect.Effect<void>
  /** Record an LLM API call with full metadata. */
  readonly recordLLMCall: (metadata: LLMCallMetadata) => Effect.Effect<void>
  /** Flush pending traces. */
  readonly flush: () => Effect.Effect<void>
  /** Get active trace count. */
  readonly activeTraceCount: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Observability") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const activeSpans = new Map<string, TraceSpan>()
    const pendingCalls: LLMCallMetadata[] = []
    let traceCounter = 0

    const generateId = (): string => {
      traceCounter++
      return `${Date.now().toString(36)}-${traceCounter.toString(36)}-${Math.random().toString(36).slice(2, 9)}`
    }

    const startSpan = Effect.fn("Observability.startSpan")(function* (
      name: string,
      attributes?: Record<string, unknown>,
    ) {
      const span: TraceSpan = {
        traceId: generateId(),
        spanId: generateId(),
        name,
        startTime: Date.now(),
        attributes: attributes ?? {},
        events: [],
        status: "unset",
      }
      activeSpans.set(span.spanId, span)
      log.info("span started", { name, traceId: span.traceId })
      return span
    })

    const endSpan = Effect.fn("Observability.endSpan")(function* (
      span: TraceSpan,
      status: "ok" | "error" = "ok",
    ) {
      span.endTime = Date.now()
      span.status = status
      const duration = span.endTime - span.startTime

      log.info("span ended", {
        name: span.name,
        traceId: span.traceId,
        duration,
        status,
        eventCount: span.events.length,
      })

      activeSpans.delete(span.spanId)

      // Auto-clean old spans (keep last 1000)
      if (activeSpans.size > 1000) {
        const oldest = [...activeSpans.entries()]
          .sort(([, a], [, b]) => a.startTime - b.startTime)
          .slice(0, activeSpans.size - 1000)
        for (const [id] of oldest) {
          activeSpans.delete(id)
        }
      }
    })

    const addEvent = Effect.fn("Observability.addEvent")(function* (
      span: TraceSpan,
      name: string,
      attributes?: Record<string, unknown>,
    ) {
      span.events.push({
        name,
        timestamp: Date.now(),
        attributes: attributes ?? {},
      })
    })

    const recordLLMCall = Effect.fn("Observability.recordLLMCall")(function* (metadata: LLMCallMetadata) {
      pendingCalls.push(metadata)

      log.info("llm call", {
        model: metadata.modelId,
        provider: metadata.providerId,
        inputTokens: metadata.inputTokens,
        outputTokens: metadata.outputTokens,
        cost: metadata.cost,
        duration: metadata.durationMs,
        error: metadata.error,
      })

      // Batch flush every 50 calls
      if (pendingCalls.length >= 50) {
        yield* flush()
      }
    })

    const flush = Effect.fn("Observability.flush")(function* () {
      if (pendingCalls.length === 0) return

      const calls = pendingCalls.splice(0)
      const totalCost = calls.reduce((sum, c) => sum + c.cost, 0)
      const totalTokens = calls.reduce((sum, c) => sum + c.inputTokens + c.outputTokens, 0)
      const totalDuration = calls.reduce((sum, c) => sum + c.durationMs, 0)

      log.info("flushed", {
        calls: calls.length,
        totalCost: totalCost.toFixed(4),
        totalTokens,
        totalDuration,
        errors: calls.filter((c) => c.error).length,
      })

      // In a full implementation, this would send to Langfuse API.
      // For now, we log the aggregated metrics.
    })

    const activeTraceCount = Effect.fn("Observability.activeTraceCount")(function* () {
      return activeSpans.size
    })

    return Service.of({
      startSpan,
      endSpan,
      addEvent,
      recordLLMCall,
      flush,
      activeTraceCount,
    })
  }),
)

export const defaultLayer = layer
