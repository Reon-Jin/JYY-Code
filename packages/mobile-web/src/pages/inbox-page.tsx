import { Filter } from "lucide-solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { inboxItems, type InboxKind, type RemoteTask } from "../lib/models"

const filters: Array<{ id: "all" | InboxKind; label: string }> = [
  { id: "all", label: "全部" }, { id: "question", label: "问题" }, { id: "permission", label: "权限" }, { id: "failed", label: "失败" }, { id: "completed", label: "完成" },
]

export function InboxPage(props: { tasks: RemoteTask[]; onOpenTask: (task: RemoteTask) => void }) {
  const [filter, setFilter] = createSignal<"all" | InboxKind>("all")
  const items = createMemo(() => inboxItems(props.tasks).filter((item) => filter() === "all" || item.kind === filter()))
  function taskFor(id: string) { return props.tasks.find((task) => task.id === id) }

  return <section class="page inbox-page"><header class="page-header"><div><span class="wordmark">待处理</span><p>跨项目统一处理</p></div><Filter /></header><div class="filter-strip" role="tablist">{filters.map((item) => <button classList={{ "is-active": filter() === item.id }} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div><Show when={items().length > 0} fallback={<p class="empty-state">当前筛选下没有待处理事项。</p>}><div class="inbox-list"><For each={items()}>{(item) => { const task = () => taskFor(item.taskID); return <button class="inbox-row" onClick={() => task() && props.onOpenTask(task()!)}><span class={`inbox-marker inbox-marker--${item.kind}`} /><span><small>{item.project}</small><strong>{item.title}</strong><em>{kindLabel(item.kind)}</em></span><time>{formatTime(item.updatedAt)}</time></button> }}</For></div></Show></section>
}

function kindLabel(kind: InboxKind) { return ({ question: "需要回答", permission: "等待批准", failed: "需要重试", completed: "已完成" })[kind] }
function formatTime(value: string) { const time = new Date(value); return Number.isNaN(time.getTime()) ? "刚刚" : time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }
