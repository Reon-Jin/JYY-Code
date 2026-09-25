import { createQuery } from "@tanstack/solid-query"
import { createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { tr } from "../../i18n/i18n-context"
import type { ManagementContextValue } from "../management/management-context"

const JEV_CREDENTIAL_ID = "typesafe-jev"
const statusKey = ["auth", JEV_CREDENTIAL_ID, "status"] as const

export function JevSettings(props: { management: ManagementContextValue }) {
  const [key, setKey] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const status = createQuery(
    () => ({
      queryKey: statusKey,
      queryFn: async () => {
        const response = await props.management.client.auth.status({ providerID: JEV_CREDENTIAL_ID }, { throwOnError: true })
        return response.data?.active ?? false
      },
    }),
    () => props.management.queryClient,
  )

  async function change(active: boolean) {
    if (saving()) return
    const value = key().trim()
    if (active && !value) return
    setSaving(true)
    setFailure(undefined)
    try {
      if (active) await props.management.client.auth.set({ providerID: JEV_CREDENTIAL_ID, auth: { type: "api", key: value } }, { throwOnError: true })
      else await props.management.client.auth.remove({ providerID: JEV_CREDENTIAL_ID }, { throwOnError: true })
      setKey("")
      await props.management.client.instance.dispose({ directory: props.management.directory }, { throwOnError: true })
      await props.management.queryClient.invalidateQueries({ queryKey: statusKey })
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : tr("settings.unable-to-save-jev-api"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section class="settings-card" aria-labelledby="jev-api-title">
      <h3 id="jev-api-title">{tr("settings.jev-api")}</h3>
      <p class="settings-description">{tr("settings.jev-api-description")}</p>
      <p role="status">{status.data ? tr("settings.jev-active") : tr("settings.jev-inactive")}</p>
      <label class="settings-select-label settings-select-label--active">
        <span>{tr("settings.jev-api-key")}</span>
        <input
          type="password"
          autocomplete="off"
          value={key()}
          disabled={saving()}
          onInput={(event) => setKey(event.currentTarget.value)}
          aria-label={tr("settings.jev-api-key")}
        />
      </label>
      <div class="settings-actions">
        <Button size="small" disabled={!key().trim() || saving()} onClick={() => void change(true)}>
          {status.data ? tr("settings.jev-replace") : tr("settings.jev-activate")}
        </Button>
        <Show when={status.data}>
          <Button size="small" variant="secondary" disabled={saving()} onClick={() => void change(false)}>
            {tr("settings.jev-deactivate")}
          </Button>
        </Show>
      </div>
      <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
      <Show when={status.error}>
        <InlineError message={status.error instanceof Error ? status.error.message : tr("settings.unable-to-read-jev-api")} />
      </Show>
    </section>
  )
}
