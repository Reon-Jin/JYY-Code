import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import * as Session from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import * as Log from "@jyycode-ai/core/util/log"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"
import { NamedError } from "@jyycode-ai/core/util/error"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Layer, Context, Schema } from "effect"
import * as DateTime from "effect/DateTime"
import { InstanceState } from "@/effect/instance-state"
import {
  isOverflow as overflow,
  shouldCompact as predictiveOverflow,
  usable,
  getAutocompactBufferTokens,
  getEffectiveContextWindow,
  getAutoCompactThreshold,
  getPredictiveCompactThreshold,
  calculateTokenWarningState,
  estimateMaxTurnGrowth,
} from "./overflow"
import {
  DEFAULT_MICRO_COMPACT_MAX_CHARS,
  isCompactable,
  microCompactOutput,
  estimateMicroCompactSavings,
} from "./micro-compact"
import {
  detectReactiveCompactTrigger,
  shouldAttemptReactiveCompact,
  createReactiveCompactState,
  reactiveCompact,
  type ReactiveCompactConfig,
  type ReactiveCompactResult,
  type ReactiveCompactState,
} from "./reactive-compact"
import { serviceUse } from "@/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventRuntime } from "@/event-runtime"
import { SessionEvent } from "@jyycode-ai/core/session-event"
import { estimateContextTokens, type ContextBudgetInput, type ContextEstimate } from "./context-estimate"
import {
  assessProgress,
  createCheckpoint,
  measureEffectiveContext,
  sameSourceHighWatermark,
  sourceHighWatermark,
  updateCheckpoint,
  type CompactionCheckpoint,
} from "./compaction-checkpoint"
import { pruneToolPart } from "./payload-pruner"

const log = Log.create({ service: "session.compaction" })

