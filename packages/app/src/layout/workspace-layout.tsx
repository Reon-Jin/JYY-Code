import { tr } from "../i18n/i18n-context"
import type { Session, SessionStatus, VcsFileDiff } from "@jyycode-ai/sdk/v2/client"
import { A, useBeforeLeave, useNavigate } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { ArrowLeft, House, PanelLeftClose, PanelLeftOpen, Plus, Radio, Settings } from "lucide-solid"
import {
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  For,
  lazy,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
  type JSX,
} from "solid-js"
import { Button, IconButton } from "../components/ui/button"
import { InlineError } from "../components/ui/inline-error"
import { useData } from "../data/context"
import type { CompactionStatus, ConnectionState } from "../data/event-bridge"
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
import { GoalModeControl } from "../features/goal/goal-mode-control"
import { McpControl } from "../features/mcp/mcp-control"
import { PlanPanel } from "../features/plan/plan-panel"
import { planQueryOptions } from "../features/plan/plan-query"
import { findTaskByChildSessionID, projectPlanState } from "../features/plan/plan-state"
import { planRoleLabel } from "../features/plan/plan-role-presentation"
import { blackboardQueryOptions } from "../features/blackboard/blackboard-query"
import { BlackboardPanel } from "../features/blackboard/blackboard-panel"
import { PermissionBar } from "../features/requests/permission-bar"
import { QuestionPanel } from "../features/requests/question-panel"
import {
  loadInspectorPreferences,
  normalizeInspectorRatios,
  saveInspectorPreferences,
  type InspectorPreferences,
} from "../features/workspace-inspector/inspector-preferences"
import { WorkspaceInspector } from "../features/workspace-inspector/workspace-inspector"
import { SubagentProfilesPanel } from "../features/subagents/subagent-profiles-panel"
import type { FilePreviewProps } from "../features/files/file-preview"
import { type FileOpenEvent } from "../features/files/file-tree"
import { permissionQueryOptions, questionQueryOptions, selectActiveRequest } from "../features/requests/request-query"
import { createSessionApi, sessionQueryOptions } from "../features/sessions/session-api"
import { SessionEmpty } from "../features/sessions/session-empty"
import { SessionList } from "../features/sessions/session-list"
import { playSoundEffect } from "../features/sound-effects/sound-effects"
import { useDesktopBridge } from "../platform/context"
import "../features/sessions/sessions.css"
import { settingsHref } from "../features/settings/settings-navigation"

type AsyncSessionAction = (sessionID: string) => Promise<void>

type FileScope = {
  directory: string
  workspaceID?: string
  sessionID?: string
}

let filePreviewModulePromise: Promise<typeof import("../features/files/file-preview")> | undefined

function loadFilePreviewModule() {
  filePreviewModulePromise ??= import("../features/files/file-preview").catch((cause) => {
    filePreviewModulePromise = undefined
    throw cause
  })
  return filePreviewModulePromise
}

function FilePreviewAttempt(props: FilePreviewProps) {
  const Preview = lazy(async () => ({ default: (await loadFilePreviewModule()).FilePreview }))
  return <Preview {...props} />
}

function RecoverableFilePreview(props: FilePreviewProps) {
  const [attempt, setAttempt] = createSignal(0)
  const retry = (reset: () => void) => {
    reset()
    setAttempt((value) => value + 1)
  }

  return (
    <For each={[attempt()]}>
      {() => (
        <ErrorBoundary
          fallback={(cause, reset) => (
            <div class="file-preview__state file-preview__state--module-error" role="alert">
              <InlineError
                message={cause instanceof Error && cause.message ? cause.message : tr("files.unable-to-load")}
              />
              <Button size="small" variant="secondary" onClick={() => retry(reset)}>
                {tr("files.retry")}
              </Button>
            </div>
          )}
        >
          <Suspense
            fallback={
              <div class="file-preview__state file-preview__state--module-loading" role="status" aria-busy="true">
                <span>{tr("files.loading-preview")}</span>
              </div>
            }
          >
            <FilePreviewAttempt {...props} />
          </Suspense>
        </ErrorBoundary>
      )}
    </For>
  )
}

