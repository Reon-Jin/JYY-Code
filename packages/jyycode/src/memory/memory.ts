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

const MEMORY_FILE = "MEMORY.md"
const USER_FILE = "USER.md"
export const DIRECTORY = path.normalize("D:/jyycode/memory")
const MEMORY_CHAR_LIMIT = 10_000
const USER_CHAR_LIMIT = 2_000
const ENTRY_LIMIT = 50
const CAPACITY_WARN_THRESHOLD = 0.8
const COMPACTION_TARGET = 0.7
const COMPACTION_ENTRY_TARGET = 45

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
  keywords: string[]
  content: string
}

export type MemoryEntry = TaskMemoryEntry | UserMemoryEntry

export class MemoryWriteForbidden extends Schema.TaggedErrorClass<MemoryWriteForbidden>()("MemoryWriteForbidden", {
  sessionID: SessionID,
}) {
  override get message() {
    return `Subagent session ${this.sessionID} cannot mutate persistent memory`
  }
}

const taskEntryPattern =
  /^- 重要性：(\d+) \+ 日期：([^\r\n]+?) \+ 关键词：([^\r\n]*?) \+ 内容：([^\r\n]+) \+ session：([^\s]+)$/u
const userEntryPattern = /^- 重要性：(\d+) \+ 关键词：([^\r\n]*?) \+ 内容：([^\r\n]+)$/u

export function normalizeKeywords(keywords: readonly string[]): string[] {
  const normalized = keywords
    .map((keyword) => keyword.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase())
    .filter(Boolean)
  return [...new Set(normalized)]
}

export function parseEntry(scope: Scope, line: string): MemoryEntry {
  const match = scope === "memory" ? taskEntryPattern.exec(line) : userEntryPattern.exec(line)
  if (!match) throw new Error(`Invalid ${scope} entry format`)

  const importance = parseImportance(match[1])
  if (scope === "memory") {
    const date = match[2]!
    const keywords = parseKeywords(match[3]!)
    const content = parseContent(match[4]!)
    const sessionID = match[5]!
    if (!isCalendarDate(date)) throw new Error(`Invalid memory entry date: ${date}`)
    if (!sessionID) throw new Error("Invalid memory entry session")
    return { scope, importance, date, keywords, content, sessionID: SessionID.make(sessionID) }
  }

  return {
    scope,
    importance,
    keywords: parseKeywords(match[2]!),
    content: parseContent(match[3]!),
  }
}

export function serializeEntry(entry: MemoryEntry): string {
  const importance = parseImportance(String(entry.importance))
  const keywords = validateKeywords(entry.keywords)
  const content = parseContent(entry.content)
  if (entry.scope === "memory") {
    if (!isCalendarDate(entry.date)) throw new Error(`Invalid memory entry date: ${entry.date}`)
    const sessionID = String(entry.sessionID).trim()
    if (!sessionID || /\s/u.test(sessionID)) throw new Error("Invalid memory entry session")
    return `- 重要性：${importance} + 日期：${entry.date} + 关键词：${keywords.join("、")} + 内容：${content} + session：${sessionID}`
  }
  return `- 重要性：${importance} + 关键词：${keywords.join("、")} + 内容：${content}`
}

export function entryKey(entry: MemoryEntry): string {
  if (entry.scope === "memory") return entry.sessionID
  return [...validateKeywords(entry.keywords)].sort().join("\u001f")
}

function parseImportance(value: string): Importance {
  const importance = Number(value)
  if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
    throw new Error(`Invalid memory entry importance: ${value}`)
  }
  return importance as Importance
}

function parseKeywords(value: string): string[] {
  return validateKeywords(value.split("、"))
}

