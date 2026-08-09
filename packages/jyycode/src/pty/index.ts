import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { lazy } from "@jyycode-ai/core/util/lazy"
import { Plugin } from "@/plugin"
import { Shell } from "@/shell/shell"
import type { Proc } from "#pty"
import type { TerminationResult } from "@jyycode-ai/core/process-supervisor"
import * as Log from "@jyycode-ai/core/util/log"
import { PtyID } from "./schema"
import { Effect, Layer, Context, Schema, Types, Scope, Clock } from "effect"
import { NonNegativeInt, PositiveInt } from "@jyycode-ai/core/schema"

const log = Log.create({ service: "pty" })

const BUFFER_LIMIT = 1024 * 1024 * 2
const BUFFER_CHUNK = 64 * 1024
const MAX_SESSIONS_PER_INSTANCE = 16
const DEFAULT_SESSIONS_PER_OWNER = 8
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const MAX_IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MS
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000
const MAX_ABSOLUTE_TIMEOUT_MS = DEFAULT_ABSOLUTE_TIMEOUT_MS
const TERMINATION_TIMEOUT_MS = 8_000
const encoder = new TextEncoder()

type Socket = {
  readyState: number
  data?: unknown
  send: (data: string | Uint8Array | ArrayBuffer) => void
  close: (code?: number, reason?: string) => void
}

const sock = (ws: Socket) => (ws.data && typeof ws.data === "object" ? ws.data : ws)

type Active = {
  info: Info
  process: Proc
  buffer: string
  bufferCursor: number
  cursor: number
  subscribers: Map<unknown, Socket>
  ownerSessionID?: string
  ownerWorkspaceID?: string
  createdAt: number
  lastActivityAt: number
  idleExpiresAt: number
  absoluteExpiresAt: number
  idleTimeoutMs: number
  absoluteTimeoutMs: number
  watchdog?: ReturnType<typeof Effect.runFork>
  termination?: TerminationResult
}

type State = {
  dir: string
  sessions: Map<PtyID, Active>
}

// WebSocket control frame: 0x00 + UTF-8 JSON.
const meta = (cursor: number) => {
  const json = JSON.stringify({ cursor })
  const bytes = encoder.encode(json)
  const out = new Uint8Array(bytes.length + 1)
  out[0] = 0
  out.set(bytes, 1)
  return out
}

const pty = lazy(() => import("#pty"))

export const Info = Schema.Struct({
  id: PtyID,
  title: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  status: Schema.Literals(["running", "exited", "kill_failed"]),
  pid: PositiveInt,
  owner_session_id: Schema.optional(Schema.String),
  owner_workspace_id: Schema.optional(Schema.String),
  created_at: PositiveInt,
  last_activity_at: PositiveInt,
  idle_expires_at: PositiveInt,
  absolute_expires_at: PositiveInt,
  termination_reason: Schema.optional(Schema.String),
}).annotate({ identifier: "Pty" })

export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const CreateInput = Schema.Struct({
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  owner_session_id: Schema.optional(Schema.String),
  owner_workspace_id: Schema.optional(Schema.String),
})

export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const UpdateInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  size: Schema.optional(
    Schema.Struct({
      rows: PositiveInt,
      cols: PositiveInt,
    }),
  ),
})

export type UpdateInput = Types.DeepMutable<Schema.Schema.Type<typeof UpdateInput>>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Pty.NotFoundError", {
  ptyID: PtyID,
}) {}

export class TerminationError extends Schema.TaggedErrorClass<TerminationError>()("Pty.TerminationError", {
  ptyID: PtyID,
  message: Schema.String,
}) {}

