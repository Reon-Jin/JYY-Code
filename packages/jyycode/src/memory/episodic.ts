import path from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { EffectFlock } from "@jyycode-ai/core/util/effect-flock"
import { SessionID } from "@/session/schema"
import * as Log from "@jyycode-ai/core/util/log"
import { buildDigestPrompt } from "./episodic-digest"
import type { MessageV2 } from "@/session/message-v2"

const log = Log.create({ service: "memory.episodic" })

export const DIGEST_INTERVAL_TURNS = 5
export const EPISODE_INPUT_MAX_CHARS = 8_000
export const EPISODE_OUTPUT_MAX_CHARS = 60_000
export const DIGEST_TARGET_CHARS = 3_000
export const DIGEST_INJECT_MAX_CHARS = 4_000

export type EpisodeToolCall = {
  tool: string
  input: string
  output?: string
  error?: string
}

export type EpisodeTurn = {
  version: 1
  sessionID: string
  turn: number
  time: string
  userText?: string
  files: string[]
  assistantText?: string
  toolCalls: EpisodeToolCall[]
}

export type DigestEntry = {
  seq: number
  turnStart: number
  turnEnd: number
  parentSeq: number | null
  createdAt: string
}

export type DigestIndex = {
  version: 1
  latestSeq: number | null
  entries: DigestEntry[]
  coveredTurns: number
}

export type DigestResult =
  | { status: "skipped"; reason: string; seq?: undefined }
  | { status: "generated"; reason: string; seq: number }

export interface CompactInput {
  sessionID: SessionID
  workspaceRoot: string
  reason: "interval" | "threshold"
  /** 已完成回合总数（当前未完成回合不计入）。 */
  totalTurns: number
  /** 首次压缩时，最近两轮之外的旧历史文本（可选，用于旧会话回填）。 */
  backfillText?: string
  /** 已有滚动摘要（compaction summary），首次压缩时作为种子。 */
  previousSummary?: string
  generate: (prompt: string) => Effect.Effect<string>
}

export type Error = AppFileSystem.Error | EffectFlock.LockError

