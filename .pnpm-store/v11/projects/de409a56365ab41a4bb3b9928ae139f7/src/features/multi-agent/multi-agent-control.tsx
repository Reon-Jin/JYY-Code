import type { AgentClusterConfig, Session } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { createMemo, createSignal, Show } from "solid-js"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import type { DesktopClient } from "../../data/sdk"
import { errorMessage } from "../projects/project-controller"
import "./multi-agent.css"

export function isMailSession(session: Pick<Session, "title" | "agent" | "path">) {
  return (
    session.title.startsWith("Email: ") ||
    session.title.startsWith("Reply email: ") ||
    session.agent === "mail" ||
    session.path === "mail"
  )
}

export function effectiveMultiAgent(session: Session, config?: AgentClusterConfig) {
  if (config?.enabled === false || session.parentID || isMailSession(session)) return false
  return session.multiAgent ?? config?.default_on ?? false
}

function disabledReason(session: Session, config?: AgentClusterConfig) {
  if (config?.enabled === false) return "多智能体已在全局配置中禁用"
  if (session.parentID) return "子智能体不支持启动多智能体"
  if (isMailSession(session)) return "邮件会话不支持多智能体"
  return undefined
}

function patchSessionList(queryClient: QueryClient, queryKey: readonly unknown[], session: Session) {
  const sessions = queryClient.getQueryData<Session[]>(queryKey)
  if (!sessions) return
  queryClient.setQueryData(
    queryKey,
    sessions.map((candidate) => (candidate.id === session.id ? session : candidate)),
  )
}

export type MultiAgentControlProps = {
  client: Pick<DesktopClient, "session">
  queryClient: QueryClient
  directory: string
  session: Session
  config?: AgentClusterConfig
}

export function MultiAgentControl(props: MultiAgentControlProps) {
  const [optimistic, setOptimistic] = createSignal<boolean>()
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<unknown>()
  const reason = createMemo(() => disabledReason(props.session, props.config))
  const checked = createMemo(() => optimistic() ?? effectiveMultiAgent(props.session, props.config))

  async function toggle() {
    if (reason() || saving()) return
    const next = !checked()
    setOptimistic(next)
    setSaving(true)
    setFailure(undefined)
    try {
      const result = await props.client.session.update(
        { directory: props.directory, sessionID: props.session.id, multiAgent: next },
        { throwOnError: true },
      )
      const session = result.data ?? { ...props.session, multiAgent: next }
      props.queryClient.setQueryData(keys.session(props.directory, session.id), session)
      patchSessionList(props.queryClient, keys.sessions(props.directory), session)
      patchSessionList(props.queryClient, keys.sessions(props.directory, true), session)
      setOptimistic(effectiveMultiAgent(session, props.config))
    } catch (cause) {
      setOptimistic(undefined)
      setFailure(cause)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="multi-agent-control">
      <button
        type="button"
        class="multi-agent-switch"
        data-active={checked() ? "true" : "false"}
        role="switch"
        aria-label="多智能体"
        aria-checked={checked()}
        disabled={Boolean(reason()) || saving()}
        title={reason()}
        onClick={() => void toggle()}
      >
        <span>多智能体</span>
      </button>
      <Show when={reason()}>{(message) => <span class="multi-agent-control__reason">{message()}</span>}</Show>
      <Show when={failure()}>
        {(cause) => <InlineError message={errorMessage(cause(), "无法更新多智能体模式")} />}
      </Show>
    </div>
  )
}
