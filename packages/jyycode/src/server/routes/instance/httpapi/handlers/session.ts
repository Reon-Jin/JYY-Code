import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Provider } from "@/provider/provider"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { estimateContextTokens } from "@/session/context-estimate"
import { MessageV2 } from "@/session/message-v2"
import { getPredictiveCompactThreshold } from "@/session/overflow"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { InstanceStore } from "@/project/instance-store"
import { EffectBridge } from "@/effect/bridge"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import {
  childTerminationRequest,
  clearChildRunIntent,
  markChildRunIntent,
  peekChildRunIntent,
  PlanProtocol,
} from "@/plan/protocol"
import { terminateChild } from "@/plan/child-termination"
import { Blackboard } from "@/plan/blackboard"
import { defaultPlanEvents, defaultPlanInbox } from "@/plan/events"
import { RuntimeEvent } from "@/plan/runtime-event"
import { planFilePath, readPlanFileSync } from "@/plan/schema"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { NamedError } from "@jyycode-ai/core/util/error"
import { Cause, Effect, Exit, Option, Schema, Scope } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  ContextPayload,
  CreatePayload,
  BlackboardPostPayload,
  BlackboardQuery,
  BlackboardReadPayload,
  DiffQuery,
  ForkPayload,
  InitPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PromptPayload,
  RevertPayload,
  ShellPayload,
  SummarizePayload,
  UpdatePayload,
} from "../groups/session"
import { PermissionNotFoundError } from "../errors"
import * as SessionError from "./session-errors"

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

type ChildTaskRef = {
  parentSessionId: string
  childSessionId: string
  taskId: string
  runId: string
  workspaceRoot: string
}

/**
 * Locate the in-flight plan task that owns this child session. Only tasks
 * still expecting work from the child (dispatched/running, not cancelled)
 * qualify; anything else means the run is already accounted for.
 */
function activePlanTaskForChild(child: Session.Info): ChildTaskRef | undefined {
  if (!child.parentID) return undefined
  const plan = readPlanFileSync(planFilePath(child.directory, child.parentID))
  if (!plan) return undefined
  for (const step of plan.steps) {
    for (const task of step.tasks) {
      const dispatch = task.dispatch
      if (!dispatch || dispatch.child_session_id !== child.id || dispatch.cancelled_at !== null) continue
      if (task.status !== "running" && task.status !== "dispatched") continue
      return {
        parentSessionId: child.parentID,
        childSessionId: child.id,
        taskId: task.id,
        runId: dispatch.run_id,
        workspaceRoot: child.directory,
      }
    }
  }
  return undefined
}

