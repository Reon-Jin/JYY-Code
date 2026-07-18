export * as Memory from "./memory"

import path from "path"
import { randomUUID } from "crypto"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { EffectFlock } from "@jyycode-ai/core/util/effect-flock"
import { Context, Effect, Layer, Schema } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import * as Log from "@jyycode-ai/core/util/log"
const log = Log.create({ service: "memory" })

const MEMORY_FILE = "MEMORY.json"
const USER_FILE = "USER.json"
export const LEGACY_DIRECTORY = path.normalize("D:/jyycode/memory")
export const DIRECTORY = LEGACY_DIRECTORY
const MEMORY_CHAR_LIMIT = 10_000
const USER_CHAR_LIMIT = 2_000
const ENTRY_LIMIT = 50
const CAPACITY_WARN_THRESHOLD = 0.8
const COMPACTION_TARGET = 0.7
const COMPACTION_ENTRY_TARGET = 45
const SNAPSHOT_ENTRY_LIMIT = 10
const TASK_SECTION_CHAR_LIMIT = 30

export type Scope = "memory" | "user"
type Confidence = "low" | "medium" | "high"

export type Importance = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10

export type TaskMemoryEntry = {
  scope: "memory"
  importance: Importance
  date: string
  keywords: string[]
  content: string
  sessionID: SessionID
}

export type UserMemoryEntry = {
  scope: "user"
  importance: Importance
  date?: string
  keywords: string[]
  content: string
}

export type MemoryEntry = TaskMemoryEntry | UserMemoryEntry

export type MemoryStore = {
  schemaVersion: 3
  lastCompactedAt: string | null
  entries: MemoryEntry[]
}

export class MemoryWriteForbidden extends Schema.TaggedErrorClass<MemoryWriteForbidden>()("MemoryWriteForbidden", {
  sessionID: SessionID,
}) {
  override get message() {
    return `Subagent session ${this.sessionID} cannot mutate persistent memory`
  }
}

export function normalizeKeywords(keywords: readonly string[]): string[] {
  const normalized = keywords
    .map((keyword) => keyword.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase())
    .filter(Boolean)
  return [...new Set(normalized)]
}

export function parseStore(scope: Scope, text: string): MemoryStore {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid ${scope} JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const root = expectRecord(value, `${scope} store`)
  assertExactFields(root, ["schemaVersion", "lastCompactedAt", "entries"], `${scope} store`)
  if (root.schemaVersion !== 3) throw new Error(`Invalid ${scope} schemaVersion: expected 3`)
  if (
    root.lastCompactedAt !== null &&
    (typeof root.lastCompactedAt !== "string" || !isCalendarDate(root.lastCompactedAt))
  ) {
    throw new Error(`Invalid ${scope} lastCompactedAt`)
  }
  if (!Array.isArray(root.entries)) throw new Error(`Invalid ${scope} entries: expected an array`)

  const entries = root.entries.map((entry, index) => parseEntryObject(scope, entry, index))
  const keys = new Set<string>()
  for (const entry of entries) {
    const key = entryKey(entry)
    if (keys.has(key)) throw new Error(`Invalid ${scope} store: duplicate key ${key}`)
    keys.add(key)
  }
  return { schemaVersion: 3, lastCompactedAt: root.lastCompactedAt as string | null, entries }
}

export function serializeStore(
  scope: Scope,
  entries: readonly MemoryEntry[],
  lastCompactedAt: string | null = null,
): string {
  if (lastCompactedAt !== null && !isCalendarDate(lastCompactedAt)) throw new Error(`Invalid ${scope} lastCompactedAt`)
  const normalized = entries.map((entry, index) => {
    if (entry.scope !== scope) throw new Error(`Invalid ${scope} entry scope at index ${index}`)
    return normalizeEntry(entry)
  })
  const keys = new Set<string>()
  for (const entry of normalized) {
    const key = entryKey(entry)
    if (keys.has(key)) throw new Error(`Invalid ${scope} store: duplicate key ${key}`)
    keys.add(key)
  }
  const stored = normalized.map((entry) =>
    entry.scope === "memory"
      ? {
          sessionID: entry.sessionID,
          importance: entry.importance,
          date: entry.date,
          keywords: entry.keywords,
          content: entry.content,
        }
      : {
          importance: entry.importance,
          ...(entry.date ? { date: entry.date } : {}),
          keywords: entry.keywords,
          content: entry.content,
        },
  )
  return JSON.stringify({ schemaVersion: 3, lastCompactedAt, entries: stored }, null, 2) + "\n"
}

function parseEntryObject(scope: Scope, value: unknown, index: number): MemoryEntry {
  const entry = expectRecord(value, `${scope} entry ${index}`)
  if (scope === "memory") {
    assertExactFields(entry, ["sessionID", "importance", "date", "keywords", "content"], `memory entry ${index}`)
    return normalizeEntry({
      scope,
      sessionID: SessionID.make(expectString(entry.sessionID, "memory entry sessionID")),
      importance: parseImportance(entry.importance),
      date: expectString(entry.date, "memory entry date"),
      keywords: expectStringArray(entry.keywords, "memory entry keywords"),
      content: expectString(entry.content, "memory entry content"),
    })
  }
  assertExactFields(
    entry,
    ["importance", ...(entry.date === undefined ? [] : ["date"]), "keywords", "content"],
    `user entry ${index}`,
  )
  return normalizeEntry({
    scope,
    importance: parseImportance(entry.importance),
    ...(entry.date === undefined ? {} : { date: expectString(entry.date, "user entry date") }),
    keywords: expectStringArray(entry.keywords, "user entry keywords"),
    content: expectString(entry.content, "user entry content"),
  })
}

function normalizeEntry(entry: MemoryEntry): MemoryEntry {
  const importance = parseImportance(entry.importance)
  const keywords = validateKeywords(entry.keywords)
  const content = parseContent(entry.content)
  if (entry.scope === "memory") {
    if (!isCalendarDate(entry.date)) throw new Error(`Invalid memory entry date: ${entry.date}`)
    const sessionID = String(entry.sessionID).trim()
    if (!sessionID || /\s/u.test(sessionID)) throw new Error("Invalid memory entry sessionID")
    return { scope: "memory", sessionID: SessionID.make(sessionID), importance, date: entry.date, keywords, content }
  }
  if (entry.date !== undefined && !isCalendarDate(entry.date)) throw new Error(`Invalid user entry date: ${entry.date}`)
  return { scope: "user", importance, ...(entry.date ? { date: entry.date } : {}), keywords, content }
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}: expected object`)
  return value as Record<string, unknown>
}

function assertExactFields(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const allowed = new Set(expected)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  const missing = expected.filter((key) => !(key in value))
  if (unknown.length > 0) throw new Error(`Invalid ${label}: unknown field ${unknown[0]}`)
  if (missing.length > 0) throw new Error(`Invalid ${label}: missing field ${missing[0]}`)
}

function expectString(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`Invalid ${label}: expected string`)
  return value
}

function expectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid ${label}: expected string array`)
  }
  return value
}

export function entryKey(entry: MemoryEntry): string {
  if (entry.scope === "memory") return entry.sessionID
  return [...validateKeywords(entry.keywords)].sort().join("\u001f")
}

function parseImportance(value: unknown): Importance {
  const importance = Number(value)
  if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
    throw new Error(`Invalid memory entry importance: ${value}`)
  }
  return importance as Importance
}

