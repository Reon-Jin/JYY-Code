import path from "path"
import { createHash } from "crypto"
import { Context, Effect, Layer } from "effect"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { EffectFlock } from "@jyycode-ai/core/util/effect-flock"
import * as Log from "@jyycode-ai/core/util/log"
import { SessionID } from "@/session/schema"
import { normalizeKeywords, parseImportance, validateKeywords } from "./memory"
import { buildCorpusStats, buildQueryTerms, scoreExperience } from "./experience-score"
import { EXPERIENCE_DIRECTORY, LEGACY_EXPERIENCE_DIRECTORY, workspaceDirectory } from "./runtime-path"
import { sanitizeForPersistence } from "./sanitize"
import type { Importance } from "./memory"
import {
  EXPERIENCE_CONFIDENCES,
  EXPERIENCE_CONTENT_CHAR_LIMIT,
  EXPERIENCE_EVIDENCE_ANCHOR,
  EXPERIENCE_EVIDENCE_CHAR_LIMIT,
  EXPERIENCE_KINDS,
  EXPERIENCE_STATUSES,
} from "./experience-schema"
import type { ExperienceCandidate, ExperienceConfidence, ExperienceKind, ExperienceStatus } from "./experience-schema"
export type { ExperienceCandidate, ExperienceConfidence, ExperienceKind, ExperienceStatus } from "./experience-schema"

const log = Log.create({ service: "memory.experience" })

export const EXPERIENCE_FILE = "EXPERIENCE.json"
export const EXPERIENCE_CHAR_LIMIT = 10_000
export const EXPERIENCE_ENTRY_LIMIT = 100
export const EXPERIENCE_CAPACITY_WARN = 0.8
export const EXPERIENCE_SNAPSHOT_TOP_K = 10
export const EXPERIENCE_SNAPSHOT_MAX_CHARS = 1_200
export const EXPERIENCE_MAINTENANCE_INTERVAL_TURNS = 20
const managementSessionID = SessionID.make("ses_desktop_management")

export type ExperienceEntry = {
  scope: "experience"
  kind: ExperienceKind
  importance: Importance
  date: string
  updatedAt: string
  keywords: string[]
  content: string
  evidence: string
  confidence: ExperienceConfidence
  uses: number
  status: ExperienceStatus
  sessionID: SessionID
  supersededReason?: string
}

export type ExperienceStore = {
  schemaVersion: 1
  lastMaintainedAt: string | null
  entries: ExperienceEntry[]
}

export type ExperienceMutationResult = {
  status: "written" | "duplicate" | "merged" | "superseded" | "capacity_rejected"
  key: string
  message: string
}

export type ExperienceMaintenanceResult = {
  removed: number
  merged: number
  retained: number
}

export interface ExperienceInterface {
  readonly ensure: (sessionID: SessionID, workspaceRoot?: string) => Effect.Effect<void, Error>
  readonly readStore: (sessionID: SessionID, workspaceRoot?: string) => Effect.Effect<ExperienceStore, Error>
  readonly upsert: (
    sessionID: SessionID,
    candidate: ExperienceCandidate,
    workspaceRoot?: string,
  ) => Effect.Effect<ExperienceMutationResult, Error>
  readonly upsertMany: (
    sessionID: SessionID,
    candidates: readonly ExperienceCandidate[],
    workspaceRoot?: string,
  ) => Effect.Effect<number, Error>
  readonly search: (input: {
    sessionID: SessionID
    query: string
    kind?: ExperienceKind
    limit?: number
    workspaceRoot?: string
  }) => Effect.Effect<ExperienceEntry[], Error>
  readonly formatExperienceSnapshot: (
    sessionID: SessionID,
    taskKeywords: readonly string[],
    taskGoal?: string,
    workspaceRoot?: string,
  ) => Effect.Effect<string, Error>
  readonly maintain: (sessionID: SessionID, workspaceRoot?: string) => Effect.Effect<ExperienceMaintenanceResult, Error>
  readonly managementRead: () => Effect.Effect<ExperienceStore, Error>
  readonly managementUpdate: (input: {
    expected: ExperienceEntry
    replacement: ExperienceEntry
  }) => Effect.Effect<ExperienceEntry, Error>
  readonly managementRemove: (input: { expected: ExperienceEntry }) => Effect.Effect<void, Error>
  readonly managementCompact: () => Effect.Effect<ExperienceMaintenanceResult, Error>
}

