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
const MAX_RECENT_SESSIONS = 30

type Scope = "memory" | "user"

export const SearchResult = Schema.Struct({
  file: Schema.String,
  section: Schema.String,
  line: Schema.Number,
  score: Schema.Number,
  text: Schema.String,
})
export type SearchResult = Schema.Schema.Type<typeof SearchResult>

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
  readonly updateAfterTurn: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Memory") {}

const templates: Record<Scope, string> = {
  memory: [
    "# JYY-Code Memory",
    "",
    "## System Metadata",
    "- Last reviewed: never",
    "",
    "## Project Facts",
    "",
    "## Engineering Conventions",
    "",
    "## Repeated Workflows",
    "",
    "## Environment Quirks",
    "",
    "## Past Lessons",
    "",
    "## Recent Sessions",
    "",
    "## Deprecated / Superseded",
    "",
  ].join("\n"),
  user: [
    "# User Memory",
    "",
    "## System Metadata",
    "- Last reviewed: never",
    "",
    "## Communication Style",
    "",
    "## Engineering Preferences",
    "",
    "## Personal / Stable Context",
    "",
    "## Sensitive Boundaries",
    "",
  ].join("\n"),
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

    const root = Effect.fn("Memory.root")(function* (sessionID: SessionID) {
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      if (!session.path) return session.directory
      const depth = session.path.split("/").filter(Boolean).length
      return path.resolve(session.directory, ...Array.from({ length: depth }, () => ".."))
    })

    const dir = Effect.fn("Memory.dir")(function* (sessionID: SessionID) {
      return path.join(yield* root(sessionID), "memory")
    })

    const filePath = Effect.fn("Memory.filePath")(function* (sessionID: SessionID, scope: Scope) {
      return path.join(yield* dir(sessionID), filenames[scope])
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
            file: filenames[scope],
            section: currentSection,
            line: i + 1,
            score,
            text: body,
          })
        }
      }

      return results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, input.limit ?? 8)
    })

    const updateAfterTurn = Effect.fn("Memory.updateAfterTurn")(function* (sessionID: SessionID) {
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
        userMemoryText = upsertBullets(userMemoryText, "Communication Style", preferences.communication)
        userMemoryText = upsertBullets(userMemoryText, "Engineering Preferences", preferences.engineering)
      }
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
      updateAfterTurn,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(Session.defaultLayer))

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
    const bullet = `- [${new Date().toISOString().slice(0, 10)}][source: explicit-user] ${summarizeText(line, 220)}`
    if (isCommunicationPreference(line)) communication.push(bullet)
    else engineering.push(bullet)
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
