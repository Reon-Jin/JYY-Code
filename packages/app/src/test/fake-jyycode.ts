import type {
  AppSkillsResponse,
  GitHubAvailability,
  GitHubPullRequestDetail,
  GitHubPullRequestSummary,
  GlobalEvent,
  GlobalCompaction,
  Message,
  McpLocalConfig,
  McpRemoteConfig,
  McpStatus,
  Part,
  PermissionRequest,
  Project,
  SessionBlackboardResponse,
  Session,
  SessionPlanResponse,
  Todo,
  VcsBranches,
  VcsFileDiff,
} from "@jyycode-ai/sdk/v2/client"

const encoder = new TextEncoder()
type PlanEvent = Extract<GlobalEvent["payload"], { type: "plan.runtime.event" }>

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
  const plans = new Map<string, SessionPlanResponse>()
  const blackboards = new Map<string, SessionBlackboardResponse>()
  const permissions: PermissionRequest[] = []
  const skills: AppSkillsResponse = [
    {
      id: "managed:desktop-helper",
      name: "desktop-helper",
      description: "Desktop management fixture",
      location: "C:\\Users\\test\\.jyycode\\skills\\desktop-helper\\SKILL.md",
      content:
        "---\nname: desktop-helper\ndescription: Desktop management fixture\n---\n\n# Desktop Helper\n\nOriginal content.",
      origin: "managed",
      editable: true,
      deletable: true,
      revision: "revision-1",
    },
  ]
  const skillSources = {
    path: [] as string[],
    url: [] as string[],
  }
  const mcpConfigs: Record<string, McpLocalConfig | McpRemoteConfig> = {}
  const mcpStatuses: Record<string, McpStatus> = {}
  const mcpOAuth = new Set<string>()
  let skillRevision = 1
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
  let globalConfig: Record<string, unknown> = {
    default_agent: "build",
    model: "test/test-model",
  }
  const defaultGlobalCompaction = (): GlobalCompaction => ({
    auto: true,
    prune: true,
    tailTurns: 2,
    triggerRatio: 0.92,
    microCompact: true,
    microCompactMaxChars: 8000,
    reactiveCompact: true,
  })
  let globalCompaction = defaultGlobalCompaction()
  let globalUserMemory: Array<Record<string, unknown>> = []
  let globalTaskMemory: Array<Record<string, unknown>> = []
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
  let streamSequence = 0
  let blackboardSequence = 0

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

  function rootSessionIDFor(sessionID: string) {
    const visited = new Set<string>()
    let current = sessions.find((session) => session.id === sessionID)
    while (current?.parentID && !visited.has(current.id)) {
      visited.add(current.id)
      current = sessions.find((session) => session.id === current?.parentID)
    }
    return current?.id ?? sessionID
  }

  function defaultBlackboard(rootSessionID: string): SessionBlackboardResponse {
    return {
      rootSessionID,
      currentStepID: "step_1",
      selectedStepID: "step_1",
      readonly: false,
      tasks: [
        {
          id: "task_1",
          title: "Inspect workspace",
          status: "pending",
          hasAgent: false,
          isSelf: false,
        },
      ],
      messages: [],
      unreadCount: 0,
    }
  }

  function boardFor(rootSessionID: string) {
    const existing = blackboards.get(rootSessionID)
    if (existing) return existing
    const created = defaultBlackboard(rootSessionID)
    blackboards.set(rootSessionID, created)
    return created
  }

  function addSession(overrides: Partial<Session> = {}) {
    const index = sessions.length + 1
    const timestamp = Date.now()
    const { time, ...sessionOverrides } = overrides
    const session: Session = {
      id: `ses_${index}`,
      slug: `session-${index}`,
      projectID: project.id,
      directory,
      title: "New session - 2026-07-13T00:00:00.000Z",
      version: "test",
      ...sessionOverrides,
      time: { created: timestamp, updated: timestamp, ...time },
    }
    sessions.push(session)
    messages.set(session.id, [])
    todos.set(session.id, [])
    if (!session.parentID) boardFor(session.id)
    return session
  }

  function sse(request: Request) {
    let active: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamSequence += 1
        active = controller
        streams.add(controller)
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ directory, payload: { id: `connected_${streamSequence}`, type: "server.connected", properties: {} } })}\n\n`,
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
    if (url.pathname === "/global/management-context") return json({ directory: "C:\\Users\\test" })
    if (url.pathname === "/global/compaction" && request.method === "GET") return json(globalCompaction)
    if (url.pathname === "/global/compaction" && request.method === "PUT") {
      globalCompaction = value as GlobalCompaction
      return json(globalCompaction)
    }
    if (url.pathname === "/global/compaction" && request.method === "DELETE") {
      globalCompaction = defaultGlobalCompaction()
      return json(globalCompaction)
    }
    if (url.pathname === "/global/memory" && request.method === "GET") {
      const entries = url.searchParams.get("scope") === "task" ? globalTaskMemory : globalUserMemory
      return json({ entries, total: entries.length })
    }
    if (url.pathname === "/global/memory/export" && request.method === "GET") {
      const entries = url.searchParams.get("scope") === "task" ? globalTaskMemory : globalUserMemory
      return json({ schemaVersion: 3, lastCompactedAt: null, entries: entries.map(({ id, scope, ...entry }) => entry) })
    }
    if (url.pathname === "/global/memory/user" && request.method === "POST") {
      const entry = { id: `usr_${globalUserMemory.length + 1}`, scope: "user", ...value }
      globalUserMemory = [...globalUserMemory, entry]
      return json(entry)
    }
    if (url.pathname === "/global/memory/task/clear" && request.method === "POST") {
      const removed = globalTaskMemory.length
      globalTaskMemory = []
      return json({ removed })
    }
    const memoryEntry = /^\/global\/memory\/(user|task)\/([^/]+)$/u.exec(url.pathname)
    if (memoryEntry && request.method === "PUT") {
      const collection = memoryEntry[1] === "task" ? globalTaskMemory : globalUserMemory
      const index = collection.findIndex((entry) => entry.id === memoryEntry[2])
      if (index === -1) return json({ message: "Memory entry not found" }, 404)
      const entry = { ...collection[index], ...value }
      collection[index] = entry
      return json(entry)
    }
    if (memoryEntry && request.method === "DELETE") {
      if (memoryEntry[1] === "task") globalTaskMemory = globalTaskMemory.filter((entry) => entry.id !== memoryEntry[2])
      else globalUserMemory = globalUserMemory.filter((entry) => entry.id !== memoryEntry[2])
      return json({ removed: true })
    }
    if (/^\/global\/memory\/(user|task)\/compact$/u.test(url.pathname) && request.method === "POST") {
      const retained = url.pathname.includes("/task/") ? globalTaskMemory.length : globalUserMemory.length
      return json({ removed: 0, merged: 0, retained })
    }
    if (url.pathname === "/global/default-permission" && request.method === "GET") {
      const permission = globalConfig.permission
      const entries =
        permission && typeof permission === "object" && !Array.isArray(permission)
          ? Object.entries(permission as Record<string, unknown>)
          : []
      const mode =
        permission === undefined
          ? "auto"
          : entries.length === 1 && entries[0]?.[0] === "*" && entries[0]?.[1] === "ask"
            ? "request"
            : entries.length === 1 && entries[0]?.[0] === "*" && entries[0]?.[1] === "allow"
              ? "full"
              : "custom"
      return json({ mode })
    }
    if (url.pathname === "/global/default-permission" && request.method === "PUT") {
      const mode = value.mode
      if (mode === "auto") delete globalConfig.permission
      if (mode === "request") globalConfig.permission = { "*": "ask" }
      if (mode === "full") globalConfig.permission = { "*": "allow" }
      return json({ mode })
    }
    if (url.pathname === "/global/config" && request.method === "GET") return json(globalConfig)
    if (url.pathname === "/global/config" && request.method === "PATCH") {
      globalConfig = {
        ...globalConfig,
        ...value,
      }
      if (value.shell === "") delete globalConfig.shell
      return json(globalConfig)
    }
    if (url.pathname === "/project/current") return json(project)
    if (url.pathname === "/project/git/init") return json({ ...project, vcs: "git" })

    if (url.pathname === "/agent") {
      return json([
        { name: "build", mode: "primary", permission: [], options: {} },
        { name: "coder", mode: "subagent", model: "test/test-complex", permission: [], options: {} },
      ])
    }
    if (url.pathname === "/config/providers") {
      const provider = {
        id: "test",
        name: "Test",
        source: "config",
        env: [],
        options: {},
        models: {
          "test-model": model(),
          "test-planner": model("test", "test-planner"),
          "test-simple": model("test", "test-simple"),
          "test-complex": model("test", "test-complex"),
          "test-visual": model("test", "test-visual"),
        },
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
        models: {
          "test-model": model(),
          "test-planner": model("test", "test-planner"),
          "test-simple": model("test", "test-simple"),
          "test-complex": model("test", "test-complex"),
          "test-visual": model("test", "test-visual"),
        },
      }
      return json({ all: [provider], connected: ["test"], default: { test: "test-model" } })
    }
    if (url.pathname === "/config") return json({ default_agent: "build", model: "test/test-model" })
    if (url.pathname === "/path") return json({ home: "C:\\Users\\test", state: "state", config: "C:\\config" })

    if (url.pathname === "/skill" && request.method === "GET") return json(skills)
    if (url.pathname === "/skill" && request.method === "POST") {
      skillRevision += 1
      const name = String(value.name ?? "")
      const content = String(value.content ?? "")
      const created: AppSkillsResponse[number] = {
        id: `managed:${name}`,
        name,
        description: typeof value.description === "string" ? value.description : undefined,
        location: `C:\\Users\\test\\.jyycode\\skills\\${name}\\SKILL.md`,
        content,
        origin: "managed",
        editable: true,
        deletable: true,
        revision: `revision-${skillRevision}`,
      }
      skills.push(created)
      return json(created)
    }
    const skillName = decodeURIComponent(url.pathname.match(/^\/skill\/([^/]+)$/)?.[1] ?? "")
    if (skillName && request.method === "PUT") {
      const current = skills.find((skill) => skill.name === skillName)
      if (!current) return json({ name: "SkillNotFoundError", message: "Skill not found" }, 404)
      if (value.revision !== current.revision) {
        return json({ name: "SkillConflictError", message: "Skill revision is stale", revision: current.revision }, 409)
      }
      skillRevision += 1
      current.content = String(value.content ?? current.content)
      current.revision = `revision-${skillRevision}`
      return json(current)
    }
    if (skillName && request.method === "DELETE") {
      const index = skills.findIndex((skill) => skill.name === skillName)
      if (index < 0) return json({ name: "SkillNotFoundError", message: "Skill not found" }, 404)
      skills.splice(index, 1)
      return json(true)
    }
    if (url.pathname === "/skill/source" && request.method === "POST") {
      const type = value.type === "url" ? "url" : "path"
      const source = String(value.value ?? "").trim()
      if (source && !skillSources[type].includes(source)) skillSources[type].push(source)
      return json(true)
    }
    if (url.pathname === "/skill/source" && request.method === "DELETE") {
      const type = value.type === "url" ? "url" : "path"
      const source = String(value.value ?? "").trim()
      skillSources[type] = skillSources[type].filter((item) => item !== source)
      const index = skills.findIndex((skill) => skill.origin === type && skill.source === source)
      if (index >= 0) skills.splice(index, 1)
      return json(true)
    }

    if (url.pathname === "/mcp/config" && request.method === "GET") return json(mcpConfigs)
    if (url.pathname === "/mcp" && request.method === "GET") return json(mcpStatuses)
    const mcpName = decodeURIComponent(url.pathname.match(/^\/mcp\/([^/]+)(?:\/|$)/)?.[1] ?? "")
    if (mcpName && url.pathname.endsWith("/config") && request.method === "PUT") {
      const config = structuredClone(value) as McpLocalConfig | McpRemoteConfig
      mcpConfigs[mcpName] = config
      mcpStatuses[mcpName] = config.enabled === false ? { status: "disabled" } : { status: "connected" }
      return json(config)
    }
    if (mcpName && url.pathname.endsWith("/config") && request.method === "DELETE") {
      if (!mcpConfigs[mcpName]) return json({ name: "NotFoundError", message: "MCP not found" }, 404)
      delete mcpConfigs[mcpName]
      delete mcpStatuses[mcpName]
      mcpOAuth.delete(mcpName)
      return json(true)
    }
    if (mcpName && url.pathname.endsWith("/connect") && request.method === "POST") {
      mcpStatuses[mcpName] = { status: "connected" }
      return json(true)
    }
    if (mcpName && url.pathname.endsWith("/disconnect") && request.method === "POST") {
      mcpStatuses[mcpName] = { status: "disabled" }
      return json(true)
    }
    if (mcpName && url.pathname.endsWith("/auth/authenticate") && request.method === "POST") {
      mcpOAuth.add(mcpName)
      mcpStatuses[mcpName] = { status: "connected" }
      return json(true)
    }
    if (mcpName && url.pathname.endsWith("/auth") && request.method === "DELETE") {
      mcpOAuth.delete(mcpName)
      mcpStatuses[mcpName] = { status: "needs_auth" }
      return json(true)
    }

    if (url.pathname === "/session" && request.method === "POST") {
      const overrides: Partial<Session> = {}
      if (typeof value.title === "string") overrides.title = value.title
      if (typeof value.parentID === "string") overrides.parentID = value.parentID
      if (typeof value.agent === "string") overrides.agent = value.agent
      if (typeof value.model === "object" && value.model !== null) overrides.model = value.model as Session["model"]
      if (typeof value.multiAgent === "boolean") overrides.multiAgent = value.multiAgent
      const session = addSession(overrides)
      event("session.created", { info: session })
      return json(session)
    }
    if (url.pathname === "/session" && request.method === "GET") return json(sessions)
    if (url.pathname === "/session/status") {
      return json(Object.fromEntries(sessions.map((session) => [session.id, { type: "idle" }])))
    }

    const sessionID = url.pathname.match(/^\/session\/([^/]+)/)?.[1]
    if (sessionID && request.method === "PATCH") {
      const session = sessions.find((candidate) => candidate.id === sessionID)
      if (!session) return json({ name: "NotFoundError", message: "Session not found" }, 404)
      if (typeof value.multiAgent === "boolean") session.multiAgent = value.multiAgent
      if (typeof value.title === "string") session.title = value.title
      session.time.updated = Date.now()
      event("session.updated", { sessionID, info: session })
      return json(session)
    }
    if (sessionID && url.pathname.endsWith("/blackboard") && request.method === "GET") {
      const rootID = rootSessionIDFor(sessionID)
      const board = boardFor(rootID)
      const stepID = url.searchParams.get("stepID")
      const taskID = url.searchParams.get("taskID")
      const before = url.searchParams.get("before")
      const limitValue = Number(url.searchParams.get("limit") ?? "50")
      const limit = Number.isFinite(limitValue) ? Math.min(100, Math.max(1, Math.floor(limitValue))) : 50
      let boardMessages = board.messages
      if (stepID) boardMessages = boardMessages.filter((message) => message.stepID === stepID)
      if (taskID) boardMessages = boardMessages.filter((message) => message.taskIDs.includes(taskID))
      if (before) {
        const index = boardMessages.findIndex((message) => message.id === before)
        if (index >= 0) boardMessages = boardMessages.slice(0, index)
      }
      return json({ ...board, messages: boardMessages.slice(-limit) })
    }
    if (sessionID && url.pathname.endsWith("/blackboard") && request.method === "POST") {
      const rootID = rootSessionIDFor(sessionID)
      const board = boardFor(rootID)
      const message = String(value.message ?? "").trim()
      if (!message) return json({ name: "InvalidRequestError", message: "message is required" }, 400)
      const kind = ["info", "risk", "blocker", "decision", "help"].includes(String(value.kind))
        ? (value.kind as "info" | "risk" | "blocker" | "decision" | "help")
        : "info"
      const attachments = Array.isArray(value.attachments)
        ? value.attachments.map((attachment) => {
            const value = String(attachment)
            return { type: /^https?:\/\//u.test(value) ? ("url" as const) : ("path" as const), value }
          })
        : []
      const created = {
        id: `bb_${++blackboardSequence}`,
        rootSessionID: rootID,
        stepID: board.currentStepID,
        ...(typeof value.reply_to === "string" ? { parentMessageID: value.reply_to } : {}),
        authorKind: "user" as const,
        kind,
        body: message,
        mentions: [],
        attachments,
        taskIDs: Array.isArray(value.task_ids) ? value.task_ids.map(String) : [],
        timeCreated: Date.now(),
        replies: [],
      }
      board.messages.push(created)
      board.unreadCount = Number(board.unreadCount) + 1
      event("blackboard.updated", {
        rootSessionID: rootID,
        stepID: created.stepID,
        messageID: created.id,
      })
      return json(created)
    }
    if (sessionID && url.pathname.endsWith("/blackboard/read") && request.method === "POST") {
      const rootID = rootSessionIDFor(sessionID)
      const board = boardFor(rootID)
      if (typeof value.stepID !== "string" || typeof value.throughMessageID !== "string") {
        return json({ name: "InvalidRequestError", message: "stepID and throughMessageID are required" }, 400)
      }
      board.unreadCount = 0
      return json(true)
    }
    if (sessionID && url.pathname.endsWith("/plan") && request.method === "GET") {
      return json(plans.get(sessionID) ?? { plan: null })
    }
    if (sessionID && url.pathname.endsWith("/message") && request.method === "GET") {
      return json(messages.get(sessionID) ?? [])
    }
    if (sessionID && url.pathname.endsWith("/todo") && request.method === "GET") {
      return json(todos.get(sessionID) ?? [])
    }
    if (
      sessionID &&
      (url.pathname.endsWith("/prompt_async") || url.pathname.endsWith("/interrupt-prompt")) &&
      request.method === "POST"
    ) {
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
      const permission: PermissionRequest | undefined = promptText.includes("检查当前工作区")
        ? {
            id: "per_1",
            sessionID,
            permission: "bash",
            patterns: ["git status"],
            metadata: {},
            always: ["git status"],
          }
        : undefined
      if (permission) permissions.push(permission)
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
      if (permission) event("permission.asked", permission as unknown as Record<string, unknown>)
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

  function setPlan(sessionID: string, state: SessionPlanResponse) {
    plans.set(sessionID, structuredClone(state))
  }

  function setBlackboard(rootSessionID: string, state: SessionBlackboardResponse) {
    blackboards.set(rootSessionID, structuredClone(state))
    const latest = state.messages.at(-1)
    event("blackboard.updated", {
      rootSessionID,
      stepID: state.currentStepID,
      messageID: latest?.id ?? "",
    })
  }

  function emitPlan(properties: PlanEvent["properties"]) {
    event("plan.runtime.event", properties)
  }

  function disconnectStreams() {
    for (const stream of [...streams]) {
      streams.delete(stream)
      try {
        stream.error(new Error("test disconnect"))
      } catch {
        // A stream may already be closed by the client.
      }
    }
  }

  function setGitHubStatus(next: GitHubAvailability) {
    githubStatus = next
  }

  return {
    fetch: fetch as typeof globalThis.fetch,
    project,
    skills,
    skillSources,
    mcpConfigs,
    mcpStatuses,
    mcpOAuth,
    sessions,
    addSession,
    messages,
    todos,
    plans,
    blackboards,
    globalConfig: () => structuredClone(globalConfig),
    permissions,
    changes,
    branches,
    githubStatus,
    pullRequests,
    pullRequestDetails,
    requests,
    emit,
    setTodos,
    setPlan,
    setBlackboard,
    emitPlan,
    disconnectStreams,
    setGitHubStatus,
  }
}
