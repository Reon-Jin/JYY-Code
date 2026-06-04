import { For } from 'solid-js'
import { Card } from '../ui/Card'

export interface RecentProjectData {
  name: string
  directory: string
  lastOpened: number
}

interface Props {
  projects: RecentProjectData[]
  onSelect: (project: RecentProjectData) => void
}

export function RecentProjects(props: Props) {
  if (props.projects.length === 0) return null

  return (
    <div style={{
      display: 'grid',
      'grid-template-columns': 'repeat(auto-fill, minmax(280px, 1fr))',
      gap: 'var(--space-20)',
    }}>
      <For each={props.projects}>
        {(project) => (
          <Card hoverable padding="lg" onClick={() => props.onSelect(project)}>
            <div style={{
              display: 'flex',
              'align-items': 'flex-start',
              gap: 'var(--space-14)',
            }}>
              <span style={{ 'font-size': '24px' }}>📁</span>
              <div style={{ flex: '1', 'min-width': '0' }}>
                <h3 class="text-card-title" style={{
                  'margin-bottom': '4px',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'white-space': 'nowrap',
                }}>
                  {project.name}
                </h3>
                <p class="text-caption" style={{
                  color: 'var(--color-text-tertiary)',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'white-space': 'nowrap',
                }}>
                  {project.directory}
                </p>
              </div>
            </div>
          </Card>
        )}
      </For>
    </div>
  )
}
