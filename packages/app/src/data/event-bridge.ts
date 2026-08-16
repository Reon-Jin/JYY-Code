import type {
  GlobalEvent,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
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
import { keys, normalizeDirectory, normalizeRelativePath } from "./query-keys"
import { publishDesktopNotificationEvent } from "../features/notifications/desktop-notifications"
import { publishSoundEffectEvent } from "../features/sound-effects/sound-effects"

export type ConnectionState = "connecting" | "connected" | "disconnected"

export type CompactionStatus =
  | { status: "compacting"; startedAt: number; reason: "auto" | "manual" }
  | { status: "done"; endedAt: number }

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
  | { kind: "compaction.started"; eventID: string; sessionID: string; reason: "auto" | "manual" }
  | { kind: "compaction.ended"; eventID: string; sessionID: string }
  | { kind: "vcs.invalidate"; eventID: string; directory: string; relativePath?: string }
  | { kind: "vcs.branch.set"; eventID: string; directory: string; branch?: string }
  | {
      kind: "session.diff"
      eventID: string
      directory: string
      sessionID: string
      diff: Extract<GlobalEvent["payload"], { type: "session.diff" }>["properties"]["diff"]
    }
  | {
      kind: "plan.event"
      eventID: string
      directory: string
      sessionID: string
      event: Extract<GlobalEvent["payload"], { type: "plan.runtime.event" }>
    }
  | { kind: "blackboard.updated"; eventID: string; directory: string; rootSessionID: string }
  | ConversationAction

function sameDirectory(left: string | undefined, right: string) {
  return typeof left === "string" && normalizeDirectory(left) === normalizeDirectory(right)
}

function isDirectoryOrDescendant(candidate: string, root: string) {
  const normalizedCandidate = normalizeDirectory(candidate)
  const normalizedRoot = normalizeDirectory(root)
  if (normalizedCandidate === normalizedRoot) return true
  const separator =
    normalizedRoot.endsWith("\\") || normalizedRoot.endsWith("/") ? "" : normalizedRoot.includes("\\") ? "\\" : "/"
  return normalizedCandidate.startsWith(`${normalizedRoot}${separator}`)
}

function routedSessionID(payload: GlobalEvent["payload"]): string | undefined {
  switch (payload.type) {
    case "session.status":
    case "session.idle":
    case "session.next.compaction.started":
    case "session.next.compaction.ended":
    case "message.updated":
    case "message.removed":
    case "message.part.updated":
    case "message.part.delta":
    case "message.part.removed":
    case "todo.updated":
    case "session.diff":
      return payload.properties.sessionID
    case "session.created":
    case "session.updated":
      return payload.properties.info.id
    case "session.deleted":
      return payload.properties.sessionID
    case "permission.asked":
    case "permission.replied":
    case "question.asked":
    case "question.replied":
    case "question.rejected":
      return payload.properties.sessionID
    default:
      return undefined
  }
}

export function routeEvent(
  directory: string,
  event: GlobalEvent,
  activeSessionID?: string | undefined,
): CacheAction[] {
  const payload = event.payload
  if (payload.type === "server.connected") {
    return [{ kind: "server.connected", eventID: payload.id }]
  }
  if (!sameDirectory(event.directory, directory)) {
    const routed = routedSessionID(payload)
    if (routed === undefined || routed !== activeSessionID) return []
  }

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
    case "session.next.compaction.started":
      return [
        {
          kind: "compaction.started",
          eventID: payload.id,
          sessionID: payload.properties.sessionID,
          reason: payload.properties.reason,
        },
      ]
    case "session.next.compaction.ended":
      return [
        {
          kind: "compaction.ended",
          eventID: payload.id,
          sessionID: payload.properties.sessionID,
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
      return [{ kind: "vcs.invalidate", eventID: payload.id, directory, relativePath: payload.properties.file }]
    case "session.diff":
      return [
        {
          kind: "session.diff",
          eventID: payload.id,
          directory,
          sessionID: payload.properties.sessionID,
          diff: payload.properties.diff,
        },
      ]
    case "vcs.branch.updated":
      return [
        { kind: "vcs.branch.set", eventID: payload.id, directory, branch: payload.properties.branch },
        { kind: "vcs.invalidate", eventID: payload.id, directory },
      ]
    case "plan.runtime.event":
      return [
        {
          kind: "plan.event",
          eventID: payload.id,
          directory,
          sessionID: payload.properties.session_id,
          event: payload,
        },
      ]
    case "blackboard.updated":
      return [
        {
          kind: "blackboard.updated",
          eventID: payload.id,
          directory,
          rootSessionID: payload.properties.rootSessionID,
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
  workspaceID?: () => string | undefined
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

type PlanAction = Extract<CacheAction, { kind: "plan.event" }>

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
      publishSoundEffectEvent({
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
    publishSoundEffectEvent({ kind: "attention", eventID: action.eventID })
  }
  if (action.kind === "question.upsert") {
    publishDesktopNotificationEvent({ kind: "question", eventID: action.eventID })
    publishSoundEffectEvent({ kind: "attention", eventID: action.eventID })
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
  readonly #partTypes = new Map<string, Part["type"]>()
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
    if (this.#abort.signal.aborted) return
    this.#abort.abort()
    if (this.#frame !== undefined) {
      ;(this.#options.cancelFrame ?? cancelFrame)(this.#frame)
      this.#frame = undefined
    }
    this.#queue.length = 0
    this.#seenEventIDs.clear()
    this.#partTypes.clear()
    this.#reconnectAttempt = 0
    this.#wasDisconnected = false
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
    if (this.#abort.signal.aborted) return
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
    if (this.#abort.signal.aborted) return
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
    const changedPlans = new Set<string>()
    const changedBlackboards = new Set<string>()
    const idleSessionIDs = new Set<string>()
    const invalidatedVcs = new Set<string>()

    for (const event of events) {
      if (this.#abort.signal.aborted) return
      for (const action of routeEvent(this.#options.directory, event, this.#options.activeSessionID?.())) {
        if (this.#abort.signal.aborted) return
        publishNotificationAction(action)
        if (action.kind === "part.upsert") {
          this.#partTypes.set(action.part.id, action.part.type)
          if (this.#partTypes.size > 4_096) {
            const oldest = this.#partTypes.keys().next().value
            if (oldest !== undefined) this.#partTypes.delete(oldest)
          }
        }
        if (action.kind === "part.delta" && action.field === "text" && this.#shouldPlayTypingSound(action)) {
          publishSoundEffectEvent({ kind: "typing", eventID: action.eventID })
        }
        if (action.kind === "server.connected") {
          await this.#connected()
          if (this.#abort.signal.aborted) return
          continue
        }
        if (action.kind === "status.set" && action.status.type === "idle") {
          idleSessionIDs.add(action.sessionID)
        }
        if (isConversationAction(action)) {
          const current = conversations.get(action.sessionID) ?? []
          current.push(event)
          conversations.set(action.sessionID, current)
          continue
        }
        if (action.kind === "plan.event") {
          changedPlans.add(action.sessionID)
          continue
        }
        if (action.kind === "blackboard.updated") {
          publishSoundEffectEvent({ kind: "blackboard", eventID: action.eventID })
          changedBlackboards.add(action.rootSessionID)
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
      if (this.#abort.signal.aborted) return
      const queryKey = keys.messages(this.#options.directory, sessionID)
      let current = this.#options.queryClient.getQueryData<ConversationSnapshot>(queryKey)
      const hadNoSnapshot = !isConversationSnapshot(current)
      if (hadNoSnapshot) {
        void this.#options.queryClient.cancelQueries({ queryKey, exact: true })
      }
      current = isConversationSnapshot(current) ? current : emptyConversationSnapshot(sessionID)
      const patched = applyConversationEvents(current, conversationEvents)
      this.#options.queryClient.setQueryData(queryKey, patched)
      if (hadNoSnapshot || (!current.needsRefetch && patched.needsRefetch)) this.#invalidate(queryKey)
    }

    if (this.#abort.signal.aborted) return
    for (const sessionID of changedPlans) this.#invalidate(keys.plan(this.#options.directory, sessionID))
    for (const rootSessionID of changedBlackboards) {
      this.#invalidate(keys.blackboard(this.#options.directory, rootSessionID))
    }
    for (const sessionID of idleSessionIDs) {
      this.#invalidate(keys.messages(this.#options.directory, sessionID))
    }
  }

  #shouldPlayTypingSound(action: Extract<CacheAction, { kind: "part.delta" }>) {
    if (this.#options.activeSessionID?.() !== action.sessionID) return false
    const session = this.#options.queryClient.getQueryData<Session>(
      keys.session(this.#options.directory, action.sessionID),
    )
    if (session && session.parentID !== undefined) return false

    const partType = this.#partTypes.get(action.partID)
    if (partType !== undefined) return partType === "text"

    const snapshot = this.#options.queryClient.getQueryData<ConversationSnapshot>(
      keys.messages(this.#options.directory, action.sessionID),
    )
    for (const message of snapshot?.messages ?? []) {
      const part = message.parts.find((candidate) => candidate.id === action.partID)
      if (part) return part.type === "text" && message.info.role === "assistant"
    }
    return false
  }

  #apply(
    action: Exclude<
      CacheAction,
      | ConversationAction
      | PlanAction
      | Extract<CacheAction, { kind: "blackboard.updated" }>
      | { kind: "server.connected"; eventID: string }
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
        this.#options.queryClient.setQueryData(queryKey, { ...(status ?? {}), [action.sessionID]: action.status })
        // The event can beat the initial status request. Keep the UI
        // responsive with the event value, then refresh to recover any other
        // session statuses that were not present in this first event.
        if (!status) this.#invalidate(queryKey)
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
      case "compaction.started": {
        const status: CompactionStatus = {
          status: "compacting",
          startedAt: Date.now(),
          reason: action.reason,
        }
        this.#options.queryClient.setQueryData(keys.compaction(directory, action.sessionID), status)
        break
      }
      case "compaction.ended": {
        const status: CompactionStatus = { status: "done", endedAt: Date.now() }
        this.#options.queryClient.setQueryData(keys.compaction(directory, action.sessionID), status)
        break
      }
      case "session.diff": {
        const matching = this.#workspaceQueries(directory).filter(
          (query) => query.queryKey[8] === "session-diff" && query.queryKey[5] === action.sessionID,
        )
        if (matching.length === 0) {
          this.#options.queryClient.setQueryData(keys.sessionDiff(directory, undefined, action.sessionID), action.diff)
        } else {
          for (const query of matching) this.#options.queryClient.setQueryData(query.queryKey, action.diff)
        }
        break
      }
      case "vcs.branch.set": {
        const queryKey = keys.vcsInfo(action.directory)
        const info = this.#options.queryClient.getQueryData<VcsInfo>(queryKey)
        this.#options.queryClient.setQueryData(queryKey, { ...info, branch: action.branch })
        break
      }
      case "vcs.invalidate": {
        const workspaceID = this.#options.workspaceID?.()
        const sessionID = this.#options.activeSessionID?.()
        this.#invalidate(keys.vcsBranches(action.directory))
        this.#invalidate(keys.vcsDiff(action.directory, workspaceID))
        this.#invalidate(keys.sessionDiff(action.directory, workspaceID, sessionID))
        this.#invalidate(keys.fileList(action.directory, workspaceID, sessionID))
        if (action.relativePath) {
          this.#invalidate(keys.fileContent(action.directory, workspaceID, sessionID, action.relativePath))
        }
        this.#invalidateScopedWorkspaceQueries(action.directory, undefined, undefined, action.relativePath)
        this.#invalidateNestedWorkspaceFileQueries(action.directory, action.relativePath)
        void this.#options.queryClient.invalidateQueries({
          queryKey: keys.pullRequestsScope(action.directory),
          exact: false,
        })
        break
      }
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
        { queryKey: keys.plansScope(directory), exact: false },
        { queryKey: keys.blackboardsScope(directory), exact: false },
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

  #workspaceQueries(directory: string, workspaceID?: string) {
    const normalized = normalizeDirectory(directory)
    return this.#options.queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => {
        const key = query.queryKey
        return (
          key[0] === "project" &&
          key[1] === normalized &&
          key[2] === "workspace" &&
          (workspaceID === undefined || key[3] === workspaceID)
        )
      })
  }

  #invalidateScopedWorkspaceQueries(
    directory: string,
    workspaceID: string | undefined,
    sessionID: string | undefined,
    relativePath: string | undefined,
  ) {
    const path = relativePath ? normalizeRelativePath(relativePath) : undefined
    for (const query of this.#workspaceQueries(directory, workspaceID)) {
      const key = query.queryKey
      const kind = key[8]
      if (kind !== "vcs-diff" && kind !== "session-diff" && kind !== "files") continue
      if (sessionID !== undefined && key[5] !== sessionID) continue
      if (kind === "files" && relativePath && (key[9] !== "content" || key[7] !== path)) continue
      this.#invalidate(key)
    }
  }

  #invalidateNestedWorkspaceFileQueries(directory: string, relativePath?: string) {
    const path = relativePath ? normalizeRelativePath(relativePath) : undefined
    for (const query of this.#options.queryClient.getQueryCache().getAll()) {
      const key = query.queryKey
      if (key[0] !== "project" || typeof key[1] !== "string" || !isDirectoryOrDescendant(key[1], directory)) continue
      if (key[2] !== "workspace" || key[8] !== "files") continue
      if (path && key[9] === "content" && key[7] !== path) continue
      this.#invalidate(key)
    }
  }

  #setConnection(state: ConnectionState) {
    this.#options.onConnectionChange?.(state)
  }
}
