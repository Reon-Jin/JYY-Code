import { A, useLocation } from "@solidjs/router"
import { Blocks, House, Plug } from "lucide-solid"
import type { ParentProps } from "solid-js"
import "./management-shell.css"

const items = [
  { href: "/", label: "首页", icon: House },
  { href: "/skills", label: "Skill", icon: Blocks },
  { href: "/mcp", label: "MCP", icon: Plug },
] as const

export function ManagementShell(props: ParentProps) {
  const location = useLocation()
  const active = (href: string) =>
    href === "/" ? location.pathname === "/" : location.pathname === href || location.pathname.startsWith(`${href}/`)

  return (
    <div class="management-shell">
      <nav class="management-rail" aria-label="全局管理">
        <span class="management-rail__brand" aria-label="JYYCode">
          J
        </span>
        <div class="management-rail__links">
          {items.map((item) => (
            <A class="management-nav-link" href={item.href} aria-current={active(item.href) ? "page" : undefined}>
              <item.icon aria-hidden="true" />
              <span>{item.label}</span>
            </A>
          ))}
        </div>
      </nav>
      <div class="management-shell__content">{props.children}</div>
    </div>
  )
}
