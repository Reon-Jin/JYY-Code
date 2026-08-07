import path from "path"
import { createHash } from "crypto"
import { SessionID } from "@/session/schema"
import { parseImportance, validateKeywords } from "./memory"
import type { Importance } from "./memory"
import {
  EXPERIENCE_CONFIDENCES,
  EXPERIENCE_CONTENT_CHAR_LIMIT,
  EXPERIENCE_EVIDENCE_ANCHOR,
  EXPERIENCE_EVIDENCE_CHAR_LIMIT,
  EXPERIENCE_KINDS,
  EXPERIENCE_STATUSES,
} from "./experience-schema"
import type { ExperienceConfidence, ExperienceKind, ExperienceStatus } from "./experience-schema"

export const EXPERIENCE_FILE = "EXPERIENCE.json"
export const EXPERIENCE_CHAR_LIMIT = 10_000
export const EXPERIENCE_ENTRY_LIMIT = 100
export const EXPERIENCE_CAPACITY_WARN = 0.8
export const EXPERIENCE_SNAPSHOT_TOP_K = 3
export const EXPERIENCE_SNAPSHOT_MAX_CHARS = 1_200
export const EXPERIENCE_MAINTENANCE_INTERVAL_TURNS = 20

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
    const key = experienceKey(entry)
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
    const key = experienceKey(entry)
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
  const content = parseSingleLine(entry.content, EXPERIENCE_CONTENT_CHAR_LIMIT, "experience content")
  const evidence = parseSingleLine(entry.evidence, EXPERIENCE_EVIDENCE_CHAR_LIMIT, "experience evidence")
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
    supersededReason = parseSingleLine(entry.supersededReason, 200, "experience supersededReason")
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

export * as ExperienceMemory from "./experience"