export class Service extends Context.Service<Service, ExperienceInterface>()("@jyycode/ExperienceMemory") {}

export function parseExperienceStore(text: string): ExperienceStore {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid experience JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const root = expectRecord(value, "experience store")
  assertExactFields(root, ["schemaVersion", "lastMaintainedAt", "entries"], "experience store")
  if (root.schemaVersion !== 1) throw new Error("Invalid experience schemaVersion: expected 1")
  if (
    root.lastMaintainedAt !== null &&
    (typeof root.lastMaintainedAt !== "string" || !isCalendarDate(root.lastMaintainedAt))
  ) {
    throw new Error("Invalid experience lastMaintainedAt")
  }
  if (!Array.isArray(root.entries)) throw new Error("Invalid experience entries: expected an array")
  const entries = root.entries.map((entry, index) => normalizeExperience(parseExperienceObject(entry, index)))
  const keys = new Set<string>()
  for (const entry of entries) {
    const key = storedExperienceKey(entry)
    if (keys.has(key)) throw new Error(`Invalid experience store: duplicate key ${key}`)
    keys.add(key)
  }
  return { schemaVersion: 1, lastMaintainedAt: root.lastMaintainedAt as string | null, entries }
}

export function serializeExperienceStore(
  entries: readonly ExperienceEntry[],
  lastMaintainedAt: string | null = null,
): string {
  if (lastMaintainedAt !== null && !isCalendarDate(lastMaintainedAt)) {
    throw new Error("Invalid experience lastMaintainedAt")
  }
  const normalized = entries.map((entry, index) => {
    const value = normalizeExperience(entry)
    if (value.scope !== "experience") throw new Error(`Invalid experience entry scope at index ${index}`)
    return value
  })
  const keys = new Set<string>()
  for (const entry of normalized) {
    const key = storedExperienceKey(entry)
    if (keys.has(key)) throw new Error(`Invalid experience store: duplicate key ${key}`)
    keys.add(key)
  }
  const stored = normalized.map((entry) => ({
    kind: entry.kind,
    importance: entry.importance,
    date: entry.date,
    updatedAt: entry.updatedAt,
    keywords: entry.keywords,
    content: entry.content,
    evidence: entry.evidence,
    confidence: entry.confidence,
    uses: entry.uses,
    status: entry.status,
    sessionID: entry.sessionID,
    ...(entry.supersededReason ? { supersededReason: entry.supersededReason } : {}),
  }))
  return JSON.stringify({ schemaVersion: 1, lastMaintainedAt, entries: stored }, null, 2) + "\n"
}

export function experienceKey(entry: Pick<ExperienceEntry, "content">): string {
  return createHash("sha256").update(canonicalExperienceContent(entry.content)).digest("base64url").slice(0, 22)
}

export function storedExperienceKey(entry: Pick<ExperienceEntry, "sessionID" | "content">): string {
  return `${entry.sessionID}\0${experienceKey(entry)}`
}

export function experienceClusterMatch(
  left: Pick<ExperienceEntry, "keywords">,
  right: Pick<ExperienceEntry, "keywords">,
): boolean {
  const intersection = left.keywords.filter((keyword) => right.keywords.includes(keyword)).length
  const union = new Set([...left.keywords, ...right.keywords]).size
  if (union === 0) return false
  return intersection / union >= 0.5
}

export function oppositeExperienceKind(
  left: Pick<ExperienceEntry, "kind">,
  right: Pick<ExperienceEntry, "kind">,
): boolean {
  return (left.kind === "success" && right.kind === "failure") || (left.kind === "failure" && right.kind === "success")
}

