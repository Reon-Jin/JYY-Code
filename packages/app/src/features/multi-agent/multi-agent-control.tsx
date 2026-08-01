import { tr } from "../../i18n/i18n-context"
import type { Session } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { createMemo, createSignal, Show } from "solid-js"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import type { DesktopClient } from "../../data/sdk"
import { errorMessage } from "../projects/project-controller"
import "./multi-agent.css"

export function effectiveMultiAgent(session: Session) {
  if (session.parentID) return false
  return session.multiAgent === true
}

function disabledReason(session: Session) {
  if (session.parentID) return tr("multi-agent.sub-agent-does-not-support-starting-multi-agent")
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
}

export function MultiAgentControl(props: MultiAgentControlProps) {
  const [optimistic, setOptimistic] = createSignal<boolean>()
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<unknown>()
  const reason = createMemo(() => disabledReason(props.session))
  const checked = createMemo(() => optimistic() ?? effectiveMultiAgent(props.session))

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
      setOptimistic(effectiveMultiAgent(session))
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
        aria-label={tr("multi-agent.multi-agent")}
        aria-checked={checked()}
        disabled={Boolean(reason()) || saving()}
        title={reason()}
        onClick={() => void toggle()}
      >
        <span>{tr("multi-agent.multi-agent")}</span>
      </button>
      <Show when={reason()}>{(message) => <span class="multi-agent-control__reason">{message()}</span>}</Show>
      <Show when={failure()}>
        {(cause) => (
          <InlineError message={errorMessage(cause(), tr("multi-agent.unable-to-update-multi-agent-mode"))} />
        )}
      </Show>
    </div>
  )
}
