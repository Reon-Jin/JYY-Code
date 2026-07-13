import { createContext, useContext, type ParentProps } from "solid-js"
import { createBrowserBridge } from "./browser"
import { tauriBridge } from "./tauri"
import type { DesktopBridge } from "./types"

const DesktopBridgeContext = createContext<DesktopBridge>()

function defaultBridge() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? tauriBridge : createBrowserBridge()
}

export function DesktopBridgeProvider(props: ParentProps<{ bridge?: DesktopBridge }>) {
  const bridge = props.bridge ?? defaultBridge()
  return <DesktopBridgeContext.Provider value={bridge}>{props.children}</DesktopBridgeContext.Provider>
}

export function useDesktopBridge() {
  const bridge = useContext(DesktopBridgeContext)
  if (!bridge) throw new Error("DesktopBridgeProvider is missing")
  return bridge
}
