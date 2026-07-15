import type { Provider } from "@jyycode-ai/sdk/v2/client"
import { ArrowLeft, KeyRound, PlugZap, Search } from "lucide-solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import type { DesktopClient } from "../../data/sdk"

type ProviderConnectClient = Pick<DesktopClient, "auth" | "instance" | "provider">

export function ProviderConnectButton(props: {
  client: ProviderConnectClient
  directory: string
  disabled?: boolean
  onConnected: (providerID: string) => void | Promise<void>
}) {
  const [opened, setOpened] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [providers, setProviders] = createSignal<Provider[]>([])
  const [selected, setSelected] = createSignal<Provider>()
  const [apiKey, setApiKey] = createSignal("")
  const [search, setSearch] = createSignal("")
  const [failure, setFailure] = createSignal<string>()
  const orderedProviders = createMemo(() => [...providers()].sort((left, right) => left.name.localeCompare(right.name)))
  const visibleProviders = createMemo(() => {
    const query = search().trim().toLowerCase()
    if (!query) return orderedProviders()
    return orderedProviders().filter(
      (provider) => provider.name.toLowerCase().includes(query) || provider.id.toLowerCase().includes(query),
    )
  })

  function close() {
    setOpened(false)
    setSelected(undefined)
    setApiKey("")
    setSearch("")
    setFailure(undefined)
  }

  async function open() {
    setOpened(true)
    setSelected(undefined)
    setApiKey("")
    setSearch("")
    setFailure(undefined)
    setLoading(true)
    try {
      const response = await props.client.provider.list({ directory: props.directory }, { throwOnError: true })
      setProviders(response.data?.all ?? [])
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "无法加载模型提供商")
    } finally {
      setLoading(false)
    }
  }

  function back() {
    if (selected()) {
      setSelected(undefined)
      setApiKey("")
      setFailure(undefined)
      return
    }
    close()
  }

  async function connect() {
    const provider = selected()
    const key = apiKey().trim()
    if (!provider || !key || saving()) return
    setSaving(true)
    setFailure(undefined)
    try {
      await props.client.auth.set({ providerID: provider.id, auth: { type: "api", key } }, { throwOnError: true })
      await props.client.instance.dispose({ directory: props.directory }, { throwOnError: true })
      await props.onConnected(provider.id)
      close()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "连接模型提供商失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="provider-connect">
      <Button
        class="composer-connect"
        size="small"
        variant="secondary"
        disabled={props.disabled}
        onClick={() => void open()}
      >
        <PlugZap aria-hidden="true" />
        连接
      </Button>
      <Dialog
        open={opened()}
        class="provider-connect-dialog"
        title={selected() ? `连接 ${selected()!.name}` : "连接模型提供商"}
        description={selected() ? "输入 API 密钥，凭据将安全保存在本机。" : "选择要连接的模型提供商。"}
        showClose
        onClose={close}
      >
        <Show when={selected()}>
          <Button class="provider-connect__back" size="small" variant="ghost" onClick={back}>
            <ArrowLeft aria-hidden="true" />
            返回提供商列表
          </Button>
        </Show>

        <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>

        <Show
          when={selected()}
          fallback={
            <Show when={!loading()} fallback={<p class="provider-connect__status">正在加载模型提供商…</p>}>
              <label class="provider-connect__search">
                <Search aria-hidden="true" />
                <input
                  type="search"
                  aria-label="搜索模型提供商"
                placeholder="搜索提供商名称或 ID"
                  value={search()}
                  onInput={(event) => setSearch(event.currentTarget.value)}
                />
              </label>
              <div class="provider-connect__list" aria-label="模型提供商">
                <For each={visibleProviders()}>
                  {(provider) => (
                    <button type="button" class="provider-connect__provider" onClick={() => setSelected(provider)}>
                      <span>{provider.name}</span>
                      <small>{provider.id}</small>
                    </button>
                  )}
                </For>
                <Show when={visibleProviders().length === 0}>
                  <p class="provider-connect__status">没有匹配的模型提供商</p>
                </Show>
              </div>
            </Show>
          }
        >
          {(provider) => (
            <form
              class="provider-connect__form"
              onSubmit={(event) => {
                event.preventDefault()
                void connect()
              }}
            >
              <label for="provider-api-key">API 密钥</label>
              <div class="provider-connect__key">
                <KeyRound aria-hidden="true" />
                <input
                  autofocus
                  id="provider-api-key"
                  type="password"
                  autocomplete="off"
                  placeholder={`${provider().name} API 密钥`}
                  value={apiKey()}
                  onInput={(event) => setApiKey(event.currentTarget.value)}
                />
              </div>
              <Button type="submit" loading={saving()} loadingLabel="正在连接" disabled={!apiKey().trim()}>
                连接
              </Button>
            </form>
          )}
        </Show>
      </Dialog>
    </div>
  )
}
