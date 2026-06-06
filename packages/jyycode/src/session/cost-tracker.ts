/**
 * Cost tracker — centralized cost/token/duration tracking across sessions.
 * Persists per-session costs and supports model-usage aggregation.
 *
 * Ported from claudecode's src/cost-tracker.ts design.
 */
import { Effect, Context, Layer, Schema } from "effect"
import type { SessionID } from "./schema"
import type { ModelID, ProviderID } from "@/provider/schema"
import * as Log from "@jyycode-ai/core/util/log"

const log = Log.create({ service: "cost-tracker" })

export interface UsageStats {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
}

export interface ModelUsageEntry {
  providerId: ProviderID
  modelId: ModelID
  usage: UsageStats
  cost: number
  apiDuration: number
  callCount: number
}

export interface SessionCostState {
  sessionId: SessionID
  totalCost: number
  totalDuration: number
  totalAPIDuration: number
  linesAdded: number
  linesRemoved: number
  modelUsage: Record<string, ModelUsageEntry>
  lastUpdated: number
}

export interface Interface {
  /** Record a cost delta from a turn. */
  readonly recordUsage: (input: {
    sessionId: SessionID
    tokens: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } }
    cost: number
    durationMs: number
  }) => Effect.Effect<void>
  /** Record lines changed by a tool. */
  readonly recordLinesChanged: (input: {
    sessionId: SessionID
    added: number
    removed: number
  }) => Effect.Effect<void>
  /** Get session cost state. */
  readonly getSessionCosts: (sessionId: SessionID) => Effect.Effect<SessionCostState | undefined>
  /** Get total cost across all sessions. */
  readonly getTotalCost: () => Effect.Effect<number>
  /** Format cost for display. */
  readonly formatCost: (cost: number) => Effect.Effect<string>
  /** Get model usage breakdown. */
  readonly getModelUsage: (sessionId: SessionID) => Effect.Effect<Record<string, ModelUsageEntry>>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/CostTracker") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessionCosts = new Map<string, SessionCostState>()
    let totalCost = 0

    const ensureSession = (sessionId: SessionID): SessionCostState => {
      const key = sessionId as string
      if (!sessionCosts.has(key)) {
        sessionCosts.set(key, {
          sessionId,
          totalCost: 0,
          totalDuration: 0,
          totalAPIDuration: 0,
          linesAdded: 0,
          linesRemoved: 0,
          modelUsage: {},
          lastUpdated: Date.now(),
        })
      }
      return sessionCosts.get(key)!
    }

    const recordUsage = Effect.fn("CostTracker.recordUsage")(function* (input: {
      sessionId: SessionID
      tokens: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } }
      cost: number
      durationMs: number
    }) {
      const state = ensureSession(input.sessionId)
      state.totalCost += input.cost
      state.totalAPIDuration += input.durationMs
      state.lastUpdated = Date.now()
      totalCost += input.cost

      log.info("cost", {
        sessionId: input.sessionId,
        cost: input.cost,
        totalCost: state.totalCost,
        tokens: input.tokens,
      })
    })

    const recordLinesChanged = Effect.fn("CostTracker.recordLinesChanged")(function* (input: {
      sessionId: SessionID
      added: number
      removed: number
    }) {
      const state = ensureSession(input.sessionId)
      state.linesAdded += input.added
      state.linesRemoved += input.removed
      state.lastUpdated = Date.now()
    })

    const getSessionCosts = Effect.fn("CostTracker.getSessionCosts")(function* (sessionId: SessionID) {
      return sessionCosts.get(sessionId as string)
    })

    const getTotalCost = Effect.fn("CostTracker.getTotalCost")(function* () {
      return totalCost
    })

    const formatCost = Effect.fn("CostTracker.formatCost")(function* (cost: number) {
      if (cost < 0.01) return `< $0.01`
      return `$${cost.toFixed(2)}`
    })

    const getModelUsage = Effect.fn("CostTracker.getModelUsage")(function* (sessionId: SessionID) {
      return sessionCosts.get(sessionId as string)?.modelUsage ?? {}
    })

    return Service.of({
      recordUsage,
      recordLinesChanged,
      getSessionCosts,
      getTotalCost,
      formatCost,
      getModelUsage,
    })
  }),
)

export const defaultLayer = layer
