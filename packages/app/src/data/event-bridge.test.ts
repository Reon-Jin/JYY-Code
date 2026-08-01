// @ts-nocheck
import type {
  GlobalEvent,
  Message,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionAgentClusterResponse,
  TextPart,
  Todo,
  VcsInfo,
} from "@jyycode-ai/sdk/v2/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EventBridge, retryDelay, routeEvent } from "./event-bridge"
import { createDesktopQueryClient } from "./query-client"
import { keys } from "./query-keys"
import { authorizationHeader, createDesktopClient } from "./sdk"
import { snapshotFromMessages, type ConversationSnapshot } from "../features/conversation/conversation-state"

const session: Session = {
  id: "ses_1",
  slug: "demo",
  projectID: "project_1",
  directory: "C:\\a",
  title: "Demo",
  version: "1",
  time: { created: 1, updated: 1 },
}

const message: Message = {
  id: "msg_1",
  sessionID: session.id,
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "provider", modelID: "model" },
}

const part: TextPart = {
  id: "part_1",
  sessionID: session.id,
  messageID: message.id,
  type: "text",
  text: "Hello",
}

const clusterState: SessionAgentClusterResponse = {
  tasks: [
    {
      id: "task_1",
      session_id: "ses_root",
      origin_message_id: "msg_parent",
      parent_task_id: "",
      child_session_id: "ses_child",
      role: "coder",
      title: "Implement",
      prompt: "Implement the feature",
      complexity: "complex",
      model: "test/coder",
      status: "running",
      step: 1,
      dependencies: [],
      review_round: 0,
      acceptance_criteria: [],
      artifact_paths: [],
      result_summary: "",
      review_issues: [],
      last_event: "Started",
      time_created: 11,
      time_updated: 11,
    },
  ],
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("desktop data boundary", () => {
  it("includes directory in every project-scoped key", () => {
    expect(keys.sessions("C:\\a")).toEqual(["project", "c:\\a", "sessions"])
    expect(keys.messages("C:\\a", "ses_1")).toEqual(["project", "c:\\a", "session", "ses_1", "messages"])
    expect(keys.todos("C:/A/", "ses_1")).toEqual(["project", "c:\\a", "session", "ses_1", "todos"])
    expect(keys.vcsInfo("C:/A/")).toEqual(["project", "c:\\a", "vcs", "info"])
    expect(keys.vcsBranches("C:/A/")).toEqual(["project", "c:\\a", "vcs", "branches"])
    expect(keys.vcsDiff("C:/A/")).toEqual(["project", "c:\\a", "vcs", "diff"])
    expect(keys.githubStatus("C:/A/")).toEqual(["project", "c:\\a", "github", "status"])
    expect(keys.pullRequests("C:/A/", "open")).toEqual(["project", "c:\\a", "github", "pulls", "open"])
    expect(keys.pullRequest("C:/A/", 12)).toEqual(["project", "c:\\a", "github", "pull", 12])
    expect(keys.pullRequestDiff("C:/A/", 12)).toEqual(["project", "c:\\a", "github", "pull", 12, "diff"])
    expect(keys.agentClustersScope("C:/A/")).toEqual(["project", "c:\\a", "agent-clusters"])
    expect(keys.agentCluster("C:/A/", "ses_root")).toEqual(["project", "c:\\a", "agent-clusters", "ses_root"])
    expect(keys.globalConfig).toEqual(["global", "config"])
  })

  it("creates Basic auth without putting credentials in a URL", () => {
    expect(authorizationHeader("jyycode", "secret")).toBe(`Basic ${btoa("jyycode:secret")}`)
  })

  it("applies authentication to normal and SSE requests", async () => {
    const requests: Request[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input instanceof Request ? input : new Request(input)
      requests.push(request)
      if (new URL(request.url).pathname === "/global/event") {
        return new Response(
          'data: {"directory":"global","payload":{"id":"connected","type":"server.connected","properties":{}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      return new Response('{"healthy":true,"version":"test"}', {
        headers: { "content-type": "application/json" },
      })
    })

    const client = createDesktopClient(
      { baseUrl: "http://127.0.0.1:1234", username: "jyycode", password: "secret" },
      "C:\\a",
    )
    await client.global.health()
    const events = await client.global.event({ sseMaxRetryAttempts: 0 })
    for await (const event of events.stream) {
      expect(event.payload.type).toBe("server.connected")
      break
    }

    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      authorizationHeader("jyycode", "secret"),
      authorizationHeader("jyycode", "secret"),
    ])
    expect(requests.every((request) => !request.url.includes("secret"))).toBe(true)
  })

  it("uses bounded network-only query retries", () => {
    const options = createDesktopQueryClient().getDefaultOptions()
    const retry = options.queries?.retry

    expect(options.queries?.staleTime).toBe(30_000)
    expect(options.mutations?.retry).toBe(false)
    expect(typeof retry).toBe("function")
    if (typeof retry !== "function") throw new Error("query retry policy is missing")
    expect(retry(0, new TypeError("offline"))).toBe(true)
    expect(retry(2, new TypeError("offline"))).toBe(false)
    expect(retry(0, new Error("HTTP 400"))).toBe(false)
  })
})

