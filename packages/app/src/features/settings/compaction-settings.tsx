import { tr } from "../../i18n/i18n-context"
import type { GlobalCompaction } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import type { ManagementContextValue } from "../management/management-context"
import { useManagement } from "../management/management-context"

type CompactionDraft = {
  auto: boolean
  prune: boolean
  tailTurns: string
  preserveRecentTokens: string
  reservedTokens: string
  triggerRatio: string
  microCompact: boolean
  microCompactMaxChars: string
  reactiveCompact: boolean
}

type ParsedDraft = { value?: GlobalCompaction; error?: string }

function toDraft(value: GlobalCompaction): CompactionDraft {
  return {
    auto: value.auto,
    prune: value.prune,
    tailTurns: String(value.tailTurns),
    preserveRecentTokens: value.preserveRecentTokens === undefined ? "" : String(value.preserveRecentTokens),
    reservedTokens: value.reservedTokens === undefined ? "" : String(value.reservedTokens),
    triggerRatio: String(value.triggerRatio),
    microCompact: value.microCompact,
    microCompactMaxChars: String(value.microCompactMaxChars),
    reactiveCompact: value.reactiveCompact,
  }
}

function integer(value: string, min: number, max: number, optional = false) {
  if (optional && value.trim() === "") return { value: undefined }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { error: tr("settings.compaction-integer-range", { min, max }) }
  }
  return { value: parsed }
}

function decimal(value: string, min: number, max: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return { error: tr("settings.compaction-number-range", { min, max }) }
  }
  return { value: parsed }
}

function parseDraft(draft: CompactionDraft): ParsedDraft {
  const tailTurns = integer(draft.tailTurns, 0, 20)
  if (tailTurns.error) return { error: tailTurns.error }
  const preserveRecentTokens = integer(draft.preserveRecentTokens, 0, 131072, true)
  if (preserveRecentTokens.error) return { error: preserveRecentTokens.error }
  const reservedTokens = integer(draft.reservedTokens, 0, 131072, true)
  if (reservedTokens.error) return { error: reservedTokens.error }
  const triggerRatio = decimal(draft.triggerRatio, 0.5, 0.98)
  if (triggerRatio.error) return { error: triggerRatio.error }
  const microCompactMaxChars = integer(draft.microCompactMaxChars, 0, 100000)
  if (microCompactMaxChars.error) return { error: microCompactMaxChars.error }

  return {
    value: {
      auto: draft.auto,
      prune: draft.prune,
      tailTurns: tailTurns.value!,
      ...(preserveRecentTokens.value === undefined ? {} : { preserveRecentTokens: preserveRecentTokens.value }),
      ...(reservedTokens.value === undefined ? {} : { reservedTokens: reservedTokens.value }),
      triggerRatio: triggerRatio.value!,
      microCompact: draft.microCompact,
      microCompactMaxChars: microCompactMaxChars.value!,
      reactiveCompact: draft.reactiveCompact,
    },
  }
}

