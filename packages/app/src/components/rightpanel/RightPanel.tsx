import { Show } from 'solid-js'
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
  const tabs = [
    { id: 'tasks', label: 'Progress' },
    { id: 'review', label: 'Changes' },
  ]

  return (
    <aside class="right-panel" data-expanded={session.rightPanelExpanded}>
      <button
        class="panel-toggle"
        onClick={() => sessionActions.toggleRightPanel()}
        title={session.rightPanelExpanded ? 'Collapse panel' : 'Expand panel'}
      >
        {session.rightPanelExpanded ? '>' : '<'}
      </button>

      <Show when={session.rightPanelExpanded}>
        <div class="panel-content">
          <TabBar
            tabs={tabs}
            activeTab={session.rightPanelTab}
            onChange={(tabId) => sessionActions.setRightPanelTab(tabId as 'tasks' | 'review')}
          />
          <div class="panel-scroll">
            <Show when={session.rightPanelTab === 'tasks'}>
              <TaskPlanningView plan={props.taskPlan} />
            </Show>
            <Show when={session.rightPanelTab === 'review'}>
              <CodeReviewView changes={props.fileChanges} />
            </Show>
          </div>
        </div>
      </Show>
    </aside>
  )
}
