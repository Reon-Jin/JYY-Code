import path from "path"
import { Effect, Option, Schema } from "effect"
import type { AppFileSystem } from "@jyycode-ai/core/filesystem"

export const SessionStateFile = Schema.Struct({
  version: Schema.Literal(1),
  updatedAt: Schema.String,
  lastUser: Schema.optional(Schema.String),
  lastAssistant: Schema.optional(Schema.String),
  lastToolNames: Schema.optional(Schema.Array(Schema.String)),
  tailStartID: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
})
export type SessionStateFile = Schema.Schema.Type<typeof SessionStateFile>

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

export function formatSessionState(state: SessionStateFile) {
  const lines = [
    "# Session state",
    `updated: ${state.updatedAt}`,
  ]
  if (state.summary) {
    lines.push("", "## Rolling summary", "", state.summary)
  }
  if (state.lastUser) {
    lines.push("", "## Latest user request", "", state.lastUser)
  }
  if (state.lastAssistant) {
    lines.push("", "## Latest assistant output", "", state.lastAssistant)
  }
  if (state.lastToolNames && state.lastToolNames.length > 0) {
    lines.push("", `## Tools used: ${state.lastToolNames.join(", ")}`)
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
