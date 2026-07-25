import type {
  GlobalEvent,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionAgentClusterResponse,
  SessionStatus,
  Todo,
  VcsInfo,
} from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import type { DesktopClient } from "./sdk"
import {
  applyConversationEvents,
  emptyConversationSnapshot,
  isConversationSnapshot,
  type ConversationSnapshot,
} from "../features/conversation/conversation-state"
import { keys, normalizeDirectory } from "./query-keys"
import { publishDesktopNotificationEvent } from "../features/notifications/desktop-notifications"

export type ConnectionState = "connecting" | "connected" | "disconnected"

export type ConversationAction =
  | { kind: "message.upsert"; eventID: string; sessionID: string; info: Message }
  | { kind: "message.remove"; eventID: string; sessionID: string; messageID: string }
  | { kind: "part.upsert"; eventID: string; sessionID: string; part: Part }
  | {
      kind: "part.delta"
      eventID: string
      sessionID: string
      messageID: string
      partID: string
      field: string
      delta: string
    }
  | { kind: "part.remove"; eventID: string; sessionID: string; messageID: string; partID: string }

export type CacheAction =
  | { kind: "server.connected"; eventID: string }
  | { kind: "session.upsert"; eventID: string; info: Session }
  | { kind: "session.remove"; eventID: string; sessionID: string }
  | { kind: "status.set"; eventID: string; sessionID: string; status: SessionStatus }
  | { kind: "permission.upsert"; eventID: string; request: PermissionRequest }
  | { kind: "permission.remove"; eventID: string; requestID: string }
  | { kind: "question.upsert"; eventID: string; request: QuestionRequest }
  | { kind: "question.remove"; eventID: string; requestID: string }
  | { kind: "todos.set"; eventID: string; directory: string; sessionID: string; todos: Todo[] }
  | { kind: "vcs.invalidate"; eventID: string; directory: string }
  | { kind: "vcs.branch.set"; eventID: string; directory: string; branch?: string }
  | {
      kind: "agent-cluster.event"
      eventID: string
      directory: string
      sessionID: string
      event: Extract<GlobalEvent["payload"], { type: "agent_cluster.event" }>
    }
  | ConversationAction

function sameDirectory(left: string | undefined, right: string) {
  return typeof left === "string" && normalizeDirectory(left) === normalizeDirectory(right)
}

