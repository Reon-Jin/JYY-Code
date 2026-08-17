import { MessageID, SessionID } from "./schema"
import { NonNegativeInt } from "@jyycode-ai/core/schema"
import { Schema, Types } from "effect"
import { Token } from "@/util/token"

/** The stable source boundary that a compaction attempt is allowed to read. */
export const SourceHighWatermark = Schema.Struct({
  id: Schema.String,
  created: NonNegativeInt,
}).annotate({ identifier: "CompactionSourceHighWatermark" })
export type SourceHighWatermark = Types.DeepMutable<Schema.Schema.Type<typeof SourceHighWatermark>>

export const ContextMeasure = Schema.Struct({
  tokens: NonNegativeInt,
  bytes: NonNegativeInt,
}).annotate({ identifier: "CompactionContextMeasure" })
export type ContextMeasure = Types.DeepMutable<Schema.Schema.Type<typeof ContextMeasure>>

export const CheckpointStatus = Schema.Literals([
  "pending",
  "active",
  "complete",
  "no_progress",
  "cancelled",
  "corrupt",
])
export type CheckpointStatus = Schema.Schema.Type<typeof CheckpointStatus>

/**
 * A checkpoint intentionally contains only structured recovery facts. It is
 * safe to persist alongside the compaction marker and does not contain raw
 * tool output or attachment bytes.
 */
export const CompactionCheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionID: SessionID,
  sourceHighWatermark: SourceHighWatermark,
  before: ContextMeasure,
  after: Schema.optional(ContextMeasure),
  attempt: NonNegativeInt,
  instructionDigests: Schema.Array(Schema.String),
  goal: Schema.String,
  constraints: Schema.Array(Schema.String),
  decisions: Schema.Array(Schema.String),
  progress: Schema.Array(Schema.String),
  files: Schema.Array(Schema.String),
  commands: Schema.Array(Schema.String),
  tests: Schema.Array(Schema.String),
  pending: Schema.Array(Schema.String),
  blocked: Schema.Array(Schema.String),
  verbatimTailMessageIDs: Schema.Array(MessageID),
  status: CheckpointStatus,
  reason: Schema.optional(Schema.String),
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
}).annotate({ identifier: "CompactionCheckpoint" })
export type CompactionCheckpoint = Types.DeepMutable<Schema.Schema.Type<typeof CompactionCheckpointSchema>>

export type CheckpointInput = Partial<
  Pick<
    CompactionCheckpoint,
    | "after"
    | "instructionDigests"
    | "goal"
    | "constraints"
    | "decisions"
    | "progress"
    | "files"
    | "commands"
    | "tests"
    | "pending"
    | "blocked"
    | "verbatimTailMessageIDs"
    | "reason"
    | "attempt"
    | "status"
  >
> & {
  sessionID: SessionID
  sourceHighWatermark: SourceHighWatermark
  before: ContextMeasure
}

const unique = (items: readonly string[] | undefined): string[] => [...new Set((items ?? []).filter(Boolean))]

type SourceMessage = {
  info?: { id?: string; role?: string; time?: { created?: number }; summary?: unknown }
  parts?: ReadonlyArray<{ type?: string }>
}

export function createCheckpoint(input: CheckpointInput): CompactionCheckpoint {
  const now = Date.now()
  return {
    version: 1,
    sessionID: input.sessionID,
    sourceHighWatermark: { ...input.sourceHighWatermark },
    before: { ...input.before },
    ...(input.after ? { after: { ...input.after } } : {}),
    attempt: input.attempt ?? 1,
    instructionDigests: unique(input.instructionDigests),
    goal: input.goal ?? "",
    constraints: unique(input.constraints),
    decisions: unique(input.decisions),
    progress: unique(input.progress),
    files: unique(input.files),
    commands: unique(input.commands),
    tests: unique(input.tests),
    pending: unique(input.pending),
    blocked: unique(input.blocked),
    verbatimTailMessageIDs: [...new Set(input.verbatimTailMessageIDs ?? [])],
    status: input.status ?? "pending",
    ...(input.reason ? { reason: input.reason } : {}),
    createdAt: now,
    updatedAt: now,
  }
}