function validateKeywords(value: readonly string[]): string[] {
  const keywords = normalizeKeywords(value)
  if (keywords.length === 0 || keywords.length > 3) {
    throw new Error("Invalid memory entry keywords: expected 1 to 3 non-empty keywords")
  }
  for (const keyword of keywords) {
    if (keyword.length < 2) throw new Error(`Invalid memory entry keyword "${keyword}": must be at least 2 characters`)
    if (keyword.length > 4) throw new Error(`Invalid memory entry keyword "${keyword}": must be at most 4 characters`)
  }
  return keywords
}

function parseContent(value: string): string {
  const content = value.trim()
  if (!content || /[\r\n]/u.test(content)) throw new Error("Invalid memory entry content")
  return content
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{8}$/u.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

type MemoryWriteInput = {
  sessionID: SessionID
  scope: Scope
  section: string
  content: string
  reason: string
  confidence?: Confidence
  source?: string
}

export type TaskMemoryUpsertInput = Omit<TaskMemoryEntry, "scope" | "date">
export type UserMemoryUpsertInput = Omit<UserMemoryEntry, "scope"> & { sessionID: SessionID }

export type MemoryCandidate = {
  importance: Importance
  keywords: string[]
  content: string
}

export type MemoryDecision = {
  shouldUpdate: boolean
  reason: string
  task: MemoryCandidate
  user: MemoryCandidate[]
}

export type MemoryUpdatePhase = "user" | "assistant"

export type DecisionInput = {
  sessionID: SessionID
  phase: MemoryUpdatePhase
  previousTaskContent?: string
  correction?: string
  userText: string
  assistantText: string
}

export type DecisionEvaluator = (input: DecisionInput) => Effect.Effect<unknown, unknown>

export type TurnText = {
  userText?: string
  assistantText?: string
}

export type AutomaticUpdateResult =
  | { status: "skipped"; reason: "subagent" | "no_user" | "no_assistant" }
  | { status: "updated"; taskUpdated: boolean; userUpdated: number }

export const MemoryDecisionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["shouldUpdate", "reason", "task", "user"],
  properties: {
    shouldUpdate: { const: true },
    reason: { type: "string", minLength: 1 },
    task: { $ref: "#/$defs/candidate" },
    user: { type: "array", items: { $ref: "#/$defs/candidate" } },
  },
  $defs: {
    candidate: {
      type: "object",
      additionalProperties: false,
      required: ["importance", "keywords", "content"],
      properties: {
        importance: { type: "integer", minimum: 1, maximum: 10 },
        keywords: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 2, maxLength: 4 } },
        content: { type: "string", minLength: 1 },
      },
    },
  },
} as const

export type MutationResult = {
  id?: string
  file?: string
  status: "written" | "duplicate" | "replaced" | "removed" | "compacted" | "capacity_rejected"
  message: string
}

export type CompactionResult = MutationResult & {
  status: "compacted"
  removed: number
  merged: number
  retained: number
  before: UsageInfo & { entries: number }
  after: UsageInfo & { entries: number }
}

export const SearchResult = Schema.Struct({
  file: Schema.String,
  section: Schema.String,
  line: Schema.Number,
  score: Schema.Number,
  text: Schema.String,
})
export type SearchResult = Schema.Schema.Type<typeof SearchResult>

export type UsageInfo = {
  percentage: number
  used: number
  limit: number
  scope: Scope
}

