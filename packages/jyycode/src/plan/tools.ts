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
import { PlanProtocolError } from "./schema"
import { RuntimeEvent } from "./runtime-event"
import { Blackboard } from "./blackboard"

const Empty = Schema.Struct({})
const AnyObject = Schema.declare<unknown>((_u): _u is unknown => true)

/** The one public name used in model requests, prompts, results, and errors. */
export function modelFacingPlanToolName(id: string) {
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
    output_path: nonEmptyStringSchema,
    mode: { enum: ["standard", "candidate"] },
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
    tasks: { type: "array", items: taskInputSchema },
  },
}

export const PLAN_CREATE_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["title", "goal", "steps"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 60 },
    goal: nonEmptyStringSchema,
    steps: { type: "array", minItems: 2, items: stepInputSchema },
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
    ops: { type: "array", minItems: 1, maxItems: 50, items: { oneOf: updateOps } },
  },
}

export const DISPATCH_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["taskIds", "role"],
  properties: {
    taskIds: { type: "array", minItems: 1, maxItems: 20, items: taskIdSchema },
    role: { type: "string", minLength: 1 },
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

function runId(ctx: Tool.Context) {
  const candidates = [ctx.extra?.run_id, ctx.extra?.runID, ctx.extra?.agentRunID, runIdForChildSession(ctx.sessionID)]
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0)
}

function protocolContext(session: Session.Info, ctx: Tool.Context): PlanExecutionContext {
  return {
    workspaceRoot: session.directory,
    sessionId: session.id,
    mode: session.multiAgent === true ? "multi" : "single",
    runId: runId(ctx),
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

/** Keep the child task brief readable in the session timeline as well as by the model. */
export function childTaskBrief(brief: DispatchBrief) {
  const standard = [
    "## 主 Agent 派发的任务简报",
    "",
    "```json",
    JSON.stringify(brief, null, 2),
    "```",
    "",
    "请严格按简报执行：先写入 `output_path`，再调用 `Report`；不要创建或输出父方案。",
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
  return [childTaskBrief(brief), "## Role instructions (launch only)", role.prompt.trim() || "No additional role instructions."].join(
    "\n\n",
  )
}

function protocolFor(
  sessions: Session.Interface,
  bus: Bus.Interface,
  runtime: {
    bridge: EffectBridgeShape
    promptOps?: TaskPromptOps
    beforeReport?: (ctx: PlanExecutionContext) => Promise<void>
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
        const brief = childLaunchPrompt(input.brief, input.role)
        runtime.bridge.fork(
          ops
            .prompt({
              sessionID: input.childSessionId as SessionID,
              agent: profileAgentName(input.role.id),
              parts: [{ type: "text", text: brief }],
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
      description: "无参读取当前 Step 的 Task 与新消息；仅在风险、阻塞、决策或求助时带 message 发布。",
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
            return jsonResult("Blackboard", message)
          }
          return jsonResult("Blackboard", yield* board.readAgent(ctx.sessionID))
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
      description: "创建当前主 session 的 plan.json；后续阶段只建立骨架，细节用 Plan_update 展开。",
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
          return jsonResult(
            "Plan.create",
            yield* Effect.promise(() => protocol.create(protocolContext(session, ctx), input)),
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
      description: "以 revision 乐观锁原子修改方案、展开任务、推进单智能体状态或审核子 Agent 汇报。",
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
          const protocol = protocolFor(sessions, bus, { bridge })
          const session = yield* getSession(sessions, ctx.sessionID)
          return jsonResult(
            "Plan.update",
            yield* Effect.promise(() => protocol.update(protocolContext(session, ctx), input)),
          )
        }),
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
      description: "在多智能体模式把 pending/rejected 任务派给指定角色。必须选择一个当前启用的 role。",
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
          return jsonResult(
            "Dispatch.dispatch",
            yield* Effect.promise(() => protocol.dispatch(protocolContext(session, ctx), input)),
          )
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
      description: "取消多智能体任务并终止其子 session。",
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
          return jsonResult(
            "Dispatch.cancel",
            yield* Effect.promise(() => protocol.cancel(protocolContext(session, ctx), input.taskIds)),
          )
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
          const session = yield* getSession(sessions, ctx.sessionID)
          const protocol = protocolFor(sessions, bus, { bridge, candidateBoard: board })
          return jsonResult("Candidate.declare", yield* Effect.promise(() => protocol.candidateDeclare(protocolContext(session, ctx), input)))
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
          const session = yield* getSession(sessions, ctx.sessionID)
          const protocol = protocolFor(sessions, bus, { bridge, candidateBoard: board })
          return jsonResult("Candidate.ready", yield* Effect.promise(() => protocol.candidateReady(protocolContext(session, ctx), {})))
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
          const session = yield* getSession(sessions, ctx.sessionID)
          const protocol = protocolFor(sessions, bus, { bridge })
          return jsonResult("Candidate.begin", yield* Effect.promise(() => protocol.candidateBegin(protocolContext(session, ctx), {})))
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
          const session = yield* getSession(sessions, ctx.sessionID)
          const protocol = protocolFor(sessions, bus, { bridge })
          return jsonResult("Candidate.submit", yield* Effect.promise(() => protocol.candidateSubmit(protocolContext(session, ctx), input)))
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
  PlanCreateTool,
  PlanUpdateTool,
  DispatchDispatchTool,
  DispatchCancelTool,
  CandidateDeclareTool,
  CandidateReadyTool,
  CandidateBeginTool,
  CandidateSubmitTool,
  ReportTool,
] as const

export const PLAN_TOOL_IDS = new Set<string>(PlanProtocolTools.map((tool) => tool.id))

export * as PlanTools from "./tools"
