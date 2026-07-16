import { tr } from "../../i18n/i18n-context"
import type { McpLocalConfig, McpOAuthConfig, McpRemoteConfig } from "@jyycode-ai/sdk/v2/client"
import { createSignal, Index, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import { errorMessage } from "../projects/project-controller"
import { KeyValueEditor, type KeyValueRow } from "./key-value-editor"
import type { ManagedMcp, McpConfig } from "./mcp-query"

export type McpConfigDialogProps = {
  initial?: ManagedMcp
  onClose: () => void
  onSave: (name: string, config: McpConfig) => Promise<void>
}

type OAuthMode = "auto" | "disabled" | "configured"

const rowsFromRecord = (value?: Record<string, string>): KeyValueRow[] =>
  Object.entries(value ?? {}).map(([key, entry]) => ({ key, value: entry }))

const recordFromRows = (rows: KeyValueRow[]) =>
  Object.fromEntries(rows.map((row) => [row.key.trim(), row.value] as const).filter(([key]) => key))

export function McpConfigDialog(props: McpConfigDialogProps) {
  const local = () => (props.initial?.config.type === "local" ? props.initial.config : undefined)
  const remote = () => (props.initial?.config.type === "remote" ? props.initial.config : undefined)
  const initialOAuth = () => remote()?.oauth
  const initialOAuthConfig = (): McpOAuthConfig | undefined => {
    const oauth = initialOAuth()
    return oauth && typeof oauth === "object" ? oauth : undefined
  }

  const [name, setName] = createSignal(props.initial?.name ?? "")
  const [type, setType] = createSignal<"local" | "remote">(props.initial?.config.type ?? "local")
  const [executable, setExecutable] = createSignal(local()?.command[0] ?? "")
  const [argumentsList, setArgumentsList] = createSignal(local()?.command.slice(1) ?? [""])
  const [environment, setEnvironment] = createSignal(rowsFromRecord(local()?.environment))
  const [url, setUrl] = createSignal(remote()?.url ?? "")
  const [headers, setHeaders] = createSignal(rowsFromRecord(remote()?.headers))
  const [enabled, setEnabled] = createSignal(props.initial?.config.enabled !== false)
  const [timeout, setTimeoutValue] = createSignal(String(props.initial?.config.timeout ?? ""))
  const [oauthMode, setOAuthMode] = createSignal<OAuthMode>(
    initialOAuth() === false ? "disabled" : initialOAuthConfig() ? "configured" : "auto",
  )
  const [clientId, setClientId] = createSignal(initialOAuthConfig()?.clientId ?? "")
  const [clientSecret, setClientSecret] = createSignal("")
  const [scope, setScope] = createSignal(initialOAuthConfig()?.scope ?? "")
  const [callbackPort, setCallbackPort] = createSignal(String(initialOAuthConfig()?.callbackPort ?? ""))
  const [redirectUri, setRedirectUri] = createSignal(initialOAuthConfig()?.redirectUri ?? "")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<unknown>()

  const optionalNumber = (value: string) => (value.trim() ? Number(value) : undefined)
  const optionalText = (value: string) => value.trim() || undefined

  const buildConfig = (): McpConfig => {
    const common = { enabled: enabled(), timeout: optionalNumber(timeout()) }
    if (type() === "local") {
      const command = [
        executable().trim(),
        ...argumentsList()
          .map((value) => value.trim())
          .filter(Boolean),
      ]
      if (!command[0]) throw new Error(tr("mcp.please-enter-the-executable-command"))
      const values = recordFromRows(environment())
      return {
        type: "local",
        command,
        environment: Object.keys(values).length ? values : undefined,
        ...common,
      } satisfies McpLocalConfig
    }

    if (!url().trim()) throw new Error(tr("mcp.please-enter-the-remote-server-url"))
    const values = recordFromRows(headers())
    let oauth: McpRemoteConfig["oauth"]
    if (oauthMode() === "disabled") oauth = false
    if (oauthMode() === "configured") {
      const originalSecret = initialOAuthConfig()?.clientSecret
      oauth = {
        clientId: optionalText(clientId()),
        clientSecret: optionalText(clientSecret()) ?? originalSecret,
        scope: optionalText(scope()),
        callbackPort: optionalNumber(callbackPort()),
        redirectUri: optionalText(redirectUri()),
      }
    }
    return {
      type: "remote",
      url: url().trim(),
      headers: Object.keys(values).length ? values : undefined,
      oauth,
      ...common,
    } satisfies McpRemoteConfig
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setFailure(undefined)
    setBusy(true)
    try {
      const serverName = name().trim()
      if (!serverName) throw new Error(tr("mcp.please-enter-mcp-name"))
      await props.onSave(serverName, buildConfig())
      props.onClose()
    } catch (cause) {
      setFailure(cause)
    } finally {
      setBusy(false)
    }
  }

  const updateArgument = (index: number, value: string) => {
    setArgumentsList((current) => current.map((entry, position) => (position === index ? value : entry)))
  }

  return (
    <Dialog
      open
      class="mcp-config-dialog"
      title={props.initial ? tr("mcp.edit-mcp-name", { name: props.initial.name }) : tr("mcp.add-mcp")}
      description={tr("mcp.the-configuration-is-saved-to-the-global-management")}
      showClose
      onClose={props.onClose}
    >
      <form class="mcp-config-form" onSubmit={(event) => void submit(event)}>
        <Show when={failure()} keyed>
          {(cause) => <InlineError message={errorMessage(cause, tr("mcp.unable-to-save-mcp-configuration"))} />}
        </Show>
        <label>
          <span>{tr("mcp.name")}</span>
          <input
            value={name()}
            disabled={Boolean(props.initial)}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>{tr("mcp.type")}</span>
          <select
            value={type()}
            disabled={Boolean(props.initial)}
            onChange={(event) => setType(event.currentTarget.value as "local" | "remote")}
          >
            <option value="local">{tr("mcp.local")}</option>
            <option value="remote">{tr("mcp.remote")}</option>
          </select>
        </label>

        <Show when={type() === "local"}>
          <label>
            <span>{tr("mcp.executable-commands")}</span>
            <input value={executable()} onInput={(event) => setExecutable(event.currentTarget.value)} />
          </label>
          <fieldset>
            <legend>{tr("mcp.parameter")}</legend>
            <Index each={argumentsList()}>
              {(argument, index) => (
                <div class="mcp-config-form__argument">
                  <label>
                    <span>{tr("mcp.parameter")} {index + 1}</span>
                    <input value={argument()} onInput={(event) => updateArgument(index, event.currentTarget.value)} />
                  </label>
                  <button
                    type="button"
                    aria-label={tr("mcp.delete-argument-index", { index: index + 1 })}
                    onClick={() => setArgumentsList((current) => current.filter((_, position) => position !== index))}
                  >
                    {tr("mcp.delete")}
                  </button>
                </div>
              )}
            </Index>
            <button type="button" onClick={() => setArgumentsList((current) => [...current, ""])}>
              {tr("mcp.add-parameters")}
            </button>
          </fieldset>
          <fieldset>
            <legend>{tr("mcp.environment-variables")}</legend>
            <KeyValueEditor rows={environment()} name={tr("mcp.environment-variables")} addLabel={tr("mcp.add-environment-variables")} onChange={setEnvironment} />
          </fieldset>
        </Show>

        <Show when={type() === "remote"}>
          <label>
            <span>URL</span>
            <input type="url" value={url()} onInput={(event) => setUrl(event.currentTarget.value)} />
          </label>
          <fieldset>
            <legend>{tr("mcp.request-header")}</legend>
            <KeyValueEditor rows={headers()} name={tr("mcp.request-header")} addLabel={tr("mcp.add-request-header")} onChange={setHeaders} />
          </fieldset>
          <label>
            <span>{tr("mcp.oauth-pattern")}</span>
            <select value={oauthMode()} onChange={(event) => setOAuthMode(event.currentTarget.value as OAuthMode)}>
              <option value="auto">{tr("mcp.automatic-detection")}</option>
              <option value="disabled">{tr("mcp.disable-oauth")}</option>
              <option value="configured">{tr("mcp.custom-oauth")}</option>
            </select>
          </label>
          <Show when={oauthMode() === "configured"}>
            <label>
              <span>{tr("mcp.client-id")}</span>
              <input value={clientId()} onInput={(event) => setClientId(event.currentTarget.value)} />
            </label>
            <label>
              <span>{tr("mcp.client-key")}</span>
              <input
                type="password"
                autocomplete="new-password"
                value={clientSecret()}
                placeholder={initialOAuthConfig()?.clientSecret ? tr("mcp.keep-existing-keys") : undefined}
                onInput={(event) => setClientSecret(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>Scope</span>
              <input value={scope()} onInput={(event) => setScope(event.currentTarget.value)} />
            </label>
            <label>
              <span>{tr("mcp.callback-port")}</span>
              <input
                type="number"
                min="1"
                max="65535"
                value={callbackPort()}
                onInput={(event) => setCallbackPort(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>{tr("mcp.redirect-uri")}</span>
              <input type="url" value={redirectUri()} onInput={(event) => setRedirectUri(event.currentTarget.value)} />
            </label>
          </Show>
        </Show>

        <div class="mcp-config-form__row">
          <label class="mcp-config-form__check">
            <input type="checkbox" checked={enabled()} onChange={(event) => setEnabled(event.currentTarget.checked)} />
            <span>{tr("mcp.enable")}</span>
          </label>
          <label>
            <span>{tr("mcp.timeout-milliseconds")}</span>
            <input
              type="number"
              min="0"
              value={timeout()}
              onInput={(event) => setTimeoutValue(event.currentTarget.value)}
            />
          </label>
        </div>
        <div class="mcp-config-form__actions">
          <Button variant="secondary" disabled={busy()} onClick={props.onClose}>
            {tr("github.cancel")}
          </Button>
          <Button type="submit" loading={busy()} loadingLabel={tr("mcp.saving")}>
            {tr("github.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
