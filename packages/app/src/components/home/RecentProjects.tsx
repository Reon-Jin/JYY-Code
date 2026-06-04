import { For } from 'solid-js'

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
    <div class="recent-project-grid">
      <For each={props.projects}>
        {(project) => (
          <button class="project-card" onClick={() => props.onSelect(project)}>
            <span class="project-initial">{project.name.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{project.name}</strong>
              <span>{project.directory}</span>
            </div>
          </button>
        )}
      </For>
    </div>
  )
}