export function routeEvent(directory: string, event: GlobalEvent): CacheAction[] {
  const payload = event.payload
  if (payload.type === "server.connected") {
    return [{ kind: "server.connected", eventID: payload.id }]
  }
  if (!sameDirectory(event.directory, directory)) return []

  switch (payload.type) {
    case "session.created":
    case "session.updated":
      return [{ kind: "session.upsert", eventID: payload.id, info: payload.properties.info }]
    case "session.deleted":
      return [{ kind: "session.remove", eventID: payload.id, sessionID: payload.properties.sessionID }]
    case "session.status":
      return [
        {
          kind: "status.set",
          eventID: payload.id,
          sessionID: payload.properties.sessionID,
          status: payload.properties.status,
        },
      ]
    case "session.idle":
      return [
        {
          kind: "status.set",
          eventID: payload.id,
          sessionID: payload.properties.sessionID,
          status: { type: "idle" },
        },
      ]
    case "message.updated":
      return [
        {
          kind: "message.upsert",
          eventID: payload.id,
          sessionID: payload.properties.sessionID,
          info: payload.properties.info,
        },
      ]
    case "message.removed":
      return [
        {
          kind: "message.remove",
          eventID: payload.id,
          sessionID: payload.properties.sessionID,
          messageID: payload.properties.messageID,
        },
      ]
    case "message.part.updated":
      return [
        {
          kind: "part.upsert",
          eventID: payload.id,
          sessionID: payload.properties.sessionID,
          part: payload.properties.part,
        },
      ]
    case "message.part.delta":
      return [
        {
          kind: "part.delta",
          eventID: payload.id,
          sessionID: payload.properties.sessionID,
          messageID: payload.properties.messageID,
          partID: payload.properties.partID,
          field: payload.properties.field,
          delta: payload.properties.delta,
        },
      ]
    case "message.part.removed":
      return [
        {
          kind: "part.remove",
          eventID: payload.id,
          sessionID: payload.properties.sessionID,
          messageID: payload.properties.messageID,
          partID: payload.properties.partID,
        },
      ]
    case "permission.asked":
      return [{ kind: "permission.upsert", eventID: payload.id, request: payload.properties }]
    case "permission.replied":
      return [
        {
          kind: "permission.remove",
          eventID: payload.id,
          requestID: payload.properties.requestID,
        },
      ]
    case "question.asked":
      return [{ kind: "question.upsert", eventID: payload.id, request: payload.properties }]
    case "question.replied":
    case "question.rejected":
      return [
        {
          kind: "question.remove",
          eventID: payload.id,
          requestID: payload.properties.requestID,
        },
      ]
    case "todo.updated":
      return [
        {
          kind: "todos.set",
          eventID: payload.id,
          directory,
          sessionID: payload.properties.sessionID,
          todos: payload.properties.todos,
        },
      ]
    case "file.watcher.updated":
      return [{ kind: "vcs.invalidate", eventID: payload.id, directory }]
    case "vcs.branch.updated":
      return [
        { kind: "vcs.branch.set", eventID: payload.id, directory, branch: payload.properties.branch },
        { kind: "vcs.invalidate", eventID: payload.id, directory },
      ]
    case "agent_cluster.event":
      return [
        {
          kind: "agent-cluster.event",
          eventID: payload.id,
          directory,
          sessionID: payload.properties.sessionID,
          event: payload,
        },
      ]
    default:
      return []
  }
}

function upsertByID<T extends { id: string }>(items: readonly T[], value: T) {
  const index = items.findIndex((item) => item.id === value.id)
  if (index === -1) return [...items, value].sort((left, right) => left.id.localeCompare(right.id))
  const result = [...items]
  result[index] = value
  return result
}

export function retryDelay(attempt: number) {
  if (attempt <= 0) return 0
  if (attempt <= 4) return 1_000 * 2 ** (attempt - 1)
  return 30_000
}

type FrameScheduler = (callback: FrameRequestCallback) => number

export type EventBridgeOptions = {
  client: Pick<DesktopClient, "global">
  directory: string
  queryClient: QueryClient
  activeSessionID?: () => string | undefined
  onConnectionChange?: (state: ConnectionState) => void
  requestFrame?: FrameScheduler
  cancelFrame?: (handle: number) => void
}

const conversationKinds = new Set<CacheAction["kind"]>([
  "message.upsert",
  "message.remove",
  "part.upsert",
  "part.delta",
  "part.remove",
])

type AgentClusterAction = Extract<CacheAction, { kind: "agent-cluster.event" }>

const taskStatuses = new Set([
  "planned",
  "queued",
  "running",
  "submitted",
  "reviewing",
  "accepted",
  "revision_requested",
  "revising",
  "failed",
  "cancelled",
  "interrupted",
] as const)

type TaskStatus = SessionAgentClusterResponse["tasks"][number]["status"]

function isTaskStatus(status: AgentClusterAction["event"]["properties"]["status"]): status is TaskStatus {
  return status !== undefined && taskStatuses.has(status as TaskStatus)
}

function patchAgentClusterState(state: SessionAgentClusterResponse, actions: AgentClusterAction[]) {
  let tasks = state.tasks

  for (const action of actions) {
    const properties = action.event.properties
    if (!properties.taskID) continue
    const index = tasks.findIndex((task) => task.id === properties.taskID)
    if (index === -1) continue
    const current = tasks[index]!
    tasks = [...tasks]
    tasks[index] = {
      ...current,
      status: isTaskStatus(properties.status) ? properties.status : current.status,
      time_updated: properties.createdAt,
      last_event: properties.message,
    }
  }

  return tasks === state.tasks ? state : { tasks }
}

