import type { GlobalEvent, Message, Session, TextPart } from "@jyycode-ai/sdk/v2/client"
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

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("desktop data boundary", () => {
  it("includes directory in every project-scoped key", () => {
    expect(keys.sessions("C:\\a")).toEqual(["project", "c:\\a", "sessions"])
    expect(keys.messages("C:\\a", "ses_1")).toEqual(["project", "c:\\a", "session", "ses_1", "messages"])
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
  it("ignores events from a different project directory", () => {
    const action = routeEvent("C:\\a", {
      directory: "C:\\b",
      payload: { id: "evt", type: "session.updated", properties: { sessionID: session.id, info: session } },
    } as GlobalEvent)

    expect(action).toEqual([])
  })

  it("batches a frame and patches exact session and status caches", async () => {
    const queryClient = createDesktopQueryClient()
    queryClient.setQueryData(keys.sessions("C:\\a"), [session])
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
    expect(queryClient.getQueryData(keys.status("C:\\a"))).toEqual({ ses_1: { type: "busy" } })

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
          id: "evt_live_message",
          type: "message.updated",
          properties: { sessionID: session.id, info: message },
        },
      } as GlobalEvent
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_live_part",
          type: "message.part.updated",
          properties: { sessionID: session.id, part: livePart, time: 1 },
        },
      } as GlobalEvent
      yield {
        directory: "C:\\a",
        payload: {
          id: "evt_live_delta",
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
      keys.status("C:\\a"),
      keys.permissions("C:\\a"),
      keys.questions("C:\\a"),
      keys.messages("C:\\a", session.id),
    ])
    expect(states.at(-1)).toBe("connected")

    bridge.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
