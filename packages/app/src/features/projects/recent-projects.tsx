import { For, Show } from "solid-js"
import { Folder, Trash2 } from "lucide-solid"
import { Button, IconButton } from "../../components/ui/button"
import type { RecentProject } from "../../platform/types"

export type RecentProjectsProps = {
  projects: readonly RecentProject[]
  isUnavailable: (path: string) => boolean
  disabled?: boolean
  onOpen: (path: string) => void
  onRemove: (path: string) => void
}

function projectName(path: string) {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts.at(-1) || path
}

export function RecentProjects(props: RecentProjectsProps) {
  return (
    <section class="recent-projects" aria-labelledby="recent-projects-title">
      <div class="recent-projects__heading">
        <h2 id="recent-projects-title">最近项目</h2>
        <span class="recent-projects__count" aria-label={`${props.projects.length} 个最近项目`}>
          {props.projects.length}
        </span>
      </div>

      <Show
        when={props.projects.length > 0}
        fallback={<p class="recent-projects__empty">打开或新建项目后，它会出现在这里。</p>}
      >
        <ul class="recent-projects__list">
          <For each={props.projects.slice(0, 10)}>
            {(project) => (
              <li class="recent-projects__item" data-unavailable={props.isUnavailable(project.path) || undefined}>
                <Button
                  class="recent-projects__open"
                  variant="ghost"
                  aria-label={`打开 ${projectName(project.path)}`}
                  disabled={props.disabled}
                  onClick={() => props.onOpen(project.path)}
                >
                  <span class="recent-projects__icon" aria-hidden="true">
                    <Folder />
                  </span>
                  <span class="recent-projects__details">
                    <span class="recent-projects__name">{projectName(project.path)}</span>
                    <span class="recent-projects__path">{project.path}</span>
                  </span>
                  <Show when={props.isUnavailable(project.path)}>
                    <span class="recent-projects__unavailable">不可用</span>
                  </Show>
                </Button>
                <IconButton
                  class="recent-projects__remove"
                  label={`从最近项目中移除 ${project.path}`}
                  variant="ghost"
                  disabled={props.disabled}
                  onClick={() => props.onRemove(project.path)}
                >
                  <Trash2 aria-hidden="true" />
                </IconButton>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
