import type { SubagentProfile, SubagentProfileView } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Button, IconButton } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import { useData } from "../../data/context"
import { tr } from "../../i18n/i18n-context"
import type { CatalogModel } from "../composer/model-catalog"
import {
  SUBAGENT_AVATAR_IDS,
  SubagentAvatar,
  subagentAvatarLabel,
  type SubagentAvatarID,
} from "./subagent-avatar-catalog"
import {
  createSubagentSkill,
  deleteSubagentProfile,
  refreshSubagentProfiles,
  subagentProfilesQueryOptions,
  subagentToolIDsQueryOptions,
  updateSubagentProfiles,
} from "./subagent-profiles-query"
import "./subagent-profiles-panel.css"

const SUBAGENT_SELECTABLE_TOOL_IDS = [
  "read",
  "edit",
  "write",
  "glob",
  "grep",
  "websearch",
  "webfetch",
  "bash",
  "process",
]
const SUBAGENT_FORBIDDEN_TOOL_IDS = new Set(["tool_search", "invalid", "question", "memory", "Inbox"])

function isFixedSubagentTool(toolID: string) {
  return (
    toolID === "skill" ||
    toolID === "Report" ||
    toolID === "Blackboard" ||
    toolID === "Blackboard.reply" ||
    toolID.startsWith("Candidate.")
  )
}

function isForbiddenSubagentTool(toolID: string) {
  return SUBAGENT_FORBIDDEN_TOOL_IDS.has(toolID) || toolID.startsWith("Plan.") || toolID.startsWith("Dispatch.")
}

function isSelectableSubagentTool(toolID: string) {
  return (
    SUBAGENT_SELECTABLE_TOOL_IDS.includes(toolID) || (!isFixedSubagentTool(toolID) && !isForbiddenSubagentTool(toolID))
  )
}

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
    ...(profile.tools !== undefined ? { tools: [...profile.tools] } : {}),
    enabled: profile.enabled,
  }
}

function errorText(value: unknown) {
  return value instanceof Error && value.message ? value.message : tr("subagents.save-failed")
}

function modelKey(model: Pick<CatalogModel, "providerID" | "modelID">) {
  return `${model.providerID}/${model.modelID}`
}

/**
 * Catalog options must keep referential identity across draft updates:
 * <For> keys by item identity, so freshly mapped objects would replace every
 * <option> node on each selection change and real browsers reset the select
 * to the first option (跟随主 Agent 模型), making an explicit choice appear
 * reverted. Memoize the catalog mapping and only vary the fallback entry.
 */
function createModelOptions(models: () => readonly CatalogModel[]) {
  const catalogOptions = createMemo(() =>
    models().map((model) => ({
      value: modelKey(model),
      label: `${model.providerName} · ${model.modelName}`,
    })),
  )
  // Keep unavailable-value entries referentially stable as well, so <For>
  // never replaces the <option> nodes of a select whose value just changed.
  const fallbackOptions = new Map<string, { value: string; label: string }>()
  return (value: string | undefined) => {
    const options = catalogOptions()
    if (!value || options.some((option) => option.value === value)) return options
    let fallback = fallbackOptions.get(value)
    if (!fallback) {
      fallback = { value, label: `${value} · ${tr("subagents.model-unavailable")}` }
      fallbackOptions.set(value, fallback)
    }
    return [fallback, ...options]
  }
}

export type SubagentProfilesPanelViewProps = {
  profiles: readonly SubagentProfileView[]
  toolIDs?: readonly string[]
  models?: readonly CatalogModel[]
  loading?: boolean
  error?: string
  onSave: (profiles: readonly SubagentProfile[]) => Promise<void>
  onDelete: (roleID: string) => Promise<void>
  onCreateSkill: (roleID: string, input: { name: string; content: string }) => Promise<void>
  onRefresh: () => void | Promise<void>
}