describe("event routing", () => {
  it("routes same-project cluster events and ignores other projects", () => {
    const clusterEvent = {
      directory: "C:\\a",
      payload: {
        id: "evt_cluster_1",
        type: "agent_cluster.event",
        properties: {
          sessionID: "ses_root",
          runID: "run_1",
          taskID: "task_1",
          type: "task",
          status: "reviewing",
          message: "Review started",
          createdAt: 20,
        },
      },
    } as GlobalEvent

    expect(routeEvent("C:\\a", clusterEvent)).toEqual([
      {
        kind: "agent-cluster.event",
        eventID: "evt_cluster_1",
        directory: "C:\\a",
        sessionID: "ses_root",
        event: clusterEvent.payload,
      },
    ])
    expect(routeEvent("C:\\b", clusterEvent)).toEqual([])
  })

  it("routes workspace inspector events to explicit cache actions", () => {
    const todos: Todo[] = [{ content: "Implement", status: "in_progress", priority: "high" }]

    expect(
      routeEvent("C:\\a", {
        directory: "C:\\a",
        payload: { id: "evt_todo", type: "todo.updated", properties: { sessionID: session.id, todos } },
      } as GlobalEvent),
    ).toEqual([{ kind: "todos.set", eventID: "evt_todo", directory: "C:\\a", sessionID: session.id, todos }])
    expect(
      routeEvent("C:\\a", {
        directory: "C:\\a",
        payload: {
          id: "evt_file",
          type: "file.watcher.updated",
          properties: { file: "src/app.tsx", event: "change" },
        },
      } as GlobalEvent),
    ).toEqual([{ kind: "vcs.invalidate", eventID: "evt_file", directory: "C:\\a" }])
    expect(
      routeEvent("C:\\a", {
        directory: "C:\\a",
        payload: { id: "evt_branch", type: "vcs.branch.updated", properties: { branch: "feature" } },
      } as GlobalEvent),
    ).toEqual([
      { kind: "vcs.branch.set", eventID: "evt_branch", directory: "C:\\a", branch: "feature" },
      { kind: "vcs.invalidate", eventID: "evt_branch", directory: "C:\\a" },
    ])
  })

  it("sets exact todos and coalesces workspace invalidations within one frame", async () => {
    const queryClient = createDesktopQueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const todos: Todo[] = [{ content: "Implement", status: "completed", priority: "high" }]
    const otherTodos: Todo[] = [{ content: "Other", status: "pending", priority: "low" }]
    queryClient.setQueryData(keys.todos("C:\\a", session.id), [])
    queryClient.setQueryData(keys.todos("C:\\a", "ses_other"), otherTodos)
    queryClient.setQueryData<VcsInfo>(keys.vcsInfo("C:\\a"), { branch: "main", default_branch: "main" })

    let releaseStream = () => {}
    const streamWait = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const stream = (async function* () {
      yield {
        directory: "C:\\a",
        payload: { id: "evt_todo", type: "todo.updated", properties: { sessionID: session.id, todos } },
      } as GlobalEvent
      for (const event of ["add", "change", "unlink"] as const) {
        yield {
          directory: "C:\\a",
          payload: {
            id: `evt_file_${event}`,
            type: "file.watcher.updated",
            properties: { file: "src/app.tsx", event },
          },
        } as GlobalEvent
      }
      yield {
        directory: "C:\\a",
        payload: { id: "evt_branch", type: "vcs.branch.updated", properties: { branch: "feature" } },
      } as GlobalEvent
      await streamWait
    })()
    let scheduled: FrameRequestCallback | undefined
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      scheduled = callback
      return 1
    })
    const bridge = new EventBridge({
      client: { global: { event: vi.fn(async () => ({ stream })) } } as never,
      directory: "C:\\a",
      queryClient,
      requestFrame,
      cancelFrame: vi.fn(),
    })

    bridge.start()
    await vi.waitFor(() => expect(requestFrame).toHaveBeenCalledTimes(1))
    scheduled?.(0)
    await vi.waitFor(() => expect(queryClient.getQueryData(keys.todos("C:\\a", session.id))).toEqual(todos))

    expect(queryClient.getQueryData(keys.todos("C:\\a", "ses_other"))).toEqual(otherTodos)
    expect(queryClient.getQueryData<VcsInfo>(keys.vcsInfo("C:\\a"))?.branch).toBe("feature")
    const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey)
    expect(invalidated.filter((key) => JSON.stringify(key) === JSON.stringify(keys.vcsDiff("C:\\a")))).toHaveLength(1)
    expect(invalidated).toContainEqual(keys.vcsBranches("C:\\a"))
    expect(invalidated).toContainEqual(keys.pullRequestsScope("C:\\a"))

    bridge.abort()
    releaseStream()
  })

  it("ignores events from a different project directory", () => {
    const action = routeEvent("C:\\a", {
      directory: "C:\\b",
      payload: { id: "evt", type: "session.updated", properties: { sessionID: session.id, info: session } },
    } as GlobalEvent)

    expect(action).toEqual([])
  })

  it("matches Windows directories case-insensitively but POSIX directories case-sensitively", () => {
    const info = { ...session, directory: "C:\\Work\\Demo" }
    expect(
      routeEvent("c:/work/demo", {
        directory: "C:\\Work\\Demo",
        payload: { id: "evt_windows", type: "session.updated", properties: { sessionID: info.id, info } },
      } as GlobalEvent),
    ).toHaveLength(1)
    expect(
      routeEvent("/Users/dev/Work", {
        directory: "/Users/dev/work",
        payload: { id: "evt_macos", type: "session.updated", properties: { sessionID: info.id, info } },
      } as GlobalEvent),
    ).toEqual([])
  })

  it("upserts asked requests and removes them only after server confirmation", () => {
    const permission: PermissionRequest = {
      id: "per_1",
      sessionID: session.id,
      permission: "bash",
      patterns: ["git status"],
      metadata: {},
      always: ["git *"],
    }
    const question: QuestionRequest = {
      id: "que_1",
      sessionID: session.id,
      questions: [{ header: "范围", question: "继续吗？", options: [] }],
    }

    expect(
      routeEvent("C:\\a", {
        directory: "C:\\a",
        payload: { id: "evt_permission_asked", type: "permission.asked", properties: permission },
      } as GlobalEvent),
    ).toEqual([{ kind: "permission.upsert", eventID: "evt_permission_asked", request: permission }])
    expect(
      routeEvent("C:\\a", {
        directory: "C:\\a",
        payload: {
          id: "evt_permission_replied",
          type: "permission.replied",
          properties: { sessionID: session.id, requestID: permission.id, reply: "once" },
        },
      } as GlobalEvent),
    ).toEqual([{ kind: "permission.remove", eventID: "evt_permission_replied", requestID: permission.id }])
    expect(
      routeEvent("C:\\a", {
        directory: "C:\\a",
        payload: { id: "evt_question_asked", type: "question.asked", properties: question },
      } as GlobalEvent),
    ).toEqual([{ kind: "question.upsert", eventID: "evt_question_asked", request: question }])
    expect(
      routeEvent("C:\\a", {
        directory: "C:\\a",
        payload: {
          id: "evt_question_rejected",
          type: "question.rejected",
          properties: { sessionID: session.id, requestID: question.id },
        },
      } as GlobalEvent),
    ).toEqual([{ kind: "question.remove", eventID: "evt_question_rejected", requestID: question.id }])
  })

  it("batches a frame and patches exact session and status caches", async () => {
    const queryClient = createDesktopQueryClient()
    queryClient.setQueryData(keys.sessions("C:\\a"), [session])
    queryClient.setQueryData(keys.sessionsAll("C:\\a"), [session])
    queryClient.setQueryData(keys.session("C:\\a", session.id), session)
    queryClient.setQueryData(keys.status("C:\\a"), {})

    let releaseStream = () => {}
    const streamWait = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const updated = { ...session, title: "Updated" }
    const stream = (async function* () {
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_session",
          type: "session.updated",
          properties: { sessionID: session.id, info: updated },
        },
      } as GlobalEvent
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_status",
          type: "session.status",
          properties: { sessionID: session.id, status: { type: "busy" } },
        },
      } as GlobalEvent
      await streamWait
    })()

    let scheduled: FrameRequestCallback | undefined
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      scheduled = callback
      return 1
    })
    const bridge = new EventBridge({
      client: { global: { event: vi.fn(async () => ({ stream })) } } as never,
      directory: "C:\\a",
      queryClient,
      requestFrame,
      cancelFrame: vi.fn(),
    })

    bridge.start()
    await vi.waitFor(() => expect(requestFrame).toHaveBeenCalledTimes(1))
    scheduled?.(0)
    await Promise.resolve()

    expect(queryClient.getQueryData<Session[]>(keys.sessions("C:\\a"))?.[0]?.title).toBe("Updated")
    expect(queryClient.getQueryData<Session[]>(keys.sessionsAll("C:\\a"))?.[0]?.title).toBe("Updated")
    expect(queryClient.getQueryData(keys.status("C:\\a"))).toEqual({ ses_1: { type: "busy" } })

    bridge.abort()
    releaseStream()
  })

  it("patches known cluster rows and refetches once per root session per frame", async () => {
    const queryClient = createDesktopQueryClient()
    const queryKey = keys.agentCluster("C:\\a", "ses_root")
    queryClient.setQueryData(queryKey, structuredClone(clusterState))
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    let releaseStream = () => {}
    const streamWait = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const clusterEvents = [
      {
        id: "evt_cluster_task",
        type: "agent_cluster.event",
        properties: {
          sessionID: "ses_root",
          taskID: "task_1",
          type: "task",
          status: "revision_requested",
          message: "Needs another pass",
          createdAt: 21,
        },
      },
      {
        id: "evt_cluster_unknown",
        type: "agent_cluster.event",
        properties: {
          sessionID: "ses_root",
          taskID: "task_new",
          type: "task",
          status: "queued",
          message: "New task queued",
          createdAt: 22,
        },
      },
    ] as const
    const stream = (async function* () {
      for (const payload of clusterEvents) yield { directory: "C:\\a", payload } as GlobalEvent
      await streamWait
    })()
    let scheduled: FrameRequestCallback | undefined
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      scheduled = callback
      return 1
    })
    const bridge = new EventBridge({
      client: { global: { event: vi.fn(async () => ({ stream })) } } as never,
      directory: "C:\\a",
      queryClient,
      requestFrame,
      cancelFrame: vi.fn(),
    })

    bridge.start()
    await vi.waitFor(() => expect(requestFrame).toHaveBeenCalledTimes(1))
    scheduled?.(0)
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey, exact: true }))

    const patched = queryClient.getQueryData<SessionAgentClusterResponse>(queryKey)
    expect(patched?.tasks[0]).toMatchObject({
      status: "revision_requested",
      time_updated: 21,
      last_event: "Needs another pass",
    })
    expect(patched?.tasks.map((task) => task.id)).toEqual(["task_1"])
    expect(
      invalidate.mock.calls.filter(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(queryKey)),
    ).toHaveLength(1)

    bridge.abort()
    releaseStream()
  })

  it("patches the active conversation snapshot without replaying a duplicate delta", async () => {
    const queryClient = createDesktopQueryClient()
    queryClient.setQueryData(
      keys.messages("C:\\a", session.id),
      snapshotFromMessages(session.id, [{ info: message, parts: [part] }]),
    )
    let releaseStream = () => {}
    const streamWait = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const delta = {
      directory: "C:\\a",
      payload: {
        id: "evt_delta_once",
        type: "message.part.delta",
        properties: {
          sessionID: session.id,
          messageID: message.id,
          partID: part.id,
          field: "text",
          delta: "!",
        },
      },
    } as GlobalEvent
    const stream = (async function* () {
      yield delta
      yield delta
      await streamWait
    })()
    let scheduled: FrameRequestCallback | undefined
    const bridge = new EventBridge({
      client: { global: { event: vi.fn(async () => ({ stream })) } } as never,
      directory: "C:\\a",
      queryClient,
      requestFrame: (callback) => {
        scheduled = callback
        return 1
      },
      cancelFrame: vi.fn(),
    })

    bridge.start()
    await vi.waitFor(() => expect(scheduled).toBeTypeOf("function"))
    scheduled?.(0)
    await Promise.resolve()

    const snapshot = queryClient.getQueryData<ConversationSnapshot>(keys.messages("C:\\a", session.id))
    expect(snapshot?.messages[0]?.parts[0]).toMatchObject({ text: "Hello!" })

    bridge.abort()
    releaseStream()
  })

  it("creates a live snapshot when SSE events beat the initial message query", async () => {
    const queryClient = createDesktopQueryClient()
    const cancelQueries = vi.spyOn(queryClient, "cancelQueries")
    const livePart = { ...part, text: "" }
    let releaseStream = () => {}
    const streamWait = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const stream = (async function* () {
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_live_1",
          type: "message.updated",
          properties: { sessionID: session.id, info: message },
        },
      } as GlobalEvent
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_live_2",
          type: "message.part.updated",
          properties: { sessionID: session.id, part: livePart, time: 1 },
        },
      } as GlobalEvent
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_live_3",
          type: "message.part.delta",
          properties: {
            sessionID: session.id,
            messageID: message.id,
            partID: livePart.id,
            field: "text",
            delta: "streaming",
          },
        },
      } as GlobalEvent
      await streamWait
    })()
    let scheduled: FrameRequestCallback | undefined
    const bridge = new EventBridge({
      client: { global: { event: vi.fn(async () => ({ stream })) } } as never,
      directory: "C:\\a",
      queryClient,
      requestFrame: (callback) => {
        scheduled = callback
        return 1
      },
      cancelFrame: vi.fn(),
    })

    bridge.start()
    await vi.waitFor(() => expect(scheduled).toBeTypeOf("function"))
    scheduled?.(0)
    await Promise.resolve()

    await vi.waitFor(() => {
      const snapshot = queryClient.getQueryData<ConversationSnapshot>(keys.messages("C:\\a", session.id))
      expect(snapshot?.messages[0]?.parts[0]).toMatchObject({ text: "streaming" })
    })
    expect(cancelQueries).toHaveBeenCalledWith({ queryKey: keys.messages("C:\\a", session.id), exact: true })

    bridge.abort()
    releaseStream()
  })

  it("caps reconnect backoff and clears its timer on abort", async () => {
    vi.useFakeTimers()
    expect([1, 2, 3, 4, 5, 6].map(retryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 30_000, 30_000])

    const event = vi.fn(async () => {
      throw new Error("offline")
    })
    const bridge = new EventBridge({
      client: { global: { event } } as never,
      directory: "C:\\a",
      queryClient: createDesktopQueryClient(),
    })

    bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(event).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    bridge.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("invalidates project snapshots before marking a reconnect healthy", async () => {
    vi.useFakeTimers()
    const queryClient = createDesktopQueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const states: string[] = []
    let attempt = 0
    const event = vi.fn(async (options: { signal: AbortSignal }) => {
      attempt += 1
      const currentAttempt = attempt
      return {
        stream: (async function* () {
          yield {
            payload: {
              id: `connected_${currentAttempt}`,
              type: "server.connected",
              properties: {},
            },
          } as GlobalEvent
          if (currentAttempt > 1) {
            await new Promise<void>((resolve) =>
              options.signal.addEventListener("abort", () => resolve(), { once: true }),
            )
          }
        })(),
      }
    })

    let scheduled: FrameRequestCallback | undefined
    const bridge = new EventBridge({
      client: { global: { event } } as never,
      directory: "C:\\a",
      queryClient,
      activeSessionID: () => session.id,
      onConnectionChange: (state) => states.push(state),
      requestFrame: (callback) => {
        scheduled = callback
        return 1
      },
      cancelFrame: () => {
        scheduled = undefined
      },
    })

    bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(states).toEqual(["connecting", "connected", "disconnected"])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(event).toHaveBeenCalledTimes(2)
    scheduled?.(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      keys.sessions("C:\\a"),
      keys.sessionsAll("C:\\a"),
      keys.status("C:\\a"),
      keys.permissions("C:\\a"),
      keys.questions("C:\\a"),
      keys.vcsInfo("C:\\a"),
      keys.vcsBranches("C:\\a"),
      keys.vcsDiff("C:\\a"),
      keys.githubStatus("C:\\a"),
      keys.pullRequestsScope("C:\\a"),
      keys.agentClustersScope("C:\\a"),
      keys.messages("C:\\a", session.id),
      keys.todos("C:\\a", session.id),
    ])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.agentClustersScope("C:\\a"), exact: false })
    expect(states.at(-1)).toBe("connected")

    bridge.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
// @ts-nocheck