export interface Interface {
  readonly recordTurn: (input: {
    sessionID: SessionID
    workspaceRoot: string
    turn: EpisodeTurn
  }) => Effect.Effect<void, Error>
  readonly readLatestDigest: (input: {
    sessionID: SessionID
    workspaceRoot: string
  }) => Effect.Effect<Option.Option<string>, Error>
  readonly readEpisode: (input: {
    sessionID: SessionID
    workspaceRoot: string
    turn: number
  }) => Effect.Effect<Option.Option<EpisodeTurn>, Error>
  readonly searchEpisodes: (input: {
    sessionID: SessionID
    workspaceRoot: string
    query: string
    limit?: number
  }) => Effect.Effect<EpisodeTurn[], Error>
  readonly compactIfDue: (input: CompactInput) => Effect.Effect<DigestResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/EpisodicMemory") {}

export function memoryRoot(workspaceRoot: string) {
  return path.join(workspaceRoot, ".jyycode", "memory")
}

export function episodesPath(workspaceRoot: string, sessionID: SessionID) {
  return path.join(memoryRoot(workspaceRoot), "episodes", `${sessionID}.jsonl`)
}

export function digestDirPath(workspaceRoot: string, sessionID: SessionID) {
  return path.join(memoryRoot(workspaceRoot), "digest", String(sessionID))
}

export function digestIndexPath(workspaceRoot: string, sessionID: SessionID) {
  return path.join(digestDirPath(workspaceRoot, sessionID), "index.json")
}

export function digestFilePath(workspaceRoot: string, sessionID: SessionID, seq: number) {
  return path.join(digestDirPath(workspaceRoot, sessionID), `${String(seq).padStart(4, "0")}.md`)
}

export function formatEpisodicDigest(text: string) {
  const bounded =
    text.length <= DIGEST_INJECT_MAX_CHARS
      ? text
      : `${text.slice(0, DIGEST_INJECT_MAX_CHARS)}\n…(digest truncated for context; use context_read for details)`
  return ["# 情景记忆（已压缩的历史）", "", bounded].join("\n")
}

export function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…(truncated ${text.length - maxChars} chars)`
}

export function realUserTurnIndexes(messages: MessageV2.WithParts[]) {
  const indexes: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (message.info.role !== "user") continue
    const isRealUserTurn = message.parts.some(
      (part) =>
        (part.type === "text" && !part.synthetic) ||
        part.type === "file" ||
        part.type === "agent" ||
        part.type === "subtask",
    )
    if (isRealUserTurn) indexes.push(i)
  }
  return indexes
}

export function sliceLastTurns(messages: MessageV2.WithParts[], keepTurns = 2) {
  const indexes = realUserTurnIndexes(messages)
  if (indexes.length <= keepTurns) return messages
  return messages.slice(indexes[indexes.length - keepTurns]!)
}

export function episodeFromMessages(messages: MessageV2.WithParts[]): EpisodeTurn {
  const indexes = realUserTurnIndexes(messages)
  const start = indexes.at(-1) ?? 0
  const user = messages[start]
  const userText =
    user?.info.role === "user"
      ? user.parts
          .filter(
            (part): part is Extract<MessageV2.Part, { type: "text" }> =>
              part.type === "text" && !part.synthetic && !part.ignored,
          )
          .map((part) => part.text.trim())
          .filter(Boolean)
          .join("\n")
      : ""
  const files =
    user?.info.role === "user"
      ? user.parts
          .filter((part): part is Extract<MessageV2.Part, { type: "file" }> => part.type === "file")
          .map((part) => part.filename ?? part.url)
      : []
  const toolCalls: EpisodeToolCall[] = []
  let assistantText: string | undefined
  for (const message of messages.slice(start)) {
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type === "tool") {
        const input = "input" in part.state ? JSON.stringify(part.state.input) : undefined
        const call: EpisodeToolCall = { tool: part.tool, input: truncate(input ?? "", EPISODE_INPUT_MAX_CHARS) }
        if (part.state.status === "completed") call.output = truncate(part.state.output, EPISODE_OUTPUT_MAX_CHARS)
        else if (part.state.status === "error") call.error = truncate(part.state.error, EPISODE_OUTPUT_MAX_CHARS)
        toolCalls.push(call)
      } else if (part.type === "text" && !part.synthetic && !part.ignored && part.text.trim()) {
        assistantText = [assistantText, part.text.trim()].filter(Boolean).join("\n\n")
      }
    }
  }
  return {
    version: 1,
    sessionID: messages[0]?.info.sessionID ?? "",
    turn: indexes.length,
    time: new Date().toISOString(),
    ...(userText ? { userText } : {}),
    files,
    ...(assistantText ? { assistantText } : {}),
    toolCalls,
  }
}

function parseIndex(text: string): DigestIndex | undefined {
  try {
    const value = JSON.parse(text) as DigestIndex
    if (value.version !== 1 || !Array.isArray(value.entries)) return undefined
    return value
  } catch {
    return undefined
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const flock = yield* EffectFlock.Service

    const readEpisodes = Effect.fn("EpisodicMemory.readEpisodes")(function* (
      workspaceRoot: string,
      sessionID: SessionID,
    ) {
      const target = episodesPath(workspaceRoot, sessionID)
      const text = (yield* fs.readFileStringSafe(target).pipe(Effect.orDie)) ?? ""
      const episodes: EpisodeTurn[] = []
      for (const line of text.split("\n")) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as EpisodeTurn
          if (parsed.version === 1 && typeof parsed.turn === "number") episodes.push(parsed)
        } catch (error) {
          log.warn("skipping corrupt episode line", { sessionID, error: String(error) })
        }
      }
      return episodes
    })

    const readIndex = Effect.fn("EpisodicMemory.readIndex")(function* (
      workspaceRoot: string,
      sessionID: SessionID,
    ) {
      const target = digestIndexPath(workspaceRoot, sessionID)
      const text = (yield* fs.readFileStringSafe(target).pipe(Effect.orDie)) ?? ""
      const parsed = text.trim() ? parseIndex(text) : undefined
      return parsed ? Option.some(parsed) : Option.none<DigestIndex>()
    })

    const readDigestFile = Effect.fn("EpisodicMemory.readDigestFile")(function* (
      workspaceRoot: string,
      sessionID: SessionID,
      seq: number | null,
    ) {
      if (seq === null) return Option.none<string>()
      const target = digestFilePath(workspaceRoot, sessionID, seq)
      const text = (yield* fs.readFileStringSafe(target).pipe(Effect.orDie)) ?? ""
      return text.trim() ? Option.some(text) : Option.none<string>()
    })

    const writeFileAtomic = Effect.fn("EpisodicMemory.writeFileAtomic")(function* (
      target: string,
      content: string,
    ) {
      const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      yield* fs.writeWithDirs(temp, content)
      yield* fs.rename(temp, target).pipe(Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore)))
    })

    const recordTurn = Effect.fn("EpisodicMemory.recordTurn")(function* (input: {
      sessionID: SessionID
      workspaceRoot: string
      turn: EpisodeTurn
    }) {
      const target = episodesPath(input.workspaceRoot, input.sessionID)
      yield* flock.withLock(
        Effect.gen(function* () {
          const current = (yield* fs.readFileStringSafe(target).pipe(Effect.orDie)) ?? ""
          yield* writeFileAtomic(target, current + JSON.stringify(input.turn) + "\n")
        }),
        target,
      )
    })

    const readLatestDigest = Effect.fn("EpisodicMemory.readLatestDigest")(function* (input: {
      sessionID: SessionID
      workspaceRoot: string
    }) {
      const index = yield* readIndex(input.workspaceRoot, input.sessionID)
      if (Option.isNone(index) || index.value.latestSeq === null) return Option.none<string>()
      return yield* readDigestFile(input.workspaceRoot, input.sessionID, index.value.latestSeq)
    })

    const readEpisode = Effect.fn("EpisodicMemory.readEpisode")(function* (input: {
      sessionID: SessionID
      workspaceRoot: string
      turn: number
    }) {
      const episodes = yield* readEpisodes(input.workspaceRoot, input.sessionID)
      const found = episodes.find((episode) => episode.turn === input.turn)
      return found ? Option.some(found) : Option.none<EpisodeTurn>()
    })

    const searchEpisodes = Effect.fn("EpisodicMemory.searchEpisodes")(function* (input: {
      sessionID: SessionID
      workspaceRoot: string
      query: string
      limit?: number
    }) {
      const query = input.query.normalize("NFKC").trim().toLowerCase()
      const episodes = yield* readEpisodes(input.workspaceRoot, input.sessionID)
      const limit = Math.min(10, Math.max(1, input.limit ?? 5))
      return episodes
        .filter((episode) =>
          [
            episode.userText,
            episode.assistantText,
            ...episode.files,
            ...episode.toolCalls.flatMap((call) => [call.tool, call.input, call.output, call.error]),
          ]
            .filter(Boolean)
            .join("\n")
            .normalize("NFKC")
            .toLowerCase()
            .includes(query),
        )
        .slice(-limit)
    })

    const compactIfDue = Effect.fn("EpisodicMemory.compactIfDue")(function* (input: CompactInput) {
      const index = yield* readIndex(input.workspaceRoot, input.sessionID)
      const episodes = yield* readEpisodes(input.workspaceRoot, input.sessionID)
      const covered = Option.isSome(index) ? index.value.coveredTurns : 0
      const keepFrom = Math.max(0, input.totalTurns - 2)
      const digestable = episodes.filter((episode) => episode.turn > covered && episode.turn <= keepFrom)
      const hasSeed = Option.isSome(index) || Boolean(input.previousSummary) || Boolean(input.backfillText)

      if (input.reason === "interval" && input.totalTurns - covered < DIGEST_INTERVAL_TURNS) {
        return { status: "skipped" as const, reason: "interval_not_due" }
      }
      if (input.reason === "threshold" && digestable.length === 0 && Option.isSome(index)) {
        return { status: "skipped" as const, reason: "nothing_new" }
      }
      if (digestable.length === 0 && !hasSeed) {
        return { status: "skipped" as const, reason: "nothing_to_digest" }
      }

      const previousDigest = Option.isSome(index)
        ? yield* readDigestFile(input.workspaceRoot, input.sessionID, index.value.latestSeq)
        : input.previousSummary
          ? Option.some(input.previousSummary)
          : Option.none<string>()
      const prompt = buildDigestPrompt({
        previousDigest: Option.getOrUndefined(previousDigest),
        backfillText: Option.isSome(index) ? undefined : input.backfillText,
        episodes: digestable,
      })
      const text = (yield* input.generate(prompt)).trim()
      if (!text) return { status: "skipped" as const, reason: "empty_generation" }

      const seq = (Option.isSome(index) ? index.value.latestSeq ?? 0 : 0) + 1
      const newCovered = Math.max(covered, keepFrom)
      const next: DigestIndex = {
        version: 1,
        latestSeq: seq,
        entries: [
          ...(Option.isSome(index) ? index.value.entries : []),
          {
            seq,
            turnStart: covered + 1,
            turnEnd: newCovered,
            parentSeq: Option.isSome(index) ? index.value.latestSeq : null,
            createdAt: new Date().toISOString(),
          },
        ],
        coveredTurns: newCovered,
      }
      yield* writeFileAtomic(digestFilePath(input.workspaceRoot, input.sessionID, seq), text)
      yield* writeFileAtomic(digestIndexPath(input.workspaceRoot, input.sessionID), JSON.stringify(next, null, 2))
      return { status: "generated" as const, reason: input.reason, seq }
    })

    return Service.of({ recordTurn, readLatestDigest, readEpisode, searchEpisodes, compactIfDue })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
)

export * as EpisodicMemory from "./episodic"