function validateKeywords(value: readonly string[]): string[] {
  const keywords = normalizeKeywords(value)
  if (keywords.length === 0 || keywords.length > 3) {
    throw new Error("Invalid memory entry keywords: expected 1 to 3 non-empty keywords")
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

export type CuratedTurn = {
  task?: TaskMemoryUpsertInput
  user: Array<Omit<UserMemoryEntry, "scope">>
}

export function curateTurn(input: {
  sessionID: SessionID
  userText: string
  assistantText: string
}): CuratedTurn {
  const user = extractStableUserCandidates(input.userText)
  const combined = `${input.userText}\n${input.assistantText}`
  if (
    !input.userText.trim() ||
    !input.assistantText.trim() ||
    looksSensitive(combined) ||
    /(?:fixture|fake world|测试夹具|hello llm)/iu.test(combined) ||
    /(?:^|[，。！？\s])(你好|您好|hello|hi)(?:[，。！？\s]|$)/iu.test(input.userText.trim()) ||
    /(?:还没好|进度|催一下|到哪了)/u.test(input.userText) ||
    /(?:这次|本次|当前任务|暂时|单次).{0,20}(?:不要|只|仅)/u.test(input.userText) ||
    /(?:未完成|尚未完成|没有完成|失败)/u.test(input.assistantText) ||
    !/(?:已完成|完成了|已实现|已创建|已生成|已修复|交付完成|通过测试|implemented|completed|created|fixed)/iu.test(
      input.assistantText,
    )
  ) {
    return { user }
  }

  const content = summarizeText(
    input.assistantText
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#")) ?? input.assistantText,
    120,
  )
  return {
    task: {
      sessionID: input.sessionID,
      importance: taskImportance(input.userText, input.assistantText),
      keywords: extractTaskKeywords(combined),
      content,
    },
    user,
  }
}

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
  readonly ensure: (sessionID: SessionID) => Effect.Effect<void>
  readonly read: (input: { sessionID: SessionID; scope: Scope; section?: string }) => Effect.Effect<string>
  readonly search: (input: {
    sessionID: SessionID
    query: string
    scope?: Scope | "all"
    limit?: number
  }) => Effect.Effect<SearchResult[]>
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
  readonly usage: (sessionID: SessionID, scope: Scope) => Effect.Effect<UsageInfo>
  readonly formatWithHeader: (sessionID: SessionID, scope: Scope) => Effect.Effect<string>
  readonly updateAfterTurn: (
    sessionID: SessionID,
  ) => Effect.Effect<
    | void
    | { status: "skipped"; reason: "subagent" }
    | { status: "updated"; taskUpdated: boolean; userUpdated: number },
    Error
  >
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Memory") {}

const templates: Record<Scope, string> = {
  memory: "# JYY-Code Memory\n\n<!-- schema: 2; last_compacted: never -->\n",
  user: "# User Memory\n\n<!-- schema: 2; last_compacted: never -->\n",
}

const filenames: Record<Scope, string> = {
  memory: MEMORY_FILE,
  user: USER_FILE,
}

export const layerWithDirectory = (directory: string) =>
  Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const sessions = yield* Session.Service
    const flock = yield* EffectFlock.Service
    const memoryDirectory = path.normalize(directory)

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

    const ensure = Effect.fn("Memory.ensure")(function* (sessionID: SessionID) {
      yield* fs.ensureDir(yield* dir(sessionID)).pipe(Effect.orDie)
      for (const scope of ["memory", "user"] as const) {
        const target = yield* filePath(sessionID, scope)
        const exists = yield* fs.existsSafe(target).pipe(Effect.orDie)
        if (!exists) yield* fs.writeWithDirs(target, templates[scope]).pipe(Effect.orDie)
      }
    })

    const readFull = Effect.fn("Memory.readFull")(function* (sessionID: SessionID, scope: Scope) {
      yield* ensure(sessionID)
      return (yield* fs.readFileStringSafe(yield* filePath(sessionID, scope)).pipe(Effect.orDie)) ?? templates[scope]
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

    const read = Effect.fn("Memory.read")(function* (input: {
      sessionID: SessionID
      scope: Scope
      section?: string
    }) {
      const text = yield* readFull(input.sessionID, input.scope)
      if (!input.section) return text
      return extractSection(text, input.section) ?? ""
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
        const text = yield* readFull(input.sessionID, scope)
        let currentSection = "Document"
        const lines = text.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? ""
          const heading = line.match(/^##\s+(.+)$/)
          if (heading?.[1]) {
            currentSection = heading[1].trim()
            continue
          }
          const body = line.trim()
          if (!body || body.startsWith("#")) continue
          const score = scoreLine(tokens, body)
          if (score <= 0) continue
          results.push({
            file: sourceFile,
            section: currentSection,
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
          const current = yield* readFull(sessionID, scope)
          const entries = parseStructuredEntries(current, scope)
          const normalized = parseEntry(scope, serializeEntry(candidate))
          const key = entryKey(normalized)
          const index = entries.findIndex((entry) => entryKey(entry) === key)
          const status: "written" | "duplicate" | "replaced" =
            index === -1
              ? "written"
              : entriesEquivalent(entries[index]!, normalized)
                ? "duplicate"
                : "replaced"

          if (status !== "duplicate") {
            if (index === -1) entries.push(normalized)
            else entries[index] = normalized
            const projected = renderStructuredDocument(current, scope, entries)
            const shouldCompact =
              projected.length >= charLimit(scope) * CAPACITY_WARN_THRESHOLD || entries.length > ENTRY_LIMIT
            if (shouldCompact) {
              const outcome = compactEntrySet(current, scope, entries)
              const retained = containsCandidate(outcome.entries, normalized)
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
            reason: status === "duplicate" ? "Exact structured entry already exists." : "Structured memory upsert.",
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
      return yield* upsertStructured(input.sessionID, {
        scope: "memory",
        importance: input.importance,
        date: localDate(new Date()),
        keywords: input.keywords,
        content: input.content,
        sessionID: input.sessionID,
      })
    })

    const upsertUserMemory = Effect.fn("Memory.upsertUserMemory")(function* (input: UserMemoryUpsertInput) {
      return yield* upsertStructured(input.sessionID, {
        scope: "user",
        importance: input.importance,
        keywords: input.keywords,
        content: input.content,
      })
    })

    const write = Effect.fn("Memory.write")(function* (input: MemoryWriteInput) {
      yield* assertPrimaryWriter(input.sessionID)
      yield* ensure(input.sessionID)
      const clean = sanitizeContent(input.content)
      if (!clean) return yield* Effect.fail(new Error("Memory content is empty"))
      if (looksSensitive(clean)) return yield* Effect.fail(new Error("Refusing to store sensitive memory content"))

      const targetFile = yield* filePath(input.sessionID, input.scope)
      return yield* flock.withLock(
        Effect.gen(function* () {
          const current = yield* readFull(input.sessionID, input.scope)
          if (findDuplicate(current, clean)) {
            yield* audit(input.sessionID, {
              action: "memory.duplicate",
              scope: input.scope,
              section: input.section,
              content: clean,
              reason: input.reason,
            })
            return {
              file: targetFile,
              status: "duplicate" as const,
              message: `Duplicate memory already exists.\nFile: ${targetFile}`,
            }
          }

          const usage = computeUsage(current, input.scope)
          if (usage.used + clean.length + 4 > usage.limit) {
            return yield* Effect.fail(new Error(capacityError(current, clean, input.scope)))
          }

          const now = new Date().toISOString()
          const next = updateMetadata(appendEntry(current, input.section, clean), now, input.sessionID)
          yield* writeFull(input.sessionID, input.scope, next)
          yield* audit(input.sessionID, {
            action: "memory.write",
            scope: input.scope,
            section: input.section,
            content: clean,
            reason: input.reason,
          })
          const newUsage = computeUsage(next, input.scope)
          let message = `Memory written.\nFile: ${targetFile}`
          if (newUsage.percentage >= CAPACITY_WARN_THRESHOLD * 100) {
            message += `\nWarning: memory at ${newUsage.percentage}% capacity (${newUsage.used}/${newUsage.limit} chars). Consider consolidating entries.`
          }
          return { file: targetFile, status: "written" as const, message }
        }),
        targetFile,
      )
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

      const targetFile = yield* filePath(input.sessionID, input.scope)
      return yield* flock.withLock(
        Effect.gen(function* () {
          const current = yield* readFull(input.sessionID, input.scope)
          const { match, error } = findEntryBySubstring(current, input.oldText)
          if (error) return yield* Effect.fail(new Error(error))

          const updated = replaceEntryByIndex(current, match!.index, clean)
          yield* writeFull(
            input.sessionID,
            input.scope,
            updateMetadata(updated, new Date().toISOString(), input.sessionID),
          )
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
          const current = yield* readFull(input.sessionID, input.scope)
          const { match, error } = findEntryBySubstring(current, input.oldText)
          if (error) return yield* Effect.fail(new Error(error))

          const updated = removeEntryByIndex(current, match!.index)
          yield* writeFull(
            input.sessionID,
            input.scope,
            updateMetadata(updated, new Date().toISOString(), input.sessionID),
          )
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
          const current = yield* readFull(input.sessionID, input.scope)
          const outcome = compactEntrySet(current, input.scope, parseStructuredEntries(current, input.scope))
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

    const usage = Effect.fn("Memory.usage")(function* (sessionID: SessionID, scope: Scope) {
      yield* ensure(sessionID)
      const text = yield* readFull(sessionID, scope)
      return computeUsage(text, scope)
    })

    const formatWithHeader = Effect.fn("Memory.formatWithHeader")(function* (sessionID: SessionID, scope: Scope) {
      yield* ensure(sessionID)
      const text = yield* readFull(sessionID, scope)
      const header = formatMemoryHeader(scope, text)
      return header + text
    })

    const updateAfterTurn = Effect.fn("Memory.updateAfterTurn")(function* (sessionID: SessionID) {
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
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const latestUser = msgs.findLast((msg) => msg.info.role === "user")
      if (!latestUser) return
      const latestAssistant = msgs.findLast(
        (msg) => msg.info.role === "assistant" && msg.info.parentID === latestUser.info.id,
      )

      const userText = textContent(latestUser, { synthetic: false })
      const assistantText = latestAssistant ? textContent(latestAssistant, { synthetic: false }) : ""
      const curated = curateTurn({ sessionID, userText, assistantText })
      const taskResult = curated.task ? yield* upsertTaskMemory(curated.task) : undefined
      const userResults = yield* Effect.forEach(curated.user, (candidate) =>
        upsertUserMemory({ sessionID, ...candidate }),
      )
      yield* audit(sessionID, {
        writerSessionID: sessionID,
        writerKind: "primary",
        action: "memory.curated",
        taskStatus: taskResult?.status ?? "skipped",
        userStatuses: userResults.map((result) => result.status),
        reason:
          curated.task || curated.user.length > 0
            ? "Accepted durable post-turn candidates."
            : "No durable post-turn candidates.",
      })
      return { status: "updated" as const, taskUpdated: taskResult !== undefined, userUpdated: userResults.length }
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
    })
  }),
).pipe(Layer.provide(EffectFlock.defaultLayer))

export const layer = layerWithDirectory(DIRECTORY)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(Session.defaultLayer))

function parseStructuredEntries(text: string, scope: Scope): MemoryEntry[] {
  const isV2 = /<!--\s*schema:\s*2\s*;/u.test(text)
  const entries: MemoryEntry[] = []
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith("- 重要性：")) continue
    try {
      entries.push(parseEntry(scope, line))
    } catch (error) {
      if (isV2) throw error
    }
  }
  return entries
}

function renderStructuredDocument(
  original: string,
  scope: Scope,
  entries: readonly MemoryEntry[],
  lastCompactedOverride?: string,
): string {
  const lines = entries.map(serializeEntry)
  if (!/<!--\s*schema:\s*2\s*;/u.test(original)) {
    const legacy = original
      .split(/\r?\n/u)
      .filter((line) => !line.startsWith("- 重要性："))
      .join("\n")
      .trimEnd()
    return [legacy, "", "## Structured V2 Entries", "", ...lines, ""].join("\n")
  }
  const title = scope === "memory" ? "# JYY-Code Memory" : "# User Memory"
  const lastCompacted =
    lastCompactedOverride ?? original.match(/last_compacted:\s*([^\s;]+)\s*-->/u)?.[1] ?? "never"
  return [title, "", `<!-- schema: 2; last_compacted: ${lastCompacted} -->`, "", ...lines, ""].join("\n")
}

type CompactOutcome = {
  entries: MemoryEntry[]
  text: string
  removed: number
  merged: number
  before: UsageInfo & { entries: number }
  after: UsageInfo & { entries: number }
}

function compactEntrySet(original: string, scope: Scope, source: readonly MemoryEntry[]): CompactOutcome {
  const beforeText = renderStructuredDocument(original, scope, source)
  const before = usageWithEntries(beforeText, scope, source.length)
  const entries: MemoryEntry[] = []
  let removed = 0
  let merged = 0

  for (const entry of source) {
    const exact = entries.findIndex((item) => serializeEntry(item) === serializeEntry(entry))
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
    const text = renderStructuredDocument(original, scope, entries, localDate(new Date()))
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

  const text = renderStructuredDocument(original, scope, entries, localDate(new Date()))
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
  const leftKeys = new Set(left.keywords)
  const rightKeys = new Set(right.keywords)
  const intersection = [...leftKeys].filter((keyword) => rightKeys.has(keyword)).length
  const union = new Set([...leftKeys, ...rightKeys]).size
  if (union > 0 && intersection / union >= 0.6) return true
  if (left.scope !== "user") return false
  return left.keywords.some((a) => right.keywords.some((b) => a.includes(b) || b.includes(a)))
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

function capacityError(current: string, newContent: string, scope: Scope) {
  const info = computeUsage(current, scope)
  const newEntrySize = newContent.trim().length + 4
  const entries = parseEntries(current)
  const lines = entries.map((e) => `  - "${e.text.slice(0, 80)}${e.text.length > 80 ? "..." : ""}"`)
  return [
    `Memory at ${info.used}/${info.limit} chars (${info.percentage}%).`,
    `Adding this entry (${newEntrySize} chars) would exceed the ${info.limit} char limit.`,
    `Replace or remove existing entries first.`,
    `Current entries:`,
    ...lines,
  ].join("\n")
}

function tokenize(input: string) {
  const ascii = input
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/)
    .filter((item) => item.length >= 2)
  const cjk = Array.from(input.matchAll(/[\p{Script=Han}]{2,}/gu)).map((match) => match[0])
  return [...new Set([...ascii, ...cjk])]
}

function scoreLine(tokens: string[], line: string) {
  const lower = line.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (lower.includes(token.toLowerCase())) score += token.length > 3 ? 2 : 1
  }
  return score
}

function extractSection(text: string, section: string) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${section}`.toLowerCase())
  if (start === -1) return undefined
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join("\n").trim()
}

function updateMetadata(text: string, now: string, sessionID: SessionID) {
  const line = `- Last reviewed: ${now} (session: ${sessionID})`
  if (text.includes("## System Metadata")) {
    const lines = text.split(/\r?\n/)
    const start = lines.findIndex((item) => item.trim() === "## System Metadata")
    const end = lines.findIndex((item, index) => index > start && /^##\s+/.test(item))
    const before = lines.slice(0, start + 1)
    const after = lines.slice(end === -1 ? lines.length : end)
    return [...before, line, "", ...after].join("\n")
  }
  return text.replace(/^# .+$/m, (heading) => [heading, "", "## System Metadata", line].join("\n"))
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

function summarizeText(input: string, max = 180) {
  const compact = input.replace(/\s+/g, " ").trim()
  if (compact.length <= max) return compact
  return compact.slice(0, max - 3).trimEnd() + "..."
}

function sanitizeContent(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function normalizedContent(input: string) {
  return sanitizeContent(input).toLowerCase()
}

// §-delimited entries. Each entry is the raw text between § markers.
// Entries are stored inside markdown sections; § delimiters separate entries.
function appendEntry(markdown: string, section: string, content: string) {
  return replaceSectionBody(markdown, section, (body) => {
    const trimmed = body.trimEnd()
    return trimmed ? `${trimmed}\n${content}\n§` : `${content}\n§`
  })
}

function replaceSectionBody(markdown: string, section: string, update: (body: string) => string) {
  const heading = `## ${section}`
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start === -1) {
    return [markdown.trimEnd(), "", heading, update("").trimEnd(), ""].join("\n")
  }
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line))
  const sectionEnd = end === -1 ? lines.length : end
  const before = lines.slice(0, start + 1)
  const body = lines.slice(start + 1, sectionEnd).join("\n")
  const after = lines.slice(sectionEnd)
  return [...before, update(body).trimEnd(), "", ...after].join("\n")
}

type EntryInfo = { index: number; text: string }

function parseEntries(markdown: string): EntryInfo[] {
  const blocks: EntryInfo[] = []
  let index = 0
  const parts = markdown.split(/(?:^|\n)§(?:\n|$)/)
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed && !trimmed.startsWith("#")) {
      blocks.push({ index, text: trimmed })
    }
    index++
  }
  return blocks
}

function findDuplicate(markdown: string, content: string) {
  const target = normalizedContent(content)
  return parseEntries(markdown).some((entry) => normalizedContent(entry.text) === target)
}

function findEntryBySubstring(markdown: string, substring: string) {
  const normalized = normalizedContent(substring)
  const entries = parseEntries(markdown)
  const matches = entries.filter((entry) => normalizedContent(entry.text).includes(normalized))
  if (matches.length === 0) return { match: null as null, error: `No entry found matching: "${substring}"` }
  if (matches.length > 1) {
    const snippets = matches.map((e) => `  - "${e.text.slice(0, 60)}..."`).join("\n")
    return { match: null as null, error: `Multiple entries match "${substring}":\n${snippets}\nUse a more specific substring.` }
  }
  return { match: matches[0]!, error: null as null }
}

function replaceEntryByIndex(markdown: string, entryIndex: number, newContent: string) {
  const lines = markdown.split(/\r?\n/)
  let currentEntry = 0
  let start = -1
  let end = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line === "§") {
      if (currentEntry === entryIndex) { end = i; break }
      currentEntry++
      start = -1
      continue
    }
    if (!line || line.startsWith("#")) continue
    if (currentEntry === entryIndex && start === -1) start = i
  }
  if (start === -1 || end === -1) return markdown
  return [...lines.slice(0, start), newContent, ...lines.slice(end)].join("\n")
}