export function updateCheckpoint(
  checkpoint: CompactionCheckpoint,
  update: Partial<
    Pick<
      CompactionCheckpoint,
      "after" | "progress" | "pending" | "blocked" | "verbatimTailMessageIDs" | "status" | "reason"
    >
  >,
): CompactionCheckpoint {
  return {
    ...checkpoint,
    ...(update.after ? { after: { ...update.after } } : {}),
    ...(update.progress ? { progress: unique(update.progress) } : {}),
    ...(update.pending ? { pending: unique(update.pending) } : {}),
    ...(update.blocked ? { blocked: unique(update.blocked) } : {}),
    ...(update.verbatimTailMessageIDs ? { verbatimTailMessageIDs: [...new Set(update.verbatimTailMessageIDs)] } : {}),
    ...(update.status ? { status: update.status } : {}),
    ...(update.reason ? { reason: update.reason } : {}),
    updatedAt: Date.now(),
  }
}

export function encodeCheckpoint(checkpoint: CompactionCheckpoint): string {
  return JSON.stringify(checkpoint)
}

export function decodeCheckpoint(input: unknown): CompactionCheckpoint | undefined {
  try {
    return Schema.decodeUnknownSync(CompactionCheckpointSchema)(input) as CompactionCheckpoint
  } catch {
    return undefined
  }
}

export function validateCheckpoint(
  checkpoint: unknown,
  input?: { sessionID?: SessionID; sourceHighWatermark?: SourceHighWatermark },
): checkpoint is CompactionCheckpoint {
  const decoded = decodeCheckpoint(checkpoint)
  if (!decoded) return false
  if (input?.sessionID && decoded.sessionID !== input.sessionID) return false
  if (input?.sourceHighWatermark && !sameSourceHighWatermark(decoded.sourceHighWatermark, input.sourceHighWatermark))
    return false
  return true
}

/** Returns the newest non-compaction user boundary, or the newest message. */
export function sourceHighWatermark(messages: ReadonlyArray<SourceMessage>): SourceHighWatermark {
  const candidates = messages.filter((message) => {
    if (!message.info?.id) return false
    if (message.info.role === "assistant" && message.info.summary) return false
    if (message.info.role === "user" && message.parts?.some((part) => part.type === "compaction")) return false
    return true
  })
  const latest = candidates.reduce<(typeof candidates)[number] | undefined>((current, message) => {
    if (!current) return message
    const currentCreated = current.info?.time?.created ?? 0
    const created = message.info?.time?.created ?? 0
    if (created !== currentCreated) return created > currentCreated ? message : current
    return String(message.info?.id).localeCompare(String(current.info?.id)) > 0 ? message : current
  }, undefined)
  return {
    id: String(latest?.info?.id ?? ""),
    created: Math.max(0, Math.floor(latest?.info?.time?.created ?? 0)),
  }
}

export function sameSourceHighWatermark(a: SourceHighWatermark, b: SourceHighWatermark) {
  return a.id === b.id && a.created === b.created
}

/**
 * Measures the effective serialized context. This deliberately measures the
 * bounded message representation supplied by the caller; it never reads or
 * expands attachment contents.
 */
export function measureEffectiveContext(messages: readonly unknown[]): ContextMeasure {
  const serialized = JSON.stringify(messages)
  const bytes = Buffer.byteLength(serialized, "utf8")
  return {
    bytes,
    tokens: Math.max(0, Math.floor(Token.estimate(serialized))),
  }
}

export function requiredProgressTokens(before: ContextMeasure) {
  return Math.max(4_096, Math.ceil(before.tokens * 0.1))
}

export type ProgressAssessment = {
  ok: boolean
  requiredTokens: number
  tokenReduction: number
  byteReduction: number
  reason?: "no_progress" | "expanded" | "insufficient_reduction"
}

export function assessProgress(before: ContextMeasure, after: ContextMeasure): ProgressAssessment {
  const requiredTokens = requiredProgressTokens(before)
  const tokenReduction = before.tokens - after.tokens
  const byteReduction = before.bytes - after.bytes
  if (after.tokens > before.tokens || after.bytes > before.bytes) {
    return { ok: false, requiredTokens, tokenReduction, byteReduction, reason: "expanded" }
  }
  if (tokenReduction < requiredTokens || byteReduction <= 0) {
    return { ok: false, requiredTokens, tokenReduction, byteReduction, reason: "insufficient_reduction" }
  }
  return { ok: true, requiredTokens, tokenReduction, byteReduction }
}

export const Checkpoint = {
  Schema: CompactionCheckpointSchema,
  create: createCheckpoint,
  update: updateCheckpoint,
  encode: encodeCheckpoint,
  decode: decodeCheckpoint,
  validate: validateCheckpoint,
  sourceHighWatermark,
  sameSourceHighWatermark,
  measureEffectiveContext,
  requiredProgressTokens,
  assessProgress,
}
