import { tr } from "../../i18n/i18n-context"
import type { PublicProvider } from "@jyycode-ai/sdk/v2/client"
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
  const [providers, setProviders] = createSignal<PublicProvider[]>([])
  const [selected, setSelected] = createSignal<PublicProvider>()
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
      setFailure(cause instanceof Error ? cause.message : tr("composer.unable-to-load-model-provider"))
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
      setFailure(cause instanceof Error ? cause.message : tr("composer.failed-to-connect-to-model-provider"))
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
        {tr("composer.connect")}
      </Button>
      <Dialog
        open={opened()}
        class="provider-connect-dialog"
        title={
          selected()
            ? tr("composer.connect-provider-name", { name: selected()!.name })
            : tr("composer.connect-model-provider")
        }
        description={
          selected()
            ? tr("composer.enter-your-api-key-and-your-credentials-will")
            : tr("composer.select-the-model-provider-to-connect-to")
        }
        showClose
        onClose={close}
      >
        <Show when={selected()}>
          <Button class="provider-connect__back" size="small" variant="ghost" onClick={back}>
            <ArrowLeft aria-hidden="true" />
            {tr("composer.return-to-provider-list")}
          </Button>
        </Show>

        <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>

        <Show
          when={selected()}
          fallback={
            <Show
              when={!loading()}
              fallback={<p class="provider-connect__status">{tr("composer.loading-model-providers")}</p>}
            >
              <label class="provider-connect__search">
                <Search aria-hidden="true" />
                <input
                  type="search"
                  aria-label={tr("composer.search-model-providers")}
                  placeholder={tr("composer.search-provider-name-or-id")}
                  value={search()}
                  onInput={(event) => setSearch(event.currentTarget.value)}
                />
              </label>
              <div class="provider-connect__list" aria-label={tr("composer.model-provider")}>
                <For each={visibleProviders()}>
                  {(provider) => (
                    <button type="button" class="provider-connect__provider" onClick={() => setSelected(provider)}>
                      <span>{provider.name}</span>
                      <small>{provider.id}</small>
                    </button>
                  )}
                </For>
                <Show when={visibleProviders().length === 0}>
                  <p class="provider-connect__status">{tr("composer.no-matching-model-provider")}</p>
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
              <label for="provider-api-key">{tr("composer.api-key")}</label>
              <div class="provider-connect__key">
                <KeyRound aria-hidden="true" />
                <input
                  autofocus
                  id="provider-api-key"
                  type="password"
                  autocomplete="off"
                  placeholder={tr("composer.provider-api-key", { name: provider().name })}
                  value={apiKey()}
                  onInput={(event) => setApiKey(event.currentTarget.value)}
                />
              </div>
              <Button
                type="submit"
                loading={saving()}
                loadingLabel={tr("composer.connecting")}
                disabled={!apiKey().trim()}
              >
                {tr("composer.connect")}
              </Button>
            </form>
          )}
        </Show>
      </Dialog>
    </div>
  )
}
