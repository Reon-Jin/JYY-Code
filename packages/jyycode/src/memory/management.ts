export * as MemoryManagement from "./management"

import { createHash } from "crypto"
import { Context, Effect, Layer } from "effect"
import { Memory } from "./memory"
import { ExperienceMemory } from "./experience"
import { SessionID } from "@/session/schema"

export type Scope = "user" | "task" | "experience"

export type UserEntry = {
  id: string
  scope: "user"
  importance: Memory.Importance
  date?: string
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
  projectID?: string
  sessionID: SessionID
}

export type ExperienceEntry = {
  id: string
  scope: "experience"
  kind: ExperienceMemory.ExperienceKind
  importance: Memory.Importance
  date: string
  updatedAt: string
  keywords: string[]
  content: string
  evidence: string
  confidence: ExperienceMemory.ExperienceConfidence
  uses: number
  status: ExperienceMemory.ExperienceStatus
  sessionID: SessionID
  supersededReason?: string
}

export type Entry = UserEntry | TaskEntry | ExperienceEntry

export type EntryInput = {
  importance: number
  keywords: readonly string[]
  content: string
}

export type ExperienceInput = {
  kind: ExperienceMemory.ExperienceKind
  importance: number
  keywords: readonly string[]
  content: string
  confidence: ExperienceMemory.ExperienceConfidence
}

export type Page = {
  entries: Entry[]
  total: number
  nextCursor?: string
}

export type CompactionResult = Pick<Memory.CompactionResult, "removed" | "merged" | "retained">

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
      | ({ scope: "task"; id: string | null; sessionID: SessionID } & EntryInput)
      | ({ scope: "experience"; id: string } & ExperienceInput),
  ) => Effect.Effect<Entry, Error>
  readonly remove: (input: { scope: Scope; id: string; sessionID?: SessionID }) => Effect.Effect<void, Error>
  readonly clearTask: (input: { sessionID?: SessionID }) => Effect.Effect<number, Error>
  readonly compact: (input: { scope: Scope; sessionID?: SessionID }) => Effect.Effect<CompactionResult, Error>
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

function experienceID(entry: ExperienceMemory.ExperienceEntry) {
  return `exp_${digest(`${entry.sessionID}\u001f${ExperienceMemory.experienceKey(entry)}`)}`
}

