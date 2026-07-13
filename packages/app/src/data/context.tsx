import type { JyycodeClient } from "@jyycode-ai/sdk/v2"
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
import { createDesktopClient } from "./sdk"

export type DataProviderInput = {
  bootstrap: DesktopBootstrap
  generation: number
  directory: string
  activeSessionID?: () => string | undefined
}

export type DataContextValue = {
  client: () => JyycodeClient
  queryClient: () => QueryClient
  directory: () => string
  generation: () => number
  connection: () => ConnectionState
}

const DataContext = createContext<DataContextValue>()

export function DataProvider(props: ParentProps<DataProviderInput>) {
  const [connection, setConnection] = createSignal<ConnectionState>("connecting")
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
      activeSessionID: props.activeSessionID,
      onConnectionChange: setConnection,
    })
    bridge.start()
    onCleanup(() => bridge.abort())
  })

  const value: DataContextValue = {
    client,
    queryClient,
    directory: () => props.directory,
    generation: () => props.generation,
    connection,
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
