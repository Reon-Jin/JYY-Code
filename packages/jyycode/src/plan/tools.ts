import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Config } from "@/config/config"
import { enabledProfiles, profileAgentName, resolveProfiles, type SubagentProfile } from "@/agent/subagent-profile"
import { Provider } from "@/provider/provider"
import { Bus } from "@/bus"
import { Tool } from "@/tool/tool"
import { EffectBridge, type Shape as EffectBridgeShape } from "@/effect/bridge"
import type { TaskPromptOps } from "@/session/tools"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Cause, Effect, Schema } from "effect"
import {
  PlanProtocol,
  parentSessionIdForRunId,
  registerChildRun,
  runIdForChildSession,
  type DispatchBrief,
  type PlanExecutionContext,
} from "./protocol"
import type { LaunchSnapshot } from "@/agent/subagent-profile"
import { PlanProtocolError, planFilePath, readPlanFileSync } from "./schema"
import { RuntimeEvent } from "./runtime-event"
import { Blackboard } from "./blackboard"

const Empty = Schema.Struct({})
const AnyObject = Schema.declare<unknown>((_u): _u is unknown => true)

/** The one public name used in model requests, prompts, results, and errors. */
export function modelFacingPlanToolName(id: string) {
  if (id === "Blackboard.reply") return "Blackboard_Reply"
  return id.replaceAll(".", "_")
}

const nonEmptyStringSchema: JSONSchema7 = { type: "string", minLength: 1 }
const stepIdSchema: JSONSchema7 = { type: "string", pattern: "^s[1-9]\\d*$" }
const taskIdSchema: JSONSchema7 = { type: "string", pattern: "^s[1-9]\\d*_t[1-9]\\d*$" }

const taskInputSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["title", "goal", "done_criteria"],
  properties: {
    title: nonEmptyStringSchema,
    goal: nonEmptyStringSchema,
    done_criteria: nonEmptyStringSchema,
    instructions: nonEmptyStringSchema,
    output_path: nonEmptyStringSchema,
    mode: {
      enum: ["standard", "candidate"],
      description:
        "Use candidate only when this Task is one of exactly 2-3 alternatives declared together in Plan_create or one Plan_update for a clean active Step; candidate output_path is assigned by the runtime.",
    },
  },
}

const stepInputSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["title", "goal", "done_criteria"],
  properties: {
    title: nonEmptyStringSchema,
    goal: nonEmptyStringSchema,
    done_criteria: nonEmptyStringSchema,
    tasks: {
      type: "array",
      items: taskInputSchema,
      description:
        "For a candidate Step, include exactly 2-3 candidate Tasks together. The initial Step may declare them in Plan_create; a later clean active Step may initialize them with one Plan_update containing 2-3 candidate add_task operations.",
    },
  },
}

export const PLAN_CREATE_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["title", "goal", "steps"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 60 },
    goal: nonEmptyStringSchema,
    steps: {
      type: "array",
      minItems: 2,
      items: stepInputSchema,
      description:
        "Only steps[0] may contain Task details at creation. Later active Steps are expanded with one Plan_update containing all ready standard Tasks or one complete 2-3 candidate Task group.",
    },
  },
}

const updateOps: JSONSchema7[] = [
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "fields"],
    properties: {
      op: { const: "edit_plan" },
      fields: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          title: { type: "string", minLength: 1, maxLength: 60 },
          goal: nonEmptyStringSchema,
        },
      },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "step"],
    properties: {
      op: { const: "add_step" },
      after: stepIdSchema,
      step: {
        type: "object",
        additionalProperties: false,
        required: ["title", "goal", "done_criteria"],
        properties: {
          title: nonEmptyStringSchema,
          goal: nonEmptyStringSchema,
          done_criteria: nonEmptyStringSchema,
        },
      },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "fields"],
    properties: {
      op: { const: "edit_step" },
      stepId: stepIdSchema,
      fields: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          title: nonEmptyStringSchema,
          goal: nonEmptyStringSchema,
          done_criteria: nonEmptyStringSchema,
        },
      },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId"],
    properties: { op: { const: "remove_step" }, stepId: stepIdSchema },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "task"],
    properties: { op: { const: "add_task" }, stepId: stepIdSchema, task: taskInputSchema },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "taskId", "fields"],
    properties: {
      op: { const: "edit_task" },
      stepId: stepIdSchema,
      taskId: taskIdSchema,
      fields: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          title: nonEmptyStringSchema,
          goal: nonEmptyStringSchema,
          done_criteria: nonEmptyStringSchema,
          instructions: nonEmptyStringSchema,
          output_path: nonEmptyStringSchema,
        },
      },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "taskId"],
    properties: { op: { const: "remove_task" }, stepId: stepIdSchema, taskId: taskIdSchema },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "taskId", "to"],
    properties: {
      op: { const: "set_task_status" },
      stepId: stepIdSchema,
      taskId: taskIdSchema,
      to: { enum: ["pending", "running", "reported", "approved", "rejected", "dismissed"] },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "taskId", "decision"],
    properties: {
      op: { const: "review_task" },
      stepId: stepIdSchema,
      taskId: taskIdSchema,
      decision: { enum: ["approve", "reject"] },
      feedback: nonEmptyStringSchema,
    },
    if: { properties: { decision: { const: "reject" } } },
    then: { required: ["feedback"] },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "selectedTaskId", "synthesisArtifact", "rationale"],
    properties: {
      op: { const: "select_candidate" },
      stepId: stepIdSchema,
      selectedTaskId: taskIdSchema,
      contributingTaskIds: { type: "array", uniqueItems: true, items: taskIdSchema },
      synthesisArtifact: nonEmptyStringSchema,
      rationale: nonEmptyStringSchema,
    },
  },
]

