import { tr } from "../i18n/i18n-context"
import type { Session, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import { A, useNavigate } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { ArrowLeft, House, PanelLeftClose, PanelLeftOpen, Plus, Radio, Settings } from "lucide-solid"
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Button, IconButton } from "../components/ui/button"
import { InlineError } from "../components/ui/inline-error"
import { useData } from "../data/context"
import type { ConnectionState } from "../data/event-bridge"
import { keys, normalizeDirectory } from "../data/query-keys"
import { directoryName } from "../platform/desktop-path"
import { errorMessage } from "../features/projects/project-controller"
import { ReconnectBanner } from "../features/lifecycle/reconnect-banner"
import { useProjects } from "../features/projects/project-context"
import { ProjectTabs } from "../features/projects/project-tabs"
import { conversationQueryOptions } from "../features/conversation/conversation-query"
import type { ConversationSnapshot } from "../features/conversation/conversation-state"
import { MessageTimeline } from "../features/conversation/message-timeline"
import { Composer } from "../features/composer/composer"
import { composerUsageMetrics } from "../features/composer/usage-metrics"
import { AgentPermissionControl } from "../features/composer/agent-permission-control"
import { BranchControl } from "../features/git/branch-control"
import {
  loadComposerPreference,
  loadModelCatalog,
  saveComposerPreference,
  type ModelSelection,
} from "../features/composer/model-catalog"
import { ProviderEmpty } from "../features/composer/provider-empty"
import { effectiveMultiAgent, MultiAgentControl } from "../features/multi-agent/multi-agent-control"
import { McpControl } from "../features/mcp/mcp-control"
import { agentClusterQueryOptions } from "../features/multi-agent/multi-agent-query"
import { MultiAgentPanel } from "../features/multi-agent/multi-agent-panel"
import { findTaskByChildSessionID, projectAgentClusterState } from "../features/multi-agent/multi-agent-state"
import { PermissionBar } from "../features/requests/permission-bar"
import { QuestionPanel } from "../features/requests/question-panel"
import {
  loadInspectorPreferences,
  saveInspectorPreferences,
  type InspectorPreferences,
} from "../features/workspace-inspector/inspector-preferences"
import { WorkspaceInspector } from "../features/workspace-inspector/workspace-inspector"
import { permissionQueryOptions, questionQueryOptions, selectActiveRequest } from "../features/requests/request-query"
import { createSessionApi, sessionQueryOptions } from "../features/sessions/session-api"
import { SessionEmpty } from "../features/sessions/session-empty"
import { SessionList } from "../features/sessions/session-list"
import { useDesktopBridge } from "../platform/context"
import "../features/sessions/sessions.css"
import { settingsHref } from "../features/settings/settings-navigation"

type AsyncSessionAction = (sessionID: string) => Promise<void>

export type WorkspaceLayoutViewProps = {
  projectName: string
  projectDirectory: string
  openProjectDirectories?: readonly string[]
  connection: ConnectionState
  activeSessions: readonly Session[]
  archivedSessions: readonly Session[]
  statuses: Record<string, SessionStatus>
  conversation?: ConversationSnapshot
  activeSession?: Session
  activeSessionID?: string
  selectedRootSessionID?: string
  activeLoading?: boolean
  archivedLoading?: boolean
  conversationLoading?: boolean
  activeError?: string
  archivedError?: string
  conversationError?: string
  planStatus?: "planning" | "ready"
  operationError?: string
  projectTabs?: JSX.Element
  requestArea?: JSX.Element
  composer?: JSX.Element
  inspector?: JSX.Element
  inspectorOpen?: boolean
  inspectorWidth?: number
  multiAgentEnabled?: boolean
  childRole?: string
  busy?: boolean
  onRetryActive?: () => void
  onRetryArchived?: () => void
  onRetryConversation?: () => void
  onReturnHome: () => Promise<void>
  onSwitchProject?: (directory: string) => Promise<void>
  onCreate: () => Promise<void>
  onRename: (sessionID: string, title: string) => Promise<void>
  onArchive: AsyncSessionAction
  onDelete: AsyncSessionAction
  onReturnToRoot?: () => void
}

