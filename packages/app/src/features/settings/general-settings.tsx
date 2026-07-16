import { tr, useI18n } from "../../i18n/i18n-context"
import { createSignal, onMount, Show } from "solid-js"
import { InlineError } from "../../components/ui/inline-error"
import { useDesktopBridge } from "../../platform/context"
import { applyTheme } from "./theme"
import { defaultDesktopSettings, type AppLocale, type DesktopSettings } from "./settings-preferences"
import { ComingSoonSetting } from "./coming-soon-setting"

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : tr("settings.unable-to-save-desktop-settings")
}

export function GeneralSettings() {
  const bridge = useDesktopBridge()
  const i18n = useI18n()
  const [settings, setSettings] = createSignal<DesktopSettings>({ ...defaultDesktopSettings })
  const [error, setError] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)

  onMount(() => {
    void bridge
      .loadSettings()
      .then((value) => {
        setSettings(value)
        applyTheme(value.theme)
      })
      .catch((cause) => setError(message(cause)))
  })

  async function save(next: DesktopSettings) {
    const previous = settings()
    setError(undefined)
    setSettings(next)
    if (next.theme !== previous.theme) applyTheme(next.theme)
    setSaving(true)
    try {
      await bridge.saveSettings(next)
    } catch (cause) {
      setSettings(previous)
      applyTheme(previous.theme)
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  async function changeLocale(locale: AppLocale) {
    setError(undefined)
    setSaving(true)
    try {
      await i18n.setLocale(locale)
      setSettings((current) => ({ ...current, locale }))
    } catch (cause) {
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="settings-sections">
      <Show when={error()}>{(value) => <InlineError message={value()} />}</Show>

      <section class="settings-card" aria-labelledby="startup-setting-title">
        <h3 id="startup-setting-title">{tr("settings.on-startup")}</h3>
        <fieldset class="settings-options" disabled={saving()}>
          <legend>{tr("settings.choose-a-desktop-application-launch-location")}</legend>
          <label>
            <input
              type="radio"
              aria-label={tr("settings.restore-last-project")}
              name="startup"
              value="restore"
              checked={settings().startup === "restore"}
              onChange={() => void save({ ...settings(), startup: "restore" })}
            />
            <span><strong>{tr("settings.restore-last-project")}</strong><small>{tr("settings.return-to-recently-used-projects-and-sessions")}</small></span>
          </label>
          <label>
            <input
              type="radio"
              aria-label={tr("settings.show-home-on-startup")}
              name="startup"
              value="home"
              checked={settings().startup === "home"}
              onChange={() => void save({ ...settings(), startup: "home" })}
            />
            <span><strong>{tr("settings.show-home-on-startup")}</strong><small>{tr("settings.every-startup-starts-with-the-project-selection-page")}</small></span>
          </label>
        </fieldset>
      </section>

      <section class="settings-card" aria-labelledby="appearance-setting-title">
        <h3 id="appearance-setting-title">{tr("settings.appearance")}</h3>
        <fieldset class="settings-options settings-options--inline" disabled={saving()}>
          <legend>{tr("settings.color-theme")}</legend>
          <label>
            <input
              type="radio"
              aria-label={tr("settings.dark")}
              name="theme"
              value="dark"
              checked={settings().theme === "dark"}
              onChange={() => void save({ ...settings(), theme: "dark" })}
            />
            <span><strong>{tr("settings.dark")}</strong></span>
          </label>
          <label>
            <input
              type="radio"
              aria-label={tr("settings.light-color")}
              name="theme"
              value="light"
              checked={settings().theme === "light"}
              onChange={() => void save({ ...settings(), theme: "light" })}
            />
            <span><strong>{tr("settings.light-color")}</strong></span>
          </label>
        </fieldset>
      </section>

      <section class="settings-card" aria-labelledby="language-setting-title">
        <h3 id="language-setting-title">{tr("settings.language")}</h3>
        <label class="settings-select-label">
          <span>{tr("settings.language")}</span>
          <select
            aria-label={tr("settings.language")}
            value={i18n.locale()}
            disabled={saving()}
            onChange={(event) => void changeLocale(event.currentTarget.value as AppLocale)}
          >
            <option value="zh-CN">{tr("settings.simplified-chinese")}</option>
            <option value="en-US">{tr("settings.english")}</option>
          </select>
        </label>
      </section>

      <ComingSoonSetting
        title={tr("settings.apple-style-liquid-glass")}
        reason={tr("settings.requires-full-vision-system-and-windows-and-webview")}
      >
        <label class="settings-disabled-check">
          <input type="checkbox" aria-label={tr("settings.apple-style-liquid-glass")} disabled />
          {tr("settings.apple-style-liquid-glass")}
        </label>
      </ComingSoonSetting>

      <ComingSoonSetting title={tr("settings.windows-notifications")} reason={tr("settings.native-notification-capabilities-and-foreground-and-background-event")}>
        <fieldset class="settings-placeholder-options" disabled>
          <legend>{tr("settings.notification-trigger-conditions")}</legend>
          {([tr("settings.reply-completed"), tr("settings.waiting-for-permission"), tr("requests.agent-asked-a-question")] as const).map((label) => (
            <label><input type="checkbox" />{label}</label>
          ))}
        </fieldset>
      </ComingSoonSetting>
    </div>
  )
}