export function maintainStore(store: ExperienceStore): { entries: ExperienceEntry[]; removed: number; merged: number } {
  let entries = [...store.entries]
  let removed = 0
  let merged = 0
  for (let left = 0; left < entries.length; left++) {
    for (let right = entries.length - 1; right > left; right--) {
      const a = entries[left]!
      const b = entries[right]!
      if (a.status !== "active" || b.status !== "active") continue
      if (storedExperienceKey(a) === storedExperienceKey(b)) {
        entries[left] = mergeExperienceEntries(a, b)
        entries.splice(right, 1)
        merged++
      }
    }
  }
  const cutoff = dateNDaysAgo(30)
  const afterExpiry: ExperienceEntry[] = []
  for (const entry of entries) {
    if (entry.status === "active" || entry.updatedAt >= cutoff) {
      afterExpiry.push(entry)
      continue
    }
    removed++
  }
  entries = afterExpiry
  const afterDecay: ExperienceEntry[] = []
  for (const entry of entries) {
    if (entry.status === "active" && entry.confidence === "low" && entry.uses === 0 && entry.updatedAt < cutoff) {
      removed++
      continue
    }
    afterDecay.push(entry)
  }
  entries = afterDecay
  const retention = (entry: ExperienceEntry, index: number) =>
    entry.importance * 100 + entry.uses * 10 + (entry.status === "active" ? 5 : 0) + index / 1_000
  while (entries.length > EXPERIENCE_ENTRY_LIMIT) {
    let min = 0
    for (let index = 1; index < entries.length; index++) {
      if (retention(entries[index]!, index) < retention(entries[min]!, min)) min = index
    }
    entries.splice(min, 1)
    removed++
  }
  let text = serializeExperienceStore(entries, store.lastMaintainedAt)
  while (text.length > EXPERIENCE_CHAR_LIMIT) {
    let min = 0
    for (let index = 1; index < entries.length; index++) {
      if (retention(entries[index]!, index) < retention(entries[min]!, min)) min = index
    }
    entries.splice(min, 1)
    removed++
    text = serializeExperienceStore(entries, store.lastMaintainedAt)
  }
  return { entries, removed, merged }
}

