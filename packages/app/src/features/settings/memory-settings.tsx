import type { GlobalMemoryEntry } from "@jyycode-ai/sdk/v2/client"
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { ArrowLeft, ChevronRight, ClipboardList, Pencil, Trash2, UserRound } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Button, IconButton } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import { tr } from "../../i18n/i18n-context"
import { useDesktopBridge } from "../../platform/context"
import type { ManagementContextValue } from "../management/management-context"
import { useManagement } from "../management/management-context"
import { MemoryConfirmDialog } from "./memory-confirm-dialog"
import { MemoryEditor, type MemoryEditorValue } from "./memory-editor"
import { memorySettingsHref, sanitizeSettingsReturnTo, settingsHref } from "./settings-navigation"
import "./settings.css"

type Scope = "user" | "task"
type Confirmation =
  | { kind: "delete"; entry: GlobalMemoryEntry }
  | { kind: "compact" }
  | { kind: "clear" }

export function MemorySettings() {
  const [search] = useSearchParams<{ returnTo?: string }>()
  const returnTo = () => sanitizeSettingsReturnTo(search.returnTo)

  return (
    <section class="settings-card memory-settings-launcher" aria-labelledby="memory-settings-title">
      <h3 id="memory-settings-title">{tr("settings.memory-management")}</h3>
      <p class="settings-description">{tr("settings.memory-management-description")}</p>
      <div class="memory-settings-launcher__links">
        <A href={memorySettingsHref("user", returnTo())}>
          <UserRound aria-hidden="true" />
          <span>
            <strong>{tr("settings.user-memory")}</strong>
            <small>{tr("settings.user-memory-description")}</small>
          </span>
          <ChevronRight aria-hidden="true" />
        </A>
        <A href={memorySettingsHref("task", returnTo())}>
          <ClipboardList aria-hidden="true" />
          <span>
            <strong>{tr("settings.task-memory")}</strong>
            <small>{tr("settings.task-memory-description")}</small>
          </span>
          <ChevronRight aria-hidden="true" />
        </A>
      </div>
    </section>
  )
}

export function MemoryManagementPage(props: { management?: ManagementContextValue; scope?: Scope }) {
  const params = useParams<{ scope?: string }>()
  const [search] = useSearchParams<{ returnTo?: string }>()
  const navigate = useNavigate()
  const scope = (): Scope => props.scope ?? (params.scope === "task" ? "task" : "user")
  const returnTo = () => sanitizeSettingsReturnTo(search.returnTo)

  return (
    <main class="settings-page memory-page">
      <header class="settings-header">
        <Button variant="ghost" onClick={() => navigate(settingsHref("advanced", returnTo()))}>
          <ArrowLeft aria-hidden="true" />
          {tr("settings.return")}
        </Button>
        <h1>{scope() === "user" ? tr("settings.user-memory") : tr("settings.task-memory")}</h1>
      </header>
      <section class="settings-content memory-page__body">
        <div class="settings-sections">
          <MemoryManager scope={scope()} management={props.management} />
        </div>
      </section>
    </main>
  )
}

