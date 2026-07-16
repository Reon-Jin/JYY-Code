import { tr } from "../../i18n/i18n-context"
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
    if (!response.data?.directory) throw new Error(tr("management.backend-does-not-return-global-management-directory"))
    return response.data.directory
  })

  return (
    <Switch>
      <Match when={directory.error}>
        <main class="management-state">
          <InlineError message={directory.error instanceof Error ? directory.error.message : tr("management.unable-to-load-global-management-environment")} />
          <Button variant="secondary" onClick={() => void refetch()}>
            {tr("changes.try-again")}
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
          {tr("management.loading-global-management")}
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