export const PLAN_UPDATE_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["revision", "ops"],
  properties: {
    revision: { type: "integer", minimum: 1 },
    ops: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { oneOf: updateOps },
      description:
        "add_task normally creates standard Tasks. A later clean active Step may initialize a candidate group only when this one call contains all 2-3 candidate add_task operations; dispatch the resulting group together.",
    },
  },
}

export const DISPATCH_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["taskIds", "role"],
  properties: {
    taskIds: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: taskIdSchema,
      description:
        "Batch all ready standard Task IDs from the current wave in one call. For a candidate Step, pass every candidate Task ID from the same Step in this one call; never dispatch candidates individually.",
    },
    role: { type: "string", minLength: 1, description: "Use an enabled role such as general." },
  },
}

const cancelSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["taskIds"],
  properties: { taskIds: { type: "array", minItems: 1, maxItems: 20, items: taskIdSchema } },
}

const reportSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["run_id", "status", "summary"],
  properties: {
    run_id: { type: "string", pattern: "^run__[A-Za-z0-9_-]+__s[1-9]\\d*_t[1-9]\\d*$" },
    status: { enum: ["done", "partial", "failed"] },
    summary: { type: "string", minLength: 1 },
    artifacts: { type: "array", items: nonEmptyStringSchema },
    issues: { type: "array", items: { type: "string" } },
  },
  if: { properties: { status: { const: "done" } } },
  then: { required: ["artifacts"] },
}

const inboxSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  properties: {
    mark_handled: { type: "array", items: { type: "string", minLength: 1 } },
  },
}

export const BLACKBOARD_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: nonEmptyStringSchema,
    kind: { enum: ["info", "risk", "blocker", "decision", "help"] },
    task_ids: { type: "array", uniqueItems: true, items: taskIdSchema },
    reply_to: nonEmptyStringSchema,
    attachments: { type: "array", items: nonEmptyStringSchema },
  },
}

function persistedRunId(session: Session.Info) {
  const rootID = session.parentID ?? session.id
  const plan = readPlanFileSync(planFilePath(session.directory, rootID))
  return plan?.steps
    .flatMap((step) => step.tasks)
    .find((task) => task.dispatch?.child_session_id === session.id)?.dispatch?.run_id
}

function runId(ctx: Tool.Context, session?: Session.Info) {
  const candidates = [
    ctx.extra?.run_id,
    ctx.extra?.runID,
    ctx.extra?.agentRunID,
    runIdForChildSession(ctx.sessionID),
    session ? persistedRunId(session) : undefined,
  ]
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0)
}

function protocolContext(session: Session.Info, ctx: Tool.Context): PlanExecutionContext {
  return {
    workspaceRoot: session.directory,
    sessionId: session.id,
    mode: session.multiAgent === true ? "multi" : "single",
    runId: runId(ctx, session),
  }
}

function jsonResult(tool: string, value: unknown) {
  return { title: modelFacingPlanToolName(tool), metadata: { protocol: "plan-v1" }, output: JSON.stringify(value, null, 2) }
}

function getSession(sessions: Session.Interface, sessionID: Tool.Context["sessionID"]) {
  return sessions.get(sessionID).pipe(Effect.orDie)
}