export interface Interface {
  readonly dir: (sessionID: SessionID) => Effect.Effect<string>
  readonly ensure: (sessionID: SessionID) => Effect.Effect<void, Error>
  readonly read: (input: { sessionID: SessionID; scope: Scope; section?: string }) => Effect.Effect<string, Error>
  readonly search: (input: {
    sessionID: SessionID
    query: string
    scope?: Scope | "all"
    limit?: number
  }) => Effect.Effect<SearchResult[], Error>
  readonly upsertTaskMemory: (input: TaskMemoryUpsertInput) => Effect.Effect<MutationResult, Error>
  readonly upsertUserMemory: (input: UserMemoryUpsertInput) => Effect.Effect<MutationResult, Error>
  readonly write: (input: MemoryWriteInput) => Effect.Effect<MutationResult, Error>
  readonly replaceBySubstring: (input: {
    sessionID: SessionID
    scope: Scope
    oldText: string
    newContent: string
    reason: string
  }) => Effect.Effect<MutationResult, Error>
  readonly removeBySubstring: (input: {
    sessionID: SessionID
    scope: Scope
    oldText: string
    reason: string
  }) => Effect.Effect<MutationResult, Error>
  readonly compact: (input: { sessionID: SessionID; scope: Scope }) => Effect.Effect<CompactionResult, Error>
  readonly usage: (sessionID: SessionID, scope: Scope) => Effect.Effect<UsageInfo, Error>
  readonly formatWithHeader: (sessionID: SessionID, scope: Scope) => Effect.Effect<string, Error>
  readonly updateAfterTurn: (
    sessionID: SessionID,
    evaluator?: DecisionEvaluator,
    turn?: TurnText,
  ) => Effect.Effect<AutomaticUpdateResult, Error>
  readonly updateStepBegin: (
    sessionID: SessionID,
    evaluatorOrTurn?: DecisionEvaluator | TurnText,
    turn?: TurnText,
  ) => Effect.Effect<AutomaticUpdateResult, Error>
  readonly managementRead?: (input: { sessionID: SessionID; scope: Scope }) => Effect.Effect<MemoryStore, Error>
  readonly managementCreate?: (input: { sessionID: SessionID; entry: MemoryEntry }) => Effect.Effect<MemoryEntry, Error>
  readonly managementUpdate?: (input: {
    sessionID: SessionID
    expected: MemoryEntry
    replacement: MemoryEntry
  }) => Effect.Effect<MemoryEntry, Error>
  readonly managementRemove?: (input: { sessionID: SessionID; expected: MemoryEntry }) => Effect.Effect<void, Error>
  readonly managementClearTask?: (input: { sessionID: SessionID }) => Effect.Effect<number, Error>
  readonly managementCompact?: (input: { sessionID: SessionID; scope: Scope }) => Effect.Effect<CompactionResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Memory") {}

const templates: Record<Scope, string> = {
  memory: serializeStore("memory", []),
  user: serializeStore("user", []),
}

const filenames: Record<Scope, string> = {
  memory: MEMORY_FILE,
  user: USER_FILE,
}

export const layerWithDirectory = (directory: string, options?: { legacyDirectory?: string }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const sessions = yield* Session.Service
      const flock = yield* EffectFlock.Service
      const memoryDirectory = path.normalize(directory)
      const legacyDirectory = options?.legacyDirectory ? path.normalize(options.legacyDirectory) : undefined

      const dir = Effect.fn("Memory.dir")(function* (_sessionID: SessionID) {
        return memoryDirectory
      })

      const filePath = Effect.fn("Memory.filePath")(function* (sessionID: SessionID, scope: Scope) {
        return path.join(yield* dir(sessionID), filenames[scope])
      })

      const assertPrimaryWriter = Effect.fn("Memory.assertPrimaryWriter")(function* (sessionID: SessionID) {
        const info = yield* sessions.get(sessionID)
        if (info.parentID !== undefined) return yield* Effect.fail(new MemoryWriteForbidden({ sessionID }))
      })

      const cleanupLegacyMdFiles = (memoryDir: string) =>
        Effect.forEach(
          legacyMdFiles,
          (filename) => fs.remove(path.join(memoryDir, filename), { force: true }).pipe(Effect.ignore),
          { discard: true },
        )

      const ensure = Effect.fn("Memory.ensure")(function* (sessionID: SessionID) {
        const memoryDir = yield* dir(sessionID)
        yield* fs.ensureDir(memoryDir).pipe(Effect.orDie)
        for (const scope of ["memory", "user"] as const) {
          const target = yield* filePath(sessionID, scope)
          const exists = yield* fs.existsSafe(target).pipe(Effect.orDie)
          if (!exists) {
            const legacyText = legacyDirectory
              ? yield* fs.readFileStringSafe(path.join(legacyDirectory, filenames[scope])).pipe(Effect.orDie)
              : undefined
            const initial = legacyText
              ? yield* Effect.try({
                  try: () => {
                    const store = parseStore(scope, legacyText)
                    return serializeStore(scope, store.entries, store.lastCompactedAt)
                  },
                  catch: (error) => asError(error),
                })
              : templates[scope]
            yield* fs.writeWithDirs(target, initial).pipe(Effect.orDie)
          }
        }
        // Clean up legacy .md files from the old memory system.
        yield* cleanupLegacyMdFiles(memoryDir)
      })

      const readFull = Effect.fn("Memory.readFull")(function* (sessionID: SessionID, scope: Scope) {
        yield* ensure(sessionID)
        return (yield* fs.readFileStringSafe(yield* filePath(sessionID, scope)).pipe(Effect.orDie)) ?? templates[scope]
      })

      const readStore = Effect.fn("Memory.readStore")(function* (sessionID: SessionID, scope: Scope) {
        const text = yield* readFull(sessionID, scope)
        return yield* Effect.try({ try: () => parseStore(scope, text), catch: (error) => asError(error) })
      })

      const writeFileAtomic = Effect.fn("Memory.writeFileAtomic")(function* (target: string, content: string) {
        const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`)
        yield* fs.writeFileString(temp, content).pipe(
          Effect.flatMap(() => fs.rename(temp, target)),
          Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore)),
          Effect.orDie,
        )
      })

      const writeFull = Effect.fn("Memory.writeFull")(function* (sessionID: SessionID, scope: Scope, text: string) {
        const target = yield* filePath(sessionID, scope)
        yield* writeFileAtomic(target, text.endsWith("\n") ? text : text + "\n")
      })

      const writeStore = Effect.fn("Memory.writeStore")(function* (
        sessionID: SessionID,
        scope: Scope,
        store: MemoryStore,
      ) {
        const text = yield* Effect.try({
          try: () => serializeStore(scope, store.entries, store.lastCompactedAt),
          catch: (error) => asError(error),
        })
        yield* writeFull(sessionID, scope, text)
      })

      const read = Effect.fn("Memory.read")(function* (input: {
        sessionID: SessionID
        scope: Scope
        section?: string
      }) {
        const store = yield* readStore(input.sessionID, input.scope)
        return serializeStore(input.scope, store.entries, store.lastCompactedAt)
      })

      const search = Effect.fn("Memory.search")(function* (input: {
        sessionID: SessionID
        query: string
        scope?: Scope | "all"
        limit?: number
      }) {
        yield* ensure(input.sessionID)
        const query = input.query.trim()
        if (!query) return []
        const scopes: Scope[] = input.scope && input.scope !== "all" ? [input.scope] : ["memory", "user"]
        const tokens = tokenize(query)
        const results: SearchResult[] = []

        for (const scope of scopes) {
          const sourceFile = yield* filePath(input.sessionID, scope)
          const store = yield* readStore(input.sessionID, scope)
          for (let i = 0; i < store.entries.length; i++) {
            const entry = store.entries[i]!
            const body = formatEntry(entry)
            const score = scoreEntry(tokens, entry)
            if (score <= 0) continue
            results.push({
              file: sourceFile,
              section: scope,
              line: i + 1,
              score,
              text: body,
            })
          }
        }

        return results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, input.limit ?? 8)
      })

      const audit = Effect.fn("Memory.audit")(function* (sessionID: SessionID, entry: Record<string, unknown>) {
        yield* appendAudit(sessionID, { time: new Date().toISOString(), ...entry }).pipe(
          Effect.catchCause((cause) => Effect.sync(() => log.error("failed to append memory audit", { cause }))),
        )
      })

      const upsertStructured = Effect.fn("Memory.upsertStructured")(function* (
        sessionID: SessionID,
        candidate: MemoryEntry,
      ) {
        yield* assertPrimaryWriter(sessionID)
        yield* ensure(sessionID)
        const scope = candidate.scope
        const targetFile = yield* filePath(sessionID, scope)
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(sessionID, scope)
            const deduplicated = scope === "user" ? deduplicateStoredUserEntries(store.entries) : null
            const entries = deduplicated ? [...deduplicated.entries] : [...store.entries]
            const normalized = normalizeEntry(candidate)
            if (looksSensitive(normalized.content)) {
              return yield* Effect.fail(new Error("Refusing to store sensitive memory content"))
            }
            const key = entryKey(normalized)
            const matchingIndexes = entries.flatMap((entry, index) => {
              if (entryKey(entry) === key) return [index]
              if (entry.scope !== "user" || normalized.scope !== "user") return []
              return equivalentUserFacts(entry, normalized) || sameUserProfileSlot(entry, normalized) ? [index] : []
            })
            const index = matchingIndexes[0] ?? -1
            const storedCandidate =
              normalized.scope === "user" && matchingIndexes.length > 0
                ? mergeUserCandidate(
                    normalized,
                    matchingIndexes.map((matchingIndex) => entries[matchingIndex]! as UserMemoryEntry),
                  )
                : normalized
            const status: "written" | "duplicate" | "replaced" =
              index === -1
                ? "written"
                : matchingIndexes.length === 1 && entriesEquivalent(entries[index]!, storedCandidate)
                  ? "duplicate"
                  : "replaced"

            if (status !== "duplicate" || (deduplicated?.removed ?? 0) > 0) {
              if (index === -1) entries.push(storedCandidate)
              else {
                for (const matchingIndex of matchingIndexes.slice(1).reverse()) entries.splice(matchingIndex, 1)
                entries[index] = storedCandidate
              }
              const projected = serializeStore(scope, entries, store.lastCompactedAt)
              const shouldCompact =
                projected.length >= charLimit(scope) * CAPACITY_WARN_THRESHOLD || entries.length > ENTRY_LIMIT
              if (shouldCompact) {
                const outcome = compactEntrySet(store, scope, entries)
                const retained = containsCandidate(outcome.entries, storedCandidate)
                if (!retained || outcome.after.used > outcome.after.limit || outcome.after.entries > ENTRY_LIMIT) {
                  yield* audit(sessionID, {
                    writerSessionID: sessionID,
                    writerKind: "primary",
                    action: "memory.capacity_rejected",
                    scope,
                    key,
                    before: outcome.before,
                    after: outcome.after,
                    reason: "Candidate could not be retained within hard capacity limits.",
                  })
                  return {
                    file: targetFile,
                    status: "capacity_rejected" as const,
                    message: `Memory candidate rejected at capacity.\nFile: ${targetFile}`,
                  }
                }
                yield* writeFull(sessionID, scope, outcome.text)
                yield* audit(sessionID, {
                  writerSessionID: sessionID,
                  writerKind: "primary",
                  action: "memory.compact",
                  scope,
                  removed: outcome.removed,
                  merged: outcome.merged,
                  before: outcome.before,
                  after: outcome.after,
                  reason: "Automatic threshold compaction before upsert.",
                })
              } else {
                yield* writeFull(sessionID, scope, projected)
              }
            }
            yield* audit(sessionID, {
              writerSessionID: sessionID,
              writerKind: "primary",
              action: `memory.${status}`,
              scope,
              key,
              reason:
                status === "duplicate"
                  ? "Equivalent structured entry already exists."
                  : normalized.scope === "user" && matchingIndexes.length > 0
                    ? "Equivalent user fact consolidated during structured memory upsert."
                    : "Structured memory upsert.",
            })
            return {
              file: targetFile,
              status,
              message:
                status === "duplicate"
                  ? `Duplicate memory already exists.\nFile: ${targetFile}`
                  : `Memory ${status === "written" ? "written" : "updated"}.\nFile: ${targetFile}`,
            }
          }),
          targetFile,
        )
      })

      const upsertTaskMemory = Effect.fn("Memory.upsertTaskMemory")(function* (input: TaskMemoryUpsertInput) {
        const content = yield* Effect.try({
          try: () => validateTaskContent(input.content),
          catch: (error) => asError(error),
        })
        return yield* upsertStructured(input.sessionID, {
          scope: "memory",
          importance: input.importance,
          date: localDate(new Date()),
          keywords: input.keywords,
          content,
          sessionID: input.sessionID,
        })
      })

      const upsertUserMemory = Effect.fn("Memory.upsertUserMemory")(function* (input: UserMemoryUpsertInput) {
        return yield* upsertStructured(input.sessionID, {
          scope: "user",
          importance: input.importance,
          date: localDate(new Date()),
          keywords: input.keywords,
          content: input.content,
        })
      })

      const write = Effect.fn("Memory.write")(function* (input: MemoryWriteInput) {
        yield* assertPrimaryWriter(input.sessionID)
        const clean = sanitizeContent(input.content)
        if (!clean) return yield* Effect.fail(new Error("Memory content is empty"))
        if (looksSensitive(clean)) return yield* Effect.fail(new Error("Refusing to store sensitive memory content"))
        const importance = confidenceImportance(input.confidence)
        const sectionKeyword = (input.section || (input.scope === "memory" ? "任务成果" : "用户事实")).slice(0, 4)
        const keywords = validateKeywords([sectionKeyword])
        const result =
          input.scope === "memory"
            ? yield* upsertTaskMemory({ sessionID: input.sessionID, importance, keywords, content: clean })
            : yield* upsertUserMemory({ sessionID: input.sessionID, importance, keywords, content: clean })
        yield* audit(input.sessionID, {
          action: "memory.write",
          scope: input.scope,
          section: input.section,
          content: clean,
          reason: input.reason,
          result: result.status,
        })
        return result
      })

      const replaceBySubstring = Effect.fn("Memory.replaceBySubstring")(function* (input: {
        sessionID: SessionID
        scope: Scope
        oldText: string
        newContent: string
        reason: string
      }) {
        yield* assertPrimaryWriter(input.sessionID)
        yield* ensure(input.sessionID)
        const clean = sanitizeContent(input.newContent)
        if (!clean) return yield* Effect.fail(new Error("Memory content is empty"))
        if (looksSensitive(clean)) return yield* Effect.fail(new Error("Refusing to store sensitive memory content"))
        if (input.scope === "memory") {
          yield* Effect.try({ try: () => validateTaskContent(clean), catch: (error) => asError(error) })
        }

        const targetFile = yield* filePath(input.sessionID, input.scope)
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(input.sessionID, input.scope)
            const { match, error } = findEntryBySubstring(store.entries, input.oldText)
            if (error) return yield* Effect.fail(new Error(error))
            const entries = [...store.entries]
            entries[match!.index] = normalizeEntry({ ...entries[match!.index]!, content: clean })
            const projected = serializeStore(input.scope, entries, store.lastCompactedAt)
            if (projected.length > charLimit(input.scope)) {
              return yield* Effect.fail(
                new Error(`Memory replacement exceeds the ${charLimit(input.scope)} char limit`),
              )
            }
            yield* writeFull(input.sessionID, input.scope, projected)
            yield* audit(input.sessionID, {
              action: "memory.replace",
              scope: input.scope,
              oldText: input.oldText,
              newContent: clean,
              reason: input.reason,
            })
            return { file: targetFile, status: "replaced" as const, message: `Memory replaced.\nFile: ${targetFile}` }
          }),
          targetFile,
        )
      })

      const removeBySubstring = Effect.fn("Memory.removeBySubstring")(function* (input: {
        sessionID: SessionID
        scope: Scope
        oldText: string
        reason: string
      }) {
        yield* assertPrimaryWriter(input.sessionID)
        yield* ensure(input.sessionID)
        const targetFile = yield* filePath(input.sessionID, input.scope)
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(input.sessionID, input.scope)
            const { match, error } = findEntryBySubstring(store.entries, input.oldText)
            if (error) return yield* Effect.fail(new Error(error))
            const entries = store.entries.filter((_, index) => index !== match!.index)
            yield* writeStore(input.sessionID, input.scope, { ...store, entries })
            yield* audit(input.sessionID, {
              action: "memory.remove",
              scope: input.scope,
              oldText: input.oldText,
              reason: input.reason,
            })
            return { file: targetFile, status: "removed" as const, message: `Memory removed.\nFile: ${targetFile}` }
          }),
          targetFile,
        )
      })

      const compact = Effect.fn("Memory.compact")(function* (input: { sessionID: SessionID; scope: Scope }) {
        yield* assertPrimaryWriter(input.sessionID)
        yield* ensure(input.sessionID)
        const targetFile = yield* filePath(input.sessionID, input.scope)
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(input.sessionID, input.scope)
            const outcome = compactEntrySet(store, input.scope, store.entries)
            if (outcome.after.used > outcome.after.limit || outcome.after.entries > ENTRY_LIMIT) {
              return yield* Effect.fail(new Error(`Memory cannot be compacted within hard limits for ${input.scope}`))
            }
            yield* writeFull(input.sessionID, input.scope, outcome.text)
            yield* audit(input.sessionID, {
              writerSessionID: input.sessionID,
              writerKind: "primary",
              action: "memory.compact",
              scope: input.scope,
              removed: outcome.removed,
              merged: outcome.merged,
              before: outcome.before,
              after: outcome.after,
              reason: "Manual deterministic compaction.",
            })
            return {
              file: targetFile,
              status: "compacted" as const,
              message: `Memory compacted.\nFile: ${targetFile}`,
              removed: outcome.removed,
              merged: outcome.merged,
              retained: outcome.entries.length,
              before: outcome.before,
              after: outcome.after,
            }
          }),
          targetFile,
        )
      })

      const managementRead = Effect.fn("Memory.managementRead")(function* (input: {
        sessionID: SessionID
        scope: Scope
      }) {
        yield* ensure(input.sessionID)
        return yield* readStore(input.sessionID, input.scope)
      })

      const validateManagementEntry = (entry: MemoryEntry) => {
        const normalized = normalizeEntry(entry)
        if (looksSensitive(normalized.content)) throw new Error("Refusing to store sensitive memory content")
        if (normalized.scope === "memory") validateTaskContent(normalized.content)
        return normalized
      }

      const writeManagedEntries = Effect.fn("Memory.writeManagedEntries")(function* (
        sessionID: SessionID,
        scope: Scope,
        store: MemoryStore,
        entries: MemoryEntry[],
        action: string,
      ) {
        const projected = serializeStore(scope, entries, store.lastCompactedAt)
        if (projected.length > charLimit(scope) || entries.length > ENTRY_LIMIT) {
          return yield* Effect.fail(new Error(`Memory management write exceeds hard capacity limits for ${scope}`))
        }
        yield* writeFull(sessionID, scope, projected)
        yield* audit(sessionID, {
          writerSessionID: sessionID,
          writerKind: "desktop-management",
          action,
          scope,
        })
      })

      const managementCreate = Effect.fn("Memory.managementCreate")(function* (input: {
        sessionID: SessionID
        entry: MemoryEntry
      }) {
        yield* ensure(input.sessionID)
        const entry = yield* Effect.try({ try: () => validateManagementEntry(input.entry), catch: asError })
        const target = yield* filePath(input.sessionID, entry.scope)
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(input.sessionID, entry.scope)
            if (store.entries.some((candidate) => entryKey(candidate) === entryKey(entry))) {
              return yield* Effect.fail(new Error("Memory entry already exists"))
            }
            yield* writeManagedEntries(input.sessionID, entry.scope, store, [...store.entries, entry], "memory.management.create")
            return entry
          }),
          target,
        )
      })

      const managementUpdate = Effect.fn("Memory.managementUpdate")(function* (input: {
        sessionID: SessionID
        expected: MemoryEntry
        replacement: MemoryEntry
      }) {
        yield* ensure(input.sessionID)
        if (input.expected.scope !== input.replacement.scope) return yield* Effect.fail(new Error("Memory scope mismatch"))
        const replacement = yield* Effect.try({ try: () => validateManagementEntry(input.replacement), catch: asError })
        const target = yield* filePath(input.sessionID, input.expected.scope)
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(input.sessionID, input.expected.scope)
            const index = store.entries.findIndex((entry) => entriesEquivalent(entry, input.expected))
            if (index === -1) return yield* Effect.fail(new Error("Memory entry is missing or stale"))
            const duplicate = store.entries.findIndex(
              (entry, candidateIndex) => candidateIndex !== index && entryKey(entry) === entryKey(replacement),
            )
            if (duplicate !== -1) return yield* Effect.fail(new Error("Memory entry conflicts with an existing entry"))
            const entries = [...store.entries]
            entries[index] = replacement
            yield* writeManagedEntries(input.sessionID, input.expected.scope, store, entries, "memory.management.update")
            return replacement
          }),
          target,
        )
      })

      const managementRemove = Effect.fn("Memory.managementRemove")(function* (input: {
        sessionID: SessionID
        expected: MemoryEntry
      }) {
        yield* ensure(input.sessionID)
        const target = yield* filePath(input.sessionID, input.expected.scope)
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(input.sessionID, input.expected.scope)
            const index = store.entries.findIndex((entry) => entriesEquivalent(entry, input.expected))
            if (index === -1) return yield* Effect.fail(new Error("Memory entry is missing or stale"))
            const entries = store.entries.filter((_, candidateIndex) => candidateIndex !== index)
            yield* writeManagedEntries(input.sessionID, input.expected.scope, store, entries, "memory.management.remove")
          }),
          target,
        )
      })

      const managementClearTask = Effect.fn("Memory.managementClearTask")(function* (input: { sessionID: SessionID }) {
        yield* ensure(input.sessionID)
        const target = yield* filePath(input.sessionID, "memory")
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(input.sessionID, "memory")
            const entries = store.entries.filter(
              (entry) => entry.scope !== "memory" || entry.sessionID !== input.sessionID,
            )
            const removed = store.entries.length - entries.length
            yield* writeManagedEntries(input.sessionID, "memory", store, entries, "memory.management.clear_task")
            return removed
          }),
          target,
        )
      })

      const managementCompact = Effect.fn("Memory.managementCompact")(function* (input: {
        sessionID: SessionID
        scope: Scope
      }) {
        yield* ensure(input.sessionID)
        const targetFile = yield* filePath(input.sessionID, input.scope)
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(input.sessionID, input.scope)
            const source =
              input.scope === "memory"
                ? store.entries.filter(
                    (entry) => entry.scope === "memory" && entry.sessionID === input.sessionID,
                  )
                : store.entries
            const untouched = input.scope === "memory" ? store.entries.filter((entry) => !source.includes(entry)) : []
            const outcome = compactEntrySet(store, input.scope, source)
            const entries = input.scope === "memory" ? [...untouched, ...outcome.entries] : outcome.entries
            yield* writeManagedEntries(input.sessionID, input.scope, store, entries, "memory.management.compact")
            return {
              file: targetFile,
              status: "compacted" as const,
              message: "Memory compacted.",
              removed: outcome.removed,
              merged: outcome.merged,
              retained: outcome.entries.length,
              before: outcome.before,
              after: outcome.after,
            }
          }),
          targetFile,
        )
      })

      const usage = Effect.fn("Memory.usage")(function* (sessionID: SessionID, scope: Scope) {
        yield* ensure(sessionID)
        const store = yield* readStore(sessionID, scope)
        return computeUsage(serializeStore(scope, store.entries, store.lastCompactedAt), scope)
      })

      const formatWithHeader = Effect.fn("Memory.formatWithHeader")(function* (sessionID: SessionID, scope: Scope) {
        yield* ensure(sessionID)
        const store = yield* readStore(sessionID, scope)
        const text = formatEntries(store.entries.slice().sort(compareSnapshotEntries).slice(0, SNAPSHOT_ENTRY_LIMIT))
        const serialized = serializeStore(scope, store.entries, store.lastCompactedAt)
        return formatMemoryHeader(scope, serialized) + text
      })

      const currentTaskContent = Effect.fn("Memory.currentTaskContent")(function* (sessionID: SessionID) {
        const store = yield* readStore(sessionID, "memory")
        const entry = store.entries.find(
          (candidate): candidate is TaskMemoryEntry =>
            candidate.scope === "memory" && candidate.sessionID === sessionID,
        )
        return entry?.content
      })

      const evaluateSemanticUpdate = Effect.fn("Memory.evaluateSemanticUpdate")(function* (
        evaluator: DecisionEvaluator | undefined,
        input: DecisionInput,
      ) {
        if (!evaluator) return yield* Effect.fail(new Error("Semantic memory evaluator is required"))
        let correction = input.correction
        let lastError = new Error("Semantic memory decision validation failed")
        for (let attempt = 0; attempt < 2; attempt++) {
          const evaluated = yield* evaluator({ ...input, ...(correction ? { correction } : {}) }).pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error: asError(error) })),
          )
          if (!evaluated.ok) {
            lastError = evaluated.error
            correction = lastError.message
            continue
          }
          try {
            const decision = parseDecision(evaluated.value)
            const content = validateTaskContentForPhase(decision.task.content, input.phase)
            return { ...decision, task: { ...decision.task, content } }
          } catch (error) {
            lastError = asError(error)
            correction = lastError.message
          }
        }
        return yield* Effect.fail(lastError)
      })

      const updateAfterTurn = Effect.fn("Memory.updateAfterTurn")(function* (
        sessionID: SessionID,
        evaluator?: DecisionEvaluator,
        turn?: TurnText,
      ) {
        const info = yield* sessions.get(sessionID).pipe(Effect.orDie)
        if (info.parentID !== undefined) {
          yield* audit(sessionID, {
            writerSessionID: sessionID,
            writerKind: "subagent",
            action: "memory.skipped",
            reason: "subagent",
          })
          return { status: "skipped" as const, reason: "subagent" as const }
        }
        yield* ensure(sessionID)
        const suppliedUserText = sanitizeContent(turn?.userText ?? "")
        const suppliedAssistantText = sanitizeContent(turn?.assistantText ?? "")
        const msgs =
          suppliedUserText && suppliedAssistantText ? [] : yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
        const userText = suppliedUserText || latestRealMessageText(msgs, "user")
        if (!userText) return { status: "skipped" as const, reason: "no_user" as const }
        // Find the last assistant message with non-synthetic text content.
        // In cluster mode the immediate child of the original user message is the
        // planning response — we want the final synthesis, which is always the
        // chronologically last assistant with real text.
        const assistantText = suppliedAssistantText || latestRealMessageText(msgs, "assistant")
        if (!assistantText) return { status: "skipped" as const, reason: "no_assistant" as const }

        const decision = yield* evaluateSemanticUpdate(evaluator, {
          sessionID,
          phase: "assistant",
          previousTaskContent: yield* currentTaskContent(sessionID),
          userText,
          assistantText,
        })
        const taskResult = yield* upsertTaskMemory({ sessionID, ...decision.task })
        if (taskResult.status === "capacity_rejected") {
          return yield* Effect.fail(new Error("Mandatory semantic task memory update was rejected at capacity"))
        }
        const userResults = yield* Effect.forEach(decision.user, (candidate) =>
          upsertUserMemory({ sessionID, ...candidate }),
        )
        yield* audit(sessionID, {
          writerSessionID: sessionID,
          writerKind: info.multiAgent ? "planner" : "primary",
          action: "memory.semantic_completion_update",
          taskStatus: taskResult.status,
          userStatuses: userResults.map((result) => result.status),
          reason: decision.reason,
        })
        return { status: "updated" as const, taskUpdated: true, userUpdated: userResults.length }
      })

      const updateStepBegin = Effect.fn("Memory.updateStepBegin")(function* (
        sessionID: SessionID,
        evaluatorOrTurn?: DecisionEvaluator | TurnText,
        turn?: TurnText,
      ) {
        const info = yield* sessions.get(sessionID).pipe(Effect.orDie)
        if (info.parentID !== undefined) {
          yield* audit(sessionID, {
            writerSessionID: sessionID,
            writerKind: "subagent",
            action: "memory.step_begin_skipped",
            reason: "subagent",
          })
          return { status: "skipped" as const, reason: "subagent" as const }
        }
        yield* ensure(sessionID)
        const evaluator = typeof evaluatorOrTurn === "function" ? evaluatorOrTurn : undefined
        const suppliedTurn = typeof evaluatorOrTurn === "function" ? turn : evaluatorOrTurn
        const suppliedUserText = sanitizeContent(suppliedTurn?.userText ?? "")
        const msgs = suppliedUserText ? [] : yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
        const userText = suppliedUserText || latestRealMessageText(msgs, "user")
        if (!userText) return { status: "skipped" as const, reason: "no_user" as const }

        const decision = yield* evaluateSemanticUpdate(evaluator, {
          sessionID,
          phase: "user",
          previousTaskContent: yield* currentTaskContent(sessionID),
          userText,
          assistantText: "",
        })
        const taskResult = yield* upsertTaskMemory({ sessionID, ...decision.task })
        if (taskResult.status === "capacity_rejected") {
          return yield* Effect.fail(new Error("Mandatory semantic task memory update was rejected at capacity"))
        }
        const userResults = yield* Effect.forEach(decision.user, (candidate) =>
          upsertUserMemory({ sessionID, ...candidate }),
        )
        yield* audit(sessionID, {
          writerSessionID: sessionID,
          writerKind: info.multiAgent ? "planner" : "primary",
          action: "memory.semantic_user_update",
          taskStatus: taskResult.status,
          userStatuses: userResults.map((result) => result.status),
          reason: decision.reason,
        })
        return { status: "updated" as const, taskUpdated: true, userUpdated: userResults.length }
      })

      const appendAudit = Effect.fn("Memory.appendAudit")(function* (
        sessionID: SessionID,
        entry: Record<string, unknown>,
      ) {
        const target = path.join(yield* dir(sessionID), "audit.jsonl")
        yield* fs.ensureDir(path.dirname(target)).pipe(Effect.orDie)
        yield* flock.withLock(
          Effect.gen(function* () {
            const current = (yield* fs.readFileStringSafe(target).pipe(Effect.orDie)) ?? ""
            yield* writeFileAtomic(target, current + JSON.stringify(entry) + "\n")
          }),
          target,
        )
      })

      return Service.of({
        dir,
        ensure,
        read,
        search,
        upsertTaskMemory,
        upsertUserMemory,
        write,
        replaceBySubstring,
        removeBySubstring,
        compact,
        usage,
        formatWithHeader,
        updateAfterTurn,
        updateStepBegin,
        managementRead,
        managementCreate,
        managementUpdate,
        managementRemove,
        managementClearTask,
        managementCompact,
      })
    }),
  ).pipe(Layer.provide(EffectFlock.defaultLayer))

export const layer = layerWithDirectory(DIRECTORY)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(Session.defaultLayer))

type CompactOutcome = {
  entries: MemoryEntry[]
  text: string
  removed: number
  merged: number
  before: UsageInfo & { entries: number }
  after: UsageInfo & { entries: number }
}

function compactEntrySet(store: MemoryStore, scope: Scope, source: readonly MemoryEntry[]): CompactOutcome {
  const beforeText = serializeStore(scope, source, store.lastCompactedAt)
  const before = usageWithEntries(beforeText, scope, source.length)
  const entries: MemoryEntry[] = []
  let removed = 0
  let merged = 0

  for (const entry of source) {
    const exact = entries.findIndex(
      (item) => JSON.stringify(normalizeEntry(item)) === JSON.stringify(normalizeEntry(entry)),
    )
    if (exact !== -1) {
      removed++
      continue
    }
    const sameKey = entries.findIndex((item) => entryKey(item) === entryKey(entry))
    if (sameKey !== -1) {
      entries[sameKey] = mergeEntries(entries[sameKey]!, entry)
      merged++
      continue
    }
    entries.push(entry)
  }

  for (let left = 0; left < entries.length; left++) {
    for (let right = entries.length - 1; right > left; right--) {
      if (!entriesAreSimilar(entries[left]!, entries[right]!)) continue
      entries[left] = mergeEntries(entries[left]!, entries[right]!)
      entries.splice(right, 1)
      merged++
    }
  }

  for (let index = 0; index < entries.length; index++) {
    entries[index] = { ...entries[index]!, content: refineContent(entries[index]!.content) }
  }

  const targetChars = Math.floor(charLimit(scope) * COMPACTION_TARGET)
  const keywordReuse = new Map<string, number>()
  for (const entry of entries) {
    for (const keyword of entry.keywords) keywordReuse.set(keyword, (keywordReuse.get(keyword) ?? 0) + 1)
  }
  const retention = (entry: MemoryEntry, index: number) => {
    const reuse = entry.keywords.reduce((sum, keyword) => sum + (keywordReuse.get(keyword) ?? 0), 0)
    const recency = entry.scope === "memory" ? dateRecency(entry.date) : 0
    return entry.importance * 100 + recency + reuse * 5 + index / 1_000
  }

  while (entries.length > 0) {
    const text = serializeStore(scope, entries, localDate(new Date()))
    if (text.length <= targetChars && entries.length <= COMPACTION_ENTRY_TARGET) break
    const candidates = entries
      .map((entry, index) => ({ entry, index, score: retention(entry, index) }))
      .filter(({ entry }) => !(entry.scope === "user" && entry.importance >= 9))
      .sort((a, b) => a.score - b.score || a.index - b.index)
    const evicted = candidates[0]
    if (!evicted) break
    entries.splice(evicted.index, 1)
    removed++
  }

  const text = serializeStore(scope, entries, localDate(new Date()))
  return {
    entries,
    text,
    removed,
    merged,
    before,
    after: usageWithEntries(text, scope, entries.length),
  }
}

function entriesAreSimilar(left: MemoryEntry, right: MemoryEntry): boolean {
  if (left.scope !== right.scope) return false
  if (left.scope === "user" && right.scope === "user") return equivalentUserFacts(left, right)
  const leftKeys = new Set(left.keywords)
  const rightKeys = new Set(right.keywords)
  const intersection = [...leftKeys].filter((keyword) => rightKeys.has(keyword)).length
  const union = new Set([...leftKeys, ...rightKeys]).size
  if (union > 0 && intersection / union >= 0.6) return true
  return false
}

type UserProfileFact = {
  slot: "name" | "birthday"
  value: string
}

function userProfileFact(content: string): UserProfileFact | null {
  const normalized = content.normalize("NFKC").trim()
  const chineseName = normalized.match(
    /(?:用户(?:的)?)?(?:姓名|名字|称呼|用户名)\s*(?:是|为|叫|[:：=])\s*([^，。；;.!?！？]{1,40}?)(?=[，。；;.!?！？]|$)/iu,
  )
  const englishName = normalized.match(
    /\buser(?:'s)?\s+name\s*(?:is|[:=])\s*([^，。；;.!?！？]{1,40}?)(?=[，。；;.!?！？]|$)/iu,
  )
  const name = canonicalProfileValue(chineseName?.[1] ?? englishName?.[1] ?? "")
  if (name) return { slot: "name", value: name }

  const birthday = normalized.match(
    /(?:用户(?:的)?)?(?:生日|出生日期)|\buser(?:'s)?\s+(?:birthday|date\s+of\s+birth)\b/iu,
  )
  if (!birthday) return null
  const date = normalized.match(/(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/u)
  if (!date) return null
  return { slot: "birthday", value: `${date[1]}-${date[2]!.padStart(2, "0")}-${date[3]!.padStart(2, "0")}` }
}

function canonicalProfileValue(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s"'“”‘’.,，。:：;；!?！？_-]+/gu, "")
}

function canonicalUserContent(content: string) {
  return content
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s"'“”‘’.,，。:：;；!?！？_-]+/gu, "")
}

function equivalentUserFacts(left: UserMemoryEntry, right: UserMemoryEntry) {
  const leftProfile = userProfileFact(left.content)
  const rightProfile = userProfileFact(right.content)
  if (leftProfile && rightProfile) {
    return leftProfile.slot === rightProfile.slot && leftProfile.value === rightProfile.value
  }
  return canonicalUserContent(left.content) === canonicalUserContent(right.content)
}

function sameUserProfileSlot(left: UserMemoryEntry, right: UserMemoryEntry) {
  const leftProfile = userProfileFact(left.content)
  const rightProfile = userProfileFact(right.content)
  return !!leftProfile && !!rightProfile && leftProfile.slot === rightProfile.slot
}

function mergeUserCandidate(candidate: UserMemoryEntry, matches: readonly UserMemoryEntry[]): UserMemoryEntry {
  return {
    ...candidate,
    importance: Math.max(candidate.importance, ...matches.map((entry) => entry.importance)) as Importance,
    keywords: normalizeKeywords([...candidate.keywords, ...matches.flatMap((entry) => entry.keywords)]).slice(0, 3),
  }
}

function deduplicateStoredUserEntries(source: readonly MemoryEntry[]) {
  const entries: MemoryEntry[] = []
  let removed = 0
  for (const entry of source) {
    if (entry.scope !== "user") {
      entries.push(entry)
      continue
    }
    const index = entries.findIndex(
      (existing) => existing.scope === "user" && equivalentUserFacts(existing, entry),
    )
    if (index === -1) {
      entries.push(entry)
      continue
    }
    entries[index] = mergeEntries(entries[index]!, entry)
    removed++
  }
  return { entries, removed }
}

function mergeEntries(left: MemoryEntry, right: MemoryEntry): MemoryEntry {
  const preferred = preferredEntry(left, right)
  const other = preferred === left ? right : left
  const keywords = normalizeKeywords([...preferred.keywords, ...other.keywords]).slice(0, 3)
  const content = preferred.content.length >= other.content.length ? preferred.content : other.content
  if (preferred.scope === "memory") {
    return {
      ...preferred,
      importance: Math.max(left.importance, right.importance) as Importance,
      keywords,
      content,
      date: left.scope === "memory" && right.scope === "memory" && left.date > right.date ? left.date : preferred.date,
    }
  }
  return { ...preferred, importance: Math.max(left.importance, right.importance) as Importance, keywords, content }
}

function preferredEntry(left: MemoryEntry, right: MemoryEntry): MemoryEntry {
  if (left.scope === "memory" && right.scope === "memory") {
    if (left.date !== right.date) return left.date > right.date ? left : right
    if (left.importance !== right.importance) return left.importance > right.importance ? left : right
  }
  return right
}

function refineContent(content: string): string {
  const compact = content.replace(/\s+/gu, " ").trim()
  return compact.length <= 120 ? compact : compact.slice(0, 119).trimEnd() + "…"
}

function dateRecency(date: string): number {
  const parsed = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)))
  const days = Math.max(0, Math.floor((Date.now() - parsed) / 86_400_000))
  return Math.max(0, 30 - Math.min(30, days))
}

function usageWithEntries(text: string, scope: Scope, entries: number): UsageInfo & { entries: number } {
  return { ...computeUsage(text, scope), entries }
}

function entriesEquivalent(left: MemoryEntry, right: MemoryEntry): boolean {
  if (left.scope !== right.scope) return false
  if (left.importance !== right.importance || left.content !== right.content) return false
  if (entryKey(left) !== entryKey(right)) return false
  if (left.keywords.join("\u001f") !== right.keywords.join("\u001f")) return false
  return left.scope === "user" || (right.scope === "memory" && left.sessionID === right.sessionID)
}

function containsCandidate(entries: readonly MemoryEntry[], candidate: MemoryEntry): boolean {
  if (candidate.scope === "memory") {
    return entries.some((entry) => entry.scope === "memory" && entry.sessionID === candidate.sessionID)
  }
  return entries.some(
    (entry) => entry.scope === "user" && candidate.keywords.every((keyword) => entry.keywords.includes(keyword)),
  )
}

const legacyMdFiles = ["MEMORY.md", "USER.md"]

function localDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0")
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}${month}${day}`
}

function charLimit(scope: Scope) {
  return scope === "user" ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT
}

function computeUsage(text: string, scope: Scope): UsageInfo {
  const limit = charLimit(scope)
  const used = text.length
  const percentage = Math.round((used / limit) * 100)
  return { percentage, used, limit, scope }
}

function formatMemoryHeader(scope: Scope, text: string) {
  const { percentage, used, limit } = computeUsage(text, scope)
  const label = scope === "user" ? "USER PROFILE (your preferences)" : "MEMORY (your personal notes)"
  const left = `${label} [${percentage}% — ${used}/${limit} chars]`
  const totalWidth = 64
  const padLeft = Math.max(2, Math.floor((totalWidth - left.length) / 2))
  const line = "═".repeat(padLeft) + " " + left + " " + "═".repeat(Math.max(0, totalWidth - padLeft - left.length - 1))
  return `\n${line}\n`
}

function tokenize(input: string) {
  const ascii = input
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/)
    .filter((item) => item.length >= 2)
  const cjk = Array.from(input.matchAll(/[\p{Script=Han}]{2,}/gu)).map((match) => match[0])
  return [...new Set([...ascii, ...cjk])]
}

function scoreEntry(tokens: string[], entry: MemoryEntry) {
  const lower = `${entry.keywords.join(" ")} ${entry.content}`.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (lower.includes(token.toLowerCase())) score += token.length > 3 ? 2 : 1
  }
  return score + Math.max(0, entry.importance - 5) / 10
}

function formatEntry(entry: MemoryEntry) {
  const fields = [`importance=${entry.importance}`, `keywords=${entry.keywords.join(", ")}`, `content=${entry.content}`]
  if (entry.scope === "memory") fields.splice(1, 0, `date=${entry.date}`, `sessionID=${entry.sessionID}`)
  else if (entry.date) fields.splice(1, 0, `date=${entry.date}`)
  return fields.join(" | ")
}

function formatEntries(entries: readonly MemoryEntry[]) {
  if (entries.length === 0) return "(no persistent memory entries)\n"
  return entries.map((entry) => `- ${formatEntry(entry)}`).join("\n") + "\n"
}

function compareSnapshotEntries(left: MemoryEntry, right: MemoryEntry) {
  if (left.importance !== right.importance) return right.importance - left.importance
  if (left.scope === "memory" && right.scope === "memory" && left.date !== right.date) {
    return right.date.localeCompare(left.date)
  }
  return entryKey(left).localeCompare(entryKey(right))
}

function textContent(message: MessageV2.WithParts, options: { synthetic: boolean }) {
  return message.parts
    .flatMap((part) => {
      if (part.type !== "text") return []
      if ((part.synthetic ?? false) !== options.synthetic) return []
      return [part.text]
    })
    .join("\n")
    .trim()
}

function latestRealMessageText(messages: readonly MessageV2.WithParts[], role: "user" | "assistant") {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.info.role !== role) continue
    const text = textContent(message, { synthetic: false })
    if (text) return text
  }
  return ""
}