export function SubagentProfilesPanelView(props: SubagentProfilesPanelViewProps) {
  const [editingID, setEditingID] = createSignal<string>()
  const [creating, setCreating] = createSignal(false)
  const [draft, setDraft] = createSignal<SubagentProfile>({ ...defaultDraft })
  const [saving, setSaving] = createSignal(false)
  const [switchBusy, setSwitchBusy] = createSignal<string>()
  const [switchOverrides, setSwitchOverrides] = createSignal<Record<string, boolean>>({})
  const [error, setError] = createSignal<string>()
  const [skillCreating, setSkillCreating] = createSignal(false)
  const [skillBusy, setSkillBusy] = createSignal(false)
  const [skillRefreshing, setSkillRefreshing] = createSignal(false)
  const [skillError, setSkillError] = createSignal<string>()
  const [skillName, setSkillName] = createSignal("")
  const [skillContent, setSkillContent] = createSignal("")
  const [deletingID, setDeletingID] = createSignal<string>()
  const [deleteBusy, setDeleteBusy] = createSignal(false)
  const [deleteError, setDeleteError] = createSignal<string>()

  const editingProfile = createMemo(() => props.profiles.find((profile) => profile.id === editingID()))
  const deletingProfile = createMemo(() => props.profiles.find((profile) => profile.id === deletingID()))
  const dialogOpen = () => creating() || Boolean(editingID())
  const enabledFor = (profile: SubagentProfileView) => switchOverrides()[profile.id] ?? profile.enabled
  const enabledCount = () => props.profiles.filter((profile) => enabledFor(profile)).length
  const modelOptionsFor = createModelOptions(() => props.models ?? [])
  const availableModels = () => modelOptionsFor(draft().model)
  const availableToolIDs = createMemo(() => [...(props.toolIDs ?? [])].sort())
  const selectableToolIDs = createMemo(() => availableToolIDs().filter(isSelectableSubagentTool))
  const selectedToolCount = () => selectableToolIDs().filter((toolID) => toolEnabled(toolID)).length
  const updateDraft = (patch: Partial<SubagentProfile>) => setDraft((current) => ({ ...current, ...patch }))

  function toolEnabled(toolID: string) {
    const configured = draft().tools
    return configured === undefined || configured.includes(toolID)
  }

  function setToolEnabled(toolID: string, enabled: boolean) {
    const configured = new Set<string>(draft().tools ?? selectableToolIDs())
    if (enabled) configured.add(toolID)
    else configured.delete(toolID)
    updateDraft({ tools: [...configured] })
  }

  function resetEditor() {
    setCreating(false)
    setEditingID(undefined)
    setSkillCreating(false)
    setSkillError(undefined)
    setSkillName("")
    setSkillContent("")
  }

  function closeEditor() {
    if (saving() || skillBusy()) return
    resetEditor()
    setError(undefined)
  }

  function editProfile(profile: SubagentProfileView) {
    setCreating(false)
    setEditingID(profile.id)
    setDraft(draftFromProfile(profile))
    setError(undefined)
    setSkillError(undefined)
    setSkillCreating(false)
  }

  function startNew() {
    setCreating(true)
    setEditingID(undefined)
    setDraft({ ...defaultDraft })
    setError(undefined)
    setSkillError(undefined)
    setSkillCreating(false)
  }

  function askDelete(profile: SubagentProfileView) {
    if (deleteBusy()) return
    setDeletingID(profile.id)
    setDeleteError(undefined)
  }

  function closeDelete() {
    if (deleteBusy()) return
    setDeletingID(undefined)
    setDeleteError(undefined)
  }

  async function confirmDelete() {
    const roleID = deletingID()
    if (!roleID || deleteBusy()) return
    setDeleteBusy(true)
    setDeleteError(undefined)
    try {
      await props.onDelete(roleID)
      setSwitchOverrides((current) => {
        const nextOverrides = { ...current }
        delete nextOverrides[roleID]
        return nextOverrides
      })
      if (editingID() === roleID) resetEditor()
      setDeletingID(undefined)
    } catch (cause) {
      setDeleteError(cause instanceof Error && cause.message ? cause.message : tr("subagents.delete-failed"))
    } finally {
      setDeleteBusy(false)
    }
  }

  async function toggleProfile(profile: SubagentProfileView) {
    if (switchBusy()) return
    const enabled = !enabledFor(profile)
    const next = props.profiles.map((candidate) => {
      const value = draftFromProfile(candidate)
      return candidate.id === profile.id ? { ...value, enabled } : value
    })
    setSwitchBusy(profile.id)
    setError(undefined)
    try {
      await props.onSave(next)
      setSwitchOverrides((current) => ({ ...current, [profile.id]: enabled }))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setSwitchBusy(undefined)
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (saving()) return
    const value = draft()
    if (!value.id.trim() || !value.name.trim() || !value.description.trim()) {
      setError(tr("subagents.required-fields"))
      return
    }
    if (props.profiles.some((profile) => profile.id === value.id && profile.id !== editingID())) {
      setError(tr("subagents.duplicate-id"))
      return
    }
    const next = creating()
      ? [...props.profiles.map(draftFromProfile), value]
      : props.profiles.map((profile) => (profile.id === editingID() ? value : draftFromProfile(profile)))
    setSaving(true)
    setError(undefined)
    try {
      await props.onSave(next)
      setSwitchOverrides((current) => {
        const nextOverrides = { ...current }
        delete nextOverrides[value.id]
        return nextOverrides
      })
      resetEditor()
      setError(undefined)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setSaving(false)
    }
  }

  async function createSkill() {
    const roleID = editingID()
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
      await props.onRefresh()
    } catch (cause) {
      setSkillError(errorText(cause))
    } finally {
      setSkillBusy(false)
    }
  }

  async function refreshSkills() {
    if (skillRefreshing()) return
    setSkillRefreshing(true)
    setSkillError(undefined)
    try {
      await props.onRefresh()
    } catch (cause) {
      setSkillError(errorText(cause))
    } finally {
      setSkillRefreshing(false)
    }
  }

  return (
    <section class="subagent-profiles-panel" aria-label={tr("subagents.title")}>
      <header class="subagent-profiles-panel__header">
        <div>
          <p class="subagent-profiles-panel__eyebrow">{tr("subagents.eyebrow")}</p>
          <h2>{tr("subagents.title")}</h2>
          <p>{tr("subagents.enabled-count", { count: enabledCount(), total: props.profiles.length })}</p>
        </div>
        <Button size="small" onClick={startNew}>
          <Plus aria-hidden="true" />
          {tr("subagents.new")}
        </Button>
      </header>

      <Show when={props.loading}>
        <p class="subagent-profiles-panel__status">{tr("subagents.loading")}</p>
      </Show>
      <Show when={props.error}>{(message) => <InlineError message={message()} />}</Show>
      <Show when={!dialogOpen() && error()}>{(message) => <InlineError message={message()} />}</Show>

      <div class="subagent-profiles-panel__list" role="list" aria-label={tr("subagents.profiles")}>
        <Show
          when={props.profiles.length > 0}
          fallback={<p class="subagent-profiles-panel__status">{tr("subagents.empty")}</p>}
        >
          <For each={props.profiles}>
            {(profile) => (
              <article
                class="subagent-profile-row"
                role="listitem"
                data-enabled={enabledFor(profile) ? "true" : "false"}
              >
                <span class="subagent-profile-row__avatar">
                  <SubagentAvatar id={profile.avatar as SubagentAvatarID} />
                </span>
                <span class="subagent-profile-row__copy">
                  <strong>{profile.name}</strong>
                  <small>{profile.id}</small>
                  <span>{profile.description}</span>
                </span>
                <span class="subagent-profile-row__actions">
                  <button
                    type="button"
                    class="subagent-profile-row__switch"
                    role="switch"
                    aria-label={`${tr("subagents.enabled")} ${profile.name}`}
                    aria-checked={enabledFor(profile)}
                    data-active={enabledFor(profile) ? "true" : "false"}
                    disabled={Boolean(switchBusy())}
                    onClick={() => void toggleProfile(profile)}
                  >
                    <span aria-hidden="true" />
                  </button>
                  <IconButton
                    class="subagent-profile-row__edit"
                    label={`${tr("subagents.edit")} ${profile.name}`}
                    variant="ghost"
                    onClick={() => editProfile(profile)}
                  >
                    <Pencil aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    class="subagent-profile-row__delete"
                    label={`${tr("subagents.delete")} ${profile.name}`}
                    variant="ghost"
                    disabled={deleteBusy()}
                    onClick={() => askDelete(profile)}
                  >
                    <Trash2 aria-hidden="true" />
                  </IconButton>
                </span>
              </article>
            )}
          </For>
        </Show>
      </div>

      <Dialog
        open={dialogOpen()}
        title={draft().name || tr("subagents.untitled")}
        showClose
        onClose={closeEditor}
        class="subagent-profile-dialog"
      >
        <form class="subagent-profile-editor" aria-label={tr("subagents.editor")} onSubmit={save}>
          <div class="subagent-profile-editor__title">
            <div>
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
          <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
          <label>
            <span>{tr("subagents.id")}</span>
            <small class="subagent-profile-editor__field-hint">{tr("subagents.id-hint")}</small>
            <input
              aria-label={tr("subagents.id")}
              value={draft().id}
              disabled={!creating()}
              onInput={(event) => updateDraft({ id: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>{tr("subagents.name")}</span>
            <small class="subagent-profile-editor__field-hint">{tr("subagents.name-hint")}</small>
            <input
              aria-label={tr("subagents.name")}
              value={draft().name}
              onInput={(event) => updateDraft({ name: event.currentTarget.value })}
            />
          </label>
          <label>
            {tr("subagents.description")}
            <input
              aria-label={tr("subagents.description")}
              value={draft().description}
              onInput={(event) => updateDraft({ description: event.currentTarget.value })}
            />
          </label>
          <label>
            {tr("subagents.launch-prompt")}
            <textarea
              aria-label={tr("subagents.launch-prompt")}
              rows={4}
              value={draft().prompt}
              onInput={(event) => updateDraft({ prompt: event.currentTarget.value })}
            />
          </label>
          <div class="subagent-profile-editor__fields">
            <label>
              {tr("subagents.model")}
              <select
                aria-label={tr("subagents.model")}
                value={draft().model ?? ""}
                onChange={(event) => updateDraft({ model: event.currentTarget.value || undefined })}
              >
                <option value="">{tr("subagents.model-default")}</option>
                <For each={availableModels()}>{(option) => <option value={option.value}>{option.label}</option>}</For>
              </select>
            </label>
            <label>
              {tr("subagents.thinking-depth")}
              <select
                aria-label={tr("subagents.thinking-depth")}
                value={draft().variant ?? "default"}
                onChange={(event) =>
                  updateDraft({
                    variant: event.currentTarget.value === "default" ? undefined : event.currentTarget.value,
                  })
                }
              >
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
          <fieldset class="subagent-profile-editor__tools">
            <legend>{tr("subagents.tools")}</legend>
            <p>{tr("subagents.tools-hint")}</p>
            <Show when={props.toolIDs !== undefined} fallback={<p>{tr("subagents.tools-loading")}</p>}>
              <p class="subagent-profile-editor__tools-count">
                {tr("subagents.tools-count", { count: selectedToolCount(), total: selectableToolIDs().length })}
              </p>
              <p class="subagent-profile-editor__tools-section-title">{tr("subagents.tools-configurable")}</p>
              <div class="subagent-profile-editor__tool-list" aria-label={tr("subagents.tools-configurable")}>
                <For each={selectableToolIDs()}>
                  {(toolID) => (
                    <label class="subagent-tool-choice">
                      <input
                        type="checkbox"
                        aria-label={toolID}
                        checked={toolEnabled(toolID)}
                        onChange={(event) => setToolEnabled(toolID, event.currentTarget.checked)}
                      />
                      <span>{toolID}</span>
                    </label>
                  )}
                </For>
              </div>
            </Show>
          </fieldset>
          <Show when={editingProfile()}>
            {(profile) => (
              <section class="subagent-profile-skills" aria-label={tr("subagents.skills")}>
                <div class="subagent-profile-skills__header">
                  <div>
                    <h3>{tr("subagents.skills")}</h3>
                    <p>{tr("subagents.skill-directory", { role: profile().id })}</p>
                  </div>
                  <div class="subagent-profile-skills__actions">
                    <IconButton
                      class="subagent-profile-skills__refresh"
                      label={tr("subagents.refresh")}
                      variant="ghost"
                      disabled={skillRefreshing()}
                      onClick={() => void refreshSkills()}
                    >
                      <RefreshCw aria-hidden="true" />
                    </IconButton>
                    <Button size="small" variant="secondary" onClick={() => setSkillCreating(true)}>
                      {tr("subagents.new-skill")}
                    </Button>
                  </div>
                </div>
                <Show
                  when={profile().skills.length > 0}
                  fallback={<p class="subagent-profiles-panel__status">{tr("subagents.no-skills")}</p>}
                >
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
                <Show when={skillCreating()}>
                  <div class="subagent-skill-create">
                    <label>
                      {tr("subagents.skill-name")}
                      <input
                        aria-label={tr("subagents.skill-name")}
                        value={skillName()}
                        onInput={(event) => setSkillName(event.currentTarget.value)}
                      />
                    </label>
                    <label>
                      {tr("subagents.skill-content")}
                      <textarea
                        aria-label="SKILL.md"
                        rows={6}
                        value={skillContent()}
                        onInput={(event) => setSkillContent(event.currentTarget.value)}
                      />
                    </label>
                    <Button
                      type="button"
                      loading={skillBusy()}
                      loadingLabel={tr("subagents.creating-skill")}
                      onClick={() => void createSkill()}
                    >
                      {tr("subagents.create-skill")}
                    </Button>
                  </div>
                </Show>
              </section>
            )}
          </Show>
          <div class="subagent-profile-editor__actions">
            <Button type="submit" loading={saving()} loadingLabel={tr("subagents.saving")}>
              {tr("subagents.save")}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={deletingProfile() !== undefined}
        title={tr("subagents.delete")}
        description={deletingProfile() ? `${deletingProfile()!.name} · ${deletingProfile()!.id}` : undefined}
        showClose
        onClose={closeDelete}
        class="subagent-profile-delete-dialog"
        footer={
          <>
            <Button variant="ghost" onClick={closeDelete}>
              {tr("github.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={deleteBusy()}
              loadingLabel={tr("skills.processing")}
              onClick={() => void confirmDelete()}
            >
              {tr("mcp.confirm-deletion")}
            </Button>
          </>
        }
      >
        <Show when={deletingProfile()}>
          {(profile) => <p>{tr("subagents.delete-warning", { name: profile().name })}</p>}
        </Show>
        <Show when={deleteError()}>{(message) => <InlineError message={message()} />}</Show>
      </Dialog>
    </section>
  )
}

export function SubagentProfilesPanel(props: {
  directory: string
  models?: readonly CatalogModel[]
  onSaved?: () => void | Promise<void>
}) {
  const data = useData()
  const query = createQuery(
    () => ({
      ...subagentProfilesQueryOptions({ client: data.client(), directory: props.directory }),
      enabled: data.connection() === "connected",
    }),
    data.queryClient,
  )
  const toolQuery = createQuery(
    () => ({
      ...subagentToolIDsQueryOptions({ client: data.client(), directory: props.directory }),
      enabled: data.connection() === "connected",
    }),
    data.queryClient,
  )

  const save = async (profiles: readonly SubagentProfile[]) => {
    await updateSubagentProfiles({ client: data.client(), directory: props.directory, profiles })
    await query.refetch()
    await props.onSaved?.()
  }

  const createSkill = async (roleID: string, input: { name: string; content: string }) => {
    await createSubagentSkill({ client: data.client(), directory: props.directory, roleID, ...input })
    await refreshSubagentProfiles(data.queryClient(), props.directory)
    await query.refetch()
    await props.onSaved?.()
  }

  const remove = async (roleID: string) => {
    await deleteSubagentProfile({ client: data.client(), directory: props.directory, roleID })
    await refreshSubagentProfiles(data.queryClient(), props.directory)
    await query.refetch()
    await props.onSaved?.()
  }

  return (
    <SubagentProfilesPanelView
      profiles={query.data ?? []}
      toolIDs={toolQuery.data}
      models={props.models}
      loading={query.isPending}
      error={query.error ? errorText(query.error) : undefined}
      onSave={save}
      onDelete={remove}
      onCreateSkill={createSkill}
      onRefresh={() => query.refetch().then(() => undefined)}
    />
  )
}
