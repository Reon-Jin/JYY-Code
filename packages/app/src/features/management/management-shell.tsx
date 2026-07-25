import { tr } from "../../i18n/i18n-context"
import { A, useLocation } from "@solidjs/router"
import { Blocks, House, Plug, Settings } from "lucide-solid"
import type { ParentProps } from "solid-js"
import "./management-shell.css"
import { settingsHref } from "../settings/settings-navigation"

const items = () =>
  [
    { href: "/", label: tr("management.front-page"), icon: House },
    { href: "/skills", label: "Skill", icon: Blocks },
    { href: "/mcp", label: "MCP", icon: Plug },
  ] as const

export function ManagementShell(props: ParentProps) {
  const location = useLocation()
  const active = (href: string) =>
    href === "/" ? location.pathname === "/" : location.pathname === href || location.pathname.startsWith(`${href}/`)

  return (
    <div class="management-shell">
      <nav class="management-rail" aria-label={tr("management.global-management")}>
        <span class="management-rail__brand" aria-label="JYYCode">
          J
        </span>
        <div class="management-rail__links">
          {items().map((item) => (
            <A class="management-nav-link" href={item.href} aria-current={active(item.href) ? "page" : undefined}>
              <item.icon aria-hidden="true" />
              <span>{item.label}</span>
            </A>
          ))}
        </div>
        <A class="management-nav-link management-nav-link--settings" href={settingsHref("general", "/")}>
          <Settings aria-hidden="true" />
          <span>{tr("management.set-up")}</span>
        </A>
      </nav>
      <div class="management-shell__content">{props.children}</div>
    </div>
  )
}