export const Event = {
  Created: BusEvent.define("pty.created", Schema.Struct({ info: Info })),
  Updated: BusEvent.define("pty.updated", Schema.Struct({ info: Info })),
  Exited: BusEvent.define("pty.exited", Schema.Struct({ id: PtyID, exitCode: NonNegativeInt })),
  Deleted: BusEvent.define("pty.deleted", Schema.Struct({ id: PtyID })),
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: PtyID) => Effect.Effect<Info, NotFoundError>
  readonly create: (input: CreateInput) => Effect.Effect<Info, never, Scope.Scope>
  readonly update: (id: PtyID, input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  readonly remove: (id: PtyID) => Effect.Effect<void, NotFoundError | TerminationError>
  readonly resize: (id: PtyID, cols: number, rows: number) => Effect.Effect<void, NotFoundError>
  readonly write: (id: PtyID, data: string) => Effect.Effect<void, NotFoundError>
  readonly connect: (
    id: PtyID,
    ws: Socket,
    cursor?: number,
  ) => Effect.Effect<
    { onMessage: (message: string | ArrayBuffer) => void; onClose: () => void } | undefined,
    NotFoundError
  >
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Pty") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const plugin = yield* Plugin.Service
    const clock = yield* Clock.Clock

    const failedTermination = (session: Active, reason: string, error?: unknown): TerminationResult => ({
      state: "kill_failed",
      pid: session.info.pid,
      remainingPids: [session.info.pid],
      error: error instanceof Error ? error.message : reason,
    })

    const teardown = Effect.fn("Pty.teardown")(function* (session: Active, reason: string) {
      if (session.info.status === "running" || session.info.status === "kill_failed") {
        const result = yield* Effect.tryPromise({
          try: () => session.process.kill("SIGTERM"),
          catch: (error) => error,
        }).pipe(
          Effect.timeoutOrElse({
            duration: `${TERMINATION_TIMEOUT_MS} millis`,
            orElse: () => Effect.succeed(failedTermination(session, reason)),
          }),
          Effect.catch((error) => Effect.succeed(failedTermination(session, reason, error))),
        )
        session.termination = result
        if (result.state === "kill_failed") {
          session.info.status = "kill_failed"
          session.info.termination_reason = reason
        } else {
          session.info.status = "exited"
        }
      }

      for (const [sub, ws] of session.subscribers.entries()) {
        try {
          if (sock(ws) === sub) ws.close()
        } catch {}
      }
      session.subscribers.clear()
      return session.termination ?? ({ state: "exited", pid: session.info.pid, remainingPids: [] } satisfies TerminationResult)
    })

    const state = yield* InstanceState.make<State>(
      Effect.fn("Pty.state")(function* (ctx) {
        const state = {
          dir: ctx.directory,
          sessions: new Map<PtyID, Active>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.forEach(state.sessions.values(), (session) => teardown(session, "instance_dispose").pipe(Effect.ignore), {
            concurrency: "unbounded",
          }).pipe(Effect.asVoid, Effect.tap(() => Effect.sync(() => state.sessions.clear()))),
        )

        return state
      }),
    )

    const requireSession = Effect.fn("Pty.requireSession")(function* (id: PtyID) {
      const session = (yield* InstanceState.get(state)).sessions.get(id)
      if (!session) return yield* new NotFoundError({ ptyID: id })
      return session
    })

    const touch = (session: Active) => {
      if (session.info.status !== "running") return
      const now = clock.currentTimeMillisUnsafe()
      session.lastActivityAt = now
      session.idleExpiresAt = Math.min(now + session.idleTimeoutMs, session.absoluteExpiresAt)
      session.info.last_activity_at = now
      session.info.idle_expires_at = session.idleExpiresAt
    }

    const remove = Effect.fn("Pty.remove")(function* (id: PtyID) {
      const s = yield* InstanceState.get(state)
      const session = yield* requireSession(id)
      log.info("removing session", { id })
      const result = yield* teardown(session, "removed")
      if (result.state === "kill_failed") {
        return yield* new TerminationError({
          ptyID: id,
          message: `PTY process tree termination failed for ${id}`,
        })
      }
      s.sessions.delete(id)
      yield* bus.publish(Event.Deleted, { id: session.info.id })
    })

    const list = Effect.fn("Pty.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Array.from(s.sessions.values()).map((session) => session.info)
    })

    const get = Effect.fn("Pty.get")(function* (id: PtyID) {
      return (yield* requireSession(id)).info
    })

    const create = Effect.fn("Pty.create")(function* (input: CreateInput) {
      const s = yield* InstanceState.get(state)
      const bridge = yield* EffectBridge.make()
      const cfg = yield* config.get()
      const ptyConfig = cfg.pty
      const ownerSessionID = input.owner_session_id
      const ownerWorkspaceID = input.owner_workspace_id
      const ownerLimit = Math.max(1, ptyConfig?.max_sessions_per_owner ?? DEFAULT_SESSIONS_PER_OWNER)
      if (s.sessions.size >= MAX_SESSIONS_PER_INSTANCE) {
        throw new Error(`PTY session limit exceeded: maximum ${MAX_SESSIONS_PER_INSTANCE} per instance`)
      }
      if (ownerSessionID || ownerWorkspaceID) {
        const owned = Array.from(s.sessions.values()).filter(
          (session) =>
            (ownerSessionID !== undefined && session.ownerSessionID === ownerSessionID) ||
            (ownerWorkspaceID !== undefined && session.ownerWorkspaceID === ownerWorkspaceID),
        ).length
        if (owned >= ownerLimit) throw new Error(`PTY owner session limit exceeded: maximum ${ownerLimit}`)
      }
      const idleTimeoutMs = Math.min(ptyConfig?.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS)
      const absoluteTimeoutMs = Math.min(
        ptyConfig?.absolute_timeout_ms ?? DEFAULT_ABSOLUTE_TIMEOUT_MS,
        MAX_ABSOLUTE_TIMEOUT_MS,
      )
      const id = PtyID.ascending()
      const command = input.command || Shell.preferred(cfg.shell)
      const args = input.args || []
      if (Shell.login(command)) {
        args.push("-l")
      }

      const cwd = input.cwd || s.dir
      const shell = yield* plugin.trigger("shell.env", { cwd }, { env: {} })
      const env = {
        ...process.env,
        ...input.env,
        ...shell.env,
        TERM: "xterm-256color",
        JYYCODE_TERMINAL: "1",
      } as Record<string, string>

      if (process.platform === "win32") {
        env.LC_ALL = "C.UTF-8"
        env.LC_CTYPE = "C.UTF-8"
        env.LANG = "C.UTF-8"
      }
      log.info("creating session", { id, cmd: command, args, cwd })

      const { spawn } = yield* Effect.promise(() => pty())
      const proc = yield* Effect.sync(() =>
        spawn(command, args, {
          name: "xterm-256color",
          cwd,
          env,
        }),
      )

      const now = clock.currentTimeMillisUnsafe()
      const info = {
        id,
        title: input.title || `Terminal ${id.slice(-4)}`,
        command,
        args,
        cwd,
        status: "running",
        pid: proc.pid,
        owner_session_id: ownerSessionID,
        owner_workspace_id: ownerWorkspaceID,
        created_at: now,
        last_activity_at: now,
        idle_expires_at: Math.min(now + idleTimeoutMs, now + absoluteTimeoutMs),
        absolute_expires_at: now + absoluteTimeoutMs,
      } as const
      const session: Active = {
        info,
        process: proc,
        buffer: "",
        bufferCursor: 0,
        cursor: 0,
        subscribers: new Map(),
        ownerSessionID,
        ownerWorkspaceID,
        createdAt: now,
        lastActivityAt: now,
        idleExpiresAt: info.idle_expires_at,
        absoluteExpiresAt: info.absolute_expires_at,
        idleTimeoutMs,
        absoluteTimeoutMs,
      }
      s.sessions.set(id, session)
      proc.onData((chunk) => {
        if (chunk.length > 0) touch(session)
        session.cursor += chunk.length

        for (const [key, ws] of session.subscribers.entries()) {
          if (ws.readyState !== 1) {
            session.subscribers.delete(key)
            continue
          }
          if (sock(ws) !== key) {
            session.subscribers.delete(key)
            continue
          }
          try {
            ws.send(chunk)
          } catch {
            session.subscribers.delete(key)
          }
        }

        session.buffer += chunk
        if (session.buffer.length <= BUFFER_LIMIT) return
        const excess = session.buffer.length - BUFFER_LIMIT
        session.buffer = session.buffer.slice(excess)
        session.bufferCursor += excess
      })
      proc.onExit(({ exitCode }) => {
        if (session.info.status === "exited") return
        log.info("session exited", { id, exitCode })
        session.info.status = "exited"
        session.termination = { state: "exited", pid: session.info.pid, remainingPids: [] }
        bridge.fork(bus.publish(Event.Exited, { id, exitCode }))
        bridge.fork(remove(id))
      })
      session.watchdog = yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (session.info.status === "running") {
            yield* Effect.sleep("1 second")
            const current = clock.currentTimeMillisUnsafe()
            if (current >= session.absoluteExpiresAt || current >= session.idleExpiresAt) {
              yield* remove(id).pipe(
                Effect.catch((error) => {
                  log.error("PTY expiry cleanup failed", { id, error: String(error) })
                  return Effect.void
                }),
              )
              return
            }
          }
        }),
      )
      yield* bus.publish(Event.Created, { info })
      return info
    })

    const update = Effect.fn("Pty.update")(function* (id: PtyID, input: UpdateInput) {
      const session = yield* requireSession(id)
      if (input.title) {
        session.info.title = input.title
      }
      if (input.size) {
        session.process.resize(input.size.cols, input.size.rows)
      }
      yield* bus.publish(Event.Updated, { info: session.info })
      return session.info
    })

    const resize = Effect.fn("Pty.resize")(function* (id: PtyID, cols: number, rows: number) {
      const session = yield* requireSession(id)
      if (session.info.status === "running") {
        session.process.resize(cols, rows)
      }
    })

    const write = Effect.fn("Pty.write")(function* (id: PtyID, data: string) {
      const session = yield* requireSession(id)
      if (session.info.status === "running") {
        if (data.length > 0) touch(session)
        session.process.write(data)
      }
    })

    const connect = Effect.fn("Pty.connect")(function* (id: PtyID, ws: Socket, cursor?: number) {
      const session = yield* requireSession(id).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            ws.close()
          }),
        ),
      )
      log.info("client connected to session", { id })

      const sub = sock(ws)
      session.subscribers.delete(sub)
      session.subscribers.set(sub, ws)

      const cleanup = () => {
        session.subscribers.delete(sub)
      }

      const start = session.bufferCursor
      const end = session.cursor
      const from =
        cursor === -1 ? end : typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0

      const data = (() => {
        if (!session.buffer) return ""
        if (from >= end) return ""
        const offset = Math.max(0, from - start)
        if (offset >= session.buffer.length) return ""
        return session.buffer.slice(offset)
      })()

      if (data) {
        try {
          for (let i = 0; i < data.length; i += BUFFER_CHUNK) {
            ws.send(data.slice(i, i + BUFFER_CHUNK))
          }
        } catch {
          cleanup()
          ws.close()
          return
        }
      }

      try {
        ws.send(meta(end))
      } catch {
        cleanup()
        ws.close()
        return
      }

      return {
        onMessage: (message: string | ArrayBuffer) => {
          touch(session)
          session.process.write(typeof message === "string" ? message : new TextDecoder().decode(message))
        },
        onClose: () => {
          log.info("client disconnected from session", { id })
          cleanup()
        },
      }
    })

    return Service.of({ list, get, create, update, remove, resize, write, connect })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as Pty from "."
