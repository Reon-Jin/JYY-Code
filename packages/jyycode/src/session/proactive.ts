/**
 * Proactive mode — state machine driving autonomous tick-based task progression.
 * Keeps prompt cache warm (< 5 min TTL) with 30-second tick intervals.
 *
 * State: inactive -> active (-> paused -> active) -> inactive
 *
 * Ported from claudecode's src/proactive/index.ts and useProactive.ts.
 */
import { Effect, Context, Layer } from "effect"

export type ProactiveState = "inactive" | "active" | "paused"
export type ActivationSource = "user" | "autonomy" | "scheduled" | "system"

export interface ProactiveStatus {
  state: ProactiveState
  activationSource: ActivationSource | null
  contextBlocked: boolean
  nextTickAt: number | null
}

/** Default tick interval: 30 seconds (under prompt cache 5-min TTL). */
export const TICK_INTERVAL_MS = 30_000

/** Guard conditions that prevent a tick from firing. */
export interface TickGuards {
  isLoading: boolean
  isInPlanMode: boolean
  hasActiveToolCalls: boolean
  queuedCommandsCount: number
}

export interface Interface {
  /** Activate proactive mode. */
  readonly activate: (source?: ActivationSource) => Effect.Effect<void>
  /** Deactivate proactive mode. */
  readonly deactivate: () => Effect.Effect<void>
  /** Pause without clearing activation source. */
  readonly pause: () => Effect.Effect<void>
  /** Resume from paused state. */
  readonly resume: () => Effect.Effect<void>
  /** Block ticks due to API errors (context overflow, etc.). */
  readonly setContextBlocked: (blocked: boolean) => Effect.Effect<void>
  /** Schedule the next tick. */
  readonly setNextTickAt: (ts: number | null) => Effect.Effect<void>
  /** Get current proactive status. */
  readonly status: () => Effect.Effect<ProactiveStatus>
  /** Check if a tick should fire now. */
  readonly shouldTick: (guards: TickGuards) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Proactive") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let state: ProactiveState = "inactive"
    let activationSource: ActivationSource | null = null
    let contextBlocked = false
    let nextTickAt: number | null = null

    const notify = () => {
      // In a full implementation, this would publish to a bus.
      // For now, state changes are read via status() polling.
    }

    const activate = Effect.fn("Proactive.activate")(function* (source?: ActivationSource) {
      state = "active"
      activationSource = source ?? "user"
      contextBlocked = false
      nextTickAt = Date.now() + TICK_INTERVAL_MS
      notify()
    })

    const deactivate = Effect.fn("Proactive.deactivate")(function* () {
      state = "inactive"
      activationSource = null
      contextBlocked = false
      nextTickAt = null
      notify()
    })

    const pause = Effect.fn("Proactive.pause")(function* () {
      if (state === "active") {
        state = "paused"
        notify()
      }
    })

    const resume = Effect.fn("Proactive.resume")(function* () {
      if (state === "paused") {
        state = "active"
        nextTickAt = Date.now() + TICK_INTERVAL_MS
        notify()
      }
    })

    const setContextBlocked = Effect.fn("Proactive.setContextBlocked")(function* (blocked: boolean) {
      contextBlocked = blocked
      if (blocked) {
        nextTickAt = null // Prevent tick→error→tick runaway
      }
    })

    const setNextTickAt = Effect.fn("Proactive.setNextTickAt")(function* (ts: number | null) {
      nextTickAt = ts
    })

    const status = Effect.fn("Proactive.status")(function* () {
      return { state, activationSource, contextBlocked, nextTickAt }
    })

    const shouldTick = Effect.fn("Proactive.shouldTick")(function* (guards: TickGuards) {
      // Basic activation check
      if (state !== "active") return false
      if (contextBlocked) return false

      // Guard conditions
      if (guards.isLoading) return false
      if (guards.isInPlanMode) return false
      if (guards.hasActiveToolCalls) return false
      if (guards.queuedCommandsCount > 0) return false

      // Timing check
      if (nextTickAt === null) return true // First tick
      if (Date.now() < nextTickAt) return false

      return true
    })

    return Service.of({
      activate,
      deactivate,
      pause,
      resume,
      setContextBlocked,
      setNextTickAt,
      status,
      shouldTick,
    })
  }),
)

export const defaultLayer = layer
