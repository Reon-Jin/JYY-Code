import type { Session } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { ChevronDown, LoaderCircle, ShieldAlert, ShieldCheck, ShieldQuestion, UnlockKeyhole } from "lucide-solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { keys } from "../../data/query-keys"
import type { DesktopClient } from "../../data/sdk"
import { errorMessage } from "../projects/project-controller"
import {
  permissionModeFromRules,
  permissionRulesForMode,
  type AgentPermissionMode,
} from "./permission-mode"

const choices: ReadonlyArray<{ mode: AgentPermissionMode; label: string; description: string }> = [
  { mode: "request", label: "请求批准", description: "编辑文件和使用工具时需要批准" },
  { mode: "auto", label: "自动模式", description: "仅在检测到风险操作时需要批准" },
  { mode: "full", label: "所有权限", description: "无需批准即可执行操作" },
]

function ModeIcon(props: { mode: AgentPermissionMode }) {
  if (props.mode === "request") return <ShieldQuestion aria-hidden="true" />
  if (props.mode === "full") return <UnlockKeyhole aria-hidden="true" />
  return <ShieldCheck aria-hidden="true" />
}

function patchSessionList(queryClient: QueryClient, queryKey: readonly unknown[], session: Session) {
  const sessions = queryClient.getQueryData<Session[]>(queryKey)
  if (!sessions) return
  queryClient.setQueryData(
    queryKey,
    sessions.map((candidate) => (candidate.id === session.id ? session : candidate)),
  )
}

export type AgentPermissionControlProps = {
  client: Pick<DesktopClient, "session">
  queryClient: QueryClient
  directory: string
  session: Session
  disabled?: boolean
}

export function AgentPermissionControl(props: AgentPermissionControlProps) {
  const [optimistic, setOptimistic] = createSignal<AgentPermissionMode>()
  const [open, setOpen] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<unknown>()
  const mode = createMemo(() => optimistic() ?? permissionModeFromRules(props.session.permission))
  const current = createMemo(() => choices.find((choice) => choice.mode === mode())!)

  async function select(next: AgentPermissionMode) {
    setOpen(false)
    if (saving() || next === mode()) return
    setOptimistic(next)
    setSaving(true)
    setFailure(undefined)
    try {
      const permission = permissionRulesForMode(next)
      const result = await props.client.session.update(
        { directory: props.directory, sessionID: props.session.id, permission },
        { throwOnError: true },
      )
      const session = result.data ?? { ...props.session, permission }
      props.queryClient.setQueryData(keys.session(props.directory, session.id), session)
      patchSessionList(props.queryClient, keys.sessions(props.directory), session)
      patchSessionList(props.queryClient, keys.sessions(props.directory, true), session)
      patchSessionList(props.queryClient, keys.sessionsAll(props.directory), session)
      setOptimistic(permissionModeFromRules(session.permission))
    } catch (cause) {
      setOptimistic(undefined)
      setFailure(cause)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="agent-permission-control" data-mode={mode()}>
      <span class="agent-permission-control__label">权限</span>
      <div class="agent-permission-control__select">
        <button
          type="button"
          class="agent-permission-control__trigger"
          aria-label={`Agent 权限：${current().label}`}
          aria-haspopup="menu"
          aria-expanded={open()}
          disabled={props.disabled || saving()}
          title={failure() ? errorMessage(failure(), "无法更新 Agent 权限") : current().description}
          onClick={() => setOpen((value) => !value)}
        >
          <Show when={saving()} fallback={<ModeIcon mode={mode()} />}>
            <LoaderCircle class="agent-permission-control__spinner" aria-hidden="true" />
          </Show>
          <strong>{current().label}</strong>
          <ChevronDown class="agent-permission-control__chevron" aria-hidden="true" />
        </button>
        <Show when={open()}>
          <div class="agent-permission-menu" role="menu" aria-label="选择 Agent 权限">
            <For each={choices}>
              {(choice) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={choice.mode === mode()}
                  data-mode={choice.mode}
                  onClick={() => void select(choice.mode)}
                >
                  <ModeIcon mode={choice.mode} />
                  <span>
                    <strong>{choice.label}</strong>
                    <small>{choice.description}</small>
                  </span>
                  <Show when={choice.mode === mode()}>
                    <ShieldCheck class="agent-permission-menu__check" aria-hidden="true" />
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show when={failure()}>
        <ShieldAlert
          class="agent-permission-control__error"
          role="img"
          aria-label={errorMessage(failure(), "无法更新 Agent 权限")}
        />
      </Show>
    </div>
  )
}
