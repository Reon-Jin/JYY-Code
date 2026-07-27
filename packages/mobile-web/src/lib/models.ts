export type TaskStatus = "running" | "waiting" | "completed" | "failed" | "idle"

export type TodoItem = { id: string; title: string; isComplete: boolean }
export type TaskChild = { id: string; title: string; status: TaskStatus }
export type TaskEvent = { id: string; title: string; date: string }

export type PendingAction =
  | { type: "permission"; id: string; title: string }
  | { type: "question"; id: string; title: string; options: string[] }

export type RemoteTask = {
  id: string
  deviceID: string
  project?: string
  title: string
  status: TaskStatus
  summary: string
  progress: number
  updatedAt: string
  todo: TodoItem[]
  children: TaskChild[]
  pending?: PendingAction | null
  timeline: TaskEvent[]
}

export type RemoteDetail = { kind: "conversation" | "diff"; content: string }

export type RemoteAction =
  | { type: "createTask"; workspace: string; prompt: string }
  | { type: "sendMessage"; message: string }
  | { type: "stop" }
  | { type: "retry" }
  | { type: "approvePermission"; id: string; approved: boolean }
  | { type: "answerQuestion"; id: string; answer: string }
  | { type: "loadConversation" }
  | { type: "loadDiff" }
  | { type: "revokeDevice" }

export type InboxKind = "question" | "permission" | "failed" | "completed"
export type InboxItem = { id: string; taskID: string; project: string; title: string; kind: InboxKind; updatedAt: string }

export function inboxItems(tasks: RemoteTask[]): InboxItem[] {
  return tasks.flatMap<InboxItem>((task) => {
    const project = task.project || "未命名项目"
    if (task.pending?.type === "permission" || task.pending?.type === "question") {
      return [{ id: task.pending.id, taskID: task.id, project, title: task.pending.title, kind: task.pending.type, updatedAt: task.updatedAt }]
    }
    if (task.status === "failed" || task.status === "completed") {
      return [{ id: task.id, taskID: task.id, project, title: task.title, kind: task.status, updatedAt: task.updatedAt }]
    }
    return []
  })
}

export function taskProject(task: RemoteTask) {
  return task.project?.trim() || "未命名项目"
}
