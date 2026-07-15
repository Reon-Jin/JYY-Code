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
      if (!command[0]) throw new Error("请输入可执行命令")
      const values = recordFromRows(environment())
      return {
        type: "local",
        command,
        environment: Object.keys(values).length ? values : undefined,
        ...common,
      } satisfies McpLocalConfig
    }

    if (!url().trim()) throw new Error("请输入远程服务器 URL")
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
      if (!serverName) throw new Error("请输入 MCP 名称")
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
      title={props.initial ? `编辑 MCP ${props.initial.name}` : "添加 MCP"}
      description="配置会保存到全局管理目录，并用于所有桌面项目。"
      showClose
      onClose={props.onClose}
    >
      <form class="mcp-config-form" onSubmit={(event) => void submit(event)}>
        <Show when={failure()} keyed>
          {(cause) => <InlineError message={errorMessage(cause, "无法保存 MCP 配置")} />}
        </Show>
        <label>
          <span>名称</span>
          <input
            value={name()}
            disabled={Boolean(props.initial)}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>类型</span>
          <select
            value={type()}
            disabled={Boolean(props.initial)}
            onChange={(event) => setType(event.currentTarget.value as "local" | "remote")}
          >
            <option value="local">本地</option>
            <option value="remote">远程</option>
          </select>
        </label>

        <Show when={type() === "local"}>
          <label>
            <span>可执行命令</span>
            <input value={executable()} onInput={(event) => setExecutable(event.currentTarget.value)} />
          </label>
          <fieldset>
            <legend>参数</legend>
            <Index each={argumentsList()}>
              {(argument, index) => (
                <div class="mcp-config-form__argument">
                  <label>
                    <span>参数 {index + 1}</span>
                    <input value={argument()} onInput={(event) => updateArgument(index, event.currentTarget.value)} />
                  </label>
                  <button
                    type="button"
                    aria-label={`删除参数 ${index + 1}`}
                    onClick={() => setArgumentsList((current) => current.filter((_, position) => position !== index))}
                  >
                    删除
                  </button>
                </div>
              )}
            </Index>
            <button type="button" onClick={() => setArgumentsList((current) => [...current, ""])}>
              添加参数
            </button>
          </fieldset>
          <fieldset>
            <legend>环境变量</legend>
            <KeyValueEditor rows={environment()} name="环境变量" addLabel="添加环境变量" onChange={setEnvironment} />
          </fieldset>
        </Show>

        <Show when={type() === "remote"}>
          <label>
            <span>URL</span>
            <input type="url" value={url()} onInput={(event) => setUrl(event.currentTarget.value)} />
          </label>
          <fieldset>
            <legend>请求头</legend>
            <KeyValueEditor rows={headers()} name="请求头" addLabel="添加请求头" onChange={setHeaders} />
          </fieldset>
          <label>
            <span>OAuth 模式</span>
            <select value={oauthMode()} onChange={(event) => setOAuthMode(event.currentTarget.value as OAuthMode)}>
              <option value="auto">自动检测</option>
              <option value="disabled">禁用 OAuth</option>
              <option value="configured">自定义 OAuth</option>
            </select>
          </label>
          <Show when={oauthMode() === "configured"}>
            <label>
              <span>客户端 ID</span>
              <input value={clientId()} onInput={(event) => setClientId(event.currentTarget.value)} />
            </label>
            <label>
              <span>客户端密钥</span>
              <input
                type="password"
                autocomplete="new-password"
                value={clientSecret()}
                placeholder={initialOAuthConfig()?.clientSecret ? "保留现有密钥" : undefined}
                onInput={(event) => setClientSecret(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>Scope</span>
              <input value={scope()} onInput={(event) => setScope(event.currentTarget.value)} />
            </label>
            <label>
              <span>回调端口</span>
              <input
                type="number"
                min="1"
                max="65535"
                value={callbackPort()}
                onInput={(event) => setCallbackPort(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>重定向 URI</span>
              <input type="url" value={redirectUri()} onInput={(event) => setRedirectUri(event.currentTarget.value)} />
            </label>
          </Show>
        </Show>

        <div class="mcp-config-form__row">
          <label class="mcp-config-form__check">
            <input type="checkbox" checked={enabled()} onChange={(event) => setEnabled(event.currentTarget.checked)} />
            <span>启用</span>
          </label>
          <label>
            <span>超时（毫秒）</span>
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
            取消
          </Button>
          <Button type="submit" loading={busy()} loadingLabel="保存中">
            保存
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