function managed(entry: Memory.MemoryEntry | ExperienceMemory.ExperienceEntry): Entry {
  if (entry.scope === "experience") return { ...entry, id: experienceID(entry), scope: "experience" }
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
  const prefix = scope === "user" ? "usr_" : scope === "task" ? "tsk_" : "exp_"
  if (!id.startsWith(prefix)) throw new Error("Memory id does not belong to the requested scope")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    const experience = yield* ExperienceMemory.Service
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
    if (
      !experience.managementRead ||
      !experience.managementUpdate ||
      !experience.managementRemove ||
      !experience.managementCompact
    ) {
      return yield* Effect.die("Experience management storage primitives are unavailable")
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
      if (scope === "experience") return (yield* experience.managementRead()).entries
      const writer =
        scope === "task" && !sessionID
          ? managementSessionID
          : yield* Effect.try({ try: () => requireSession(scope, sessionID), catch: asError })
      const projectID = scope === "task" && sessionID ? yield* memory.resolveProjectID(sessionID) : undefined
      const store = yield* storage.read({ sessionID: writer, scope: storageScope(scope) })
      return store.entries.filter((entry) =>
        scope === "user"
          ? entry.scope === "user"
          : entry.scope === "memory" && (!sessionID || (entry.projectID ?? entry.sessionID) === projectID),
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
          !query
            ? true
            : `${entry.keywords.join(" ")} ${entry.content} ${entry.scope === "experience" ? entry.evidence : ""}`
                .normalize("NFKC")
                .toLowerCase()
                .includes(query),
        )
        .map((entry, index) => ({ entry, index }))
        .sort(
          (left, right) => (right.entry.date ?? "").localeCompare(left.entry.date ?? "") || right.index - left.index,
        )
        .map(({ entry }) => managed(entry))
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
      const entry = yield* storage.create({
        sessionID: managementSessionID,
        entry: {
          scope: "user",
          ...input,
          date: localDate(new Date()),
          importance: input.importance as Memory.Importance,
          keywords: [...input.keywords],
        },
      })
      return managed(entry) as UserEntry
    })

    const update = Effect.fn("MemoryManagement.update")(function* (
      input:
        | ({ scope: "user"; id: string } & EntryInput)
        | ({ scope: "task"; id: string | null; sessionID: SessionID } & EntryInput)
        | ({ scope: "experience"; id: string } & ExperienceInput),
    ) {
      if (input.scope === "experience") {
        const raw = yield* findExact("experience", input.id)
        if (raw.scope !== "experience") return yield* Effect.fail(new Error("Unexpected experience scope"))
        const expected = raw
        const replacement: ExperienceMemory.ExperienceEntry = {
          ...expected,
          kind: input.kind,
          importance: input.importance as Memory.Importance,
          keywords: [...input.keywords],
          content: input.content,
          confidence: input.confidence,
          updatedAt: localDate(new Date()),
        }
        return managed(yield* experience.managementUpdate({ expected, replacement }))
      }
      if (input.scope === "task" && input.id === null) {
        const projectID = yield* memory.resolveProjectID(input.sessionID)
        const entry = yield* storage.create({
          sessionID: input.sessionID,
          entry: {
            scope: "memory",
            sessionID: input.sessionID,
            projectID,
            date: localDate(new Date()),
            importance: input.importance as Memory.Importance,
            keywords: [...input.keywords],
            content: input.content,
          },
        })
        return managed(entry)
      }
      if (input.id === null) return yield* Effect.fail(new Error("Memory id is required"))
      const sessionID = input.scope === "task" ? input.sessionID : managementSessionID
      const expected = (yield* findExact(input.scope, input.id)) as Memory.MemoryEntry
      const replacement: Memory.MemoryEntry =
        expected.scope === "memory"
          ? {
              ...expected,
              importance: input.importance as Memory.Importance,
              keywords: [...input.keywords],
              content: input.content,
            }
          : {
              scope: "user",
              date: localDate(new Date()),
              importance: input.importance as Memory.Importance,
              keywords: [...input.keywords],
              content: input.content,
            }
      return managed(yield* storage.update({ sessionID, expected, replacement }))
    })

    const remove = Effect.fn("MemoryManagement.remove")(function* (input: {
      scope: Scope
      id: string
      sessionID?: SessionID
    }) {
      if (input.scope === "experience") {
        const raw = yield* findExact("experience", input.id)
        if (raw.scope !== "experience") return yield* Effect.fail(new Error("Unexpected experience scope"))
        const expected = raw
        yield* experience.managementRemove({ expected })
        return
      }
      const sessionID = input.sessionID ?? managementSessionID
      const expected = (yield* findExact(input.scope, input.id)) as Memory.MemoryEntry
      yield* storage.remove({ sessionID, expected })
    })

    const clearTask = Effect.fn("MemoryManagement.clearTask")(function* (input: { sessionID?: SessionID }) {
      if (input.sessionID) return yield* storage.clearTask({ sessionID: input.sessionID })
      const byProject = new Map<string, SessionID>()
      for (const entry of yield* entriesFor("task")) {
        if (entry.scope !== "memory") continue
        const key = entry.projectID ?? entry.sessionID
        if (!byProject.has(key)) byProject.set(key, entry.sessionID)
      }
      const removed = yield* Effect.forEach([...byProject.values()], (sessionID) => storage.clearTask({ sessionID }))
      return removed.reduce((total, count) => total + count, 0)
    })

    const compact = Effect.fn("MemoryManagement.compact")(function* (input: { scope: Scope; sessionID?: SessionID }) {
      if (input.scope === "experience") return yield* experience.managementCompact()
      if (input.scope === "task" && !input.sessionID) {
        const byProject = new Map<string, SessionID>()
        for (const entry of yield* entriesFor("task")) {
          if (entry.scope !== "memory") continue
          const key = entry.projectID ?? entry.sessionID
          if (!byProject.has(key)) byProject.set(key, entry.sessionID)
        }
        const results = yield* Effect.forEach([...byProject.values()], (sessionID) =>
          storage.compact({ sessionID, scope: "memory" }),
        )
        return results.reduce(
          (total, result) => ({
            removed: total.removed + result.removed,
            merged: total.merged + result.merged,
            retained: total.retained + result.retained,
          }),
          { removed: 0, merged: 0, retained: 0 },
        )
      }
      const sessionID = yield* Effect.try({ try: () => requireSession(input.scope, input.sessionID), catch: asError })
      const result = yield* storage.compact({ sessionID, scope: storageScope(input.scope) })
      return { removed: result.removed, merged: result.merged, retained: result.retained }
    })

    const exportStore = Effect.fn("MemoryManagement.exportStore")(function* (input: {
      scope: Scope
      sessionID?: SessionID
    }) {
      if (input.scope === "experience") {
        const store = yield* experience.managementRead()
        return ExperienceMemory.serializeExperienceStore(store.entries, store.lastMaintainedAt)
      }
      const scope = input.scope as Exclude<Scope, "experience">
      const entries = (yield* entriesFor(scope, input.sessionID)) as Memory.MemoryEntry[]
      return Memory.serializeStore(storageScope(scope), entries)
    })

    return Service.of({ list, createUser, update, remove, clearTask, compact, exportStore })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Memory.defaultLayer),
  Layer.provide(ExperienceMemory.defaultLayer),
)

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function localDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}${month}${day}`
}