function removeEntryByIndex(markdown: string, entryIndex: number) {
  const lines = markdown.split(/\r?\n/)
  let currentEntry = 0
  let start = -1
  let end = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line === "§") {
      if (currentEntry === entryIndex) { end = i + 1; break }
      currentEntry++
      start = -1
      continue
    }
    if (!line || line.startsWith("#")) continue
    if (currentEntry === entryIndex && start === -1) start = i
  }
  if (start === -1) return markdown
  if (end === -1) return [...lines.slice(0, start), ...lines.slice(start + 1)].join("\n")
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n")
}

function extractStableUserCandidates(input: string): Array<Omit<UserMemoryEntry, "scope">> {
  const result: Array<Omit<UserMemoryEntry, "scope">> = []
  const name = input.match(/我(?:叫|的名字是)\s*([\p{Script=Han}]{2,8})/u)?.[1]
  if (name) result.push({ importance: 10, keywords: ["姓名"], content: `用户姓名为${name}。` })

  const birthday = input.match(/(?:我的)?生日(?:是|为)\s*(\d{4})\s*年?[\/-]?\s*(\d{1,2})\s*月?[\/-]?\s*(\d{1,2})\s*日?/u)
  if (birthday) {
    const normalized = `${birthday[1]}${birthday[2]!.padStart(2, "0")}${birthday[3]!.padStart(2, "0")}`
    if (isCalendarDate(normalized)) {
      result.push({ importance: 10, keywords: ["生日"], content: `用户生日为${normalized}。` })
    }
  }

  const sentences = input
    .split(/[。；;\r\n]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
  for (const sentence of sentences) {
    if (!/(?:以后|今后|长期|总是|始终|默认|偏好|我喜欢|请记住|记住)/u.test(sentence)) continue
    if (/(?:这次|本次|当前任务|暂时|单次)/u.test(sentence)) continue
    if (/(?:我叫|我的名字|生日)/u.test(sentence) || looksSensitive(sentence)) continue
    const communication = /(?:中文|英文|回答|解释|语气|风格|简洁|详细|称呼)/u.test(sentence)
    result.push({
      importance: 8,
      keywords: [communication ? "沟通偏好" : "工程偏好"],
      content: `用户长期偏好${sentence.replace(/^(?:请记住|记住)[:：]?/u, "")}。`,
    })
  }

  const seen = new Set<string>()
  return result.filter((entry) => {
    const key = entryKey({ scope: "user", ...entry })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function taskImportance(userText: string, assistantText: string): Importance {
  if (/(?:发布|上线|迁移|架构|完整|全部|端到端|生产)/u.test(`${userText}\n${assistantText}`)) return 8
  if (/(?:优化|修复|通过测试|交付)/u.test(assistantText)) return 7
  return 6
}

function extractTaskKeywords(input: string): string[] {
  if (/赛车游戏/u.test(input)) return ["赛车游戏"]
  const matches = Array.from(
    input.matchAll(/[\p{Script=Han}A-Za-z0-9+#.-]{0,12}(?:项目|游戏|系统|功能|文档|报告|模型|地图)/gu),
  )
    .map((match) =>
      match[0]
        .replace(/^(?:请|继续|完成|优化|实现|创建|生成|修复|已完成|已实现|已创建|已生成)+/u, "")
        .trim(),
    )
    .filter((keyword) => keyword.length >= 2)
  return normalizeKeywords(matches).slice(0, 3).length > 0 ? normalizeKeywords(matches).slice(0, 3) : ["任务成果"]
}

function looksSensitive(input: string) {
  return /(password|passwd|secret|token|api[_-]?key|private[_-]?key|cookie|authorization|bearer|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|密码|密钥|令牌|私钥)/i.test(
    input,
  )
}
