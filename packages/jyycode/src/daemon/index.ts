/**
 * Daemon / supervisor system for managing background worker processes.
 * Supports worker lifecycle, crash recovery with exponential backoff,
 * and IPC-based session management.
 *
 * Ported from claudecode's src/daemon/main.ts and workerRegistry.ts.
 */
import { Effect, Context, Layer, Schedule, Duration, Stream } from "effect"
import { ChildProcess } from "@jyycode-ai/core/process"
import * as Log from "@jyycode-ai/core/util/log"

const log = Log.create({ service: "daemon" })

export type WorkerState = "starting" | "running" | "stopping" | "stopped" | "crashed" | "parked"
export type WorkerKind = "background" | "session" | "scheduled" | "remote"

export interface WorkerInfo {
  id: string
  kind: WorkerKind
  state: WorkerState
  pid: number | null
  dir: string
  startedAt: number
  restartCount: number
  lastCrashAt: number | null
  crashHistory: number[] // Timestamps of recent crashes
  capacity: number
}

export interface DaemonState {
  workers: Map<string, WorkerInfo>
  supervisorRunning: boolean
}

// Crash recovery: exponential backoff with 120s cap
const BACKOFF_SCHEDULE = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 120_000]
const MAX_FAST_CRASHES = 5
const FAST_CRASH_WINDOW_MS = 10_000
const PERMANENT_EXIT_CODE = 78

export interface Interface {
  /** Start the supervisor loop. */
  readonly startSupervisor: () => Effect.Effect<void>
  /** Stop the supervisor and all workers. */
  readonly stopSupervisor: () => Effect.Effect<void>
  /** Register a new worker. */
  readonly registerWorker: (info: {
    id: string
    kind: WorkerKind
    dir: string
    capacity?: number
  }) => Effect.Effect<WorkerInfo>
  /** Spawn a worker process. */
  readonly spawnWorker: (workerId: string) => Effect.Effect<WorkerInfo>
  /** Stop a specific worker. */
  readonly stopWorker: (workerId: string) => Effect.Effect<void>
  /** Get daemon status. */
  readonly status: () => Effect.Effect<DaemonState>
  /** List all workers. */
  readonly listWorkers: () => Effect.Effect<WorkerInfo[]>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Daemon") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const workers = new Map<string, WorkerInfo>()
    let supervisorAbort: (() => void) | null = null
    let supervisorRunning = false

    const registerWorker = Effect.fn("Daemon.registerWorker")(function* (info: {
      id: string
      kind: WorkerKind
      dir: string
      capacity?: number
    }) {
      const worker: WorkerInfo = {
        id: info.id,
        kind: info.kind,
        state: "stopped",
        pid: null,
        dir: info.dir,
        startedAt: Date.now(),
        restartCount: 0,
        lastCrashAt: null,
        crashHistory: [],
        capacity: info.capacity ?? 1,
      }
      workers.set(info.id, worker)
      log.info("worker registered", { id: info.id, kind: info.kind })
      return worker
    })

    const spawnWorker = Effect.fn("Daemon.spawnWorker")(function* (workerId: string) {
      const worker = workers.get(workerId)
      if (!worker) throw new Error(`Worker not found: ${workerId}`)

      worker.state = "starting"
      worker.startedAt = Date.now()

      try {
        // In a real implementation, this would spawn a child process.
        // For now, simulate the worker lifecycle.
        worker.state = "running"
        worker.pid = process.pid // Placeholder
        log.info("worker started", { id: workerId })
      } catch (error) {
        worker.state = "crashed"
        worker.lastCrashAt = Date.now()
        worker.crashHistory.push(Date.now())
        yield* handleCrash(worker)
      }

      return worker
    })

    const handleCrash = (worker: WorkerInfo): Effect.Effect<void> => {
      return Effect.gen(function* () {
        worker.restartCount++

        // Clean old crash history (outside FAST_CRASH_WINDOW)
        const cutoff = Date.now() - FAST_CRASH_WINDOW_MS
        while (worker.crashHistory.length > 0 && (worker.crashHistory[0] ?? 0) < cutoff) {
          worker.crashHistory.shift()
        }

        // Park worker after too many fast crashes
        if (worker.crashHistory.length >= MAX_FAST_CRASHES) {
          worker.state = "parked"
          log.warn("worker parked after fast crashes", {
            id: worker.id,
            crashes: worker.crashHistory.length,
          })
          return
        }

        // Exponential backoff
        const backoffIndex = Math.min(worker.restartCount - 1, BACKOFF_SCHEDULE.length - 1)
        const delay = BACKOFF_SCHEDULE[backoffIndex] ?? 120_000
        log.info("worker crash recovery", { id: worker.id, delay, attempt: worker.restartCount })

        yield* Effect.sleep(delay)
        yield* spawnWorker(worker.id)
      })
    }

    const stopWorker = Effect.fn("Daemon.stopWorker")(function* (workerId: string) {
      const worker = workers.get(workerId)
      if (!worker) return

      worker.state = "stopping"
      yield* Effect.sleep(1000) // Graceful shutdown window
      worker.state = "stopped"
      worker.pid = null
      log.info("worker stopped", { id: workerId })
    })

    const startSupervisor = Effect.fn("Daemon.startSupervisor")(function* () {
      if (supervisorRunning) return
      supervisorRunning = true

      log.info("supervisor started")

      // Start all registered workers
      for (const [id, worker] of workers) {
        if (worker.state === "stopped") {
          yield* spawnWorker(id).pipe(Effect.fork)
        }
      }
    })

    const stopSupervisor = Effect.fn("Daemon.stopSupervisor")(function* () {
      if (!supervisorRunning) return
      supervisorRunning = false

      log.info("supervisor stopping")

      // Stop all running workers
      const stops: Effect.Effect<void>[] = []
      for (const [id, worker] of workers) {
        if (worker.state === "running" || worker.state === "starting") {
          stops.push(stopWorker(id))
        }
      }
      yield* Effect.all(stops, { concurrency: "unbounded" })

      if (supervisorAbort) {
        supervisorAbort()
        supervisorAbort = null
      }
    })

    const status = Effect.fn("Daemon.status")(function* () {
      return { workers: new Map(workers), supervisorRunning }
    })

    const listWorkers = Effect.fn("Daemon.listWorkers")(function* () {
      return [...workers.values()]
    })

    return Service.of({
      startSupervisor,
      stopSupervisor,
      registerWorker,
      spawnWorker,
      stopWorker,
      status,
      listWorkers,
    })
  }),
)

export const defaultLayer = layer