export const Event = {
  Compacted: BusEvent.define(
    "session.compacted",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
export const AUTO_FAILURE_LIMIT = 3

export type RequestCompressionStage = "none" | "micro" | "reactive" | "full"
export type RequestCompressionReason = "within_budget" | "micro_compacted" | "reactive_compacted" | "full_compaction_required"

export type RequestPreparation = {
  messages: MessageV2.WithParts[]
  estimate: ContextEstimate
  estimatedTokens: number
  budget: number
  strategy: RequestCompressionStage
  tokensReclaimed: number
  reason: RequestCompressionReason
  stage: RequestCompressionStage
  microSavings: number
  reactive: ReactiveCompactResult["stats"] | undefined
  needsFullCompaction: boolean
}

function isCompletedToolPart(part: MessageV2.Part): part is MessageV2.ToolPart & {
  state: MessageV2.ToolStateCompleted
} {
  return part.type === "tool" && part.state.status === "completed"
}

const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

function summaryText(message: MessageV2.WithParts) {
  const text = message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function compactionPart(message: MessageV2.WithParts) {
  return message.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")
}

function compactionSourceMessages(messages: MessageV2.WithParts[], source: { id: string }) {
  const boundary = messages.findIndex((message) => message.info.id === source.id)
  if (boundary < 0) return messages
  let end = boundary + 1
  // A compaction marker and its summary are part of the stable prefix even
  // when a new user message arrives while the model is summarizing.
  while (end < messages.length) {
    const message = messages[end]
    if (message.info.role === "user" && compactionPart(message)) {
      end++
      continue
    }
    if (
      message.info.role === "assistant" &&
      message.info.summary === true &&
      end > boundary &&
      messages[end - 1]?.info.role === "user" &&
      message.info.parentID === messages[end - 1]!.info.id
    ) {
      end++
      continue
    }
    break
  }
  return messages.slice(0, end)
}

function completedCompactions(messages: MessageV2.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    // A compaction that finished without any summary text produced nothing
    // useful and must not be treated as completed.
    if (!summaryText(msg)) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function buildPrompt(input: { previousSummary?: string; context: string[] }) {
  const anchor = input.previousSummary
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        input.previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above."
  return [anchor, SUMMARY_TEMPLATE, ...input.context].join("\n\n")
}

function mediaManifest(messages: MessageV2.WithParts[]) {
  const lines: string[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "file" && MessageV2.isMedia(part.mime)) {
        lines.push(`- message=${message.info.id} mime=${part.mime} filename=${part.filename ?? "file"}`)
      }
      if (part.type === "tool" && part.state.status === "completed") {
        for (const attachment of part.state.attachments ?? []) {
          if (!MessageV2.isMedia(attachment.mime)) continue
          lines.push(
            `- message=${message.info.id} tool=${part.tool} mime=${attachment.mime} filename=${attachment.filename ?? "file"}`,
          )
        }
      }
    }
  }
  if (!lines.length) return []
  return ["<media-manifest>", ...lines, "</media-manifest>"]
}

function preserveRecentBudget(input: { cfg: Config.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: MessageV2.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: MessageV2.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: MessageV2.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly shouldCompact: (input: { messages: MessageV2.WithParts[]; model: Provider.Model }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  /** Micro-compact tool results within a message array without full compaction. */
  readonly microCompact: (input: {
    messages: MessageV2.WithParts[]
    maxChars?: number
  }) => Effect.Effect<MessageV2.WithParts[]>
  /** Apply the request-level compression chain before sending to a provider. */
  readonly prepareRequest: (input: ContextBudgetInput & { model: Provider.Model }) => Effect.Effect<RequestPreparation>
  /** Reactive compaction result with change statistics for telemetry and tests. */
  readonly reactiveCompact: (input: {
    messages: MessageV2.WithParts[]
  }) => Effect.Effect<ReactiveCompactResult>
  /** Detect if the conversation needs reactive (emergency) compaction. */
  readonly detectReactiveNeed: (input: {
    messages: MessageV2.WithParts[]
  }) => Effect.Effect<"prompt_too_long" | "media_size" | null>
  /** Get detailed token warning state for UI. */
  readonly tokenWarningState: (input: {
    tokenUsage: number
    model: Provider.Model
  }) => Effect.Effect<ReturnType<typeof calculateTokenWarningState>>
  readonly process: (input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/SessionCompaction") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventRuntime.Service
    const flags = yield* RuntimeFlags.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      return estimateContextTokens({ messages: input.messages }).totalTokens
    })

    const shouldCompact = Effect.fn("SessionCompaction.shouldCompact")(function* (input: {
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      const estimatedInputTokens = yield* estimate(input)
      return predictiveOverflow({
        cfg: yield* config.get(),
        model: input.model,
        estimatedInputTokens,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: MessageV2.WithParts[]
      cfg: Config.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) log.info("tail fallback", { budget, size, total })
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      log.info("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return
      const currentSession = yield* session
        .get(input.sessionID)
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!currentSession) return
      const revertBoundaryIndex = currentSession.revert
        ? msgs.findIndex((message) => message.info.id === currentSession.revert?.messageID)
        : -1
      if (currentSession.revert && revertBoundaryIndex < 0) return
      const previewChars = cfg.compaction?.prune_preview_chars

      let total = 0
      let pruned = 0
      const toPrune: MessageV2.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (revertBoundaryIndex >= 0) {
          if (msgIndex > revertBoundaryIndex) continue
          break loop
        }
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      log.info("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            yield* session.updatePart(
              yield* Effect.promise(() => pruneToolPart(part, { previewChars })),
            )
          }
        }
        log.info("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const marker = compactionPart(parent)

      let messages = input.messages
      let replay:
        | {
            info: MessageV2.User
            parts: MessageV2.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      const cfg = yield* config.get()
      const history = marker && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      const source = marker?.checkpoint?.sourceHighWatermark ?? sourceHighWatermark(input.messages)
      const before = marker?.checkpoint?.before ?? measureEffectiveContext(MessageV2.filterCompacted(history))
      let checkpoint: CompactionCheckpoint =
        marker?.checkpoint ??
        createCheckpoint({
          sessionID: input.sessionID,
          sourceHighWatermark: source,
          before,
          status: "active",
        })
      checkpoint = updateCheckpoint(checkpoint, {
        status: "active",
        verbatimTailMessageIDs: selected.tail_start_id ? [selected.tail_start_id] : [],
      })
      if (marker && (!marker.checkpoint || marker.checkpoint.status !== "active")) {
        yield* session.updatePart({ ...marker, checkpoint })
      }
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const nextPrompt =
        compacting.prompt ??
        buildPrompt({ previousSummary, context: [...compacting.context, ...mediaManifest(history)] })
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const ctx = yield* InstanceState.context
      const msg: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor
        .process({
          user: userMessage,
          agent,
          sessionID: input.sessionID,
          tools: {},
          system: [],
          messages: [
            ...modelMessages,
            {
              role: "user",
              content: [{ type: "text", text: nextPrompt }],
            },
          ],
          model,
        })
        .pipe(
          Effect.onInterrupt(() =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                const cancelled = updateCheckpoint(checkpoint, {
                  status: "cancelled",
                  reason: "compaction interrupted before activation",
                })
                if (marker) yield* session.updatePart({ ...marker, checkpoint: cancelled })
                processor.message.error = new MessageV2.AbortedError({ message: "Compaction was cancelled" }).toObject()
                processor.message.finish = "error"
                yield* session.updateMessage(processor.message)
              }),
            ),
          ),
        )

      if (result === "compact") {
        processor.message.error = new MessageV2.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      const persisted = yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      const stable = compactionSourceMessages(persisted, source)
      const after = measureEffectiveContext(MessageV2.filterCompacted(stable))
      const assessment = assessProgress(before, after)
      checkpoint = updateCheckpoint(checkpoint, {
        after,
        status: assessment.ok ? "complete" : "no_progress",
        reason: assessment.ok ? undefined : assessment.reason,
      })
      if (marker) {
        yield* session.updatePart({
          ...marker,
          ...(selected.tail_start_id ? { tail_start_id: selected.tail_start_id } : {}),
          checkpoint,
        })
      }

      // A short manual compaction can be useful even when it cannot save
      // 4,096 tokens. Automatic compaction is strict once the history is large
      // enough to make the invariant meaningful, and always rejects growth.
      const enforceProgress = input.auto && before.tokens >= 4_096
      if (result === "continue" && enforceProgress && !assessment.ok) {
        processor.message.error = new NamedError.Unknown({
          message: `Compaction made insufficient progress (${assessment.tokenReduction} token reduction; required ${assessment.requiredTokens})`,
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        const summary = summaryText(
          (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
            (item) => item.info.id === msg.id,
          ) ?? {
            info: msg,
            parts: [],
          },
        )
        // An empty summary is a failed compaction: it did not reduce context,
        // so it must not emit a successful `Compaction.Ended` event. The
        // failure is counted by `failedAutoCompactions` so the auto-compaction
        // circuit opens after repeated empty summaries.
        if (summary) {
          yield* events.publish(SessionEvent.Compaction.Ended, {
            sessionID: input.sessionID,
            timestamp: DateTime.makeUnsafe(Date.now()),
            text: summary,
            include: selected.tail_start_id,
          })
        }
        yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const failedAutoCompactions = (messages: MessageV2.WithParts[], source = sourceHighWatermark(messages)) => {
      let failed = 0
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") continue
        const assistant = msg.info as MessageV2.Assistant
        if (assistant.summary !== true) continue
        const parent = messages.find((candidate) => candidate.info.id === assistant.parentID)
        const checkpoint = parent ? compactionPart(parent)?.checkpoint : undefined
        if (checkpoint && !sameSourceHighWatermark(checkpoint.sourceHighWatermark, source)) break
        if (msg.info.error) {
          failed++
          continue
        }
        if (msg.info.finish) {
          // A "successful" compaction that returned no text is still a
          // failure: it does not reduce context and would only loop.
          if (!summaryText(msg)) {
            failed++
            continue
          }
          break
        }
      }
      return failed
    }

    const microCompactFn = Effect.fn("SessionCompaction.microCompact")(function* (input: {
      messages: MessageV2.WithParts[]
      maxChars?: number
    }) {
      const cfg = yield* config.get()
      const result = structuredClone(input.messages)
      if (cfg.compaction?.micro_compact === false) return result

      const maxChars =
        cfg.compaction?.micro_compact_max_chars ?? input.maxChars ?? DEFAULT_MICRO_COMPACT_MAX_CHARS
      const savings = estimateMicroCompactSavings(result, maxChars)
      for (const msg of result) {
        for (const part of msg.parts) {
          if (!isCompletedToolPart(part)) continue
          if (!isCompactable(part)) continue
          const compacted = microCompactOutput(part.state.output, maxChars)
          if (compacted) {
            part.state.output = compacted.content
          }
        }
      }
      if (savings > 0) log.info("micro-compacted tool output", { savings })
      return result
    })

    const detectReactiveNeed = Effect.fn("SessionCompaction.detectReactiveNeed")(function* (input: {
      messages: MessageV2.WithParts[]
    }) {
      const cfg = yield* config.get()
      if (cfg.compaction?.reactive_compact === false) return null
      return detectReactiveCompactTrigger(input.messages) ? "prompt_too_long" : null
    })

    const tokenWarningStateFn = Effect.fn("SessionCompaction.tokenWarningState")(function* (input: {
      tokenUsage: number
      model: Provider.Model
    }) {
      const cfg = yield* config.get()
      return calculateTokenWarningState({
        tokenUsage: input.tokenUsage,
        model: input.model,
        config: cfg,
      })
    })

    const reactiveCompactFn = Effect.fn("SessionCompaction.reactiveCompact")(function* (input: {
      messages: MessageV2.WithParts[]
    }) {
      const cfg = yield* config.get()
      if (cfg.compaction?.reactive_compact === false) {
        const messages = structuredClone(input.messages)
        return {
          messages,
          stats: {
            changed: false,
            messagesChanged: 0,
            partsChanged: 0,
            compactedToolOutputs: 0,
            compactedAssistantText: 0,
            preservedActiveParts: messages.reduce(
              (total, message) =>
                total +
                message.parts.filter(
                  (part) =>
                    part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
                ).length,
              0,
            ),
            beforeChars: JSON.stringify(messages).length,
            afterChars: JSON.stringify(messages).length,
            savedChars: 0,
          },
        } satisfies ReactiveCompactResult
      }
      const state = createReactiveCompactState({ enabled: true })
      if (!shouldAttemptReactiveCompact(state, { enabled: true })) {
        return reactiveCompact({ messages: input.messages, config: { enabled: false } })
      }
      const result = reactiveCompact({ messages: input.messages })
      if (result.stats.changed) log.info("reactively compacted old conversation segments", result.stats)
      return result
    })

    const prepareRequest = Effect.fn("SessionCompaction.prepareRequest")(function* (
      input: ContextBudgetInput & { model: Provider.Model },
    ) {
      const cfg = yield* config.get()
      const outputReserve = Math.max(0, Number.isFinite(input.outputReserve) ? input.outputReserve : 0)
      const budgetInput = (messages: MessageV2.WithParts[]): ContextBudgetInput => ({
        messages,
        system: input.system,
        tools: input.tools,
        injectedContext: input.injectedContext,
        outputReserve,
      })
      const hardBudget = usable({ cfg, model: input.model, outputTokenMax: flags.outputTokenMax })
      const softBudget = getPredictiveCompactThreshold({
        cfg,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
      let messages = structuredClone(input.messages)
      let estimate = estimateContextTokens(budgetInput(messages))
      const initialEstimatedTokens = estimate.inputTokens
      let stage: RequestCompressionStage = "none"
      let microSavings = 0
      let reactiveStats: ReactiveCompactResult["stats"] | undefined

      const done = (needsFullCompaction: boolean): RequestPreparation => ({
        messages,
        estimate,
        estimatedTokens: estimate.inputTokens,
        budget: hardBudget,
        strategy: needsFullCompaction ? "full" : stage,
        tokensReclaimed: Math.max(0, initialEstimatedTokens - estimate.inputTokens),
        reason: needsFullCompaction
          ? "full_compaction_required"
          : stage === "micro"
            ? "micro_compacted"
            : stage === "reactive"
              ? "reactive_compacted"
              : "within_budget",
        stage,
        microSavings,
        reactive: reactiveStats,
        needsFullCompaction,
      })

      if (estimate.inputTokens <= softBudget) return done(false)

      if (cfg.compaction?.micro_compact !== false) {
        const before = estimate.inputTokens
        messages = yield* microCompactFn({
          messages,
          maxChars: cfg.compaction?.micro_compact_max_chars,
        })
        estimate = estimateContextTokens(budgetInput(messages))
        microSavings = Math.max(0, before - estimate.inputTokens)
        if (estimate.inputTokens <= softBudget) {
          stage = "micro"
          return done(false)
        }
        stage = "micro"
      }

      if (cfg.compaction?.reactive_compact !== false) {
        const result = yield* reactiveCompactFn({ messages })
        messages = result.messages
        reactiveStats = result.stats
        estimate = estimateContextTokens(budgetInput(messages))
        if (result.stats.changed) stage = "reactive"
        if (estimate.inputTokens <= hardBudget) return done(false)
      }

      return done(estimate.inputTokens > hardBudget)
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
    }) {
      const messages = yield* session
          .messages({ sessionID: input.sessionID })
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([])))
      if (input.auto) {
        const failures = failedAutoCompactions(messages)
        if (failures >= AUTO_FAILURE_LIMIT) {
          log.warn("auto compaction circuit open", { sessionID: input.sessionID, failures })
          return false
        }
      }

      const source = sourceHighWatermark(messages)
      const before = measureEffectiveContext(MessageV2.filterCompacted(messages))
      const attempt = Math.max(
        1,
        ...messages.flatMap((message) => {
          const marker = compactionPart(message)
          return marker?.checkpoint && sameSourceHighWatermark(marker.checkpoint.sourceHighWatermark, source)
            ? [marker.checkpoint.attempt + 1]
            : []
        }),
      )
      const checkpoint = createCheckpoint({
        sessionID: input.sessionID,
        sourceHighWatermark: source,
        before,
        attempt,
        status: "pending",
      })
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
        checkpoint,
      })
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID: input.sessionID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        reason: input.auto ? "auto" : "manual",
      })
      return true
    })

    return Service.of({
      isOverflow,
      shouldCompact,
      prune,
      microCompact: microCompactFn,
      prepareRequest,
      reactiveCompact: reactiveCompactFn,
      detectReactiveNeed,
      tokenWarningState: tokenWarningStateFn,
      process: processCompaction,
      create,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(EventRuntime.defaultLayer),
  ),
)

export * as SessionCompaction from "./compaction"
