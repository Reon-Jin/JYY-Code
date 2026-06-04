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
  },
]

const THINKING_VARIANTS = ["none", "low", "medium", "high"]

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
  const [thinkingDepth, setThinkingDepth] = createSignal(2)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  const activeModel = createMemo<SelectedModel>(() => {
    const base = parseSelectedModel(selectedModel())
    const variant = THINKING_VARIANTS[thinkingDepth()]
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
    if (!api) return
    try {
      const next = toModels(await api.providers())
      const visible = next.length ? next : FALLBACK_MODELS
      setModels(visible)
      const preferred =
        visible.find((model) => model.modelID === "deepseek-v4-pro") ??
        visible.find((model) => model.modelID === "deepseek-v4-flash-mimo-v2.5") ??
        visible[0]
      if (preferred) setSelectedModel(preferred.id)
    } catch {
      setModels(FALLBACK_MODELS)
      setSelectedModel(FALLBACK_MODELS[0].id)
    }
  }

  async function syncSession(sessionID: string) {
    const api = client()
    if (!api) return
    const [messages, plan, diff] = await Promise.all([api.messages(sessionID), api.todo(sessionID), api.diff(sessionID)])
    sessionActions.setMessages(messages)
    sessionActions.setTaskPlan(plan)
    sessionActions.setFileChanges(diff)
  }

  async function handleSend(text: string) {
    const api = client()
    if (!api || !session.sessionId || session.status === "running") return

    try {
      sessionActions.setSessionStatus("running")
      await api.updateSession(session.sessionId, { multiAgent: multiAgent() })
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
    await api.replyPermission(session.sessionId, messageId, "allow").catch((err) => setError(String(err)))
  }

  async function handleDenyPermission(messageId: string) {
    const api = client()
    if (!api || !session.sessionId) return
    await api.replyPermission(session.sessionId, messageId, "deny").catch((err) => setError(String(err)))
  }

  function handleFileSelect(files: string[]) {
    files.forEach((file) => sessionActions.addContextFile(file))
  }

  return (
    <div class="session-screen">
      <Toolbar
        model={selectedModel()}
        models={models()}
        onModelChange={setSelectedModel}
        multiAgent={multiAgent()}
        onMultiAgentChange={setMultiAgent}
        onFileSelect={handleFileSelect}
        permissions={permissions()}
        onPermissionChange={setPermissions}
        thinkingDepth={thinkingDepth()}
        onThinkingDepthChange={setThinkingDepth}
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
