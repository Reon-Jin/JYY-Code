import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { ArrowLeft } from "lucide-solid"
import { Button } from "../../components/ui/button"
import { sanitizeSettingsReturnTo, settingsHref, type SettingsSection } from "./settings-navigation"
import "./settings.css"
import { GeneralSettings } from "./general-settings"
import { Show } from "solid-js"

const sections: Array<{ id: SettingsSection; label: string }> = [
  { id: "general", label: "常规" },
  { id: "security", label: "权限与安全" },
  { id: "advanced", label: "高级" },
]

function selectedSection(value: string | undefined): SettingsSection {
  return sections.some((section) => section.id === value) ? (value as SettingsSection) : "general"
}

export function SettingsPage() {
  const params = useParams<{ section?: string }>()
  const [search] = useSearchParams<{ returnTo?: string }>()
  const navigate = useNavigate()
  const section = () => selectedSection(params.section)
  const returnTo = () => sanitizeSettingsReturnTo(search.returnTo)

  return (
    <main class="settings-page">
      <header class="settings-header">
        <Button variant="ghost" onClick={() => navigate(returnTo())}>
          <ArrowLeft aria-hidden="true" />
          返回
        </Button>
        <h1>设置</h1>
      </header>
      <div class="settings-layout">
        <nav class="settings-navigation" aria-label="设置分类">
          {sections.map((item) => (
            <A
              href={settingsHref(item.id, returnTo())}
              aria-current={section() === item.id ? "page" : undefined}
            >
              {item.label}
            </A>
          ))}
        </nav>
        <section class="settings-content" aria-labelledby="settings-section-title">
          <h2 id="settings-section-title">{sections.find((item) => item.id === section())?.label}</h2>
          <Show when={section() === "general"}>
            <GeneralSettings />
          </Show>
        </section>
      </div>
    </main>
  )
}
