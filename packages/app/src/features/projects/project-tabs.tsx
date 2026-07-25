import type { SessionStatus } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { createQuery } from "@tanstack/solid-query"
import { Plus, X } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { keys, normalizeDirectory } from "../../data/query-keys"
import { directoryName } from "../../platform/desktop-path"
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
  return directoryName(project.directory) || project.directory
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
  dragOffset: number
  onPointerDown: (event: PointerEvent) => void
  onPointerMove: (event: PointerEvent) => void
  onPointerUp: (event: PointerEvent) => void
  onPointerCancel: (event: PointerEvent) => void
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
      data-project-directory={props.project.directory}
      title={props.project.directory}
      style={
        props.dragOffset === 0
          ? undefined
          : {
              transform: `translateX(calc(${props.dragOffset} * (var(--project-tab-width) + 3px)))`,
              "z-index": props.dragging ? "3" : undefined,
            }
      }
    >
      <button
        type="button"
        role="tab"
        class="project-tab__select"
        aria-selected={props.active}
        aria-label={tr("projects.switch-to-project", { name: projectName(props.project) })}
        data-state={state()}
        disabled={props.disabled}
        onPointerDown={props.onPointerDown}
        onPointerMove={props.onPointerMove}
        onPointerUp={props.onPointerUp}
        onPointerCancel={props.onPointerCancel}
        onClick={() => {
          if (!props.active) props.onSelect()
        }}
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
  const [previewOrder, setPreviewOrder] = createSignal<string[]>()
  const [suppressSelection, setSuppressSelection] = createSignal(false)
  let pointerDrag:
    | {
        pointerId: number
        sourceDirectory: string
        startX: number
        startY: number
        active: boolean
        slots: Array<{
          directory: string
          left: number
          right: number
          top: number
          bottom: number
        }>
      }
    | undefined
  let suppressSelectionTimer: ReturnType<typeof setTimeout> | undefined

  function clearDrag() {
    setDragging(undefined)
    setDropTarget(undefined)
    setPreviewOrder(undefined)
  }

  function previewOrderFor(sourceDirectory: string, targetDirectory: string, placement: "before" | "after") {
    const order = props.projects.map((project) => project.directory)
    const sourceIndex = order.indexOf(sourceDirectory)
    if (sourceIndex < 0) return undefined
    order.splice(sourceIndex, 1)
    const targetIndex = order.indexOf(targetDirectory)
    if (targetIndex < 0) return undefined
    order.splice(targetIndex + (placement === "after" ? 1 : 0), 0, sourceDirectory)
    return order
  }

  function updatePointerDropTarget(sourceDirectory: string, clientX: number, clientY: number) {
    const current = pointerDrag
    const target = current?.slots.find(
      (slot) =>
        slot.directory !== sourceDirectory &&
        clientX >= slot.left &&
        clientX <= slot.right &&
        clientY >= slot.top &&
        clientY <= slot.bottom,
    )
    if (!target || normalizeDirectory(target.directory) === normalizeDirectory(sourceDirectory)) {
      setDropTarget(undefined)
      setPreviewOrder(undefined)
      return
    }

    const placement = clientX > target.left + (target.right - target.left) / 2 ? "after" : "before"
    setDropTarget({
      directory: target.directory,
      placement,
    })
    setPreviewOrder(previewOrderFor(sourceDirectory, target.directory, placement))
  }

  function suppressNextSelection() {
    setSuppressSelection(true)
    if (suppressSelectionTimer !== undefined) clearTimeout(suppressSelectionTimer)
    suppressSelectionTimer = setTimeout(() => {
      suppressSelectionTimer = undefined
      setSuppressSelection(false)
    }, 0)
  }

  function consumeSuppressedSelection() {
    if (!suppressSelection()) return false
    if (suppressSelectionTimer !== undefined) {
      clearTimeout(suppressSelectionTimer)
      suppressSelectionTimer = undefined
    }
    setSuppressSelection(false)
    return true
  }

  function startPointerDrag(sourceDirectory: string, event: PointerEvent) {
    if (props.disabled || event.button !== 0 || !event.isPrimary) return
    const source = event.currentTarget as HTMLButtonElement
    source.setPointerCapture?.(event.pointerId)
    const list = source.closest<HTMLElement>(".project-tabs__list")
    const slots = list
      ? Array.from(list.querySelectorAll<HTMLElement>("[data-project-directory]")).map((tab) => {
          const bounds = tab.getBoundingClientRect()
          return {
            directory: tab.dataset.projectDirectory ?? "",
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            bottom: bounds.bottom,
          }
        })
      : []
    pointerDrag = {
      pointerId: event.pointerId,
      sourceDirectory,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      slots,
    }
  }

  function movePointerDrag(event: PointerEvent) {
    const current = pointerDrag
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 6) return

    if (!current.active) {
      current.active = true
      setDragging(current.sourceDirectory)
    }
    event.preventDefault()
    updatePointerDropTarget(current.sourceDirectory, event.clientX, event.clientY)
  }

  function finishPointerDrag(event: PointerEvent, commit: boolean) {
    const current = pointerDrag
    if (!current || current.pointerId !== event.pointerId) return

    if (current.active) {
      event.preventDefault()
      const target = dropTarget()
      if (commit && target) props.onReorder(current.sourceDirectory, target.directory, target.placement)
      suppressNextSelection()
    }
    const source = event.currentTarget as HTMLButtonElement
    if (source.hasPointerCapture?.(event.pointerId)) source.releasePointerCapture?.(event.pointerId)
    pointerDrag = undefined
    clearDrag()
  }

  function dragOffset(directory: string) {
    const preview = previewOrder()
    if (!preview) return 0
    const originalIndex = props.projects.findIndex((project) => project.directory === directory)
    const previewIndex = preview.indexOf(directory)
    return originalIndex < 0 || previewIndex < 0 ? 0 : previewIndex - originalIndex
  }

  onCleanup(() => {
    pointerDrag = undefined
    if (suppressSelectionTimer !== undefined) clearTimeout(suppressSelectionTimer)
  })

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
              onSelect={() => {
                if (consumeSuppressedSelection()) return
                props.onSelect(project.directory)
              }}
              onClose={() => props.onClose(project.directory)}
              dragging={dragging() === project.directory}
              dropPlacement={dropTarget()?.directory === project.directory ? dropTarget()?.placement : undefined}
              dragOffset={dragOffset(project.directory)}
              onPointerDown={(event) => startPointerDrag(project.directory, event)}
              onPointerMove={movePointerDrag}
              onPointerUp={(event) => finishPointerDrag(event, true)}
              onPointerCancel={(event) => finishPointerDrag(event, false)}
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