function workspaceForChild(ref: ChildTaskRef) {
  const plan = readPlanFileSync(planFilePath(ref.workspaceRoot, ref.parentSessionId))
  return plan?.steps.flatMap((step) => step.tasks).find((task) => task.id === ref.taskId)?.dispatch?.workspace
}

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const shareSvc = yield* SessionShare.Service
    const promptSvc = yield* SessionPrompt.Service
    const revertSvc = yield* SessionRevert.Service
    const compactSvc = yield* SessionCompaction.Service
    const runState = yield* SessionRunState.Service
    const agentSvc = yield* Agent.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const instanceStore = yield* InstanceStore.Service
    const bridge = yield* EffectBridge.make()
    const todoSvc = yield* Todo.Service
    const summary = yield* SessionSummary.Service
    const blackboard = yield* Blackboard.Service
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      return yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : ctx.query.directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        archived: ctx.query.archived,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
      })
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      return Object.fromEntries(yield* statusSvc.list())
    })

    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      return yield* SessionError.mapStorageNotFound(session.get(sessionID))
    })

    const rootSession = Effect.fn("SessionHttpApi.rootSession")(function* (sessionID: SessionID) {
      let current = yield* requireSession(sessionID)
      while (current.parentID) current = yield* requireSession(current.parentID)
      return current
    })

    // Push a plan.updated event onto the bus so desktop clients refetch the
    // plan snapshot after handler-side plan mutations. Protocol writes done
    // through PlanProtocol only reach the in-process event hub.
    const publishPlanRefresh = (ref: ChildTaskRef) =>
      Effect.gen(function* () {
        const event = defaultPlanEvents.publish({
          type: "plan.updated",
          session_id: ref.parentSessionId,
          revision: readPlanFileSync(planFilePath(ref.workspaceRoot, ref.parentSessionId))?.revision,
          payload: new PlanProtocol().snapshot({
            workspaceRoot: ref.workspaceRoot,
            sessionId: ref.parentSessionId,
            mode: "multi",
          }),
        })
        yield* bus.publish(RuntimeEvent, event).pipe(Effect.ignore)
      })

    // Add an Inbox entry for the parent session and wake it so the main agent
    // processes the event; mirrors the dispatch watcher's settle notification.
    const notifyParent = (input: {
      ref: ChildTaskRef
      kind: "user_interrupt" | "user_terminated" | "runtime_error"
      message: string
      suggestedActions: string[]
      wakeKind: string
      wakeText: string
    }) =>
      Effect.gen(function* () {
        defaultPlanInbox.add({
          session_id: input.ref.parentSessionId,
          task_id: input.ref.taskId,
          run_id: input.ref.runId,
          kind: input.kind,
          message: input.message,
          suggested_actions: input.suggestedActions,
        })
        yield* publishPlanRefresh(input.ref)
        yield* promptSvc
          .wake({
            sessionID: input.ref.parentSessionId as SessionID,
            kind: input.wakeKind,
            text: input.wakeText,
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

    const settleChildTask = (ref: ChildTaskRef) =>
      Effect.promise(() =>
        new PlanProtocol().settleChildExit({
          workspaceRoot: ref.workspaceRoot,
          parentSessionId: ref.parentSessionId,
          childSessionId: ref.childSessionId,
          taskId: ref.taskId,
          runId: ref.runId,
        }),
      ).pipe(Effect.orElseSucceed(() => ({ settled: false, reason: "settle_failed" }) as const))

    // Runs when a steered (user-interrupted) child turn ends. The dispatch
    // watcher skipped this run via the steer intent, so without this watcher a
    // steered child that stops without Report would strand its task. A newer
    // steer/terminate intent means a newer owner handles the run instead.
    const settleSteeredTurn = (ref: ChildTaskRef, seq: number) =>
      Effect.gen(function* () {
        const pending = peekChildRunIntent(ref.childSessionId)
        if (pending && pending.seq > seq) return
        if (pending) clearChildRunIntent(ref.childSessionId, pending.seq)
        const outcome = yield* settleChildTask(ref)
        if (!outcome.settled) return
        yield* notifyParent({
          ref,
          kind: "runtime_error",
          message: `子 Agent 未提交 Report 即停止运行：任务 ${ref.taskId} 已标记为需要修改，可修正后重新派发或取消。`,
          suggestedActions: ["读取 Inbox 查看错误", "取消任务并修正后重新派发"],
          wakeKind: "plan_child_runtime_error",
          wakeText: `子 Agent ${ref.childSessionId} 执行 ${ref.taskId} 时停止运行，任务状态已同步更新。先调用 Plan_read，再处理 Inbox。`,
        })
      })

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* session.children(ctx.params.sessionID)
    })

    const context = Effect.fn("SessionHttpApi.context")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      const messages = yield* MessageV2.filterCompactedEffect(ctx.params.sessionID)
      const estimate = estimateContextTokens({ messages })
      const result: typeof ContextPayload.Type = { ...estimate }
      const latestUser = messages.findLast(
        (message): message is MessageV2.WithParts & { info: MessageV2.User } => message.info.role === "user",
      )
      if (!latestUser) return result

      const model = yield* provider
        .getModel(latestUser.info.model.providerID, latestUser.info.model.modelID)
        .pipe(Effect.exit)
      if (Exit.isFailure(model)) return result

      const cfg = yield* config.get()
      const thresholdTokens = getPredictiveCompactThreshold({ cfg, model: model.value })
      return {
        ...result,
        thresholdTokens,
        shouldCompact:
          cfg.compaction?.auto !== false && model.value.limit.context !== 0 && estimate.totalTokens >= thresholdTokens,
      }
    })

    const plan = Effect.fn("SessionHttpApi.plan")(function* (ctx: { params: { sessionID: SessionID } }) {
      const root = yield* requireSession(ctx.params.sessionID)
      return new PlanProtocol().snapshot({
        workspaceRoot: root.directory,
        sessionId: root.id,
        mode: root.multiAgent === true ? "multi" : "single",
      })
    })

    const blackboardSnapshot = Effect.fn("SessionHttpApi.blackboardSnapshot")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof BlackboardQuery.Type
    }) {
      const root = yield* rootSession(ctx.params.sessionID)
      return yield* blackboard
        .listUser({
          rootSessionID: root.id,
          stepID: ctx.query.stepID,
          taskID: ctx.query.taskID,
          before: ctx.query.before,
          limit: ctx.query.limit,
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const blackboardPost = Effect.fn("SessionHttpApi.blackboardPost")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof BlackboardPostPayload.Type
    }) {
      const root = yield* rootSession(ctx.params.sessionID)
      const message = yield* blackboard
        .postUser({
          rootSessionID: root.id,
          message: ctx.payload.message,
          kind: ctx.payload.kind,
          taskIDs: ctx.payload.task_ids ? [...ctx.payload.task_ids] : undefined,
          replyTo: ctx.payload.reply_to,
          attachments: ctx.payload.attachments ? [...ctx.payload.attachments] : undefined,
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      for (const recipient of yield* blackboard.recipientsForMessage(message)) {
        if (recipient.role !== "sub_agent") continue
        yield* promptSvc
          .wake({
            sessionID: recipient.sessionID,
            kind: "blackboard_direct_message",
            text: "Blackboard 收到与你的 Task 有关的用户消息。请调用 Blackboard 阅读并处理，然后继续当前任务。",
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      }
      yield* promptSvc
        .wake({
          sessionID: root.id,
          kind: "blackboard_user_message",
          text: "黑板有新用户消息。先调用 Blackboard，处理后继续当前任务。",
        })
        .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      const planFile = readPlanFileSync(planFilePath(root.directory, root.id))
      const currentStep = planFile?.current_step
        ? planFile.steps.find((step) => step.id === planFile.current_step)
        : undefined
      const phase = currentStep?.candidate_discussion?.phase
      if (currentStep && phase && phase !== "running") {
        const candidates = yield* blackboard.candidateParticipants({ rootSessionID: root.id, stepID: currentStep.id })
        for (const candidate of candidates) {
          yield* promptSvc
            .wake({
              sessionID: candidate.sessionID,
              kind: "candidate_blackboard_user_message",
              text: "用户在候选预讨论阶段更新了 Blackboard；读取相关消息并按当前阶段继续。",
            })
            .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
        }
      }
      return message
    })

    const blackboardRead = Effect.fn("SessionHttpApi.blackboardRead")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof BlackboardReadPayload.Type
    }) {
      const root = yield* rootSession(ctx.params.sessionID)
      yield* blackboard
        .markUserRead({
          rootSessionID: root.id,
          stepID: ctx.payload.stepID,
          throughMessageID: ctx.payload.throughMessageID,
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return true
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.before) {
        const before = ctx.query.before
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      yield* requireSession(ctx.params.sessionID)
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      }

      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.page({
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit,
          before: ctx.query.before,
        }),
      )
      if (!page.cursor) return page.items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(page.items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      return yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
    })

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: typeof CreatePayload.Type }) {
      const payload = ctx.payload
        ? {
            ...ctx.payload,
            permission: ctx.payload.permission ? [...ctx.payload.permission] : undefined,
          }
        : undefined
      return yield* shareSvc.create(payload)
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* tryParseJson(body)
      const decoded = yield* Schema.decodeUnknownEffect(CreatePayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const payload = decoded
        ? {
            ...decoded,
            permission: decoded.permission ? [...decoded.permission] : undefined,
          }
        : decoded
      return yield* create({ payload })
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.remove(ctx.params.sessionID))
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      if (ctx.payload.title !== undefined) {
        yield* session.setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
      }
      if (ctx.payload.permission !== undefined) {
        yield* session.setPermission({
          sessionID: ctx.params.sessionID,
          permission: [...ctx.payload.permission],
        })
      }
      if (ctx.payload.multiAgent !== undefined) {
        yield* session.setMultiAgent({ sessionID: ctx.params.sessionID, enabled: ctx.payload.multiAgent })
      }
      if (ctx.payload.goal !== undefined) {
        yield* session.setGoal({ sessionID: ctx.params.sessionID, goal: ctx.payload.goal })
      }
      if (ctx.payload.time?.archived !== undefined) {
        yield* session.setArchived({ sessionID: ctx.params.sessionID, time: ctx.payload.time.archived })
      }
      return yield* requireSession(ctx.params.sessionID)
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload?: typeof ForkPayload.Type
    }) {
      return yield* SessionError.mapStorageNotFound(
        session.fork({ sessionID: ctx.params.sessionID, messageID: ctx.payload?.messageID }),
      )
    })

    const forkRaw = Effect.fn("SessionHttpApi.forkRaw")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* fork({ params: ctx.params })

      const json = yield* tryParseJson(body)
      const payload = yield* Schema.decodeUnknownEffect(ForkPayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* fork({ params: ctx.params, payload })
    })

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* promptSvc.cancel(ctx.params.sessionID)
      return true
    })

    const interruptPrompt = Effect.fn("SessionHttpApi.interruptPrompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      const child = yield* requireSession(ctx.params.sessionID)
      const ref = activePlanTaskForChild(child)
      // Mark the steer intent before cancelling so the dispatch watcher skips
      // its automatic "child exited" settle for this intentional interruption.
      const intent = ref ? markChildRunIntent(child.id, "steer") : undefined
      yield* promptSvc.cancel(child.id)
      if (ref) {
        yield* notifyParent({
          ref,
          kind: "user_interrupt",
          message: `用户打断了子 Agent 并发送了新指令：任务 ${ref.taskId} 正在按新指令继续执行。`,
          suggestedActions: ["读取 Inbox 查看详情", "必要时用 Dispatch_cancel 取消该任务"],
          wakeKind: "plan_child_user_interrupted",
          wakeText: `用户手动打断了子 Agent ${child.id}（任务 ${ref.taskId}）并发送了新指令。先调用 Plan_read，再处理 Inbox。`,
        })
      }
      yield* promptSvc.prompt({ ...ctx.payload, sessionID: child.id }).pipe(
        // The steered turn owns the task now; when it ends, park the task if
        // the child stopped without reporting (idempotent, run-scoped).
        Effect.ensuring(ref && intent ? settleSteeredTurn(ref, intent.seq) : Effect.void),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("interrupt_prompt failed").pipe(Effect.annotateLogs({ sessionID: child.id, cause }))
            yield* bus.publish(Session.Event.Error, {
              sessionID: child.id,
              error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
            })
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const terminate = Effect.fn("SessionHttpApi.terminate")(function* (ctx: { params: { sessionID: SessionID } }) {
      const child = yield* requireSession(ctx.params.sessionID)
      const ref = activePlanTaskForChild(child)
      let intentSeq: number | undefined
      const termination = yield* Effect.tryPromise({
        try: () =>
          terminateChild(
            {
              sessionId: child.id,
              request: ref ? childTerminationRequest(workspaceForChild(ref)) : undefined,
            },
            {
              markIntent: () => {
                intentSeq = markChildRunIntent(child.id, "terminate").seq
              },
              cancel: () => bridge.promise(promptSvc.cancel(child.id)),
              status: () => bridge.promise(statusSvc.get(child.id)),
              disposeDirectory: (directory) => bridge.promise(instanceStore.disposeDirectory(directory)),
              archive: () => bridge.promise(session.setArchived({ sessionID: child.id, time: Date.now() })),
            },
          ),
        catch: () => new HttpApiError.BadRequest({}),
      })
      if (termination.state === "stop_failed") {
        if (ref) {
          yield* notifyParent({
            ref,
            kind: "runtime_error",
            message: `Child termination failed during ${termination.phase}: ${termination.message}`,
            suggestedActions: ["read Inbox", "preserve the child workspace and retry termination"],
            wakeKind: "plan_child_termination_failed",
            wakeText: `Child ${child.id} could not be terminated safely. The workspace was preserved; inspect Inbox before retrying.`,
          })
        }
        if (intentSeq !== undefined) clearChildRunIntent(child.id, intentSeq)
        return HttpApiSchema.NoContent.make()
      }
      if (ref) {
        const outcome = yield* settleChildTask(ref)
        yield* notifyParent({
          ref,
          kind: "user_terminated",
          message: outcome.settled
            ? `用户手动终止了子 Agent：任务 ${ref.taskId} 已标记为需要修改，可修正后重新派发或取消。`
            : `用户手动终止了子 Agent：任务 ${ref.taskId} 的最新状态请通过 Plan_read 确认。`,
          suggestedActions: ["读取 Inbox 查看详情", "取消任务或修正后重新派发"],
          wakeKind: "plan_child_user_terminated",
          wakeText: `用户手动终止了子 Agent ${child.id}（任务 ${ref.taskId}），任务状态已同步更新。先调用 Plan_read，再处理 Inbox。`,
        })
        if (intentSeq !== undefined) clearChildRunIntent(child.id, intentSeq)
      }
      return HttpApiSchema.NoContent.make()
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* promptSvc
        .command({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload.messageID,
          model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
          command: Command.Default.INIT,
          arguments: "",
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return true
    })

    // share/unshare errors aren't all client-induced — storage and network
    // failures from SessionShare are real possibilities. Map to a typed 500
    // (matches the legacy route behavior which routed any failure through
    // ErrorMiddleware → NamedError.Unknown 500) instead of blanket-mapping
    // every failure to a 400 BadRequest.
    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc.share(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc
        .unshare(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      yield* revertSvc.cleanup(yield* requireSession(ctx.params.sessionID))
      const messages = yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      const defaultAgent = yield* agentSvc.defaultAgent()
      const currentAgent = messages.findLast((message) => message.info.role === "user")?.info.agent ?? defaultAgent

      yield* compactSvc.create({
        sessionID: ctx.params.sessionID,
        agent: currentAgent,
        model: {
          providerID: ctx.payload.providerID,
          modelID: ctx.payload.modelID,
        },
        auto: ctx.payload.auto ?? false,
      })
      yield* promptSvc.loop({ sessionID: ctx.params.sessionID })
      return true
    })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const message = yield* promptSvc
        .prompt({
          ...ctx.payload,
          sessionID: ctx.params.sessionID,
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return HttpServerResponse.stream(Stream.make(JSON.stringify(message)).pipe(Stream.encodeText), {
        contentType: "application/json",
      })
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* promptSvc.prompt({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("prompt_async failed").pipe(
              Effect.annotateLogs({ sessionID: ctx.params.sessionID, cause }),
            )
            yield* bus.publish(Session.Event.Error, {
              sessionID: ctx.params.sessionID,
              error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
            })
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* promptSvc
        .command({ ...ctx.payload, sessionID: ctx.params.sessionID })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID }))
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload }))
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.unrevert({ sessionID: ctx.params.sessionID }))
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      yield* session.removeMessage(ctx.params)
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* session.removePart(ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof MessageV2.Part.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as MessageV2.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      return yield* session.updatePart(payload)
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("context", context)
      .handle("plan", plan)
      .handle("blackboard", blackboardSnapshot)
      .handle("todo", todo)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handleRaw("fork", forkRaw)
      .handle("abort", abort)
      .handle("blackboardPost", blackboardPost)
      .handle("blackboardRead", blackboardRead)
      .handle("interruptPrompt", interruptPrompt)
      .handle("terminate", terminate)
      .handle("init", init)
      .handle("share", share)
      .handle("unshare", unshare)
      .handle("summarize", summarize)
      .handle("prompt", prompt)
      .handle("promptAsync", promptAsync)
      .handle("command", command)
      .handle("shell", shell)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
  }),
)
