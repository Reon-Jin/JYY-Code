import type { Session, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import { useNavigate } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { FolderOpen, PanelLeftClose, PanelLeftOpen, Plus, Radio } from "lucide-solid"
import { createMemo, createSignal, Show } from "solid-js"
import { Button, IconButton } from "../components/ui/button"
import { InlineError } from "../components/ui/inline-error"
import { useData } from "../data/context"
import type { ConnectionState } from "../data/event-bridge"
import { keys } from "../data/query-keys"
import { errorMessage } from "../features/projects/project-controller"
import { useProjects } from "../features/projects/project-context"
import { createSessionApi } from "../features/sessions/session-api"
import { SessionEmpty } from "../features/sessions/session-empty"
import { SessionList } from "../features/sessions/session-list"
import "../features/sessions/sessions.css"

type AsyncSessionAction = (sessionID: string) => Promise<void>

export type WorkspaceLayoutViewProps = {
  projectName: string
  projectDirectory: string
  connection: ConnectionState
  activeSessions: readonly Session[]
  archivedSessions: readonly Session[]
  statuses: Record<string, SessionStatus>
  activeSessionID?: string
  activeLoading?: boolean
  archivedLoading?: boolean
  activeError?: string
  archivedError?: string
  operationError?: string
  busy?: boolean
  onRetryActive?: () => void
  onRetryArchived?: () => void
  onSwitchProject: () => Promise<void>
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
    <div class="workspace-shell" data-rail-open={railOpen() ? "true" : "false"}>
      <aside
        id="session-navigation"
        class="workspace-rail"
        aria-label="项目与 Session 导航"
        aria-hidden={railOpen() ? "false" : "true"}
        inert={!railOpen() ? true : undefined}
      >
        <header class="workspace-project">
          <span class="workspace-project__mark" aria-hidden="true">J</span>
          <span class="workspace-project__copy">
            <strong>{props.projectName}</strong>
            <small>{props.projectDirectory}</small>
          </span>
          <IconButton
            label="切换项目"
            variant="ghost"
            disabled={props.busy}
            onClick={() => void props.onSwitchProject()}
          >
            <FolderOpen aria-hidden="true" />
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
          onCreate={() => void props.onCreate()}
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
          when={selected()}
          fallback={<SessionEmpty disabled={props.busy || props.activeLoading} onCreate={() => void props.onCreate()} />}
        >
          {(session) => (
            <section class="workspace-conversation-placeholder" aria-labelledby="workspace-session-title">
              <span class="workspace-conversation-placeholder__eyebrow">Single Agent Workspace</span>
              <h1 id="workspace-session-title">{session().title}</h1>
              <p>Session 已就绪。下一步将在这里加载对话消息与实时生成状态。</p>
            </section>
          )}
        </Show>
      </main>
    </div>
  )
}

export function WorkspaceLayout(props: { activeSessionID?: string }) {
  const data = useData()
  const projects = useProjects()
  const navigate = useNavigate()
  const [operationError, setOperationError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
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
      const session = await api().create({ title: "New session" })
      navigate(`/session/${encodeURIComponent(session.id)}`)
    } catch (cause) {
      setOperationError(errorMessage(cause, "无法创建 Session"))
    } finally {
      setBusy(false)
    }
  }

  async function switchProject() {
    setBusy(true)
    setOperationError(undefined)
    try {
      const project = await projects.chooseAndOpenProject()
      if (project) navigate("/")
    } catch (cause) {
      setOperationError(errorMessage(cause, "无法切换项目"))
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

  return (
    <WorkspaceLayoutView
      projectName={projectName()}
      projectDirectory={data.directory()}
      connection={data.connection()}
      activeSessions={activeQuery.data ?? []}
      archivedSessions={archivedQuery.data ?? []}
      statuses={statusQuery.data ?? {}}
      activeSessionID={props.activeSessionID}
      activeLoading={activeQuery.isPending}
      archivedLoading={archivedQuery.isPending}
      activeError={activeQuery.error ? errorMessage(activeQuery.error, "无法加载活动 Session") : undefined}
      archivedError={archivedQuery.error ? errorMessage(archivedQuery.error, "无法加载归档 Session") : undefined}
      operationError={operationError()}
      busy={busy()}
      onRetryActive={() => void activeQuery.refetch()}
      onRetryArchived={() => void archivedQuery.refetch()}
      onSwitchProject={switchProject}
      onCreate={createNewSession}
      onRename={rename}
      onArchive={archive}
      onDelete={remove}
    />
  )
}
