import type { DesktopBridge } from "../../platform/types"
import type { ColorTheme, DesktopSettings } from "./settings-preferences"

type GlassInput = {
  bridge: DesktopBridge
  current: DesktopSettings
  enabled: boolean
  persist: (settings: DesktopSettings) => Promise<void>
  root?: HTMLElement
}

function capabilityError(reason?: string) {
  return new Error(reason || "Window glass is not supported on this system")
}

export async function setGlassPreference(input: GlassInput) {
  const root = input.root ?? document.documentElement
  const previousEnabled = input.current.glass === "on"
  const result = await input.bridge.setWindowGlass(input.enabled, input.current.theme)
  if (!result.supported) {
    root.dataset.glass = previousEnabled ? "on" : "off"
    throw capabilityError(result.reason)
  }

  const next: DesktopSettings = { ...input.current, glass: input.enabled ? "on" : "off" }
  root.dataset.glass = next.glass
  try {
    await input.persist(next)
    return next
  } catch (error) {
    root.dataset.glass = input.current.glass
    await input.bridge.setWindowGlass(previousEnabled, input.current.theme).catch(() => undefined)
    throw error
  }
}

export async function reapplyGlassForTheme(
  bridge: DesktopBridge,
  settings: DesktopSettings,
  theme: ColorTheme,
) {
  if (settings.glass !== "on") return
  const result = await bridge.setWindowGlass(true, theme)
  if (!result.supported) throw capabilityError(result.reason)
}

export async function applyStoredGlass(
  bridge: DesktopBridge,
  settings: DesktopSettings,
  root: HTMLElement = document.documentElement,
) {
  root.dataset.glass = "off"
  if (settings.glass !== "on") return
  const result = await bridge.setWindowGlass(true, settings.theme)
  if (!result.supported) throw capabilityError(result.reason)
  root.dataset.glass = "on"
}
