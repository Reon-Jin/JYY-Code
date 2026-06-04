import type { RouteSectionProps } from '@solidjs/router'
import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'

export function AppLayout(props: RouteSectionProps) {
  return (
    <div style={{
      display: 'flex',
      'flex-direction': 'column',
      height: '100vh',
      overflow: 'hidden',
    }}>
      <TitleBar />
      <div style={{
        display: 'flex',
        flex: '1',
        overflow: 'hidden',
      }}>
        <Sidebar />
        <main style={{
          flex: '1',
          overflow: 'hidden',
          display: 'flex',
          'flex-direction': 'column',
        }}>
          {props.children}
        </main>
      </div>
    </div>
  )
}
