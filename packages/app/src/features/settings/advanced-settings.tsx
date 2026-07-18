import { tr } from "../../i18n/i18n-context"
import { createQuery } from "@tanstack/solid-query"
import { createEffect, createSignal, Show } from "solid-js"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import type { ManagementContextValue } from "../management/management-context"
import { useManagement } from "../management/management-context"
import { CompactionSettings } from "./compaction-settings"
import { GlobalConfigReveal } from "./global-config-reveal"
import { MemorySettings } from "./memory-settings"
import { UpdateSettings } from "./update-settings"
import { defaultShellOptions } from "../../platform/desktop-path"

export function AdvancedSettings(props: { management?: ManagementContextValue }) {
  const management = props.management ?? useManagement()
  const knownShells = () => defaultShellOptions(management.directory)
  const [shell, setShell] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const config = createQuery(
    () => ({
      queryKey: keys.globalConfig,
      queryFn: async () => {
        const response = await management.client.global.config.get({ throwOnError: true })
        if (!response.data) throw new Error(tr("settings.backend-did-not-return-global-configuration"))
        return response.data
      },
    }),
    () => management.queryClient,
  )

  createEffect(() => {
    if (config.data && !saving()) setShell(config.data.shell ?? "")
  })

  async function save(next: string) {
    const previous = shell()
    setShell(next)
    setSaving(true)
    setFailure(undefined)
    try {
      await management.client.global.config.update({ config: { shell: next } }, { throwOnError: true })
      await management.queryClient.invalidateQueries({ queryKey: keys.globalConfig })
    } catch (cause) {
      setShell(previous)
      setFailure(cause instanceof Error ? cause.message : tr("settings.unable-to-save-default-shell"))
    } finally {
      setSaving(false)
    }
  }

  const unknownShell = () => {
    const current = shell()
    return current && !knownShells().some((value) => value === current) ? current : undefined
  }

  return (
    <div class="settings-sections">
      <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
      <section class="settings-card" aria-labelledby="default-shell-title">
        <h3 id="default-shell-title">{tr("settings.default-shell")}</h3>
        <p class="settings-description">{tr("settings.terminal-and-shell-tools-for-new-startups-use")}</p>
        <label class="settings-select-label settings-select-label--active">
          <span>{tr("settings.default-shell")}</span>
          <select
            aria-label={tr("settings.default-shell")}
            value={shell()}
            disabled={config.isPending || saving()}
            onChange={(event) => void save(event.currentTarget.value)}
          >
            <option value="">{tr("settings.system-default")}</option>
            <Show when={unknownShell()}>
              {(value) => (
                <option value={value()}>
                  {tr("settings.current-value")}
                  {value()}
                </option>
              )}
            </Show>
            {knownShells().map((value) => (
              <option value={value}>{value}</option>
            ))}
          </select>
        </label>
        <Show when={config.error}>
          <InlineError
            message={
              config.error instanceof Error ? config.error.message : tr("settings.unable-to-read-global-configuration")
            }
          />
        </Show>
      </section>

      <section class="settings-card" aria-labelledby="global-config-title">
        <h3 id="global-config-title">{tr("settings.global-configuration-file")}</h3>
        <p class="settings-description">{tr("settings.select-the-jyycode-global-configuration-file-provided-by")}</p>
        <GlobalConfigReveal management={management} />
      </section>

      <UpdateSettings />
      <CompactionSettings management={management} />
      <MemorySettings />
    </div>
  )
}
