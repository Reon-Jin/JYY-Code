import type { SubagentProfile, SubagentProfileView } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { useData } from "../../data/context"
import { tr } from "../../i18n/i18n-context"
import {
  SUBAGENT_AVATAR_IDS,
  SubagentAvatar,
  subagentAvatarLabel,
  type SubagentAvatarID,
} from "./subagent-avatar-catalog"
import {
  createSubagentSkill,
  refreshSubagentProfiles,
  subagentProfilesQueryOptions,
  updateSubagentProfiles,
} from "./subagent-profiles-query"
import "./subagent-profiles-panel.css"

const defaultDraft: SubagentProfile = {
  id: "",
  name: "",
  description: "",
  prompt: "",
  avatar: "bot",
  enabled: true,
}

function draftFromProfile(profile: SubagentProfileView): SubagentProfile {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    prompt: profile.prompt,
    avatar: profile.avatar,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.variant ? { variant: profile.variant } : {}),
    enabled: profile.enabled,
  }
}

function errorText(value: unknown) {
  return value instanceof Error && value.message ? value.message : tr("subagents.save-failed")
}

export type SubagentProfilesPanelViewProps = {
  profiles: readonly SubagentProfileView[]
  loading?: boolean
  error?: string
  onSave: (profiles: readonly SubagentProfile[]) => Promise<void>
  onCreateSkill: (roleID: string, input: { name: string; content: string }) => Promise<void>
  onRefresh: () => void
}

