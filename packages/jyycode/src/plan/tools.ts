import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
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
import { PlanProtocolError } from "./schema"
import { RuntimeEvent } from "./runtime-event"
import { Blackboard } from "./blackboard"

const Empty = Schema.Struct({})
const AnyObject = Schema.declare<unknown>((_u): _u is unknown => true)

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
      to: { enum: ["pending", "running", "reported", "approved", "rejected"] },
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

const dispatchSchema: JSONSchema7 = {
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

function jsonResult(title: string, value: unknown) {
  return { title, metadata: { protocol: "plan-v1" }, output: JSON.stringify(value, null, 2) }
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
  return [
    "## 主 Agent 派发的任务简报",
    "",
    "```json",
    JSON.stringify(brief, null, 2),
    "```",
    "",
    "请严格按简报执行：先写入 `output_path`，再调用 `Report`；不要创建或输出父方案。",
  ].join("\n")
}

function protocolFor(
  sessions: Session.Interface,
  bus: Bus.Interface,
  runtime: {
    bridge: EffectBridgeShape
    promptOps?: TaskPromptOps
    beforeReport?: (ctx: PlanExecutionContext) => Promise<void>
  },
) {
  let protocol: PlanProtocol
  protocol = new PlanProtocol({
    eventSink: (event) => {
      runtime.bridge.fork(bus.publish(RuntimeEvent, event).pipe(Effect.ignore))
    },
    children: {
      async create(input) {
        const run = runtime.bridge.promise
        const parent = await run(sessions.get(input.parentSessionId as SessionID).pipe(Effect.orDie))
        const child = await run(
          sessions.create({
            parentID: parent.id,
            title: `Plan task ${input.taskId}`,
            agent: "build",
            model: parent.model,
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
        const brief = childTaskBrief(input.brief)
        runtime.bridge.fork(
          ops
            .prompt({
              sessionID: input.childSessionId as SessionID,
              agent: "build",
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
      description: "创建当前主 session 的 plan.json；后续阶段只建立骨架，细节用 Plan.update 展开。",
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
    return {
      description: "在多智能体模式把 pending/rejected 任务派给子 session。",
      parameters: Schema.Struct({ taskIds: Schema.Array(Schema.String) }),
      jsonSchema: dispatchSchema,
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
          const protocol = protocolFor(sessions, bus, { bridge, promptOps: promptOps(ctx) })
          return jsonResult(
            "Dispatch.dispatch",
            yield* Effect.promise(() => protocol.dispatch(protocolContext(session, ctx), input.taskIds)),
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
      jsonSchema: dispatchSchema,
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
  ReportTool,
] as const

export const PLAN_TOOL_IDS = new Set<string>(PlanProtocolTools.map((tool) => tool.id))

export * as PlanTools from "./tools"
