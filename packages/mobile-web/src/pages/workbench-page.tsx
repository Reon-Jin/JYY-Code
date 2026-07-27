import { ChevronRight, Monitor, Plus, RefreshCw } from "lucide-solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { ProjectSwitcher, ALL_PROJECTS } from "../components/project-switcher"
import { TaskRow } from "../components/task-row"
import { taskProject, type RemoteAction, type RemoteTask } from "../lib/models"

export function WorkbenchPage(props: {
  tasks: RemoteTask[]
  selectedProject: string
  online: boolean
  deviceName?: string
  onProject: (project: string) => void
  onDevices: () => void
  onOpenTask: (task: RemoteTask) => void
  onRefresh: () => void
  onCreate: (action: RemoteAction) => Promise<void>
}) {
  const [composing, setComposing] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [workspace, setWorkspace] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const filtered = createMemo(() => props.selectedProject === ALL_PROJECTS ? props.tasks : props.tasks.filter((task) => taskProject(task) === props.selectedProject))
  const pending = createMemo(() => filtered().filter((task) => task.pending || task.status === "failed"))
  const active = createMemo(() => filtered().filter((task) => task.status === "running" || task.status === "waiting"))
  const recent = createMemo(() => filtered().filter((task) => task.status === "completed" || task.status === "failed"))

  async function createTask() {
    if (!workspace().trim() || !prompt().trim()) return
    setCreating(true)
    try {
      await props.onCreate({ type: "createTask", workspace: workspace().trim(), prompt: prompt().trim() })
      setWorkspace("")
      setPrompt("")
      setComposing(false)
    } finally {
      setCreating(false)
    }
  }

  return (
    <section class="page page--workbench">
      <header class="page-header"><div><span class="wordmark">JYYCode</span><p><span classList={{ "online-dot": true, "is-offline": !props.online }} />{props.online ? "电脑已连接" : "电脑离线"}</p></div><button class="icon-button" aria-label="刷新任务" onClick={props.onRefresh}><RefreshCw /></button></header>
      <button class="computer-switcher" onClick={props.onDevices}><Monitor /><span><small>当前电脑</small><strong>{props.deviceName ?? "选择已配对电脑"}</strong></span><ChevronRight /></button>
      <ProjectSwitcher tasks={props.tasks} selected={props.selectedProject} onSelect={props.onProject} />
      <Show when={!props.online}><p class="offline-banner">电脑当前离线，显示的是上次同步状态，操作已禁用。</p></Show>
      <section class="list-section"><header><h2>待处理</h2><span>{pending().length}</span></header><Show when={pending().length > 0} fallback={<p class="empty-copy">当前没有需要立即处理的事项。</p>}><For each={pending()}>{(task) => <TaskRow task={task} onOpen={() => props.onOpenTask(task)} />}</For></Show></section>
      <section class="list-section"><header><h2>进行中的任务</h2><span>{active().length}</span></header><Show when={active().length > 0} fallback={<p class="empty-copy">没有正在运行的任务。</p>}><For each={active()}>{(task) => <TaskRow task={task} onOpen={() => props.onOpenTask(task)} />}</For></Show></section>
      <section class="list-section"><header><h2>近期完成</h2><span>{recent().length}</span></header><For each={recent().slice(0, 5)}>{(task) => <TaskRow task={task} onOpen={() => props.onOpenTask(task)} />}</For></section>
      <button class="floating-action" aria-label="创建任务" disabled={!props.online} onClick={() => setComposing(true)}><Plus /></button>
      <Show when={composing()}>
        <div class="sheet-backdrop" role="presentation" onClick={() => setComposing(false)}><section class="project-sheet compose-sheet" role="dialog" aria-modal="true" aria-label="创建任务" onClick={(event) => event.stopPropagation()}><header><div><span class="eyebrow">新任务</span><h2>创建任务</h2></div></header><label>工作区<input placeholder="工作区路径" value={workspace()} onInput={(event) => setWorkspace(event.currentTarget.value)} /></label><label>任务内容<textarea placeholder="输入要交给 JYYCode 的任务" value={prompt()} onInput={(event) => setPrompt(event.currentTarget.value)} /></label><div class="button-row"><button class="secondary-button" onClick={() => setComposing(false)}>取消</button><button class="primary-button" disabled={!workspace().trim() || !prompt().trim() || creating()} onClick={() => void createTask()}>{creating() ? "正在创建…" : "创建任务"}</button></div></section></div>
      </Show>
    </section>
  )
}
