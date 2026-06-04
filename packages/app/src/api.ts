import type {
  FileChange,
  Message,
  MessagePart,
  ModelInfo,
  SessionInfo,
  TaskPlan,
  TaskStep,
  ToolCallPart,
} from "./types/models"

type Json = Record<string, unknown>

type LegacySession = {
  id: string
  title: string
  projectID?: string
  directory: string
  path?: string
  agent?: string
  model?: { id?: string; providerID?: string; variant?: string }
  multiAgent?: boolean
  summary?: { additions?: number; deletions?: number; files?: number; diffs?: SnapshotDiff[] }
  time: { created: number; updated: number; archived?: number; compacting?: number }
}

type LegacyMessage = {
  info: {
    id: string
    role: "user" | "assistant"
    time: { created: number; completed?: number }
    agent?: string
    model?: { providerID: string; modelID: string; variant?: string }
    providerID?: string
    modelID?: string
    cost?: number
    error?: { name?: string; message?: string; data?: { message?: string } }
  }
  parts: LegacyPart[]
}

type LegacyPart =
  | { id: string; messageID: string; type: "text"; text: string; time?: { start?: number; end?: number } }
  | { id: string; messageID: string; type: "reasoning"; text: string; time?: { start?: number; end?: number } }
  | {
      id: string
      messageID: string
      type: "tool"
      tool: string
      callID: string
      state:
        | { status: "pending"; input?: Json; raw?: string }
        | { status: "running"; input: Json; title?: string; time?: { start?: number } }
        | { status: "completed"; input: Json; output: string; title?: string; time?: { start?: number; end?: number } }
        | { status: "error"; input: Json; error: string; time?: { start?: number; end?: number } }
    }
  | { id: string; messageID: string; type: "file"; filename?: string; url: string; mime: string }
  | { id: string; messageID: string; type: "subtask"; description: string; agent: string; prompt: string }
  | { id: string; messageID: string; type: string }

type ProviderList = {
  all: Array<{
    id: string
    name: string
    connected?: boolean
    models: Record<
      string,
      {
        id: string
        name: string
        providerID: string
        limit?: { context?: number }
        capabilities?: { reasoning?: boolean; toolcall?: boolean; attachment?: boolean }
        variants?: Record<string, Json>
      }
    >
  }>
  default?: Record<string, string>
  connected?: string[]
}

type SnapshotDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "modified" | "deleted"
}

type Todo = {
  content: string
  status: string
  priority: string
}

