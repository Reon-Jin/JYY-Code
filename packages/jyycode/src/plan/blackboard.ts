import fs from "node:fs"
import path from "node:path"
import { and, asc, desc, eq, gt, inArray, isNull, lt, not, or, type SQL } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { SessionTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import { Database } from "@/storage/db"
import { readPlanFileSync, type PlanFile, type PlanStep } from "./schema"
import {
  BlackboardMessageTable,
  BlackboardMessageTaskTable,
  BlackboardReadCursorTable,
  type BlackboardAttachment,
} from "./blackboard.sql"

export type BlackboardKind = "info" | "risk" | "blocker" | "decision" | "help"
export type BlackboardAuthorKind = "user" | "main_agent" | "sub_agent"
export type BlackboardPurpose = "general" | "candidate_declaration"

export const Event = {
  Updated: BusEvent.define(
    "blackboard.updated",
    Schema.Struct({
      rootSessionID: SessionID,
      stepID: Schema.String,
      messageID: Schema.String,
    }),
  ),
}

export type Message = {
  id: string
  rootSessionID: SessionID
  stepID: string
  parentMessageID?: string
  authorKind: BlackboardAuthorKind
  authorSessionID?: SessionID
  authorTaskID?: string
  kind: BlackboardKind
  purpose: BlackboardPurpose
  body: string
  mentions: string[]
  attachments: BlackboardAttachment[]
  taskIDs: string[]
  timeCreated: number
  replies: Message[]
}

export type TaskSummary = {
  id: string
  title: string
  status: PlanStep["tasks"][number]["status"]
  hasAgent: boolean
  isSelf: boolean
}

export type Snapshot = {
  rootSessionID: SessionID
  currentStepID: string
  selectedStepID: string
  readonly: boolean
  tasks: TaskSummary[]
  messages: Message[]
  nextBefore?: string
  unreadCount: number
}

export type AgentReadResult = {
  rootSessionID: SessionID
  stepID: string
  tasks: TaskSummary[]
  messages: Message[]
  remaining: number
}

export type PostUserInput = {
  rootSessionID: SessionID
  message: string
  kind?: BlackboardKind
  taskIDs?: string[]
  replyTo?: string
  attachments?: string[]
}

export type PostAgentInput = Omit<PostUserInput, "rootSessionID"> & {
  sessionID: SessionID
}

export type CandidateDeclarationInput = {
  sessionID: SessionID
  approach: string
  assumptions: string[]
  risks: string[]
  differentiator: string
}

export type CandidateParticipant = {
  taskID: string
  sessionID: SessionID
}

export type CandidatePeerReplyCoverage = {
  taskID: string
  repliedTaskIDs: string[]
  missingTaskIDs: string[]
  complete: boolean
}

export type ListUserInput = {
  rootSessionID: SessionID
  stepID?: string
  taskID?: string
  before?: string
  limit?: number
}

export type MarkReadInput = {
  rootSessionID: SessionID
  stepID: string
  throughMessageID: string
}

export class BlackboardError extends Error {
  readonly code:
    | "SESSION_NOT_FOUND"
    | "PLAN_NOT_FOUND"
    | "NO_CURRENT_STEP"
    | "INVALID_STEP"
    | "INVALID_TASK"
    | "INVALID_REPLY"
    | "INVALID_ATTACHMENT"
    | "CHILD_NOT_IN_STEP"
    | "UNREAD_MESSAGES"

  constructor(code: BlackboardError["code"], message: string) {
    super(message)
    this.name = "BlackboardError"
    this.code = code
  }
}

export interface Interface {
  readonly postUser: (input: PostUserInput) => Effect.Effect<Message>
  readonly postAgent: (input: PostAgentInput) => Effect.Effect<Message>
  readonly postCandidateDeclaration: (input: CandidateDeclarationInput) => Effect.Effect<Message>
  readonly candidateDeclarations: (input: { rootSessionID: SessionID; stepID: string }) => Effect.Effect<Message[]>
  readonly candidatePeerReplyCoverage: (input: {
    rootSessionID: SessionID
    stepID: string
    taskID: string
  }) => Effect.Effect<CandidatePeerReplyCoverage>
  readonly candidateParticipants: (input: { rootSessionID: SessionID; stepID: string }) => Effect.Effect<CandidateParticipant[]>
  readonly listUser: (input: ListUserInput) => Effect.Effect<Snapshot>
  readonly readAgent: (sessionID: SessionID) => Effect.Effect<AgentReadResult>
  readonly markUserRead: (input: MarkReadInput) => Effect.Effect<void>
  readonly unreadForAgent: (sessionID: SessionID) => Effect.Effect<{ checked: boolean; count: number }>
  readonly unreadForMain: (rootSessionID: SessionID) => Effect.Effect<number>
  readonly assertReportReady: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Blackboard") {}

const db = Database.query

function getPlanPath(directory: string, rootSessionID: SessionID) {
  return path.join(directory, ".jyycode", "plan", rootSessionID, "plan.json")
}

function readPlan(directory: string, rootSessionID: SessionID): PlanFile {
  const plan = readPlanFileSync(getPlanPath(directory, rootSessionID))
  if (!plan) throw new BlackboardError("PLAN_NOT_FOUND", `找不到 session ${rootSessionID} 的 plan.json`)
  return plan
}

function currentStep(plan: PlanFile): PlanStep {
  if (!plan.current_step) throw new BlackboardError("NO_CURRENT_STEP", "当前没有可用的 Step")
  const step = plan.steps.find((item) => item.id === plan.current_step)
  if (!step) throw new BlackboardError("INVALID_STEP", `当前 Step ${plan.current_step} 不存在`)
  return step
}

function selectedStep(plan: PlanFile, stepID?: string): PlanStep {
  const id = stepID ?? plan.current_step
  if (!id) throw new BlackboardError("NO_CURRENT_STEP", "当前没有可用的 Step")
  const step = plan.steps.find((item) => item.id === id)
  if (!step) throw new BlackboardError("INVALID_STEP", `Step ${id} 不存在`)
  return step
}

function normalizeMessage(row: typeof BlackboardMessageTable.$inferSelect, taskIDs: string[], replies: Message[] = []) {
  return {
    id: row.id,
    rootSessionID: row.root_session_id as SessionID,
    stepID: row.step_id,
    ...(row.parent_message_id ? { parentMessageID: row.parent_message_id } : {}),
    authorKind: row.author_kind,
    ...(row.author_session_id ? { authorSessionID: row.author_session_id as SessionID } : {}),
    ...(row.author_task_id ? { authorTaskID: row.author_task_id } : {}),
    kind: row.kind,
    purpose: row.purpose ?? "general",
    body: row.body,
    mentions: row.mentions ?? [],
    attachments: row.attachments ?? [],
    taskIDs,
    timeCreated: row.time_created,
    replies,
  } satisfies Message
}

function unique<T>(values: readonly T[]) {
  return [...new Set(values)]
}

function parseMentions(body: string, step: PlanStep) {
  const taskIDs = new Set(step.tasks.map((task) => task.id))
  const mentions: string[] = []
  const mentionedTaskIDs: string[] = []
  const pattern = /(?:^|\s)@([A-Za-z0-9_-]+)/g
  for (const match of body.matchAll(pattern)) {
    const target = match[1]
    if (!target) continue
    if (target === "main") {
      if (!mentions.includes("main")) mentions.push("main")
      continue
    }
    if (taskIDs.has(target)) {
      if (!mentions.includes(target)) mentions.push(target)
      if (!mentionedTaskIDs.includes(target)) mentionedTaskIDs.push(target)
    }
  }
  return { mentions, mentionedTaskIDs }
}

function isWithin(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function normalizeAttachments(values: readonly string[] | undefined, workspaceRoot: string, allowUserLocalFile: boolean) {
  return (values ?? []).map((value) => {
    let url: URL | undefined
    try {
      url = new URL(value)
    } catch {
      // A workspace-relative or absolute path is handled below.
    }
    if (url?.protocol === "http:" || url?.protocol === "https:")
      return { type: "url" as const, value: url.toString() }
    if (url?.protocol === "file:") {
      if (!allowUserLocalFile) throw new BlackboardError("INVALID_ATTACHMENT", `Agent 不允许使用本地 file:// 附件：${value}`)
      return { type: "path" as const, value: url.toString() }
    }
    const resolved = path.resolve(workspaceRoot, value)
    if (!fs.existsSync(resolved)) throw new BlackboardError("INVALID_ATTACHMENT", `附件不存在：${value}`)
    if (!isWithin(workspaceRoot, resolved))
      throw new BlackboardError("INVALID_ATTACHMENT", `附件超出工作区：${value}`)
    return { type: fs.statSync(resolved).isDirectory() ? ("directory" as const) : ("path" as const), value: resolved }
  })
}

function makeService(bus: Bus.Interface): Interface {
  const session = Effect.fn("Blackboard.session")(function* (sessionID: SessionID) {
    const row = yield* db((database) => database.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())
    if (!row) throw new BlackboardError("SESSION_NOT_FOUND", `找不到 session ${sessionID}`)
    return row
  })

  const root = Effect.fn("Blackboard.root")(function* (sessionID: SessionID) {
    let current = yield* session(sessionID)
    while (current.parent_id) current = yield* session(current.parent_id)
    return current
  })

  const tasksFor = Effect.fn("Blackboard.tasksFor")(function* (_rootSessionID: SessionID, step: PlanStep, selfTaskID?: string) {
    const dispatches = step.tasks
      .filter((task) => task.dispatch?.child_session_id)
      .map((task) => [task.id, task.dispatch!.child_session_id] as const)
    const childIDs = dispatches.map(([, childID]) => childID)
    const archived = childIDs.length
      ? yield* db((database) =>
          database
            .select({ id: SessionTable.id, time_archived: SessionTable.time_archived })
            .from(SessionTable)
            .where(inArray(SessionTable.id, childIDs as SessionID[]))
            .all(),
        )
      : []
    const archivedIDs = new Set(archived.filter((item) => item.time_archived !== null).map((item) => item.id))
    return step.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      hasAgent: !!task.dispatch?.child_session_id && !archivedIDs.has(task.dispatch.child_session_id as SessionID),
      isSelf: task.id === selfTaskID,
    }))
  })

  const listMessages = Effect.fn("Blackboard.listMessages")(function* (input: {
    rootSessionID: SessionID
    stepID: string
    taskID?: string
    before?: string
    limit: number
  }) {
    const taskMatch = input.taskID
      ? yield* db((database) =>
          database
            .select({ messageID: BlackboardMessageTaskTable.message_id })
            .from(BlackboardMessageTaskTable)
            .innerJoin(
              BlackboardMessageTable,
              and(
                eq(BlackboardMessageTaskTable.message_id, BlackboardMessageTable.id),
                eq(BlackboardMessageTable.root_session_id, input.rootSessionID),
                eq(BlackboardMessageTable.step_id, input.stepID),
              ),
            )
            .where(eq(BlackboardMessageTaskTable.task_id, input.taskID!))
            .all(),
        )
      : []
    const taskMessageIDs = taskMatch.map((item) => item.messageID)
    const conditions = [
      eq(BlackboardMessageTable.root_session_id, input.rootSessionID),
      eq(BlackboardMessageTable.step_id, input.stepID),
      input.before ? lt(BlackboardMessageTable.id, input.before) : undefined,
      input.taskID ? (taskMessageIDs.length ? inArray(BlackboardMessageTable.id, taskMessageIDs) : eq(BlackboardMessageTable.id, "")) : undefined,
      isNull(BlackboardMessageTable.parent_message_id),
    ].filter(Boolean) as SQL<unknown>[]
    const rows = yield* db((database) =>
      database
        .select()
        .from(BlackboardMessageTable)
        .where(and(...(conditions as any)))
        .orderBy(desc(BlackboardMessageTable.id))
        .limit(input.limit + 1)
        .all(),
    )
    const page = rows.slice(0, input.limit).reverse()
    const ids = page.map((row) => row.id)
    const topLevelAndReplyIDs = rows.length
      ? rows.map((row) => row.id)
      : ids
    const links = topLevelAndReplyIDs.length
      ? yield* db((database) =>
          database
            .select()
            .from(BlackboardMessageTaskTable)
            .where(inArray(BlackboardMessageTaskTable.message_id, topLevelAndReplyIDs))
            .all(),
        )
      : []
    const taskIDs = new Map<string, string[]>()
    for (const link of links) taskIDs.set(link.message_id, [...(taskIDs.get(link.message_id) ?? []), link.task_id])
    const replyRows = ids.length
      ? yield* db((database) =>
          database
            .select()
            .from(BlackboardMessageTable)
            .where(and(inArray(BlackboardMessageTable.parent_message_id, ids), eq(BlackboardMessageTable.step_id, input.stepID)))
            .orderBy(asc(BlackboardMessageTable.id))
            .all(),
        )
      : []
    const repliesByParent = new Map<string, Message[]>()
    for (const reply of replyRows) {
      const replyTasks = links
        .filter((link) => link.message_id === reply.id)
        .map((link) => link.task_id)
      const normalized = normalizeMessage(reply, replyTasks)
      const parent = reply.parent_message_id!
      repliesByParent.set(parent, [...(repliesByParent.get(parent) ?? []), normalized])
    }
    return {
      messages: page.map((row) => normalizeMessage(row, taskIDs.get(row.id) ?? [], repliesByParent.get(row.id) ?? [])),
      hasMore: rows.length > input.limit,
    }
  })

  const post = Effect.fn("Blackboard.post")(function* (input: {
    rootSessionID: SessionID
    stepID: string
    workspaceRoot: string
    allowUserLocalFile: boolean
    authorKind: BlackboardAuthorKind
    authorSessionID?: SessionID
    authorTaskID?: string
    message: string
    kind?: BlackboardKind
    purpose?: BlackboardPurpose
    taskIDs?: string[]
    replyTo?: string
    attachments?: string[]
    mentions?: string[]
  }) {
    if (!input.message.trim()) throw new BlackboardError("INVALID_STEP", "黑板消息不能为空")
    const parent = input.replyTo
      ? yield* db((database) =>
          database.select().from(BlackboardMessageTable).where(eq(BlackboardMessageTable.id, input.replyTo!)).get(),
        )
      : undefined
    if (input.replyTo && (!parent || parent.parent_message_id || parent.root_session_id !== input.rootSessionID || parent.step_id !== input.stepID))
      throw new BlackboardError("INVALID_REPLY", "回复必须指向同一根 Session、同一 Step 的顶层消息")
    const parentTaskIDs = parent
      ? yield* db((database) =>
          database
            .select()
            .from(BlackboardMessageTaskTable)
            .where(eq(BlackboardMessageTaskTable.message_id, parent.id))
            .all(),
        )
      : []
    const finalTaskIDs = unique([
      ...(input.taskIDs ?? []),
      ...(input.authorTaskID ? [input.authorTaskID] : []),
      ...parentTaskIDs.map((item) => item.task_id),
      ...(input.mentions ?? []).filter((mention) => mention !== "main"),
    ])
    const normalizedAttachments = normalizeAttachments(input.attachments, input.workspaceRoot, input.allowUserLocalFile)
    const id = Identifier.create("bbm", "ascending")
    const row = {
      id,
      root_session_id: input.rootSessionID,
      step_id: input.stepID,
      parent_message_id: input.replyTo ?? null,
      author_kind: input.authorKind,
      author_session_id: input.authorSessionID ?? null,
      author_task_id: input.authorTaskID ?? null,
      kind: input.kind ?? "info",
      purpose: input.purpose ?? "general",
      body: input.message,
      mentions: unique(input.mentions ?? []),
      attachments: normalizedAttachments,
    }
    yield* Database.withTransaction((database) =>
      Effect.gen(function* () {
        yield* database.insert(BlackboardMessageTable).values(row).run()
        if (finalTaskIDs.length)
          yield* database
            .insert(BlackboardMessageTaskTable)
            .values(finalTaskIDs.map((taskID) => ({ message_id: id, task_id: taskID })))
            .run()
      }),
    )
    yield* bus.publish(Event.Updated, { rootSessionID: input.rootSessionID, stepID: input.stepID, messageID: id })
    const persisted = yield* db((database) =>
      database.select().from(BlackboardMessageTable).where(eq(BlackboardMessageTable.id, id)).get(),
    )
    if (!persisted) throw new BlackboardError("SESSION_NOT_FOUND", "黑板消息写入后无法读取")
    return normalizeMessage(persisted, finalTaskIDs)
  })

  const postUser = Effect.fn("Blackboard.postUser")(function* (input: PostUserInput) {
    const rootSession = yield* session(input.rootSessionID)
    if (rootSession.parent_id) throw new BlackboardError("SESSION_NOT_FOUND", "必须使用根 session 访问黑板")
    const plan = readPlan(rootSession.directory, input.rootSessionID)
    const step = currentStep(plan)
    const { mentions, mentionedTaskIDs } = parseMentions(input.message, step)
    const taskIDs = unique([...(input.taskIDs ?? []), ...mentionedTaskIDs])
    for (const taskID of taskIDs)
      if (!step.tasks.some((task) => task.id === taskID)) throw new BlackboardError("INVALID_TASK", `Task ${taskID} 不属于当前 Step`)
    return yield* post({
      ...input,
      rootSessionID: input.rootSessionID,
      stepID: step.id,
      workspaceRoot: rootSession.directory,
      allowUserLocalFile: true,
      taskIDs,
      mentions,
      authorKind: "user",
    })
  })

  const postAgent = Effect.fn("Blackboard.postAgent")(function* (input: PostAgentInput) {
    const rootSession = yield* root(input.sessionID)
    const plan = readPlan(rootSession.directory, rootSession.id as SessionID)
    const step = currentStep(plan)
    const selfTask =
      input.sessionID === rootSession.id
        ? undefined
        : step.tasks.find((task) => task.dispatch?.child_session_id === input.sessionID)
    if (input.sessionID !== rootSession.id && !selfTask)
      throw new BlackboardError("CHILD_NOT_IN_STEP", `子 session ${input.sessionID} 不属于当前 Step`)
    if (selfTask?.mode === "candidate") {
      const phase = step.candidate_discussion?.phase
      if (phase === "declaring" || phase === "running")
        throw new BlackboardError("INVALID_STEP", "candidate children cannot use Blackboard in this phase")
      if (phase === "cross_review") {
        if (!input.replyTo) throw new BlackboardError("INVALID_REPLY", "candidate cross-review messages must reply to a declaration")
        const parent = yield* db((database) =>
          database.select().from(BlackboardMessageTable).where(eq(BlackboardMessageTable.id, input.replyTo!)).get(),
        )
        if (!parent || parent.parent_message_id || parent.purpose !== "candidate_declaration" || parent.author_task_id === selfTask.id)
          throw new BlackboardError("INVALID_REPLY", "candidate replies must target another candidate's top-level declaration")
      }
    }
    const { mentions, mentionedTaskIDs } = parseMentions(input.message, step)
    const taskIDs = unique([...(input.taskIDs ?? []), ...mentionedTaskIDs])
    for (const taskID of taskIDs)
      if (!step.tasks.some((task) => task.id === taskID)) throw new BlackboardError("INVALID_TASK", `Task ${taskID} 不属于当前 Step`)
    return yield* post({
      ...input,
      rootSessionID: rootSession.id as SessionID,
      stepID: step.id,
      workspaceRoot: rootSession.directory,
      allowUserLocalFile: false,
      taskIDs,
      mentions,
      authorTaskID: selfTask?.id,
      authorKind: input.sessionID === rootSession.id ? "main_agent" : "sub_agent",
      authorSessionID: input.sessionID,
    })
  })

  const candidateParticipants = Effect.fn("Blackboard.candidateParticipants")(function* (input: {
    rootSessionID: SessionID
    stepID: string
  }) {
    const rootSession = yield* root(input.rootSessionID)
    if (rootSession.id !== input.rootSessionID) throw new BlackboardError("SESSION_NOT_FOUND", "candidate root session mismatch")
    const plan = readPlan(rootSession.directory, rootSession.id as SessionID)
    const step = selectedStep(plan, input.stepID)
    if (!step.tasks.some((task) => task.mode === "candidate")) return []
    return step.tasks.flatMap((task) =>
      task.mode === "candidate" && task.dispatch?.child_session_id
        ? [{ taskID: task.id, sessionID: task.dispatch.child_session_id as SessionID }]
        : [],
    )
  })

  const candidateDeclarations = Effect.fn("Blackboard.candidateDeclarations")(function* (input: {
    rootSessionID: SessionID
    stepID: string
  }) {
    const participants = yield* candidateParticipants(input)
    const taskIDs = participants.map((item) => item.taskID)
    if (!taskIDs.length) return []
    const rows = yield* db((database) =>
      database
        .select()
        .from(BlackboardMessageTable)
        .where(
          and(
            eq(BlackboardMessageTable.root_session_id, input.rootSessionID),
            eq(BlackboardMessageTable.step_id, input.stepID),
            eq(BlackboardMessageTable.purpose, "candidate_declaration"),
            isNull(BlackboardMessageTable.parent_message_id),
            eq(BlackboardMessageTable.author_kind, "sub_agent"),
            inArray(BlackboardMessageTable.author_task_id, taskIDs),
          ),
        )
        .orderBy(asc(BlackboardMessageTable.id))
        .all(),
    )
    const participantByTask = new Map(participants.map((item) => [item.taskID, item.sessionID]))
    return rows
      .filter((row) => row.author_task_id && participantByTask.get(row.author_task_id) === row.author_session_id)
      .map((row) => normalizeMessage(row, row.author_task_id ? [row.author_task_id] : []))
  })

  const candidatePeerReplyCoverage = Effect.fn("Blackboard.candidatePeerReplyCoverage")(function* (input: {
    rootSessionID: SessionID
    stepID: string
    taskID: string
  }) {
    const participants = yield* candidateParticipants({ rootSessionID: input.rootSessionID, stepID: input.stepID })
    const self = participants.find((item) => item.taskID === input.taskID)
    if (!self) throw new BlackboardError("INVALID_TASK", `candidate task ${input.taskID} is not in this step`)
    const declarations = yield* candidateDeclarations({ rootSessionID: input.rootSessionID, stepID: input.stepID })
    const peerDeclarations = declarations.filter((message) => message.authorTaskID && message.authorTaskID !== input.taskID)
    const declarationIDs = peerDeclarations.map((message) => message.id)
    if (!declarationIDs.length)
      return { taskID: input.taskID, repliedTaskIDs: [], missingTaskIDs: [], complete: true }
    const replies = yield* db((database) =>
      database
        .select()
        .from(BlackboardMessageTable)
        .where(
          and(
            eq(BlackboardMessageTable.root_session_id, input.rootSessionID),
            eq(BlackboardMessageTable.step_id, input.stepID),
            inArray(BlackboardMessageTable.parent_message_id, declarationIDs),
            eq(BlackboardMessageTable.author_kind, "sub_agent"),
            eq(BlackboardMessageTable.author_session_id, self.sessionID),
            eq(BlackboardMessageTable.author_task_id, input.taskID),
          ),
        )
        .all(),
    )
    const declarationTaskByID = new Map(peerDeclarations.map((message) => [message.id, message.authorTaskID!]))
    const repliedTaskIDs = unique(
      replies.flatMap((reply) => {
        const peerTaskID = reply.parent_message_id ? declarationTaskByID.get(reply.parent_message_id) : undefined
        return peerTaskID ? [peerTaskID] : []
      }),
    )
    const missingTaskIDs = peerDeclarations
      .map((message) => message.authorTaskID!)
      .filter((peerTaskID) => !repliedTaskIDs.includes(peerTaskID))
    return { taskID: input.taskID, repliedTaskIDs, missingTaskIDs, complete: missingTaskIDs.length === 0 }
  })

  const postCandidateDeclaration = Effect.fn("Blackboard.postCandidateDeclaration")(function* (input: CandidateDeclarationInput) {
    const rootSession = yield* root(input.sessionID)
    const plan = readPlan(rootSession.directory, rootSession.id as SessionID)
    const step = currentStep(plan)
    const selfTask = step.tasks.find((task) => task.mode === "candidate" && task.dispatch?.child_session_id === input.sessionID)
    if (!selfTask) throw new BlackboardError("CHILD_NOT_IN_STEP", "only a dispatched candidate child may declare")
    if (step.candidate_discussion && step.candidate_discussion.phase !== "declaring")
      throw new BlackboardError("INVALID_STEP", "candidate declarations are closed")
    const values = [input.approach, input.differentiator, ...input.assumptions, ...input.risks]
    if (values.some((value) => typeof value !== "string" || !value.trim()))
      throw new BlackboardError("INVALID_STEP", "candidate declaration fields must be non-empty")
    return yield* post({
      rootSessionID: rootSession.id as SessionID,
      stepID: step.id,
      workspaceRoot: rootSession.directory,
      allowUserLocalFile: false,
      authorKind: "sub_agent",
      authorSessionID: input.sessionID,
      authorTaskID: selfTask.id,
      message: JSON.stringify({
        approach: input.approach,
        assumptions: input.assumptions,
        risks: input.risks,
        differentiator: input.differentiator,
      }),
      purpose: "candidate_declaration",
      taskIDs: [selfTask.id],
    })
  })

  const unreadForUser = Effect.fn("Blackboard.unreadForUser")(function* (rootSessionID: SessionID, stepID: string) {
    const cursor = yield* db((database) =>
      database
        .select()
        .from(BlackboardReadCursorTable)
        .where(
          and(
            eq(BlackboardReadCursorTable.root_session_id, rootSessionID),
            eq(BlackboardReadCursorTable.step_id, stepID),
            eq(BlackboardReadCursorTable.participant_key, "user"),
          ),
        )
        .get(),
    )
    const rows = yield* db((database) =>
      database
        .select({ id: BlackboardMessageTable.id })
        .from(BlackboardMessageTable)
        .where(
          and(
            eq(BlackboardMessageTable.root_session_id, rootSessionID),
            eq(BlackboardMessageTable.step_id, stepID),
            cursor?.last_message_id ? gt(BlackboardMessageTable.id, cursor.last_message_id) : undefined,
            not(eq(BlackboardMessageTable.author_kind, "user")),
          ),
        )
        .all(),
    )
    return rows.length
  })

  const listUser = Effect.fn("Blackboard.listUser")(function* (input: ListUserInput) {
    const rootSession = yield* session(input.rootSessionID)
    const plan = readPlan(rootSession.directory, input.rootSessionID)
    const step = selectedStep(plan, input.stepID)
    const current = currentStep(plan)
    const page = yield* listMessages({
      rootSessionID: input.rootSessionID,
      stepID: step.id,
      taskID: input.taskID,
      before: input.before,
      limit: Math.min(Math.max(input.limit ?? 50, 1), 100),
    })
    return {
      rootSessionID: input.rootSessionID,
      currentStepID: current.id,
      selectedStepID: step.id,
      readonly: step.id !== current.id,
      tasks: yield* tasksFor(input.rootSessionID, step),
      messages: page.messages,
      ...(page.hasMore && page.messages.length ? { nextBefore: page.messages[0]!.id } : {}),
      unreadCount: yield* unreadForUser(input.rootSessionID, current.id),
    }
  })

  const readAgent = Effect.fn("Blackboard.readAgent")(function* (sessionID: SessionID) {
    const rootSession = yield* root(sessionID)
    const plan = readPlan(rootSession.directory, rootSession.id as SessionID)
    const step = currentStep(plan)
    const selfTask = step.tasks.find((task) => task.mode === "candidate" && task.dispatch?.child_session_id === sessionID)
    if (selfTask && (step.candidate_discussion?.phase === "declaring" || step.candidate_discussion?.phase === "running"))
      throw new BlackboardError("INVALID_STEP", "candidate children cannot use Blackboard in this phase")
    const participantKey = sessionID === rootSession.id ? `main:${rootSession.id}` : `agent:${sessionID}`
    const cursor = yield* db((database) =>
      database
        .select()
        .from(BlackboardReadCursorTable)
        .where(
          and(
            eq(BlackboardReadCursorTable.root_session_id, rootSession.id),
            eq(BlackboardReadCursorTable.step_id, step.id),
            eq(BlackboardReadCursorTable.participant_key, participantKey),
          ),
        )
        .get(),
    )
    const rows = yield* db((database) =>
      database
        .select()
        .from(BlackboardMessageTable)
        .where(
          and(
            eq(BlackboardMessageTable.root_session_id, rootSession.id),
            eq(BlackboardMessageTable.step_id, step.id),
            cursor?.last_message_id ? gt(BlackboardMessageTable.id, cursor.last_message_id) : undefined,
            sessionID === rootSession.id
              ? not(eq(BlackboardMessageTable.author_kind, "main_agent"))
              : or(
                  eq(BlackboardMessageTable.author_kind, "user"),
                  eq(BlackboardMessageTable.author_kind, "main_agent"),
                  and(
                    eq(BlackboardMessageTable.author_kind, "sub_agent"),
                    not(eq(BlackboardMessageTable.author_session_id, sessionID)),
                  ),
                ),
          ),
        )
        .orderBy(asc(BlackboardMessageTable.id))
        .limit(51)
        .all(),
    )
    const ids = rows.map((row) => row.id)
    const links = ids.length
      ? yield* db((database) =>
          database
            .select()
            .from(BlackboardMessageTaskTable)
            .where(inArray(BlackboardMessageTaskTable.message_id, ids))
            .all(),
        )
      : []
    const messageTaskIDs = new Map<string, string[]>()
    for (const link of links) messageTaskIDs.set(link.message_id, [...(messageTaskIDs.get(link.message_id) ?? []), link.task_id])
    const messages = rows.slice(0, 50).map((row) => normalizeMessage(row, messageTaskIDs.get(row.id) ?? []))
    const last = messages.at(-1)
    yield* Database.withTransaction((database) =>
      database
        .insert(BlackboardReadCursorTable)
        .values({
          root_session_id: rootSession.id,
          step_id: step.id,
          participant_key: participantKey,
          last_message_id: last?.id ?? cursor?.last_message_id ?? null,
          checked_at: Date.now(),
        })
        .onConflictDoUpdate({
          target: [
            BlackboardReadCursorTable.root_session_id,
            BlackboardReadCursorTable.step_id,
            BlackboardReadCursorTable.participant_key,
          ],
          set: { last_message_id: last?.id ?? cursor?.last_message_id ?? null, checked_at: Date.now() },
        })
        .run(),
    )
    return {
      rootSessionID: rootSession.id as SessionID,
      stepID: step.id,
      tasks: yield* tasksFor(
        rootSession.id as SessionID,
        step,
        step.tasks.find((task) => task.dispatch?.child_session_id === sessionID)?.id,
      ),
      messages,
      remaining: Math.max(0, rows.length - messages.length),
    }
  })

  const markUserRead = Effect.fn("Blackboard.markUserRead")(function* (input: MarkReadInput) {
    yield* Database.withTransaction((database) =>
      database
        .insert(BlackboardReadCursorTable)
        .values({
          root_session_id: input.rootSessionID,
          step_id: input.stepID,
          participant_key: "user",
          last_message_id: input.throughMessageID,
          checked_at: Date.now(),
        })
        .onConflictDoUpdate({
          target: [
            BlackboardReadCursorTable.root_session_id,
            BlackboardReadCursorTable.step_id,
            BlackboardReadCursorTable.participant_key,
          ],
          set: { last_message_id: input.throughMessageID, checked_at: Date.now() },
        })
        .run(),
    )
  })

  const unreadForAgent = Effect.fn("Blackboard.unreadForAgent")(function* (sessionID: SessionID) {
    const rootSession = yield* root(sessionID)
    const plan = readPlan(rootSession.directory, rootSession.id as SessionID)
    const step = currentStep(plan)
    const participantKey = sessionID === rootSession.id ? `main:${rootSession.id}` : `agent:${sessionID}`
    const cursor = yield* db((database) =>
      database
        .select()
        .from(BlackboardReadCursorTable)
        .where(
          and(
            eq(BlackboardReadCursorTable.root_session_id, rootSession.id),
            eq(BlackboardReadCursorTable.step_id, step.id),
            eq(BlackboardReadCursorTable.participant_key, participantKey),
          ),
        )
        .get(),
    )
    const count = yield* db((database) =>
      database
        .select({ id: BlackboardMessageTable.id })
        .from(BlackboardMessageTable)
        .where(
          and(
            eq(BlackboardMessageTable.root_session_id, rootSession.id),
            eq(BlackboardMessageTable.step_id, step.id),
            cursor?.last_message_id ? gt(BlackboardMessageTable.id, cursor.last_message_id) : undefined,
            sessionID === rootSession.id
              ? not(eq(BlackboardMessageTable.author_kind, "main_agent"))
              : or(
                  eq(BlackboardMessageTable.author_kind, "user"),
                  eq(BlackboardMessageTable.author_kind, "main_agent"),
                  and(
                    eq(BlackboardMessageTable.author_kind, "sub_agent"),
                    not(eq(BlackboardMessageTable.author_session_id, sessionID)),
                  ),
                ),
          ),
        )
        .all(),
    )
    return { checked: !!cursor, count: count.length }
  })

  const unreadForMain = Effect.fn("Blackboard.unreadForMain")(function* (rootSessionID: SessionID) {
    return (yield* unreadForAgent(rootSessionID)).count
  })

  const assertReportReady = Effect.fn("Blackboard.assertReportReady")(function* (sessionID: SessionID) {
    const rootSession = yield* root(sessionID)
    if (sessionID === rootSession.id) return
    const unread = yield* unreadForAgent(sessionID)
    if (!unread.checked || unread.count > 0)
      throw new BlackboardError("UNREAD_MESSAGES", "提交 Report 前必须先无参读取 Blackboard 并处理全部新消息")
  })

  return {
    postUser,
    postAgent,
    postCandidateDeclaration,
    candidateDeclarations,
    candidatePeerReplyCoverage,
    candidateParticipants,
    listUser,
    readAgent,
    markUserRead,
    unreadForAgent,
    unreadForMain,
    assertReportReady,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of(makeService(yield* Bus.Service))
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Blackboard from "./blackboard"