export function localDate(date: Date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, "0")
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}${month}${day}`
}

export function dateNDaysAgo(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return localDate(date)
}

export const layerWithDirectory = (directory: string, options: { legacyDirectory?: string } = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const flock = yield* EffectFlock.Service
      const experienceDirectory = path.normalize(directory)
      const legacyDirectory = options.legacyDirectory ? path.normalize(options.legacyDirectory) : undefined

      const filePath = Effect.fn("ExperienceMemory.filePath")(function* (
        _sessionID: SessionID,
        workspaceRoot?: string,
      ) {
        return path.join(workspaceDirectory(experienceDirectory, workspaceRoot), EXPERIENCE_FILE)
      })

      const ensure = Effect.fn("ExperienceMemory.ensure")(function* (sessionID: SessionID, workspaceRoot?: string) {
        const target = yield* filePath(sessionID, workspaceRoot)
        yield* fs.ensureDir(path.dirname(target)).pipe(Effect.orDie)
        const exists = yield* fs.existsSafe(target).pipe(Effect.orDie)
        const targetText = (yield* fs.readFileStringSafe(target).pipe(Effect.orDie))?.trim()
        let needsLegacy = !exists || !targetText
        if (!needsLegacy && !workspaceRoot && legacyDirectory) {
          const current = yield* Effect.try({ try: () => parseExperienceStore(targetText), catch: asError })
          needsLegacy = current.entries.length === 0
        }
        if (needsLegacy) {
          const legacyTarget =
            !workspaceRoot && legacyDirectory ? path.join(legacyDirectory, EXPERIENCE_FILE) : undefined
          if (legacyTarget && path.resolve(legacyTarget) !== path.resolve(target)) {
            const legacyText = (yield* fs.readFileStringSafe(legacyTarget).pipe(Effect.orDie))?.trim()
            if (legacyText) {
              yield* Effect.try({ try: () => parseExperienceStore(legacyText), catch: asError })
              yield* fs.writeWithDirs(target, `${legacyText}\n`).pipe(Effect.orDie)
              return
            }
          }
          yield* fs.writeWithDirs(target, serializeExperienceStore([])).pipe(Effect.orDie)
        }
      })

      const readStore = Effect.fn("ExperienceMemory.readStore")(function* (
        sessionID: SessionID,
        workspaceRoot?: string,
      ) {
        yield* ensure(sessionID, workspaceRoot)
        const text = (yield* fs.readFileStringSafe(yield* filePath(sessionID, workspaceRoot)).pipe(Effect.orDie)) ?? ""
        return yield* Effect.try({ try: () => parseExperienceStore(text), catch: (error) => asError(error) })
      })

      const writeFileAtomic = Effect.fn("ExperienceMemory.writeFileAtomic")(function* (
        target: string,
        content: string,
      ) {
        const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
        yield* fs.writeWithDirs(temp, content)
        yield* fs.rename(temp, target).pipe(Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore)))
      })

      const writeStore = Effect.fn("ExperienceMemory.writeStore")(function* (
        sessionID: SessionID,
        store: ExperienceStore,
        workspaceRoot?: string,
      ) {
        yield* writeFileAtomic(
          yield* filePath(sessionID, workspaceRoot),
          serializeExperienceStore(store.entries, store.lastMaintainedAt),
        )
      })

      const appendAudit = Effect.fn("ExperienceMemory.appendAudit")(function* (
        sessionID: SessionID,
        entry: Record<string, unknown>,
        workspaceRoot?: string,
      ) {
        const scopedDirectory = workspaceDirectory(directory, workspaceRoot)
        const target = path.join(scopedDirectory, "audit.jsonl")
        yield* fs.ensureDir(scopedDirectory).pipe(Effect.orDie)
        const safeEntry = sanitizeAuditEntry(entry)
        yield* flock
          .withLock(
            Effect.gen(function* () {
              const current = (yield* fs.readFileStringSafe(target).pipe(Effect.orDie)) ?? ""
              yield* writeFileAtomic(
                target,
                current + JSON.stringify({ time: new Date().toISOString(), ...safeEntry }) + "\n",
              )
            }),
            target,
          )
          .pipe(
            Effect.catchCause((cause) => Effect.sync(() => log.error("failed to append experience audit", { cause }))),
          )
      })

      const upsert = Effect.fn("ExperienceMemory.upsert")(function* (
        sessionID: SessionID,
        candidate: ExperienceCandidate,
        workspaceRoot?: string,
      ) {
        yield* ensure(sessionID, workspaceRoot)
        const entry = normalizeExperience({
          scope: "experience",
          kind: candidate.kind,
          importance: candidate.importance,
          date: localDate(),
          updatedAt: localDate(),
          keywords: candidate.keywords,
          content: candidate.content,
          evidence: candidate.evidence,
          confidence: candidate.confidence,
          uses: 0,
          status: "active",
          sessionID,
        })
        const target = yield* filePath(sessionID, workspaceRoot)
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(sessionID, workspaceRoot)
            const entries = [...store.entries]
            const key = experienceKey(entry)
            const storedKey = storedExperienceKey(entry)
            const exact = entries.findIndex((existing) => storedExperienceKey(existing) === storedKey)
            if (exact !== -1) {
              yield* appendAudit(sessionID, { action: "memory.experience.duplicate", key }, workspaceRoot)
              return { status: "duplicate" as const, key, message: "Duplicate experience already exists." }
            }
            const cluster = entries.flatMap((existing, index) =>
              existing.status === "active" && experienceClusterMatch(existing, entry) ? [index] : [],
            )
            const opposite = cluster.find((index) => oppositeExperienceKind(entries[index]!, entry))
            if (opposite !== undefined) {
              const old = entries[opposite]!
              entries[opposite] = {
                ...old,
                status: "superseded",
                supersededReason: `Outcome reversed by ${sessionID} on ${entry.updatedAt}: ${entry.content.slice(0, 80)}`,
              }
              entries.push(entry)
              yield* writeStore(sessionID, { ...store, entries }, workspaceRoot)
              yield* appendAudit(
                sessionID,
                {
                  action: "memory.experience.superseded",
                  key,
                  oldKey: experienceKey(old),
                },
                workspaceRoot,
              )
              return {
                status: "superseded" as const,
                key,
                message: "New experience superseded the opposite earlier lesson.",
              }
            }
            const sameKind = cluster.filter(
              (index) => entries[index]!.kind === entry.kind && entries[index]!.sessionID === sessionID,
            )
            if (sameKind.length > 0) {
              let merged = entry
              for (const index of sameKind) merged = mergeExperienceEntries(merged, entries[index]!)
              entries[sameKind[0]!] = merged
              for (const index of sameKind.slice(1).reverse()) entries.splice(index, 1)
              yield* writeStore(sessionID, { ...store, entries }, workspaceRoot)
              yield* appendAudit(
                sessionID,
                {
                  action: "memory.experience.merged",
                  key,
                  merged: sameKind.length,
                },
                workspaceRoot,
              )
              return {
                status: "merged" as const,
                key: experienceKey(merged),
                message: "Merged with a same-session experience.",
              }
            }
            entries.push(entry)
            const projected = serializeExperienceStore(entries, store.lastMaintainedAt)
            if (projected.length > EXPERIENCE_CHAR_LIMIT || entries.length > EXPERIENCE_ENTRY_LIMIT) {
              const outcome = maintainStore({ ...store, entries })
              const retained = outcome.entries.some((existing) => storedExperienceKey(existing) === storedKey)
              if (!retained || outcome.entries.length > EXPERIENCE_ENTRY_LIMIT) {
                yield* appendAudit(sessionID, { action: "memory.experience.capacity_rejected", key }, workspaceRoot)
                return { status: "capacity_rejected" as const, key, message: "Experience rejected at capacity." }
              }
              const next: ExperienceStore = {
                schemaVersion: 1,
                lastMaintainedAt: localDate(),
                entries: outcome.entries,
              }
              yield* writeStore(sessionID, next, workspaceRoot)
              yield* appendAudit(
                sessionID,
                {
                  action: "memory.experience.maintain_on_write",
                  removed: outcome.removed,
                  merged: outcome.merged,
                },
                workspaceRoot,
              )
            } else {
              yield* writeStore(sessionID, { ...store, entries }, workspaceRoot)
            }
            yield* appendAudit(
              sessionID,
              {
                action: "memory.experience.written",
                key,
                kind: entry.kind,
              },
              workspaceRoot,
            )
            return { status: "written" as const, key, message: "Experience stored." }
          }),
          target,
        )
      })

      const upsertMany = Effect.fn("ExperienceMemory.upsertMany")(function* (
        sessionID: SessionID,
        candidates: readonly ExperienceCandidate[],
        workspaceRoot?: string,
      ) {
        const results = yield* Effect.forEach(candidates, (candidate) => upsert(sessionID, candidate, workspaceRoot), {
          concurrency: 1,
        })
        return results.filter((result) => result.status !== "duplicate").length
      })

      const search = Effect.fn("ExperienceMemory.search")(function* (input: {
        sessionID: SessionID
        query: string
        kind?: ExperienceKind
        limit?: number
        workspaceRoot?: string
      }) {
        yield* ensure(input.sessionID, input.workspaceRoot)
        const query = input.query.normalize("NFKC").trim().toLowerCase()
        const limit = Math.min(10, Math.max(1, input.limit ?? 5))
        const target = yield* filePath(input.sessionID, input.workspaceRoot)
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(input.sessionID, input.workspaceRoot)
            const candidates = store.entries.filter(
              (entry) => entry.status === "active" && (!input.kind || entry.kind === input.kind),
            )
            const queryTerms = buildQueryTerms([], query, 1)
            let scored: Array<{ entry: ExperienceEntry; score: number }> = []
            if (queryTerms.size > 0 && candidates.length > 0) {
              const stats = buildCorpusStats(candidates)
              scored = candidates
                .map((entry) => ({ entry, score: scoreExperience(entry, queryTerms, [], stats) }))
                .filter(({ score }) => score > 0)
                .sort(
                  (a, b) =>
                    b.score - a.score ||
                    b.entry.importance - a.entry.importance ||
                    b.entry.uses - a.entry.uses ||
                    b.entry.date.localeCompare(a.entry.date),
                )
                .slice(0, limit)
            }
            const byKey = new Map(store.entries.map((entry) => [storedExperienceKey(entry), entry]))
            if (scored.length > 0) {
              for (const { entry } of scored) {
                const key = storedExperienceKey(entry)
                const current = byKey.get(key) ?? entry
                byKey.set(key, { ...current, uses: current.uses + 1 })
              }
              yield* writeStore(input.sessionID, { ...store, entries: [...byKey.values()] }, input.workspaceRoot)
              yield* appendAudit(
                input.sessionID,
                { action: "memory.experience.search", query, hits: scored.length },
                input.workspaceRoot,
              )
            }
            return scored.map(({ entry }) => byKey.get(storedExperienceKey(entry)) ?? entry)
          }),
          target,
        )
      })

      const formatExperienceSnapshot = Effect.fn("ExperienceMemory.formatExperienceSnapshot")(function* (
        sessionID: SessionID,
        taskKeywords: readonly string[],
        taskGoal?: string,
        workspaceRoot?: string,
      ) {
        yield* ensure(sessionID, workspaceRoot)
        const store = yield* readStore(sessionID, workspaceRoot)
        const active = store.entries.filter((entry) => entry.status === "active")
        if (active.length === 0) return ""
        const normalizedKeywords = normalizeKeywords(taskKeywords)
        const queryTerms = buildQueryTerms(normalizedKeywords, taskGoal ?? "")
        if (queryTerms.size === 0) return ""
        const stats = buildCorpusStats(active)
        const matched = active
          .map((entry) => ({
            entry,
            score: scoreExperience(entry, queryTerms, normalizedKeywords, stats),
          }))
          .filter(({ score }) => score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              b.entry.importance - a.entry.importance ||
              b.entry.uses - a.entry.uses ||
              b.entry.date.localeCompare(a.entry.date),
          )
          .slice(0, EXPERIENCE_SNAPSHOT_TOP_K)
        if (matched.length === 0) return ""
        const lines = ["# EXPERIENCE（跨会话经验：先查相关经验，再动手）"]
        let budget = EXPERIENCE_SNAPSHOT_MAX_CHARS - lines[0]!.length - 1
        for (const { entry } of matched) {
          const line = `- [${entry.kind}] ${sanitizeForPersistence(entry.content).text}`
          if (budget <= 0) break
          const bounded = line.length <= budget ? line : `${line.slice(0, budget - 1)}…`
          lines.push(bounded)
          budget -= bounded.length + 1
        }
        return lines.join("\n") + "\n"
      })

      const maintain = Effect.fn("ExperienceMemory.maintain")(function* (sessionID: SessionID, workspaceRoot?: string) {
        yield* ensure(sessionID, workspaceRoot)
        const target = yield* filePath(sessionID, workspaceRoot)
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(sessionID, workspaceRoot)
            const outcome = maintainStore(store)
            const next: ExperienceStore = { schemaVersion: 1, lastMaintainedAt: localDate(), entries: outcome.entries }
            yield* writeStore(sessionID, next, workspaceRoot)
            yield* appendAudit(sessionID, {
              action: "memory.experience.maintain",
              removed: outcome.removed,
              merged: outcome.merged,
              retained: outcome.entries.length,
            })
            return { removed: outcome.removed, merged: outcome.merged, retained: outcome.entries.length }
          }),
          target,
        )
      })

      const managementRead = Effect.fn("ExperienceMemory.managementRead")(function* () {
        return yield* readStore(managementSessionID)
      })

      const managementUpdate = Effect.fn("ExperienceMemory.managementUpdate")(function* (input: {
        expected: ExperienceEntry
        replacement: ExperienceEntry
      }) {
        if (input.expected.scope !== "experience" || input.replacement.scope !== "experience") {
          return yield* Effect.fail(new Error("Experience scope mismatch"))
        }
        const replacement = yield* Effect.try({
          try: () => normalizeExperience(input.replacement),
          catch: (error) => asError(error),
        })
        const target = yield* filePath(managementSessionID)
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(managementSessionID)
            const index = store.entries.findIndex((entry) => sameExperienceEntry(entry, input.expected))
            if (index === -1) return yield* Effect.fail(new Error("Experience entry is missing or stale"))
            const duplicate = store.entries.findIndex(
              (entry, candidateIndex) =>
                candidateIndex !== index &&
                entry.sessionID === replacement.sessionID &&
                storedExperienceKey(entry) === storedExperienceKey(replacement),
            )
            if (duplicate !== -1) {
              return yield* Effect.fail(new Error("Experience entry conflicts with an existing entry"))
            }
            const entries = [...store.entries]
            entries[index] = replacement
            yield* writeStore(managementSessionID, { ...store, entries })
            yield* appendAudit(managementSessionID, {
              action: "memory.experience.management_update",
              key: experienceKey(replacement),
            })
            return replacement
          }),
          target,
        )
      })

      const managementRemove = Effect.fn("ExperienceMemory.managementRemove")(function* (input: {
        expected: ExperienceEntry
      }) {
        const target = yield* filePath(managementSessionID)
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(managementSessionID)
            const index = store.entries.findIndex((entry) => sameExperienceEntry(entry, input.expected))
            if (index === -1) return yield* Effect.fail(new Error("Experience entry is missing or stale"))
            const entries = store.entries.filter((_, candidateIndex) => candidateIndex !== index)
            yield* writeStore(managementSessionID, { ...store, entries })
            yield* appendAudit(managementSessionID, {
              action: "memory.experience.management_remove",
              key: experienceKey(input.expected),
              content: input.expected.content,
            })
          }),
          target,
        )
      })

      const managementCompact = Effect.fn("ExperienceMemory.managementCompact")(function* () {
        const target = yield* filePath(managementSessionID)
        return yield* flock.withLock(
          Effect.gen(function* () {
            const store = yield* readStore(managementSessionID)
            const outcome = maintainStore(store)
            const next: ExperienceStore = {
              schemaVersion: 1,
              lastMaintainedAt: localDate(),
              entries: outcome.entries,
            }
            yield* writeStore(managementSessionID, next)
            yield* appendAudit(managementSessionID, {
              action: "memory.experience.management_compact",
              removed: outcome.removed,
              merged: outcome.merged,
              retained: outcome.entries.length,
            })
            return { removed: outcome.removed, merged: outcome.merged, retained: outcome.entries.length }
          }),
          target,
        )
      })

      return Service.of({
        ensure,
        readStore,
        upsert,
        upsertMany,
        search,
        formatExperienceSnapshot,
        maintain,
        managementRead,
        managementUpdate,
        managementRemove,
        managementCompact,
      })
    }),
  ).pipe(Layer.provide(EffectFlock.defaultLayer))

export const layer = layerWithDirectory(EXPERIENCE_DIRECTORY, { legacyDirectory: LEGACY_EXPERIENCE_DIRECTORY })
export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

function mergeExperienceEntries(left: ExperienceEntry, right: ExperienceEntry): ExperienceEntry {
  const confidenceRank: Record<ExperienceConfidence, number> = { low: 1, medium: 2, high: 3 }
  const preferred = confidenceRank[right.confidence] > confidenceRank[left.confidence] ? right : left
  return {
    ...preferred,
    importance: Math.max(left.importance, right.importance) as Importance,
    keywords: normalizeKeywords([...left.keywords, ...right.keywords]).slice(0, 3),
    content: preferred.content,
    evidence: preferred.evidence,
    uses: Math.max(left.uses, right.uses),
    status: "active",
    date: left.date < right.date ? left.date : right.date,
    updatedAt: left.updatedAt > right.updatedAt ? left.updatedAt : right.updatedAt,
    supersededReason: undefined,
  }
}

function parseExperienceObject(value: unknown, index: number): ExperienceEntry {
  const entry = expectRecord(value, `experience entry ${index}`)
  assertExactFields(
    entry,
    [
      "kind",
      "importance",
      "date",
      "updatedAt",
      "keywords",
      "content",
      "evidence",
      "confidence",
      "uses",
      "status",
      "sessionID",
      ...(entry.supersededReason === undefined ? [] : ["supersededReason"]),
    ],
    `experience entry ${index}`,
  )
  return {
    scope: "experience",
    kind: expectString(entry.kind, "experience kind") as ExperienceKind,
    importance: parseImportance(entry.importance),
    date: expectString(entry.date, "experience date"),
    updatedAt: expectString(entry.updatedAt, "experience updatedAt"),
    keywords: expectStringArray(entry.keywords, "experience keywords"),
    content: expectString(entry.content, "experience content"),
    evidence: expectString(entry.evidence, "experience evidence"),
    confidence: expectString(entry.confidence, "experience confidence") as ExperienceConfidence,
    uses: entry.uses as number,
    status: expectString(entry.status, "experience status") as ExperienceStatus,
    sessionID: expectString(entry.sessionID, "experience sessionID") as SessionID,
    ...(entry.supersededReason === undefined
      ? {}
      : { supersededReason: expectString(entry.supersededReason, "experience supersededReason") }),
  }
}

function normalizeExperience(entry: ExperienceEntry): ExperienceEntry {
  if (!(EXPERIENCE_KINDS as readonly string[]).includes(entry.kind)) {
    throw new Error(`Invalid experience kind: ${String(entry.kind)}`)
  }
  if (!(EXPERIENCE_STATUSES as readonly string[]).includes(entry.status)) {
    throw new Error(`Invalid experience status: ${String(entry.status)}`)
  }
  if (!(EXPERIENCE_CONFIDENCES as readonly string[]).includes(entry.confidence)) {
    throw new Error(`Invalid experience confidence: ${String(entry.confidence)}`)
  }
  const importance = parseImportance(entry.importance)
  const keywords = validateKeywords(entry.keywords)
  const content = sanitizeForPersistence(
    parseSingleLine(entry.content, EXPERIENCE_CONTENT_CHAR_LIMIT, "experience content"),
  ).text
  const evidence = sanitizeForPersistence(
    parseSingleLine(entry.evidence, EXPERIENCE_EVIDENCE_CHAR_LIMIT, "experience evidence"),
  ).text
  if (!EXPERIENCE_EVIDENCE_ANCHOR.test(evidence)) {
    throw new Error("Invalid experience evidence: expected [sessionID#turn] at the start")
  }
  if (!isCalendarDate(entry.date)) throw new Error(`Invalid experience date: ${entry.date}`)
  if (!isCalendarDate(entry.updatedAt)) throw new Error(`Invalid experience updatedAt: ${entry.updatedAt}`)
  if (!Number.isInteger(entry.uses) || entry.uses < 0) throw new Error(`Invalid experience uses: ${entry.uses}`)
  const sessionID = String(entry.sessionID).trim()
  if (!sessionID || /\s/u.test(sessionID)) throw new Error("Invalid experience sessionID")
  let supersededReason: string | undefined
  if (entry.supersededReason !== undefined) {
    supersededReason = sanitizeForPersistence(
      parseSingleLine(entry.supersededReason, 200, "experience supersededReason"),
    ).text
  }
  return {
    scope: "experience",
    kind: entry.kind,
    importance,
    date: entry.date,
    updatedAt: entry.updatedAt,
    keywords,
    content,
    evidence,
    confidence: entry.confidence,
    uses: entry.uses,
    status: entry.status,
    sessionID: SessionID.make(sessionID),
    ...(supersededReason ? { supersededReason } : {}),
  }
}

function sameExperienceEntry(left: ExperienceEntry, right: ExperienceEntry): boolean {
  return JSON.stringify(normalizeExperience(left)) === JSON.stringify(normalizeExperience(right))
}

function canonicalExperienceContent(content: string) {
  return content
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s"'“”‘’.,，。:：;；!?！？_-]+/gu, "")
}

function parseSingleLine(value: string, maxChars: number, label: string): string {
  const content = value.trim()
  if (!content || /[\r\n]/u.test(content)) throw new Error(`Invalid ${label}`)
  if ([...content].length > maxChars) throw new Error(`${label} must not exceed ${maxChars} characters`)
  return content
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

function isCalendarDate(value: string): boolean {
  if (!/^\d{8}$/u.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function sanitizeAuditEntry(entry: Record<string, unknown>): Record<string, unknown> {
  let redactions = 0
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (key === "content" || key === "evidence" || key === "supersededReason") continue
    if (typeof value === "string") {
      const sanitized = sanitizeForPersistence(value)
      next[key] = sanitized.text
      redactions += sanitized.redacted
    } else {
      next[key] = value
    }
  }
  if (redactions > 0) next.redactions = Number(next.redactions ?? 0) + redactions
  return next
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

export * as ExperienceMemory from "./experience"
