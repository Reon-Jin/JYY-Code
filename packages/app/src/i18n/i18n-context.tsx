import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { defaultDesktopSettings, type AppLocale, type DesktopSettings } from "../features/settings/settings-preferences"
import { useDesktopBridge } from "../platform/context"
import { formatMessage, type MessageValues } from "./format"
import { messages, zhCN, type MessageKey } from "./messages"

export type I18nContextValue = {
  locale: Accessor<AppLocale>
  isReady: Accessor<boolean>
  t: (key: MessageKey, values?: MessageValues) => string
  setLocale: (locale: AppLocale) => Promise<void>
}

const I18nContext = createContext<I18nContextValue>()
const warnedKeys = new Set<string>()
const [globalLocale, setGlobalLocale] = createSignal<AppLocale>(defaultDesktopSettings.locale)

function missingMessage(locale: AppLocale, key: MessageKey) {
  if (import.meta.env.DEV) throw new Error(`Missing i18n message: ${locale}.${key}`)
  const warningKey = `${locale}.${key}`
  if (!warnedKeys.has(warningKey)) {
    warnedKeys.add(warningKey)
    console.warn("i18n_missing_message", { locale, key })
  }
  return zhCN[key]
}

function translate(locale: AppLocale, key: MessageKey, values?: MessageValues) {
  const template = messages[locale][key] ?? missingMessage(locale, key)
  return formatMessage(template, values)
}

export function tr(key: MessageKey, values?: MessageValues) {
  return translate(globalLocale(), key, values)
}

export function I18nProvider(props: ParentProps) {
  const bridge = useDesktopBridge()
  const [locale, setLocaleSignal] = createSignal<AppLocale>(defaultDesktopSettings.locale)
  const [isReady, setReady] = createSignal(false)
  let settings: DesktopSettings = defaultDesktopSettings

  const previousLang = document.documentElement.getAttribute("lang")
  const previousDataLocale = document.documentElement.getAttribute("data-locale")
  const previousGlobalLocale = globalLocale()

  createEffect(() => {
    document.documentElement.lang = locale()
    document.documentElement.dataset.locale = locale()
    setGlobalLocale(locale())
  })

  onCleanup(() => {
    if (previousLang === null) document.documentElement.removeAttribute("lang")
    else document.documentElement.lang = previousLang
    if (previousDataLocale === null) document.documentElement.removeAttribute("data-locale")
    else document.documentElement.dataset.locale = previousDataLocale
    setGlobalLocale(previousGlobalLocale)
  })

  onMount(async () => {
    try {
      settings = await bridge.loadSettings()
      setLocaleSignal(settings.locale)
    } catch {
      settings = defaultDesktopSettings
    } finally {
      setReady(true)
    }
  })

  const value: I18nContextValue = {
    locale,
    isReady,
    t(key, values) {
      return translate(locale(), key, values)
    },
    async setLocale(nextLocale) {
      const previousLocale = locale()
      if (nextLocale === previousLocale) return
      setLocaleSignal(nextLocale)
      try {
        const nextSettings = { ...settings, locale: nextLocale }
        await bridge.saveSettings(nextSettings)
        settings = nextSettings
      } catch (error) {
        setLocaleSignal(previousLocale)
        throw error
      }
    },
  }

  return (
    <I18nContext.Provider value={value}>
      <Show
        when={isReady()}
        fallback={
          <main class="startup-screen i18n-loading-shell">
            <div role="status">{value.t("app.loading")}</div>
          </main>
        }
      >
        {props.children}
      </Show>
    </I18nContext.Provider>
  )
}

export function useI18n() {
  const value = useContext(I18nContext)
  if (!value) throw new Error("I18nProvider is missing")
  return value
}
