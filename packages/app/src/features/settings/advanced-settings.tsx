import { tr } from "../../i18n/i18n-context"
import { createQuery } from "@tanstack/solid-query"
import { createEffect, createSignal, Show } from "solid-js"
import { InlineError } from "../../components/ui/inline-error"
import { Button } from "../../components/ui/button"
import { keys } from "../../data/query-keys"
import type { ManagementContextValue } from "../management/management-context"
import { useManagement } from "../management/management-context"
import { CompactionSettings } from "./compaction-settings"
import { GlobalConfigReveal } from "./global-config-reveal"
import { MemorySettings } from "./memory-settings"
import { UpdateSettings } from "./update-settings"
import { defaultShellOptions } from "../../platform/desktop-path"
import { JevSettings } from "./jev-settings"

export function AdvancedSettings(props: { management?: ManagementContextValue }) {
  const management = props.management ?? useManagement()
  const knownShells = () => defaultShellOptions(management.directory)
  const [shell, setShell] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [timeoutMinutes, setTimeoutMinutes] = createSignal("60")
  const [timeoutSaving, setTimeoutSaving] = createSignal(false)
  const [timeoutFailure, setTimeoutFailure] = createSignal<string>()
  const [timeoutNotice, setTimeoutNotice] = createSignal<string>()
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

  const savedTimeout = () => Math.min(config.data?.subagents?.timeout_ms ?? 3_600_000, 3_600_000) / 60_000
  const validTimeout = () =>
    timeoutMinutes().trim() !== "" &&
    Number.isInteger(Number(timeoutMinutes())) &&
    Number(timeoutMinutes()) >= 1 &&
    Number(timeoutMinutes()) <= 60
  createEffect(() => {
    if (config.data) setTimeoutMinutes(String(savedTimeout()))
  })

  async function saveTimeout() {
    if (!validTimeout() || timeoutSaving() || !config.data || Number(timeoutMinutes()) === savedTimeout()) return
    const timeoutMs = Number(timeoutMinutes()) * 60_000
    setTimeoutSaving(true)
    setTimeoutFailure(undefined)
    setTimeoutNotice(undefined)
    try {
      await management.client.global.config.update(
        { config: { subagents: { timeout_ms: timeoutMs } } },
        { throwOnError: true },
      )
      management.queryClient.setQueryData(keys.globalConfig, {
        ...config.data,
        subagents: { ...config.data.subagents, timeout_ms: timeoutMs },
      })
      setTimeoutNotice(tr("settings.subagent-timeout-saved"))
    } catch (cause) {
      setTimeoutFailure(cause instanceof Error ? cause.message : tr("settings.subagent-timeout-save-failed"))
    } finally {
      setTimeoutSaving(false)
    }
  }

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

      <section class="settings-card" aria-labelledby="subagent-timeout-title">
        <h3 id="subagent-timeout-title">{tr("settings.subagent-timeout")}</h3>
        <p class="settings-description" id="subagent-timeout-description">
          {tr("settings.subagent-timeout-description")}
        </p>
        <form
          class="subagent-timeout-form"
          onSubmit={(event) => {
            event.preventDefault()
            void saveTimeout()
          }}
        >
          <label class="settings-select-label settings-select-label--active">
            <span>{tr("settings.subagent-timeout-minutes")}</span>
            <input
              type="number"
              min="1"
              max="60"
              step="1"
              required
              aria-label={tr("settings.subagent-timeout-minutes")}
              aria-describedby="subagent-timeout-description"
              aria-invalid={!validTimeout()}
              value={timeoutMinutes()}
              disabled={config.isPending || config.isError || timeoutSaving()}
              onInput={(event) => {
                setTimeoutMinutes(event.currentTarget.value)
                setTimeoutFailure(undefined)
                setTimeoutNotice(undefined)
              }}
            />
          </label>
          <Button
            type="submit"
            loading={timeoutSaving()}
            loadingLabel={tr("settings.saving")}
            disabled={
              config.isPending ||
              config.isError ||
              !validTimeout() ||
              timeoutSaving() ||
              Number(timeoutMinutes()) === savedTimeout()
            }
          >
            {tr("settings.subagent-timeout-save")}
          </Button>
        </form>
        <Show when={!validTimeout()}>
          <InlineError message={tr("settings.subagent-timeout-invalid")} />
        </Show>
        <Show when={timeoutFailure()}>{(message) => <InlineError message={message()} />}</Show>
        <Show when={timeoutNotice()}>
          {(message) => (
            <p class="settings-card__hint" role="status">
              {message()}
            </p>
          )}
        </Show>
      </section>

      <section class="settings-card" aria-labelledby="global-config-title">
        <h3 id="global-config-title">{tr("settings.global-configuration-file")}</h3>
        <p class="settings-description">{tr("settings.select-the-jyycode-global-configuration-file-provided-by")}</p>
        <GlobalConfigReveal management={management} />
      </section>

      <JevSettings management={management} />

      <UpdateSettings />
      <CompactionSettings management={management} />
      <MemorySettings />
    </div>
  )
}
