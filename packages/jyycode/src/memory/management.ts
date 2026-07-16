export * as MemoryManagement from "./management"

import { createHash } from "crypto"
import { Context, Effect, Layer } from "effect"
import { Memory } from "./memory"
import { SessionID } from "@/session/schema"

export type Scope = "user" | "task"

export type UserEntry = {
  id: string
  scope: "user"
  importance: Memory.Importance
  keywords: string[]
  content: string
}

export type TaskEntry = {
  id: string
  scope: "task"
  importance: Memory.Importance
  date: string
  keywords: string[]
  content: string
  sessionID: SessionID
}

export type Entry = UserEntry | TaskEntry

export type EntryInput = {
  importance: Memory.Importance
  keywords: string[]
  content: string
}

export type Page = {
  entries: Entry[]
  total: number
  nextCursor?: string
}

export interface Interface {
  readonly list: (input: {
    scope: Scope
    sessionID?: SessionID
    query?: string
    cursor?: string
    limit?: number
  }) => Effect.Effect<Page, Error>
  readonly createUser: (input: EntryInput) => Effect.Effect<UserEntry, Error>
  readonly update: (
    input:
      | ({ scope: "user"; id: string } & EntryInput)
      | ({ scope: "task"; id: string | null; sessionID: SessionID } & EntryInput),
  ) => Effect.Effect<Entry, Error>
  readonly remove: (input: { scope: Scope; id: string; sessionID?: SessionID }) => Effect.Effect<void, Error>
  readonly clearTask: (input: { sessionID: SessionID }) => Effect.Effect<number, Error>
  readonly compact: (input: { scope: Scope; sessionID?: SessionID }) => Effect.Effect<Memory.CompactionResult, Error>
  readonly exportStore: (input: { scope: Scope; sessionID?: SessionID }) => Effect.Effect<string, Error>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/MemoryManagement") {}

const managementSessionID = SessionID.make("ses_desktop_management")

function digest(value: string) {
  return createHash("sha256").update(value).digest("base64url").slice(0, 22)
}

function userID(entry: Memory.UserMemoryEntry) {
  return `usr_${digest(Memory.normalizeKeywords(entry.keywords).sort().join("\u001f"))}`
}

function taskID(entry: Memory.TaskMemoryEntry) {
  return `tsk_${digest(JSON.stringify(entry))}`
}

function managed(entry: Memory.MemoryEntry): Entry {
  if (entry.scope === "user") return { ...entry, id: userID(entry) }
  return { ...entry, scope: "task", id: taskID(entry) }
}

function storageScope(scope: Scope): Memory.Scope {
  return scope === "task" ? "memory" : "user"
}

function requireSession(scope: Scope, sessionID?: SessionID) {
  if (scope === "task" && !sessionID) throw new Error("Task memory requires a sessionID")
  return sessionID ?? managementSessionID
}

function assertIDScope(scope: Scope, id: string) {
  const prefix = scope === "user" ? "usr_" : "tsk_"
  if (!id.startsWith(prefix)) throw new Error("Memory id does not belong to the requested scope")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    if (
      !memory.managementRead ||
      !memory.managementCreate ||
      !memory.managementUpdate ||
      !memory.managementRemove ||
      !memory.managementClearTask ||
      !memory.managementCompact
    ) {
      return yield* Effect.die("Memory management storage primitives are unavailable")
    }
    const storage = {
      read: memory.managementRead,
      create: memory.managementCreate,
      update: memory.managementUpdate,
      remove: memory.managementRemove,
      clearTask: memory.managementClearTask,
      compact: memory.managementCompact,
    }

    const entriesFor = Effect.fn("MemoryManagement.entriesFor")(function* (scope: Scope, sessionID?: SessionID) {
      const writer = yield* Effect.try({ try: () => requireSession(scope, sessionID), catch: asError })
      const store = yield* storage.read({ sessionID: writer, scope: storageScope(scope) })
      return store.entries.filter((entry) =>
        scope === "user"
          ? entry.scope === "user"
          : entry.scope === "memory" && entry.sessionID === sessionID,
      )
    })

    const findExact = Effect.fn("MemoryManagement.findExact")(function* (
      scope: Scope,
      id: string,
      sessionID?: SessionID,
    ) {
      yield* Effect.try({ try: () => assertIDScope(scope, id), catch: asError })
      const entries = yield* entriesFor(scope, sessionID)
      const found = entries.find((entry) => managed(entry).id === id)
      if (!found) return yield* Effect.fail(new Error("Memory entry not found or stale"))
      return found
    })

    const list = Effect.fn("MemoryManagement.list")(function* (input: {
      scope: Scope
      sessionID?: SessionID
      query?: string
      cursor?: string
      limit?: number
    }) {
      const query = input.query?.normalize("NFKC").trim().toLowerCase() ?? ""
      const filtered = (yield* entriesFor(input.scope, input.sessionID))
        .filter((entry) =>
          !query ? true : `${entry.keywords.join(" ")} ${entry.content}`.normalize("NFKC").toLowerCase().includes(query),
        )
        .map(managed)
      const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0
      if (!Number.isInteger(offset) || offset < 0) return yield* Effect.fail(new Error("Invalid memory cursor"))
      const limit = Math.min(100, Math.max(1, input.limit ?? 25))
      const entries = filtered.slice(offset, offset + limit)
      const nextOffset = offset + entries.length
      return {
        entries,
        total: filtered.length,
        ...(nextOffset < filtered.length ? { nextCursor: String(nextOffset) } : {}),
      }
    })

    const createUser = Effect.fn("MemoryManagement.createUser")(function* (input: EntryInput) {
      const entry = yield* storage.create({ sessionID: managementSessionID, entry: { scope: "user", ...input } })
      return managed(entry) as UserEntry
    })

    const update = Effect.fn("MemoryManagement.update")(function* (
      input:
        | ({ scope: "user"; id: string } & EntryInput)
        | ({ scope: "task"; id: string | null; sessionID: SessionID } & EntryInput),
    ) {
      if (input.scope === "task" && input.id === null) {
        const entry = yield* storage.create({
          sessionID: input.sessionID,
          entry: {
            scope: "memory",
            sessionID: input.sessionID,
            date: localDate(new Date()),
            importance: input.importance,
            keywords: input.keywords,
            content: input.content,
          },
        })
        return managed(entry)
      }
      if (input.id === null) return yield* Effect.fail(new Error("Memory id is required"))
      const sessionID = input.scope === "task" ? input.sessionID : managementSessionID
      const expected = yield* findExact(input.scope, input.id, input.scope === "task" ? input.sessionID : undefined)
      const replacement: Memory.MemoryEntry =
        expected.scope === "memory"
          ? {
              ...expected,
              importance: input.importance,
              keywords: input.keywords,
              content: input.content,
            }
          : { scope: "user", importance: input.importance, keywords: input.keywords, content: input.content }
      return managed(yield* storage.update({ sessionID, expected, replacement }))
    })

    const remove = Effect.fn("MemoryManagement.remove")(function* (input: {
      scope: Scope
      id: string
      sessionID?: SessionID
    }) {
      const sessionID = yield* Effect.try({ try: () => requireSession(input.scope, input.sessionID), catch: asError })
      const expected = yield* findExact(input.scope, input.id, input.sessionID)
      yield* storage.remove({ sessionID, expected })
    })

    const clearTask = Effect.fn("MemoryManagement.clearTask")(function* (input: { sessionID: SessionID }) {
      return yield* storage.clearTask(input)
    })

    const compact = Effect.fn("MemoryManagement.compact")(function* (input: {
      scope: Scope
      sessionID?: SessionID
    }) {
      const sessionID = yield* Effect.try({ try: () => requireSession(input.scope, input.sessionID), catch: asError })
      return yield* storage.compact({ sessionID, scope: storageScope(input.scope) })
    })

    const exportStore = Effect.fn("MemoryManagement.exportStore")(function* (input: {
      scope: Scope
      sessionID?: SessionID
    }) {
      const entries = yield* entriesFor(input.scope, input.sessionID)
      return Memory.serializeStore(storageScope(input.scope), entries)
    })

    return Service.of({ list, createUser, update, remove, clearTask, compact, exportStore })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Memory.defaultLayer))

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function localDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}${month}${day}`
}