function connectionLabel(connection: ConnectionState) {
  switch (connection) {
    case "connected":
      return tr("layout.backend-is-connected")
    case "disconnected":
      return tr("layout.the-connection-has-been-interrupted")
    default:
      return tr("layout.connecting-backend")
  }
}

function capitalize(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

function startsNarrow() {
  return typeof window !== "undefined" && window.matchMedia?.("(max-width: 960px)").matches === true
}

function isTypingOrNavigating(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    Boolean(
      target.closest("input, textarea, select, button, a, [contenteditable='true'], [role='dialog'], [role='menu']"),
    )
  )
}

export function projectShortcutIndex(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "target">,
  activeIndex: number,
  count: number,
) {
  if (count < 2 || event.altKey || event.metaKey) return undefined
  if (event.ctrlKey && /^[1-9]$/u.test(event.key)) {
    const index = Number(event.key) - 1
    return index < count ? index : undefined
  }
  if (event.key !== "Tab") return undefined
  if (!event.ctrlKey && event.target instanceof HTMLElement && event.target.closest("[role='dialog'], [role='menu']")) {
    return undefined
  }
  return (activeIndex + (event.shiftKey ? count - 1 : 1)) % count
}

export function WorkspaceLayoutView(props: WorkspaceLayoutViewProps) {
  const [filter, setFilter] = createSignal<"active" | "archived">("active")
  const [railOpen, setRailOpen] = createSignal(!startsNarrow())
  const selected = createMemo(
    () =>
      props.activeSession ??
      [...props.activeSessions, ...props.archivedSessions].find((session) => session.id === props.activeSessionID),
  )
  const list = () => (filter() === "active" ? props.activeSessions : props.archivedSessions)
  const listLoading = () => (filter() === "active" ? props.activeLoading : props.archivedLoading)
  const listError = () => (filter() === "active" ? props.activeError : props.archivedError)
  const retry = () => (filter() === "active" ? props.onRetryActive : props.onRetryArchived)
  const childRole = () => {
    const sessionAgent = selected()?.agent
    if (props.childRole) return props.childRole
    if (sessionAgent && sessionAgent.toLowerCase() !== "general") return sessionAgent
    return "Specialist"
  }

  function closeNarrowRail() {
    if (startsNarrow()) setRailOpen(false)
  }

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (props.busy) return
      const projects = props.openProjectDirectories ?? []
      const activeIndex = projects.findIndex(
        (directory) => normalizeDirectory(directory) === normalizeDirectory(props.projectDirectory),
      )
      if (activeIndex < 0) return
      const nextIndex = projectShortcutIndex(event, activeIndex, projects.length)
      if (nextIndex === undefined || nextIndex === activeIndex) return
      event.preventDefault()
      void props.onSwitchProject?.(projects[nextIndex]!)
    }
    document.addEventListener("keydown", onKeyDown)
    onCleanup(() => document.removeEventListener("keydown", onKeyDown))
  })

  return (
    <div
      class="workspace-shell"
      data-rail-open={railOpen() ? "true" : "false"}
      data-inspector-open={props.inspectorOpen ? "true" : "false"}
      style={{ "--workspace-inspector-width": `${props.inspectorWidth ?? 420}px` }}
    >
      <aside
        id="session-navigation"
        class="workspace-rail"
        aria-label={tr("layout.project-and-session-navigation")}
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
            label={tr("layout.return-to-project-home-page")}
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
            {tr("sessions.new-session")}
          </Button>
          <div class="session-filter" aria-label={tr("layout.session-display-range")}>
            <button type="button" aria-pressed={filter() === "active"} onClick={() => setFilter("active")}>
              {tr("layout.activity")} <span>{props.activeSessions.length}</span>
            </button>
            <button type="button" aria-pressed={filter() === "archived"} onClick={() => setFilter("archived")}>
              {tr("sessions.archive")} <span>{props.archivedSessions.length}</span>
            </button>
          </div>
        </div>

        <SessionList
          sessions={list()}
          statuses={props.statuses}
          activeSessionID={props.selectedRootSessionID ?? props.activeSessionID}
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

        <footer class="workspace-connection" data-state={props.connection}>
          <span class="workspace-connection__status" role="status" aria-live="polite">
            <Radio aria-hidden="true" />
            <span>{connectionLabel(props.connection)}</span>
          </span>
          <A
            class="workspace-settings-link"
            href={settingsHref(
              "general",
              props.activeSessionID ? `/session/${encodeURIComponent(props.activeSessionID)}` : "/workspace",
            )}
            aria-label={tr("layout.open-settings")}
          >
            <Settings aria-hidden="true" />
          </A>
        </footer>
      </aside>

      {props.projectTabs}

      <IconButton
        class="workspace-rail-toggle"
        label={railOpen() ? tr("layout.collapse-session-navigation") : tr("layout.expand-session-navigation")}
        variant="secondary"
        aria-controls="session-navigation"
        aria-expanded={railOpen()}
        onClick={() => setRailOpen((open) => !open)}
      >
        <Show when={railOpen()} fallback={<PanelLeftOpen aria-hidden="true" />}>
          <PanelLeftClose aria-hidden="true" />
        </Show>
      </IconButton>

      <main
        class="workspace-main"
        tabIndex={-1}
        onPointerDown={(event) => {
          if (!isTypingOrNavigating(event.target)) event.currentTarget.focus({ preventScroll: true })
        }}
      >
        <Show when={props.operationError}>{(message) => <InlineError message={message()} />}</Show>
        <Show
          when={props.activeSessionID}
          fallback={
            <SessionEmpty disabled={props.busy || props.activeLoading} onCreate={() => void props.onCreate()} />
          }
        >
          <section class="workspace-conversation" aria-labelledby="workspace-session-title">
            <header class="workspace-conversation__header">
              <Show
                when={selected()?.parentID}
                fallback={
                  <span class="workspace-conversation__context">
                    {props.multiAgentEnabled ? tr("layout.multi-agent-model") : tr("layout.single-agent-mode")}
                  </span>
                }
              >
                <div class="workspace-conversation__child-context">
                  <button type="button" onClick={props.onReturnToRoot} aria-label={tr("layout.return-to-main-session")}>
                    <ArrowLeft aria-hidden="true" />
                    {tr("layout.return-to-main-session")}
                  </button>
                  <span>
                    {tr("layout.subagent")} {capitalize(childRole())}
                  </span>
                </div>
              </Show>
              <h1 id="workspace-session-title">{selected()?.title ?? "Session"}</h1>
            </header>
            <Show when={props.connection === "connected" ? undefined : props.connection} keyed>
              {(state) => <ReconnectBanner state={state} />}
            </Show>
            <MessageTimeline
              messages={props.conversation?.messages ?? []}
              loading={props.conversationLoading}
              error={props.conversationError}
              planStatus={props.planStatus}
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
  onMount(() => {
    projects
      .loadRecentProjects()
      .catch((cause) => setOperationError(errorMessage(cause, tr("projects.unable-to-read-recent-items"))))
  })
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
  const allSessionsQuery = createQuery(
    () => ({ queryKey: keys.sessionsAll(data.directory()), queryFn: () => api().listAll() }),
    data.queryClient,
  )
  const sessionQuery = createQuery(
    () => ({
      ...sessionQueryOptions({
        client: data.client(),
        directory: data.directory(),
        sessionID: props.activeSessionID ?? "",
      }),
      enabled: Boolean(props.activeSessionID),
    }),
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
  const activeSession = createMemo(() => sessionQuery.data)
  const parentSessionID = createMemo(() => activeSession()?.parentID)
  const rootSessionID = createMemo(() => parentSessionID() ?? activeSession()?.id)
  const rootSession = createMemo(() => {
    const rootID = rootSessionID()
    if (!rootID) return undefined
    if (activeSession()?.id === rootID) return activeSession()
    return [...(activeQuery.data ?? []), ...(archivedQuery.data ?? [])].find((session) => session.id === rootID)
  })
  const isChildSession = createMemo(() => Boolean(parentSessionID()))
  const clusterQuery = createQuery(
    () => ({
      ...agentClusterQueryOptions({
        client: data.client(),
        directory: data.directory(),
        sessionID: rootSessionID() ?? "",
      }),
      enabled: Boolean(rootSessionID()),
    }),
    data.queryClient,
  )
  const clusterSnapshot = createMemo(() => projectAgentClusterState(clusterQuery.data ?? { runs: [], tasks: [] }))
  const activeChildTask = createMemo(() => findTaskByChildSessionID(clusterSnapshot(), activeSession()?.id))
  const rootMultiAgentEnabled = createMemo(() =>
    rootSession() ? effectiveMultiAgent(rootSession()!, catalogQuery.data?.agentCluster) : false,
  )
  const clusterPlanStatus = createMemo<"planning" | "ready" | undefined>(() => {
    if (isChildSession() || !rootMultiAgentEnabled()) return undefined
    const snapshot = clusterSnapshot()
    const rootStatus = statusQuery.data?.[rootSessionID() ?? ""]
    const active = rootStatus?.type === "busy" || rootStatus?.type === "retry"
    return snapshot.totalAgents === 0 && (active || snapshot.latestRun?.status === "planning") ? "planning" : "ready"
  })
  const multiAgentBadge = createMemo(() => {
    const snapshot = clusterSnapshot()
    if (snapshot.failedAgents > 0) return `${snapshot.runningAgents}/${snapshot.failedAgents}`
    if (snapshot.runningAgents > 0) return String(snapshot.runningAgents)
    return undefined
  })
  const requestScope = createMemo(() => {
    const session = activeSession()
    if (!session) return []
    if (session.parentID) return [session.id]
    return [
      ...new Set([
        session.id,
        ...clusterSnapshot().tasks.flatMap((task) => (task.childSessionID ? [task.childSessionID] : [])),
      ]),
    ]
  })
  const composerAgent = createMemo(() =>
    isChildSession()
      ? (activeSession()?.agent ?? "build")
      : (selectedAgent() ?? catalogQuery.data?.selectedAgent ?? "build"),
  )
  const composerModel = createMemo<ModelSelection | undefined>(() => {
    const stored = activeSession()?.model
    if (isChildSession() && stored) {
      return {
        providerID: stored.providerID,
        modelID: stored.id,
        ...(stored.variant ? { variant: stored.variant } : {}),
      }
    }
    return selectedModel() ?? catalogQuery.data?.selectedModel
  })
  const composerUsage = createMemo(() => {
    const session = activeSession()
    const model = composerModel()
    if (!session || !model) return undefined
    const contextWindow = catalogQuery.data?.models.find(
      (candidate) => candidate.providerID === model.providerID && candidate.modelID === model.modelID,
    )?.contextWindow
    return composerUsageMetrics({
      session,
      sessions: allSessionsQuery.data ?? [session],
      messages: conversationQuery.data?.messages ?? [],
      contextWindow,
    })
  })

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

  function updateInspectorPreferences(next: InspectorPreferences) {
    setInspectorPreferences(next)
    saveInspectorPreferences(data.directory(), next)
  }

  const projectName = createMemo(() => {
    const project = projects.activeProject()
    if (project?.info.name) return project.info.name
    return directoryName(data.directory()) || "JYYCode"
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
      setOperationError(errorMessage(cause, tr("layout.unable-to-create-session")))
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
      setOperationError(errorMessage(cause, tr("layout.unable-to-return-to-project-home-page")))
    } finally {
      setBusy(false)
    }
  }

  async function switchProject(directory?: string) {
    setBusy(true)
    setOperationError(undefined)
    try {
      const opened = directory ? await projects.openProject(directory) : await projects.chooseAndOpenProject()
      if (opened) {
        const sessionID = projects.sessionFor(opened.directory)
        navigate(sessionID ? `/session/${encodeURIComponent(sessionID)}` : "/workspace")
      }
    } catch (cause) {
      setOperationError(errorMessage(cause, tr("projects.unable-to-open-project")))
    } finally {
      setBusy(false)
    }
  }

  async function closeProject(directory: string) {
    const closingActive = normalizeDirectory(directory) === normalizeDirectory(data.directory())
    const next = projects.closeProject(directory)
    if (!closingActive) return
    if (!next) {
      await projects.returnToProjectSelection()
      navigate("/")
      return
    }
    const sessionID = projects.sessionFor(next.directory)
    navigate(sessionID ? `/session/${encodeURIComponent(sessionID)}` : "/workspace")
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

  const activeRequest = createMemo(() =>
    selectActiveRequest(permissionsQuery.data ?? [], questionsQuery.data ?? [], requestScope()),
  )
  const requestError = createMemo(() => {
    if (permissionsQuery.error)
      return errorMessage(permissionsQuery.error, tr("layout.unable-to-load-permission-request"))
    if (questionsQuery.error) return errorMessage(questionsQuery.error, tr("layout.unable-to-load-agent-issue"))
    return undefined
  })
  let persistedLocation = ""
  createEffect(() => {
    if (activeQuery.isPending || archivedQuery.isPending || activeQuery.error || archivedQuery.error) return
    const sessionID = props.activeSessionID
    if (sessionID && sessionQuery.data?.id !== sessionID) return
    if (sessionID) projects.rememberSession(data.directory(), sessionID)
    const openProjects = projects.openProjects().map((project) => {
      const rememberedSessionID = projects.sessionFor(project.directory)
      return { path: project.directory, ...(rememberedSessionID ? { sessionID: rememberedSessionID } : {}) }
    })
    const location = { project: data.directory(), ...(sessionID ? { sessionID } : {}), openProjects }
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
      openProjectDirectories={projects.openProjects().map((project) => project.directory)}
      connection={data.connection()}
      activeSessions={activeQuery.data ?? []}
      archivedSessions={archivedQuery.data ?? []}
      statuses={statusQuery.data ?? {}}
      conversation={conversationQuery.data}
      activeSession={activeSession()}
      activeSessionID={props.activeSessionID}
      selectedRootSessionID={rootSessionID()}
      activeLoading={activeQuery.isPending || (Boolean(props.activeSessionID) && sessionQuery.isPending)}
      archivedLoading={archivedQuery.isPending}
      conversationLoading={Boolean(props.activeSessionID) && conversationQuery.isPending}
      activeError={
        activeQuery.error ? errorMessage(activeQuery.error, tr("layout.unable-to-load-active-session")) : undefined
      }
      archivedError={
        archivedQuery.error
          ? errorMessage(archivedQuery.error, tr("layout.unable-to-load-archived-session"))
          : undefined
      }
      conversationError={
        conversationQuery.error
          ? errorMessage(conversationQuery.error, tr("layout.unable-to-load-session-message"))
          : undefined
      }
      planStatus={clusterPlanStatus()}
      operationError={operationError()}
      projectTabs={
        <ProjectTabs
          projects={projects.openProjects()}
          activeDirectory={data.directory()}
          queryClient={data.queryClient()}
          disabled={busy()}
          onSelect={(directory) => void switchProject(directory)}
          onOpen={() => void switchProject()}
          onClose={(directory) => void closeProject(directory)}
          onReorder={(source, target, placement) => projects.reorderProjects(source, target, placement)}
        />
      }
      multiAgentEnabled={rootMultiAgentEnabled()}
      childRole={activeChildTask()?.role}
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
            {(pending) => (
              <>
                <Show when={pending.sourceSessionID !== activeSession()?.id}>
                  <p class="request-panel__source">
                    {tr("layout.from-subagent")}{" "}
                    {capitalize(
                      clusterSnapshot().tasks.find((task) => task.childSessionID === pending.sourceSessionID)?.role ??
                        tr("composer.agent"),
                    )}
                  </p>
                </Show>
                {pending.type === "permission" ? (
                  <PermissionBar client={data.client()} directory={data.directory()} request={pending.request} />
                ) : (
                  <QuestionPanel client={data.client()} directory={data.directory()} request={pending.request} />
                )}
              </>
            )}
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
                  {tr("layout.loading-agents-and-models")}
                </p>
              }
            >
              <Show
                when={!catalogQuery.error}
                fallback={
                  <InlineError
                    message={errorMessage(catalogQuery.error, tr("layout.unable-to-load-agents-and-models"))}
                  />
                }
              >
                <Show
                  when={composerModel()}
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
                    queryClient={data.queryClient()}
                    directory={data.directory()}
                    sessionID={sessionID}
                    agents={isChildSession() ? (catalogQuery.data?.allAgents ?? []) : (catalogQuery.data?.agents ?? [])}
                    models={catalogQuery.data?.models ?? []}
                    selectedAgent={composerAgent()}
                    selectedModel={composerModel()!}
                    agentClusterEnabled={
                      activeSession() ? effectiveMultiAgent(activeSession()!, catalogQuery.data?.agentCluster) : false
                    }
                    status={statusQuery.data?.[sessionID] ?? { type: "idle" }}
                    requestPending={Boolean(activeRequest())}
                    disabled={data.connection() !== "connected"}
                    identityLocked={isChildSession()}
                    minimal={isChildSession()}
                    usage={composerUsage()}
                    permissionControl={
                      <Show when={activeSession()} keyed>
                        {(session) => (
                          <AgentPermissionControl
                            client={data.client()}
                            queryClient={data.queryClient()}
                            directory={data.directory()}
                            session={session}
                            disabled={data.connection() !== "connected"}
                          />
                        )}
                      </Show>
                    }
                    branchControl={<BranchControl directory={data.directory()} />}
                    multiAgentControl={
                      <Show when={activeSession()} keyed>
                        {(session) => (
                          <MultiAgentControl
                            client={data.client()}
                            queryClient={data.queryClient()}
                            directory={data.directory()}
                            session={session}
                            config={catalogQuery.data?.agentCluster}
                          />
                        )}
                      </Show>
                    }
                    mcpControl={
                      <McpControl
                        client={data.client()}
                        queryClient={data.queryClient()}
                        directory={data.directory()}
                        disabled={data.connection() !== "connected"}
                      />
                    }
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
      inspectorOpen={inspectorPreferences().panes.length > 0}
      inspectorWidth={inspectorPreferences().width}
      inspector={
        <WorkspaceInspector
          directory={data.directory()}
          sessionID={props.activeSessionID}
          preferences={inspectorPreferences()}
          onPreferencesChange={updateInspectorPreferences}
          multiAgent={
            <MultiAgentPanel
              directory={data.directory()}
              sessionID={rootSessionID()}
              enabled={rootMultiAgentEnabled()}
              selectedChildSessionID={isChildSession() ? activeSession()?.id : undefined}
              onOpenChild={(sessionID) => navigate(`/session/${encodeURIComponent(sessionID)}`)}
            />
          }
          multiAgentBadge={multiAgentBadge()}
        />
      }
      busy={busy()}
      onRetryActive={() => void activeQuery.refetch()}
      onRetryArchived={() => void archivedQuery.refetch()}
      onRetryConversation={() => void conversationQuery.refetch()}
      onReturnHome={returnHome}
      onSwitchProject={(directory) => switchProject(directory)}
      onCreate={createNewSession}
      onRename={rename}
      onArchive={archive}
      onDelete={remove}
      onReturnToRoot={() => {
        const parentID = parentSessionID()
        if (parentID) navigate(`/session/${encodeURIComponent(parentID)}`)
      }}
    />
  )
}