function promptOps(ctx: Tool.Context) {
  const value = ctx.extra?.promptOps
  if (!value) throw new Error("Plan runtime requires promptOps")
  return value as TaskPromptOps
}

function requestToolCatalogRefresh(ctx: Tool.Context) {
  const request = ctx.extra?.requestToolCatalogRefresh
  if (typeof request === "function") request()
}

function wakeBlackboardRecipients(
  ctx: Tool.Context,
  board: Blackboard.Interface,
  message: Blackboard.Message,
  bridge: EffectBridgeShape,
) {
  const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
  if (!ops) return Effect.void
  return Effect.gen(function* () {
    const recipients = yield* board.recipientsForMessage(message)
    bridge.fork(
      Effect.forEach(recipients, (recipient) =>
        ops
          .wake({
            sessionID: recipient.sessionID,
            kind: recipient.role === "main" ? "blackboard_agent_message" : "blackboard_direct_message",
            text:
              recipient.role === "main"
                ? "Blackboard 有新的子 Agent 消息。请调用 Blackboard 阅读全部当前 Step 消息；必要时可使用 Blackboard_Reply 回复。"
                : "Blackboard 收到与你的 Task 有关的新消息。请调用 Blackboard 阅读并处理；完成后继续当前任务。",
          })
          .pipe(Effect.ignore),
      ).pipe(Effect.asVoid),
    )
  })
}

function drainProtocolWakeups(
  protocol: PlanProtocol,
  ops: TaskPromptOps,
  bridge: EffectBridgeShape,
  sessionIDs: readonly string[],
  currentSessionID?: string,
) {
  const events = sessionIDs
    .filter((sessionID) => sessionID !== currentSessionID)
    .flatMap((sessionID) => protocol.drainWakeups(sessionID))
  bridge.fork(Effect.forEach(
    events,
    (event) =>
      ops
        .wake({
          sessionID: event.session_id as SessionID,
          kind: `plan_${event.type}`,
          text:
            event.type === "check_point"
              ? "候选流程已进入下一阶段。请先读取当前阶段要求，再继续候选任务。"
              : "候选流程有新的可处理事件。请先读取当前方案状态，再继续候选任务。",
        })
        .pipe(Effect.ignore),
  ).pipe(Effect.asVoid))
  return Effect.void
}

function candidateChildSessionIDs(session: Session.Info) {
  const rootID = session.parentID ?? session.id
  const plan = readPlanFileSync(planFilePath(session.directory, rootID))
  return (
    plan?.steps
      .flatMap((step) => step.tasks)
      .filter((task) => task.mode === "candidate")
      .flatMap((task) => (task.dispatch?.child_session_id ? [task.dispatch.child_session_id] : [])) ?? []
  )
}

/** The only user-visible content in a child session's initial message. */
export function childTaskBrief(brief: DispatchBrief, role?: Pick<LaunchSnapshot, "prompt">) {
  const parts = [
    "## Instructions",
    brief.task_instructions?.trim() || "No additional instructions.",
    "",
    "## Current Task Goal",
    brief.goal.trim(),
    "",
    "## Working Directory",
    brief.workspace_root,
    "你的工作目录与主 Agent 一致。所有相对路径都相对于此目录解析；不要在此目录之外读写文件。",
  ]
  const rolePrompt = role?.prompt.trim()
  if (rolePrompt) parts.push("", "## Role Instructions", rolePrompt)
  return parts.join("\n")
}

/** Full dispatch metadata is delivered in a synthetic message part. */
function childInternalTaskBrief(brief: DispatchBrief) {
  const standard = [
    "## 主 Agent 派发的任务简报",
    "",
    "```json",
    JSON.stringify(brief, null, 2),
    "```",
    "",
    "请严格按简报执行：先写入 `output_path`，再调用 `Report`；不要创建或输出父方案。",
    "`workspace_root` 是你的工作目录（与主 Agent 一致）；`output_path` 已是基于它解析好的绝对路径。简报或指令中出现的其他相对路径一律相对于 `workspace_root` 解析，禁止在工作目录之外读写文件。",
  ].join("\n")
  if (brief.mode !== "candidate") return standard
  return [
    standard,
    "",
    "## Candidate execution",
    "This is a candidate task. Use Candidate_declare once, then read peer declarations with Blackboard and reply directly to every other candidate before Candidate_ready.",
    "After the root calls Candidate_begin, work independently. Write only the isolated proposal described by this brief and submit it with Candidate_submit; do not call Report or use Blackboard during running.",
  ].join("\n")
}

