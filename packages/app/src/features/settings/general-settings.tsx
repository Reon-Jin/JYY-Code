import { tr, useI18n } from "../../i18n/i18n-context"
import { createSignal, onMount, Show } from "solid-js"
import { InlineError } from "../../components/ui/inline-error"
import { useDesktopBridge } from "../../platform/context"
import { applyTheme } from "./theme"
import { defaultDesktopSettings, type AppLocale, type DesktopSettings, type NotificationPreferences } from "./settings-preferences"
import type { DesktopNotificationPermission } from "../../platform/types"
import { publishDesktopNotificationPermission } from "../notifications/desktop-notifications"
import { reapplyGlassForTheme, setGlassPreference } from "./glass-preference"

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : tr("settings.unable-to-save-desktop-settings")
}

export function GeneralSettings() {
  const bridge = useDesktopBridge()
  const i18n = useI18n()
  const [settings, setSettings] = createSignal<DesktopSettings>({ ...defaultDesktopSettings })
  const [error, setError] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)
  const [notificationPermission, setNotificationPermission] = createSignal<DesktopNotificationPermission>("default")

  onMount(() => {
    void (bridge.getNotificationPermission?.() ?? Promise.resolve("unsupported" as const))
      .then(setNotificationPermission)
      .catch(() => setNotificationPermission("unsupported"))
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
      if (next.theme !== previous.theme) await reapplyGlassForTheme(bridge, previous, next.theme)
      await bridge.saveSettings(next)
    } catch (cause) {
      setSettings(previous)
      applyTheme(previous.theme)
      if (next.theme !== previous.theme) {
        await reapplyGlassForTheme(bridge, previous, previous.theme).catch(() => undefined)
      }
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  async function changeGlass(enabled: boolean) {
    setError(undefined)
    setSaving(true)
    try {
      const next = await setGlassPreference({
        bridge,
        current: settings(),
        enabled,
        persist: (value) => bridge.saveSettings(value),
      })
      setSettings(next)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  async function changeNotification(kind: keyof NotificationPreferences, enabled: boolean) {
    setError(undefined)
    if (enabled && notificationPermission() !== "granted") {
      setSaving(true)
      try {
        const permission = await bridge.requestNotificationPermission()
        setNotificationPermission(permission)
        publishDesktopNotificationPermission(permission)
      } catch (cause) {
        setError(message(cause))
        setSaving(false)
        return
      }
    }
    await save({
      ...settings(),
      notifications: { ...settings().notifications, [kind]: enabled },
    })
  }

  function notificationPermissionText() {
    switch (notificationPermission()) {
      case "granted": return tr("settings.notification-permission-granted")
      case "denied": return tr("settings.notification-permission-denied")
      case "unsupported": return tr("settings.notification-permission-unsupported")
      default: return tr("settings.notification-permission-default")
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

      <section class="settings-card" aria-labelledby="glass-setting-title">
        <h3 id="glass-setting-title">{tr("settings.apple-style-liquid-glass")}</h3>
        <label class="settings-disabled-check">
          <input
            type="checkbox"
            aria-label={tr("settings.apple-style-liquid-glass")}
            checked={settings().glass === "on"}
            disabled={saving()}
            onChange={(event) => void changeGlass(event.currentTarget.checked)}
          />
          {tr("settings.apple-style-liquid-glass")}
        </label>
        <p class="settings-card__hint">{tr("settings.requires-full-vision-system-and-windows-and-webview")}</p>
      </section>

      <section class="settings-card" aria-labelledby="notifications-setting-title">
        <h3 id="notifications-setting-title">{tr("settings.windows-notifications")}</h3>
        <fieldset class="settings-placeholder-options" disabled={saving()}>
          <legend>{tr("settings.notification-trigger-conditions")}</legend>
          <label>
            <input
              type="checkbox"
              checked={settings().notifications.completion}
              onChange={(event) => void changeNotification("completion", event.currentTarget.checked)}
            />
            {tr("settings.reply-completed")}
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings().notifications.permission}
              onChange={(event) => void changeNotification("permission", event.currentTarget.checked)}
            />
            {tr("settings.waiting-for-permission")}
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings().notifications.question}
              onChange={(event) => void changeNotification("question", event.currentTarget.checked)}
            />
            {tr("requests.agent-asked-a-question")}
          </label>
        </fieldset>
        <p class="settings-card__hint" role="status" aria-live="polite">{notificationPermissionText()}</p>
      </section>
    </div>
  )
}