function same(left: GlobalCompaction, right: GlobalCompaction) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function CompactionSettings(props: { management?: ManagementContextValue }) {
  const management = props.management ?? useManagement()
  const [draft, setDraft] = createSignal<CompactionDraft>()
  const [saving, setSaving] = createSignal(false)
  const [resetting, setResetting] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [notice, setNotice] = createSignal<string>()
  const query = createQuery(
    () => ({
      queryKey: keys.globalCompaction,
      queryFn: async () => {
        const response = await management.client.global.compaction.get({ throwOnError: true })
        if (!response.data) throw new Error(tr("settings.backend-did-not-return-compaction-settings"))
        return response.data
      },
    }),
    () => management.queryClient,
  )

  createEffect(() => {
    if (query.data && !saving() && !resetting()) setDraft(toDraft(query.data))
  })

  const parsed = createMemo<ParsedDraft>(() => {
    const current = draft()
    return current ? parseDraft(current) : {}
  })
  const changed = createMemo(() => Boolean(query.data && parsed().value && !same(query.data, parsed().value!)))

  function patch<K extends keyof CompactionDraft>(key: K, value: CompactionDraft[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current))
    setFailure(undefined)
    setNotice(undefined)
  }

  async function save() {
    const value = parsed().value
    const previous = query.data
    if (!value || !previous || !changed()) return
    setSaving(true)
    setFailure(undefined)
    setNotice(undefined)
    try {
      const response = await management.client.global.compaction.update(
        { globalCompaction: value },
        { throwOnError: true },
      )
      const persisted = response.data ?? value
      management.queryClient.setQueryData(keys.globalCompaction, persisted)
      setDraft(toDraft(persisted))
      setNotice(tr("settings.compaction-saved-new-sessions"))
    } catch (cause) {
      setDraft(toDraft(previous))
      setFailure(cause instanceof Error ? cause.message : tr("settings.unable-to-save-compaction-settings"))
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    if (!window.confirm(tr("settings.compaction-reset-confirmation"))) return
    setResetting(true)
    setFailure(undefined)
    setNotice(undefined)
    try {
      const response = await management.client.global.compaction.reset({ throwOnError: true })
      if (response.data) {
        management.queryClient.setQueryData(keys.globalCompaction, response.data)
        setDraft(toDraft(response.data))
      }
      await management.queryClient.invalidateQueries({ queryKey: keys.globalCompaction })
      setNotice(tr("settings.compaction-reset-new-sessions"))
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : tr("settings.unable-to-reset-compaction-settings"))
    } finally {
      setResetting(false)
    }
  }

  return (
    <section class="settings-card compaction-settings" aria-labelledby="compaction-settings-title">
      <h3 id="compaction-settings-title">{tr("settings.context-compression-parameters")}</h3>
      <p class="settings-description">{tr("settings.compaction-description")}</p>

      <Show when={query.isPending}>
        <p class="settings-saving" role="status">
          {tr("settings.loading-compaction-settings")}
        </p>
      </Show>
      <Show when={query.error}>
        <InlineError
          message={
            query.error instanceof Error ? query.error.message : tr("settings.unable-to-read-compaction-settings")
          }
        />
      </Show>

      <Show when={draft()}>
        {(current) => (
          <form
            class="compaction-settings__form"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <fieldset class="settings-options settings-options--inline">
              <legend>{tr("settings.context-compression-parameters")}</legend>
              <label>
                <input
                  type="checkbox"
                  aria-label={tr("settings.automatic-compaction")}
                  checked={current().auto}
                  disabled={saving() || resetting()}
                  onChange={(event) => patch("auto", event.currentTarget.checked)}
                />
                <span>
                  <strong>{tr("settings.automatic-compaction")}</strong>
                  <small>{tr("settings.automatic-compaction-description")}</small>
                </span>
              </label>
              <label>
                <input
                  type="checkbox"
                  aria-label={tr("settings.prune-old-tool-output")}
                  checked={current().prune}
                  disabled={saving() || resetting()}
                  onChange={(event) => patch("prune", event.currentTarget.checked)}
                />
                <span>
                  <strong>{tr("settings.prune-old-tool-output")}</strong>
                  <small>{tr("settings.prune-old-tool-output-description")}</small>
                </span>
              </label>
            </fieldset>

            <details class="compaction-settings__advanced">
              <summary>{tr("settings.advanced-parameters")}</summary>
              <div class="compaction-settings__grid">
                <label class="compaction-settings__field">
                  <span>{tr("settings.compaction-tail-turns")}</span>
                  <input
                    aria-label={tr("settings.compaction-tail-turns")}
                    type="number"
                    min="0"
                    max="20"
                    step="1"
                    value={current().tailTurns}
                    onInput={(event) => patch("tailTurns", event.currentTarget.value)}
                  />
                  <small>{tr("settings.compaction-tail-turns-description")}</small>
                </label>
                <label class="compaction-settings__field">
                  <span>{tr("settings.compaction-preserve-recent-tokens")}</span>
                  <input
                    aria-label={tr("settings.compaction-preserve-recent-tokens")}
                    type="number"
                    min="0"
                    max="131072"
                    step="1"
                    value={current().preserveRecentTokens}
                    onInput={(event) => patch("preserveRecentTokens", event.currentTarget.value)}
                  />
                  <small>{tr("settings.compaction-preserve-recent-tokens-description")}</small>
                </label>
                <label class="compaction-settings__field">
                  <span>{tr("settings.compaction-reserved-tokens")}</span>
                  <input
                    aria-label={tr("settings.compaction-reserved-tokens")}
                    type="number"
                    min="0"
                    max="131072"
                    step="1"
                    value={current().reservedTokens}
                    onInput={(event) => patch("reservedTokens", event.currentTarget.value)}
                  />
                  <small>{tr("settings.compaction-reserved-tokens-description")}</small>
                </label>
                <label class="compaction-settings__field">
                  <span>{tr("settings.compaction-trigger-ratio")}</span>
                  <input
                    aria-label={tr("settings.compaction-trigger-ratio")}
                    type="number"
                    min="0.5"
                    max="0.98"
                    step="0.01"
                    value={current().triggerRatio}
                    onInput={(event) => patch("triggerRatio", event.currentTarget.value)}
                  />
                  <small>{tr("settings.compaction-trigger-ratio-description")}</small>
                </label>
                <label class="compaction-settings__field">
                  <span>{tr("settings.compaction-micro-max-chars")}</span>
                  <input
                    aria-label={tr("settings.compaction-micro-max-chars")}
                    type="number"
                    min="0"
                    max="100000"
                    step="1"
                    value={current().microCompactMaxChars}
                    onInput={(event) => patch("microCompactMaxChars", event.currentTarget.value)}
                  />
                  <small>{tr("settings.compaction-micro-max-chars-description")}</small>
                </label>
              </div>
              <fieldset class="settings-options settings-options--inline compaction-settings__toggles">
                <legend>{tr("settings.advanced-parameters")}</legend>
                <label>
                  <input
                    type="checkbox"
                    aria-label={tr("settings.compaction-micro")}
                    checked={current().microCompact}
                    disabled={saving() || resetting()}
                    onChange={(event) => patch("microCompact", event.currentTarget.checked)}
                  />
                  <span>
                    <strong>{tr("settings.compaction-micro")}</strong>
                    <small>{tr("settings.compaction-micro-description")}</small>
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    aria-label={tr("settings.compaction-reactive")}
                    checked={current().reactiveCompact}
                    disabled={saving() || resetting()}
                    onChange={(event) => patch("reactiveCompact", event.currentTarget.checked)}
                  />
                  <span>
                    <strong>{tr("settings.compaction-reactive")}</strong>
                    <small>{tr("settings.compaction-reactive-description")}</small>
                  </span>
                </label>
              </fieldset>
            </details>

            <Show when={parsed().error}>{(message) => <p class="compaction-settings__validation">{message()}</p>}</Show>
            <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
            <Show when={notice()}>
              {(message) => (
                <p class="compaction-settings__notice" role="status">
                  {message()}
                </p>
              )}
            </Show>
            <div class="compaction-settings__actions">
              <Button
                type="submit"
                disabled={!changed() || !parsed().value || saving() || resetting()}
                loading={saving()}
                loadingLabel={tr("settings.saving")}
              >
                {tr("settings.save-compaction-settings")}
              </Button>
              <Button
                variant="secondary"
                disabled={saving() || resetting()}
                loading={resetting()}
                loadingLabel={tr("settings.resetting-compaction-settings")}
                onClick={() => void reset()}
              >
                {tr("settings.restore-safe-defaults")}
              </Button>
            </div>
          </form>
        )}
      </Show>
    </section>
  )
}