export function SubagentProfilesPanelView(props: SubagentProfilesPanelViewProps) {
  const [selectedID, setSelectedID] = createSignal<string>()
  const [draft, setDraft] = createSignal<SubagentProfile>({ ...defaultDraft })
  const [creating, setCreating] = createSignal(false)
  const [skillCreating, setSkillCreating] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [skillBusy, setSkillBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [skillError, setSkillError] = createSignal<string>()
  const [skillName, setSkillName] = createSignal("")
  const [skillContent, setSkillContent] = createSignal("")

  createEffect(() => {
    if (selectedID() || creating() || props.profiles.length === 0) return
    const first = props.profiles[0]
    if (first) {
      setSelectedID(first.id)
      setDraft(draftFromProfile(first))
    }
  })

  const selectedProfile = createMemo(() => props.profiles.find((profile) => profile.id === selectedID()))
  const updateDraft = (patch: Partial<SubagentProfile>) => setDraft((current) => ({ ...current, ...patch }))

  function selectProfile(profile: SubagentProfileView) {
    setCreating(false)
    setSelectedID(profile.id)
    setDraft(draftFromProfile(profile))
    setError(undefined)
    setSkillError(undefined)
    setSkillCreating(false)
  }

  function startNew() {
    setCreating(true)
    setSelectedID(undefined)
    setDraft({ ...defaultDraft })
    setError(undefined)
    setSkillError(undefined)
    setSkillCreating(false)
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (saving()) return
    const value = draft()
    if (!value.id.trim() || !value.name.trim() || !value.description.trim()) {
      setError(tr("subagents.required-fields"))
      return
    }
    if (value.id !== "general" && props.profiles.some((profile) => profile.id === value.id && profile.id !== selectedID())) {
      setError(tr("subagents.duplicate-id"))
      return
    }
    const next = creating()
      ? [...props.profiles.map(draftFromProfile), value]
      : props.profiles.map((profile) => (profile.id === selectedID() ? value : draftFromProfile(profile)))
    setSaving(true)
    setError(undefined)
    try {
      await props.onSave(next)
      setCreating(false)
      setSkillCreating(false)
      setSelectedID(value.id)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setSaving(false)
    }
  }

  async function createSkill(event: SubmitEvent) {
    event.preventDefault()
    const roleID = selectedID()
    const name = skillName().trim()
    if (!roleID || !name) {
      setSkillError(tr("subagents.required-skill-name"))
      return
    }
    setSkillBusy(true)
    setSkillError(undefined)
    try {
      await props.onCreateSkill(roleID, { name, content: skillContent() })
      setSkillName("")
      setSkillContent("")
      setSkillCreating(false)
      await Promise.resolve(props.onRefresh())
    } catch (cause) {
      setSkillError(errorText(cause))
    } finally {
      setSkillBusy(false)
    }
  }

  return (
    <section class="subagent-profiles-panel" aria-label={tr("subagents.title")}>
      <header class="subagent-profiles-panel__header">
        <div>
          <p class="subagent-profiles-panel__eyebrow">{tr("subagents.eyebrow")}</p>
          <h2>{tr("subagents.title")}</h2>
          <p>{tr("subagents.enabled-count", { count: props.profiles.filter((profile) => profile.enabled).length, total: props.profiles.length })}</p>
        </div>
        <Button size="small" onClick={startNew}>
          {tr("subagents.new")}
        </Button>
      </header>

      <Show when={props.loading}>
        <p class="subagent-profiles-panel__status">{tr("subagents.loading")}</p>
      </Show>
      <Show when={props.error || error()}>{(message) => <InlineError message={message()} />}</Show>

      <div class="subagent-profiles-panel__body">
        <div class="subagent-profiles-panel__cards" role="list" aria-label={tr("subagents.profiles")}>
          <For each={props.profiles}>
            {(profile) => (
              <button
                type="button"
                class="subagent-profile-card"
                classList={{ "subagent-profile-card--active": selectedID() === profile.id }}
                aria-pressed={selectedID() === profile.id}
                onClick={() => selectProfile(profile)}
              >
                <span class="subagent-profile-card__avatar">
                  <SubagentAvatar id={profile.avatar as SubagentAvatarID} />
                </span>
                <span class="subagent-profile-card__copy">
                  <strong>{profile.name}</strong>
                  <small>{profile.id}</small>
                </span>
                <span class="subagent-profile-card__status" data-enabled={profile.enabled ? "true" : "false"} />
              </button>
            )}
          </For>
        </div>

        <Show when={creating() || selectedID()}>
          <form class="subagent-profile-editor" aria-label={tr("subagents.editor")} onSubmit={save}>
            <div class="subagent-profile-editor__title">
              <div>
                <p class="subagent-profiles-panel__eyebrow">{creating() ? tr("subagents.new") : tr("subagents.edit")}</p>
                <h3>{draft().name || tr("subagents.untitled")}</h3>
              </div>
              <label class="subagent-profile-editor__toggle">
                <input
                  type="checkbox"
                  aria-label={tr("subagents.enabled")}
                  checked={draft().enabled}
                  onChange={(event) => updateDraft({ enabled: event.currentTarget.checked })}
                />
                {tr("subagents.enabled")}
              </label>
            </div>
            <label>
              {tr("subagents.id")}
              <input
                aria-label={tr("subagents.id")}
                value={draft().id}
                disabled={!creating()}
                onInput={(event) => updateDraft({ id: event.currentTarget.value })}
              />
            </label>
            <label>
              {tr("subagents.name")}
              <input aria-label={tr("subagents.name")} value={draft().name} onInput={(event) => updateDraft({ name: event.currentTarget.value })} />
            </label>
            <label>
              {tr("subagents.description")}
              <input aria-label={tr("subagents.description")} value={draft().description} onInput={(event) => updateDraft({ description: event.currentTarget.value })} />
            </label>
            <label>
              {tr("subagents.launch-prompt")}
              <textarea aria-label={tr("subagents.launch-prompt")} rows={4} value={draft().prompt} onInput={(event) => updateDraft({ prompt: event.currentTarget.value })} />
            </label>
            <div class="subagent-profile-editor__fields">
              <label>
                {tr("subagents.model")}
                <input aria-label={tr("subagents.model")} value={draft().model ?? ""} placeholder="provider/model" onInput={(event) => updateDraft({ model: event.currentTarget.value || undefined })} />
              </label>
              <label>
                {tr("subagents.thinking-depth")}
                <select aria-label={tr("subagents.thinking-depth")} value={draft().variant ?? "default"} onChange={(event) => updateDraft({ variant: event.currentTarget.value === "default" ? undefined : event.currentTarget.value })}>
                  <option value="default">{tr("composer.thinking-depth-default")}</option>
                  <option value="low">{tr("composer.thinking-depth-low")}</option>
                  <option value="medium">{tr("composer.thinking-depth-medium")}</option>
                  <option value="high">{tr("composer.thinking-depth-high")}</option>
                  <option value="max">{tr("composer.thinking-depth-max")}</option>
                </select>
              </label>
            </div>
            <fieldset class="subagent-profile-editor__avatars">
              <legend>{tr("subagents.avatar")}</legend>
              <div>
                <For each={SUBAGENT_AVATAR_IDS}>
                  {(id) => (
                    <button
                      type="button"
                      class="subagent-avatar-choice"
                      aria-label={`${tr("subagents.choose-avatar")} ${id}`}
                      aria-pressed={draft().avatar === id}
                      title={subagentAvatarLabel(id)}
                      onClick={() => updateDraft({ avatar: id })}
                    >
                      <SubagentAvatar id={id} />
                    </button>
                  )}
                </For>
              </div>
            </fieldset>
            <div class="subagent-profile-editor__actions">
              <Button type="submit" loading={saving()} loadingLabel={tr("subagents.saving")}>
                {tr("subagents.save")}
              </Button>
            </div>
          </form>
        </Show>
      </div>

      <Show when={selectedProfile()}>
        {(profile) => (
          <section class="subagent-profile-skills" aria-label={tr("subagents.skills")}>
            <div class="subagent-profile-skills__header">
              <div>
                <h3>{tr("subagents.skills")}</h3>
                <p>{tr("subagents.skill-directory", { role: profile().id })}</p>
              </div>
              <Button size="small" variant="secondary" onClick={() => setSkillCreating(true)}>
                {tr("subagents.new-skill")}
              </Button>
            </div>
            <Show when={profile().skills.length > 0} fallback={<p class="subagent-profiles-panel__status">{tr("subagents.no-skills")}</p>}>
              <ul class="subagent-profile-skills__list">
                <For each={profile().skills}>
                  {(skill) => (
                    <li>
                      <strong>{skill.name}</strong>
                      <small>{skill.location}</small>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <p class="subagent-profile-skills__hint">{tr("subagents.refresh-hint")}</p>
            <Show when={skillError()}>{(message) => <InlineError message={message()} />}</Show>
            <Show when={selectedID() && skillCreating()}>
              <form class="subagent-skill-create" onSubmit={createSkill}>
                <label>
                  {tr("subagents.skill-name")}
                  <input aria-label={tr("subagents.skill-name")} value={skillName()} onInput={(event) => setSkillName(event.currentTarget.value)} />
                </label>
                <label>
                  {tr("subagents.skill-content")}
                  <textarea aria-label="SKILL.md" rows={6} value={skillContent()} onInput={(event) => setSkillContent(event.currentTarget.value)} />
                </label>
                <Button type="submit" loading={skillBusy()} loadingLabel={tr("subagents.creating-skill")}>
                  {tr("subagents.create-skill")}
                </Button>
              </form>
            </Show>
          </section>
        )}
      </Show>
    </section>
  )
}

export function SubagentProfilesPanel(props: { directory: string }) {
  const data = useData()
  const query = createQuery(
    () => ({
      ...subagentProfilesQueryOptions({ client: data.client(), directory: props.directory }),
      enabled: data.connection() === "connected",
    }),
    data.queryClient,
  )

  const save = async (profiles: readonly SubagentProfile[]) => {
    await updateSubagentProfiles({ client: data.client(), directory: props.directory, profiles })
    await query.refetch()
  }

  const createSkill = async (roleID: string, input: { name: string; content: string }) => {
    await createSubagentSkill({ client: data.client(), directory: props.directory, roleID, ...input })
    await refreshSubagentProfiles(data.queryClient(), props.directory)
    await query.refetch()
  }

  return (
    <SubagentProfilesPanelView
      profiles={query.data ?? []}
      loading={query.isPending}
      error={query.error ? errorText(query.error) : undefined}
      onSave={save}
      onCreateSkill={createSkill}
      onRefresh={() => void query.refetch()}
    />
  )
}