function isConversationAction(action: CacheAction): action is ConversationAction {
  return conversationKinds.has(action.kind)
}

function publishNotificationAction(action: CacheAction) {
  if (action.kind === "status.set") {
    const status = action.status.type
    if (status === "idle" || status === "retry" || status === "busy") {
      publishDesktopNotificationEvent({
        kind: "status",
        eventID: action.eventID,
        sessionID: action.sessionID,
        status: status === "busy" ? "running" : status,
      })
    }
    return
  }
  if (action.kind === "permission.upsert") {
    publishDesktopNotificationEvent({ kind: "permission", eventID: action.eventID })
  }
  if (action.kind === "question.upsert") {
    publishDesktopNotificationEvent({ kind: "question", eventID: action.eventID })
  }
}

function requestFrame(callback: FrameRequestCallback) {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback)
  return window.setTimeout(() => callback(performance.now()), 16)
}

function cancelFrame(handle: number) {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle)
  else window.clearTimeout(handle)
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }

    const finish = () => {
      window.clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = window.setTimeout(finish, milliseconds)
    signal.addEventListener("abort", finish, { once: true })
  })
}

export class EventBridge {
  readonly #options: EventBridgeOptions
  readonly #abort = new AbortController()
  readonly #queue: GlobalEvent[] = []
  readonly #seenEventIDs = new Set<string>()
  #frame: number | undefined
  #started = false
  #reconnectAttempt = 0
  #wasDisconnected = false

  constructor(options: EventBridgeOptions) {
    this.#options = options
  }

