import { tr } from "../../i18n/i18n-context"
import { File, FileDiff, ListTodo, MessageSquare, Users } from "lucide-solid"
import { For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { IconButton } from "../../components/ui/button"
import { ChangesPanel } from "../changes/changes-panel"
import { FileTree, type FileOpenEvent } from "../files/file-tree"
import { PlanPanel } from "../plan/plan-panel"
import { SubagentProfilesPanel } from "../subagents/subagent-profiles-panel"
import { normalizeInspectorRatios, type InspectorPane, type InspectorPreferences } from "./inspector-preferences"
import { playSoundEffect } from "../sound-effects/sound-effects"
import "./workspace-inspector.css"

function paneLabel(pane: InspectorPane) {
  const labels: Record<InspectorPane, string> = {
    plan: tr("workspace-inspector.plan"),
    subagents: tr("subagents.title"),
    blackboard: tr("workspace-inspector.blackboard"),
    changes: tr("changes.workspace-changes"),
    files: tr("workspace-inspector.files"),
  }
  return labels[pane]
}

function isNarrow() {
  return typeof window !== "undefined" && window.matchMedia?.("(max-width: 960px)").matches === true
}

function clampWidth(width: number) {
  const viewport = typeof window === "undefined" ? 1_260 : window.innerWidth
  return Math.min(Math.max(280, width), Math.max(280, viewport / 2))
}

export type WorkspaceInspectorViewProps = {
  preferences: InspectorPreferences
  onPreferencesChange: (preferences: InspectorPreferences) => void
  plan: JSX.Element
  blackboard?: JSX.Element
  changes: JSX.Element
  files?: JSX.Element
  subagents?: JSX.Element
  planBadge?: JSX.Element
  blackboardBadge?: JSX.Element
  changesBadge?: JSX.Element
}

export function WorkspaceInspectorView(props: WorkspaceInspectorViewProps) {
  let stack: HTMLDivElement | undefined

  const update = (change: Partial<InspectorPreferences>) =>
    props.onPreferencesChange({ ...props.preferences, ...change })

  const selectPane = (next: InspectorPane) => {
    const index = props.preferences.panes.indexOf(next)
    if (index >= 0) {
      const panes = props.preferences.panes.filter((pane) => pane !== next)
      const ratios = props.preferences.ratios.filter((_, ratioIndex) => ratioIndex !== index)
      update({ panes, ratios: normalizeInspectorRatios(panes.length, ratios) })
      return
    }
    const panes = [...props.preferences.panes, next]
    update({ panes, ratios: normalizeInspectorRatios(panes.length) })
  }

  const panel = (pane: InspectorPane) => {
    if (pane === "plan") return props.plan
    if (pane === "blackboard") return props.blackboard
    if (pane === "subagents") return props.subagents ?? <div />
    if (pane === "files") return props.files ?? <div />
    return props.changes
  }

  function setBoundary(index: number, delta: number) {
    const ratios = normalizeInspectorRatios(props.preferences.panes.length, props.preferences.ratios)
    const minimum = Math.min(0.12, 1 / ratios.length)
    const bounded = Math.max(-(ratios[index]! - minimum), Math.min(ratios[index + 1]! - minimum, delta))
    ratios[index] = ratios[index]! + bounded
    ratios[index + 1] = ratios[index + 1]! - bounded
    update({ ratios })
  }

  function startVerticalResize(event: PointerEvent, index: number) {
    event.preventDefault()
    const startY = event.clientY
    const height = stack?.getBoundingClientRect().height ?? 1
    let previousDelta = 0
    const move = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientY - startY) / height
      setBoundary(index, delta - previousDelta)
      previousDelta = delta
    }
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop, { once: true })
  }

  function startWidthResize(event: PointerEvent) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = clampWidth(props.preferences.width)
    const shell = (event.currentTarget as HTMLElement).closest<HTMLElement>(".workspace-shell")
    let width = startWidth
    let frame = 0
    shell?.setAttribute("data-inspector-resizing", "true")
    const renderPreview = () => {
      frame = 0
      shell?.style.setProperty("--workspace-inspector-width", `${width}px`)
    }
    const move = (moveEvent: PointerEvent) => {
      width = clampWidth(startWidth + startX - moveEvent.clientX)
      if (!frame) frame = window.requestAnimationFrame(renderPreview)
    }
    const stop = () => {
      if (frame) window.cancelAnimationFrame(frame)
      renderPreview()
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      update({ width })
      shell?.removeAttribute("data-inspector-resizing")
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop, { once: true })
  }

  function keydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || props.preferences.panes.length === 0 || !isNarrow()) return
    playSoundEffect("panel-close")
    update({ panes: [], ratios: [] })
  }

  onMount(() => window.addEventListener("keydown", keydown))
  onCleanup(() => window.removeEventListener("keydown", keydown))

  const ActivityButton = (buttonProps: { pane: InspectorPane; icon: JSX.Element; badge?: JSX.Element }) => {
    const active = () => props.preferences.panes.includes(buttonProps.pane)
    return (
      <IconButton
        class="workspace-activity-button"
        data-sound-effect={active() ? "panel-close" : "panel-open"}
        label={paneLabel(buttonProps.pane)}
        variant="ghost"
        aria-controls={active() ? "workspace-drawer" : undefined}
        aria-pressed={active()}
        onClick={() => selectPane(buttonProps.pane)}
      >
        {buttonProps.icon}
        <Show when={buttonProps.badge !== undefined}>
          <span class="workspace-activity-button__badge" aria-hidden="true">
            {buttonProps.badge}
          </span>
        </Show>
      </IconButton>
    )
  }

  const gridRows = () =>
    normalizeInspectorRatios(props.preferences.panes.length, props.preferences.ratios)
      .flatMap((ratio, index) =>
        index < props.preferences.panes.length - 1 ? [`minmax(96px, ${ratio}fr)`, "7px"] : [`minmax(96px, ${ratio}fr)`],
      )
      .join(" ")

  return (
    <>
      <Show when={props.preferences.panes.length > 0 && isNarrow()}>
        <button
          type="button"
          class="workspace-drawer-scrim"
          data-sound-effect="panel-close"
          aria-label={tr("workspace-inspector.close-the-taskbar-page")}
          onClick={() => update({ panes: [], ratios: [] })}
        />
      </Show>
      <Show when={props.preferences.panes.length > 0}>
        <div id="workspace-drawer" class="workspace-drawer">
          <div
            class="workspace-drawer__width-handle"
            role="separator"
            aria-label={tr("workspace-inspector.adjust-taskbar-width")}
            aria-orientation="vertical"
            aria-valuemin="280"
            aria-valuemax={Math.round(Math.max(280, window.innerWidth / 2))}
            aria-valuenow={Math.round(clampWidth(props.preferences.width))}
            tabIndex={0}
            onPointerDown={startWidthResize}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
              event.preventDefault()
              update({ width: clampWidth(props.preferences.width + (event.key === "ArrowLeft" ? 20 : -20)) })
            }}
          />
          <div ref={stack} class="workspace-drawer__stack" style={{ "grid-template-rows": gridRows() }}>
            <For each={props.preferences.panes}>
              {(pane, index) => (
                <>
                  <div class="workspace-drawer__pane" role="group" aria-label={paneLabel(pane)}>
                    {panel(pane)}
                  </div>
                  <Show when={index() < props.preferences.panes.length - 1}>
                    <div
                      class="workspace-drawer__row-handle"
                      role="separator"
                      aria-label={tr("workspace-inspector.resize-pane", { pane: paneLabel(pane) })}
                      aria-orientation="horizontal"
                      tabIndex={0}
                      onPointerDown={(event) => startVerticalResize(event, index())}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
                        event.preventDefault()
                        setBoundary(index(), event.key === "ArrowDown" ? 0.05 : -0.05)
                      }}
                    />
                  </Show>
                </>
              )}
            </For>
          </div>
        </div>
      </Show>
      <nav class="workspace-activity-rail" aria-label={tr("workspace-inspector.taskbar-page")}>
        <ActivityButton pane="plan" icon={<ListTodo aria-hidden="true" />} badge={props.planBadge} />
        <ActivityButton pane="subagents" icon={<Users aria-hidden="true" />} />
        <ActivityButton pane="blackboard" icon={<MessageSquare aria-hidden="true" />} badge={props.blackboardBadge} />
        <ActivityButton pane="changes" icon={<FileDiff aria-hidden="true" />} badge={props.changesBadge} />
        <ActivityButton pane="files" icon={<File aria-hidden="true" />} />
      </nav>
    </>
  )
}