function MemoryManager(props: { scope: Scope; management?: ManagementContextValue }) {
  const management = props.management ?? useManagement()
  const desktop = useDesktopBridge()
  const [search, setSearch] = createSignal("")
  const [debouncedSearch, setDebouncedSearch] = createSignal("")
  const [editorOpen, setEditorOpen] = createSignal(false)
  const [editing, setEditing] = createSignal<GlobalMemoryEntry>()
  const [confirmation, setConfirmation] = createSignal<Confirmation>()
  const [failure, setFailure] = createSignal<string>()
  const [notice, setNotice] = createSignal<string>()

  createEffect(() => {
    const value = search()
    const timer = window.setTimeout(() => setDebouncedSearch(value.trim()), 250)
    onCleanup(() => window.clearTimeout(timer))
  })

  const query = createQuery(
    () => ({
      queryKey: keys.globalMemory(props.scope, "", debouncedSearch()),
      queryFn: async () => {
        const response = await management.client.global.memory.list(
          {
            scope: props.scope,
            ...(debouncedSearch() ? { query: debouncedSearch() } : {}),
            limit: "100",
          },
          { throwOnError: true },
        )
        if (!response.data) throw new Error(tr("settings.memory-load-error"))
        return response.data
      },
      refetchInterval: 1_000,
    }),
    () => management.queryClient,
  )
  const entries = createMemo(() =>
    [...(query.data?.entries ?? [])].sort((left, right) => (right.date ?? "").localeCompare(left.date ?? "")),
  )

  const invalidate = () => management.queryClient.invalidateQueries({ queryKey: keys.globalMemoryScope(props.scope) })

  function openCreate() {
    setEditing(undefined)
    setEditorOpen(true)
  }

  async function save(value: MemoryEditorValue) {
    const entry = editing()
    if (!entry) {
      await management.client.global.memory.user.create(value, { throwOnError: true })
    } else {
      await management.client.global.memory.update(
        {
          scope: entry.scope,
          id: entry.id,
          ...(entry.scope === "task" ? { sessionID: entry.sessionID } : {}),
          ...value,
        },
        { throwOnError: true },
      )
    }
    await invalidate()
    setNotice(tr("settings.memory-saved"))
  }

  async function confirm() {
    const current = confirmation()
    if (!current) return
    if (current.kind === "delete") {
      await management.client.global.memory.remove(
        {
          scope: current.entry.scope,
          id: current.entry.id,
          ...(current.entry.scope === "task" ? { sessionID: current.entry.sessionID } : {}),
        },
        { throwOnError: true },
      )
    } else if (current.kind === "clear") {
      await management.client.global.memory.task.clear({}, { throwOnError: true })
    } else {
      await management.client.global.memory.compact({ scope: props.scope }, { throwOnError: true })
    }
    await invalidate()
    setNotice(tr("settings.memory-operation-complete"))
  }

  async function exportMemory() {
    setFailure(undefined)
    setNotice(undefined)
    try {
      const response = await management.client.global.memory.export({ scope: props.scope }, { throwOnError: true })
      if (!response.data) throw new Error(tr("settings.memory-export-error"))
      const filename = `jyycode-memory-${props.scope}-${localDate(new Date())}.json`
      const result = await desktop.saveTextFile(filename, `${JSON.stringify(response.data, null, 2)}\n`)
      if (!result.supported) throw new Error(result.reason ?? tr("settings.memory-export-error"))
      if (result.saved) setNotice(tr("settings.memory-exported"))
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : tr("settings.memory-export-error"))
    }
  }

  const confirmCopy = createMemo(() => {
    const current = confirmation()
    if (current?.kind === "delete") return {
      title: tr("settings.delete-memory"),
      description: tr("settings.delete-memory-description"),
      label: tr("settings.confirm-delete-memory"),
      danger: true,
    }
    if (current?.kind === "clear") return {
      title: tr("settings.clear-task-memory"),
      description: tr("settings.clear-task-memory-description"),
      label: tr("settings.confirm-clear-memory"),
      danger: true,
    }
    return {
      title: tr("settings.compact-memory"),
      description: tr("settings.compact-memory-description"),
      label: tr("settings.confirm-compact-memory"),
      danger: false,
    }
  })

  return (
    <section class="settings-card memory-settings" aria-labelledby="memory-manager-title">
      <header class="memory-settings__header">
        <div>
          <h3 id="memory-manager-title">{tr("settings.manage-memory")}</h3>
          <p class="settings-description">
            {props.scope === "user" ? tr("settings.user-memory-description") : tr("settings.task-memory-description")}
          </p>
        </div>
        <span>{tr("settings.memory-entry-count", { count: query.data?.total ?? 0 })}</span>
      </header>

      <label class="memory-settings__search">
        <span>{tr("settings.search-memory")}</span>
        <input type="search" aria-label={tr("settings.search-memory")} value={search()} onInput={(event) => setSearch(event.currentTarget.value)} />
      </label>

      <div class="memory-settings__actions">
        <Show when={props.scope === "user"}><Button onClick={openCreate}>{tr("settings.add-user-memory")}</Button></Show>
        <Button variant="secondary" onClick={() => setConfirmation({ kind: "compact" })}>{tr("settings.compact-memory")}</Button>
        <Show when={props.scope === "task"}><Button variant="danger" onClick={() => setConfirmation({ kind: "clear" })}>{tr("settings.clear-task-memory")}</Button></Show>
        <Button variant="secondary" onClick={() => void exportMemory()}>{tr("settings.export-memory")}</Button>
      </div>

      <Show when={query.isPending}><p class="settings-saving" role="status">{tr("settings.loading-memory")}</p></Show>
      <Show when={query.error}><InlineError message={query.error instanceof Error ? query.error.message : tr("settings.memory-load-error")} /></Show>
      <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
      <Show when={notice()}>{(message) => <p class="compaction-settings__notice" role="status">{message()}</p>}</Show>

      <div class="memory-settings__list">
        <For each={entries()}>
          {(entry) => (
            <article class="memory-settings__entry">
              <header class="memory-settings__entry-header">
                <strong>{entry.keywords.join(" · ")}</strong>
                <div class="memory-settings__entry-aside">
                  <span class="memory-settings__entry-date">
                    <Show when={entry.date} fallback={tr("settings.memory-date-unknown")}>
                      {(date) => <time dateTime={date()}>{formatMemoryDate(date())}</time>}
                    </Show>
                  </span>
                  <span>{tr("settings.memory-importance-value", { value: entry.importance })}</span>
                  <div class="memory-settings__entry-actions">
                    <IconButton
                      class="memory-settings__entry-action"
                      variant="ghost"
                      label={tr("settings.edit-memory")}
                      title={tr("settings.edit-memory")}
                      onClick={() => { setEditing(entry); setEditorOpen(true) }}
                    >
                      <Pencil aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      class="memory-settings__entry-action memory-settings__entry-action--danger"
                      variant="ghost"
                      label={tr("settings.delete-memory")}
                      title={tr("settings.delete-memory")}
                      onClick={() => setConfirmation({ kind: "delete", entry })}
                    >
                      <Trash2 aria-hidden="true" />
                    </IconButton>
                  </div>
                </div>
              </header>
              <p>{entry.content}</p>
            </article>
          )}
        </For>
        <Show when={!query.isPending && !query.error && (query.data?.entries.length ?? 0) === 0}>
          <p class="memory-settings__empty">{tr("settings.no-memory-entries")}</p>
        </Show>
      </div>

      <MemoryEditor open={editorOpen()} entry={editing()} onClose={() => setEditorOpen(false)} onSave={save} />
      <MemoryConfirmDialog
        open={Boolean(confirmation())}
        title={confirmCopy().title}
        description={confirmCopy().description}
        confirmLabel={confirmCopy().label}
        danger={confirmCopy().danger}
        onClose={() => setConfirmation(undefined)}
        onConfirm={confirm}
      />
    </section>
  )
}

function localDate(date: Date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`
}

function formatMemoryDate(value: string) {
  if (!/^\d{8}$/u.test(value)) return value
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}
