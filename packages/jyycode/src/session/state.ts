import path from "path"
import { randomUUID } from "crypto"
import { Effect, Option, Schema } from "effect"
import type { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { NonNegativeInt } from "@jyycode-ai/core/schema"
import { sanitizeForPersistence, untrustedMemoryBlock } from "@/memory/sanitize"

export const SESSION_STATE_MAX_CHARS = 3_200

export const SessionStateFile = Schema.Struct({
  version: Schema.Union([Schema.Literal(1), Schema.Literal(2)]),
  updatedAt: Schema.String,
  lastUser: Schema.optional(Schema.String),
  lastAssistant: Schema.optional(Schema.String),
  lastUserID: Schema.optional(Schema.String),
  lastAssistantID: Schema.optional(Schema.String),
  summaryID: Schema.optional(Schema.String),
  lastToolNames: Schema.optional(Schema.Array(Schema.String)),
  tailStartID: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  turnCount: Schema.optional(NonNegativeInt),
})
export type SessionStateFile = Schema.Schema.Type<typeof SessionStateFile>

export function countRealUserTurns(
  messages: ReadonlyArray<{
    info: { role: string }
    parts: ReadonlyArray<{ type: string; synthetic?: boolean }>
  }>,
) {
  let count = 0
  for (const message of messages) {
    if (message.info.role !== "user") continue
    const isRealUserTurn = message.parts.some(
      (part) =>
        (part.type === "text" && !part.synthetic) ||
        part.type === "file" ||
        part.type === "agent" ||
        part.type === "subtask",
    )
    if (isRealUserTurn) count++
  }
  return count
}

export function sessionStatePath(workspaceRoot: string, sessionID: string) {
  return path.join(workspaceRoot, ".jyycode", "context", `${sessionID}.json`)
}

export const readSessionState = Effect.fn("SessionState.read")(function* (
  fsys: AppFileSystem.Interface,
  workspaceRoot: string,
  sessionID: string,
) {
  const raw = yield* fsys.readFileStringSafe(sessionStatePath(workspaceRoot, sessionID)).pipe(Effect.option)
  if (Option.isNone(raw) || raw.value === undefined) return Option.none<SessionStateFile>()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.value)
  } catch {
    return Option.none<SessionStateFile>()
  }
  const decoded = Schema.decodeUnknownOption(SessionStateFile)(parsed)
  return Option.isNone(decoded) ? Option.none<SessionStateFile>() : decoded
})

export const writeSessionState = Effect.fn("SessionState.write")(function* (
  fsys: AppFileSystem.Interface,
  workspaceRoot: string,
  sessionID: string,
  state: SessionStateFile,
) {
  const bounded = (text: string | undefined, max: number) =>
    text === undefined ? undefined : sanitizeForPersistence(text).text.slice(0, max)
  const safe = {
    ...state,
    lastUser: bounded(state.lastUser, 400),
    lastAssistant: bounded(state.lastAssistant, 600),
    summary: bounded(state.summary, 1_800),
    lastToolNames: state.lastToolNames?.slice(0, 10).map((name) => bounded(name, 80)!),
  }
  const target = sessionStatePath(workspaceRoot, sessionID)
  const temp = `${target}.${randomUUID()}.tmp`
  yield* fsys.writeWithDirs(temp, JSON.stringify(safe, null, 2)).pipe(
    Effect.andThen(fsys.rename(temp, target)),
    Effect.ensuring(fsys.remove(temp, { force: true }).pipe(Effect.ignore)),
  )
})

export function formatSessionState(
  state: SessionStateFile,
  options: { omitTurnDetails?: boolean; omitRollingSummary?: boolean } = {},
) {
  const lines = ["# Session state"]
  if (!options.omitRollingSummary && state.summary) {
    lines.push("", "## Rolling summary", "", state.summary)
  }
  if (!options.omitTurnDetails) {
    if (state.lastUser) {
      lines.push("", "## Latest user request", "", state.lastUser)
    }
    if (state.lastAssistant) {
      lines.push("", "## Latest assistant output", "", state.lastAssistant)
    }
    if (state.lastToolNames && state.lastToolNames.length > 0) {
      lines.push("", `## Tools used: ${state.lastToolNames.join(", ")}`)
    }
  }
  if (state.tailStartID) {
    lines.push("", `compacted before: ${state.tailStartID}`)
  }
  return untrustedMemoryBlock("session-state", lines.join("\n").slice(0, SESSION_STATE_MAX_CHARS))
}

export const SessionState = {
  readSessionState,
  writeSessionState,
  formatSessionState,
} as const
