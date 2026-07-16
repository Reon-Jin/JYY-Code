import type { GlobalMemoryEntry } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import { tr } from "../../i18n/i18n-context"
import { useDesktopBridge } from "../../platform/context"
import type { ManagementContextValue } from "../management/management-context"
import { useManagement } from "../management/management-context"
import { MemoryConfirmDialog } from "./memory-confirm-dialog"
import { MemoryEditor, type MemoryEditorValue } from "./memory-editor"

type Scope = "user" | "task"
type Confirmation =
  | { kind: "delete"; entry: GlobalMemoryEntry }
  | { kind: "compact" }
  | { kind: "clear" }

export function MemorySettings(props: { management?: ManagementContextValue }) {
  const management = props.management ?? useManagement()
  const desktop = useDesktopBridge()
  const [scope, setScope] = createSignal<Scope>("user")
  const [sessionID, setSessionID] = createSignal("")
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

  const ready = () => scope() === "user" || Boolean(sessionID().trim())
  const queryKey = () => keys.globalMemory(scope(), sessionID().trim(), debouncedSearch())
  const query = createQuery(
    () => ({
      queryKey: queryKey(),
      enabled: ready(),
      queryFn: async () => {
        const response = await management.client.global.memory.list(
          {
            scope: scope(),
            ...(scope() === "task" ? { sessionID: sessionID().trim() } : {}),
            ...(debouncedSearch() ? { query: debouncedSearch() } : {}),
            limit: "100",
          },
          { throwOnError: true },
        )
        if (!response.data) throw new Error(tr("settings.memory-load-error"))
        return response.data
      },
    }),
    () => management.queryClient,
  )

  const invalidate = () => management.queryClient.invalidateQueries({ queryKey: keys.globalMemoryScope(scope(), sessionID().trim()) })

  function changeScope(next: Scope) {
    setScope(next)
    setSearch("")
    setDebouncedSearch("")
    setFailure(undefined)
    setNotice(undefined)
  }

  function openCreate() {
    setEditing(undefined)
    setEditorOpen(true)
  }

  function openEdit(entry: GlobalMemoryEntry) {
    setEditing(entry)
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
      await management.client.global.memory.task.clear({ sessionID: sessionID().trim() }, { throwOnError: true })
    } else {
      await management.client.global.memory.compact(
        { scope: scope(), sessionID: scope() === "task" ? sessionID().trim() : undefined },
        { throwOnError: true },
      )
    }
    await invalidate()
    setNotice(tr("settings.memory-operation-complete"))
  }

  async function exportMemory() {
    setFailure(undefined)
    setNotice(undefined)
    try {
      const response = await management.client.global.memory.export(
        { scope: scope(), sessionID: scope() === "task" ? sessionID().trim() : undefined },
        { throwOnError: true },
      )
      if (!response.data) throw new Error(tr("settings.memory-export-error"))
      const date = localDate(new Date())
      const taskName = sessionID().trim().replace(/[^A-Za-z0-9_-]/gu, "-")
      const filename = scope() === "user"
        ? `jyycode-memory-user-${date}.json`
        : `jyycode-memory-task-${taskName}-${date}.json`
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
    <section class="settings-card memory-settings" aria-labelledby="memory-settings-title">
      <header class="memory-settings__header">
        <div>
          <h3 id="memory-settings-title">{tr("settings.memory-management")}</h3>
          <p class="settings-description">{tr("settings.memory-management-description")}</p>
        </div>
        <span>{tr("settings.memory-entry-count", { count: query.data?.total ?? 0 })}</span>
      </header>

      <div class="memory-settings__tabs" role="tablist" aria-label={tr("settings.memory-scope")}>
        <Button variant={scope() === "user" ? "primary" : "ghost"} role="tab" aria-selected={scope() === "user"} onClick={() => changeScope("user")}>{tr("settings.user-memory")}</Button>
        <Button variant={scope() === "task" ? "primary" : "ghost"} role="tab" aria-selected={scope() === "task"} onClick={() => changeScope("task")}>{tr("settings.task-memory")}</Button>
      </div>

      <Show when={scope() === "task"}>
        <label class="memory-settings__session">
          <span>{tr("settings.session-id")}</span>
          <input aria-label={tr("settings.session-id")} value={sessionID()} onInput={(event) => setSessionID(event.currentTarget.value)} placeholder="ses_..." />
        </label>
      </Show>

      <label class="memory-settings__search">
        <span>{tr("settings.search-memory")}</span>
        <input type="search" aria-label={tr("settings.search-memory")} value={search()} disabled={!ready()} onInput={(event) => setSearch(event.currentTarget.value)} />
      </label>

      <div class="memory-settings__actions">
        <Show when={scope() === "user"}><Button onClick={openCreate}>{tr("settings.add-user-memory")}</Button></Show>
        <Button variant="secondary" disabled={!ready()} onClick={() => setConfirmation({ kind: "compact" })}>{tr("settings.compact-memory")}</Button>
        <Show when={scope() === "task"}><Button variant="danger" disabled={!ready()} onClick={() => setConfirmation({ kind: "clear" })}>{tr("settings.clear-task-memory")}</Button></Show>
        <Button variant="secondary" disabled={!ready()} onClick={() => void exportMemory()}>{tr("settings.export-memory")}</Button>
      </div>

      <Show when={!ready()}><p class="memory-settings__empty">{tr("settings.enter-session-id-first")}</p></Show>
      <Show when={ready() && query.isPending}><p class="settings-saving" role="status">{tr("settings.loading-memory")}</p></Show>
      <Show when={query.error}><InlineError message={query.error instanceof Error ? query.error.message : tr("settings.memory-load-error")} /></Show>
      <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
      <Show when={notice()}>{(message) => <p class="compaction-settings__notice" role="status">{message()}</p>}</Show>

      <div class="memory-settings__list">
        <For each={ready() ? query.data?.entries ?? [] : []}>
          {(entry) => (
            <article class="memory-settings__entry">
              <div class="memory-settings__entry-meta">
                <strong>{entry.keywords.join(" · ")}</strong>
                <span>{tr("settings.memory-importance-value", { value: entry.importance })}</span>
              </div>
              <p>{entry.content}</p>
              <div class="memory-settings__entry-actions">
                <Button size="small" variant="secondary" aria-label={tr("settings.edit-memory")} onClick={() => openEdit(entry)}>{tr("settings.edit-memory")}</Button>
                <Button size="small" variant="danger" aria-label={tr("settings.delete-memory")} onClick={() => setConfirmation({ kind: "delete", entry })}>{tr("settings.delete-memory")}</Button>
              </div>
            </article>
          )}
        </For>
        <Show when={ready() && !query.isPending && !query.error && (query.data?.entries.length ?? 0) === 0}>
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
