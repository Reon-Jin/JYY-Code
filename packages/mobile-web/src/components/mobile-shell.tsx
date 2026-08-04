import { ClipboardCheck, LayoutDashboard, MonitorSmartphone } from "lucide-solid"
import { type JSX } from "solid-js"

export type PrimaryPage = "workbench" | "inbox" | "devices"

export function MobileShell(props: {
  page: PrimaryPage
  onNavigate: (page: PrimaryPage) => void
  children: JSX.Element
}) {
  return (
    <main class="mobile-app">
      <div class="mobile-app__content">{props.children}</div>
      <nav class="mobile-tabbar" aria-label="主导航">
        <Tab
          active={props.page === "workbench"}
          label="工作台"
          icon={<LayoutDashboard />}
          onClick={() => props.onNavigate("workbench")}
        />
        <Tab
          active={props.page === "inbox"}
          label="待处理"
          icon={<ClipboardCheck />}
          onClick={() => props.onNavigate("inbox")}
        />
        <Tab
          active={props.page === "devices"}
          label="设备"
          icon={<MonitorSmartphone />}
          onClick={() => props.onNavigate("devices")}
        />
      </nav>
    </main>
  )
}

function Tab(props: { active: boolean; label: string; icon: JSX.Element; onClick: () => void }) {
  return (
    <button
      class="mobile-tabbar__item"
      classList={{ "is-active": props.active }}
      aria-current={props.active ? "page" : undefined}
      onClick={props.onClick}
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  )
}
