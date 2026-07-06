import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { BackgroundJob } from "@/background/job"
import { AgentCluster } from "@/agent-cluster/cluster"
import { AgentClusterRuntime } from "@/agent-cluster/runtime"
import { Bus } from "@/bus"
import { Session } from "@/session/session"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { SessionStatus } from "@/session/status"
import { Config } from "@/config/config"
import { ConfigAgentCluster } from "@/config/agent-cluster"
import { Provider } from "@/provider/provider"
import { ModelID } from "@/provider/schema"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Worktree } from "@/worktree"
import { Git } from "@/git"
import { Cause, Effect, Exit, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import path from "path"
import { pathToFileURL } from "url"
import type { RunID } from "@/agent-cluster/schema"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
  loop(input: SessionPrompt.LoopInput): Effect.Effect<MessageV2.WithParts>
}

export interface TaskWorktreeOps {
  create(input?: { name?: string }): Effect.Effect<Worktree.Info>
}

export type TaskGitOps = Pick<Git.Interface, "branch" | "patchAll" | "run" | "status">

const ContextAttachment = Schema.Struct({
  type: Schema.Literals(["text", "file", "directory"]),
  value: Schema.String,
  note: Schema.optional(Schema.String),
}).annotate({ identifier: "TaskContextAttachment" })

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "",
  "",
  [
    "Background mode: background=true launches the subagent asynchronously.",
    "Use task_status(task_id=..., wait=false) to poll, or wait=true to block until done.",
  ].join(" "),
].join("\n")
const FORK_CONTEXT_MAX_CHARS = 20_000

function agentClusterRunID(ctx: Tool.Context) {
  if (typeof ctx.extra?.agentClusterRunID === "string") return ctx.extra.agentClusterRunID
  for (const message of ctx.messages) {
    for (const part of message.parts) {
      const metadata = "metadata" in part ? (part.metadata as { kind?: string; runID?: string } | undefined) : undefined
      if (metadata?.kind === "agent_cluster" && metadata.runID) return metadata.runID
    }
  }
  return undefined
}

const BaseParameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  model: Schema.optional(Schema.String).annotate({
    description:
      "Optional model override for this subagent task. Use provider/model when possible; a bare model id must match exactly one configured provider.",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  fork: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true, inherit recent parent conversation context. Use for continuing a multi-file investigation or refactor where the child needs the same background.",
  }),
  isolation: Schema.optional(Schema.Literal("worktree")).annotate({
    description:
      "Optional isolation mode. Set to worktree when the subagent may edit files in parallel without touching the parent working tree.",
  }),
  worktree_name: Schema.optional(Schema.String).annotate({
    description: "Optional short name for the isolated worktree when isolation=worktree",
  }),
  context: Schema.optional(Schema.Array(ContextAttachment)).annotate({
    description:
      "Optional structured context for the subagent. Use text for short notes, file for a relevant file path, and directory for a relevant directory path.",
  }),
  merge: Schema.optional(Schema.Literal("auto")).annotate({
    description:
      "When isolation=worktree, set merge=auto to review the child worktree, commit its changes on the child branch, and merge that branch into the parent session branch after the task succeeds.",
  }),
})

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  model: Schema.optional(Schema.String).annotate({
    description:
      "Optional model override for this subagent task. Use provider/model when possible; a bare model id must match exactly one configured provider.",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  background: Schema.optional(Schema.Boolean).annotate({
    description: "When true, launch the subagent in the background and return immediately",
  }),
  fork: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true, inherit recent parent conversation context. Use for continuing a multi-file investigation or refactor where the child needs the same background.",
  }),
  isolation: Schema.optional(Schema.Literal("worktree")).annotate({
    description:
      "Optional isolation mode. Set to worktree when the subagent may edit files in parallel without touching the parent working tree.",
  }),
  worktree_name: Schema.optional(Schema.String).annotate({
    description: "Optional short name for the isolated worktree when isolation=worktree",
  }),
  context: Schema.optional(Schema.Array(ContextAttachment)).annotate({
    description:
      "Optional structured context for the subagent. Use text for short notes, file for a relevant file path, and directory for a relevant directory path.",
  }),
  merge: Schema.optional(Schema.Literal("auto")).annotate({
    description:
      "When isolation=worktree, set merge=auto to review the child worktree, commit its changes on the child branch, and merge that branch into the parent session branch after the task succeeds.",
  }),
})

