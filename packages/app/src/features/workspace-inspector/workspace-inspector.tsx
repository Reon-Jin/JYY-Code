import { PanelRightClose, PanelRightOpen } from "lucide-solid"
import { Show, type JSX } from "solid-js"
import { IconButton } from "../../components/ui/button"
import { ChangesPanel } from "../changes/changes-panel"
import { TodoPanel } from "../todos/todo-panel"
import { ResizableSplit } from "./resizable-split"
import "./workspace-inspector.css"

export type WorkspaceInspectorViewProps = {
  open: boolean
  todoRatio: number
  onOpenChange: (open: boolean) => void
  onTodoRatioChange: (ratio: number) => void
  todo: JSX.Element
  changes: JSX.Element
}

export function WorkspaceInspectorView(props: WorkspaceInspectorViewProps) {
  return (
    <>
      <IconButton
        class="workspace-inspector-toggle"
        label={props.open ? "收起工作栏" : "展开工作栏"}
        variant="secondary"
        aria-controls="workspace-inspector"
        aria-expanded={props.open}
        onClick={() => props.onOpenChange(!props.open)}
      >
        <Show when={props.open} fallback={<PanelRightOpen aria-hidden="true" />}>
          <PanelRightClose aria-hidden="true" />
        </Show>
      </IconButton>

      <aside
        id="workspace-inspector"
        class="workspace-inspector"
        aria-label="工作栏"
        aria-hidden={props.open ? "false" : "true"}
        inert={!props.open ? true : undefined}
        style={`--todo-ratio: ${props.todoRatio}fr; --changes-ratio: ${1 - props.todoRatio}fr`}
      >
        <div class="workspace-inspector__region workspace-inspector__region--todo" role="region" aria-label="Todo">
          {props.todo}
        </div>
        <ResizableSplit value={props.todoRatio} onChange={props.onTodoRatioChange} />
        <div
          class="workspace-inspector__region workspace-inspector__region--changes"
          role="region"
          aria-label="工作区变更"
        >
          {props.changes}
        </div>
      </aside>
    </>
  )
}

export function WorkspaceInspector(props: {
  directory: string
  sessionID?: string
  open: boolean
  todoRatio: number
  onOpenChange: (open: boolean) => void
  onTodoRatioChange: (ratio: number) => void
}) {
  return (
    <WorkspaceInspectorView
      open={props.open}
      todoRatio={props.todoRatio}
      onOpenChange={props.onOpenChange}
      onTodoRatioChange={props.onTodoRatioChange}
      todo={<TodoPanel directory={props.directory} sessionID={props.sessionID} />}
      changes={<ChangesPanel directory={props.directory} />}
    />
  )
}
