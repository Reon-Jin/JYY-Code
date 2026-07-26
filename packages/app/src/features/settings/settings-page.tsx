import { tr } from "../../i18n/i18n-context"
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { ArrowLeft } from "lucide-solid"
import { Button } from "../../components/ui/button"
import { sanitizeSettingsReturnTo, settingsHref, type SettingsSection } from "./settings-navigation"
import "./settings.css"
import { GeneralSettings } from "./general-settings"
import { Show } from "solid-js"
import { SecuritySettings } from "./security-settings"
import { AdvancedSettings } from "./advanced-settings"
import { MobileSettings } from "./mobile-settings"

const sections = (): Array<{ id: SettingsSection; label: string }> => [
  { id: "general", label: tr("settings.conventional") },
  { id: "security", label: tr("settings.permissions-and-security") },
  { id: "mobile", label: "Mobile companion" },
  { id: "advanced", label: tr("settings.advanced") },
]

function selectedSection(value: string | undefined): SettingsSection {
  return sections().some((section) => section.id === value) ? (value as SettingsSection) : "general"
}

export function SettingsPage() {
  const params = useParams<{ section?: string }>()
  const [search] = useSearchParams<{ returnTo?: string }>()
  const navigate = useNavigate()
  const section = () => selectedSection(params.section)
  const returnTo = () => sanitizeSettingsReturnTo(search.returnTo)

  function returnFromSettings() {
    const target = returnTo()
    navigate(target)
    window.requestAnimationFrame(() => {
      const selector = target === "/" ? ".management-nav-link--settings" : ".workspace-settings-link"
      document.querySelector<HTMLElement>(selector)?.focus()
    })
  }

  return (
    <main class="settings-page">
      <header class="settings-header">
        <Button variant="ghost" onClick={returnFromSettings}>
          <ArrowLeft aria-hidden="true" />
          {tr("settings.return")}
        </Button>
        <h1>{tr("management.set-up")}</h1>
      </header>
      <div class="settings-layout">
        <nav class="settings-navigation" aria-label={tr("settings.set-categories")}>
          {sections().map((item) => (
            <A href={settingsHref(item.id, returnTo())} aria-current={section() === item.id ? "page" : undefined}>
              {item.label}
            </A>
          ))}
        </nav>
        <section class="settings-content" aria-labelledby="settings-section-title">
          <h2 id="settings-section-title">{sections().find((item) => item.id === section())?.label}</h2>
          <Show when={section() === "general"}>
            <GeneralSettings />
          </Show>
          <Show when={section() === "security"}>
            <SecuritySettings />
          </Show>
          <Show when={section() === "advanced"}>
            <AdvancedSettings />
          </Show>
          <Show when={section() === "mobile"}>
            <MobileSettings />
          </Show>
        </section>
      </div>
    </main>
  )
}