export const BLACKBOARD_REPLY_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["message", "reply_to"],
  properties: {
    message: nonEmptyStringSchema,
    reply_to: nonEmptyStringSchema,
    kind: { enum: ["info", "risk", "blocker", "decision", "help"] },
    attachments: { type: "array", items: nonEmptyStringSchema },
  },
}

const candidateDeclareSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["approach", "assumptions", "risks", "differentiator"],
  properties: {
    approach: nonEmptyStringSchema,
    assumptions: { type: "array", maxItems: 20, items: nonEmptyStringSchema },
    risks: { type: "array", maxItems: 20, items: nonEmptyStringSchema },
    differentiator: nonEmptyStringSchema,
  },
}

const candidateSubmitSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["run_id", "status", "summary", "proposal"],
  properties: {
    run_id: { type: "string", pattern: "^run__[A-Za-z0-9_-]+__s[1-9]\\d*_t[1-9]\\d*$" },
    status: { enum: ["done", "partial", "failed"] },
    summary: nonEmptyStringSchema,
    proposal: nonEmptyStringSchema,
  },
}

export function childModelForRole(parentModel: Session.Info["model"], role: LaunchSnapshot) {
  const model = role.model ? Provider.parseModel(role.model) : parentModel
  if (!model) return undefined
  const sessionModel = "modelID" in model ? { id: model.modelID, providerID: model.providerID } : model
  return {
    ...sessionModel,
    ...(role.variant ? { variant: role.variant } : {}),
  }
}

export function childLaunchPrompt(brief: DispatchBrief, role: LaunchSnapshot) {
  return [childInternalTaskBrief(brief), "## Role instructions (launch only)", role.prompt.trim() || "No additional role instructions."].join(
    "\n\n",
  )
}

export function childLaunchParts(brief: DispatchBrief, role: LaunchSnapshot) {
  return [
    { type: "text" as const, text: childTaskBrief(brief, role) },
    { type: "text" as const, text: childLaunchPrompt(brief, role), synthetic: true, metadata: { kind: "plan_dispatch_context" } },
  ]
}

function protocolFor(
  sessions: Session.Interface,
  bus: Bus.Interface,
  runtime: {
    bridge: EffectBridgeShape
    promptOps?: TaskPromptOps
    beforeReport?: (ctx: PlanExecutionContext) => Promise<void>
    beforeStepAdvance?: (ctx: PlanExecutionContext) => Promise<void>
    profiles?: () => Promise<readonly SubagentProfile[]>
    candidateBoard?: Blackboard.Interface
  },
) {
  let protocol: PlanProtocol
  protocol = new PlanProtocol({
    eventSink: (event) => {
      runtime.bridge.fork(bus.publish(RuntimeEvent, event).pipe(Effect.ignore))
    },
    profiles: runtime.profiles,
    children: {
      async create(input) {
        const run = runtime.bridge.promise
        const parent = await run(sessions.get(input.parentSessionId as SessionID).pipe(Effect.orDie))
        const child = await run(
          sessions.create({
            parentID: parent.id,
            title: `Plan task ${input.taskId}`,
            agent: profileAgentName(input.role.id),
            model: childModelForRole(parent.model, input.role),
            permission: parent.permission,
            workspaceID: parent.workspaceID,
            directory: parent.directory,
          }),
        )
        return child.id
      },
      async start(input) {
        if (!runtime.promptOps) return
        const ops = runtime.promptOps
        registerChildRun(input.childSessionId, input.brief.run_id)
        runtime.bridge.fork(
          Effect.gen(function* () {
            // Persist the visible user prompt before starting the model loop. A
            // single fire-and-forget prompt could let the child run race its
            // first message, leaving some child sessions with no initial task.
            yield* ops.prompt({
              sessionID: input.childSessionId as SessionID,
              agent: profileAgentName(input.role.id),
              noReply: true,
              parts: childLaunchParts(input.brief, input.role),
            })
            yield* ops.loop({ sessionID: input.childSessionId as SessionID })
          })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  protocol.inbox.add({
                    session_id: input.parentSessionId,
                    task_id: input.taskId,
                    run_id: input.brief.run_id,
                    kind: "runtime_error",
                    message: `子 Agent 启动或执行失败：${Cause.pretty(cause)}`,
                    suggested_actions: ["读取 Inbox 查看错误", "取消任务并修正后重新派发"],
                  })
                  yield* ops
                    .wake({
                      sessionID: input.parentSessionId as SessionID,
                      kind: "plan_child_runtime_error",
                      text: `子 Agent ${input.childSessionId} 执行 ${input.taskId} 时发生运行时错误。先调用 Plan_read，再处理 Inbox。`,
                    })
                    .pipe(Effect.ignore)
                }),
              ),
            ),
        )
      },
      async terminate(sessionId) {
        const run = runtime.bridge.promise
        await run(sessions.setArchived({ sessionID: sessionId as SessionID }))
      },
    },
    beforeReport: runtime.beforeReport,
    beforeStepAdvance: runtime.beforeStepAdvance,
    candidateBoard: runtime.candidateBoard
      ? {
          postCandidateDeclaration: (input) =>
            runtime.bridge.promise(
              runtime.candidateBoard!.postCandidateDeclaration({ ...input, sessionID: input.sessionID as SessionID }),
            ),
          candidateDeclarations: (input) =>
            runtime.bridge.promise(
              runtime.candidateBoard!.candidateDeclarations({ ...input, rootSessionID: input.rootSessionID as SessionID }),
            ),
          candidatePeerReplyCoverage: (input) =>
            runtime.bridge.promise(
              runtime.candidateBoard!.candidatePeerReplyCoverage({ ...input, rootSessionID: input.rootSessionID as SessionID }),
            ),
          candidateParticipants: (input) =>
            runtime.bridge.promise(
              runtime.candidateBoard!.candidateParticipants({ ...input, rootSessionID: input.rootSessionID as SessionID }),
            ),
        }
      : undefined,
  })
  return protocol
}

