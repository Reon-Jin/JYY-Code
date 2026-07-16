import type { JyycodeClient } from "@jyycode-ai/sdk/v2/client"
import { QueryClientProvider, type QueryClient } from "@tanstack/solid-query"
import { createContext, createResource, Match, Switch, useContext, type ParentProps } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { createDesktopQueryClient } from "../../data/query-client"
import { createDesktopClient } from "../../data/sdk"
import type { DesktopBootstrap } from "../../platform/types"

export type ManagementContextValue = {
  client: JyycodeClient
  queryClient: QueryClient
  directory: string
}

const ManagementContext = createContext<ManagementContextValue>()

function ManagementReady(props: ParentProps<{ bootstrap: DesktopBootstrap; directory: string }>) {
  const queryClient = createDesktopQueryClient()
  const client = createDesktopClient(props.bootstrap, props.directory)
  const value: ManagementContextValue = { client, queryClient, directory: props.directory }

  return (
    <ManagementContext.Provider value={value}>
      <QueryClientProvider client={queryClient}>{props.children}</QueryClientProvider>
    </ManagementContext.Provider>
  )
}

export function ManagementProvider(props: ParentProps<{ bootstrap: DesktopBootstrap }>) {
  const bootstrapClient = createDesktopClient(props.bootstrap)
  const [directory, { refetch }] = createResource(async () => {
    const response = await bootstrapClient.global.managementContext({ throwOnError: true })
    if (!response.data?.directory) throw new Error("后端未返回全局管理目录")
    return response.data.directory
  })

  return (
    <Switch>
      <Match when={directory.error}>
        <main class="management-state">
          <InlineError message={directory.error instanceof Error ? directory.error.message : "无法加载全局管理环境"} />
          <Button variant="secondary" onClick={() => void refetch()}>
            重试
          </Button>
        </main>
      </Match>
      <Match when={directory()}>
        {(home) => (
          <ManagementReady bootstrap={props.bootstrap} directory={home()}>
            {props.children}
          </ManagementReady>
        )}
      </Match>
      <Match when={true}>
        <main class="management-state" role="status" aria-live="polite">
          正在加载全局管理…
        </main>
      </Match>
    </Switch>
  )
}

export function useManagement() {
  const value = useContext(ManagementContext)
  if (!value) throw new Error("ManagementProvider is missing")
  return value
}
