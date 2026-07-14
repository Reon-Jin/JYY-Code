import { FileDiff, ListTodo, Network } from "lucide-solid"
import { onCleanup, onMount, Show, type JSX } from "solid-js"
import { IconButton } from "../../components/ui/button"
import { ChangesPanel } from "../changes/changes-panel"
import { TodoPanel } from "../todos/todo-panel"
import type { InspectorPane } from "./inspector-preferences"
import "./workspace-inspector.css"

const paneLabels: Record<InspectorPane, string> = {
  todo: "Todo",
  "multi-agent": "Multi-Agent",
  changes: "工作区变更",
}

function isNarrow() {
  return typeof window !== "undefined" && window.matchMedia?.("(max-width: 960px)").matches === true
}

export type WorkspaceInspectorViewProps = {
  pane?: InspectorPane
  onPaneChange: (pane: InspectorPane | undefined) => void
  todo: JSX.Element
  multiAgent: JSX.Element
  changes: JSX.Element
  todoBadge?: JSX.Element
  multiAgentBadge?: JSX.Element
  changesBadge?: JSX.Element
}

export function WorkspaceInspectorView(props: WorkspaceInspectorViewProps) {
  const selectPane = (next: InspectorPane) => props.onPaneChange(next === props.pane ? undefined : next)
  const panel = (pane: InspectorPane) => {
    if (pane === "todo") return props.todo
    if (pane === "multi-agent") return props.multiAgent
    return props.changes
  }

  function keydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !props.pane || !isNarrow()) return
    props.onPaneChange(undefined)
  }

  onMount(() => window.addEventListener("keydown", keydown))
  onCleanup(() => window.removeEventListener("keydown", keydown))

  const ActivityButton = (buttonProps: {
    pane: InspectorPane
    icon: JSX.Element
    badge?: JSX.Element
  }) => (
    <IconButton
      class="workspace-activity-button"
      label={paneLabels[buttonProps.pane]}
      variant="ghost"
      aria-controls={props.pane === buttonProps.pane ? "workspace-drawer" : undefined}
      aria-pressed={props.pane === buttonProps.pane}
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

  return (
    <>
      <Show when={props.pane && isNarrow()}>
        <button
          type="button"
          class="workspace-drawer-scrim"
          aria-label="关闭工作栏页面"
          onClick={() => props.onPaneChange(undefined)}
        />
      </Show>
      <Show when={props.pane} keyed>
        {(pane) => (
          <aside id="workspace-drawer" class="workspace-drawer" aria-label={paneLabels[pane]}>
            {panel(pane)}
          </aside>
        )}
      </Show>
      <nav class="workspace-activity-rail" aria-label="工作栏页面">
        <ActivityButton
          pane="todo"
          icon={<ListTodo aria-hidden="true" />}
          badge={props.todoBadge}
        />
        <ActivityButton
          pane="multi-agent"
          icon={<Network aria-hidden="true" />}
          badge={props.multiAgentBadge}
        />
        <ActivityButton
          pane="changes"
          icon={<FileDiff aria-hidden="true" />}
          badge={props.changesBadge}
        />
      </nav>
    </>
  )
}

export function WorkspaceInspector(props: {
  directory: string
  sessionID?: string
  pane?: InspectorPane
  onPaneChange: (pane: InspectorPane | undefined) => void
  multiAgent?: JSX.Element
  multiAgentBadge?: JSX.Element
}) {
  return (
    <WorkspaceInspectorView
      pane={props.pane}
      onPaneChange={props.onPaneChange}
      todo={<TodoPanel directory={props.directory} sessionID={props.sessionID} />}
      multiAgent={
        props.multiAgent ?? (
          <section class="workspace-drawer__placeholder" aria-labelledby="multi-agent-placeholder-title">
            <h2 id="multi-agent-placeholder-title">Multi-Agent</h2>
            <p>选择 Session 后可在这里查看 Agent 计划与进度。</p>
          </section>
        )
      }
      changes={<ChangesPanel directory={props.directory} />}
      multiAgentBadge={props.multiAgentBadge}
    />
  )
}
