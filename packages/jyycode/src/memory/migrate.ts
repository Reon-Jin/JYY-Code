import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect } from "effect"
import { MemoryDb, computeContentHash, type ObservationInput } from "./memory-db"
import { DIRECTORY } from "./memory"
import * as Log from "@jyycode-ai/core/util/log"

const log = Log.create({ service: "memory-migrate" })

const MEMORY_FILE = "MEMORY.md"
const USER_FILE = "USER.md"

interface LegacyEntry {
  id: string
  date: string
  confidence: string
  source: string
  reason: string
  content: string
  status?: string
  superseded_by?: string
  updated?: string
}

function parseLegacyMarkdown(text: string): LegacyEntry[] {
  const entries: LegacyEntry[] = []
  const lines = text.split(/\r?\n/)
  let current: Partial<LegacyEntry> | null = null
  let contentLines: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const idMatch = line.match(/^\-\s+id:\s+(\S+)/)
    if (idMatch) {
      if (current?.id && contentLines.length > 0) {
        entries.push({ ...current, content: contentLines.join("\n").trim() } as LegacyEntry)
      }
      current = { id: idMatch[1] }
      contentLines = []
      continue
    }

    if (current) {
      const dateMatch = line.match(/^\s+date:\s+(.+)/)
      if (dateMatch) { current.date = dateMatch[1].trim(); continue }
      const confMatch = line.match(/^\s+confidence:\s+(.+)/)
      if (confMatch) { current.confidence = confMatch[1].trim(); continue }
      const sourceMatch = line.match(/^\s+source:\s+(.+)/)
      if (sourceMatch) { current.source = sourceMatch[1].trim(); continue }
      const reasonMatch = line.match(/^\s+reason:\s+(.+)/)
      if (reasonMatch) { current.reason = reasonMatch[1].trim(); continue }
      const contentMatch = line.match(/^\s+content:\s+(.*)/)
      if (contentMatch) { contentLines.push(contentMatch[1] ?? ""); continue }
      const statusMatch = line.match(/^\s+status:\s+(.+)/)
      if (statusMatch) { current.status = statusMatch[1].trim(); continue }
      const superMatch = line.match(/^\s+superseded_by:\s+(.+)/)
      if (superMatch) { current.superseded_by = superMatch[1].trim(); continue }
      const updatedMatch = line.match(/^\s+updated:\s+(.+)/)
      if (updatedMatch) { current.updated = updatedMatch[1].trim(); continue }

      if (contentLines.length > 0 && line.match(/^\s+\S/)) {
        contentLines.push(line.trim())
      }
    }
  }

  if (current?.id && contentLines.length > 0) {
    entries.push({ ...current, content: contentLines.join("\n").trim() } as LegacyEntry)
  }

  return entries
}

function determineObservationType(scope: string, section: string, content: string): string {
  const combined = `${section} ${content}`.toLowerCase()
  if (scope === "user") {
    if (/identity|个人|我是|姓名/.test(combined)) return "fact"
    if (/prefer|偏好|喜欢|爱玩/.test(combined)) return "preference"
    if (/style|沟通|中文|语言/.test(combined)) return "preference"
    return "preference"
  }
  if (/技术栈|tech|stack/.test(combined)) return "convention"
  if (/项目|project/.test(combined)) return "discovery"
  if (/竞赛|荣誉|award/.test(combined)) return "fact"
  if (/研究|论文|科研/.test(combined)) return "discovery"
  if (/游戏|gaming/.test(combined)) return "fact"
  if (/课程|course/.test(combined)) return "fact"
  return "discovery"
}

function extractConcepts(content: string): string[] {
  const concepts: string[] = []
  const patterns: [RegExp, string][] = [
    [/python/gi, "python"],
    [/fastapi/gi, "fastapi"],
    [/react/gi, "react"],
    [/pytorch/gi, "pytorch"],
    [/深度学习/gi, "deep-learning"],
    [/计算机视觉|CV/gi, "cv"],
    [/NLP|自然语言/gi, "nlp"],
    [/agent/gi, "agent"],
    [/RAG/gi, "rag"],
    [/LLM|大语言模型/gi, "llm"],
    [/c\+\+/gi, "c++"],
    [/游戏/gi, "gaming"],
    [/CSGO/gi, "csgo"],
    [/苏大|苏州大学/gi, "suda"],
    [/东南大学/gi, "seu"],
    [/竞赛/gi, "competition"],
    [/论文/gi, "paper"],
    [/专利/gi, "patent"],
    [/MySQL/gi, "mysql"],
    [/DeepSeek/gi, "deepseek"],
  ]
  for (const [regex, concept] of patterns) {
    if (regex.test(content) && !concepts.includes(concept)) {
      concepts.push(concept)
    }
  }
  return concepts.slice(0, 10)
}

export function migrateMarkdownToSqlite(): Effect.Effect<{ imported: number; skipped: number }, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const db = new MemoryDb()

    const memoryPath = path.join(DIRECTORY, MEMORY_FILE)
    const userPath = path.join(DIRECTORY, USER_FILE)

    let imported = 0
    let skipped = 0

    const files: { path: string; scope: string }[] = [
      { path: memoryPath, scope: "memory" },
      { path: userPath, scope: "user" },
    ]

    for (const file of files) {
      const exists = yield* fs.existsSafe(file.path).pipe(Effect.orDie)
      if (!exists) {
        log.warn("memory file not found, skipping", { path: file.path })
        continue
      }

      const text = (yield* fs.readFileStringSafe(file.path).pipe(Effect.orDie)) ?? ""
      if (!text.trim()) continue

      const entries = parseLegacyMarkdown(text)
      log.info("parsed legacy entries", { path: file.path, count: entries.length })

      for (const entry of entries) {
        if (entry.status === "superseded") {
          skipped++
          continue
        }

        const sessionId = entry.source?.startsWith("session:")
          ? entry.source.slice("session:".length)
          : `legacy-migration`
        const section = "Legacy"
        const obsType = determineObservationType(file.scope, section, entry.content)

        const input: ObservationInput = {
          memory_session_id: sessionId,
          kind: "manual",
          type: obsType,
          title: entry.reason?.slice(0, 80) || entry.content.slice(0, 80),
          subtitle: entry.source || null,
          narrative: entry.content.slice(0, 2000),
          facts: entry.content
            .split(/[。；\n]/)
            .map((s) => s.trim())
            .filter((s) => s.length > 5 && s.length < 300)
            .slice(0, 10),
          concepts: extractConcepts(entry.content),
          metadata: {
            legacy_id: entry.id,
            legacy_confidence: entry.confidence,
            legacy_source: entry.source,
            migrated_at: new Date().toISOString(),
          },
          time_created: entry.date ? new Date(entry.date).getTime() : Date.now(),
        }

        const result = db.createObservation(input)
        if (result) {
          imported++
          log.debug("migrated entry", { legacyId: entry.id, newId: result.id })
        } else {
          skipped++
        }
      }
    }

    db.close()
    log.info("migration complete", { imported, skipped })
    return { imported, skipped }
  })
}
