/**
 * Observation collector — records tool events and session patterns for
 * later analysis by the skill learning system.
 *
 * Ported from claudecode's src/services/skillLearning/runtimeObserver.ts
 * and toolEventObserver.ts.
 */
import { Effect, Context, Layer } from "effect"
import {
  type SkillObservation,
  type InstinctSource,
  type InstinctDomain,
  MAX_OBSERVATIONS_PER_ANALYSIS,
} from "./types"

export interface Interface {
  /** Record a tool event observation. */
  readonly recordToolEvent: (event: {
    toolName: string
    toolInput?: Record<string, unknown>
    sessionId?: string
    pattern: string
    context: string
    domain?: InstinctDomain
  }) => Effect.Effect<void>
  /** Record a session-level pattern observation. */
  readonly recordSessionPattern: (event: {
    sessionId: string
    pattern: string
    context: string
    domain?: InstinctDomain
  }) => Effect.Effect<void>
  /** Get all pending observations for analysis. */
  readonly getPending: (limit?: number) => Effect.Effect<SkillObservation[]>
  /** Mark observations as processed. */
  readonly markProcessed: (ids: string[]) => Effect.Effect<void>
  /** Clear all observations. */
  readonly clear: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/SkillObservation") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const observations: SkillObservation[] = []
    let idCounter = 0

    const inferDomain = (toolName: string): InstinctDomain => {
      const lower = toolName.toLowerCase()
      if (lower.includes("test") || lower.includes("spec")) return "testing"
      if (lower.includes("git") || lower.includes("commit")) return "git"
      if (lower.includes("debug") || lower.includes("log")) return "debugging"
      if (lower.includes("lint") || lower.includes("format") || lower.includes("style"))
        return "code-style"
      if (lower.includes("secret") || lower.includes("token") || lower.includes("auth"))
        return "security"
      if (lower.includes("build") || lower.includes("deploy") || lower.includes("ci"))
        return "workflow"
      return "project"
    }

    const recordToolEvent = Effect.fn("SkillObservation.recordToolEvent")(function* (event: {
      toolName: string
      toolInput?: Record<string, unknown>
      sessionId?: string
      pattern: string
      context: string
      domain?: InstinctDomain
    }) {
      const obs: SkillObservation = {
        id: `obs_${++idCounter}_${Date.now()}`,
        timestamp: Date.now(),
        source: "tool_event" as InstinctSource,
        domain: event.domain ?? inferDomain(event.toolName),
        toolName: event.toolName,
        toolInput: event.toolInput,
        sessionId: event.sessionId,
        pattern: event.pattern,
        context: event.context,
        confidence: 0.5, // Initial confidence, refined by analysis
      }
      observations.push(obs)

      // Cap at MAX_OBSERVATIONS_PER_ANALYSIS * 3 to prevent unbounded growth
      while (observations.length > MAX_OBSERVATIONS_PER_ANALYSIS * 3) {
        observations.shift()
      }
    })

    const recordSessionPattern = Effect.fn("SkillObservation.recordSessionPattern")(function* (event: {
      sessionId: string
      pattern: string
      context: string
      domain?: InstinctDomain
    }) {
      const obs: SkillObservation = {
        id: `obs_${++idCounter}_${Date.now()}`,
        timestamp: Date.now(),
        source: "session_pattern" as InstinctSource,
        domain: event.domain ?? "project",
        sessionId: event.sessionId,
        pattern: event.pattern,
        context: event.context,
        confidence: 0.6,
      }
      observations.push(obs)
      while (observations.length > MAX_OBSERVATIONS_PER_ANALYSIS * 3) {
        observations.shift()
      }
    })

    const getPending = Effect.fn("SkillObservation.getPending")(function* (limit?: number) {
      const max = limit ?? MAX_OBSERVATIONS_PER_ANALYSIS
      return observations.slice(-max)
    })

    const markProcessed = Effect.fn("SkillObservation.markProcessed")(function* (ids: string[]) {
      const idSet = new Set(ids)
      for (let i = observations.length - 1; i >= 0; i--) {
        if (idSet.has(observations[i]!.id)) {
          observations.splice(i, 1)
        }
      }
    })

    const clear = Effect.fn("SkillObservation.clear")(function* () {
      observations.length = 0
    })

    return Service.of({ recordToolEvent, recordSessionPattern, getPending, markProcessed, clear })
  }),
)

export const defaultLayer = layer
