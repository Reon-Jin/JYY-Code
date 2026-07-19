import { tr } from "../../i18n/i18n-context"
import { createQuery } from "@tanstack/solid-query"
import { createEffect, createSignal, For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import type { ManagementContextValue } from "../management/management-context"
import { useManagement } from "../management/management-context"
import { displayDefaultPermission, type DefaultPermissionMode } from "./default-permission"
import { GlobalConfigReveal } from "./global-config-reveal"

type SimpleMode = Exclude<DefaultPermissionMode, "custom">

const options = (): Array<{ mode: SimpleMode; description: string }> => [
  { mode: "auto", description: tr("settings.use-the-safe-default-behavior-of-jyycode") },
  { mode: "request", description: tr("settings.ask-first-every-time-you-need-permission-to") },
  { mode: "full", description: tr("settings.allows-tools-to-execute-directly-suitable-for-trusted") },
]

export function SecuritySettings(props: { management?: ManagementContextValue }) {
  const management = props.management ?? useManagement()
  const permission = createQuery(
    () => ({
      queryKey: keys.globalDefaultPermission,
      queryFn: async () => {
        const response = await management.client.global.defaultPermission.get({ throwOnError: true })
        if (!response.data) throw new Error(tr("settings.backend-not-returning-default-permissions"))
        return response.data
      },
    }),
    () => management.queryClient,
  )
  const [selected, setSelected] = createSignal<DefaultPermissionMode>("auto")
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [pendingMode, setPendingMode] = createSignal<SimpleMode>()

  createEffect(() => {
    if (permission.data && !saving()) setSelected(permission.data.mode)
  })

  async function save(mode: SimpleMode) {
    const previous = selected()
    setPendingMode(undefined)
    setFailure(undefined)
    setSelected(mode)
    setSaving(true)
    try {
      await management.client.global.defaultPermission.update({ mode }, { throwOnError: true })
      await Promise.all([
        management.queryClient.invalidateQueries({ queryKey: keys.globalDefaultPermission }),
        management.queryClient.invalidateQueries({ queryKey: keys.globalConfig }),
      ])
    } catch (cause) {
      setSelected(previous)
      setFailure(cause instanceof Error ? cause.message : tr("settings.unable-to-save-default-permissions"))
    } finally {
      setSaving(false)
    }
  }

  function choose(mode: SimpleMode) {
    if (selected() === "custom") {
      setPendingMode(mode)
      return
    }
    void save(mode)
  }

  return (
    <div class="settings-sections">
      <Show when={permission.isPending}>
        <p role="status">{tr("settings.reading-default-permissions")}</p>
      </Show>
      <Show when={permission.error}>
        <InlineError message={permission.error instanceof Error ? permission.error.message : tr("settings.unable-to-read-default-permissions")} />
      </Show>
      <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
      <Show when={!permission.isPending && !permission.error}>
        <section class="settings-card" aria-labelledby="default-permission-title">
          <h3 id="default-permission-title">{tr("settings.new-session-default-permissions")}</h3>
          <p class="settings-description">
            {tr("settings.applies-only-to-newly-created-sessions-existing-sessions")}
          </p>
          <fieldset class="settings-options" disabled={saving()}>
            <legend>{tr("settings.select-default-permissions-for-new-sessions")}</legend>
            <For each={options()}>
              {(option) => (
                <label>
                  <input
                    type="radio"
                    name="default-permission"
                    aria-label={displayDefaultPermission(option).label}
                    checked={selected() === option.mode}
                    onChange={() => choose(option.mode)}
                  />
                  <span>
                    <strong>{displayDefaultPermission(option).label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              )}
            </For>
          </fieldset>
          <Show when={selected() === "custom"}>
            <div class="settings-custom-permission" role="status">
              <strong>{tr("settings.custom-configuration")}</strong>
              <p>{tr("settings.the-current-global-configuration-contains-fine-grained-rules")}</p>
              <GlobalConfigReveal management={management} />
            </div>
          </Show>
        </section>
      </Show>

      <Dialog
        open={Boolean(pendingMode())}
        title={tr("settings.replace-custom-permissions")}
        description={tr("settings.once-you-proceed-the-existing-fine-grained-permissions")}
        onClose={() => setPendingMode(undefined)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingMode(undefined)}>{tr("github.cancel")}</Button>
            <Button onClick={() => { const mode = pendingMode(); if (mode) void save(mode) }}>{tr("settings.replace-and-continue")}</Button>
          </>
        }
      >
        <p>{tr("settings.this-operation-only-changes-the-default-permissions-of")}</p>
      </Dialog>
    </div>
  )
}
