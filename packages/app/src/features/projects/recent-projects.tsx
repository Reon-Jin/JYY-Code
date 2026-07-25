import { tr } from "../../i18n/i18n-context"
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
  const projectPaths = () => props.projects.slice(0, 10).map((project) => project.path)

  return (
    <section class="recent-projects" aria-labelledby="recent-projects-title">
      <div class="recent-projects__heading">
        <h2 id="recent-projects-title">{tr("projects.recent-projects")}</h2>
        <span
          class="recent-projects__count"
          aria-label={tr("projects.recent-project-count", { count: props.projects.length })}
        >
          {props.projects.length}
        </span>
      </div>

      <Show
        when={props.projects.length > 0}
        fallback={<p class="recent-projects__empty">{tr("projects.after-opening-or-creating-a-new-project-it")}</p>}
      >
        <ul class="recent-projects__list">
          <For each={projectPaths()}>
            {(path) => (
              <li class="recent-projects__item" data-unavailable={props.isUnavailable(path) || undefined}>
                <Button
                  class="recent-projects__open"
                  variant="ghost"
                  aria-label={tr("projects.open-name", { name: projectName(path) })}
                  disabled={props.disabled}
                  onClick={() => props.onOpen(path)}
                >
                  <span class="recent-projects__icon" aria-hidden="true">
                    <Folder />
                  </span>
                  <span class="recent-projects__details">
                    <span class="recent-projects__name">{projectName(path)}</span>
                    <span class="recent-projects__path">{path}</span>
                  </span>
                  <Show when={props.isUnavailable(path)}>
                    <span class="recent-projects__unavailable">{tr("projects.not-available")}</span>
                  </Show>
                </Button>
                <IconButton
                  class="recent-projects__remove"
                  label={tr("projects.remove-recent-path", { path })}
                  variant="ghost"
                  disabled={props.disabled}
                  onClick={() => props.onRemove(path)}
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
