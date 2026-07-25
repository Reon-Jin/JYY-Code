import { tr } from "../../i18n/i18n-context"
import { useNavigate } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { useManagement, type ManagementContextValue } from "../management/management-context"
import { SkillCreateDialog } from "./skill-create-dialog"
import { SkillSourceDialog } from "./skill-source-dialog"
import { managementSkillsQueryOptions, refreshManagementSkills } from "./skill-query"
import "./skills.css"

const originLabel = () =>
  ({ built_in: tr("skills.built-in"), managed: tr("skills.managed"), path: tr("skills.path"), url: "URL" }) as const

export function SkillListPage(props: { management?: ManagementContextValue }) {
  const management = props.management ?? useManagement()
  const navigate = useNavigate()
  const [search, setSearch] = createSignal("")
  const [createOpen, setCreateOpen] = createSignal(false)
  const [sourceOpen, setSourceOpen] = createSignal(false)
  const query = createQuery(
    () => managementSkillsQueryOptions({ client: management.client, directory: management.directory }),
    () => management.queryClient,
  )
  const filtered = createMemo(() => {
    const term = search().trim().toLocaleLowerCase("en-US")
    return (query.data ?? [])
      .map((skill, index) => ({ skill, index }))
      .filter(
        ({ skill }) =>
          !term ||
          [skill.name, skill.description, skill.source, skill.location].some((value) =>
            value?.toLocaleLowerCase("en-US").includes(term),
          ),
      )
      .sort(
        (left, right) =>
          left.skill.name.localeCompare(right.skill.name, undefined, { sensitivity: "base" }) ||
          left.index - right.index,
      )
      .map(({ skill }) => skill)
  })

  return (
    <main class="skill-page">
      <header class="skill-page__header">
        <h1>Skill</h1>
        <div class="skill-toolbar">
          <input
            type="search"
            aria-label={tr("skills.search-skill")}
            placeholder={tr("skills.search")}
            value={search()}
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
          <Button size="small" variant="secondary" onClick={() => setCreateOpen(true)}>
            {tr("skills.new")}
          </Button>
          <Button size="small" variant="secondary" onClick={() => setSourceOpen(true)}>
            {tr("skills.source")}
          </Button>
        </div>
      </header>
      <Show
        when={!query.isPending}
        fallback={
          <p class="skill-state" role="status">
            {tr("skills.loading-skills")}
          </p>
        }
      >
        <Show
          when={!query.error}
          fallback={
            <div class="skill-state">
              <InlineError
                message={query.error instanceof Error ? query.error.message : tr("skills.unable-to-load-skill")}
              />
              <Button size="small" variant="secondary" onClick={() => void query.refetch()}>
                {tr("changes.try-again")}
              </Button>
            </div>
          }
        >
          <Show
            when={filtered().length > 0}
            fallback={
              <p class="skill-state">
                {search() ? tr("skills.no-matching-skill") : tr("skills.there-is-no-global-skill-yet")}
              </p>
            }
          >
            <ul class="skill-list">
              <For each={filtered()}>
                {(skill) => (
                  <li>
                    <button
                      type="button"
                      class="skill-list__row"
                      aria-label={tr("skills.open-skill-name", { name: skill.name })}
                      onClick={() => navigate(`/skills/${encodeURIComponent(skill.name)}`)}
                    >
                      <span class="skill-list__primary">
                        <strong>{skill.name}</strong>
                        <small>{skill.description || tr("skills.no-description")}</small>
                      </span>
                      <span class="skill-origin" data-origin={skill.origin}>
                        {originLabel()[skill.origin]}
                      </span>
                      <span class="skill-list__location">{skill.source ?? skill.location}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
      <SkillCreateDialog
        open={createOpen()}
        onClose={() => setCreateOpen(false)}
        onCreate={async (input) => {
          await management.client.skill.create({ directory: management.directory, ...input }, { throwOnError: true })
          await refreshManagementSkills(management.queryClient, input.name)
          navigate(`/skills/${encodeURIComponent(input.name)}`)
        }}
      />
      <SkillSourceDialog
        open={sourceOpen()}
        onClose={() => setSourceOpen(false)}
        onAdd={async (input) => {
          await management.client.skill.source.add(
            { directory: management.directory, ...input },
            { throwOnError: true },
          )
          await refreshManagementSkills(management.queryClient)
        }}
      />
    </main>
  )
}

export default SkillListPage