export type WorkspaceLayoutViewProps = {
  projectName: string
  projectDirectory: string
  openProjectDirectories?: readonly string[]
  connection: ConnectionState
  activeSessions: readonly Session[]
  archivedSessions: readonly Session[]
  statuses: Record<string, SessionStatus>
  conversation?: ConversationSnapshot
  compaction?: CompactionStatus | null
  activeSession?: Session
  activeSessionID?: string
  selectedRootSessionID?: string
  activeLoading?: boolean
  archivedLoading?: boolean
  conversationLoading?: boolean
  activeError?: string
  archivedError?: string
  conversationError?: string
  operationError?: string
  projectTabs?: JSX.Element
  requestArea?: JSX.Element
  composer?: JSX.Element
  inspector?: JSX.Element
  inspectorOpen?: boolean
  inspectorWidth?: number
  multiAgentEnabled?: boolean
  childRole?: string
  pendingActions?: ReadonlySet<string>
  busy?: boolean
  onRetryActive?: () => void
  onRetryArchived?: () => void
  onRetryConversation?: () => void
  onShowArchived?: () => void
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
  let previousGoalSessionID: string | undefined
  let previousGoalStatus: "running" | "done" | "failed" | "cancelled" | undefined
  createEffect(() => {
    const session = selected()
    const goal = session?.goal
    const status = goal?.status
    if (session?.id !== previousGoalSessionID) {
      previousGoalSessionID = session?.id
      previousGoalStatus = status
      return
    }
    if (status === "running" && previousGoalStatus !== "running") {
      playSoundEffect("goal-start")
    } else if (status && status !== "running" && previousGoalStatus === "running") {
      playSoundEffect("goal-end")
    }
    previousGoalStatus = status
  })
  const rootActiveSessions = () => props.activeSessions.filter((session) => session.parentID === undefined)
  const rootArchivedSessions = () => props.archivedSessions.filter((session) => session.parentID === undefined)
  const list = () => (filter() === "active" ? rootActiveSessions() : rootArchivedSessions())
  const listLoading = () => (filter() === "active" ? props.activeLoading : props.archivedLoading)
  const listError = () => (filter() === "active" ? props.activeError : props.archivedError)
  const retry = () => (filter() === "active" ? props.onRetryActive : props.onRetryArchived)
  const pending = (key: string) => props.pendingActions?.has(key) === true
  const projectNavigationPending = () => Boolean(props.busy) || pending("project.return") || pending("project.switch")
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
      if (projectNavigationPending()) return
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
            loading={pending("project.return")}
            disabled={projectNavigationPending()}
            onClick={() => void props.onReturnHome()}
          >
            <House aria-hidden="true" />
          </IconButton>
        </header>

        <div class="workspace-rail__toolbar">
          <Button
            class="workspace-new-session"
            loading={pending("session.create")}
            disabled={projectNavigationPending()}
            onClick={() => void props.onCreate()}
          >
            <Plus aria-hidden="true" />
            {tr("sessions.new-session")}
          </Button>
          <div class="session-filter" aria-label={tr("layout.session-display-range")}>
            <button type="button" aria-pressed={filter() === "active"} onClick={() => setFilter("active")}>
              {tr("layout.activity")} <span>{rootActiveSessions().length}</span>
            </button>
            <button
              type="button"
              aria-pressed={filter() === "archived"}
              onClick={() => {
                setFilter("archived")
                props.onShowArchived?.()
              }}
            >
              {tr("sessions.archive")} <span>{rootArchivedSessions().length}</span>
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
          disabled={projectNavigationPending()}
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
        data-sound-effect={railOpen() ? "panel-close" : "panel-open"}
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
            <SessionEmpty
              disabled={projectNavigationPending() || pending("session.create") || props.activeLoading}
              onCreate={() => void props.onCreate()}
            />
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
              goal={selected()?.goal}
              compaction={props.compaction}
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
  const [pendingActions, setPendingActions] = createSignal<ReadonlySet<string>>(new Set())
  const [selectedAgent, setSelectedAgent] = createSignal<string>()
  const [selectedModel, setSelectedModel] = createSignal<ModelSelection>()
  const [activeFilePath, setActiveFilePath] = createSignal<string>()
  const [activeFileChange, setActiveFileChange] = createSignal<VcsFileDiff>()
  const [selectedFileScope, setSelectedFileScope] = createSignal<FileScope>()
  const [fileDirty, setFileDirty] = createSignal(false)
  const [catalogEnabled, setCatalogEnabled] = createSignal(false)
  const [archiveRequested, setArchiveRequested] = createSignal(false)
  const [inspectorPreferences, setInspectorPreferences] = createSignal<InspectorPreferences>(
    loadInspectorPreferences(data.directory()),
  )

  async function runPending(key: string, operation: () => Promise<void>) {
    if (pendingActions().has(key)) return
    setPendingActions((current) => new Set(current).add(key))
    try {
      await operation()
    } finally {
      setPendingActions((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }
  onMount(() => {
    const frame = requestAnimationFrame(() => setCatalogEnabled(true))
    projects
      .loadRecentProjects()
      .catch((cause) => setOperationError(errorMessage(cause, tr("projects.unable-to-read-recent-items"))))
    onCleanup(() => cancelAnimationFrame(frame))
  })
  const api = createMemo(() =>
    createSessionApi({ client: data.client(), directory: data.directory(), queryClient: data.queryClient() }),
  )
  const activeQuery = createQuery(
    () => ({ queryKey: keys.sessions(data.directory()), queryFn: () => api().list(false) }),
    data.queryClient,
  )
  const archivedQuery = createQuery(
    () => ({
      queryKey: keys.sessions(data.directory(), true),
      queryFn: () => api().list(true),
      // Archived sessions are not needed to render the active workspace. Load
      // them only when the user opens the archive view, or when an active child
      // needs its archived root session for context.
      enabled: archiveRequested(),
    }),
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
  const compactionQuery = createQuery<CompactionStatus | null, Error, CompactionStatus | null>(
    () => ({
      queryKey: keys.compaction(data.directory(), props.activeSessionID ?? ""),
      queryFn: async () => null,
      initialData: null,
      enabled: Boolean(props.activeSessionID),
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
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
      enabled: catalogEnabled() && Boolean(props.activeSessionID),
    }),
    data.queryClient,
  )
  const activeSession = createMemo(() => sessionQuery.data)
  createEffect(() => {
    if (activeSession()?.parentID) setArchiveRequested(true)
  })
  const parentSessionID = createMemo(() => activeSession()?.parentID)
  const rootSessionID = createMemo(() => parentSessionID() ?? activeSession()?.id)
  const rootSession = createMemo(() => {
    const rootID = rootSessionID()
    if (!rootID) return undefined
    if (activeSession()?.id === rootID) return activeSession()
    return [...(activeQuery.data ?? []), ...(archivedQuery.data ?? [])].find((session) => session.id === rootID)
  })
  const isChildSession = createMemo(() => Boolean(parentSessionID()))
  const activeSessionFileDirectory = createMemo(() => activeSession()?.directory ?? data.directory())
  const activeSessionFileWorkspaceID = createMemo(() => {
    const session = activeSession()
    const root = rootSession()
    if (!session?.workspaceID) return undefined
    if (
      session.parentID &&
      session.directory &&
      root?.directory &&
      normalizeDirectory(session.directory) !== normalizeDirectory(root.directory)
    )
      return undefined
    return session.workspaceID
  })
  const activeFileScope = createMemo<FileScope>(
    () =>
      selectedFileScope() ?? {
        directory: activeSessionFileDirectory(),
        workspaceID: activeSessionFileWorkspaceID(),
        sessionID: activeSession()?.id,
      },
  )
  const rootDiffDirectory = createMemo(() => rootSession()?.directory ?? data.directory())
  const diffSharedCompat = createMemo(() => {
    if (!isChildSession()) return false
    const activeDirectory = activeSession()?.directory
    return (
      activeDirectory !== undefined && normalizeDirectory(activeDirectory) === normalizeDirectory(rootDiffDirectory())
    )
  })
  const diffMode = createMemo<"git" | "session">(() =>
    projects.activeProject()?.info.vcs === "git" ? "git" : "session",
  )

  createEffect(() => data.setWorkspaceID(activeSession()?.workspaceID))

  createEffect(
    on(
      () => [data.directory(), props.activeSessionID] as const,
      () => {
        setActiveFilePath(undefined)
        setActiveFileChange(undefined)
        setSelectedFileScope(undefined)
        setFileDirty(false)
        setArchiveRequested(false)
      },
    ),
  )
  const planQuery = createQuery(
    () => ({
      ...planQueryOptions({
        client: data.client(),
        directory: data.directory(),
        sessionID: rootSessionID() ?? "",
      }),
      // Single-agent sessions have no plan protocol; only multi-agent roots
      // pay for plan snapshot polling.
      enabled: Boolean(rootSessionID()) && rootMultiAgentEnabled(),
    }),
    data.queryClient,
  )
  const planSnapshot = createMemo(() => projectPlanState(planQuery.data ?? { plan: null }))
  // A completed plan clears currentStepID, but its blackboard history stays readable.
  const planExists = createMemo(() => planSnapshot().totalSteps > 0)
  const rootMultiAgentEnabled = createMemo(() => (rootSession() ? effectiveMultiAgent(rootSession()!) : false))
  const blackboardQuery = createQuery(
    () => ({
      ...blackboardQueryOptions({
        client: data.client(),
        directory: data.directory(),
        rootSessionID: rootSessionID() ?? "",
      }),
      enabled: Boolean(rootSessionID()) && planExists(),
    }),
    data.queryClient,
  )
  const activeChildTask = createMemo(() => findTaskByChildSessionID(planSnapshot(), activeSession()?.id))
  const childTaskRunning = createMemo(() => {
    const task = activeChildTask()
    return task?.status === "running"
  })
  const childSteering = createMemo(() => {
    if (!isChildSession()) return false
    const sessionID = activeSession()?.id
    const status = sessionID ? statusQuery.data?.[sessionID] : undefined
    return childTaskRunning() || (status !== undefined && status.type !== "idle")
  })
  const planBadge = createMemo(() => {
    if (!rootMultiAgentEnabled()) return undefined
    const snapshot = planSnapshot()
    if (snapshot.failedAgents > 0) return `${snapshot.runningAgents}/${snapshot.failedAgents}`
    if (snapshot.runningAgents > 0) return String(snapshot.runningAgents)
    return undefined
  })
  const blackboardBadge = createMemo(() => {
    // The board stays readable in single-agent mode, so unread still matters.
    if (!planExists()) return undefined
    const unreadCount = Number(blackboardQuery.data?.unreadCount ?? 0)
    return unreadCount > 0 ? String(unreadCount) : undefined
  })
  const requestScope = createMemo(() => {
    const session = activeSession()
    if (!session) return []
    if (session.parentID) return [session.id]
    return [
      ...new Set([
        session.id,
        ...planSnapshot().tasks.flatMap((task) => (task.childSessionID ? [task.childSessionID] : [])),
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
      sessions: [...(activeQuery.data ?? []), ...(archivedQuery.data ?? [])],
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
    await runPending("session.create", async () => {
      setOperationError(undefined)
      try {
        const session = await api().create({})
        navigate(`/session/${encodeURIComponent(session.id)}`)
      } catch (cause) {
        setOperationError(errorMessage(cause, tr("layout.unable-to-create-session")))
      }
    })
  }

  async function returnHome() {
    await runPending("project.return", async () => {
      setOperationError(undefined)
      try {
        await projects.returnToProjectSelection()
        navigate("/")
      } catch (cause) {
        setOperationError(errorMessage(cause, tr("layout.unable-to-return-to-project-home-page")))
      }
    })
  }

  async function switchProject(directory?: string) {
    await runPending("project.switch", async () => {
      setOperationError(undefined)
      try {
        const opened = directory ? await projects.openProject(directory) : await projects.chooseAndOpenProject()
        if (opened) {
          const sessionID = projects.sessionFor(opened.directory)
          navigate(sessionID ? `/session/${encodeURIComponent(sessionID)}` : "/workspace")
        }
      } catch (cause) {
        setOperationError(errorMessage(cause, tr("projects.unable-to-open-project")))
      }
    })
  }

  async function closeProject(directory: string) {
    await runPending(`project.close:${normalizeDirectory(directory)}`, async () => {
      const closingActive = normalizeDirectory(directory) === normalizeDirectory(data.directory())
      const next = projects.closeProject(directory)
      if (!closingActive) return
      if (!next) {
        try {
          await projects.returnToProjectSelection()
          navigate("/")
        } catch (cause) {
          setOperationError(errorMessage(cause, tr("layout.unable-to-return-to-project-home-page")))
        }
        return
      }
      const sessionID = projects.sessionFor(next.directory)
      navigate(sessionID ? `/session/${encodeURIComponent(sessionID)}` : "/workspace")
    })
  }

  async function rename(sessionID: string, title: string) {
    await runPending(`session.rename:${sessionID}`, async () => {
      await api().rename(sessionID, title)
    })
  }

  async function archive(sessionID: string) {
    await runPending(`session.archive:${sessionID}`, async () => {
      const next = nextActive(sessionID)
      await api().archive(sessionID)
      if (props.activeSessionID === sessionID) navigate(next ? `/session/${encodeURIComponent(next.id)}` : "/")
    })
  }

  async function remove(sessionID: string) {
    await runPending(`session.delete:${sessionID}`, async () => {
      const next = nextActive(sessionID)
      await api().remove(sessionID)
      if (props.activeSessionID === sessionID) navigate(next ? `/session/${encodeURIComponent(next.id)}` : "/")
    })
  }

  function changeModel(model: ModelSelection) {
    setSelectedModel(model)
    saveComposerPreference({ agent: selectedAgent(), model })
  }

  function canLeaveFile() {
    return !fileDirty() || typeof window === "undefined" || window.confirm(tr("files.unsaved"))
  }

  function ensureFilesPane() {
    const current = inspectorPreferences()
    if (current.panes.includes("files")) return
    const panes: InspectorPreferences["panes"] = [...current.panes, "files"]
    updateInspectorPreferences({ ...current, panes, ratios: normalizeInspectorRatios(panes.length, current.ratios) })
  }

  function openFile(event: FileOpenEvent) {
    const fallbackScope: FileScope = {
      directory: activeSessionFileDirectory(),
      workspaceID: activeSessionFileWorkspaceID(),
      sessionID: activeSession()?.id,
    }
    const nextScope: FileScope = event.directory
      ? {
          directory: event.directory,
          workspaceID: event.workspaceID,
          sessionID: event.sessionID,
        }
      : fallbackScope
    const currentScope = selectedFileScope()
    const sameScope =
      currentScope &&
      normalizeDirectory(currentScope.directory) === normalizeDirectory(nextScope.directory) &&
      currentScope.workspaceID === nextScope.workspaceID &&
      currentScope.sessionID === nextScope.sessionID
    if (activeFilePath() === event.path && activeFileChange() === event.change && sameScope) {
      ensureFilesPane()
      return
    }
    if (!canLeaveFile()) return
    ensureFilesPane()
    if (activeFilePath() === event.path) {
      setActiveFileChange(event.change)
      setSelectedFileScope(nextScope)
      return
    }
    setActiveFilePath(event.path)
    setActiveFileChange(event.change)
    setSelectedFileScope(nextScope)
    setFileDirty(false)
  }

  function closeFile() {
    if (!canLeaveFile()) return
    setActiveFilePath(undefined)
    setActiveFileChange(undefined)
    setSelectedFileScope(undefined)
    setFileDirty(false)
  }

  useBeforeLeave((event) => {
    if (fileDirty() && typeof window !== "undefined" && !window.confirm(tr("files.unsaved"))) {
      event.preventDefault()
    }
  })

  async function refreshAfterSubagentsChange() {
    await Promise.all([catalogQuery.refetch(), planQuery.refetch()])
  }

  const activeRequest = createMemo(
    () => selectActiveRequest(permissionsQuery.data ?? [], questionsQuery.data ?? [], requestScope()),
    undefined,
    // Keep the previous object while the same request stays active so the keyed
    // request panel does not remount (and lose its state) on unrelated refetches.
    { equals: (previous, next) => previous?.type === next?.type && previous?.request.id === next?.request.id },
  )
  const requestError = createMemo(() => {
    if (permissionsQuery.error)
      return errorMessage(permissionsQuery.error, tr("layout.unable-to-load-permission-request"))
    if (questionsQuery.error) return errorMessage(questionsQuery.error, tr("layout.unable-to-load-agent-issue"))
    return undefined
  })
  let persistedLocation = ""
  createEffect(() => {
    // Location persistence only depends on the active session and project
    // list. An optional archive fetch must never delay restoring the user's
    // last location.
    if (activeQuery.isPending || activeQuery.error) return
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
      compaction={compactionQuery.data}
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
      onShowArchived={() => setArchiveRequested(true)}
      operationError={operationError()}
      projectTabs={
        <ProjectTabs
          projects={projects.openProjects()}
          activeDirectory={data.directory()}
          queryClient={data.queryClient()}
          pendingActions={pendingActions()}
          onSelect={(directory) => void switchProject(directory)}
          onOpen={() => void switchProject()}
          onClose={(directory) => void closeProject(directory)}
          onReorder={(source, target, placement) => projects.reorderProjects(source, target, placement)}
        />
      }
      multiAgentEnabled={rootMultiAgentEnabled()}
      childRole={planRoleLabel(activeChildTask()?.role)}
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
                      planRoleLabel(
                        planSnapshot().tasks.find((task) => task.childSessionID === pending.sourceSessionID)?.role,
                      ),
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
                    requestDirectory={activeSession()?.directory ?? data.directory()}
                    sessionID={sessionID}
                    models={catalogQuery.data?.models ?? []}
                    selectedAgent={composerAgent()}
                    selectedModel={composerModel()!}
                    status={statusQuery.data?.[sessionID] ?? { type: "idle" }}
                    requestPending={Boolean(activeRequest())}
                    childSteering={childSteering()}
                    disabled={data.connection() !== "connected"}
                    identityLocked={isChildSession()}
                    minimal={isChildSession()}
                    usage={composerUsage()}
                    permissionControl={
                      <Show when={activeSession()}>
                        <AgentPermissionControl
                          client={data.client()}
                          queryClient={data.queryClient()}
                          directory={data.directory()}
                          session={activeSession()!}
                          disabled={data.connection() !== "connected"}
                        />
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
                          />
                        )}
                      </Show>
                    }
                    goalModeControl={
                      <Show when={activeSession()} keyed>
                        {(session) => (
                          <GoalModeControl
                            client={data.client()}
                            queryClient={data.queryClient()}
                            directory={data.directory()}
                            session={session}
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
          workspaceID={activeSession()?.workspaceID}
          diffDirectory={rootDiffDirectory()}
          diffWorkspaceID={rootSession()?.workspaceID}
          diffSessionID={rootSessionID()}
          diffMode={diffMode()}
          diffSharedCompat={diffSharedCompat()}
          fileDirectory={activeSessionFileDirectory()}
          fileWorkspaceID={activeSessionFileWorkspaceID()}
          fileSessionID={activeSession()?.id}
          files={
            activeFilePath() ? (
              <RecoverableFilePreview
                directory={activeFileScope().directory}
                workspaceID={activeFileScope().workspaceID}
                sessionID={activeFileScope().sessionID}
                path={activeFilePath()!}
                change={activeFileChange()}
                onClose={closeFile}
                onDirtyChange={setFileDirty}
              />
            ) : undefined
          }
          preferences={inspectorPreferences()}
          onPreferencesChange={updateInspectorPreferences}
          onOpenFile={openFile}
          plan={
            <PlanPanel
              directory={data.directory()}
              sessionID={props.activeSessionID}
              rootSessionID={rootSessionID()}
              selectedChildSessionID={isChildSession() ? activeSession()?.id : undefined}
              onOpenChild={(sessionID) => navigate(`/session/${encodeURIComponent(sessionID)}`)}
            />
          }
          planBadge={planBadge()}
          blackboardBadge={blackboardBadge()}
          blackboard={
            <BlackboardPanel
              directory={data.directory()}
              enabled={planExists()}
              postingEnabled={rootMultiAgentEnabled()}
              waitingForPlan={rootMultiAgentEnabled() && planSnapshot().totalSteps === 0}
              rootSessionID={rootSessionID()}
              steps={planSnapshot().steps.map((step) => ({ id: step.id, title: step.title }))}
              taskLabels={Object.fromEntries(planSnapshot().tasks.map((task) => [task.id, task.title]))}
            />
          }
          subagents={
            <SubagentProfilesPanel
              directory={data.directory()}
              models={catalogQuery.data?.models ?? []}
              onSaved={refreshAfterSubagentsChange}
            />
          }
        />
      }
      pendingActions={pendingActions()}
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
