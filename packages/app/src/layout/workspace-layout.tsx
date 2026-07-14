import type { Session, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import { useNavigate } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { House, PanelLeftClose, PanelLeftOpen, Plus, Radio } from "lucide-solid"
import { createEffect, createMemo, createSignal, on, Show, type JSX } from "solid-js"
import { Button, IconButton } from "../components/ui/button"
import { InlineError } from "../components/ui/inline-error"
import { useData } from "../data/context"
import type { ConnectionState } from "../data/event-bridge"
import { keys } from "../data/query-keys"
import { errorMessage } from "../features/projects/project-controller"
import { ReconnectBanner } from "../features/lifecycle/reconnect-banner"
import { useProjects } from "../features/projects/project-context"
import { conversationQueryOptions } from "../features/conversation/conversation-query"
import type { ConversationSnapshot } from "../features/conversation/conversation-state"
import { MessageTimeline } from "../features/conversation/message-timeline"
import { Composer } from "../features/composer/composer"
import { BranchControl } from "../features/git/branch-control"
import {
  loadComposerPreference,
  loadModelCatalog,
  saveComposerPreference,
  type ModelSelection,
} from "../features/composer/model-catalog"
import { ProviderEmpty } from "../features/composer/provider-empty"
import { PermissionBar } from "../features/requests/permission-bar"
import { QuestionPanel } from "../features/requests/question-panel"
import {
  loadInspectorPreferences,
  saveInspectorPreferences,
  type InspectorPreferences,
} from "../features/workspace-inspector/inspector-preferences"
import { WorkspaceInspector } from "../features/workspace-inspector/workspace-inspector"
import { permissionQueryOptions, questionQueryOptions, selectActiveRequest } from "../features/requests/request-query"
import { createSessionApi } from "../features/sessions/session-api"
import { SessionEmpty } from "../features/sessions/session-empty"
import { SessionList } from "../features/sessions/session-list"
import { useDesktopBridge } from "../platform/context"
import "../features/sessions/sessions.css"

type AsyncSessionAction = (sessionID: string) => Promise<void>

export type WorkspaceLayoutViewProps = {
  projectName: string
  projectDirectory: string
  connection: ConnectionState
  activeSessions: readonly Session[]
  archivedSessions: readonly Session[]
  statuses: Record<string, SessionStatus>
  conversation?: ConversationSnapshot
  activeSessionID?: string
  activeLoading?: boolean
  archivedLoading?: boolean
  conversationLoading?: boolean
  activeError?: string
  archivedError?: string
  conversationError?: string
  operationError?: string
  requestArea?: JSX.Element
  composer?: JSX.Element
  inspector?: JSX.Element
  inspectorOpen?: boolean
  busy?: boolean
  onRetryActive?: () => void
  onRetryArchived?: () => void
  onRetryConversation?: () => void
  onReturnHome: () => Promise<void>
  onCreate: () => Promise<void>
  onRename: (sessionID: string, title: string) => Promise<void>
  onArchive: AsyncSessionAction
  onDelete: AsyncSessionAction
}

function connectionLabel(connection: ConnectionState) {
  switch (connection) {
    case "connected":
      return "后端已连接"
    case "disconnected":
      return "连接已中断"
    default:
      return "正在连接后端"
  }
}

function startsNarrow() {
  return typeof window !== "undefined" && window.matchMedia?.("(max-width: 960px)").matches === true
}

export function WorkspaceLayoutView(props: WorkspaceLayoutViewProps) {
  const [filter, setFilter] = createSignal<"active" | "archived">("active")
  const [railOpen, setRailOpen] = createSignal(!startsNarrow())
  const selected = createMemo(() =>
    [...props.activeSessions, ...props.archivedSessions].find((session) => session.id === props.activeSessionID),
  )
  const list = () => (filter() === "active" ? props.activeSessions : props.archivedSessions)
  const listLoading = () => (filter() === "active" ? props.activeLoading : props.archivedLoading)
  const listError = () => (filter() === "active" ? props.activeError : props.archivedError)
  const retry = () => (filter() === "active" ? props.onRetryActive : props.onRetryArchived)

  function closeNarrowRail() {
    if (startsNarrow()) setRailOpen(false)
  }

  return (
    <div
      class="workspace-shell"
      data-rail-open={railOpen() ? "true" : "false"}
      data-inspector-open={props.inspectorOpen ? "true" : "false"}
    >
      <aside
        id="session-navigation"
        class="workspace-rail"
        aria-label="项目与 Session 导航"
        aria-hidden={railOpen() ? "false" : "true"}
        inert={!railOpen() ? true : undefined}
      >
        <header class="workspace-project">
          <span class="workspace-project__mark" aria-hidden="true">
            J
          </span>
          <span class="workspace-project__copy">
            <strong>{props.projectName}</strong>
            <small>{props.projectDirectory}</small>
          </span>
          <IconButton
            label="返回项目首页"
            variant="secondary"
            disabled={props.busy}
            onClick={() => void props.onReturnHome()}
          >
            <House aria-hidden="true" />
          </IconButton>
        </header>

        <div class="workspace-rail__toolbar">
          <Button class="workspace-new-session" disabled={props.busy} onClick={() => void props.onCreate()}>
            <Plus aria-hidden="true" />
            新建 Session
          </Button>
          <div class="session-filter" aria-label="Session 显示范围">
            <button type="button" aria-pressed={filter() === "active"} onClick={() => setFilter("active")}>
              活动 <span>{props.activeSessions.length}</span>
            </button>
            <button type="button" aria-pressed={filter() === "archived"} onClick={() => setFilter("archived")}>
              归档 <span>{props.archivedSessions.length}</span>
            </button>
          </div>
        </div>

        <SessionList
          sessions={list()}
          statuses={props.statuses}
          activeSessionID={props.activeSessionID}
          archived={filter() === "archived"}
          loading={listLoading()}
          error={listError()}
          disabled={props.busy}
          onRetry={retry()}
          onNavigate={closeNarrowRail}
          onRename={props.onRename}
          onArchive={props.onArchive}
          onDelete={props.onDelete}
        />

        <footer class="workspace-connection" data-state={props.connection} role="status" aria-live="polite">
          <Radio aria-hidden="true" />
          <span>{connectionLabel(props.connection)}</span>
        </footer>
      </aside>

      <IconButton
        class="workspace-rail-toggle"
        label={railOpen() ? "收起 Session 导航" : "展开 Session 导航"}
        variant="secondary"
        aria-controls="session-navigation"
        aria-expanded={railOpen()}
        onClick={() => setRailOpen((open) => !open)}
      >
        <Show when={railOpen()} fallback={<PanelLeftOpen aria-hidden="true" />}>
          <PanelLeftClose aria-hidden="true" />
        </Show>
      </IconButton>

      <main class="workspace-main">
        <Show when={props.operationError}>{(message) => <InlineError message={message()} />}</Show>
        <Show
          when={props.activeSessionID}
          fallback={
            <SessionEmpty disabled={props.busy || props.activeLoading} onCreate={() => void props.onCreate()} />
          }
        >
          <section class="workspace-conversation" aria-labelledby="workspace-session-title">
            <header class="workspace-conversation__header">
              <span>Single Agent</span>
              <h1 id="workspace-session-title">{selected()?.title ?? "Session"}</h1>
            </header>
            <Show when={props.connection === "connected" ? undefined : props.connection} keyed>
              {(state) => <ReconnectBanner state={state} />}
            </Show>
            <MessageTimeline
              messages={props.conversation?.messages ?? []}
              loading={props.conversationLoading}
              error={props.conversationError}
              onRetry={props.onRetryConversation}
            />
            <div class="workspace-conversation__footer">
              {props.requestArea}
              {props.composer}
            </div>
          </section>
        </Show>
      </main>
      {props.inspector}
    </div>
  )
}

export function WorkspaceLayout(props: { activeSessionID?: string }) {
  const data = useData()
  const desktop = useDesktopBridge()
  const projects = useProjects()
  const navigate = useNavigate()
  const [operationError, setOperationError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [selectedAgent, setSelectedAgent] = createSignal<string>()
  const [selectedModel, setSelectedModel] = createSignal<ModelSelection>()
  const [inspectorPreferences, setInspectorPreferences] = createSignal<InspectorPreferences>(
    loadInspectorPreferences(data.directory()),
  )
  const api = createMemo(() =>
    createSessionApi({ client: data.client(), directory: data.directory(), queryClient: data.queryClient() }),
  )
  const activeQuery = createQuery(
    () => ({ queryKey: keys.sessions(data.directory()), queryFn: () => api().list(false) }),
    data.queryClient,
  )
  const archivedQuery = createQuery(
    () => ({ queryKey: keys.sessions(data.directory(), true), queryFn: () => api().list(true) }),
    data.queryClient,
  )
  const statusQuery = createQuery(
    () => ({ queryKey: keys.status(data.directory()), queryFn: () => api().status() }),
    data.queryClient,
  )
  const conversationQuery = createQuery(
    () => ({
      ...conversationQueryOptions({
        client: data.client(),
        directory: data.directory(),
        sessionID: props.activeSessionID ?? "",
        queryClient: data.queryClient(),
      }),
      enabled: Boolean(props.activeSessionID),
    }),
    data.queryClient,
  )
  const permissionsQuery = createQuery(
    () => ({
      ...permissionQueryOptions({ client: data.client(), directory: data.directory() }),
      enabled: Boolean(props.activeSessionID),
    }),
    data.queryClient,
  )
  const questionsQuery = createQuery(
    () => ({
      ...questionQueryOptions({ client: data.client(), directory: data.directory() }),
      enabled: Boolean(props.activeSessionID),
    }),
    data.queryClient,
  )
  const catalogQuery = createQuery(
    () => ({
      queryKey: [...keys.project(data.directory()), "composer-catalog"] as const,
      queryFn: () =>
        loadModelCatalog({
          client: data.client(),
          directory: data.directory(),
          preference: loadComposerPreference(),
        }),
    }),
    data.queryClient,
  )

  createEffect(
    on(
      () => catalogQuery.data,
      (catalog) => {
        if (!catalog) return
        setSelectedAgent(catalog.selectedAgent)
        setSelectedModel(catalog.selectedModel)
      },
    ),
  )

  createEffect(
    on(
      () => data.directory(),
      (directory) => setInspectorPreferences(loadInspectorPreferences(directory)),
    ),
  )

  function updateInspectorPreferences(update: Partial<InspectorPreferences>) {
    const next = { ...inspectorPreferences(), ...update }
    setInspectorPreferences(next)
    saveInspectorPreferences(data.directory(), next)
  }

  const projectName = createMemo(() => {
    const project = projects.activeProject()
    if (project?.info.name) return project.info.name
    const parts = data.directory().replaceAll("/", "\\").split("\\").filter(Boolean)
    return parts.at(-1) ?? "JYYCode"
  })

  function nextActive(excluding: string) {
    return activeQuery.data?.find((session) => session.id !== excluding)
  }

  async function createNewSession() {
    setBusy(true)
    setOperationError(undefined)
    try {
      const session = await api().create({})
      navigate(`/session/${encodeURIComponent(session.id)}`)
    } catch (cause) {
      setOperationError(errorMessage(cause, "无法创建 Session"))
    } finally {
      setBusy(false)
    }
  }

  async function returnHome() {
    setBusy(true)
    setOperationError(undefined)
    try {
      await projects.returnToProjectSelection()
      navigate("/")
    } catch (cause) {
      setOperationError(errorMessage(cause, "无法返回项目首页"))
    } finally {
      setBusy(false)
    }
  }

  async function rename(sessionID: string, title: string) {
    await api().rename(sessionID, title)
  }

  async function archive(sessionID: string) {
    const next = nextActive(sessionID)
    await api().archive(sessionID)
    if (props.activeSessionID === sessionID) navigate(next ? `/session/${encodeURIComponent(next.id)}` : "/")
  }

  async function remove(sessionID: string) {
    const next = nextActive(sessionID)
    await api().remove(sessionID)
    if (props.activeSessionID === sessionID) navigate(next ? `/session/${encodeURIComponent(next.id)}` : "/")
  }

  function changeAgent(agent: string) {
    setSelectedAgent(agent)
    saveComposerPreference({ agent, model: selectedModel() })
  }

  function changeModel(model: ModelSelection) {
    setSelectedModel(model)
    saveComposerPreference({ agent: selectedAgent(), model })
  }

  const lastMessageError = createMemo(() => {
    const messages = conversationQuery.data?.messages ?? []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const info = messages[index]!.info
      if (info.role === "assistant" && info.error) return info.error
    }
    return undefined
  })
  const activeRequest = createMemo(() =>
    selectActiveRequest(permissionsQuery.data ?? [], questionsQuery.data ?? [], props.activeSessionID),
  )
  const requestError = createMemo(() => {
    if (permissionsQuery.error) return errorMessage(permissionsQuery.error, "无法加载权限请求")
    if (questionsQuery.error) return errorMessage(questionsQuery.error, "无法加载 Agent 问题")
    return undefined
  })
  let persistedLocation = ""
  createEffect(() => {
    if (activeQuery.isPending || archivedQuery.isPending || activeQuery.error || archivedQuery.error) return
    const sessionID = props.activeSessionID
    if (
      sessionID &&
      ![...(activeQuery.data ?? []), ...(archivedQuery.data ?? [])].some((session) => session.id === sessionID)
    ) {
      return
    }
    const location = { project: data.directory(), ...(sessionID ? { sessionID } : {}) }
    const signature = JSON.stringify(location)
    if (signature === persistedLocation) return
    persistedLocation = signature
    void desktop.saveLastLocation(location).catch(() => {
      persistedLocation = ""
    })
  })

  return (
    <WorkspaceLayoutView
      projectName={projectName()}
      projectDirectory={data.directory()}
      connection={data.connection()}
      activeSessions={activeQuery.data ?? []}
      archivedSessions={archivedQuery.data ?? []}
      statuses={statusQuery.data ?? {}}
      conversation={conversationQuery.data}
      activeSessionID={props.activeSessionID}
      activeLoading={activeQuery.isPending}
      archivedLoading={archivedQuery.isPending}
      conversationLoading={Boolean(props.activeSessionID) && conversationQuery.isPending}
      activeError={activeQuery.error ? errorMessage(activeQuery.error, "无法加载活动 Session") : undefined}
      archivedError={archivedQuery.error ? errorMessage(archivedQuery.error, "无法加载归档 Session") : undefined}
      conversationError={
        conversationQuery.error ? errorMessage(conversationQuery.error, "无法加载 Session 消息") : undefined
      }
      operationError={operationError()}
      requestArea={
        <Show
          when={!requestError()}
          fallback={
            <div class="request-panel">
              <InlineError message={requestError()!} />
            </div>
          }
        >
          <Show when={activeRequest()} keyed>
            {(pending) =>
              pending.type === "permission" ? (
                <PermissionBar client={data.client()} directory={data.directory()} request={pending.request} />
              ) : (
                <QuestionPanel client={data.client()} directory={data.directory()} request={pending.request} />
              )
            }
          </Show>
        </Show>
      }
      composer={
        <Show when={props.activeSessionID} keyed>
          {(sessionID) => (
            <Show
              when={!catalogQuery.isPending}
              fallback={
                <p class="composer__status" role="status">
                  正在加载 Agent 和模型
                </p>
              }
            >
              <Show
                when={!catalogQuery.error}
                fallback={<InlineError message={errorMessage(catalogQuery.error, "无法加载 Agent 和模型")} />}
              >
                <Show
                  when={catalogQuery.data?.selectedModel && selectedModel()}
                  fallback={
                    <ProviderEmpty
                      client={data.client()}
                      configPath={catalogQuery.data?.configPath ?? "jyycode.jsonc"}
                      directory={data.directory()}
                      disabled={data.connection() !== "connected"}
                      onProviderConnected={async () => {
                        await catalogQuery.refetch()
                      }}
                    />
                  }
                >
                  <Composer
                    client={data.client()}
                    directory={data.directory()}
                    sessionID={sessionID}
                    agents={catalogQuery.data?.agents ?? []}
                    models={catalogQuery.data?.models ?? []}
                    selectedAgent={selectedAgent() ?? catalogQuery.data?.selectedAgent ?? "build"}
                    selectedModel={selectedModel()!}
                    status={statusQuery.data?.[sessionID] ?? { type: "idle" }}
                    lastMessageError={lastMessageError()}
                    disabled={data.connection() !== "connected"}
                    branchControl={<BranchControl directory={data.directory()} />}
                    onAgentChange={changeAgent}
                    onModelChange={changeModel}
                    onProviderConnected={async () => {
                      await catalogQuery.refetch()
                    }}
                  />
                </Show>
              </Show>
            </Show>
          )}
        </Show>
      }
      inspectorOpen={inspectorPreferences().open}
      inspector={
        <WorkspaceInspector
          directory={data.directory()}
          sessionID={props.activeSessionID}
          open={inspectorPreferences().open}
          todoRatio={inspectorPreferences().todoRatio}
          onOpenChange={(open) => updateInspectorPreferences({ open })}
          onTodoRatioChange={(todoRatio) => updateInspectorPreferences({ todoRatio })}
        />
      }
      busy={busy()}
      onRetryActive={() => void activeQuery.refetch()}
      onRetryArchived={() => void archivedQuery.refetch()}
      onRetryConversation={() => void conversationQuery.refetch()}
      onReturnHome={returnHome}
      onCreate={createNewSession}
      onRename={rename}
      onArchive={archive}
      onDelete={remove}
    />
  )
}
