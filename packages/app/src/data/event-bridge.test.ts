// @ts-nocheck
import type {
  GlobalEvent,
  Message,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionPlanResponse,
  TextPart,
  VcsInfo,
} from "@jyycode-ai/sdk/v2/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EventBridge, retryDelay, routeEvent } from "./event-bridge"
import { createDesktopQueryClient } from "./query-client"
import { keys } from "./query-keys"
import { authorizationHeader, createDesktopClient } from "./sdk"
import { snapshotFromMessages, type ConversationSnapshot } from "../features/conversation/conversation-state"
import * as soundEffects from "../features/sound-effects/sound-effects"

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

const planState: SessionPlanResponse = {
  title: "Implement",
  goal: "Implement the feature",
  status: "active",
  revision: 1,
  current_step: "s1",
  pending_review: 0,
  inbox_pending: 0,
  steps: [
    { id: "s1", title: "Implement", status: "active", tasks: [{ id: "s1_t1", title: "Code", status: "running" }] },
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
    expect(keys.vcsInfo("C:/A/")).toEqual(["project", "c:\\a", "vcs", "info"])
    expect(keys.vcsBranches("C:/A/")).toEqual(["project", "c:\\a", "vcs", "branches"])
    expect(keys.vcsDiff("C:/A/")).toEqual(["project", "c:\\a", "vcs", "diff"])
    expect(keys.githubStatus("C:/A/")).toEqual(["project", "c:\\a", "github", "status"])
    expect(keys.pullRequests("C:/A/", "open")).toEqual(["project", "c:\\a", "github", "pulls", "open"])
    expect(keys.pullRequest("C:/A/", 12)).toEqual(["project", "c:\\a", "github", "pull", 12])
    expect(keys.pullRequestDiff("C:/A/", 12)).toEqual(["project", "c:\\a", "github", "pull", 12, "diff"])
    expect(keys.plansScope("C:/A/")).toEqual(["project", "c:\\a", "plans"])
    expect(keys.plan("C:/A/", "ses_root")).toEqual(["project", "c:\\a", "plans", "ses_root"])
    expect(keys.blackboardsScope("C:/A/")).toEqual(["project", "c:\\a", "blackboards"])
    expect(keys.blackboard("C:/A/", "ses_root")).toEqual(["project", "c:\\a", "blackboards", "ses_root"])
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
  it("routes same-project plan events and ignores other projects", () => {
    const planEvent = {
      directory: "C:\\a",
      payload: {
        id: "evt_plan_1",
        type: "plan.runtime.event",
        properties: {
          seq: 1,
          type: "report_arrived",
          session_id: "ses_root",
          at: new Date(20).toISOString(),
          payload: { taskId: "s1_t1" },
        },
      },
    } as GlobalEvent

    expect(routeEvent("C:\\a", planEvent)).toEqual([
      {
        kind: "plan.event",
        eventID: "evt_plan_1",
        directory: "C:\\a",
        sessionID: "ses_root",
        event: planEvent.payload,
      },
    ])
    expect(routeEvent("C:\\b", planEvent)).toEqual([])
  })

  it("routes blackboard updates to the root board without mixing them with plan events", () => {
    const blackboardEvent = {
      directory: "C:\\a",
      payload: {
        id: "evt_blackboard_1",
        type: "blackboard.updated",
        properties: { rootSessionID: "ses_root", stepID: "step_1", messageID: "bb_1" },
      },
    } as GlobalEvent

    expect(routeEvent("C:\\a", blackboardEvent)).toEqual([
      {
        kind: "blackboard.updated",
        eventID: "evt_blackboard_1",
        directory: "C:\\a",
        rootSessionID: "ses_root",
      },
    ])
    expect(routeEvent("C:\\b", blackboardEvent)).toEqual([])
  })

  it("routes workspace inspector events to explicit cache actions", () => {
    expect(
      routeEvent("C:\\a", {
        directory: "C:\\a",
        payload: {
          id: "evt_file",
          type: "file.watcher.updated",
          properties: { file: "src/app.tsx", event: "change" },
        },
      } as GlobalEvent),
    ).toEqual([{ kind: "vcs.invalidate", eventID: "evt_file", directory: "C:\\a", relativePath: "src/app.tsx" }])
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

  it("routes session diffs with their explicit session scope", () => {
    const diff = [{ file: "src/app.tsx", status: "modified", additions: 1, deletions: 0, patch: "+next" }]
    expect(
      routeEvent("C:\\a", {
        directory: "C:\\a",
        payload: { id: "evt_diff", type: "session.diff", properties: { sessionID: "ses_child", diff } },
      } as GlobalEvent),
    ).toEqual([{ kind: "session.diff", eventID: "evt_diff", directory: "C:\\a", sessionID: "ses_child", diff }])
  })

  it("updates cached session diffs for the matching session across workspace scopes", async () => {
    const queryClient = createDesktopQueryClient()
    const rootKey = keys.sessionDiff("C:\\a", "wrk_root", "ses_root")
    const childKey = keys.sessionDiff("C:\\a", "wrk_child", "ses_root")
    queryClient.setQueryData(rootKey, [])
    queryClient.setQueryData(childKey, [])
    const diff = [{ file: "main.txt", status: "modified", additions: 1, deletions: 0, patch: "+next" }]
    const event = vi.fn(async (options: { signal: AbortSignal }) => ({
      stream: (async function* () {
        yield {
          directory: "C:\\a",
          payload: { id: "connected", type: "server.connected", properties: {} },
        } as GlobalEvent
        yield {
          directory: "C:\\a",
          payload: { id: "evt_diff_scope", type: "session.diff", properties: { sessionID: "ses_root", diff } },
        } as GlobalEvent
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }))
      })(),
    }))
    const bridge = new EventBridge({
      client: { global: { event } } as never,
      directory: "C:\\a",
      queryClient,
      workspaceID: () => "wrk_child",
    })

    bridge.start()
    await vi.waitFor(() => {
      expect(queryClient.getQueryData(rootKey)).toEqual(diff)
      expect(queryClient.getQueryData(childKey)).toEqual(diff)
    })
    bridge.abort()
  })

  it("ignores events from a different project directory", () => {
    const action = routeEvent("C:\\a", {
      directory: "C:\\b",
      payload: { id: "evt", type: "session.updated", properties: { sessionID: session.id, info: session } },
    } as GlobalEvent)

    expect(action).toEqual([])
  })

  it("routes session-scoped events for the active child session across directories", () => {
    const childDirectory = "C:\\a\\plan\\ses_child"
    expect(
      routeEvent(
        "C:\\a",
        {
          directory: childDirectory,
          payload: {
            id: "evt_child_message",
            type: "message.updated",
            properties: { sessionID: session.id, info: session },
          },
        } as GlobalEvent,
        session.id,
      ),
    ).toEqual([
      {
        kind: "message.upsert",
        eventID: "evt_child_message",
        sessionID: session.id,
        info: session,
      },
    ])
    expect(
      routeEvent(
        "C:\\a",
        {
          directory: childDirectory,
          payload: {
            id: "evt_other_message",
            type: "message.updated",
            properties: { sessionID: "ses_other", info: session },
          },
        } as GlobalEvent,
        session.id,
      ),
    ).toEqual([])
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

  it("routes compaction started and ended events", () => {
    expect(
      routeEvent("C:\\a", {
        directory: "C:\\a",
        payload: {
          id: "evt_compaction_started",
          type: "session.next.compaction.started",
          properties: { timestamp: 1, sessionID: session.id, reason: "auto" },
        },
      } as GlobalEvent),
    ).toEqual([
      { kind: "compaction.started", eventID: "evt_compaction_started", sessionID: session.id, reason: "auto" },
    ])
    expect(
      routeEvent("C:\\a", {
        directory: "C:\\a",
        payload: {
          id: "evt_compaction_ended",
          type: "session.next.compaction.ended",
          properties: { timestamp: 2, sessionID: session.id, text: "summary" },
        },
      } as GlobalEvent),
    ).toEqual([{ kind: "compaction.ended", eventID: "evt_compaction_ended", sessionID: session.id }])
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

  it("patches compaction status caches from started and ended events", async () => {
    const queryClient = createDesktopQueryClient()
    let releaseStream = () => {}
    const streamWait = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const stream = (async function* () {
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_compaction_started",
          type: "session.next.compaction.started",
          properties: { timestamp: 1, sessionID: session.id, reason: "manual" },
        },
      } as GlobalEvent
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_compaction_ended",
          type: "session.next.compaction.ended",
          properties: { timestamp: 2, sessionID: session.id, text: "summary" },
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

    const status = queryClient.getQueryData(keys.compaction("C:\\a", session.id))
    expect(status).toMatchObject({ status: "done" })
    expect(status?.endedAt).toBeTypeOf("number")

    bridge.abort()
    releaseStream()
  })

  it("invalidates a plan snapshot once per root session per frame", async () => {
    const queryClient = createDesktopQueryClient()
    const queryKey = keys.plan("C:\\a", "ses_root")
    queryClient.setQueryData(queryKey, structuredClone(planState))
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    let releaseStream = () => {}
    const streamWait = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const planEvents = [
      {
        id: "evt_plan_task",
        type: "plan.runtime.event",
        properties: {
          seq: 1,
          type: "plan.updated",
          session_id: "ses_root",
          revision: 2,
          at: new Date(21).toISOString(),
          payload: {},
        },
      },
      {
        id: "evt_plan_activity",
        type: "plan.runtime.event",
        properties: {
          seq: 2,
          type: "child.activity",
          session_id: "ses_root",
          at: new Date(22).toISOString(),
          payload: { taskId: "s1_t1" },
        },
      },
    ] as const
    const stream = (async function* () {
      for (const payload of planEvents) yield { directory: "C:\\a", payload } as GlobalEvent
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

    expect(queryClient.getQueryData<SessionPlanResponse>(queryKey)).toEqual(planState)
    expect(
      invalidate.mock.calls.filter(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(queryKey)),
    ).toHaveLength(1)

    bridge.abort()
    releaseStream()
  })

  it("invalidates each changed root blackboard once per frame and does not patch the payload", async () => {
    const queryClient = createDesktopQueryClient()
    const firstKey = keys.blackboard("C:\\a", "ses_root")
    const secondKey = keys.blackboard("C:\\a", "ses_other")
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    let releaseStream = () => {}
    const streamWait = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const stream = (async function* () {
      for (const [id, rootSessionID] of [
        ["evt_bb_1", "ses_root"],
        ["evt_bb_2", "ses_root"],
        ["evt_bb_3", "ses_other"],
      ] as const) {
        yield {
          directory: "C:\\a",
          payload: {
            id,
            type: "blackboard.updated",
            properties: { rootSessionID, stepID: "step_1", messageID: id },
          },
        } as GlobalEvent
      }
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
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: firstKey, exact: false }))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: secondKey, exact: false })
    expect(
      invalidate.mock.calls.filter(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(firstKey)),
    ).toHaveLength(1)
    expect(queryClient.getQueryData(firstKey)).toBeUndefined()

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
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")
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
    // This is exactly the dangerous case: the event batch already contains the
    // new message, so needsRefetch stays false and the old code never refetched
    // the full history. The forced invalidate below is the fix.
    expect(queryClient.getQueryData<ConversationSnapshot>(keys.messages("C:\\a", session.id))?.needsRefetch).toBe(false)
    expect(cancelQueries).toHaveBeenCalledWith({ queryKey: keys.messages("C:\\a", session.id), exact: true })
    // Even though the event batch already contains the new message (so
    // needsRefetch stays false), the bridge must force a full-history refetch
    // so earlier messages are not lost from the UI.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: keys.messages("C:\\a", session.id), exact: true })

    bridge.abort()
    releaseStream()
  })

  it("applies session.next.* message events to the live snapshot", async () => {
    const queryClient = createDesktopQueryClient()
    const livePart = { ...part, text: "" }
    const stream = (async function* () {
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_next_1",
          type: "session.next.message.updated",
          properties: { timestamp: 1, sessionID: session.id, info: message },
        },
      } as GlobalEvent
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_next_2",
          type: "session.next.message.part.updated",
          properties: { timestamp: 2, sessionID: session.id, part: livePart, time: 1 },
        },
      } as GlobalEvent
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_next_3",
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
      await new Promise(() => undefined)
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

    bridge.abort()
  })

  it("unwraps durable sync envelopes for message events", async () => {
    const queryClient = createDesktopQueryClient()
    const livePart = { ...part, text: "" }
    const stream = (async function* () {
      yield {
        directory: "C:\\a",
        payload: {
          type: "sync",
          syncEvent: {
            type: "session.next.message.updated.1",
            id: "evt_sync_1",
            seq: 1,
            aggregateID: "sessionID",
            data: { sessionID: session.id, info: message },
          },
        },
      } as GlobalEvent
      yield {
        directory: "C:\\a",
        payload: {
          type: "sync",
          syncEvent: {
            type: "session.next.message.part.updated.1",
            id: "evt_sync_2",
            seq: 2,
            aggregateID: "sessionID",
            data: { sessionID: session.id, part: livePart, time: 1 },
          },
        },
      } as GlobalEvent
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_sync_3",
          type: "message.part.delta",
          properties: {
            sessionID: session.id,
            messageID: message.id,
            partID: livePart.id,
            field: "text",
            delta: "synced",
          },
        },
      } as GlobalEvent
      await new Promise(() => undefined)
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
      expect(snapshot?.messages[0]?.parts[0]).toMatchObject({ text: "synced" })
    })

    bridge.abort()
  })

  it("refetches the conversation when a session goes idle to reconcile dropped stream events", async () => {
    const queryClient = createDesktopQueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")
    queryClient.setQueryData(
      keys.messages("C:\\a", session.id),
      snapshotFromMessages(session.id, [{ info: message, parts: [part] }]),
    )
    let releaseStream = () => {}
    const streamWait = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const stream = (async function* () {
      yield {
        directory: "C:\\a",
        payload: { id: "evt_idle", type: "session.idle", properties: { sessionID: session.id } },
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

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: keys.messages("C:\\a", session.id),
      exact: true,
    })

    bridge.abort()
    releaseStream()
  })

  it("forces a full-history refetch for child Agent sessions when events beat the query", async () => {
    const child: Session = { ...session, id: "ses_child", parentID: session.id }
    const queryClient = createDesktopQueryClient()
    const cancelQueries = vi.spyOn(queryClient, "cancelQueries")
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")
    const childMessage: Message = { ...message, id: "msg_child", sessionID: child.id }
    const childPart: TextPart = { ...part, id: "part_child", sessionID: child.id, messageID: childMessage.id }
    let releaseStream = () => {}
    const streamWait = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const stream = (async function* () {
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_child_1",
          type: "message.updated",
          properties: { sessionID: child.id, info: childMessage },
        },
      } as GlobalEvent
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_child_2",
          type: "message.part.updated",
          properties: { sessionID: child.id, part: childPart },
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
      const snapshot = queryClient.getQueryData<ConversationSnapshot>(keys.messages("C:\\a", child.id))
      expect(snapshot?.messages[0]?.parts[0]).toMatchObject({ text: "Hello" })
    })
    expect(queryClient.getQueryData<ConversationSnapshot>(keys.messages("C:\\a", child.id))?.needsRefetch).toBe(false)
    expect(cancelQueries).toHaveBeenCalledWith({ queryKey: keys.messages("C:\\a", child.id), exact: true })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: keys.messages("C:\\a", child.id), exact: true })

    bridge.abort()
    releaseStream()
  })

  it("publishes a typing sound only for active main-agent text deltas", async () => {
    const publish = vi.spyOn(soundEffects, "publishSoundEffectEvent")
    const queryClient = createDesktopQueryClient()
    const assistantMessage = { ...message, id: "msg_typing", role: "assistant" }
    const typingPart = { ...part, id: "part_typing", messageID: assistantMessage.id }
    queryClient.setQueryData(keys.session("C:\\a", session.id), session)
    queryClient.setQueryData(
      keys.messages("C:\\a", session.id),
      snapshotFromMessages(session.id, [{ info: assistantMessage, parts: [typingPart] }]),
    )
    const events = [
      {
        directory: "C:\\a",
        payload: {
          id: "evt_typing_1",
          type: "message.part.delta",
          properties: {
            sessionID: session.id,
            messageID: assistantMessage.id,
            partID: typingPart.id,
            field: "text",
            delta: " more",
          },
        },
      },
      {
        directory: "C:\\a",
        payload: {
          id: "evt_typing_2",
          type: "message.part.delta",
          properties: {
            sessionID: session.id,
            messageID: assistantMessage.id,
            partID: typingPart.id,
            field: "text",
            delta: " output",
          },
        },
      },
    ] as GlobalEvent[]
    let releaseStream = () => {}
    const streamWait = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const stream = (async function* () {
      yield* events
      await streamWait
    })()
    let scheduled: FrameRequestCallback | undefined
    const bridge = new EventBridge({
      client: { global: { event: vi.fn(async () => ({ stream })) } } as never,
      directory: "C:\\a",
      queryClient,
      activeSessionID: () => session.id,
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
      expect(publish).toHaveBeenCalledWith({ kind: "typing", eventID: "evt_typing_1" })
    })
    expect(publish).toHaveBeenCalledWith({ kind: "typing", eventID: "evt_typing_2" })

    bridge.abort()
    releaseStream()
  })

  it("does not publish a typing sound for child sessions", async () => {
    const publish = vi.spyOn(soundEffects, "publishSoundEffectEvent")
    const queryClient = createDesktopQueryClient()
    const childMessage = { ...message, id: "msg_child", role: "assistant" }
    const childPart = { ...part, id: "part_child", messageID: childMessage.id }
    queryClient.setQueryData(keys.session("C:\\a", session.id), { ...session, parentID: "ses_root" })
    queryClient.setQueryData(
      keys.messages("C:\\a", session.id),
      snapshotFromMessages(session.id, [{ info: childMessage, parts: [childPart] }]),
    )
    const stream = (async function* () {
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_typing_child",
          type: "message.part.delta",
          properties: {
            sessionID: session.id,
            messageID: childMessage.id,
            partID: childPart.id,
            field: "text",
            delta: " child",
          },
        },
      } as GlobalEvent
      await new Promise(() => undefined)
    })()
    let scheduled: FrameRequestCallback | undefined
    const bridge = new EventBridge({
      client: { global: { event: vi.fn(async () => ({ stream })) } } as never,
      directory: "C:\\a",
      queryClient,
      activeSessionID: () => session.id,
      requestFrame: (callback) => {
        scheduled = callback
        return 1
      },
      cancelFrame: vi.fn(),
    })

    bridge.start()
    await vi.waitFor(() => expect(scheduled).toBeTypeOf("function"))
    scheduled?.(0)
    await vi.waitFor(() => {
      const snapshot = queryClient.getQueryData<ConversationSnapshot>(keys.messages("C:\\a", session.id))
      expect(snapshot?.messages[0]?.parts[0]).toMatchObject({ text: "Hello child" })
    })

    expect(publish).not.toHaveBeenCalled()
    bridge.abort()
  })

  it("does not publish a typing sound for reasoning deltas", async () => {
    const publish = vi.spyOn(soundEffects, "publishSoundEffectEvent")
    const queryClient = createDesktopQueryClient()
    const assistantMessage = { ...message, id: "msg_reasoning", role: "assistant" }
    const reasoningPart = { ...part, id: "part_reasoning", messageID: assistantMessage.id, type: "reasoning", text: "" }
    queryClient.setQueryData(keys.session("C:\\a", session.id), session)
    queryClient.setQueryData(
      keys.messages("C:\\a", session.id),
      snapshotFromMessages(session.id, [{ info: assistantMessage, parts: [reasoningPart] }]),
    )
    const stream = (async function* () {
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_typing_reasoning",
          type: "message.part.delta",
          properties: {
            sessionID: session.id,
            messageID: assistantMessage.id,
            partID: reasoningPart.id,
            field: "text",
            delta: " thinking",
          },
        },
      } as GlobalEvent
      await new Promise(() => undefined)
    })()
    let scheduled: FrameRequestCallback | undefined
    const bridge = new EventBridge({
      client: { global: { event: vi.fn(async () => ({ stream })) } } as never,
      directory: "C:\\a",
      queryClient,
      activeSessionID: () => session.id,
      requestFrame: (callback) => {
        scheduled = callback
        return 1
      },
      cancelFrame: vi.fn(),
    })

    bridge.start()
    await vi.waitFor(() => expect(scheduled).toBeTypeOf("function"))
    scheduled?.(0)
    await vi.waitFor(() => {
      const snapshot = queryClient.getQueryData<ConversationSnapshot>(keys.messages("C:\\a", session.id))
      expect(snapshot?.messages[0]?.parts[0]).toMatchObject({ text: " thinking" })
    })

    expect(publish).not.toHaveBeenCalled()
    bridge.abort()
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
      keys.plansScope("C:\\a"),
      keys.blackboardsScope("C:\\a"),
      keys.messages("C:\\a", session.id),
    ])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.plansScope("C:\\a"), exact: false })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.blackboardsScope("C:\\a"), exact: false })
    expect(states.at(-1)).toBe("connected")

    bridge.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("drops queued events and does not write cache after provider abort", async () => {
    const queryClient = createDesktopQueryClient()
    let scheduled: FrameRequestCallback | undefined
    let cancelled: FrameRequestCallback | undefined
    const event = vi.fn(async (options: { signal: AbortSignal }) => ({
      stream: (async function* () {
        yield {
          directory: "C:\\a",
          payload: { id: "late_session", type: "session.created", properties: { info: session } },
        } as GlobalEvent
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }))
      })(),
    }))
    const bridge = new EventBridge({
      client: { global: { event } } as never,
      directory: "C:\\a",
      queryClient,
      requestFrame: (callback) => {
        scheduled = callback
        return 1
      },
      cancelFrame: () => {
        cancelled = scheduled
        scheduled = undefined
      },
    })

    bridge.start()
    await vi.waitFor(() => expect(scheduled).toBeDefined())
    bridge.abort()
    cancelled?.(0)
    await Promise.resolve()

    expect(queryClient.getQueryData(keys.sessions("C:\\a"))).toBeUndefined()
  })
})
// @ts-nocheck