export const PlanReadTool = Tool.define(
  "Plan.read",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "读取当前主 session 的持久化方案和进度。",
      parameters: Empty,
      catalog: {
        category: "other" as const,
        mutability: "read" as const,
        risk: "low" as const,
        detail: "standard" as const,
      },
      execute: (_input: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const protocol = protocolFor(sessions, bus, { bridge })
          const session = yield* getSession(sessions, ctx.sessionID)
          return jsonResult("Plan.read", yield* Effect.promise(() => protocol.read(protocolContext(session, ctx))))
        }),
    }
  }),
)

export const InboxTool = Tool.define(
  "Inbox",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "读取主 session 的异常 Inbox，并可标记已处理条目。",
      parameters: AnyObject,
      jsonSchema: inboxSchema,
      catalog: {
        category: "other" as const,
        mutability: "write" as const,
        risk: "low" as const,
        detail: "standard" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const protocol = protocolFor(sessions, bus, { bridge })
          const session = yield* getSession(sessions, ctx.sessionID)
          return jsonResult(
            "Inbox",
            yield* Effect.promise(() => protocol.readInbox(protocolContext(session, ctx), input)),
          )
        }),
    }
  }),
)

export const BlackboardTool = Tool.define(
  "Blackboard",
  Effect.gen(function* () {
    return {
      description: "无参读取当前 Step 的 Task 与新消息；用 message 发布简洁的发现、依赖、交接、决策、风险、阻塞或求助，不要发布心跳或重复的普通进度。",
      parameters: AnyObject,
      jsonSchema: BLACKBOARD_INPUT_SCHEMA,
      catalog: {
        category: "communication" as const,
        mutability: "write" as const,
        risk: "low" as const,
        detail: "standard" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const board = yield* Blackboard.Service
          const bridge = yield* EffectBridge.make()
          const value = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
          if (typeof value.message === "string") {
            const message = yield* board.postAgent({
              sessionID: ctx.sessionID,
              message: value.message,
              kind: typeof value.kind === "string" ? (value.kind as Blackboard.BlackboardKind) : undefined,
              taskIDs: Array.isArray(value.task_ids) ? value.task_ids.filter((item): item is string => typeof item === "string") : undefined,
              replyTo: typeof value.reply_to === "string" ? value.reply_to : undefined,
              attachments: Array.isArray(value.attachments)
                ? value.attachments.filter((item): item is string => typeof item === "string")
                : undefined,
            })
            requestToolCatalogRefresh(ctx)
            yield* wakeBlackboardRecipients(ctx, board, message, bridge)
            return jsonResult("Blackboard", message)
          }
          return jsonResult("Blackboard", yield* board.readAgent(ctx.sessionID))
        }).pipe(Effect.provide(Blackboard.defaultLayer)),
    }
  }),
)

