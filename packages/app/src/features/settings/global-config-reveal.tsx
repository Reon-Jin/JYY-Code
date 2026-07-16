import { createQuery } from "@tanstack/solid-query"
import { createMemo, createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import { useDesktopBridge } from "../../platform/context"
import type { ManagementContextValue } from "../management/management-context"
import { globalConfigPath } from "./global-config-path"

export function GlobalConfigReveal(props: { management: ManagementContextValue }) {
  const desktop = useDesktopBridge()
  const [failure, setFailure] = createSignal<string>()
  const paths = createQuery(
    () => ({
      queryKey: keys.globalPath(props.management.directory),
      queryFn: async () => {
        const response = await props.management.client.path.get(
          { directory: props.management.directory },
          { throwOnError: true },
        )
        if (!response.data?.config) throw new Error("后端未返回全局配置目录")
        return response.data
      },
    }),
    () => props.management.queryClient,
  )
  const path = createMemo(() => paths.data?.config && globalConfigPath(paths.data.config))

  async function reveal() {
    const target = path()
    if (!target) return
    setFailure(undefined)
    try {
      await desktop.revealConfigFile(target)
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "无法打开全局配置文件")
    }
  }

  return (
    <div class="settings-reveal-config">
      <Button variant="secondary" disabled={paths.isPending || Boolean(paths.error) || !path()} onClick={() => void reveal()}>
        打开全局配置文件
      </Button>
      <Show when={paths.error}>
        <InlineError message={paths.error instanceof Error ? paths.error.message : "无法读取全局配置目录"} />
      </Show>
      <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
    </div>
  )
}