function sanitizeContent(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function normalizedContent(input: string) {
  return sanitizeContent(input).toLowerCase()
}

type EntryInfo = { index: number; text: string }

function findEntryBySubstring(entries: readonly MemoryEntry[], substring: string) {
  const normalized = normalizedContent(substring)
  const matches: EntryInfo[] = entries.flatMap((entry, index) =>
    normalizedContent(entry.content).includes(normalized) ? [{ index, text: entry.content }] : [],
  )
  if (matches.length === 0) return { match: null as null, error: `No entry found matching: "${substring}"` }
  if (matches.length > 1) {
    const snippets = matches.map((e) => `  - "${e.text.slice(0, 60)}..."`).join("\n")
    return {
      match: null as null,
      error: `Multiple entries match "${substring}":\n${snippets}\nUse a more specific substring.`,
    }
  }
  return { match: matches[0]!, error: null as null }
}

function confidenceImportance(confidence: Confidence | undefined): Importance {
  if (confidence === "high") return 8
  if (confidence === "low") return 4
  return 6
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function parseDecision(value: unknown): MemoryDecision {
  const decision = expectRecord(value, "memory decision")
  assertExactFields(decision, ["shouldUpdate", "reason", "task", "user"], "memory decision")
  if (decision.shouldUpdate !== true) {
    throw new Error("Invalid memory decision shouldUpdate: mandatory semantic updates must be true")
  }
  const reason = expectString(decision.reason, "memory decision reason").trim()
  if (!reason) throw new Error("Invalid memory decision reason")
  if (!Array.isArray(decision.user)) throw new Error("Invalid memory decision user")
  const task = parseCandidate(decision.task, "task")
  const user: MemoryCandidate[] = []
  for (const [index, value] of decision.user.entries()) {
    const candidate = parseCandidate(value, `user ${index}`)
    const candidateEntry: UserMemoryEntry = { scope: "user", ...candidate }
    const existingIndex = user.findIndex((existing) => {
      const existingEntry: UserMemoryEntry = { scope: "user", ...existing }
      return (
        entryKey(existingEntry) === entryKey(candidateEntry) ||
        equivalentUserFacts(existingEntry, candidateEntry) ||
        sameUserProfileSlot(existingEntry, candidateEntry)
      )
    })
    if (existingIndex === -1) {
      user.push(candidate)
      continue
    }
    const merged = mergeUserCandidate(candidateEntry, [{ scope: "user", ...user[existingIndex]! }])
    user[existingIndex] = {
      importance: merged.importance,
      keywords: merged.keywords,
      content: merged.content,
    }
  }
  return { shouldUpdate: true, reason, task, user }
}

function parseCandidate(value: unknown, label: string): MemoryCandidate {
  const candidate = expectRecord(value, `memory decision ${label}`)
  assertExactFields(candidate, ["importance", "keywords", "content"], `memory decision ${label}`)
  const normalized: MemoryCandidate = {
    importance: parseImportance(candidate.importance),
    keywords: validateKeywords(expectStringArray(candidate.keywords, `memory decision ${label} keywords`)),
    content: parseContent(expectString(candidate.content, `memory decision ${label} content`)),
  }
  if (looksSensitive(normalized.content)) throw new Error(`Invalid memory decision ${label}: sensitive content`)
  return normalized
}

function validateTaskContent(input: string) {
  const content = parseContent(input)
  const prefix = "用户要求"
  const completionMarker = "，我完成了"
  if (!content.startsWith(prefix)) {
    throw new Error('Invalid task memory content: expected "用户要求..." or "用户要求...，我完成了..."')
  }
  const body = content.slice(prefix.length)
  const markerIndex = body.indexOf(completionMarker)
  if ((markerIndex === -1 && body.includes("我完成了")) || body.indexOf(completionMarker, markerIndex + 1) !== -1) {
    throw new Error('Invalid task memory content: expected "用户要求..." or "用户要求...，我完成了..."')
  }
  const request = markerIndex === -1 ? body : body.slice(0, markerIndex)
  const completion = markerIndex === -1 ? undefined : body.slice(markerIndex + completionMarker.length)
  if (!request || completion === "") {
    throw new Error('Invalid task memory content: expected "用户要求..." or "用户要求...，我完成了..."')
  }
  if ([...request].length > TASK_SECTION_CHAR_LIMIT) {
    throw new Error(`Task memory 用户要求 must not exceed ${TASK_SECTION_CHAR_LIMIT} characters`)
  }
  if (completion !== undefined && [...completion].length > TASK_SECTION_CHAR_LIMIT) {
    throw new Error(`Task memory 我完成了 must not exceed ${TASK_SECTION_CHAR_LIMIT} characters`)
  }
  return content
}

function validateTaskContentForPhase(input: string, phase: MemoryUpdatePhase) {
  const content = validateTaskContent(input)
  if (phase === "user" && /，我完成了/u.test(content)) {
    throw new Error('Invalid user-phase task memory content: expected "用户要求..." without a completion')
  }
  if (phase === "assistant" && !/^用户要求.+，我完成了.+$/u.test(content)) {
    throw new Error('Invalid assistant-phase task memory content: expected "用户要求...，我完成了..."')
  }
  return content
}

function looksSensitive(input: string) {
  return /(password|passwd|secret|token|api[_-]?key|private[_-]?key|cookie|authorization|bearer|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|密码|密钥|令牌|私钥)/i.test(
    input,
  )
}
