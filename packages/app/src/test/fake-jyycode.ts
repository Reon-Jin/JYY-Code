import type {
  GitHubAvailability,
  GitHubPullRequestDetail,
  GitHubPullRequestSummary,
  GlobalEvent,
  Message,
  Part,
  PermissionRequest,
  Project,
  Session,
  Todo,
  VcsBranches,
  VcsFileDiff,
} from "@jyycode-ai/sdk/v2/client"

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
  const todos = new Map<string, Todo[]>()
  const permissions: PermissionRequest[] = []
  const changes: VcsFileDiff[] = [
    { file: "src/app.tsx", status: "modified", additions: 4, deletions: 1, patch: "@@ -1 +1 @@" },
  ]
  const branches: VcsBranches = {
    current: "main",
    branches: [
      { name: "main", kind: "local", current: true, upstream: "origin/main" },
      { name: "origin/main", kind: "remote", current: false, remote: "origin" },
    ],
    remotes: [
      { name: "origin", fetchUrl: "https://github.com/example/demo.git", pushUrl: "git@github.com:example/demo.git" },
    ],
  }
  let githubStatus: GitHubAvailability = {
    available: true,
    repository: { nameWithOwner: "example/demo", url: "https://github.com/example/demo", defaultBranch: "main" },
  }
  const pullRequests: GitHubPullRequestSummary[] = [
    {
      number: 1,
      title: "Workspace inspector",
      state: "OPEN",
      isDraft: false,
      headRefName: "feature/inspector",
      baseRefName: "main",
      author: { login: "codex" },
      updatedAt: "2026-07-13T00:00:00Z",
      url: "https://github.com/example/demo/pull/1",
    },
  ]
  const pullRequestDetails = new Map<number, GitHubPullRequestDetail>([
    [
      1,
      {
        ...pullRequests[0]!,
        body: "Adds the workspace inspector.",
        mergeable: "MERGEABLE",
        comments: [],
        commits: [],
        checks: [],
      },
    ],
  ])
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const requests: Array<{
    method: string
    path: string
    query: Record<string, string>
    body: Record<string, unknown>
  }> = []
  let sequence = 0

  function emit(payload: GlobalEvent["payload"]) {
    const event: GlobalEvent = { directory, payload }
    const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
    for (const stream of streams) {
      try {
        stream.enqueue(frame)
      } catch {
        streams.delete(stream)
      }
    }
  }

  function event(type: string, properties: Record<string, unknown>) {
    sequence += 1
    emit({ id: `event_${sequence}`, type, properties } as GlobalEvent["payload"])
  }

  function sse(request: Request) {
    let active: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        active = controller
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
        if (active) streams.delete(active)
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
    requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: value,
    })

    if (url.pathname === "/global/event") return sse(request)
    if (url.pathname === "/global/health") return json({ healthy: true, version: "test" })
    if (url.pathname === "/project/current") return json(project)
    if (url.pathname === "/project/git/init") return json({ ...project, vcs: "git" })

    if (url.pathname === "/agent") {
      return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    }
    if (url.pathname === "/config/providers") {
      const provider = {
        id: "test",
        name: "Test",
        source: "config",
        env: [],
        options: {},
        models: { "test-model": model() },
      }
      return json({ providers: [provider], default: { test: "test-model" } })
    }
    if (url.pathname === "/provider") {
      const provider = {
        id: "test",
        name: "Test",
        source: "config",
        env: [],
        options: {},
        models: { "test-model": model() },
      }
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
      todos.set(session.id, [])
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
    if (sessionID && url.pathname.endsWith("/todo") && request.method === "GET") {
      return json(todos.get(sessionID) ?? [])
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
        model: (value.model as { providerID: string; modelID: string }) ?? {
          providerID: "test",
          modelID: "test-model",
        },
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

    if (url.pathname === "/vcs" && request.method === "GET") {
      return json({ branch: branches.current, default_branch: "main" })
    }
    if (url.pathname === "/vcs/diff" && request.method === "GET") return json(changes)
    if (url.pathname === "/vcs/branches" && request.method === "GET") return json(branches)
    if (url.pathname === "/vcs/branches" && request.method === "POST") {
      const name = String(value.name ?? "feature")
      branches.branches.push({ name, kind: "local", current: value.checkout === true })
      if (value.checkout === true) setCurrentBranch(name)
      return json(branches)
    }
    if (url.pathname === "/vcs/branches/switch" && request.method === "POST") {
      setCurrentBranch(String(value.name ?? "main"))
      event("vcs.branch.updated", { branch: branches.current })
      return json(branches)
    }
    if (url.pathname === "/vcs/fetch" && request.method === "POST") return json(branches)
    if (url.pathname === "/vcs/push" && request.method === "POST") return json(branches)

    if (url.pathname === "/github/status" && request.method === "GET") return json(githubStatus)
    if (url.pathname === "/github/pulls" && request.method === "GET") {
      const state = url.searchParams.get("state") ?? "all"
      return json(state === "all" ? pullRequests : pullRequests.filter((pull) => pull.state.toLowerCase() === state))
    }
    if (url.pathname === "/github/pulls" && request.method === "POST") {
      const number = Math.max(0, ...pullRequests.map((pull) => Number(pull.number))) + 1
      const summary: GitHubPullRequestSummary = {
        number,
        title: String(value.title ?? "Pull request"),
        state: "OPEN",
        isDraft: value.draft === true,
        headRefName: String(value.head ?? branches.current ?? "feature"),
        baseRefName: String(value.base ?? "main"),
        author: { login: "codex" },
        updatedAt: new Date().toISOString(),
        url: `https://github.com/example/demo/pull/${number}`,
      }
      pullRequests.unshift(summary)
      pullRequestDetails.set(number, {
        ...summary,
        body: String(value.body ?? ""),
        mergeable: "MERGEABLE",
        comments: [],
        commits: [],
        checks: [],
      })
      return json({ number, url: summary.url })
    }

    const pullMatch = url.pathname.match(/^\/github\/pulls\/(\d+)/)
    const pullNumber = Number(pullMatch?.[1])
    const pull = pullRequestDetails.get(pullNumber)
    if (pull && url.pathname.endsWith("/diff") && request.method === "GET") {
      return json("diff --git a/src/app.tsx b/src/app.tsx\n@@ -1 +1 @@\n-old\n+new")
    }
    if (pull && url.pathname.endsWith("/comments") && request.method === "POST") {
      pull.comments.push({
        id: `comment_${pull.comments.length + 1}`,
        body: String(value.body ?? ""),
        author: { login: "codex" },
        createdAt: new Date().toISOString(),
      })
      return json({ success: true })
    }
    if (pull && url.pathname.endsWith("/checkout") && request.method === "POST") {
      setCurrentBranch(pull.headRefName)
      event("vcs.branch.updated", { branch: branches.current })
      return json({ success: true })
    }
    if (pull && url.pathname.endsWith("/close") && request.method === "POST") {
      setPullState(pullNumber, "CLOSED")
      return json({ success: true })
    }
    if (pull && url.pathname.endsWith("/reopen") && request.method === "POST") {
      setPullState(pullNumber, "OPEN")
      return json({ success: true })
    }
    if (pull && url.pathname.endsWith("/merge") && request.method === "POST") {
      setPullState(pullNumber, "MERGED")
      return json({ success: true })
    }
    if (pull && url.pathname === `/github/pulls/${pullNumber}` && request.method === "PATCH") {
      pull.title = String(value.title ?? pull.title)
      pull.body = String(value.body ?? pull.body)
      const summary = pullRequests.find((candidate) => Number(candidate.number) === pullNumber)
      if (summary) summary.title = pull.title
      return json({ success: true })
    }
    if (pull && url.pathname === `/github/pulls/${pullNumber}` && request.method === "GET") return json(pull)
    throw new Error(`Unhandled fake JYYCode request: ${request.method} ${url.pathname}`)
  }

  function setCurrentBranch(name: string) {
    branches.current = name
    for (const branch of branches.branches) branch.current = branch.name === name
    if (!branches.branches.some((branch) => branch.name === name)) {
      branches.branches.push({ name, kind: "local", current: true })
    }
  }

  function setPullState(number: number, state: "OPEN" | "CLOSED" | "MERGED") {
    const detail = pullRequestDetails.get(number)
    if (detail) detail.state = state
    const summary = pullRequests.find((pull) => Number(pull.number) === number)
    if (summary) summary.state = state
  }

  function setTodos(sessionID: string, next: Todo[]) {
    todos.set(sessionID, next)
    event("todo.updated", { sessionID, todos: next })
  }

  function setGitHubStatus(next: GitHubAvailability) {
    githubStatus = next
  }

  return {
    fetch: fetch as typeof globalThis.fetch,
    project,
    sessions,
    messages,
    todos,
    permissions,
    changes,
    branches,
    githubStatus,
    pullRequests,
    pullRequestDetails,
    requests,
    emit,
    setTodos,
    setGitHubStatus,
  }
}
