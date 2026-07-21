import path from "path"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import * as Log from "@jyycode-ai/core/util/log"
import { SessionRevert } from "./revert"
import * as Session from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { type Tool as AITool, tool, jsonSchema, generateText, Output } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { Bus } from "../bus"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { ToolRegistry } from "@/tool/registry"
import { BackgroundProcess } from "@/process/job"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigAgentCluster } from "@/config/agent-cluster"
import { AgentClusterRunTable } from "@/agent-cluster/cluster.sql"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@jyycode-ai/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@/shell/shell"
import { ShellID } from "@/tool/shell/id"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import { Cause, Effect, Exit, Latch, Layer, Option, Scope, Context, Schema, Types } from "effect"
import * as EffectLogger from "@jyycode-ai/core/effect/logger"
import { InstanceState } from "@/effect/instance-state"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionEvent } from "@jyycode-ai/core/session-event"
import { ModelV2 } from "@jyycode-ai/core/model"
import { ProviderV2 } from "@jyycode-ai/core/provider"
import { AgentAttachment, FileAttachment, ReferenceAttachment, Source } from "@jyycode-ai/core/session-prompt"
import { Reference } from "@/reference/reference"
import * as DateTime from "effect/DateTime"
import { eq } from "@/storage/db"
import * as Database from "@/storage/db"
import { SessionTable } from "./session.sql"
import { referencePromptMetadata, referenceTextPart } from "./prompt/reference"
import { SessionReminders } from "./reminders"
import { SessionTools } from "./tools"
import { LLMEvent } from "@jyycode-ai/llm"
import { AgentCluster } from "@/agent-cluster/cluster"
import { AgentClusterRuntime } from "@/agent-cluster/runtime"
import type { RunID } from "@/agent-cluster/schema"
import { Memory } from "@/memory/memory"
import { storeClusterPlanText } from "@/agent-cluster/plan-cache"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(MessageV2.Info)
const decodeMessagePart = Schema.decodeUnknownExit(MessageV2.Part)

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final JSON response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be a valid JSON object matching the required JSON schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final JSON answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured JSON output. You MUST use the StructuredOutput tool to provide your final response as a JSON object. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the JSON schema.`
const MEMORY_RETRIEVAL_LIMIT = 5
const MEMORY_RETRIEVAL_QUERY_MAX = 240
const MEMORY_RETRIEVAL_TEXT_MAX = 1800
const MEMORY_RETRIEVAL_KIND = "memory-retrieval"

export async function retryMemoryJsonOutput(
  generate: (prompt: string) => Promise<unknown>,
  prompt: string,
): Promise<unknown> {
  let lastError: unknown = new Error("DeepSeek JSON mode returned empty content")
  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptPrompt =
      attempt === 0
        ? prompt
        : `${prompt}\n\nRETRY: The previous JSON-mode response was empty or invalid. Output exactly one complete JSON object and no other text.`
    try {
      const output = await generate(attemptPrompt)
      if (output !== null && typeof output === "object" && !Array.isArray(output)) return output
      lastError = new Error("DeepSeek JSON mode did not return a JSON object")
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

const log = Log.create({ service: "session.prompt" })
const elog = EffectLogger.create({ service: "session.prompt" })

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts, Image.Error>
  readonly loop: (input: LoopInput) => Effect.Effect<MessageV2.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<MessageV2.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/SessionPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* AppFileSystem.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const references = yield* Reference.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const memory = Option.getOrUndefined(yield* Effect.serviceOption(Memory.Service))
    const evaluateMemoryDecision: Memory.DecisionEvaluator = (input) =>
      Effect.gen(function* () {
        const history = yield* sessions.messages({ sessionID: input.sessionID })
        const latestUser = history.findLast((message) => message.info.role === "user")
        if (!latestUser || latestUser.info.role !== "user") {
          return yield* Effect.fail(new Error("Cannot evaluate memory without a user message"))
        }
        const model = yield* provider.getModel(latestUser.info.model.providerID, latestUser.info.model.modelID)
        const language = yield* provider.getLanguage(model)
        const historyText = history
          .flatMap((message) => {
            if (message.info.role !== "user" && message.info.role !== "assistant") return []
            const text = memoryMessageText(message)
            return text ? [`${message.info.role === "user" ? "User" : "Assistant"}: ${text}`] : []
          })
          .join("\n")
        const isUserPhase = input.phase === "user"
        const prompt = [
          "You are a semantic memory compressor. Rewrite the single task-memory entry for this session and output a JSON object.",
          "This is semantic compression: preserve intent, constraints, decisions, and outcomes in concise natural language. Never shorten by slicing text and never use ellipses as a truncation marker.",
          "Merge the previous task memory, the full conversation history, and the current turn. The returned task is a complete replacement, not a delta.",
          isUserPhase
            ? 'This update runs immediately after a user prompt. Summarize the request as A and task.content must have exactly the form "用户要求<A>"; do not include method or learned knowledge because the assistant has not answered yet.'
            : 'This update runs immediately before the assistant answer is returned. Summarize the request as A, the method/steps used as B, and the learned knowledge or reusable experience as C. task.content must have exactly the form "用户要求<A>，我用了<B>，最终学会了<C>".',
          "A and C must each be at most 20 Unicode characters, and B must be at most 50 Unicode characters. Prefixes and punctuation do not count. Rephrase semantically to fit; never truncate or add ellipses. The LLM must summarize A, B, and C from the previous memory, conversation, and current turn; the runtime does not construct these sections.",
          "A task entry is mandatory on every phase, including greetings and prompts containing stable user facts. Always set shouldUpdate to true and always return task.",
          "Put explicit stable user identity facts or long-term preferences in user as well; this never replaces the mandatory task entry.",
          "Every keyword must contain 2 to 4 characters. Return one to three keywords per candidate.",
          "The service supplies sessionID and date. Do not include them.",
          "",
          "EXPECTED JSON OUTPUT FORMAT (output a valid JSON object matching this shape):",
          "{",
          '  "shouldUpdate": true,',
          '  "reason": "brief justification for the decision",',
          '  "task": {',
          '    "importance": 7,',
          '    "keywords": ["编程"],',
          `    "content": "${isUserPhase ? "用户要求修复认证缺陷" : "用户要求修复认证缺陷，我用了中间件测试，最终学会了边界隔离"}"`,
          "  },",
          '  "user": [',
          "    {",
          '      "importance": 5,',
          '      "keywords": ["偏好"],',
          '      "content": "User prefers concise answers in Chinese"',
          "    }",
          "  ]",
          "}",
          "",
          "Previous task memory:",
          input.previousTaskContent ?? "(none)",
          "",
          "Conversation history:",
          historyText || "(none)",
          "",
          "Current user input:",
          input.userText,
          "",
          "Current assistant output:",
          input.assistantText || "(not available in the user phase)",
          ...(input.correction
            ? [
                "",
                "CORRECTION REQUIRED:",
                input.correction,
                "Return a new complete JSON object that fixes this validation error.",
              ]
            : []),
        ].join("\n")
        return yield* Effect.tryPromise({
          try: () =>
            retryMemoryJsonOutput(
              async (attemptPrompt) =>
                (
                  await generateText({
                    model: language,
                    output: Output.json(),
                    prompt: attemptPrompt,
                    maxOutputTokens: 4096,
                    temperature: 0,
                    maxRetries: 0,
                    providerOptions:
                      model.providerID === "deepseek" ? { deepseek: { thinking: { type: "disabled" } } } : undefined,
                  })
                ).output,
              prompt,
            ),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        })
      })
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input).pipe(Effect.catch(Effect.die)),
        loop: (input: LoopInput) => loop(input),
      } satisfies TaskPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* elog.info("cancel", { sessionID })
      yield* state.cancel(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      const mentionSource = (match: RegExpMatchArray) => {
        const start = match.index ?? 0
        return { value: match[0], start, end: start + match[0].length }
      }
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const slash = name.indexOf("/")
          const alias = slash === -1 ? name : name.slice(0, slash)
          const reference = yield* references.get(alias)
          if (reference) {
            const source = mentionSource(match)
            if (reference.kind === "invalid") {
              parts.push(
                referenceTextPart({ reference, source, target: slash === -1 ? undefined : name.slice(slash + 1) }),
              )
              return
            }

            yield* references.ensure(reference.path)
            if (slash === -1) {
              parts.push(referenceTextPart({ reference, source }))
              return
            }

            const target = name.slice(slash + 1)
            const targetPath = path.resolve(reference.path, target)
            if (!AppFileSystem.contains(reference.path, targetPath)) {
              parts.push(
                referenceTextPart({
                  reference,
                  source,
                  target,
                  targetPath,
                  problem: `Path escapes configured reference @${alias}: ${target}`,
                }),
              )
              return
            }

            const info = yield* fsys.stat(targetPath).pipe(Effect.option)
            if (Option.isNone(info)) {
              parts.push(
                referenceTextPart({
                  reference,
                  source,
                  target,
                  targetPath,
                  problem: `Path does not exist inside configured reference @${alias}: ${target}`,
                }),
              )
              return
            }

            parts.push({
              type: "file",
              url: pathToFileURL(targetPath).href,
              filename: name,
              mime: info.value.type === "Directory" ? "application/x-directory" : "text/plain",
            })
            return
          }

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const applyMemoryRetrieval = Effect.fn("SessionPrompt.applyMemoryRetrieval")(function* (input: {
      sessionID: SessionID
      messages: MessageV2.WithParts[]
      lastUser: MessageV2.User
      enabled: boolean
    }) {
      if (!memory || !input.enabled) return input.messages
      const source = latestRealUserText(input.messages)
      const query = memoryRetrievalQuery(source)
      if (!query) return input.messages
      const results = yield* memory
        .search({
          sessionID: input.sessionID,
          query,
          scope: "all",
          limit: MEMORY_RETRIEVAL_LIMIT,
        })
        .pipe(
          Effect.catchCause((cause) =>
            elog.error("failed to retrieve persistent memory", { cause }).pipe(Effect.as([] as Memory.SearchResult[])),
          ),
        )
      if (results.length === 0) return input.messages
      const text = formatMemoryRetrieval(query, results)
      const messageID = MessageID.ascending()
      const reminder: MessageV2.WithParts = {
        info: {
          ...input.lastUser,
          id: messageID,
          time: { created: Date.now() },
        },
        parts: [
          {
            id: PartID.ascending(),
            sessionID: input.sessionID,
            messageID,
            type: "text",
            synthetic: true,
            text,
            metadata: {
              kind: MEMORY_RETRIEVAL_KIND,
              query,
              matches: results.length,
            },
          } satisfies MessageV2.TextPart,
        ],
      }
      return [...input.messages, reminder]
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: MessageV2.WithParts[]
      providerID: ProviderID
      modelID: ModelID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: MessageV2.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is MessageV2.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => elog.error("failed to generate title", { error: Cause.squash(cause) })))
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: MessageV2.SubtaskPart
      model: Provider.Model
      lastUser: MessageV2.User
      sessionID: SessionID
      session: Session.Info
      msgs: MessageV2.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { task: taskTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: MessageV2.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: MessageV2.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: TaskTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* taskTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies MessageV2.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
            return Effect.void
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies MessageV2.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies MessageV2.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies MessageV2.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies MessageV2.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
            const userMsg: MessageV2.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: MessageV2.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: MessageV2.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const started = Date.now()
            const part: MessageV2.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Shell.Started, {
                sessionID: input.sessionID,
                timestamp: DateTime.makeUnsafe(started),
                callID: part.callID,
                command: input.command,
              })
            }
            return { msg, part, cwd: ctx.directory }
          }).pipe(Effect.ensuring(markReady))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, cwd)
          let output = ""
          let aborted = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Shell.Ended, {
                  sessionID: input.sessionID,
                  timestamp: DateTime.makeUnsafe(completed),
                  callID: part.callID,
                  output,
                })
              }
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output, description: "" },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const cmd = ChildProcess.make(sh, args, {
                cwd,
                extendEnv: true,
                env: { ...shellEnv.env, TERM: "dumb" },
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(cmd)
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output, description: "" }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderID,
      modelID: ModelID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* bus.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* Database.query((db) =>
        db.select({ model: SessionTable.model }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
      )
      if (current?.model) {
        return {
          providerID: ProviderID.make(current.model.providerID),
          modelID: ModelID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const current = yield* Database.query((db) =>
        db
          .select({ agent: SessionTable.agent, model: SessionTable.model })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get(),
      )
      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: MessageV2.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
      }

      if (current?.agent !== info.agent) {
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(info.time.created),
          agent: info.agent,
        })
      }
      if (
        current?.model?.providerID !== info.model.providerID ||
        current.model.id !== info.model.modelID ||
        (current.model.variant === "default" ? undefined : current.model.variant) !== info.model.variant
      ) {
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(info.time.created),
          model: {
            id: ModelV2.ID.make(info.model.modelID),
            providerID: ProviderV2.ID.make(info.model.providerID),
            variant: ModelV2.VariantID.make(info.model.variant ?? "default"),
          },
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const referenceContextFromFilePart = Effect.fnUntraced(function* (
        part: Extract<PromptInput["parts"][number], { type: "file" }>,
        filepath: string,
      ) {
        const name = part.filename?.replace(/#\d+(?:-\d*)?$/, "")
        if (!name) return
        const slash = name.indexOf("/")
        if (slash === -1) return

        const reference = yield* references.get(name.slice(0, slash))
        if (!reference || reference.kind === "invalid") return
        if (!AppFileSystem.contains(reference.path, filepath)) return

        const target = path.relative(reference.path, filepath).split(path.sep).join("/")
        if (!target || target.startsWith("../") || target === "..") return

        return referenceTextPart({
          reference,
          source: part.source?.text ?? { value: `@${name}`, start: 0, end: name.length + 1 },
          target,
          targetPath: filepath,
        })
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<MessageV2.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if ("text" in c && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && c.blob) {
                  const mime = "mimeType" in c ? c.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mime}]`,
                  })
                }
              }
              pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
            } else {
              const error = Cause.squash(exit.cause)
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              log.info("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const referenceContext = yield* referenceContextFromFilePart(part, filepath)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<MessageV2.Part>[] = [
                  ...(referenceContext
                    ? [{ ...referenceContext, messageID: info.id, sessionID: input.sessionID }]
                    : []),
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read file", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read directory", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    ...(referenceContext
                      ? [{ ...referenceContext, messageID: info.id, sessionID: input.sessionID }]
                      : []),
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  ...(referenceContext
                    ? [{ ...referenceContext, messageID: info.id, sessionID: input.sessionID }]
                    : []),
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                ...(referenceContext ? [{ ...referenceContext, messageID: info.id, sessionID: input.sessionID }] : []),
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        log.error("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      parts.forEach((part, index) => {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) return
        log.error("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      })

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)
      const nextPrompt = parts.reduce(
        (result, part) => {
          if (part.type === "text") {
            if (part.synthetic) result.synthetic.push(part.text)
            else result.text.push(part.text)
            const reference = referencePromptMetadata(part.metadata?.reference)
            if (reference) {
              result.references.push(
                new ReferenceAttachment({
                  name: reference.name,
                  kind: reference.kind,
                  uri: reference.path ? pathToFileURL(reference.path).href : undefined,
                  repository: reference.repository,
                  branch: reference.branch,
                  target: reference.target,
                  targetUri: reference.targetPath ? pathToFileURL(reference.targetPath).href : undefined,
                  problem: reference.problem,
                  source: new Source({
                    start: reference.source.start,
                    end: reference.source.end,
                    text: reference.source.value,
                  }),
                }),
              )
            }
          }
          if (part.type === "file") {
            result.files.push(
              new FileAttachment({
                uri: part.url,
                mime: part.mime,
                name: part.filename,
                source: part.source
                  ? new Source({
                      start: part.source.text.start,
                      end: part.source.text.end,
                      text: part.source.text.value,
                    })
                  : undefined,
              }),
            )
          }
          if (part.type === "agent") {
            result.agents.push(
              new AgentAttachment({
                name: part.name,
                source: part.source
                  ? new Source({
                      start: part.source.start,
                      end: part.source.end,
                      text: part.source.value,
                    })
                  : undefined,
              }),
            )
          }
          return result
        },
        {
          text: [] as string[],
          files: [] as FileAttachment[],
          agents: [] as AgentAttachment[],
          references: [] as ReferenceAttachment[],
          synthetic: [] as string[],
        },
      )
      // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
      if (flags.experimentalEventSystem) {
        yield* events.publish(SessionEvent.Prompted, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(info.time.created),
          prompt: {
            text: nextPrompt.text.join("\n"),
            files: nextPrompt.files,
            agents: nextPrompt.agents,
            references: nextPrompt.references,
          },
        })
      }
      for (const text of nextPrompt.synthetic) {
        // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
        if (flags.experimentalEventSystem) {
          yield* events.publish(SessionEvent.Synthetic, {
            sessionID: input.sessionID,
            timestamp: DateTime.makeUnsafe(info.time.created),
            text,
          })
        }
      }

      return { info, parts }
    }, Effect.scoped)

    const prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts, Image.Error> = Effect.fn(
      "SessionPrompt.prompt",
    )((input) => {
      const body = Effect.gen(function* () {
        const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        const cfg = yield* config.get()
        // noReply messages are synthetic injections (for example, background
        // subagent completion). They continue an existing run and must never
        // decorate the message with a fresh, unpersisted cluster run ID.
        const useCluster =
          input.noReply !== true &&
          AgentCluster.canUseAgentCluster({
            session,
            config: cfg.agent_cluster,
            requested: input.agentCluster?.enabled,
          })
        const clusterModels = useCluster
          ? yield* AgentCluster.resolveModels(cfg.agent_cluster ?? {}).pipe(Effect.orDie)
          : undefined
        const runID = useCluster ? AgentCluster.createRunID() : undefined
        const reusableSubagents = useCluster ? yield* AgentCluster.reusableSubagents(session.id) : undefined
        const promptInput =
          useCluster && clusterModels && runID
            ? AgentCluster.decoratePromptInput({
                prompt: input,
                runID,
                session,
                config: cfg.agent_cluster ?? {},
                models: clusterModels,
                reusableSubagents,
              })
            : input
        yield* revert.cleanup(session)
        const message = yield* createUserMessage(promptInput)
        yield* sessions.touch(input.sessionID)

        const permissions: Permission.Rule[] = []
        for (const [t, enabled] of Object.entries(promptInput.tools ?? {})) {
          permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
        }
        if (permissions.length > 0) {
          session.permission = permissions
          yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
        }

        if (promptInput.noReply === true) return message
        if (useCluster && clusterModels && runID) {
          return yield* AgentCluster.run({
            runID,
            session,
            message,
            config: cfg.agent_cluster ?? {},
            models: clusterModels,
            runLoop: loop({ sessionID: input.sessionID }),
          })
        }
        return yield* loop({ sessionID: input.sessionID })
      })
      return body
    }) as (input: PromptInput) => Effect.Effect<MessageV2.WithParts, Image.Error>

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const runLoop: (sessionID: SessionID) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.run")(
      function* (sessionID: SessionID) {
        const ctx = yield* InstanceState.context
        const slog = elog.with({ sessionID })
        let structured: unknown
        let latestMemoryUserText = ""
        let step = 0
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
        const canUsePersistentMemory = session.parentID === undefined
        let previousToolTurnSignature: string | undefined
        let repeatedToolTurnCount = 0
        const clusterDispatchReminderKind = "agent_cluster_dispatch_reminder"
        const clusterSynthesisReminderKind = "agent_cluster_synthesis_gate"

        function hasTaskToolAfter(messages: MessageV2.WithParts[], userID: MessageID) {
          const userIndex = messages.findIndex((message) => message.info.id === userID)
          return messages
            .slice(userIndex + 1)
            .some((message) => message.parts.some((part) => part.type === "tool" && part.tool === "task"))
        }

        function clusterPlan(message: MessageV2.WithParts | undefined) {
          if (!message || message.info.role !== "assistant") return false
          if (message.info.agent !== "cluster" && message.info.mode !== "cluster") return false
          const text = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
          return AgentClusterRuntime.extractPlanFromText(text)
        }

        function clusterRunID(messages: MessageV2.WithParts[]) {
          function metadataOf(part: MessageV2.Part): Record<string, unknown> | undefined {
            return "metadata" in part ? part.metadata : undefined
          }

          for (const message of [...messages].reverse()) {
            for (const part of [...message.parts].reverse()) {
              const metadata = metadataOf(part) as { kind?: string; runID?: string } | undefined
              if (metadata?.kind === "agent_cluster" && metadata.runID) return metadata.runID as RunID
            }
          }
          return undefined
        }

        function isClusterDispatchReminder(message: MessageV2.WithParts | undefined) {
          if (!message || message.info.role !== "user") return false
          return message.parts.some(
            (part) => part.type === "text" && part.synthetic && part.metadata?.kind === clusterDispatchReminderKind,
          )
        }

        function isClusterSynthesisReminder(message: MessageV2.WithParts | undefined) {
          if (!message || message.info.role !== "user") return false
          return message.parts.some(
            (part) => part.type === "text" && part.synthetic && part.metadata?.kind === clusterSynthesisReminderKind,
          )
        }

        const createClusterDispatchReminder = Effect.fn("SessionPrompt.createClusterDispatchReminder")(
          function* (input: {
            lastUser: MessageV2.User
            plan: ReturnType<typeof AgentClusterRuntime.extractPlanFromText>
          }) {
            const cfg = yield* config.get()
            const clusterConfig = ConfigAgentCluster.resolve(cfg.agent_cluster)
            const validation = input.plan
              ? AgentClusterRuntime.validatePlan(input.plan, {
                  maxSubagents: clusterConfig.max_subagents,
                  maxConcurrency: clusterConfig.max_concurrency,
                })
              : undefined
            const ready = input.plan
              ? AgentClusterRuntime.nextReadyBatch(input.plan, {
                  completed: [],
                }).tasks
              : []
            const userMsg: MessageV2.User = {
              id: MessageID.ascending(),
              sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: input.lastUser.agent,
              model: input.lastUser.model,
            }
            yield* sessions.updateMessage(userMsg)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID,
              type: "text",
              synthetic: true,
              metadata: { kind: clusterDispatchReminderKind },
              text: [
                "<system-reminder>",
                "The Multi-Agent plan has been presented, but no subagents were dispatched.",
                ...(validation && !validation.valid
                  ? [
                      "The plan violates runtime scheduling rules. Fix the plan first, then dispatch ready tasks.",
                      "Plan errors:",
                      ...validation.errors.map((error) => `- ${error}`),
                    ]
                  : ready.length > 0
                    ? [
                        "Runtime validation passed. Immediately dispatch every ready task now using parallel task tool calls.",
                        "Ready task ids:",
                        ...ready.map((task) => `- ${task.id}`),
                      ]
                    : [
                        "No tasks are ready. Explain the blocker or revise the plan so step-1 tasks are dependency-free.",
                      ]),
                "Do not repeat the plan and do not stop after text; this turn must include the task tool calls.",
                "</system-reminder>",
              ].join("\n"),
            } satisfies MessageV2.TextPart)
          },
        )

        const createClusterSynthesisReminder = Effect.fn("SessionPrompt.createClusterSynthesisReminder")(
          function* (input: { lastUser: MessageV2.User; runID: RunID }) {
            const state = yield* AgentCluster.getSessionState(sessionID)
            const tasks = state.tasks.filter((task) => task.run_id === input.runID)
            const notAccepted = tasks.filter((task) => task.status !== "accepted")
            const failed = notAccepted.filter((task) => task.status === "failed" || task.status === "cancelled")
            const userMsg: MessageV2.User = {
              id: MessageID.ascending(),
              sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: input.lastUser.agent,
              model: input.lastUser.model,
            }
            yield* sessions.updateMessage(userMsg)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID,
              type: "text",
              synthetic: true,
              metadata: { kind: clusterSynthesisReminderKind },
              text: [
                "<system-reminder>",
                failed.length
                  ? "The Multi-Agent run has failed or cancelled tasks. Do not present a successful final synthesis."
                  : "Final synthesis is blocked. Every planned task must be accepted with agent_cluster_review before final delivery.",
                "Non-accepted tasks:",
                ...notAccepted.map((task) => `- ${task.id}: ${task.status}`),
                failed.length
                  ? "Report the failure and unresolved issues."
                  : "Continue the fixed loop: poll submitted work, review each task with agent_cluster_review, revise if needed, and only then synthesize.",
                "</system-reminder>",
              ].join("\n"),
            } satisfies MessageV2.TextPart)
          },
        )

        while (true) {
          yield* status.set(sessionID, { type: "busy" })
          yield* slog.info("loop", { step })

          let msgs = yield* MessageV2.filterCompactedEffect(sessionID)
          latestMemoryUserText = memoryUserText(msgs) || latestMemoryUserText

          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

          if (step === 0 && canUsePersistentMemory && memory && (!lastAssistant || lastUser.id > lastAssistant.id)) {
            const updated = yield* memory
              .updateStepBegin(sessionID, evaluateMemoryDecision, { userText: latestMemoryUserText })
              .pipe(
                Effect.catchCause((cause) =>
                  slog
                    .warn("persistent memory update failed after user message; continuing prompt", {
                      cause: Cause.pretty(cause),
                    })
                    .pipe(Effect.as(undefined)),
                ),
              )
            if (updated) yield* slog.info("persistent memory updated after user message", { ...updated })
          }

          const lastAssistantMsg = msgs.findLast(
            (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
          )
          // Some providers return "stop" while a non-provider tool result still
          // needs to be replayed to the model. Child sessions also guard against
          // repeating the same tool turn without making progress.
          // Skip provider-executed tool parts �?those were fully handled within the
          // provider's stream (e.g. DWS Agent Platform) and don't need a re-loop.
          const hasToolCalls =
            lastAssistantMsg?.parts.some(
              (part) => part.type === "tool" && !part.metadata?.providerExecuted,
            ) ?? false

          if (session.parentID !== undefined && hasToolCalls && lastAssistantMsg) {
            const signature = [
              lastAssistantMsg.parts
                .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
                .map((part) => part.text.trim())
                .filter(Boolean)
                .join("\n"),
              lastAssistantMsg.parts
                .filter((part): part is MessageV2.ToolPart => part.type === "tool" && !part.metadata?.providerExecuted)
                .map((part) => {
                  // Include a truncated input fingerprint: identical tool names with
                  // different arguments (e.g. a researcher issuing many distinct
                  // searches) are progress, not a stuck loop.
                  const input = "input" in part.state ? JSON.stringify(part.state.input) : undefined
                  return `${part.tool}:${part.state.status}:${input?.slice(0, 200) ?? ""}`
                })
                .join(","),
            ].join("|")
            if (signature === previousToolTurnSignature) repeatedToolTurnCount++
            else {
              previousToolTurnSignature = signature
              repeatedToolTurnCount = 0
            }
            if (repeatedToolTurnCount >= 2 && lastAssistantMsg.info.role === "assistant") {
              yield* slog.warn("stopping repeated child-agent tool turns", {
                repetitions: repeatedToolTurnCount + 1,
                finish: lastAssistantMsg.info.finish,
              })
              yield* sessions.updateMessage({
                ...lastAssistantMsg.info,
                finish: "stop",
                time: { ...lastAssistantMsg.info.time, completed: lastAssistantMsg.info.time.completed ?? Date.now() },
              })
              break
            }
          } else {
            previousToolTurnSignature = undefined
            repeatedToolTurnCount = 0
          }

          if (
            lastAssistant?.finish &&
            !["tool-calls"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastUser.id < lastAssistant.id
          ) {
            const plan = clusterPlan(lastAssistantMsg)
            if (lastUser.agent === "cluster" && plan) {
              const clusterConfig = ConfigAgentCluster.resolve((yield* config.get()).agent_cluster)
              const validation = AgentClusterRuntime.validatePlan(plan, {
                maxSubagents: clusterConfig.max_subagents,
                maxConcurrency: clusterConfig.max_concurrency,
              })
              const persistedRunID = clusterRunID(msgs)
              if (validation.valid && persistedRunID) {
                yield* AgentCluster.persistPlan({ runID: persistedRunID, plan })
              }
              if (
                !hasTaskToolAfter(msgs, lastUser.id) &&
                !isClusterDispatchReminder(msgs.find((msg) => msg.info.id === lastUser.id))
              ) {
                yield* slog.info("cluster plan produced without task dispatch; requesting dispatch")
                yield* createClusterDispatchReminder({ lastUser, plan })
                continue
              }
            }
            const persistedRunID = lastUser.agent === "cluster" ? clusterRunID(msgs) : undefined
            if (persistedRunID && !isClusterSynthesisReminder(msgs.find((msg) => msg.info.id === lastUser.id))) {
              const state = yield* AgentCluster.getSessionState(sessionID)
              const tasks = state.tasks.filter((task) => task.run_id === persistedRunID)
              if (tasks.length > 0 && tasks.some((task) => task.status !== "accepted")) {
                yield* slog.info(
                  "cluster attempted final response before all tasks were accepted; requesting continuation",
                )
                yield* createClusterSynthesisReminder({ lastUser, runID: persistedRunID })
                continue
              }
            }
            yield* slog.info("exiting loop")
            break
          }

          step++
          if (step === 1)
            yield* title({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            }).pipe(Effect.ignore, Effect.forkIn(scope))

          const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          const task = tasks.pop()

          if (task?.type === "subtask") {
            yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
            continue
          }

          if (task?.type === "compaction") {
            const result = yield* compaction.process({
              messages: msgs,
              parentID: lastUser.id,
              sessionID,
              auto: task.auto,
              overflow: task.overflow,
            })
            if (result === "stop") break
            continue
          }

          if (
            lastFinished &&
            lastFinished.summary !== true &&
            (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
          ) {
            const created = yield* compaction.create({
              sessionID,
              agent: lastUser.agent,
              model: lastUser.model,
              auto: true,
            })
            if (!created) break
            continue
          }

          const agent = yield* agents.get(lastUser.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
            yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          const maxSteps = agent.steps ?? Infinity
          const isLastStep = step >= maxSteps
          msgs = yield* SessionReminders.apply({ messages: msgs, agent, session }).pipe(
            Effect.provideService(RuntimeFlags.Service, flags),
            Effect.provideService(AppFileSystem.Service, fsys),
            Effect.provideService(Session.Service, sessions),
          )
          if (yield* compaction.shouldCompact({ messages: msgs, model })) {
            const created = yield* compaction.create({
              sessionID,
              agent: lastUser.agent,
              model: lastUser.model,
              auto: true,
              overflow: true,
            })
            if (!created) break
            continue
          }

          const msg: MessageV2.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            variant: lastUser.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            time: { created: Date.now() },
            sessionID,
          }
          yield* sessions.updateMessage(msg)

          const finalizeInterruptedAssistant = Effect.gen(function* () {
            if (msg.time.completed) return
            msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
              providerID: msg.providerID,
              aborted: true,
            })
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          })

          const handle = yield* processor
            .create({
              assistantMessage: msg,
              sessionID,
              model,
            })
            .pipe(Effect.onInterrupt(() => finalizeInterruptedAssistant))

          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
            const promptOps: TaskPromptOps = yield* ops()

            // Resolve the cluster run ID for the current session if in cluster mode.
            let clusterRunID: string | undefined
            // 1. Try to find it in the message parts (synthetic planner prompt)
            for (const m of [...msgs].reverse()) {
              for (const part of m.parts) {
                const meta =
                  "metadata" in part ? (part.metadata as { kind?: string; runID?: string } | undefined) : undefined
                if (meta?.kind === "agent_cluster" && meta.runID) {
                  clusterRunID = meta.runID as string
                  break
                }
              }
              if (clusterRunID) break
            }
            // 2. Fall back to querying the database for the most recent open run
            if (!clusterRunID) {
              const rows = yield* Database.query((db) =>
                db
                  .select({ id: AgentClusterRunTable.id, time: AgentClusterRunTable.time_created })
                  .from(AgentClusterRunTable)
                  .where(Database.eq(AgentClusterRunTable.session_id, sessionID))
                  .all(),
              )
              clusterRunID = rows.toSorted((a, b) => b.time - a.time)[0]?.id
            }
            // Tools execute inside handle.process(), so wire the live text
            // accessor before SessionTools.resolve() creates AI SDK callbacks.
            if (clusterRunID) {
              promptOps.agentClusterRunID = clusterRunID
              promptOps.currentAssistantText = handle.allText
            }

            const tools = yield* SessionTools.resolve({
              agent,
              session,
              model,
              processor: handle,
              bypassAgentCheck,
              messages: msgs,
              promptOps,
              agentClusterRunID: clusterRunID,
            }).pipe(
              Effect.provideService(Plugin.Service, plugin),
              Effect.provideService(Permission.Service, permission),
              Effect.provideService(ToolRegistry.Service, registry),
              Effect.provideService(MCP.Service, mcp),
              Effect.provideService(Truncate.Service, truncate),
              Effect.provideService(Bus.Service, bus),
              Effect.provideService(RuntimeFlags.Service, flags),
              Effect.provideService(Config.Service, config),
            )

            if (lastUser.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess(output) {
                  structured = output
                },
              })
            }

            if (step === 1) {
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))
            }

            if (step > 1 && lastFinished) {
              for (const m of msgs) {
                if (m.info.role !== "user" || m.info.id <= lastFinished.id) continue
                for (const p of m.parts) {
                  if (p.type !== "text" || p.ignored || p.synthetic) continue
                  if (!p.text.trim()) continue
                  p.text = [
                    "<system-reminder>",
                    "The user sent the following message:",
                    p.text,
                    "",
                    "Please address this message and continue with your tasks.",
                    "</system-reminder>",
                  ].join("\n")
                }
              }
            }

            yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
            msgs = yield* applyMemoryRetrieval({
              sessionID,
              messages: msgs,
              lastUser,
              enabled: canUsePersistentMemory,
            })

            const memorySnapshot =
              step === 1 && canUsePersistentMemory && memory
                ? yield* memory.formatWithHeader(sessionID, "memory").pipe(
                    Effect.andThen((mem) =>
                      memory!.formatWithHeader(sessionID, "user").pipe(Effect.map((user) => [mem, user].join("\n"))),
                    ),
                    Effect.catchCause(() => Effect.succeed(undefined)),
                  )
                : undefined

            const [skills, env, instructions, modelMsgs] = yield* Effect.all([
              sys.skills(agent),
              sys.environment(model, { includeMemory: canUsePersistentMemory }),
              instruction.system().pipe(Effect.orDie),
              MessageV2.toModelMessagesEffect(msgs, model),
            ])
            const system = [
              ...(memorySnapshot ? [memorySnapshot] : []),
              ...env,
              ...instructions,
              ...(skills ? [skills] : []),
            ]
            const format = lastUser.format ?? { type: "text" as const }
            if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
            const result = yield* handle.process({
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              system,
              messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : [])],
              tools,
              model,
              toolChoice: format.type === "json_schema" ? "required" : undefined,
            })

            // Pre-persist the cluster plan so concurrent task dispatch
            // tool calls can find their rows in the database. We use the
            // in-memory text accumulator built during the stream — not a
            // DB read — because the SyncEvent projectors may not have
            // committed the text parts yet when concurrent tools execute.
            // Without this early persist, every task tool independently
            // tries to extract the plan from DB sources that may be empty,
            // exhausting retries and failing silently.
            if (lastUser.agent === "cluster" && clusterRunID) {
              yield* Effect.gen(function* () {
                const combined = handle.allText()
                // ALWAYS store in the in-memory cache so persistCurrentClusterPlan()
                // in task.ts can read the plan text without any DB round-trip.
                // This eliminates the race between SyncEvent projector commits and
                // concurrent tool execution in both CLI and TUI modes.
                storeClusterPlanText(clusterRunID, combined)
                const plan = AgentClusterRuntime.extractPlanFromText(combined)
                if (plan) {
                  const clusterCfg = ConfigAgentCluster.resolve((yield* config.get()).agent_cluster)
                  const validation = AgentClusterRuntime.validatePlan(plan, {
                    maxSubagents: clusterCfg.max_subagents,
                    maxConcurrency: clusterCfg.max_concurrency,
                  })
                  if (validation.valid) {
                    yield* AgentCluster.persistPlan({ runID: clusterRunID as RunID, plan })
                    yield* slog.info("cluster plan pre-persisted from in-memory text accumulator", {
                      runID: clusterRunID,
                      taskCount: plan.tasks.length,
                      textLen: combined.length,
                    })
                  } else {
                    yield* slog.warn("cluster plan validation failed", { errors: validation.errors.join("; ") })
                  }
                } else {
                  yield* slog.warn("cluster plan not found in in-memory text accumulator", {
                    runID: clusterRunID,
                    textLen: combined.length,
                    preview: combined.slice(0, 200),
                  })
                }
              }).pipe(
                Effect.catchCause((cause) =>
                  elog.warn("failed to pre-persist cluster plan", { error: Cause.squash(cause) }),
                ),
              )
            }

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              if (format.type === "json_schema") {
                handle.message.error = new MessageV2.StructuredOutputError({
                  message: "Model did not produce structured output",
                  retries: 0,
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }
            }

            if (result === "stop") return "break" as const
            if (result === "compact") {
              const created = yield* compaction.create({
                sessionID,
                agent: lastUser.agent,
                model: lastUser.model,
                auto: true,
                overflow: !handle.message.finish,
              })
              if (!created) return "break" as const
            }
            return "continue" as const
          }).pipe(
            Effect.ensuring(instruction.clear(handle.message.id)),
            Effect.onInterrupt(() => finalizeInterruptedAssistant),
          )
          if (outcome === "break") break
          continue
        }

        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        const result = yield* lastAssistant(sessionID)
        if (canUsePersistentMemory && memory) {
          const curated = yield* memory
            .updateAfterTurn(sessionID, evaluateMemoryDecision, {
              userText: latestMemoryUserText,
              assistantText: latestRealAssistantText(result),
            })
            .pipe(
              Effect.catchCause((cause) =>
                slog
                  .warn("persistent memory update failed after assistant response; preserving response", {
                    cause: Cause.pretty(cause),
                  })
                  .pipe(Effect.as(undefined)),
              ),
            )
          if (curated) yield* elog.info("persistent memory curator completed", { sessionID, ...curated })
        }
        return result
      },
    )

    const loop: (input: LoopInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      return yield* state.ensureRunning(input.sessionID, lastAssistant(input.sessionID), runLoop(input.sessionID))
    })

    const shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* elog.info("command", { sessionID: input.sessionID, command: input.command, agent: input.agent })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...templateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* bus.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel,
      prompt,
      loop,
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(SessionCompaction.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Command.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(MCP.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(ToolRegistry.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(Layer.mergeAll(Image.defaultLayer, Memory.defaultLayer)),
    Layer.provide(
      Layer.mergeAll(
        EventV2Bridge.defaultLayer,
        Agent.defaultLayer,
        SystemPrompt.defaultLayer,
        LLM.defaultLayer,
        Reference.defaultLayer,
        BackgroundProcess.defaultLayer,
        Bus.layer,
        CrossSpawnSpawner.defaultLayer,
        RuntimeFlags.defaultLayer,
      ),
    ),
  ),
)

function latestRealUserText(messages: MessageV2.WithParts[]) {
  let selected: MessageV2.WithParts | undefined
  for (const message of messages) {
    if (message.info.role !== "user") continue
    const text = message.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n")
    if (!text) continue
    if (!selected || message.info.id > selected.info.id) selected = message
  }
  if (!selected) return ""
  return selected.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
}

function memoryUserText(messages: MessageV2.WithParts[]) {
  let selected: MessageV2.WithParts | undefined
  for (const message of messages) {
    if (message.info.role !== "user") continue
    const hasRealPart = message.parts.some((part) => !(part.type === "text" && part.synthetic))
    if (!hasRealPart) continue
    if (!selected || message.info.id > selected.info.id) selected = message
  }
  if (!selected) return ""
  const text = latestRealUserText([selected])
  if (text) return text
  const attachments = selected.parts.flatMap((part) => {
    if (part.type === "file") return [`文件 ${part.filename ?? part.url}`]
    if (part.type === "agent") return [`Agent ${part.name}`]
    if (part.type === "subtask") return [`子任务 ${part.description || part.prompt}`]
    return []
  })
  return attachments.length > 0 ? `提交了${attachments.join("、")}` : "提交了一条非文本消息"
}

function memoryMessageText(message: MessageV2.WithParts) {
  if (message.info.role === "user") return memoryUserText([message])
  if (message.info.role === "assistant") return latestRealAssistantText(message)
  return ""
}

function latestRealAssistantText(message: MessageV2.WithParts) {
  if (message.info.role !== "assistant") return ""
  const text = message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
  if (text) return text
  if (message.info.structured === undefined) return ""
  try {
    return JSON.stringify(message.info.structured)
  } catch {
    return String(message.info.structured)
  }
}

function memoryRetrievalQuery(input: string) {
  const text = input.replace(/\s+/g, " ").trim()
  if (!text) return ""
  const hints: string[] = []
  if (/(我.*(叫|名字|姓名|称呼|是谁)|名字|姓名|称呼)/.test(text)) {
    hints.push("用户 个人 身份 名字 姓名 称呼")
  }
  if (/(偏好|喜欢|习惯|风格|怎么回答|中文|英文|不要|别|必须)/.test(text)) {
    hints.push("偏好 喜欢 习惯 风格 沟通 回答 Communication Style Engineering Preferences")
  }
  if (/(项目|约定|工作流|经验|教训|环境|路径|目录|记忆库|memory)/i.test(text)) {
    hints.push("项目 约定 工作流 经验 教训 环境 路径 目录 Project Facts Engineering Conventions")
  }
  return [text, ...hints].join(" ").replace(/\s+/g, " ").trim().slice(0, MEMORY_RETRIEVAL_QUERY_MAX)
}

function formatMemoryRetrieval(query: string, results: Memory.SearchResult[]) {
  const body = results
    .map((item, index) => [`${index + 1}. ${item.file}:${item.line} [${item.section}]`, item.text].join("\n"))
    .join("\n\n")
  const text = [
    "<system-reminder>",
    "Relevant persistent memory was automatically retrieved from D:/jyycode/memory for this turn.",
    `Retrieval query: ${query}`,
    "",
    body,
    "",
    "Use these memories when relevant. Do not mention this retrieval unless the user asks how memory was used.",
    "</system-reminder>",
  ].join("\n")
  if (text.length <= MEMORY_RETRIEVAL_TEXT_MAX) return text
  return text.slice(0, MEMORY_RETRIEVAL_TEXT_MAX) + "\n[retrieved memory truncated]\n</system-reminder>"
}

const ModelRef = Schema.Struct({
  providerID: ProviderID,
  modelID: ModelID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(MessageV2.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  agentCluster: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
    }),
  ),
  parts: Schema.Array(
    Schema.Union([
      MessageV2.TextPartInput,
      MessageV2.FilePartInput,
      MessageV2.AgentPartInput,
      MessageV2.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output �?the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(MessageV2.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export * as SessionPrompt from "./prompt"
