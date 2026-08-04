import { ChevronRight } from "lucide-solid"
import type { RemoteTask } from "../lib/models"
import { taskProject } from "../lib/models"

export function TaskRow(props: { task: RemoteTask; onOpen: () => void }) {
  return (
    <button class="task-row" onClick={props.onOpen}>
      <span class="task-row__body">
        <span class="task-row__meta">
          <span>{taskProject(props.task)}</span>
          <Status status={props.task.status} />
        </span>
        <strong>{props.task.title}</strong>
        <small>{props.task.summary}</small>
      </span>
      <ChevronRight />
    </button>
  )
}

export function Status(props: { status: RemoteTask["status"] }) {
  const label = () =>
    ({ running: "进行中", waiting: "待处理", completed: "已完成", failed: "失败", idle: "空闲" })[props.status]
  return <span class={`status-dot status-dot--${props.status}`}>{label()}</span>
}