export const BlackboardReplyTool = Tool.define(
  "Blackboard.reply",
  Effect.gen(function* () {
    return {
      description: "回复 Blackboard 的一条顶层消息。必须提供 reply_to 和 message；读取消息请使用 Blackboard。",
      parameters: AnyObject,
      jsonSchema: BLACKBOARD_REPLY_INPUT_SCHEMA,
      catalog: {
        category: "communication" as const,
        mutability: "write" as const,
        risk: "low" as const,
        detail: "standard" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const board = yield* Blackboard.Service
          const bridge = yield* EffectBridge.make()
          const value = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
          if (typeof value.message !== "string" || typeof value.reply_to !== "string")
            throw new PlanProtocolError({
              code: "SCHEMA_VALIDATION",
              message: "Blackboard_Reply requires message and reply_to",
              hint: "提供要回复的顶层消息 ID 与回复正文",
            })
          const message = yield* board.postAgent({
            sessionID: ctx.sessionID,
            message: value.message,
            replyTo: value.reply_to,
            kind: typeof value.kind === "string" ? (value.kind as Blackboard.BlackboardKind) : undefined,
            attachments: Array.isArray(value.attachments)
              ? value.attachments.filter((item): item is string => typeof item === "string")
              : undefined,
          })
          requestToolCatalogRefresh(ctx)
          yield* wakeBlackboardRecipients(ctx, board, message, bridge)
          return jsonResult("Blackboard.reply", message)
        }).pipe(Effect.provide(Blackboard.defaultLayer)),
    }
  }),
)

export const PlanCreateTool = Tool.define(
  "Plan.create",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description:
        "创建当前主 session 的 plan.json；后续阶段只建立骨架，细节用 Plan_update 展开。需要候选比较时，在 Plan_create 或后续 clean active Step 的一次 Plan_update 中完整放入 2-3 个 mode=candidate Task，运行时会自动创建 candidate_discussion 和隔离 proposal 路径。",
      parameters: AnyObject,
      jsonSchema: PLAN_CREATE_INPUT_SCHEMA,
      catalog: {
        category: "other" as const,
        mutability: "write" as const,
        risk: "medium" as const,
        detail: "standard" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const protocol = protocolFor(sessions, bus, { bridge })
          const session = yield* getSession(sessions, ctx.sessionID)
          const result = yield* Effect.promise(() => protocol.create(protocolContext(session, ctx), input))
          if (result.ok) requestToolCatalogRefresh(ctx)
          return jsonResult(
            "Plan.create",
            result,
          )
        }),
    }
  }),
)

export const PlanUpdateTool = Tool.define(
  "Plan.update",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description:
        "以 revision 乐观锁原子修改方案、展开标准任务、推进单智能体状态或审核子 Agent 汇报。后续 active Step 可在一次调用中用 2-3 个 candidate add_task 初始化候选组；不能向已有 candidate Step 追加或混入 standard Task。",
      parameters: AnyObject,
      jsonSchema: PLAN_UPDATE_INPUT_SCHEMA,
      catalog: {
        category: "other" as const,
        mutability: "write" as const,
        risk: "medium" as const,
        detail: "advanced" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const board = yield* Blackboard.Service
          const protocol = protocolFor(sessions, bus, {
            bridge,
            beforeStepAdvance: async (main) => {
              const unread = await bridge.promise(board.unreadForMain(main.sessionId as SessionID))
              if (unread > 0)
                throw new PlanProtocolError({
                  code: "BLACKBOARD_UNREAD",
                  message: `进入下一 Step 前必须处理当前 Step 的 ${unread} 条 Blackboard 消息`,
                  hint: "先无参调用 Blackboard，阅读并处理全部当前 Step 消息后，用同一 revision 重试 Plan_update",
                  retryable: true,
                })
            },
          })
          const session = yield* getSession(sessions, ctx.sessionID)
          const result = yield* Effect.promise(() => protocol.update(protocolContext(session, ctx), input))
          if (result.ok) requestToolCatalogRefresh(ctx)
          return jsonResult(
            "Plan.update",
            result,
          )
        }).pipe(Effect.provide(Blackboard.defaultLayer)),
    }
  }),
)

