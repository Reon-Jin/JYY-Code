import type { JyycodeClient } from "@jyycode-ai/sdk/v2/client"
import { QueryClientProvider, type QueryClient } from "@tanstack/solid-query"
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js"
import type { DesktopBootstrap } from "../platform/types"
import { EventBridge, type ConnectionState } from "./event-bridge"
import { createDesktopQueryClient } from "./query-client"
import { createDesktopClient, createFileMediaUrl, createFilePreviewUrl } from "./sdk"

export type DataProviderInput = {
  bootstrap: DesktopBootstrap
  generation: number
  directory: string
  activeSessionID?: () => string | undefined
}

export type DataContextValue = {
  client: () => JyycodeClient
  fileMediaUrl: (path: string, workspaceID?: string, directory?: string) => string
  filePreviewUrl: (path: string, workspaceID?: string, directory?: string) => string
  queryClient: () => QueryClient
  directory: () => string
  generation: () => number
  connection: () => ConnectionState
  workspaceID: () => string | undefined
  setWorkspaceID: (workspaceID: string | undefined) => void
}

const DataContext = createContext<DataContextValue>()

export function DataProvider(props: ParentProps<DataProviderInput>) {
  const [connection, setConnection] = createSignal<ConnectionState>("connecting")
  const [workspaceID, setWorkspaceID] = createSignal<string>()
  const queryClient = createMemo(
    on(
      () => props.generation,
      () => createDesktopQueryClient(),
    ),
  )
  const client = createMemo(() => {
    props.generation
    return createDesktopClient(props.bootstrap, props.directory)
  })

  createEffect(() => {
    const bridge = new EventBridge({
      client: client(),
      directory: props.directory,
      queryClient: queryClient(),
      workspaceID,
      activeSessionID: props.activeSessionID,
      onConnectionChange: setConnection,
    })
    bridge.start()
    onCleanup(() => bridge.abort())
  })

  const value: DataContextValue = {
    client,
    fileMediaUrl: (path, workspaceID, directory) =>
      createFileMediaUrl({ bootstrap: props.bootstrap, directory: directory ?? props.directory, path, workspaceID }),
    filePreviewUrl: (path, workspaceID, directory) =>
      createFilePreviewUrl({ bootstrap: props.bootstrap, directory: directory ?? props.directory, path, workspaceID }),
    queryClient,
    directory: () => props.directory,
    generation: () => props.generation,
    connection,
    workspaceID,
    setWorkspaceID,
  }

  return (
    <DataContext.Provider value={value}>
      <QueryClientProvider client={queryClient()}>{props.children}</QueryClientProvider>
    </DataContext.Provider>
  )
}

export function useData() {
  const value = useContext(DataContext)
  if (!value) throw new Error("DataProvider is missing")
  return value
}
