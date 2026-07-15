import type { QueryClient } from "@tanstack/solid-query"
import { createQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import type { DesktopClient } from "../../data/sdk"
import { errorMessage } from "../projects/project-controller"

export type SkillAutocompleteHandle = {
  handleKeyDown: (event: KeyboardEvent) => boolean
}

export type SkillAutocompleteProps = {
  client: Pick<DesktopClient, "app">
  queryClient: QueryClient
  directory: string
  open: boolean
  query: string
  onSelect: (name: string) => void
  onDismiss: () => void
  ref?: (handle: SkillAutocompleteHandle) => void
}

export function SkillAutocomplete(props: SkillAutocompleteProps) {
  const [selected, setSelected] = createSignal(0)
  const skills = createQuery(
    () => ({
      queryKey: keys.skills(props.directory),
      enabled: props.open,
      queryFn: async () => {
        const result = await props.client.app.skills({ directory: props.directory }, { throwOnError: true })
        return result.data ?? []
      },
    }),
    () => props.queryClient,
  )
  const options = createMemo(() => {
    const query = props.query.trim().toLocaleLowerCase()
    return [...(skills.data ?? [])]
      .filter((skill) => {
        if (!query) return true
        return `${skill.name}\n${skill.description ?? ""}`.toLocaleLowerCase().includes(query)
      })
      .sort((left, right) => {
        const leftPrefix = left.name.toLocaleLowerCase().startsWith(query)
        const rightPrefix = right.name.toLocaleLowerCase().startsWith(query)
        if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1
        return left.name.localeCompare(right.name)
      })
  })

  createEffect(() => {
    props.open
    props.query
    options().length
    setSelected(0)
  })

  function handleKeyDown(event: KeyboardEvent) {
    if (!props.open) return false
    if (event.key === "Escape") {
      event.preventDefault()
      props.onDismiss()
      return true
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const count = options().length
      if (count) setSelected((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + count) % count)
      return true
    }
    if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault()
      const skill = options()[selected()]
      if (skill) props.onSelect(skill.name)
      return true
    }
    return false
  }

  props.ref?.({ handleKeyDown })

  return (
    <Show when={props.open}>
      <div id="composer-skill-listbox" class="composer-skill-menu" role="listbox" aria-label="Skills">
        <Show when={!skills.isPending} fallback={<p class="composer-skill-menu__status">正在加载 Skills…</p>}>
          <Show
            when={!skills.error}
            fallback={<InlineError message={errorMessage(skills.error, "无法加载 Skills")} />}
          >
            <Show when={options().length > 0} fallback={<p class="composer-skill-menu__status">没有匹配的 Skills</p>}>
              <For each={options()}>
                {(skill, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index() === selected()}
                    data-selected={index() === selected() ? "true" : "false"}
                    onPointerDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setSelected(index())}
                    onClick={() => props.onSelect(skill.name)}
                  >
                    <strong>/{skill.name}</strong>
                    <Show when={skill.description}><small>{skill.description}</small></Show>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </div>
    </Show>
  )
}
