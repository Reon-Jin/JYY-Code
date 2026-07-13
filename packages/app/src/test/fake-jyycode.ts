import type { GlobalEvent, Message, Part, PermissionRequest, Project, Session } from "@jyycode-ai/sdk/v2/client"

const encoder = new TextEncoder()

function model(providerID = "test", modelID = "test-model") {
  return {
    id: modelID,
    providerID,
    api: { id: modelID, url: "http://desktop.test/model", npm: "test" },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 100_000, output: 10_000 },
    status: "active" as const,
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
}

function json(data: unknown, status = 200) {
  return new Response(data === undefined ? undefined : JSON.stringify(data), {
    status,
    headers: data === undefined ? undefined : { "content-type": "application/json" },
  })
}

async function body(request: Request) {
  if (!request.body) return {}
  return (await request.json()) as Record<string, unknown>
}

export function createFakeJyycode(directory = "C:\\work\\demo") {
  const project: Project = {
    id: "project_desktop",
    worktree: directory,
    time: { created: 1, updated: 1 },
    sandboxes: [],
  }
  const sessions: Session[] = []
  const messages = new Map<string, Array<{ info: Message; parts: Part[] }>>()
  const permissions: PermissionRequest[] = []
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  let sequence = 0

  function emit(payload: GlobalEvent["payload"]) {
    const event: GlobalEvent = { directory, payload }
    const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
    for (const stream of streams) stream.enqueue(frame)
  }

  function event(type: string, properties: Record<string, unknown>) {
    sequence += 1
    emit({ id: `event_${sequence}`, type, properties } as GlobalEvent["payload"])
  }

  function sse(request: Request) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streams.add(controller)
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ directory, payload: { id: "connected", type: "server.connected", properties: {} } })}\n\n`,
          ),
        )
        request.signal.addEventListener(
          "abort",
          () => {
            streams.delete(controller)
            try {
              controller.close()
            } catch {
              // The SDK can cancel the stream before the request signal fires.
            }
          },
          { once: true },
        )
      },
      cancel() {
        // The controller is removed by the request abort handler.
      },
    })
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  }

  async function fetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    const value = await body(request)
    requests.push({ method: request.method, path: url.pathname, body: value })

    if (url.pathname === "/global/event") return sse(request)
    if (url.pathname === "/global/health") return json({ healthy: true, version: "test" })
    if (url.pathname === "/project/current") return json(project)
    if (url.pathname === "/project/git/init") return json({ ...project, vcs: "git" })

    if (url.pathname === "/agent") {
      return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    }
    if (url.pathname === "/config/providers") {
      const provider = { id: "test", name: "Test", source: "config", env: [], options: {}, models: { "test-model": model() } }
      return json({ providers: [provider], default: { test: "test-model" } })
    }
    if (url.pathname === "/provider") {
      const provider = { id: "test", name: "Test", source: "config", env: [], options: {}, models: { "test-model": model() } }
      return json({ all: [provider], connected: ["test"], default: { test: "test-model" } })
    }
    if (url.pathname === "/config") return json({ default_agent: "build", model: "test/test-model" })
    if (url.pathname === "/path") return json({ home: "C:\\Users\\test", state: "state", config: "C:\\config" })

    if (url.pathname === "/session" && request.method === "POST") {
      const session: Session = {
        id: `ses_${sessions.length + 1}`,
        slug: `session-${sessions.length + 1}`,
        projectID: project.id,
        directory,
        title: typeof value.title === "string" ? value.title : "New session - 2026-07-13T00:00:00.000Z",
        version: "test",
        time: { created: Date.now(), updated: Date.now() },
      }
      sessions.push(session)
      messages.set(session.id, [])
      event("session.created", { info: session })
      return json(session)
    }
    if (url.pathname === "/session" && request.method === "GET") return json(sessions)
    if (url.pathname === "/session/status") {
      return json(Object.fromEntries(sessions.map((session) => [session.id, { type: "idle" }])))
    }

    const sessionID = url.pathname.match(/^\/session\/([^/]+)/)?.[1]
    if (sessionID && url.pathname.endsWith("/message") && request.method === "GET") {
      return json(messages.get(sessionID) ?? [])
    }
    if (sessionID && url.pathname.endsWith("/prompt_async") && request.method === "POST") {
      const promptText = Array.isArray(value.parts)
        ? String((value.parts[0] as Record<string, unknown> | undefined)?.text ?? "")
        : ""
      const userInfo: Message = {
        id: "msg_user",
        sessionID,
        role: "user",
        time: { created: 10 },
        agent: String(value.agent ?? "build"),
        model: (value.model as { providerID: string; modelID: string }) ?? { providerID: "test", modelID: "test-model" },
      }
      const userPart: Part = { id: "part_user", sessionID, messageID: userInfo.id, type: "text", text: promptText }
      const assistantInfo: Message = {
        id: "msg_assistant",
        sessionID,
        role: "assistant",
        time: { created: 11 },
        parentID: userInfo.id,
        modelID: "test-model",
        providerID: "test",
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      const textPart: Part = {
        id: "part_assistant",
        sessionID,
        messageID: assistantInfo.id,
        type: "text",
        text: "流式回复已完成",
      }
      const toolPart: Part = {
        id: "part_tool",
        sessionID,
        messageID: assistantInfo.id,
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "git status" },
          output: "clean",
          title: "检查工作区",
          metadata: {},
          time: { start: 12, end: 18 },
        },
      }
      messages.set(sessionID, [
        { info: userInfo, parts: [userPart] },
        { info: assistantInfo, parts: [textPart, toolPart] },
      ])
      const permission: PermissionRequest = {
        id: "per_1",
        sessionID,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: ["git status"],
      }
      permissions.push(permission)
      const session = sessions.find((candidate) => candidate.id === sessionID)
      if (session) {
        session.title = "检查工作区状态"
        session.time.updated = Date.now()
        event("session.updated", { sessionID, info: session })
      }
      event("session.status", { sessionID, status: { type: "busy" } })
      event("message.updated", { sessionID, info: userInfo })
      event("message.part.updated", { sessionID, part: userPart })
      event("message.updated", { sessionID, info: assistantInfo })
      event("message.part.updated", { sessionID, part: textPart })
      event("message.part.updated", { sessionID, part: toolPart })
      event("permission.asked", permission as unknown as Record<string, unknown>)
      return json(true)
    }
    if (sessionID && url.pathname.endsWith("/abort") && request.method === "POST") {
      event("session.idle", { sessionID })
      return json(true)
    }
    if (sessionID && request.method === "GET") return json(sessions.find((session) => session.id === sessionID))

    if (url.pathname === "/permission" && request.method === "GET") return json(permissions)
    if (/^\/permission\/[^/]+\/reply$/.test(url.pathname) && request.method === "POST") {
      const requestID = url.pathname.split("/")[2]!
      const index = permissions.findIndex((request) => request.id === requestID)
      if (index >= 0) permissions.splice(index, 1)
      event("permission.replied", { requestID })
      return json(true)
    }
    if (url.pathname === "/question" && request.method === "GET") return json([])
    throw new Error(`Unhandled fake JYYCode request: ${request.method} ${url.pathname}`)
  }

  return {
    fetch: fetch as typeof globalThis.fetch,
    project,
    sessions,
    messages,
    permissions,
    requests,
    emit,
  }
}
