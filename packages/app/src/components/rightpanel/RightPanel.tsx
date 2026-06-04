import { type JSX, Show } from 'solid-js'
import { useSessionStore, sessionActions } from '../../stores/session'
import { TabBar } from '../ui/TabBar'
import { TaskPlanningView } from './TaskPlanningView'
import { CodeReviewView } from './CodeReviewView'
import type { TaskPlan, FileChange } from '../../types/models'

interface RightPanelProps {
  taskPlan: TaskPlan | null
  fileChanges: FileChange[]
}

export function RightPanel(props: RightPanelProps) {
  const session = useSessionStore()

  const panelWidth = () => session.rightPanelExpanded ? 340 : 40

  const tabs = [
    { id: 'tasks', label: '任务', icon: '📋' },
    { id: 'review', label: '审查', icon: '📝' },
  ]

  return (
    <div style={{
      width: `${panelWidth()}px`,
      'min-width': `${panelWidth()}px`,
      'max-width': `${panelWidth()}px`,
      height: '100%',
      background: 'var(--color-white)',
      'border-left': session.rightPanelExpanded ? '1px solid rgba(0,0,0,0.06)' : 'none',
      transition: 'width 0.3s ease, min-width 0.3s ease, max-width 0.3s ease',
      display: 'flex',
      'flex-direction': 'column',
      overflow: 'hidden',
    }}>
      {/* Toggle button (always visible) */}
      <button
        onClick={() => sessionActions.toggleRightPanel()}
        style={{
          width: '100%',
          height: '40px',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
          color: 'var(--color-text-tertiary)',
          'font-size': '14px',
          transition: 'color 0.15s',
          'flex-shrink': '0',
        }}
        title={session.rightPanelExpanded ? '收起面板' : '展开面板'}
      >
        {session.rightPanelExpanded ? '▶' : '◀'}
      </button>

      <Show when={session.rightPanelExpanded}>
        <div style={{
          flex: '1',
          display: 'flex',
          'flex-direction': 'column',
          overflow: 'hidden',
        }}>
          {/* Tab bar */}
          <TabBar
            tabs={tabs}
            activeTab={session.rightPanelTab}
            onChange={(tabId) => sessionActions.setRightPanelTab(tabId as 'tasks' | 'review')}
          />

          {/* Content */}
          <div style={{
            flex: '1',
            overflow: 'auto',
            padding: 'var(--space-14)',
          }}>
            <Show when={session.rightPanelTab === 'tasks'}>
              <TaskPlanningView plan={props.taskPlan} />
            </Show>
            <Show when={session.rightPanelTab === 'review'}>
              <CodeReviewView changes={props.fileChanges} />
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
