import type { SessionStatus } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { createQuery } from "@tanstack/solid-query"
import { Plus, X } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { keys, normalizeDirectory } from "../../data/query-keys"
import { publishDesktopNotificationEvent } from "../notifications/desktop-notifications"
import { tr } from "../../i18n/i18n-context"
import type { OpenedProject } from "./project-controller"

const statusCache = new Map<string, Record<string, SessionStatus>>()
let statusEventSequence = 0

type ProjectStatusTransition = {
  sessionID: string
  status: "running" | "retry" | "idle"
}

function notificationStatus(status: SessionStatus | undefined): ProjectStatusTransition["status"] {
  if (status?.type === "busy") return "running"
  if (status?.type === "retry") return "retry"
  return "idle"
}

export function projectStatusTransitions(
  previous: Record<string, SessionStatus>,
  current: Record<string, SessionStatus>,
): ProjectStatusTransition[] {
  const sessionIDs = new Set([...Object.keys(previous), ...Object.keys(current)])
  const transitions: ProjectStatusTransition[] = []
  for (const sessionID of sessionIDs) {
    const before = notificationStatus(previous[sessionID])
    const after = notificationStatus(current[sessionID])
    if (before === after) continue
    transitions.push({ sessionID, status: after })
  }
  return transitions
}

export type ProjectTabsProps = {
  projects: readonly OpenedProject[]
  activeDirectory: string
  queryClient: QueryClient
  disabled?: boolean
  onSelect: (directory: string) => void
  onOpen: () => void
  onClose: (directory: string) => void
  onReorder: (sourceDirectory: string, targetDirectory: string, placement: "before" | "after") => void
}

function projectName(project: OpenedProject) {
  if (project.info.name) return project.info.name
  return project.directory.replaceAll("/", "\\").split("\\").filter(Boolean).at(-1) ?? project.directory
}

function ProjectTab(props: {
  project: OpenedProject
  active: boolean
  queryClient: QueryClient
  disabled?: boolean
  onSelect: () => void
  onClose: () => void
  dragging: boolean
  dropPlacement?: "before" | "after"
  onDragStart: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
  onDragEnd: () => void
}) {
  const [unread, setUnread] = createSignal(0)
  const statusKey = () => normalizeDirectory(props.project.directory)
  let notificationStatuses = statusCache.get(statusKey()) ?? {}
  const status = createQuery(
    () => ({
      queryKey: keys.status(props.project.directory),
      queryFn: async () => {
        const result = await props.project.client.session.status(
          { directory: props.project.directory },
          { throwOnError: true },
        )
        const next = (result.data ?? {}) as Record<string, SessionStatus>
        statusCache.set(statusKey(), next)
        return next
      },
      initialData: statusCache.get(statusKey()),
      refetchInterval: 3_000,
      refetchIntervalInBackground: true,
    }),
    () => props.queryClient,
  )
  const running = createMemo(
    () => Object.values(status.data ?? {}).filter((item) => item.type === "busy" || item.type === "retry").length,
  )
  let previousRunning: number | undefined

  createEffect(() => {
    const current = status.data
    if (!current) return
    for (const transition of projectStatusTransitions(notificationStatuses, current)) {
      publishDesktopNotificationEvent({
        kind: "status",
        eventID: `project-status:${statusKey()}:${transition.sessionID}:${transition.status}:${++statusEventSequence}`,
        sessionID: transition.sessionID,
        status: transition.status,
      })
    }
    notificationStatuses = current
  })

  createEffect(() => {
    const current = running()
    if (props.active) setUnread(0)
    else if (previousRunning !== undefined && current < previousRunning) {
      setUnread((value) => value + previousRunning! - current)
    }
    previousRunning = current
  })

  const state = () => (running() > 0 ? "running" : unread() > 0 ? "complete" : "idle")

  return (
    <div
      class="project-tab"
      data-state={state()}
      data-active={props.active}
      data-dragging={props.dragging || undefined}
      data-drop-placement={props.dropPlacement}
      draggable={!props.disabled}
      title={props.project.directory}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnd={props.onDragEnd}
    >
      <button
        type="button"
        role="tab"
        class="project-tab__select"
        aria-selected={props.active}
        aria-label={tr("projects.switch-to-project", { name: projectName(props.project) })}
        data-state={state()}
        disabled={props.disabled || props.active}
        onClick={props.onSelect}
      >
        <span class="project-tab__dot" aria-hidden="true" />
        <strong>{projectName(props.project)}</strong>
        <Show when={running() > 0}>
          <small>{tr("projects.running-task-count", { count: running() })}</small>
        </Show>
        <Show when={unread() > 0}>
          <span class="project-tab__badge" aria-label={tr("projects.completed-task-count", { count: unread() })}>
            {unread()}
          </span>
        </Show>
      </button>
      <button
        type="button"
        class="project-tab__close"
        aria-label={tr("projects.close-project", { name: projectName(props.project) })}
        disabled={props.disabled}
        onClick={props.onClose}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  )
}

export function ProjectTabs(props: ProjectTabsProps) {
  const [dragging, setDragging] = createSignal<string>()
  const [dropTarget, setDropTarget] = createSignal<{
    directory: string
    placement: "before" | "after"
  }>()

  function clearDrag() {
    setDragging(undefined)
    setDropTarget(undefined)
  }

  return (
    <nav class="project-tabs" aria-label={tr("projects.open-projects")}>
      <div class="project-tabs__list" role="tablist">
        <For each={props.projects}>
          {(project) => (
            <ProjectTab
              project={project}
              active={normalizeDirectory(project.directory) === normalizeDirectory(props.activeDirectory)}
              queryClient={props.queryClient}
              disabled={props.disabled}
              onSelect={() => props.onSelect(project.directory)}
              onClose={() => props.onClose(project.directory)}
              dragging={dragging() === project.directory}
              dropPlacement={
                dropTarget()?.directory === project.directory ? dropTarget()?.placement : undefined
              }
              onDragStart={(event) => {
                setDragging(project.directory)
                event.dataTransfer?.setData("text/plain", project.directory)
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
              }}
              onDragOver={(event) => {
                const source = dragging()
                if (!source || source === project.directory) return
                event.preventDefault()
                const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
                const placement = event.clientX > bounds.left + bounds.width / 2 ? "after" : "before"
                setDropTarget({ directory: project.directory, placement })
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
              }}
              onDrop={(event) => {
                event.preventDefault()
                const source = dragging() ?? event.dataTransfer?.getData("text/plain")
                const target = dropTarget()
                if (source && target?.directory === project.directory) {
                  props.onReorder(source, project.directory, target.placement)
                }
                clearDrag()
              }}
              onDragEnd={clearDrag}
            />
          )}
        </For>
        <button
          type="button"
          class="project-tabs__open"
          aria-label={tr("projects.open-directory")}
          disabled={props.disabled}
          onClick={props.onOpen}
        >
          <Plus aria-hidden="true" />
        </button>
      </div>
      <span class="project-tabs__count">{tr("projects.open-project-count", { count: props.projects.length })}</span>
    </nav>
  )
}
