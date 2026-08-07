import path from "path"
import { Effect, Option, Schema } from "effect"
import type { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { NonNegativeInt } from "@jyycode-ai/core/schema"

export const SessionStateFile = Schema.Struct({
  version: Schema.Union([Schema.Literal(1), Schema.Literal(2)]),
  updatedAt: Schema.String,
  lastUser: Schema.optional(Schema.String),
  lastAssistant: Schema.optional(Schema.String),
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
  yield* fsys.writeWithDirs(sessionStatePath(workspaceRoot, sessionID), JSON.stringify(state, null, 2))
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
  return lines.join("\n")
}

export const SessionState = {
  readSessionState,
  writeSessionState,
  formatSessionState,
} as const
