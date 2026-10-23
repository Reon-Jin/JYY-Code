import { Effect, Layer, Context, Schema } from "effect"
import { Bus } from "@/bus"
import { Snapshot } from "@/snapshot"
import { isExcludedChange } from "@/snapshot/excludes"
import { Storage } from "@/storage/storage"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"
import { InstanceState } from "@/effect/instance-state"

// A workspace may contain a growing log or generated file. Keep change counts
// and filenames, but do not copy an unbounded patch into every user message.
export const MAX_SUMMARY_PATCH_BYTES = 512 * 1024

export function limitSummaryPatches(diffs: Snapshot.FileDiff[]): Snapshot.FileDiff[] {
  let remaining = MAX_SUMMARY_PATCH_BYTES
  return diffs
    .filter((diff) => !isExcludedChange(diff.file))
    .map((diff) => {
      if (!diff.patch) return diff
      const size = Buffer.byteLength(diff.patch, "utf8")
      if (size > remaining) return { ...diff, patch: undefined }
      remaining -= size
      return diff
    })
}

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

/** Synthetic wakeups continue the latest user request; they do not start a new delivery turn. */
function summaryTurn(all: MessageV2.WithParts[], messageID?: MessageID) {
  const owners = new Map<MessageID, MessageID>()
  let current: MessageID | undefined
  for (const message of all) {
    if (message.info.role !== "user") continue
    if (
      message.parts.length === 0 ||
      message.parts.some(
        (part) =>
          (part.type === "text" && !part.synthetic) ||
          part.type === "file" ||
          part.type === "agent" ||
          part.type === "subtask",
      )
    )
      current = message.info.id
    owners.set(message.info.id, current ?? message.info.id)
  }
  const id = messageID ? owners.get(messageID) : current
  return {
    target: all.find((message) => message.info.id === id && message.info.role === "user"),
    messages: id
      ? all.filter(
          (message) => owners.get(message.info.role === "user" ? message.info.id : message.info.parentID) === id,
        )
      : [],
  }
}

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: MessageV2.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/SessionSummary") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: MessageV2.WithParts[] }) {
      let from: string | undefined
      let to: string | undefined
      for (const item of input.messages) {
        if (!from) {
          for (const part of item.parts) {
            if (part.type === "step-start" && part.snapshot) {
              from = part.snapshot
              break
            }
          }
        }
        for (const part of item.parts) {
          if (part.type === "step-finish" && part.snapshot) to = part.snapshot
        }
      }
      if (from && to) return yield* snapshot.diffFull(from, to)
      return []
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      if (!all.length) return

      const diffs = limitSummaryPatches(yield* computeDiff({ messages: all }))
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)

      const { messages, target } = summaryTurn(all, input.messageID)
      if (!target || target.info.role !== "user") return
      const msgDiffs = limitSummaryPatches(yield* computeDiff({ messages }))
      target.info.summary = { ...target.info.summary, diffs: msgDiffs }
      yield* sessions.updateMessage(target.info)
      // The sidebar and a subsequent GET must use the same scope. Non-Git
      // projects show the latest user turn; Git retains its session aggregate.
      yield* bus.publish(Session.Event.Diff, {
        sessionID: input.sessionID,
        diff: yield* diff({ sessionID: input.sessionID }),
      })
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const instance = yield* InstanceState.context
      if (input.messageID || instance.project.vcs !== "git") {
        const messages = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
        const { target: user, messages: turn } = summaryTurn(messages, input.messageID)
        if (input.messageID && !user) return []
        if (user?.info.role === "user" && user.info.summary?.diffs)
          return user.info.summary.diffs
            .filter((item) => !isExcludedChange(item.file))
            .map((item) => ({
              ...item,
              ...(item.file ? { file: unquoteGitPath(item.file) } : {}),
            }))
        if (user) return yield* computeDiff({ messages: turn })
      }
      const diffs = yield* storage
        .read<Snapshot.FileDiff[]>(["session_diff", input.sessionID])
        .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
      const next = diffs
        .map((item) => {
          if (item.file === undefined) return item
          const file = unquoteGitPath(item.file)
          if (file === item.file) return item
          return { ...item, file }
        })
        .filter((item) => !isExcludedChange(item.file))
      const changed = next.length !== diffs.length || next.some((item, i) => item.file !== diffs[i]?.file)
      if (changed) yield* storage.write(["session_diff", input.sessionID], next).pipe(Effect.ignore)
      return next
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export * as SessionSummary from "./summary"
