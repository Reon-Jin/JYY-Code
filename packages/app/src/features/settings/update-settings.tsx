import { createSignal, onMount, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { tr } from "../../i18n/i18n-context"
import { useDesktopBridge } from "../../platform/context"
import type { DesktopUpdateCheck } from "../../platform/types"
import { defaultDesktopSettings, type DesktopSettings, type UpdatePolicy } from "./settings-preferences"

type UpdatePhase = "idle" | "checking" | "current" | "available" | "installing"

function failureMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : tr("settings.update-failed")
}

export function UpdateSettings(props: { supported?: boolean }) {
  const bridge = useDesktopBridge()
  const supported = () => props.supported !== false
  const [settings, setSettings] = createSignal<DesktopSettings>({ ...defaultDesktopSettings })
  const [phase, setPhase] = createSignal<UpdatePhase>("idle")
  const [update, setUpdate] = createSignal<DesktopUpdateCheck>()
  const [error, setError] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)

  onMount(() => {
    void bridge.loadSettings().then(setSettings).catch((cause) => setError(failureMessage(cause)))
  })

  async function changePolicy(policy: UpdatePolicy) {
    if (!supported()) return
    const previous = settings()
    const next = { ...previous, updatePolicy: policy }
    setSettings(next)
    setSaving(true)
    setError(undefined)
    try {
      await bridge.saveSettings(next)
    } catch (cause) {
      setSettings(previous)
      setError(failureMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  async function checkNow() {
    if (!supported()) return
    setPhase("checking")
    setError(undefined)
    try {
      const result = await bridge.checkForUpdate()
      setUpdate(result)
      setPhase(result.available ? "available" : "current")
    } catch (cause) {
      setPhase("idle")
      setError(failureMessage(cause))
    }
  }

  async function install() {
    if (!supported()) return
    setPhase("installing")
    setError(undefined)
    try {
      const result = await bridge.installAvailableUpdate()
      if (!result.supported) throw new Error(result.reason ?? tr("settings.update-failed"))
    } catch (cause) {
      setPhase("available")
      setError(failureMessage(cause))
    }
  }

  const status = () => {
    if (!supported()) return tr("settings.update-unavailable-macos-preview")
    switch (phase()) {
      case "checking": return tr("settings.update-checking")
      case "current": return tr("settings.update-current")
      case "available": return tr("settings.update-available", { version: update()?.version ?? "" })
      case "installing": return tr("settings.update-installing")
      default: return tr("settings.update-ready")
    }
  }

  return (
    <section class="settings-card update-settings" aria-labelledby="update-settings-title">
      <header>
        <h3 id="update-settings-title">{tr("settings.automatic-updates")}</h3>
        <span class="settings-badge" data-phase={phase()}>{status()}</span>
      </header>
      <p>{tr("settings.update-description")}</p>
      <label class="settings-select-label settings-select-label--active">
        <span>{tr("settings.update-policy")}</span>
        <select
          aria-label={tr("settings.update-policy")}
          value={settings().updatePolicy}
          disabled={!supported() || saving() || phase() === "installing"}
          onChange={(event) => void changePolicy(event.currentTarget.value as UpdatePolicy)}
        >
          <option value="install">{tr("settings.update-policy-install")}</option>
          <option value="notify">{tr("settings.update-policy-notify")}</option>
          <option value="off">{tr("settings.update-policy-off")}</option>
        </select>
      </label>
      <Show when={update()?.available && update()?.notes}>
        <p class="update-settings__notes">{update()!.notes}</p>
      </Show>
      <Show when={error()}>{(value) => <InlineError message={value()} />}</Show>
      <div class="update-settings__actions">
        <Button
          variant="secondary"
          loading={phase() === "checking"}
          loadingLabel={tr("settings.update-checking")}
          disabled={!supported() || phase() === "installing"}
          onClick={() => void checkNow()}
        >
          {tr("settings.update-check-now")}
        </Button>
        <Show when={phase() === "available" || phase() === "installing"}>
          <Button
            loading={phase() === "installing"}
            loadingLabel={tr("settings.update-installing")}
            onClick={() => void install()}
          >
            {tr("settings.update-install-restart")}
          </Button>
        </Show>
      </div>
    </section>
  )
}
