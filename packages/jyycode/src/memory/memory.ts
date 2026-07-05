export * as Memory from "./memory"

import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Context, Effect, Layer, Schema } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import * as Log from "@jyycode-ai/core/util/log"
const log = Log.create({ service: "memory" })

const MEMORY_FILE = "MEMORY.md"
const USER_FILE = "USER.md"
export const DIRECTORY = path.normalize("D:/jyycode/memory")
const MAX_RECENT_SESSIONS = 30
const MEMORY_CHAR_LIMIT = 2200
const USER_CHAR_LIMIT = 1375
const CAPACITY_WARN_THRESHOLD = 0.8

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

export type MutationResult = {
  id?: string
  file?: string
  status: "written" | "duplicate" | "replaced" | "removed" | "compacted"
  message: string
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
  readonly compact: (input: { sessionID: SessionID; scope: Scope }) => Effect.Effect<MutationResult, Error>
  readonly usage: (sessionID: SessionID, scope: Scope) => Effect.Effect<UsageInfo>
  readonly formatWithHeader: (sessionID: SessionID, scope: Scope) => Effect.Effect<string>
  readonly updateAfterTurn: (
    sessionID: SessionID,
  ) => Effect.Effect<void | { status: "skipped"; reason: "subagent" }>
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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const sessions = yield* Session.Service

    const dir = Effect.fn("Memory.dir")(function* (_sessionID: SessionID) {
      return DIRECTORY
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

    const writeFull = Effect.fn("Memory.writeFull")(function* (sessionID: SessionID, scope: Scope, text: string) {
      yield* fs.writeWithDirs(yield* filePath(sessionID, scope), text.endsWith("\n") ? text : text + "\n").pipe(
        Effect.orDie,
      )
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
      const current = yield* readFull(sessionID, scope)
      const entries = parseStructuredEntries(current, scope)
      const normalized = parseEntry(scope, serializeEntry(candidate))
      const key = entryKey(normalized)
      const index = entries.findIndex((entry) => entryKey(entry) === key)
      const status: MutationResult["status"] =
        index === -1
          ? "written"
          : entriesEquivalent(entries[index]!, normalized)
            ? "duplicate"
            : "replaced"

      if (status !== "duplicate") {
        if (index === -1) entries.push(normalized)
        else entries[index] = normalized
        yield* writeFull(sessionID, scope, renderStructuredDocument(current, scope, entries))
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
      const current = yield* readFull(input.sessionID, input.scope)
      const { match, error } = findEntryBySubstring(current, input.oldText)
      if (error) return yield* Effect.fail(new Error(error))

      const updated = replaceEntryByIndex(current, match!.index, clean)
      yield* writeFull(input.sessionID, input.scope, updateMetadata(updated, new Date().toISOString(), input.sessionID))
      yield* audit(input.sessionID, {
        action: "memory.replace",
        scope: input.scope,
        oldText: input.oldText,
        newContent: clean,
        reason: input.reason,
      })
      return { file: targetFile, status: "replaced" as const, message: `Memory replaced.\nFile: ${targetFile}` }
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
      const current = yield* readFull(input.sessionID, input.scope)
      const { match, error } = findEntryBySubstring(current, input.oldText)
      if (error) return yield* Effect.fail(new Error(error))

      const updated = removeEntryByIndex(current, match!.index)
      yield* writeFull(input.sessionID, input.scope, updateMetadata(updated, new Date().toISOString(), input.sessionID))
      yield* audit(input.sessionID, {
        action: "memory.remove",
        scope: input.scope,
        oldText: input.oldText,
        reason: input.reason,
      })
      return { file: targetFile, status: "removed" as const, message: `Memory removed.\nFile: ${targetFile}` }
    })

    const compact = Effect.fn("Memory.compact")(function* (input: { sessionID: SessionID; scope: Scope }) {
      yield* assertPrimaryWriter(input.sessionID)
      yield* ensure(input.sessionID)
      const targetFile = yield* filePath(input.sessionID, input.scope)
      yield* audit(input.sessionID, {
        action: "memory.compact",
        scope: input.scope,
        reason: "Manual compaction requested; deterministic compaction is implemented in the capacity phase.",
      })
      return {
        file: targetFile,
        status: "compacted" as const,
        message: `Memory compaction authorized.\nFile: ${targetFile}`,
      }
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

      const now = new Date().toISOString()
      const userText = textContent(latestUser, { synthetic: false })
      const assistantText = latestAssistant ? textContent(latestAssistant, { synthetic: false }) : ""
      const sessionLine = formatRecentSession({
        now,
        sessionID,
        userText,
        assistantText,
      })

      const memoryText = updateMetadata(yield* readFull(sessionID, "memory"), now, sessionID)
      yield* writeFull(sessionID, "memory", upsertRecentSession(memoryText, sessionLine))

      let userMemoryText = updateMetadata(yield* readFull(sessionID, "user"), now, sessionID)
      const preferences = extractUserPreferences(userText)
      if (preferences.length > 0) {
        for (const item of preferences.communication) {
          yield* write({
            sessionID,
            scope: "user",
            section: "Communication Style",
            content: item,
            reason: "Post-turn curator extracted an explicit communication preference.",
            confidence: "high",
            source: `session:${sessionID}`,
          }).pipe(Effect.catchCause((cause) => Effect.sync(() => log.error("failed to write user memory", { cause }))))
        }
        for (const item of preferences.engineering) {
          yield* write({
            sessionID,
            scope: "user",
            section: "Engineering Preferences",
            content: item,
            reason: "Post-turn curator extracted an explicit engineering preference.",
            confidence: "high",
            source: `session:${sessionID}`,
          }).pipe(Effect.catchCause((cause) => Effect.sync(() => log.error("failed to write user memory", { cause }))))
        }
      }
      userMemoryText = updateMetadata(yield* readFull(sessionID, "user"), now, sessionID)
      yield* writeFull(sessionID, "user", userMemoryText)

      yield* appendAudit(sessionID, {
        time: now,
        sessionID,
        memoryUpdated: true,
        userUpdated: preferences.length > 0,
        userPreferences: preferences.length,
      }).pipe(Effect.catchCause((cause) => Effect.sync(() => log.error("failed to append memory audit", { cause }))))
    })

    const appendAudit = Effect.fn("Memory.appendAudit")(function* (
      sessionID: SessionID,
      entry: Record<string, unknown>,
    ) {
      const target = path.join(yield* dir(sessionID), "audit.jsonl")
      const current = (yield* fs.readFileStringSafe(target).pipe(Effect.orDie)) ?? ""
      yield* fs.writeWithDirs(target, current + JSON.stringify(entry) + "\n").pipe(Effect.orDie)
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
)

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

function renderStructuredDocument(original: string, scope: Scope, entries: readonly MemoryEntry[]): string {
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
  const lastCompacted = original.match(/last_compacted:\s*([^\s;]+)\s*-->/u)?.[1] ?? "never"
  return [title, "", `<!-- schema: 2; last_compacted: ${lastCompacted} -->`, "", ...lines, ""].join("\n")
}

function entriesEquivalent(left: MemoryEntry, right: MemoryEntry): boolean {
  if (left.scope !== right.scope) return false
  if (left.importance !== right.importance || left.content !== right.content) return false
  if (entryKey(left) !== entryKey(right)) return false
  if (left.keywords.join("\u001f") !== right.keywords.join("\u001f")) return false
  return left.scope === "user" || (right.scope === "memory" && left.sessionID === right.sessionID)
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

function upsertRecentSession(text: string, line: string) {
  return replaceSectionBullets(text, "Recent Sessions", (existing) => {
    const next = [line, ...existing.filter((item) => item !== line)]
    return next.slice(0, MAX_RECENT_SESSIONS)
  })
}

function upsertBullets(text: string, section: string, bullets: string[]) {
  if (bullets.length === 0) return text
  return replaceSectionBullets(text, section, (existing) => {
    const seen = new Set(existing.map(normalizeBullet))
    const next = [...existing]
    for (const bullet of bullets) {
      const normalized = normalizeBullet(bullet)
      if (seen.has(normalized)) continue
      seen.add(normalized)
      next.push(bullet)
    }
    return next
  })
}

function replaceSectionBullets(text: string, section: string, update: (existing: string[]) => string[]) {
  const heading = `## ${section}`
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((item) => item.trim() === heading)
  if (start === -1) {
    return [text.trimEnd(), "", heading, ...update([]), ""].join("\n")
  }
  const end = lines.findIndex((item, index) => index > start && /^##\s+/.test(item))
  const sectionEnd = end === -1 ? lines.length : end
  const existing = lines.slice(start + 1, sectionEnd).map((item) => item.trim()).filter((item) => item.startsWith("- "))
  const updated = update(existing)
  return [...lines.slice(0, start + 1), ...updated, "", ...lines.slice(sectionEnd)].join("\n")
}

function normalizeBullet(input: string) {
  return input.toLowerCase().replace(/^\-\s+\[[^\]]+\]\s*/, "- ").replace(/\s+/g, " ").trim()
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

function formatRecentSession(input: {
  now: string
  sessionID: SessionID
  userText: string
  assistantText: string
}) {
  const user = summarizeText(input.userText || "(no user text)")
  const outcome = summarizeText(input.assistantText || "(no assistant response)", 140)
  return `- [${input.now}] session:${input.sessionID} user="${escapeInline(user)}" outcome="${escapeInline(outcome)}"`
}

function escapeInline(input: string) {
  return input.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
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

function extractUserPreferences(input: string) {
  if (!input.trim()) return preferenceResult([], [])
  const lines = input
    .split(/\r?\n|。|；|;/)
    .map((item) => item.trim())
    .filter(Boolean)
  const communication: string[] = []
  const engineering: string[] = []
  for (const line of lines) {
    if (!looksLikePreference(line)) continue
    if (looksSensitive(line)) continue
    const memory = summarizeText(line, 220)
    if (isCommunicationPreference(line)) communication.push(memory)
    else engineering.push(memory)
  }
  return preferenceResult(communication, engineering)
}

function preferenceResult(communication: string[], engineering: string[]) {
  const all = [...communication, ...engineering] as string[] & {
    communication: string[]
    engineering: string[]
  }
  all.communication = communication
  all.engineering = engineering
  return all
}

function looksLikePreference(input: string) {
  return /(记住|以后|今后|总是|默认|偏好|喜欢|希望|不要|别|必须|先.+再|不改代码|用中文|中文回答|详细设计|性格|个人信息)/.test(
    input,
  )
}

function isCommunicationPreference(input: string) {
  return /中文|英文|语气|风格|沟通|回答|解释|详细|简洁|称呼/.test(
    input,
  )
}

function looksSensitive(input: string) {
  return /(password|passwd|secret|token|api[_-]?key|private[_-]?key|cookie|authorization|bearer|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|密码|密钥|令牌|私钥)/i.test(
    input,
  )
}