export function WorkspaceInspector(props: {
  directory: string
  workspaceID?: string
  sessionID?: string
  diffDirectory?: string
  diffWorkspaceID?: string
  diffSessionID?: string
  diffMode?: "git" | "session"
  fileDirectory?: string
  fileWorkspaceID?: string
  fileSessionID?: string
  preferences: InspectorPreferences
  onPreferencesChange: (preferences: InspectorPreferences) => void
  onOpenFile?: (event: FileOpenEvent) => void
  plan?: JSX.Element
  blackboard?: JSX.Element
  planBadge?: JSX.Element
  blackboardBadge?: JSX.Element
  subagents?: JSX.Element
}) {
  return (
    <WorkspaceInspectorView
      preferences={props.preferences}
      onPreferencesChange={props.onPreferencesChange}
      plan={
        props.plan ?? (
          <PlanPanel
            directory={props.directory}
            sessionID={props.sessionID}
            rootSessionID={props.sessionID}
            onOpenChild={() => undefined}
          />
        )
      }
      blackboard={props.blackboard ?? <div />}
      subagents={props.subagents ?? <SubagentProfilesPanel directory={props.directory} />}
      changes={
        <ChangesPanel
          directory={props.diffDirectory ?? props.directory}
          workspaceID={props.diffWorkspaceID ?? props.workspaceID}
          sessionID={props.diffSessionID ?? props.sessionID}
          mode={props.diffMode}
          onOpenFile={props.onOpenFile}
        />
      }
      files={
        <FileTree
          directory={props.fileDirectory ?? props.directory}
          workspaceID={props.fileWorkspaceID ?? props.workspaceID}
          sessionID={props.fileSessionID ?? props.sessionID}
          onOpenFile={props.onOpenFile}
        />
      }
      planBadge={props.planBadge}
      blackboardBadge={props.blackboardBadge}
    />
  )
}
