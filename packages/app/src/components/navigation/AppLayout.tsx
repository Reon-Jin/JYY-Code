import type { RouteSectionProps } from '@solidjs/router'
import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'

export function AppLayout(props: RouteSectionProps) {
  return (
    <div class="app-shell">
      <TitleBar />
      <div class="app-body">
        <Sidebar />
        <main class="app-main">{props.children}</main>
      </div>
    </div>
  )
}
