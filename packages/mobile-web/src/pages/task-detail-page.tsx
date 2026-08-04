import { ArrowLeft, RotateCcw, Send, Square } from "lucide-solid"
import { createSignal, For, Show } from "solid-js"
import { PendingCard } from "../components/pending-card"
import { Status } from "../components/task-row"
import type { RemoteAction, RemoteDetail, RemoteTask } from "../lib/models"
import { taskProject } from "../lib/models"

export function TaskDetailPage(props: {
  task: RemoteTask
  online: boolean
  onBack: () => void
  onCommand: (action: RemoteAction) => Promise<RemoteDetail | undefined>
}) {
  const [tab, setTab] = createSignal<"summary" | "conversation" | "diff">("summary")
  const [detail, setDetail] = createSignal<RemoteDetail>()
  const [message, setMessage] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  async function command(action: RemoteAction) {
    setBusy(true)
    try {
      return await props.onCommand(action)
    } finally {
      setBusy(false)
    }
  }
  async function load(kind: "conversation" | "diff") {
    const loaded = await command({ type: kind === "conversation" ? "loadConversation" : "loadDiff" })
    if (loaded) setDetail(loaded)
  }

  return (
    <section class="page task-detail">
      <header class="page-header">
        <button class="icon-button" aria-label="返回" onClick={props.onBack}>
          <ArrowLeft />
        </button>
        <div class="task-detail__heading">
          <span class="eyebrow">{taskProject(props.task)}</span>
          <h1>{props.task.title}</h1>
          <p>
            <Status status={props.task.status} /> · 电脑任务
          </p>
        </div>
        <Show
          when={props.task.status === "failed"}
          fallback={
            <button
              class="icon-button danger-icon"
              aria-label="停止任务"
              disabled={!props.online || (props.task.status !== "running" && props.task.status !== "waiting")}
              onClick={() => void command({ type: "stop" })}
            >
              <Square />
            </button>
          }
        >
          <button
            class="icon-button"
            aria-label="重试任务"
            disabled={!props.online}
            onClick={() => void command({ type: "retry" })}
          >
            <RotateCcw />
          </button>
        </Show>
      </header>
      <section class="detail-panel">
        <div class="progress-heading">
          <span>任务进度</span>
          <strong>{Math.round(props.task.progress * 100)}%</strong>
        </div>
        <div class="progress-track">
          <span style={{ width: `${Math.max(0, Math.min(100, props.task.progress * 100))}%` }} />
        </div>
        <p>{props.task.summary}</p>
      </section>
      <Show when={props.task.pending}>
        {(pending) => (
          <PendingCard
            pending={pending()}
            task={props.task}
            onApprove={(approved) => void command({ type: "approvePermission", id: pending().id, approved })}
            onAnswer={(answer) => void command({ type: "answerQuestion", id: pending().id, answer })}
          />
        )}
      </Show>
      <section class="detail-panel">
        <h2>子任务</h2>
        <Show when={props.task.children.length > 0} fallback={<p class="empty-copy">当前没有子任务。</p>}>
          <For each={props.task.children}>
            {(child) => (
              <div class="check-row">
                <span class={`tiny-status tiny-status--${child.status}`} />
                {child.title}
                <small>
                  {child.status === "completed" ? "已完成" : child.status === "running" ? "进行中" : "等待中"}
                </small>
              </div>
            )}
          </For>
        </Show>
      </section>
      <section class="detail-panel">
        <h2>待办</h2>
        <For each={props.task.todo}>
          {(item) => (
            <div class="check-row">
              <span classList={{ checkbox: true, "is-complete": item.isComplete }}>{item.isComplete ? "✓" : ""}</span>
              {item.title}
            </div>
          )}
        </For>
      </section>
      <section class="detail-panel">
        <h2>活动记录</h2>
        <Show when={props.task.timeline.length > 0} fallback={<p class="empty-copy">等待新的活动记录。</p>}>
          <For each={props.task.timeline}>
            {(event) => (
              <div class="timeline-row">
                <span />{" "}
                <div>
                  <strong>{event.title}</strong>
                  <small>{new Date(event.date).toLocaleString("zh-CN")}</small>
                </div>
              </div>
            )}
          </For>
        </Show>
      </section>
      <section class="detail-panel">
        <div class="detail-tabs" role="tablist">
          <button classList={{ "is-active": tab() === "summary" }} onClick={() => setTab("summary")}>
            摘要
          </button>
          <button classList={{ "is-active": tab() === "conversation" }} onClick={() => setTab("conversation")}>
            对话
          </button>
          <button classList={{ "is-active": tab() === "diff" }} onClick={() => setTab("diff")}>
            代码改动
          </button>
        </div>
        <Show when={tab() === "summary"}>
          <p>默认仅显示摘要。打开“对话”或“代码改动”后才会从已配对电脑按需加载，离开页面后不会保留。</p>
        </Show>
        <Show when={tab() !== "summary" && detail()?.kind === tab()}>
          <pre class="detail-content">{detail()!.content}</pre>
          <button class="secondary-button" onClick={() => setDetail(undefined)}>
            清除已加载内容
          </button>
        </Show>
        <Show when={tab() !== "summary" && detail()?.kind !== tab()}>
          <button
            class="secondary-button"
            disabled={!props.online || busy()}
            onClick={() => void load(tab() as "conversation" | "diff")}
          >
            {busy() ? "正在加载…" : `加载${tab() === "conversation" ? "对话" : "代码改动"}`}
          </button>
        </Show>
      </section>
      <section class="message-composer">
        <textarea
          placeholder="发送后续指令"
          value={message()}
          onInput={(event) => setMessage(event.currentTarget.value)}
        />
        <button
          class="icon-button primary-icon"
          aria-label="发送消息"
          disabled={!props.online || !message().trim() || busy()}
          onClick={() => {
            const value = message().trim()
            setMessage("")
            void command({ type: "sendMessage", message: value })
          }}
        >
          <Send />
        </button>
      </section>
    </section>
  )
}