export const DispatchDispatchTool = Tool.define(
  "Dispatch.dispatch",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    return {
      description:
        "在多智能体模式把 pending/rejected 任务派给指定角色。必须选择一个当前启用的 role；如果 taskIds 中包含 candidate Task，必须在一次调用中包含该 Step 的全部 2-3 个候选 ID。",
      parameters: Schema.Struct({ taskIds: Schema.Array(Schema.String), role: Schema.String }),
      jsonSchema: DISPATCH_INPUT_SCHEMA,
      catalog: {
        category: "subagent" as const,
        mutability: "execute" as const,
        risk: "high" as const,
        detail: "advanced" as const,
      },
      execute: (input: { taskIds: string[]; role: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const session = yield* getSession(sessions, ctx.sessionID)
          const protocol = protocolFor(sessions, bus, {
            bridge,
            promptOps: promptOps(ctx),
            profiles: async () => enabledProfiles(resolveProfiles((await bridge.promise(config.get())).subagents?.profiles)),
          })
          const result = yield* Effect.promise(() => protocol.dispatch(protocolContext(session, ctx), input))
          if (result.ok) requestToolCatalogRefresh(ctx)
          return jsonResult(
            "Dispatch.dispatch",
            result,
          )
        }),
    }
  }),
)

export const DispatchRolesTool = Tool.define(
  "Dispatch.roles",
  Effect.gen(function* () {
    const config = yield* Config.Service
    return {
      description:
        "List every currently enabled sub-agent role available to Dispatch_dispatch, including its ID, name, description, model, and thinking depth.",
      parameters: Empty,
      jsonSchema: { type: "object", additionalProperties: false } satisfies JSONSchema7,
      catalog: {
        category: "subagent" as const,
        mutability: "read" as const,
        risk: "low" as const,
        detail: "standard" as const,
      },
      execute: (_input: {}, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const profiles = enabledProfiles(resolveProfiles((yield* config.get()).subagents?.profiles))
          return jsonResult("Dispatch.roles", {
            count: profiles.length,
            roles: profiles.map((profile) => ({
              id: profile.id,
              name: profile.name,
              description: profile.description,
              model: profile.model ?? null,
              variant: profile.variant ?? null,
            })),
          })
        }),
    }
  }),
)

export const DispatchCancelTool = Tool.define(
  "Dispatch.cancel",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "取消多智能体任务并终止其子 session；已取消任务可重复调用，子 session 清理失败会在结果中返回 termination_errors。",
      parameters: Schema.Struct({ taskIds: Schema.Array(Schema.String) }),
      jsonSchema: cancelSchema,
      catalog: {
        category: "subagent" as const,
        mutability: "execute" as const,
        risk: "high" as const,
        detail: "advanced" as const,
      },
      execute: (input: { taskIds: string[] }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const session = yield* getSession(sessions, ctx.sessionID)
          const protocol = protocolFor(sessions, bus, { bridge })
          const result = yield* Effect.promise(() => protocol.cancel(protocolContext(session, ctx), input.taskIds))
          if (result.ok) requestToolCatalogRefresh(ctx)
          return jsonResult("Dispatch.cancel", result)
        }),
    }
  }),
)

export const CandidateDeclareTool = Tool.define(
  "Candidate.declare",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "在候选讨论的 declaring 阶段提交一次盲声明。",
      parameters: AnyObject,
      jsonSchema: candidateDeclareSchema,
      catalog: { category: "communication" as const, mutability: "write" as const, risk: "low" as const, detail: "standard" as const },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const board = yield* Blackboard.Service
          const bridge = yield* EffectBridge.make()
          const ops = promptOps(ctx)
          const session = yield* getSession(sessions, ctx.sessionID)
          const protocol = protocolFor(sessions, bus, { bridge, candidateBoard: board })
          const result = yield* Effect.promise(() => protocol.candidateDeclare(protocolContext(session, ctx), input))
          if (result.ok) requestToolCatalogRefresh(ctx)
          yield* drainProtocolWakeups(protocol, ops, bridge, candidateChildSessionIDs(session), session.id)
          return jsonResult("Candidate.declare", result)
        }).pipe(Effect.provide(Blackboard.defaultLayer)),
    }
  }),
)

export const CandidateReadyTool = Tool.define(
  "Candidate.ready",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "确认已回复每位其他候选的顶层声明。",
      parameters: Empty,
      jsonSchema: { type: "object", additionalProperties: false } satisfies JSONSchema7,
      catalog: { category: "communication" as const, mutability: "write" as const, risk: "low" as const, detail: "standard" as const },
      execute: (_input: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const board = yield* Blackboard.Service
          const bridge = yield* EffectBridge.make()
          const ops = promptOps(ctx)
          const session = yield* getSession(sessions, ctx.sessionID)
          const protocol = protocolFor(sessions, bus, { bridge, candidateBoard: board })
          const result = yield* Effect.promise(() => protocol.candidateReady(protocolContext(session, ctx), {}))
          if (result.ok) requestToolCatalogRefresh(ctx)
          yield* drainProtocolWakeups(protocol, ops, bridge, session.parentID ? [session.parentID] : [])
          return jsonResult("Candidate.ready", result)
        }).pipe(Effect.provide(Blackboard.defaultLayer)),
    }
  }),
)

