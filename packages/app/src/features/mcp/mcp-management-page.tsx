import { tr } from "../../i18n/i18n-context"
import type { McpStatus } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import type { ManagementContextValue } from "../management/management-context"
import { useManagement } from "../management/management-context"
import { errorMessage } from "../projects/project-controller"
import { McpConfigDialog } from "./mcp-config-dialog"
import { mcpStatusLabel } from "./mcp-control"
import { McpDeleteDialog } from "./mcp-delete-dialog"
import {
  managementMcpConfigQueryOptions,
  managementMcpStatusQueryOptions,
  mergeManagedMcp,
  refreshManagementMcp,
  type ManagedMcp,
  type McpConfig,
} from "./mcp-query"
import "./mcp-management.css"

export type McpManagementPageProps = {
  management?: ManagementContextValue
}

function endpoint(config: McpConfig) {
  if (config.type === "local") return config.command.join(" ")
  try {
    return new URL(config.url).host
  } catch {
    return config.url
  }
}

function statusText(status: McpStatus) {
  return mcpStatusLabel(status) ?? tr("mcp.connected")
}

export function McpManagementPage(props: McpManagementPageProps) {
  const management = props.management ?? useManagement()
  const config = createQuery(
    () => managementMcpConfigQueryOptions(management),
    () => management.queryClient,
  )
  const status = createQuery(
    () => managementMcpStatusQueryOptions(management),
    () => management.queryClient,
  )
  const entries = createMemo(() => mergeManagedMcp(config.data ?? {}, status.data ?? {}))
  const [editing, setEditing] = createSignal<ManagedMcp | "new">()
  const [deleting, setDeleting] = createSignal<string>()
  const [busyNames, setBusyNames] = createSignal<ReadonlySet<string>>(new Set())
  const [failure, setFailure] = createSignal<unknown>()

  const setBusy = (name: string, busy: boolean) => {
    setBusyNames((current) => {
      const next = new Set(current)
      if (busy) next.add(name)
      else next.delete(name)
      return next
    })
  }

  const run = async (name: string, action: () => Promise<unknown>, includeConfig = false) => {
    if (busyNames().has(name)) return
    setBusy(name, true)
    setFailure(undefined)
    try {
      await action()
      await refreshManagementMcp(management.queryClient, includeConfig)
    } catch (cause) {
      setFailure(cause)
      throw cause
    } finally {
      setBusy(name, false)
    }
  }

  const save = async (name: string, body: McpConfig) => {
    await run(
      name,
      () =>
        management.client.mcp.config.update({ directory: management.directory, name, body }, { throwOnError: true }),
      true,
    )
  }

  const remove = async (name: string) => {
    await run(
      name,
      () => management.client.mcp.config.delete({ directory: management.directory, name }, { throwOnError: true }),
      true,
    )
  }

  return (
    <main class="mcp-management">
      <header class="mcp-management__header">
        <div>
          <h1>MCP</h1>
          <p>{tr("mcp.manage-the-global-model-context-protocol-server")}</p>
        </div>
        <Button onClick={() => setEditing("new")}>{tr("mcp.add-mcp")}</Button>
      </header>

      <Show when={failure()} keyed>
        {(cause) => <InlineError message={errorMessage(cause, tr("mcp.mcp-operation-failed"))} />}
      </Show>

      <Show
        when={!config.isPending && !status.isPending}
        fallback={
          <p class="mcp-management__state" role="status">
            {tr("mcp.loading-mcp")}
          </p>
        }
      >
        <Show
          when={!config.error && !status.error}
          fallback={
            <div class="mcp-management__error">
              <InlineError message={errorMessage(config.error ?? status.error, tr("mcp.unable-to-load-mcp-configuration"))} />
              <Button variant="secondary" onClick={() => void Promise.all([config.refetch(), status.refetch()])}>
                {tr("changes.try-again")}
              </Button>
            </div>
          }
        >
          <Show when={entries().length} fallback={<p class="mcp-management__state">{tr("mcp.there-is-no-global-mcp-configuration-yet")}</p>}>
            <div class="mcp-management__list">
              <For each={entries()}>
                {(entry) => {
                  const busy = () => busyNames().has(entry.name)
                  const enabled = () => entry.config.enabled !== false
                  return (
                    <article class="mcp-management__item" data-status={entry.status.status}>
                      <div class="mcp-management__identity">
                        <strong>{entry.name}</strong>
                        <span class="mcp-management__type">{entry.config.type === "local" ? tr("mcp.local") : tr("mcp.remote")}</span>
                        <small>{endpoint(entry.config)}</small>
                      </div>
                      <span
                        class="mcp-management__status"
                        title={entry.status.status === "failed" ? entry.status.error : undefined}
                      >
                        {statusText(entry.status)}
                      </span>
                      <button
                        type="button"
                        class="mcp-management__switch"
                        role="switch"
                        aria-label={tr("mcp.enable-name", { name: entry.name })}
                        aria-checked={enabled()}
                        data-active={enabled() ? "true" : "false"}
                        disabled={busy()}
                        onClick={() =>
                          void save(entry.name, { ...entry.config, enabled: !enabled() }).catch(() => undefined)
                        }
                      >
                        <span aria-hidden="true" />
                      </button>
                      <div class="mcp-management__actions">
                        <Show when={entry.status.status === "failed"}>
                          <button
                            type="button"
                            aria-label={tr("mcp.retry-name", { name: entry.name })}
                            disabled={busy()}
                            onClick={() =>
                              void run(entry.name, () =>
                                management.client.mcp.connect(
                                  { directory: management.directory, name: entry.name },
                                  { throwOnError: true },
                                ),
                              ).catch(() => undefined)
                            }
                          >
                            {tr("changes.try-again")}
                          </button>
                        </Show>
                        <Show when={entry.config.type === "remote"}>
                          <button
                            type="button"
                            aria-label={tr("mcp.authenticate-name", { name: entry.name })}
                            disabled={busy()}
                            onClick={() =>
                              void run(entry.name, () =>
                                management.client.mcp.auth.authenticate(
                                  { directory: management.directory, name: entry.name },
                                  { throwOnError: true },
                                ),
                              ).catch(() => undefined)
                            }
                          >
                            {tr("mcp.certification")}
                          </button>
                          <button
                            type="button"
                            aria-label={tr("mcp.remove-auth-name", { name: entry.name })}
                            disabled={busy()}
                            onClick={() =>
                              void run(entry.name, () =>
                                management.client.mcp.auth.remove(
                                  { directory: management.directory, name: entry.name },
                                  { throwOnError: true },
                                ),
                              ).catch(() => undefined)
                            }
                          >
                            {tr("mcp.remove-certification")}
                          </button>
                        </Show>
                        <button
                          type="button"
                          aria-label={tr("mcp.edit-name", { name: entry.name })}
                          disabled={busy()}
                          onClick={() => setEditing(entry)}
                        >
                          {tr("github.edit")}
                        </button>
                        <button
                          type="button"
                          aria-label={tr("mcp.delete-name", { name: entry.name })}
                          disabled={busy()}
                          onClick={() => setDeleting(entry.name)}
                        >
                          {tr("mcp.delete")}
                        </button>
                      </div>
                    </article>
                  )
                }}
              </For>
            </div>
          </Show>
        </Show>
      </Show>

      <Show when={editing()} keyed>
        {(target) => (
          <McpConfigDialog
            initial={target === "new" ? undefined : target}
            onClose={() => setEditing(undefined)}
            onSave={save}
          />
        )}
      </Show>
      <Show when={deleting()} keyed>
        {(name) => <McpDeleteDialog name={name} onClose={() => setDeleting(undefined)} onDelete={() => remove(name)} />}
      </Show>
    </main>
  )
}
