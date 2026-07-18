import { tr } from "../../i18n/i18n-context"
import type { DesktopBridge } from "../../platform/types"
import type { DesktopSettings } from "./settings-preferences"

export async function runDesktopUpdater(bridge: DesktopBridge, settings: DesktopSettings) {
  if (settings.updatePolicy === "off") return
  try {
    const update = await bridge.checkForUpdate()
    if (!update.supported || !update.available) return
    if (settings.updatePolicy === "install") {
      await bridge.installAvailableUpdate()
      return
    }
    await bridge.sendNotification({
      title: "JYYCode",
      body: tr("settings.update-notification-body", { version: update.version ?? "" }),
    })
  } catch {
    // Updates must never prevent the local application from starting.
  }
}