  start() {
    if (this.#started || this.#abort.signal.aborted) return
    this.#started = true
    this.#setConnection("connecting")
    void this.#run()
  }

  abort() {
    this.#abort.abort()
    if (this.#frame !== undefined) {
      ;(this.#options.cancelFrame ?? cancelFrame)(this.#frame)
      this.#frame = undefined
    }
    this.#queue.length = 0
  }

  async #run() {
    while (!this.#abort.signal.aborted) {
      try {
        const events = await this.#options.client.global.event({
          signal: this.#abort.signal,
          sseMaxRetryAttempts: 0,
        })
        for await (const event of events.stream) {
          if (this.#abort.signal.aborted) break
          this.#enqueue(event)
        }
      } catch {
        if (this.#abort.signal.aborted) break
      }

      await this.#flushNow()
      if (this.#abort.signal.aborted) break

      this.#wasDisconnected = true
      this.#setConnection("disconnected")
      this.#reconnectAttempt += 1
      await abortableDelay(retryDelay(this.#reconnectAttempt), this.#abort.signal)
    }
  }

  #enqueue(event: GlobalEvent) {
    const eventID = event.payload.id
    if (this.#seenEventIDs.has(eventID)) return
    this.#seenEventIDs.add(eventID)
    if (this.#seenEventIDs.size > 2_048) {
      const oldest = this.#seenEventIDs.values().next().value
      if (oldest !== undefined) this.#seenEventIDs.delete(oldest)
    }

    if (event.payload.type === "server.connected") this.#reconnectAttempt = 0
    this.#queue.push(event)
    if (this.#frame !== undefined) return
    this.#frame = (this.#options.requestFrame ?? requestFrame)(() => {
      this.#frame = undefined
      void this.#flush()
    })
  }

  async #flushNow() {
    if (this.#frame !== undefined) {
      ;(this.#options.cancelFrame ?? cancelFrame)(this.#frame)
      this.#frame = undefined
    }
    await this.#flush()
  }

  async #flush() {
    if (this.#queue.length === 0 || this.#abort.signal.aborted) return
    const events = this.#queue.splice(0)
    const conversations = new Map<string, GlobalEvent[]>()
    const agentClusters = new Map<string, AgentClusterAction[]>()
    const invalidatedVcs = new Set<string>()

    for (const event of events) {
      for (const action of routeEvent(this.#options.directory, event)) {
        publishNotificationAction(action)
        if (action.kind === "server.connected") {
          await this.#connected()
          continue
        }
        if (isConversationAction(action)) {
          const current = conversations.get(action.sessionID) ?? []
          current.push(event)
          conversations.set(action.sessionID, current)
          continue
        }
        if (action.kind === "agent-cluster.event") {
          const current = agentClusters.get(action.sessionID) ?? []
          current.push(action)
          agentClusters.set(action.sessionID, current)
          continue
        }
        if (action.kind === "vcs.invalidate") {
          const key = normalizeDirectory(action.directory)
          if (invalidatedVcs.has(key)) continue
          invalidatedVcs.add(key)
        }
        this.#apply(action)
      }
    }

    for (const [sessionID, conversationEvents] of conversations) {
      const queryKey = keys.messages(this.#options.directory, sessionID)
      let current = this.#options.queryClient.getQueryData<ConversationSnapshot>(queryKey)
      if (!isConversationSnapshot(current)) {
        void this.#options.queryClient.cancelQueries({ queryKey, exact: true })
        current = emptyConversationSnapshot(sessionID)
      }
      const patched = applyConversationEvents(current, conversationEvents)
      this.#options.queryClient.setQueryData(queryKey, patched)
      if (!current.needsRefetch && patched.needsRefetch) this.#invalidate(queryKey)
    }

    for (const [sessionID, actions] of agentClusters) {
      const queryKey = keys.agentCluster(this.#options.directory, sessionID)
      const state = this.#options.queryClient.getQueryData<SessionAgentClusterResponse>(queryKey)
      if (state) this.#options.queryClient.setQueryData(queryKey, patchAgentClusterState(state, actions))
      this.#invalidate(queryKey)
    }
  }

  #apply(
    action: Exclude<
      CacheAction,
      ConversationAction | AgentClusterAction | { kind: "server.connected"; eventID: string }
    >,
  ) {
    const directory = this.#options.directory
    switch (action.kind) {
      case "session.upsert": {
        const patchRootList = (archived: boolean) => {
          const listKey = keys.sessions(directory, archived)
          const sessions = this.#options.queryClient.getQueryData<Session[]>(listKey)
          const belongs =
            action.info.parentID === undefined &&
            (archived ? action.info.time.archived !== undefined : action.info.time.archived === undefined)
          if (sessions) {
            this.#options.queryClient.setQueryData(
              listKey,
              belongs ? upsertByID(sessions, action.info) : sessions.filter((session) => session.id !== action.info.id),
            )
          } else if (belongs) {
            this.#invalidate(listKey)
          }
        }
        patchRootList(false)
        patchRootList(true)

        const allKey = keys.sessionsAll(directory)
        const allSessions = this.#options.queryClient.getQueryData<Session[]>(allKey)
        if (allSessions) this.#options.queryClient.setQueryData(allKey, upsertByID(allSessions, action.info))
        else this.#invalidate(allKey)

        const sessionKey = keys.session(directory, action.info.id)
        if (this.#options.queryClient.getQueryData(sessionKey)) {
          this.#options.queryClient.setQueryData(sessionKey, action.info)
        } else {
          this.#invalidate(sessionKey)
        }
        break
      }
      case "session.remove": {
        for (const archived of [false, true]) {
          const listKey = keys.sessions(directory, archived)
          const sessions = this.#options.queryClient.getQueryData<Session[]>(listKey)
          if (!sessions || !sessions.some((session) => session.id === action.sessionID)) {
            this.#invalidate(listKey)
          } else {
            this.#options.queryClient.setQueryData(
              listKey,
              sessions.filter((session) => session.id !== action.sessionID),
            )
          }
        }
        this.#options.queryClient.removeQueries({ queryKey: keys.session(directory, action.sessionID), exact: true })
        const allKey = keys.sessionsAll(directory)
        const allSessions = this.#options.queryClient.getQueryData<Session[]>(allKey)
        if (allSessions) {
          this.#options.queryClient.setQueryData(
            allKey,
            allSessions.filter((session) => session.id !== action.sessionID),
          )
        } else {
          this.#invalidate(allKey)
        }
        break
      }
      case "status.set": {
        const queryKey = keys.status(directory)
        const status = this.#options.queryClient.getQueryData<Record<string, SessionStatus>>(queryKey)
        if (status) this.#options.queryClient.setQueryData(queryKey, { ...status, [action.sessionID]: action.status })
        else this.#invalidate(queryKey)
        break
      }
      case "permission.upsert":
        this.#patchRequestList(keys.permissions(directory), action.request)
        break
      case "permission.remove":
        this.#removeRequest(keys.permissions(directory), action.requestID)
        break
      case "question.upsert":
        this.#patchRequestList(keys.questions(directory), action.request)
        break
      case "question.remove":
        this.#removeRequest(keys.questions(directory), action.requestID)
        break
      case "todos.set":
        this.#options.queryClient.setQueryData(keys.todos(action.directory, action.sessionID), action.todos)
        break
      case "vcs.branch.set": {
        const queryKey = keys.vcsInfo(action.directory)
        const info = this.#options.queryClient.getQueryData<VcsInfo>(queryKey)
        this.#options.queryClient.setQueryData(queryKey, { ...info, branch: action.branch })
        break
      }
      case "vcs.invalidate":
        this.#invalidate(keys.vcsBranches(action.directory))
        this.#invalidate(keys.vcsDiff(action.directory))
        void this.#options.queryClient.invalidateQueries({
          queryKey: keys.pullRequestsScope(action.directory),
          exact: false,
        })
        break
    }
  }

