import { tr } from "../../i18n/i18n-context"
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
        if (!response.data?.config) throw new Error(tr("settings.the-backend-did-not-return-the-global-configuration"))
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
      setFailure(cause instanceof Error ? cause.message : tr("settings.unable-to-open-global-configuration-file"))
    }
  }

  return (
    <div class="settings-reveal-config">
      <Button variant="secondary" disabled={paths.isPending || Boolean(paths.error) || !path()} onClick={() => void reveal()}>
        {tr("settings.open-global-configuration-file")}
      </Button>
      <Show when={paths.error}>
        <InlineError message={paths.error instanceof Error ? paths.error.message : tr("settings.unable-to-read-global-configuration-directory")} />
      </Show>
      <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
    </div>
  )
}
