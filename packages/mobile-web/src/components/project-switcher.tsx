import { ChevronDown, Search, X } from "lucide-solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { taskProject, type RemoteTask } from "../lib/models"

export const ALL_PROJECTS = "全部项目"

export function ProjectSwitcher(props: { tasks: RemoteTask[]; selected: string; onSelect: (project: string) => void }) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const projects = createMemo(() =>
    Array.from(new Set(props.tasks.map(taskProject))).sort((left, right) => left.localeCompare(right, "zh-CN")),
  )
  const filtered = createMemo(() => projects().filter((project) => project.includes(query().trim())))

  function choose(project: string) {
    props.onSelect(project)
    setOpen(false)
    setQuery("")
  }

  return (
    <>
      <button class="project-switcher" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <span>项目：{props.selected}</span>
        <ChevronDown />
      </button>
      <div class="project-chips" role="tablist" aria-label="项目筛选">
        <button
          classList={{ "is-active": props.selected === ALL_PROJECTS }}
          onClick={() => props.onSelect(ALL_PROJECTS)}
        >
          全部项目
        </button>
        <For each={projects()}>
          {(project) => (
            <button classList={{ "is-active": props.selected === project }} onClick={() => props.onSelect(project)}>
              {project}
            </button>
          )}
        </For>
      </div>
      <Show when={open()}>
        <div class="sheet-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <section
            class="project-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="项目切换"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span class="eyebrow">项目切换</span>
                <h2>快速切换项目</h2>
              </div>
              <button class="icon-button" aria-label="关闭" onClick={() => setOpen(false)}>
                <X />
              </button>
            </header>
            <label class="search-field">
              <Search />
              <input
                autofocus
                placeholder="搜索项目"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <button
              class="project-row"
              classList={{ "is-selected": props.selected === ALL_PROJECTS }}
              onClick={() => choose(ALL_PROJECTS)}
            >
              <span>
                <strong>全部项目</strong>
                <small>{props.tasks.length} 个任务</small>
              </span>
              <span>›</span>
            </button>
            <For each={filtered()}>
              {(project) => {
                const count = () => props.tasks.filter((task) => taskProject(task) === project).length
                return (
                  <button
                    class="project-row"
                    classList={{ "is-selected": props.selected === project }}
                    onClick={() => choose(project)}
                  >
                    <span>
                      <strong>{project}</strong>
                      <small>{count()} 个任务</small>
                    </span>
                    <span>›</span>
                  </button>
                )
              }}
            </For>
            <Show when={filtered().length === 0}>
              <p class="empty-copy">没有匹配的项目。</p>
            </Show>
          </section>
        </div>
      </Show>
    </>
  )
}