function output(sessionID: SessionID, text: string) {
  return [
    `task_id: ${sessionID} (for resuming to continue this task if needed)`,
    "",
    "<task_result>",
    text,
    "</task_result>",
  ].join("\n")
}

function backgroundOutput(sessionID: SessionID) {
  return [
    `task_id: ${sessionID} (for polling this task with task_status)`,
    "state: running",
    "",
    "<task_result>",
    "Background task started. Continue your current work and call task_status when you need the result.",
    "</task_result>",
  ].join("\n")
}

function backgroundMessage(input: {
  sessionID: SessionID
  description: string
  state: "completed" | "error"
  text: string
}) {
  const tag = input.state === "completed" ? "task_result" : "task_error"
  const title =
    input.state === "completed"
      ? `Background task completed: ${input.description}`
      : `Background task failed: ${input.description}`
  return [title, `task_id: ${input.sessionID}`, `state: ${input.state}`, "", `<${tag}>`, input.text, `</${tag}>`].join(
    "\n",
  )
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function partSummary(part: MessageV2.Part) {
  if (part.type === "text") return part.text
  if (part.type === "file") return `[Attached file: ${part.filename ?? part.mime}]`
  if (part.type === "tool") {
    const input = "input" in part.state ? JSON.stringify(part.state.input) : "{}"
    if (part.state.status === "completed") return `[Tool ${part.tool} ${input} -> ${part.state.output.slice(0, 1200)}]`
    if (part.state.status === "error") return `[Tool ${part.tool} ${input} failed: ${part.state.error}]`
    return `[Tool ${part.tool} ${input} ${part.state.status}]`
  }
  if (part.type === "patch") return `[Patch: ${part.files.length} file(s) changed]`
  if (part.type === "reasoning") return ""
  return `[${part.type}]`
}

function forkContext(messages: MessageV2.WithParts[]) {
  const chunks = messages
    .slice(-16)
    .flatMap((message) => {
      const body = message.parts
        .map(partSummary)
        .map((item) => item.trim())
        .filter(Boolean)
        .join("\n")
      if (!body) return []
      return [`${message.info.role.toUpperCase()} (${message.info.agent ?? message.info.role}):\n${body}`]
    })
    .join("\n\n")
  if (chunks.length <= FORK_CONTEXT_MAX_CHARS) return chunks
  return chunks.slice(chunks.length - FORK_CONTEXT_MAX_CHARS)
}

function forkPrompt(input: { context: string; prompt: string }) {
  return [
    "<forked-context>",
    "You are a forked subagent. You inherited recent parent conversation context below.",
    "Use it as background, but stay strictly within the directive after </forked-context>.",
    "Do not spawn another forked task. Work directly with your tools and report concise facts.",
    "",
    input.context || "(no parent context available)",
    "</forked-context>",
    "",
    "<directive>",
    input.prompt,
    "</directive>",
  ].join("\n")
}

function worktreePrompt(input: { info: Worktree.Info; prompt: string }) {
  return [
    "<worktree-isolation>",
    `You are operating in an isolated git worktree at ${input.info.directory}.`,
    input.info.branch ? `Branch: ${input.info.branch}` : "Branch: detached HEAD",
    "Use this directory for file reads, edits, commands, and verification.",
    "Do not modify the parent working tree. Re-read files in this worktree before editing.",
    "</worktree-isolation>",
    "",
    input.prompt,
  ].join("\n")
}

function mergePrompt(input: { prompt: string }) {
  return [
    "<auto-merge-workflow>",
    "After you finish, the parent agent will review this worktree, commit your branch changes, and merge the branch into the parent session branch if the review checks pass.",
    "Keep changes focused. Run relevant verification and report exact commands and results.",
    "</auto-merge-workflow>",
    "",
    input.prompt,
  ].join("\n")
}

function worktreeExternalPattern(directory: string) {
  const pattern = path.join(directory, "*")
  return process.platform === "win32" ? AppFileSystem.normalizePathPattern(pattern) : pattern.replaceAll("\\", "/")
}

function contextPromptParts(
  context: ReadonlyArray<Schema.Schema.Type<typeof ContextAttachment>> | undefined,
  parentDirectory: string,
): SessionPrompt.PromptInput["parts"] {
  if (!context?.length) return []

  const lines = context.map((item, index) => {
    const prefix = `${index + 1}. ${item.type}`
    if (item.type === "text") return `${prefix}: ${item.value}${item.note ? ` (${item.note})` : ""}`
    const filepath = path.isAbsolute(item.value) ? item.value : path.resolve(parentDirectory, item.value)
    return `${prefix}: ${filepath}${item.note ? ` (${item.note})` : ""}`
  })

  const fileParts = context.flatMap((item): SessionPrompt.PromptInput["parts"] => {
    if (item.type === "text") return []
    const filepath = path.isAbsolute(item.value) ? item.value : path.resolve(parentDirectory, item.value)
    return [
      {
        type: "file" as const,
        mime: item.type === "directory" ? "application/x-directory" : "text/plain",
        filename: filepath,
        url: pathToFileURL(filepath).href,
      },
    ]
  })

  return [
    {
      type: "text" as const,
      text: ["<task-context>", ...lines, "</task-context>"].join("\n"),
    },
    ...fileParts,
  ]
}

function gitOutput(result: Git.Result) {
  return result.stderr.toString("utf8").trim() || result.text().trim()
}

function statusSummary(items: Git.Item[]) {
  if (!items.length) return "(clean)"
  return items.map((item) => `${item.code} ${item.file}`).join("\n")
}

function mergeReviewOutput(input: {
  state: "merged" | "blocked" | "failed" | "skipped"
  branch?: string
  directory: string
  parentDirectory: string
  message: string
  status?: Git.Item[]
  patch?: string
}) {
  return [
    "<worktree_review>",
    `state: ${input.state}`,
    input.branch ? `branch: ${input.branch}` : undefined,
    `worktree: ${input.directory}`,
    `parent: ${input.parentDirectory}`,
    "",
    input.message,
    input.status?.length ? ["", "changed files:", statusSummary(input.status)].join("\n") : undefined,
    input.patch ? ["", "reviewed patch:", input.patch].join("\n") : undefined,
    "</worktree_review>",
  ]
    .filter(Boolean)
    .join("\n")
}

function withMergeReview(taskText: string, review: string | undefined) {
  if (!review) return taskText
  return [taskText, "", review].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const clusterBackground = ctx.agent === "cluster"
      const runInBackground = params.background === true || clusterBackground
      const clusterRunID = clusterBackground ? agentClusterRunID(ctx) : undefined
      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(Effect.orDie)
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const persistCurrentClusterPlan = Effect.fn("TaskTool.persistCurrentClusterPlan")(function* () {
        if (!clusterRunID) return false
        const current = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(Effect.orDie)
        const plan = AgentClusterRuntime.extractPlanFromText(
          current.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
        )
        if (!plan) return false
        const clusterConfig = ConfigAgentCluster.resolve(cfg.agent_cluster)
        const validation = AgentClusterRuntime.validatePlan(plan, {
          maxSubagents: clusterConfig.max_subagents,
          maxConcurrency: clusterConfig.max_concurrency,
        })
        if (!validation.valid) {
          return yield* Effect.fail(new Error(`Invalid cluster plan: ${validation.errors.join("; ")}`))
        }
        yield* AgentCluster.persistPlan({ runID: clusterRunID as RunID, plan })
        return true
      })
      if (clusterBackground && clusterRunID && !params.task_id) {
        return yield* Effect.fail(new Error("Cluster task_id is required for every task in an active cluster run"))
      }
      if (clusterBackground && clusterRunID && params.task_id) yield* persistCurrentClusterPlan()
      const prepareClusterDispatch = () =>
        AgentCluster.prepareTaskDispatch({
          runID: clusterRunID,
          requestedTaskID: params.task_id,
          prompt: params.prompt,
        })
      let clusterDispatch =
        clusterBackground && params.task_id
          ? yield* prepareClusterDispatch().pipe(Effect.exit)
          : undefined
      if (clusterDispatch && Exit.isFailure(clusterDispatch)) {
        const error = Cause.squash(clusterDispatch.cause)
        if (String(error).includes("Unknown cluster task for run")) {
          for (let attempt = 0; attempt < 30; attempt++) {
            yield* Effect.sleep("100 millis")
            if (!(yield* persistCurrentClusterPlan())) continue
            clusterDispatch = yield* prepareClusterDispatch().pipe(Effect.exit)
            break
          }
        }
      }
      if (clusterDispatch && Exit.isFailure(clusterDispatch)) return yield* Effect.failCause(clusterDispatch.cause)
      const preparedDispatch = clusterDispatch?.value
      const effectivePrompt = preparedDispatch?.prompt ?? params.prompt
      const clusterPlanTaskID = preparedDispatch?.taskID
      const resumeTaskID = preparedDispatch?.childSessionID ?? (clusterPlanTaskID ? undefined : params.task_id)
      if (runInBackground && !clusterBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require JYYCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const resolveModel = Effect.fn("TaskTool.resolveModel")(function* (model: string) {
        if (model.includes("/")) {
          const parsed = Provider.parseModel(model)
          yield* provider.getModel(parsed.providerID, parsed.modelID)
          return parsed
        }

        const providers = yield* provider.list()
        const matches = Object.values(providers)
          .filter((item) => item.models[model])
          .map((item) => ({ providerID: item.id, modelID: ModelID.make(model) }))
        if (matches.length === 1) return matches[0]!
        if (matches.length > 1) {
          return yield* Effect.fail(new Error(`Task model "${model}" is ambiguous; use provider/${model}`))
        }
        return yield* Effect.fail(new Error(`Task model not found: ${model}`))
      })

      const taskID = resumeTaskID
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parent = yield* sessions.get(ctx.sessionID)
      if (params.isolation === "worktree" && session) {
        return yield* Effect.fail(
          new Error("Worktree isolation only applies when creating a new task session; resume without isolation."),
        )
      }
      if (params.merge === "auto" && params.isolation !== "worktree") {
        return yield* Effect.fail(new Error("Automatic merge requires isolation=worktree."))
      }
      if (params.fork === true && /\sfork\)$/i.test(parent.title)) {
        return yield* Effect.fail(new Error("Forked subagents cannot spawn another forked subagent."))
      }
      const parentAgent = parent.agent
        ? yield* agent.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const createWorktree = Effect.fn("TaskTool.createWorktree")(function* () {
        const injected = ctx.extra?.worktreeOps as TaskWorktreeOps | undefined
        if (injected) return yield* injected.create({ name: params.worktree_name ?? params.description })

        const service = Option.getOrUndefined(yield* Effect.serviceOption(Worktree.Service))
        if (!service) return yield* Effect.fail(new Error("Worktree isolation requires Worktree service."))
        return yield* service.create({ name: params.worktree_name ?? params.description })
      })
      const isolatedWorktree = params.isolation === "worktree" && !session ? yield* createWorktree() : undefined
      const gitOps = Effect.fn("TaskTool.gitOps")(function* () {
        const injected = ctx.extra?.gitOps as TaskGitOps | undefined
        if (injected) return injected

        const service = Option.getOrUndefined(yield* Effect.serviceOption(Git.Service))
        if (!service) return yield* Effect.fail(new Error("Automatic worktree merge requires Git service."))
        return service
      })
      const permission = [
        ...deriveSubagentSessionPermission({
          parentSessionPermission: parent.permission ?? [],
          parentAgent,
          subagent: next,
        }),
        ...(isolatedWorktree
          ? [
              {
                pattern: worktreeExternalPattern(isolatedWorktree.directory),
                action: "allow" as const,
                permission: "external_directory",
              },
            ]
          : []),
        ...(cfg.experimental?.primary_tools?.map((item) => ({
          pattern: "*",
          action: "allow" as const,
          permission: item,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} ${params.fork === true ? "fork" : "subagent"})`,
          directory: isolatedWorktree?.directory,
          permission,
        }))

      const model = params.model
        ? yield* resolveModel(params.model)
        : (next.model ?? {
            modelID: msg.info.modelID,
            providerID: msg.info.providerID,
          })
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(params.fork === true ? { fork: true } : {}),
        ...(isolatedWorktree
          ? {
              isolation: "worktree" as const,
              worktree: {
                name: isolatedWorktree.name,
                directory: isolatedWorktree.directory,
                ...(isolatedWorktree.branch ? { branch: isolatedWorktree.branch } : {}),
              },
              ...(params.merge === "auto" ? { merge: "auto" as const } : {}),
            }
          : {}),
        ...(runInBackground ? { background: true } : {}),
        ...(clusterRunID && clusterPlanTaskID
          ? { agentCluster: { runID: clusterRunID, taskID: clusterPlanTaskID } }
          : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      const runCancel = yield* EffectBridge.make()

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const resolved = yield* ops.resolvePromptParts(effectivePrompt)
        const extraParts = contextPromptParts(params.context, parent.directory)
        const prompt = isolatedWorktree
          ? worktreePrompt({
              info: isolatedWorktree,
              prompt:
                params.merge === "auto"
                  ? mergePrompt({
                      prompt:
                        params.fork === true
                          ? forkPrompt({
                              context: forkContext(ctx.messages),
                              prompt: effectivePrompt,
                            })
                          : effectivePrompt,
                    })
                  : params.fork === true
                    ? forkPrompt({
                        context: forkContext(ctx.messages),
                        prompt: effectivePrompt,
                      })
                    : effectivePrompt,
            })
          : params.fork === true
            ? forkPrompt({
                context: forkContext(ctx.messages),
                prompt: effectivePrompt,
              })
            : undefined
        const parts = prompt
          ? [
              ...extraParts,
              {
                type: "text" as const,
                text: prompt,
              },
            ]
          : [...extraParts, ...resolved]
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          agent: next.name,
          tools: {
            ...(next.permission.some((rule) => rule.permission === "todowrite" && rule.action === "allow")
              ? {}
              : { todowrite: false }),
            ...(next.permission.some((rule) => rule.permission === id && rule.action === "allow")
              ? {}
              : { task: false }),
            ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
          },
          parts,
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const reviewAndMerge = Effect.fn("TaskTool.reviewAndMerge")(function* () {
        if (!isolatedWorktree || params.merge !== "auto") return undefined
        const git = yield* gitOps()
        const branch = isolatedWorktree.branch ?? (yield* git.branch(isolatedWorktree.directory))
        if (!branch) {
          return mergeReviewOutput({
            state: "blocked",
            directory: isolatedWorktree.directory,
            parentDirectory: parent.directory,
            message: "Cannot auto-merge because the isolated worktree is detached and has no branch.",
          })
        }

        const childStatus = yield* git.status(isolatedWorktree.directory)
        if (childStatus.some((item) => item.code.includes("U"))) {
          return mergeReviewOutput({
            state: "blocked",
            branch,
            directory: isolatedWorktree.directory,
            parentDirectory: parent.directory,
            status: childStatus,
            message: "Cannot auto-merge because the child worktree has unresolved conflicts.",
          })
        }

        const patch = childStatus.length
          ? yield* git.patchAll(isolatedWorktree.directory, "HEAD", { maxOutputBytes: 80_000 })
          : undefined
        if (patch?.truncated) {
          return mergeReviewOutput({
            state: "blocked",
            branch,
            directory: isolatedWorktree.directory,
            parentDirectory: parent.directory,
            status: childStatus,
            message: "Cannot auto-merge because the child patch is too large to review safely.",
          })
        }

        if (childStatus.length) {
          const added = yield* git.run(["add", "-A"], { cwd: isolatedWorktree.directory })
          if (added.exitCode !== 0) {
            return mergeReviewOutput({
              state: "failed",
              branch,
              directory: isolatedWorktree.directory,
              parentDirectory: parent.directory,
              status: childStatus,
              message: `Failed to stage child worktree changes: ${gitOutput(added)}`,
            })
          }
          const committed = yield* git.run(["commit", "-m", `Task: ${params.description}`], {
            cwd: isolatedWorktree.directory,
          })
          if (committed.exitCode !== 0) {
            return mergeReviewOutput({
              state: "failed",
              branch,
              directory: isolatedWorktree.directory,
              parentDirectory: parent.directory,
              status: childStatus,
              message: `Failed to commit child worktree changes: ${gitOutput(committed)}`,
              patch: patch?.text,
            })
          }
        }

        const parentStatus = yield* git.status(parent.directory)
        if (parentStatus.length) {
          return mergeReviewOutput({
            state: "blocked",
            branch,
            directory: isolatedWorktree.directory,
            parentDirectory: parent.directory,
            status: parentStatus,
            message: "Reviewed child worktree, but did not merge because the parent worktree has local changes.",
            patch: patch?.text,
          })
        }

        const diff = yield* git.run(["diff", "--name-status", "HEAD.." + branch, "--", "."], {
          cwd: parent.directory,
          maxOutputBytes: 80_000,
        })
        if (diff.exitCode !== 0) {
          return mergeReviewOutput({
            state: "failed",
            branch,
            directory: isolatedWorktree.directory,
            parentDirectory: parent.directory,
            message: `Failed to inspect branch diff before merge: ${gitOutput(diff)}`,
            patch: patch?.text,
          })
        }
        if (!diff.text().trim()) {
          return mergeReviewOutput({
            state: "skipped",
            branch,
            directory: isolatedWorktree.directory,
            parentDirectory: parent.directory,
            message: "Reviewed child worktree; branch has no changes to merge.",
          })
        }

        const merged = yield* git.run(["merge", "--no-ff", "--no-edit", branch], { cwd: parent.directory })
        if (merged.exitCode !== 0) {
          yield* git.run(["merge", "--abort"], { cwd: parent.directory }).pipe(Effect.ignore)
          return mergeReviewOutput({
            state: "failed",
            branch,
            directory: isolatedWorktree.directory,
            parentDirectory: parent.directory,
            message: `Merge failed and was aborted: ${gitOutput(merged)}`,
            patch: patch?.text,
          })
        }

        const head = yield* git.run(["rev-parse", "--short", "HEAD"], { cwd: parent.directory })
        return mergeReviewOutput({
          state: "merged",
          branch,
          directory: isolatedWorktree.directory,
          parentDirectory: parent.directory,
          status: childStatus,
          message: `Reviewed child worktree and merged ${branch} into the parent branch. Parent HEAD is ${head.text().trim() || "unknown"}.`,
          patch: patch?.text,
        })
      })

      const runTaskWithMerge = Effect.fn("TaskTool.runTaskWithMerge")(function* () {
        const text = yield* runTask()
        const review = yield* reviewAndMerge()
        return withMergeReview(text, review)
      })

      const resumeWhenIdle: (input: { userID: MessageID; state: "completed" | "error" }) => Effect.Effect<void> =
        Effect.fn("TaskTool.resumeWhenIdle")(function* (input: { userID: MessageID; state: "completed" | "error" }) {
          const latest = yield* sessions
            .findMessage(ctx.sessionID, (item) => item.info.role === "user")
            .pipe(Effect.orDie)
          if (Option.isNone(latest)) return
          if (latest.value.info.id !== input.userID) return
          if ((yield* status.get(ctx.sessionID)).type !== "idle") {
            yield* Effect.sleep("300 millis")
            return yield* resumeWhenIdle(input)
          }
          yield* bus.publish(TuiEvent.ToastShow, {
            title: input.state === "completed" ? "Background task complete" : "Background task failed",
            message:
              input.state === "completed"
                ? `Background task "${params.description}" finished. Resuming the main thread.`
                : `Background task "${params.description}" failed. Resuming the main thread.`,
            variant: input.state === "completed" ? "success" : "error",
            duration: 5000,
          })
          yield* ops
            .loop({ sessionID: ctx.sessionID })
            .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
        })

      const continueIfIdle = Effect.fn("TaskTool.continueIfIdle")(function* (input: {
        userID: MessageID
        state: "completed" | "error"
      }) {
        yield* resumeWhenIdle(input).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        const message = yield* ops.prompt({
          sessionID: ctx.sessionID,
          noReply: true,
          agent: currentParent.agent ?? ctx.agent,
          parts: [
            {
              type: "text",
              synthetic: true,
              text: backgroundMessage({
                sessionID: nextSession.id,
                description: params.description,
                state,
                text,
              }),
            },
          ],
        })
        yield* continueIfIdle({ userID: message.info.id, state })
      })

      const existing = yield* background.get(nextSession.id)
      if (existing?.status === "running") {
        return yield* Effect.fail(
          new Error(`Task ${nextSession.id} is already running. Use task_status to check progress.`),
        )
      }

      if (runInBackground) {
        const info = yield* background.start({
          id: nextSession.id,
          type: id,
          title: params.description,
          metadata,
          run: runTaskWithMerge().pipe(
            Effect.tap((text) =>
              AgentCluster.submitTaskResult({
                runID: clusterRunID,
                taskID: clusterPlanTaskID,
                childSessionID: nextSession.id,
                summary: AgentCluster.summarizeTaskResult(text),
              }),
            ),
            Effect.tap((text) => inject("completed", text).pipe(Effect.ignore)),
            Effect.catchCause((cause) =>
              (Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : AgentCluster.failTaskResult({
                    runID: clusterRunID,
                    taskID: clusterPlanTaskID,
                    childSessionID: nextSession.id,
                    error: errorText(Cause.squash(cause)),
                  }).pipe(Effect.andThen(inject("error", errorText(Cause.squash(cause))).pipe(Effect.ignore)))
              ).pipe(Effect.andThen(Effect.failCause(cause))),
            ),
          ),
        })
        if (clusterPlanTaskID) {
          yield* AgentCluster.markTaskRunning({
            runID: clusterRunID,
            taskID: clusterPlanTaskID,
            childSessionID: nextSession.id,
          })
        }

        return {
          title: params.description,
          metadata: {
            ...metadata,
            jobId: info.id,
          },
          output: backgroundOutput(nextSession.id),
        }
      }

      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const text = yield* runTask()
            const review = yield* reviewAndMerge()
            return {
              title: params.description,
              metadata,
              output: output(nextSession.id, withMergeReview(text, review)),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) yield* cancel
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents ? DESCRIPTION + BACKGROUND_DESCRIPTION : DESCRIPTION,
      parameters: Parameters,
      catalog: {
        category: "subagent",
        mutability: "external",
        risk: "medium",
        detail: "core",
      },
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