export type SelectedModel = {
  value: string
  providerID: string
  modelID: string
  variant?: string
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly directory?: string,
  ) {}

  async health() {
    return this.get<{ status?: string }>("/global/health")
  }

  async providers() {
    return this.get<ProviderList>("/provider")
  }

  async sessions() {
    const sessions = await this.get<LegacySession[]>("/session", { roots: "true", limit: "100" })
    return sessions.map(toSessionInfo)
  }

  async createSession(input: { title?: string; model?: SelectedModel; agent?: string; multiAgent?: boolean }) {
    const body = {
      title: input.title,
      agent: input.agent,
      multiAgent: input.multiAgent,
      model: input.model
        ? { id: input.model.modelID, providerID: input.model.providerID, variant: input.model.variant }
        : undefined,
    }
    return toSessionInfo(await this.post<LegacySession>("/session", body))
  }

  async updateSession(sessionID: string, input: { multiAgent?: boolean; title?: string }) {
    return toSessionInfo(await this.patch<LegacySession>(`/session/${sessionID}`, input))
  }

  async messages(sessionID: string) {
    const messages = await this.get<LegacyMessage[]>(`/session/${sessionID}/message`, { limit: "100" })
    return messages.map(toMessage)
  }

  async todo(sessionID: string) {
    const todos = await this.get<Todo[]>(`/session/${sessionID}/todo`)
    return toTaskPlan(todos)
  }

  async diff(sessionID: string) {
    const diffs = await this.get<SnapshotDiff[]>(`/session/${sessionID}/diff`)
    return diffs.map(toFileChange)
  }

  async promptAsync(input: {
    sessionID: string
    text: string
    model: SelectedModel
    agent?: string
    multiAgent: boolean
    files: string[]
  }) {
    const parts: Json[] = [
      ...input.files.map((file) => ({
        type: "file",
        url: pathToFileUrl(file),
        filename: file.split(/[\\/]/).pop() ?? file,
        mime: "text/plain",
      })),
      { type: "text", text: input.text },
    ]
    await this.postNoContent(`/session/${input.sessionID}/prompt_async`, {
      agent: input.agent,
      model: { providerID: input.model.providerID, modelID: input.model.modelID },
      variant: input.model.variant,
      agentCluster: { enabled: input.multiAgent },
      parts,
    })
  }

  async abort(sessionID: string) {
    await this.postNoContent(`/session/${sessionID}/abort`, undefined)
  }

  async replyPermission(sessionID: string, permissionID: string, response: "allow" | "deny") {
    await this.postNoContent(`/session/${sessionID}/permissions/${permissionID}`, { response })
  }

  eventUrl() {
    return this.url("/event")
  }

  private async get<T>(path: string, query?: Record<string, string>) {
    return this.request<T>(path, { method: "GET" }, query)
  }

  private async post<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) })
  }

  private async patch<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: "PATCH", body: JSON.stringify(body) })
  }

  private async postNoContent(path: string, body: unknown) {
    await this.request<unknown>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) })
  }

  private async request<T>(path: string, init: RequestInit, query?: Record<string, string>) {
    const res = await fetch(this.url(path, query), {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    })
    if (!res.ok) {
      throw new Error(`${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  private url(path: string, query: Record<string, string> = {}) {
    const url = new URL(path, this.baseUrl)
    if (this.directory) url.searchParams.set("directory", this.directory)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    return url.toString()
  }
}

export function parseSelectedModel(value: string): SelectedModel {
  const [modelRef, variant] = value.split("::")
  const slash = modelRef.indexOf("/")
  return {
    value,
    providerID: slash === -1 ? "jyycode" : modelRef.slice(0, slash),
    modelID: slash === -1 ? modelRef : modelRef.slice(slash + 1),
    variant: variant || undefined,
  }
}

export function toModelValue(model: { providerID: string; modelID?: string; id?: string; variant?: string }) {
  const id = model.modelID ?? model.id ?? ""
  return `${model.providerID}/${id}${model.variant && model.variant !== "default" ? `::${model.variant}` : ""}`
}

export function toModels(list: ProviderList): ModelInfo[] {
  const connected = new Set(list.connected ?? [])
  const models = list.all.flatMap((provider) =>
    Object.values(provider.models).flatMap((model) => {
      const variants = model.variants && Object.keys(model.variants).length > 0 ? Object.keys(model.variants) : [""]
      return variants.map((variant) => ({
        id: toModelValue({ providerID: provider.id, modelID: model.id, variant: variant || undefined }),
        modelID: model.id,
        providerID: provider.id,
        name: variant ? `${model.name} · ${variant}` : model.name,
        provider: provider.name || provider.id,
        maxTokens: model.limit?.context ?? 0,
        supportsReasoning: Boolean(model.capabilities?.reasoning),
        supportsTools: model.capabilities?.toolcall !== false,
        connected: connected.has(provider.id),
      }))
    }),
  )

  const preferred = ["deepseek-v4-pro", "deepseek-v4-flash-mimo-v2.5"]
  return models.sort((a, b) => {
    const ai = preferred.indexOf(a.modelID)
    const bi = preferred.indexOf(b.modelID)
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    if (a.connected !== b.connected) return a.connected ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export function toMessage(input: LegacyMessage): Message {
  return {
    id: input.info.id,
    role: input.info.role,
    timestamp: input.info.time.created,
    parts: input.parts.map(toPart).filter((part): part is MessagePart => Boolean(part)),
  }
}

export function mergeMessageParts(message: Message | undefined, part: LegacyPart): Message {
  const base: Message = message ?? {
    id: part.messageID,
    role: "assistant",
    timestamp: Date.now(),
    parts: [],
  }
  const next = toPart(part)
  if (!next) return base
  const idx = base.parts.findIndex((item) => partKey(item) === partKey(next))
  const parts = [...base.parts]
  if (idx >= 0) parts[idx] = next
  else parts.push(next)
  return { ...base, parts }
}

export function appendPartDelta(message: Message | undefined, input: { messageID: string; partID: string; delta: string }) {
  if (!message) return message
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (!("id" in part) || part.id !== input.partID) return part
      if (part.type === "text") return { ...part, content: part.content + input.delta }
      if (part.type === "reasoning") return { ...part, content: part.content + input.delta }
      return part
    }),
  }
}

function toPart(part: LegacyPart): MessagePart | undefined {
  if (part.type === "text") return { id: part.id, type: "text", content: part.text }
  if (part.type === "reasoning") return { id: part.id, type: "reasoning", content: part.text, collapsed: false }
  if (part.type === "tool") {
    const state = part.state
    return {
      id: part.id,
      type: "tool_call",
      toolName: normalizeToolName(part.tool),
      toolInput: "input" in state && state.input ? state.input : {},
      toolOutput: "output" in state ? state.output : "error" in state ? state.error : undefined,
      status: state.status,
      elapsed:
        "time" in state && state.time?.start && state.time.end ? (state.time.end - state.time.start) / 1000 : undefined,
    }
  }
  if (part.type === "subtask") {
    return {
      id: part.id,
      type: "tool_call",
      toolName: "task",
      toolInput: { agent: part.agent, description: part.description, prompt: part.prompt },
      status: "running",
    }
  }
  return undefined
}

function partKey(part: MessagePart) {
  return "id" in part && part.id ? part.id : `${part.type}:${part.type === "tool_call" ? part.toolName : ""}`
}

function normalizeToolName(tool: string): ToolCallPart["toolName"] {
  if (tool === "bash") return "shell"
  if (tool === "apply_patch") return "apply_patch"
  if (tool === "edit") return "edit"
  if (tool === "write") return "write"
  if (tool === "read") return "read"
  if (tool === "grep") return "grep"
  if (tool === "glob") return "glob"
  if (tool === "webfetch") return "web_fetch"
  if (tool === "websearch") return "web_search"
  if (tool === "task") return "task"
  if (tool === "question") return "question"
  if (tool === "skill") return "skill"
  return "shell"
}

function toSessionInfo(session: LegacySession): SessionInfo {
  return {
    id: session.id,
    title: cleanTitle(session.title),
    projectId: session.projectID ?? session.directory,
    model: session.model ? toModelValue(session.model) : "",
    agent: session.agent ?? "build",
    status: session.time.compacting ? "running" : "idle",
    createdAt: session.time.created,
    updatedAt: session.time.updated,
    messageCount: 0,
  }
}

function cleanTitle(title: string) {
  return title.replace(/^New session - /, "Untitled ").replace(/^Child session - /, "Child ")
}

function toTaskPlan(todos: Todo[]): TaskPlan | null {
  if (todos.length === 0) return null
  const steps: TaskStep[] = todos.map((todo, index) => ({
    id: `${index}-${todo.content}`,
    title: todo.content,
    detail: todo.priority ? `Priority: ${todo.priority}` : undefined,
    status:
      todo.status === "completed"
        ? "completed"
        : todo.status === "in_progress"
          ? "running"
          : todo.status === "cancelled"
            ? "failed"
            : "pending",
  }))
  const currentStepIndex = Math.max(
    0,
    steps.findIndex((step) => step.status === "running" || step.status === "pending"),
  )
  return { steps, currentStepIndex, totalSteps: steps.length }
}

function toFileChange(diff: SnapshotDiff): FileChange {
  return {
    filePath: diff.file ?? "unknown",
    status: diff.status ?? "modified",
    additions: diff.additions,
    deletions: diff.deletions,
    hunks: [],
    patch: diff.patch,
  }
}

function pathToFileUrl(file: string) {
  const normalized = file.replaceAll("\\", "/")
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`
  return `file://${encodeURI(absolute)}`
}