export const CandidateBeginTool = Tool.define(
  "Candidate.begin",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "由根会话显式开始候选的独立执行阶段。",
      parameters: Empty,
      jsonSchema: { type: "object", additionalProperties: false } satisfies JSONSchema7,
      catalog: { category: "subagent" as const, mutability: "execute" as const, risk: "medium" as const, detail: "advanced" as const },
      execute: (_input: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const ops = promptOps(ctx)
          const session = yield* getSession(sessions, ctx.sessionID)
          const protocol = protocolFor(sessions, bus, { bridge })
          const result = yield* Effect.promise(() => protocol.candidateBegin(protocolContext(session, ctx), {}))
          if (result.ok) requestToolCatalogRefresh(ctx)
          yield* drainProtocolWakeups(protocol, ops, bridge, candidateChildSessionIDs(session))
          return jsonResult("Candidate.begin", result)
        }),
    }
  }),
)

export const CandidateSubmitTool = Tool.define(
  "Candidate.submit",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "把候选方案写入服务端隔离提案并提交候选报告。",
      parameters: AnyObject,
      jsonSchema: candidateSubmitSchema,
      catalog: { category: "subagent" as const, mutability: "write" as const, risk: "medium" as const, detail: "standard" as const },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const ops = promptOps(ctx)
          const session = yield* getSession(sessions, ctx.sessionID)
          const protocol = protocolFor(sessions, bus, { bridge })
          const result = yield* Effect.promise(() => protocol.candidateSubmit(protocolContext(session, ctx), input))
          if (result.ok) requestToolCatalogRefresh(ctx)
          yield* drainProtocolWakeups(protocol, ops, bridge, session.parentID ? [session.parentID] : [])
          return jsonResult("Candidate.submit", result)
        }),
    }
  }),
)

export const ReportTool = Tool.define(
  "Report",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "子 session 唯一的任务汇报入口；先写入产出文件，再提交 done/partial/failed 汇报。",
      parameters: AnyObject,
      jsonSchema: reportSchema,
      catalog: {
        category: "subagent" as const,
        mutability: "write" as const,
        risk: "medium" as const,
        detail: "standard" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const session = yield* getSession(sessions, ctx.sessionID)
          const ops = promptOps(ctx)
          const board = yield* Blackboard.Service
          const protocol = protocolFor(sessions, bus, {
            bridge,
            promptOps: ops,
            beforeReport: async (child) => {
              try {
                await bridge.promise(board.assertReportReady(child.sessionId as SessionID))
              } catch {
                throw new PlanProtocolError({
                  code: "BLACKBOARD_UNREAD",
                  message: "Report 前必须读取 Blackboard",
                  hint: "先无参调用 Blackboard，处理新消息后用同一 run_id 重试 Report",
                  retryable: true,
                })
              }
            },
          })
          const result = yield* Effect.promise(() => protocol.report(protocolContext(session, ctx), input))
          if (result.ok) requestToolCatalogRefresh(ctx)
          const effectiveRunId = runId(ctx)
          const parentSessionId = effectiveRunId ? parentSessionIdForRunId(effectiveRunId) : undefined
          if (result.ok && parentSessionId) {
            bridge.fork(
              ops
                .wake({
                  sessionID: parentSessionId as SessionID,
                  kind: "plan_report_arrived",
                  text: `子 Agent 已提交 ${effectiveRunId} 的 Report（${result.review}）。先调用 Plan_read，再审核汇报或处理 Inbox。`,
                })
                .pipe(Effect.ignore),
            )
          }
          return jsonResult("Report", result)
        }).pipe(Effect.provide(Blackboard.defaultLayer)),
    }
  }),
)

export const PlanProtocolTools = [
  PlanReadTool,
  InboxTool,
  BlackboardTool,
  BlackboardReplyTool,
  PlanCreateTool,
  PlanUpdateTool,
  DispatchDispatchTool,
  DispatchRolesTool,
  DispatchCancelTool,
  CandidateDeclareTool,
  CandidateReadyTool,
  CandidateBeginTool,
  CandidateSubmitTool,
  ReportTool,
] as const

export const PLAN_TOOL_IDS = new Set<string>(PlanProtocolTools.map((tool) => tool.id))

export * as PlanTools from "./tools"
