import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { parseSelectedModel, toModels, type SelectedModel } from "../api"
import { Toolbar } from "../components/session/Toolbar"
import { MessageList } from "../components/session/MessageList"
import { InputArea } from "../components/session/InputArea"
import { RightPanel } from "../components/rightpanel/RightPanel"
import { appActions } from "../stores/app"
import { sessionActions, useSessionStore } from "../stores/session"
import { useSDK } from "../hooks/useSDK"
import { useSSE } from "../hooks/useSSE"
import type { ModelInfo, PermissionRule } from "../types/models"

const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: "jyycode/deepseek-v4-pro",
    providerID: "jyycode",
    modelID: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "JYYCode",
    maxTokens: 128000,
    supportsReasoning: true,
    supportsTools: true,
    connected: true,
    variants: ["low", "medium", "high"],
  },
  {
    id: "jyycode/deepseek-v4-flash-mimo-v2.5",
    providerID: "jyycode",
    modelID: "deepseek-v4-flash-mimo-v2.5",
    name: "DeepSeek V4 Flash MIMO v2.5",
    provider: "JYYCode",
    maxTokens: 128000,
    supportsReasoning: true,
    supportsTools: true,
    connected: true,
    variants: ["low", "medium", "high"],
  },
]

export function SessionPage() {
  const params = useParams()
  const navigate = useNavigate()
  const session = useSessionStore()
  const client = useSDK()
  const { connected, connect, disconnect } = useSSE()

  const [models, setModels] = createSignal<ModelInfo[]>(FALLBACK_MODELS)
  const [selectedModel, setSelectedModel] = createSignal(FALLBACK_MODELS[0].id)
  const [multiAgent, setMultiAgent] = createSignal(false)
  const [permissions, setPermissions] = createSignal<PermissionRule[]>([])
  const [thinkingDepth, setThinkingDepth] = createSignal(0)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  const selectedModelInfo = createMemo(() => models().find((model) => model.id === selectedModel()))
  const thinkingVariants = createMemo(() => selectedModelInfo()?.variants ?? [])
  const activeModel = createMemo<SelectedModel>(() => {
    const base = parseSelectedModel(selectedModel())
    const variant = thinkingDepth() === 0 ? undefined : thinkingVariants()[thinkingDepth() - 1]
    return { ...base, value: `${base.providerID}/${base.modelID}${variant ? `::${variant}` : ""}`, variant }
  })

  onMount(() => {
    void bootstrap()
  })

  createEffect(() => {
    const id = session.sessionId
    if (!id) return
    connect(id)
  })

  onCleanup(() => {
    disconnect()
  })

  async function bootstrap() {
    const api = client()
    if (!api) {
      setLoading(false)
      setError("Please open a project first.")
      return
    }

    setLoading(true)
    setError(null)
    try {
      await loadModels()
      let sessionID = params.id
      if (sessionID === "new") {
        const created = await api.createSession({
          title: "New task",
          model: activeModel(),
          multiAgent: multiAgent(),
          agent: "build",
        })
        appActions.addSession(created)
        appActions.setActiveSession(created.id)
        sessionID = created.id
        navigate(`/session/${created.id}`, { replace: true })
      }
      if (!sessionID) throw new Error("Missing session id")

      sessionActions.resetSession()
      sessionActions.setSession(sessionID, "idle")
      appActions.setActiveSession(sessionID)
      await syncSession(sessionID)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      sessionActions.setSessionStatus("error")
    } finally {
      setLoading(false)
    }
  }

  async function loadModels() {
    const api = client()
    if (!api) return FALLBACK_MODELS
    try {
      const next = toModels(await api.providers())
      const visible = next.length ? next : FALLBACK_MODELS
      setModels(visible)
      const preferred =
        visible.find((model) => model.modelID === "deepseek-v4-pro") ??
        visible.find((model) => model.modelID === "deepseek-v4-flash-mimo-v2.5") ??
        visible[0]
      if (preferred) setSelectedModel(preferred.id)
      return visible
    } catch {
      setModels(FALLBACK_MODELS)
      setSelectedModel(FALLBACK_MODELS[0].id)
      return FALLBACK_MODELS
    }
  }

  async function syncSession(sessionID: string) {
    const api = client()
    if (!api) return
    const [info, messages, plan, diff, pendingPermissions] = await Promise.all([
      api.session(sessionID),
      api.messages(sessionID),
      api.todo(sessionID),
      api.diff(sessionID),
      api.permissions(),
    ])
    appActions.addSession(info)
    setMultiAgent(Boolean(info.multiAgent))
    setPermissions(info.permission ?? [])
    applySessionModel(info.model)
    sessionActions.setMessages(messages)
    sessionActions.setTaskPlan(plan)
    sessionActions.setFileChanges(diff)
    for (const request of pendingPermissions.filter((request) => request.sessionID === sessionID)) {
      sessionActions.updateMessagePart(request.tool?.messageID ?? `permission-${request.id}`, {
        id: request.id,
        type: "permission_request",
        toolName: request.permission,
        message: request.patterns.join(", ") || "Permission required",
        status: "pending",
        patterns: request.patterns,
        always: request.always,
        metadata: request.metadata,
      })
    }
  }

  async function handleSend(text: string) {
    const api = client()
    if (!api || !session.sessionId || session.status === "running") return

    try {
      sessionActions.setSessionStatus("running")
      await api.updateSession(session.sessionId, { multiAgent: multiAgent(), permission: permissions() })
      await api.promptAsync({
        sessionID: session.sessionId,
        text,
        model: activeModel(),
        agent: "build",
        multiAgent: multiAgent(),
        files: session.contextFiles,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      sessionActions.setSessionStatus("error")
    }
  }

  async function handleApprovePermission(messageId: string) {
    const api = client()
    if (!api || !session.sessionId) return
    await api.replyPermission(messageId, "once").catch((err) => setError(String(err)))
  }

  async function handleDenyPermission(messageId: string) {
    const api = client()
    if (!api || !session.sessionId) return
    await api.replyPermission(messageId, "reject").catch((err) => setError(String(err)))
  }

  function handleFileSelect(files: string[]) {
    files.forEach((file) => sessionActions.addContextFile(file))
  }

  async function handleMultiAgentChange(enabled: boolean) {
    setMultiAgent(enabled)
    const api = client()
    if (!api || !session.sessionId) return
    try {
      const info = await api.updateSession(session.sessionId, { multiAgent: enabled })
      appActions.addSession(info)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handlePermissionChange(rules: PermissionRule[]) {
    setPermissions(rules)
    const api = client()
    if (!api || !session.sessionId) return
    try {
      const info = await api.updateSession(session.sessionId, { permission: rules })
      appActions.addSession(info)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function handleModelChange(modelId: string) {
    setSelectedModel(modelId)
    setThinkingDepth(0)
  }

  function applySessionModel(value: string) {
    if (!value) return
    const parsed = parseSelectedModel(value)
    const base = `${parsed.providerID}/${parsed.modelID}`
    if (models().some((model) => model.id === base)) {
      setSelectedModel(base)
      const variants = models().find((model) => model.id === base)?.variants ?? []
      const index = parsed.variant ? variants.indexOf(parsed.variant) : -1
      setThinkingDepth(index >= 0 ? index + 1 : 0)
    }
  }

  return (
    <div class="session-screen">
      <Toolbar
        model={selectedModel()}
        models={models()}
        onModelChange={handleModelChange}
        multiAgent={multiAgent()}
        onMultiAgentChange={handleMultiAgentChange}
        onFileSelect={handleFileSelect}
        permissions={permissions()}
        onPermissionChange={handlePermissionChange}
        thinkingDepth={thinkingDepth()}
        onThinkingDepthChange={setThinkingDepth}
        thinkingVariants={thinkingVariants()}
        sessionTitle={session.sessionId ? `Task / ${session.sessionId.slice(-8)}` : "New task"}
        connected={connected()}
      />

      <Show when={error()}>
        <div class="app-error">{error()}</div>
      </Show>

      <div class="session-main">
        <div class="chat-pane">
          <Show when={!loading()} fallback={<div class="loading-state">Loading session...</div>}>
            <MessageList
              messages={session.messages}
              streamingMessageId={session.streamingMessageId}
              onApprovePermission={handleApprovePermission}
              onDenyPermission={handleDenyPermission}
            />
            <InputArea onSend={handleSend} disabled={session.status === "running"} />
          </Show>
        </div>
        <RightPanel taskPlan={session.taskPlan} fileChanges={session.fileChanges} />
      </div>
    </div>
  )
}