  #patchRequestList<T extends { id: string }>(queryKey: readonly unknown[], request: T) {
    const requests = this.#options.queryClient.getQueryData<T[]>(queryKey)
    if (requests) this.#options.queryClient.setQueryData(queryKey, upsertByID(requests, request))
    else this.#invalidate(queryKey)
  }

  #removeRequest(queryKey: readonly unknown[], requestID: string) {
    const requests = this.#options.queryClient.getQueryData<Array<{ id: string }>>(queryKey)
    if (!requests || !requests.some((request) => request.id === requestID)) {
      this.#invalidate(queryKey)
      return
    }
    this.#options.queryClient.setQueryData(
      queryKey,
      requests.filter((request) => request.id !== requestID),
    )
  }

  async #connected() {
    if (this.#wasDisconnected) {
      const directory = this.#options.directory
      const queryFilters: Array<{ queryKey: readonly unknown[]; exact: boolean }> = [
        { queryKey: keys.sessions(directory), exact: true },
        { queryKey: keys.sessionsAll(directory), exact: true },
        { queryKey: keys.status(directory), exact: true },
        { queryKey: keys.permissions(directory), exact: true },
        { queryKey: keys.questions(directory), exact: true },
        { queryKey: keys.vcsInfo(directory), exact: true },
        { queryKey: keys.vcsBranches(directory), exact: true },
        { queryKey: keys.vcsDiff(directory), exact: true },
        { queryKey: keys.githubStatus(directory), exact: true },
        { queryKey: keys.pullRequestsScope(directory), exact: true },
        { queryKey: keys.agentClustersScope(directory), exact: false },
      ]
      const sessionID = this.#options.activeSessionID?.()
      if (sessionID) {
        queryFilters.push(
          { queryKey: keys.messages(directory, sessionID), exact: true },
          { queryKey: keys.todos(directory, sessionID), exact: true },
        )
      }
      await Promise.all(queryFilters.map((filters) => this.#options.queryClient.invalidateQueries(filters)))
    }
    if (this.#abort.signal.aborted) return
    this.#wasDisconnected = false
    this.#setConnection("connected")
  }

  #invalidate(queryKey: readonly unknown[]) {
    void this.#options.queryClient.invalidateQueries({ queryKey, exact: true })
  }

  #setConnection(state: ConnectionState) {
    this.#options.onConnectionChange?.(state)
  }
}
