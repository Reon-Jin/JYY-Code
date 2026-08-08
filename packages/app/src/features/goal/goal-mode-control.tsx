import { tr } from "../../i18n/i18n-context"
import type { Session } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { createMemo, createSignal, Show } from "solid-js"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import type { DesktopClient } from "../../data/sdk"
import { errorMessage } from "../projects/project-controller"
import "./goal-mode.css"

export function effectiveGoalRunning(session: Session) {
  if (session.parentID) return false
  return session.goal?.status === "running"
}

function patchSessionList(queryClient: QueryClient, queryKey: readonly unknown[], session: Session) {
  const sessions = queryClient.getQueryData<Session[]>(queryKey)
  if (!sessions) return
  queryClient.setQueryData(
    queryKey,
    sessions.map((candidate) => (candidate.id === session.id ? session : candidate)),
  )
}

export type GoalModeControlProps = {
  client: Pick<DesktopClient, "session">
  queryClient: QueryClient
  directory: string
  session: Session
}

export function GoalModeControl(props: GoalModeControlProps) {
  const [optimistic, setOptimistic] = createSignal<boolean>()
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<unknown>()
  const running = createMemo(() => optimistic() ?? effectiveGoalRunning(props.session))
  const disabled = createMemo(() => Boolean(props.session.parentID) || saving())

  async function applyGoal(goal: Session["goal"] | null) {
    setSaving(true)
    setFailure(undefined)
    try {
      const result = await props.client.session.update(
        { directory: props.directory, sessionID: props.session.id, goal: goal ?? undefined },
        { throwOnError: true },
      )
      const session = result.data ?? { ...props.session, goal: goal ?? undefined }
      props.queryClient.setQueryData(keys.session(props.directory, session.id), session)
      patchSessionList(props.queryClient, keys.sessions(props.directory), session)
      patchSessionList(props.queryClient, keys.sessions(props.directory, true), session)
      setOptimistic(effectiveGoalRunning(session))
    } catch (cause) {
      setOptimistic(undefined)
      setFailure(cause)
    } finally {
      setSaving(false)
    }
  }

  async function start() {
    if (disabled()) return
    setOptimistic(true)
    await applyGoal({
      condition: "Complete the user's current request",
      status: "running",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  async function stop() {
    if (disabled()) return
    setOptimistic(false)
    await applyGoal(props.session.goal ? { ...props.session.goal, status: "cancelled" } : null)
  }

  return (
    <div class="goal-mode-control">
      <button
        type="button"
        class="goal-mode-switch"
        data-active={running() ? "true" : "false"}
        role="switch"
        aria-label={tr("goal-mode.goal-mode")}
        aria-checked={running() ? "true" : "false"}
        disabled={disabled()}
        title={running() ? props.session.goal?.condition : undefined}
        onClick={() => void (running() ? stop() : start())}
      >
        <span>{tr("goal-mode.goal-mode")}</span>
      </button>
      <Show when={failure()}>
        {(cause) => <InlineError message={errorMessage(cause(), tr("goal-mode.unable-to-update-goal-mode"))} />}
      </Show>
    </div>
  )
}
