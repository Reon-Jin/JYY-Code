import type { McpStatus } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { createQuery } from "@tanstack/solid-query"
import { Plug } from "lucide-solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import type { DesktopClient } from "../../data/sdk"
import { errorMessage } from "../projects/project-controller"
import "./mcp-control.css"

export type McpControlProps = {
  client: Pick<DesktopClient, "mcp">
  queryClient: QueryClient
  directory: string
  disabled?: boolean
}

export function mcpStatusLabel(status: McpStatus) {
  switch (status.status) {
    case "connected":
      return undefined
    case "disabled":
      return "已关闭"
    case "failed":
      return "连接失败"
    case "needs_auth":
      return "需要认证"
    case "needs_client_registration":
      return "需要注册客户端"
  }
}

export function McpControl(props: McpControlProps) {
  const [open, setOpen] = createSignal(false)
  const [busyName, setBusyName] = createSignal<string>()
  const [failure, setFailure] = createSignal<unknown>()
  const status = createQuery(
    () => ({
      queryKey: keys.mcp(props.directory),
      enabled: open(),
      queryFn: async () => {
        const result = await props.client.mcp.status({ directory: props.directory }, { throwOnError: true })
        return result.data ?? {}
      },
    }),
    () => props.queryClient,
  )
  const entries = createMemo(() =>
    Object.entries(status.data ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  )

  async function toggle(name: string, current: McpStatus) {
    if (busyName() || props.disabled) return
    setBusyName(name)
    setFailure(undefined)
    try {
      if (current.status === "connected") {
        await props.client.mcp.disconnect({ directory: props.directory, name }, { throwOnError: true })
      } else {
        await props.client.mcp.connect({ directory: props.directory, name }, { throwOnError: true })
      }
      await status.refetch()
    } catch (cause) {
      setFailure(cause)
    } finally {
      setBusyName(undefined)
    }
  }

  return (
    <>
      <Button
        size="small"
        variant="secondary"
        class="mcp-control__button"
        disabled={props.disabled}
        aria-label="MCP"
        onClick={() => {
          setFailure(undefined)
          setOpen(true)
        }}
      >
        <Plug aria-hidden="true" />
        MCP
      </Button>
      <Dialog
        open={open()}
        class="mcp-control__dialog"
        title="MCP 插件"
        description="启用或关闭当前项目中已安装的 MCP 插件。"
        showClose
        onClose={() => setOpen(false)}
      >
        <Show when={failure()} keyed>
          {(cause) => <InlineError message={errorMessage(cause, "无法更新 MCP 插件")} />}
        </Show>
        <Show when={!status.isPending} fallback={<p class="mcp-control__status">正在加载 MCP 插件…</p>}>
          <Show
            when={!status.error}
            fallback={<InlineError message={errorMessage(status.error, "无法加载 MCP 插件")} />}
          >
            <Show
              when={entries().length > 0}
              fallback={<p class="mcp-control__status">当前项目没有已安装的 MCP 插件。</p>}
            >
              <div class="mcp-control__list">
                <For each={entries()}>
                  {([name, current]) => {
                    const enabled = () => current.status === "connected"
                    return (
                      <div class="mcp-control__item">
                        <span>
                          <strong>{name}</strong>
                          <Show when={mcpStatusLabel(current)}>
                            {(label) => <small data-status={current.status}>{label()}</small>}
                          </Show>
                        </span>
                        <button
                          type="button"
                          class="mcp-control__switch"
                          role="switch"
                          aria-label={name}
                          aria-checked={enabled()}
                          data-active={enabled() ? "true" : "false"}
                          disabled={Boolean(props.disabled) || Boolean(busyName())}
                          onClick={() => void toggle(name, current)}
                        >
                          <span aria-hidden="true" />
                        </button>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </Dialog>
    </>
  )
}
